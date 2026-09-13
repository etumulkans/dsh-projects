/**
 * DSH Projects Phase 5 — the merge-in-order integration strategy and the
 * structural `verifyIntegration` check (spec §12: disjoint / overlap /
 * skip; conflict capture + abort; re-run determinism; verification ok /
 * missing branch / tampered worktree). Real Git fixtures throughout.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, rm as rmFs, symlink, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MergeInOrderStrategy, verifyIntegration } from '../src/tasks/integration.ts'
import {
  integrationBranchName,
  integrationWorktreePath,
  taskBranchName,
} from '../src/tasks/git-workspace.ts'

const RUN_ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-integration-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    return git(cwd, 'rev-parse', '--verify', `refs/heads/${branch}`) !== ''
  } catch {
    return false
  }
}

async function initRepository(dir: string): Promise<string> {
  await writeFile(join(dir, 'shared.txt'), 'one\ntwo\nthree\n')
  execFileSync('git', ['init', dir], { stdio: 'ignore', windowsHide: true })
  git(dir, 'config', 'user.name', 'dsh-dashboard tests')
  git(dir, 'config', 'user.email', 'dsh-dashboard@example.invalid')
  git(dir, 'add', 'shared.txt')
  git(dir, 'commit', '-m', 'fixture')
  return dir
}

/** Create a task branch with the given file changes; returns its head sha. */
async function makeTaskBranch(repo: string, planTaskId: string, changes: Record<string, string>): Promise<string> {
  const branch = taskBranchName(RUN_ID, planTaskId)
  const setup = join(repo, 'worktree', 'setup', planTaskId)
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', branch, setup, 'HEAD'], { stdio: 'ignore', windowsHide: true })
  for (const [file, content] of Object.entries(changes)) {
    await writeFile(join(setup, file), content)
  }
  git(setup, 'add', '-A')
  git(setup, 'commit', '-m', `task ${planTaskId}`)
  const head = git(repo, 'rev-parse', branch)
  git(repo, 'worktree', 'remove', '--force', setup)
  return head
}

describe('MergeInOrderStrategy (spec §5)', () => {
  it('integrates disjoint task branches in plan order and skips empty tasks', async () => {
    const repo = await initRepository(await temporaryRoot())
    const base = git(repo, 'rev-parse', 'HEAD')
    const t1 = await makeTaskBranch(repo, 't1', { 'file-a.txt': 'work from t1\n' })
    const t2 = await makeTaskBranch(repo, 't2', { 'file-b.txt': 'work from t2\n' })

    // Intentionally out of plan order: the strategy must sort.
    const outcome = await new MergeInOrderStrategy().run({
      repositoryRoot: repo,
      projectRoot: repo,
      runId: RUN_ID,
      tasks: [
        { planTaskId: 't2', branch: taskBranchName(RUN_ID, 't2'), headCommit: t2, baseCommit: base },
        { planTaskId: 't3', branch: taskBranchName(RUN_ID, 't3'), headCommit: base, baseCommit: base },
        { planTaskId: 't1', branch: taskBranchName(RUN_ID, 't1'), headCommit: t1, baseCommit: base },
      ],
    })

    expect(outcome.status).toBe('integrated')
    expect(outcome.merged).toEqual(['t1', 't2'])
    expect(outcome.skipped).toEqual(['t3'])
    expect(outcome.integratedBranch).toBe(integrationBranchName(RUN_ID))
    expect(outcome.integratedHead).toBe(git(repo, 'rev-parse', outcome.integratedBranch))
    // Plan order: t1 merged first, t2 second.
    expect(git(repo, 'log', '--format=%s', '-2', outcome.integratedBranch)).toBe('dsh merge t2\ndsh merge t1')
    const integrationPath = integrationWorktreePath(repo, RUN_ID)
    await expect(readFile(join(integrationPath, 'file-a.txt'), 'utf8')).resolves.toBe('work from t1\n')
    await expect(readFile(join(integrationPath, 'file-b.txt'), 'utf8')).resolves.toBe('work from t2\n')
  })

  it('captures the conflicting paths on overlap, aborts the merge, and keeps everything for inspection', async () => {
    const repo = await initRepository(await temporaryRoot())
    const base = git(repo, 'rev-parse', 'HEAD')
    const t1 = await makeTaskBranch(repo, 't1', { 'shared.txt': 'ONE\ntwo\nthree\n' })
    const t2 = await makeTaskBranch(repo, 't2', { 'shared.txt': 'TWO\ntwo\nthree\n' })

    const outcome = await new MergeInOrderStrategy().run({
      repositoryRoot: repo,
      projectRoot: repo,
      runId: RUN_ID,
      tasks: [
        { planTaskId: 't1', branch: taskBranchName(RUN_ID, 't1'), headCommit: t1, baseCommit: base },
        { planTaskId: 't2', branch: taskBranchName(RUN_ID, 't2'), headCommit: t2, baseCommit: base },
      ],
    })

    expect(outcome.status).toBe('conflict')
    expect(outcome.conflictingPaths).toEqual(['shared.txt'])
    expect(outcome.merged).toEqual(['t1'])
    expect(outcome.skipped).toEqual([])
    // The conflicted merge was aborted: the clean t1 merge stays, t2's
    // changes do not, and the worktree is clean again.
    const integrationPath = integrationWorktreePath(repo, RUN_ID)
    expect(git(repo, 'log', '-1', '--format=%s', outcome.integratedBranch)).toBe('dsh merge t1')
    expect(git(integrationPath, 'status', '--porcelain')).toBe('')
    await expect(readFile(join(integrationPath, 'shared.txt'), 'utf8')).resolves.toBe('ONE\ntwo\nthree\n')
    // No force resolution, no silent skip: task branches are untouched.
    expect(git(repo, 'rev-parse', taskBranchName(RUN_ID, 't1'))).toBe(t1)
    expect(git(repo, 'rev-parse', taskBranchName(RUN_ID, 't2'))).toBe(t2)
    // Kept for inspection until the next re-run or finalization.
    expect(branchExists(repo, outcome.integratedBranch)).toBe(true)
    await expect(stat(integrationPath)).resolves.toMatchObject({})
  })

  it('re-runs deterministically: the previous attempt worktree + branch are removed and recreated', async () => {
    const repo = await initRepository(await temporaryRoot())
    const base = git(repo, 'rev-parse', 'HEAD')
    const t1 = await makeTaskBranch(repo, 't1', { 'file-a.txt': 'work from t1\n' })
    const strategy = new MergeInOrderStrategy()
    const input = {
      repositoryRoot: repo,
      projectRoot: repo,
      runId: RUN_ID,
      tasks: [{ planTaskId: 't1', branch: taskBranchName(RUN_ID, 't1'), headCommit: t1, baseCommit: base }],
    }

    const first = await strategy.run(input)
    expect(first.status).toBe('integrated')
    const second = await strategy.run(input)

    expect(second.status).toBe('integrated')
    expect(second.integratedHead).toBe(git(repo, 'rev-parse', second.integratedBranch))
    expect(second.merged).toEqual(['t1'])
    await expect(readFile(join(integrationWorktreePath(repo, RUN_ID), 'file-a.txt'), 'utf8')).resolves.toBe('work from t1\n')
  })
})

