/**
 * DSH Projects Phase 5 — per-task Git worktree provisioning and commit
 * (spec §12: naming; provisioning reuse / conflict / containment; dirty /
 * clean / missing-identity commit; idempotent double removal + the
 * unregistered-tree fallback). Real Git repository fixtures (git >= 2.25
 * through child_process), not fakes: the manager's contract is defined by
 * real Git behavior.
 */

import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TaskWorktreeManager,
  integrationBranchName,
  integrationWorktreePath,
  shortRunId,
  taskBranchName,
  taskLeaf,
  taskWorktreePath,
} from '../src/tasks/git-workspace.ts'

const RUN_ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-workspace-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

/** True when the local branch exists. */
function branchExists(cwd: string, branch: string): boolean {
  try {
    return git(cwd, 'rev-parse', '--verify', `refs/heads/${branch}`) !== ''
  } catch {
    return false
  }
}

async function initRepository(dir: string, withLocalIdentity = true): Promise<string> {
  await mkdir(dir, { recursive: true })
  execFileSync('git', ['init', dir], { stdio: 'ignore', windowsHide: true })
  if (withLocalIdentity) {
    // Deterministic identity regardless of the host's git configuration.
    git(dir, 'config', 'user.name', 'dsh-dashboard tests')
    git(dir, 'config', 'user.email', 'dsh-dashboard@example.invalid')
  } else {
    // Empty local identity: deterministically blocks git's
    // username@hostname auto-identity fallback on any git version.
    git(dir, 'config', 'user.name', '')
    git(dir, 'config', 'user.email', '')
  }
  await writeFile(join(dir, 'tracked.txt'), 'from HEAD\n')
  git(dir, 'add', 'tracked.txt')
  git(dir, '-c', 'user.name=dsh-dashboard tests', '-c', 'user.email=dsh-dashboard@example.invalid', 'commit', '-m', 'fixture')
  return dir
}

describe('worktree naming (spec §4.2)', () => {
  it('derives deterministic branch and worktree names from run + plan task', () => {
    expect(shortRunId(RUN_ID)).toBe('a1b2c3d4')
    expect(taskBranchName(RUN_ID, 't1')).toBe('dsh/run-a1b2c3d4/t1')
    expect(integrationBranchName(RUN_ID)).toBe('dsh/run-a1b2c3d4/integration')
    const root = '/repo/project'
    expect(taskWorktreePath(root, RUN_ID, 't2')).toBe(join(root, 'worktree', 'run-a1b2c3d4', 't2'))
    expect(integrationWorktreePath(root, RUN_ID)).toBe(join(root, 'worktree', 'run-a1b2c3d4', 'integration'))
  })

  it('normalizes unsafe plan task ids into distinct, stable leaves', () => {
    expect(taskLeaf('t1')).toBe('t1')
    const leaf = taskLeaf('a/b')
    expect(leaf).toMatch(/^a-b-[0-9a-f]{16}$/)
    expect(taskLeaf('a/b')).toBe(leaf)
    expect(taskLeaf('x/y')).not.toBe(leaf)
    expect(taskBranchName(RUN_ID, 'a/b')).toBe(`dsh/run-a1b2c3d4/${leaf}`)
  })
})

describe('provisionTaskWorktree (spec §4.3)', { timeout: 30_000 }, () => {
  it('creates a worktree + branch from the repository HEAD and revalidates it', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()

    const result = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })

    expect(result.createdNow).toBe(true)
    expect(result.branch).toBe('dsh/run-a1b2c3d4/t1')
    expect(result.baseCommit).toBe(git(projectRoot, 'rev-parse', 'HEAD'))
    expect(result.path).toBe(await realpath(taskWorktreePath(projectRoot, RUN_ID, 't1')))
    await expect(readFile(join(result.path, 'tracked.txt'), 'utf8')).resolves.toBe('from HEAD\n')
    expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(result.branch)
    expect(branchExists(projectRoot, result.branch)).toBe(true)
  })

  it('reuses the existing worktree idempotently, keeping uncommitted work (no reset)', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const input = { repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' }

    const first = await manager.provisionTaskWorktree(input)
    await writeFile(join(first.path, 'wip.txt'), 'uncommitted\n')
    const second = await manager.provisionTaskWorktree(input)

    expect(second.createdNow).toBe(false)
    expect(second.baseCommit).toBeUndefined()
    expect(second.path).toBe(first.path)
    await expect(readFile(join(second.path, 'wip.txt'), 'utf8')).resolves.toBe('uncommitted\n')
  })

  it('re-provisions cleanly when a crashed attempt left only the branch behind', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const input = { repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't3' }

    const first = await manager.provisionTaskWorktree(input)
    await expect(manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path: first.path })).resolves.toBe(true)
    const second = await manager.provisionTaskWorktree(input)

    expect(second.createdNow).toBe(true)
    expect(second.branch).toBe(first.branch)
    expect(git(second.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.branch)
  })

  it('refuses a foreign worktree on the expected path (wrong branch) — never adopted, never deleted', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const path = taskWorktreePath(projectRoot, RUN_ID, 't1')
    execFileSync('git', ['-C', projectRoot, 'worktree', 'add', '-b', 'foreign', path, 'HEAD'], { stdio: 'ignore', windowsHide: true })

    await expect(
      manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' }),
    ).rejects.toMatchObject({ dashboardCode: 'task.workspaceConflict' })

    // The foreign worktree is untouched.
    expect(git(projectRoot, 'worktree', 'list')).toContain(path)
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('foreign')
  })

  it('refuses a worktree belonging to a different repository', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const other = await initRepository(join(await temporaryRoot(), 'other'))
    const manager = new TaskWorktreeManager()
    const path = taskWorktreePath(projectRoot, RUN_ID, 't9')
    execFileSync('git', ['-C', other, 'worktree', 'add', path, 'HEAD'], { stdio: 'ignore', windowsHide: true })

    await expect(
      manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't9' }),
    ).rejects.toMatchObject({ dashboardCode: 'task.workspaceConflict' })
  })

  it('refuses a plain file at the expected path', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const path = taskWorktreePath(projectRoot, RUN_ID, 't5')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'file\n')

    await expect(
      manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't5' }),
    ).rejects.toMatchObject({ dashboardCode: 'task.workspaceConflict' })
  })

  it('fails with task.worktreeFailed when the worktree parent is not a real directory', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    await writeFile(join(projectRoot, 'worktree'), 'not a directory\n')

    await expect(
      manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' }),
    ).rejects.toMatchObject({ dashboardCode: 'task.worktreeFailed' })
  })
})

describe('provisionIntegrationWorktree (spec §4.3)', { timeout: 30_000 }, () => {
  it('provisions the run integration worktree from the repository HEAD', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()

    const result = await manager.provisionIntegrationWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID })

    expect(result.createdNow).toBe(true)
    expect(result.branch).toBe('dsh/run-a1b2c3d4/integration')
    expect(result.baseCommit).toBe(git(projectRoot, 'rev-parse', 'HEAD'))
    expect(result.path).toBe(await realpath(integrationWorktreePath(projectRoot, RUN_ID)))
    await expect(readFile(join(result.path, 'tracked.txt'), 'utf8')).resolves.toBe('from HEAD\n')
  })
})