describe('verifyIntegration (spec §5)', () => {
  async function integratedFixture(): Promise<{ repo: string; branches: string[] }> {
    const repo = await initRepository(await temporaryRoot())
    const base = git(repo, 'rev-parse', 'HEAD')
    const t1 = await makeTaskBranch(repo, 't1', { 'file-a.txt': 'work from t1\n' })
    await new MergeInOrderStrategy().run({
      repositoryRoot: repo,
      projectRoot: repo,
      runId: RUN_ID,
      tasks: [{ planTaskId: 't1', branch: taskBranchName(RUN_ID, 't1'), headCommit: t1, baseCommit: base }],
    })
    return { repo, branches: [taskBranchName(RUN_ID, 't1')] }
  }

  it('passes when the branch resolves, the worktree is sound, and task branches are ancestors', async () => {
    const { repo, branches } = await integratedFixture()
    const result = await verifyIntegration({
      repositoryRoot: repo,
      integrationPath: integrationWorktreePath(repo, RUN_ID),
      integrationBranch: integrationBranchName(RUN_ID),
      taskBranches: branches,
    })
    expect(result).toEqual({ ok: true })
  })

  it('fails when the integration branch does not resolve', async () => {
    const { repo, branches } = await integratedFixture()
    const missing = 'dsh/run-deadbeef/integration'
    const result = await verifyIntegration({
      repositoryRoot: repo,
      integrationPath: integrationWorktreePath(repo, RUN_ID),
      integrationBranch: missing,
      taskBranches: branches,
    })
    expect(result).toEqual({ ok: false, missing: [missing] })
  })

  it('fails when the integration worktree is missing or a symlink', async () => {
    const { repo, branches } = await integratedFixture()
    const integrationPath = integrationWorktreePath(repo, RUN_ID)
    const input = {
      repositoryRoot: repo,
      integrationPath,
      integrationBranch: integrationBranchName(RUN_ID),
      taskBranches: branches,
    }

    await rmFs(integrationPath, { recursive: true, force: true })
    expect(await verifyIntegration(input)).toEqual({ ok: false, missing: [integrationPath] })

    await symlink(dirname(integrationPath), integrationPath)
    expect(await verifyIntegration(input)).toEqual({ ok: false, missing: [integrationPath] })
  })

  it('fails when a task branch is not an ancestor of the integrated branch', async () => {
    const { repo } = await integratedFixture()
    const stray = 'dsh/stray-branch'
    execFileSync('git', ['-C', repo, 'branch', stray, 'HEAD'], { stdio: 'ignore', windowsHide: true })
    // A commit of its own makes the stray branch non-ancestor.
    const setup = join(repo, 'worktree', 'setup', 'stray')
    execFileSync('git', ['-C', repo, 'worktree', 'add', setup, stray], { stdio: 'ignore', windowsHide: true })
    await writeFile(join(setup, 'stray.txt'), 'x\n')
    git(setup, 'add', '-A')
    git(setup, 'commit', '-m', 'stray')
    git(repo, 'worktree', 'remove', '--force', setup)

    const result = await verifyIntegration({
      repositoryRoot: repo,
      integrationPath: integrationWorktreePath(repo, RUN_ID),
      integrationBranch: integrationBranchName(RUN_ID),
      taskBranches: [stray],
    })
    expect(result).toEqual({ ok: false, missing: [stray] })
  })
})