describe('commitTaskWork (spec §4.3)', { timeout: 30_000 }, () => {
  it('commits dirty work with the plan-task message and returns the new head', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })
    await writeFile(join(provisioned.path, 'new.txt'), 'work\n')
    const before = git(projectRoot, 'rev-parse', provisioned.branch)

    const result = await manager.commitTaskWork({ path: provisioned.path, planTaskId: 't1', title: 'Add new file' })

    expect(result.committed).toBe(true)
    expect(result.headCommit).not.toBe(before)
    expect(git(projectRoot, 'rev-parse', provisioned.branch)).toBe(result.headCommit)
    expect(git(provisioned.path, 'log', '-1', '--format=%s')).toBe('dsh task t1: Add new file')
  })

  it('reports a clean tree as not committed (headCommit stays at the base)', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })

    const result = await manager.commitTaskWork({ path: provisioned.path, planTaskId: 't1', title: 'No work' })

    expect(result.committed).toBe(false)
    expect(result.headCommit).toBe(git(projectRoot, 'rev-parse', 'HEAD'))
  })

  it('truncates long titles to 120 characters in the commit subject', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })
    await writeFile(join(provisioned.path, 'new.txt'), 'work\n')

    await manager.commitTaskWork({ path: provisioned.path, planTaskId: 't1', title: 'x'.repeat(150) })

    expect(git(provisioned.path, 'log', '-1', '--format=%s')).toBe(`dsh task t1: ${'x'.repeat(120)}…`)
  })

  it('fails with task.commitFailed when the repository has no usable git identity', async () => {
    // No local identity in this fixture; strip any host-level identity too.
    const projectRoot = await initRepository(await temporaryRoot(), false)
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })
    await writeFile(join(provisioned.path, 'new.txt'), 'work\n')
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    try {
      await expect(
        manager.commitTaskWork({ path: provisioned.path, planTaskId: 't1', title: 'No identity' }),
      ).rejects.toMatchObject({ dashboardCode: 'task.commitFailed' })
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved.global
      if (saved.system === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = saved.system
    }
  })
})

describe('worktree removal (spec §4.3)', { timeout: 30_000 }, () => {
  it('removes a registered worktree (force, even when dirty) and keeps the branch', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })
    await writeFile(join(provisioned.path, 'dirty.txt'), 'x\n')

    expect(await manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path: provisioned.path })).toBe(true)

    await expect(stat(provisioned.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(branchExists(projectRoot, provisioned.branch)).toBe(true)
  })

  it('is idempotent: a double removal and a missing path both report false', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })

    expect(await manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path: provisioned.path })).toBe(true)
    expect(await manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path: provisioned.path })).toBe(false)
    expect(await manager.removeTaskWorktree({
      repositoryRoot: projectRoot,
      projectRoot,
      path: join(projectRoot, 'worktree', 'run-a1b2c3d4', 'absent'),
    })).toBe(false)
  })

  it('falls back to a validated plain removal for an unregistered directory (crashed mid-creation)', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const path = taskWorktreePath(projectRoot, RUN_ID, 't7')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'leftover.txt'), 'x\n')

    expect(await manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path })).toBe(true)

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never removes a symlink at the expected path', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const target = await temporaryRoot()
    const path = taskWorktreePath(projectRoot, RUN_ID, 't8')
    await mkdir(dirname(path), { recursive: true })
    await symlink(target, path)

    expect(await manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path })).toBe(false)

    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })

  it('refuses to remove a real directory outside the project root', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const outside = await temporaryRoot() // a real dir, not under projectRoot
    const manager = new TaskWorktreeManager()

    await expect(
      manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path: outside }),
    ).rejects.toThrow('escapes its configured root')
  })
})

describe('branch removal (spec §4.3)', { timeout: 30_000 }, () => {
  it('refuses to delete a checked-out branch while its worktree is attached', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })

    await expect(
      manager.removeBranch({ repositoryRoot: projectRoot, branch: provisioned.branch }),
    ).rejects.toMatchObject({ dashboardCode: 'task.worktreeFailed' })

    expect(branchExists(projectRoot, provisioned.branch)).toBe(true)
  })

  it('force-deletes a branch after its worktree is gone, and is idempotent for a missing one', async () => {
    const projectRoot = await initRepository(await temporaryRoot())
    const manager = new TaskWorktreeManager()
    const provisioned = await manager.provisionTaskWorktree({ repositoryRoot: projectRoot, projectRoot, runId: RUN_ID, planTaskId: 't1' })
    await manager.removeTaskWorktree({ repositoryRoot: projectRoot, projectRoot, path: provisioned.path })

    expect(await manager.removeBranch({ repositoryRoot: projectRoot, branch: provisioned.branch })).toBe(true)
    expect(branchExists(projectRoot, provisioned.branch)).toBe(false)
    expect(await manager.removeBranch({ repositoryRoot: projectRoot, branch: provisioned.branch })).toBe(false)
  })
})
