/**
 * DSH Projects Phase 5 — per-task Git worktree provisioning and commit
 * (spec §4).
 *
 * Every live task of a Git project runs in its own worktree + branch under
 * `<projectRoot>/worktree/run-<shortRunId>/<leaf>` (master spec §16 layout).
 * The manager reuses the workspace path-safety discipline (leaf
 * normalization, containment, symlink protection) and the shared `runGit`
 * helper; Git is only touched through `node:child_process` `execFile` —
 * no new dependency. All operations are idempotent and safe to re-run
 * (restart, resume, cleanup retries).
 */

import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { DashboardDomainError } from '../runtime/errors.ts'
import { runGit } from '../workspace/git.ts'
import { assertContained, workspaceLeaf } from '../workspace/path-safety.ts'
import { GIT_OPERATION_TIMEOUT_MS } from './constants.ts'

/** First 8 characters of the run UUID (hex — ref-safe). */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8)
}

/** `workspaceLeaf`-normalized leaf; never trusts its input (spec §4.2). */
export function taskLeaf(planTaskId: string): string {
  return workspaceLeaf(planTaskId)
}

/** Task branch name: `dsh/run-<shortRunId>/<leaf>` (master spec §16). */
export function taskBranchName(runId: string, planTaskId: string): string {
  return `dsh/run-${shortRunId(runId)}/${taskLeaf(planTaskId)}`
}

/** Integration branch name: `dsh/run-<shortRunId>/integration`. */
export function integrationBranchName(runId: string): string {
  return `dsh/run-${shortRunId(runId)}/integration`
}

/** Task worktree path: `<projectRoot>/worktree/run-<shortRunId>/<leaf>`. */
export function taskWorktreePath(projectRoot: string, runId: string, planTaskId: string): string {
  return join(projectRoot, 'worktree', `run-${shortRunId(runId)}`, taskLeaf(planTaskId))
}

/** Integration worktree path: `<projectRoot>/worktree/run-<shortRunId>/integration`. */
export function integrationWorktreePath(projectRoot: string, runId: string): string {
  return join(projectRoot, 'worktree', `run-${shortRunId(runId)}`, 'integration')
}

export interface ProvisionTaskWorktreeInput {
  readonly repositoryRoot: string
  readonly projectRoot: string
  readonly runId: string
  readonly planTaskId: string
}

export interface ProvisionWorktreeInput {
  readonly repositoryRoot: string
  readonly projectRoot: string
  readonly branch: string
  readonly path: string
}

export interface ProvisionWorktreeResult {
  readonly path: string
  readonly branch: string
  /** Repository `HEAD` at creation; absent on idempotent reuse (the persisted record keeps the original base). */
  readonly baseCommit?: string
  readonly createdNow: boolean
}

export interface CommitTaskWorkInput {
  readonly path: string
  readonly planTaskId: string
  readonly title: string
}

export interface CommitTaskWorkResult {
  readonly headCommit: string
  readonly committed: boolean
}

export interface RemoveTaskWorktreeInput {
  readonly repositoryRoot: string
  readonly projectRoot: string
  readonly path: string
}

export interface RemoveBranchInput {
  readonly repositoryRoot: string
  readonly branch: string
}

/**
 * Provisions and removes per-task Git worktrees (spec §4.3). One writer per
 * worktree is exclusive by construction (unique per-task naming); the
 * idempotent-reuse path is the one-writer guard's backstop — a foreign
 * identity at an expected path is refused, never adopted, never deleted
 * (`task.workspaceConflict`).
 */
export class TaskWorktreeManager {
  /**
   * Provision (or idempotently reuse) the task worktree for
   * `(runId, planTaskId)`: branch `dsh/run-<short>/<leaf>` from the
   * repository `HEAD`, at `<projectRoot>/worktree/run-<short>/<leaf>`.
   */
  async provisionTaskWorktree(input: ProvisionTaskWorktreeInput): Promise<ProvisionWorktreeResult> {
    return this.provisionWorktree({
      repositoryRoot: input.repositoryRoot,
      projectRoot: input.projectRoot,
      branch: taskBranchName(input.runId, input.planTaskId),
      path: taskWorktreePath(input.projectRoot, input.runId, input.planTaskId),
    })
  }

  /** Provision (or idempotently reuse) the run's integration worktree. */
  async provisionIntegrationWorktree(input: {
    readonly repositoryRoot: string
    readonly projectRoot: string
    readonly runId: string
  }): Promise<ProvisionWorktreeResult> {
    return this.provisionWorktree({
      repositoryRoot: input.repositoryRoot,
      projectRoot: input.projectRoot,
      branch: integrationBranchName(input.runId),
      path: integrationWorktreePath(input.projectRoot, input.runId),
    })
  }

  /**
   * Commit the task's work onto its branch (spec §4.3): `git add -A` +
   * `git commit -m "dsh task <planTaskId>: <title ≤ 120 chars>"` using the
   * repository's configured identity (no invented identity). Clean tree →
   * `committed: false`; the returned `headCommit` equals `baseCommit` then.
   */
  async commitTaskWork(input: CommitTaskWorkInput): Promise<CommitTaskWorkResult> {
    const status = await this.git(input.path, ['status', '--porcelain'])
    const committed = status !== ''
    if (committed) {
      const subject = input.title.length > 120 ? `${input.title.slice(0, 120)}…` : input.title
      await this.git(input.path, ['add', '-A'])
      try {
        await this.git(input.path, ['commit', '-m', `dsh task ${input.planTaskId}: ${subject}`])
      } catch (error) {
        throw new DashboardDomainError(
          'task.commitFailed',
          `could not commit task ${input.planTaskId}: ${errorMessage(error)}`,
        )
      }
    }
    const headCommit = await this.git(input.path, ['rev-parse', 'HEAD'])
    return { headCommit, committed }
  }

  /**
   * Remove a task (or integration) worktree (spec §4.3). When git reports
   * no registered worktree (a crashed mid-creation), fall back to a
   * revalidated plain removal (real directory, contained, not a symlink).
   * Returns whether anything was removed.
   */
  async removeTaskWorktree(input: RemoveTaskWorktreeInput): Promise<boolean> {
    const { repositoryRoot, projectRoot, path } = input
    try {
      await this.git(repositoryRoot, ['worktree', 'remove', '--force', path])
      return true
    } catch (error) {
      const message = errorMessage(error)
      if (!/is not a working tree/i.test(message)) {
        throw new DashboardDomainError('task.worktreeFailed', `could not remove worktree ${path}: ${message}`)
      }
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink() || !info.isDirectory()) return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
      const canonicalParent = await realpath(dirname(path))
      const canonicalPath = await realpath(path)
      const canonicalRoot = await realpath(projectRoot)
      assertContained(canonicalParent, canonicalPath)
      assertContained(canonicalRoot, canonicalPath)
      await rm(canonicalPath, { recursive: true, force: false })
      return true
    }
  }

  /** `git branch -D <branch>`; “not found” → `false` (idempotent). */
  async removeBranch(input: RemoveBranchInput): Promise<boolean> {
    try {
      await this.git(input.repositoryRoot, ['branch', '-D', input.branch])
      return true
    } catch (error) {
      if (/not found|No such branch/i.test(errorMessage(error))) return false
      throw new DashboardDomainError('task.worktreeFailed', `could not remove branch ${input.branch}: ${errorMessage(error)}`)
    }
  }

  /** The provisioning primitive shared by task and integration worktrees (spec §4.3). */
  async provisionWorktree(input: ProvisionWorktreeInput): Promise<ProvisionWorktreeResult> {
    const { repositoryRoot, projectRoot, branch, path } = input
    assertContained(projectRoot, path)
    const parent = dirname(path)
    try {
      const parentInfo = await lstat(parent)
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
        throw new DashboardDomainError('task.worktreeFailed', `worktree parent is not a real directory: ${parent}`)
      }
    } catch (error) {
      if (error instanceof DashboardDomainError) throw error
      // ENOENT: the parent does not exist yet; ENOTDIR: an ancestor is a file.
      // Both fall through to the (wrapped) mkdir attempt.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      try {
        await mkdir(parent, { recursive: true })
      } catch (mkdirError) {
        // e.g. an ancestor of the parent is a file (ENOTDIR).
        throw new DashboardDomainError('task.worktreeFailed', `could not create worktree parent ${parent}: ${errorMessage(mkdirError)}`)
      }
      const created = await lstat(parent)
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new DashboardDomainError('task.worktreeFailed', `worktree parent is not a real directory: ${parent}`)
      }
    }
    const canonicalParent = await realpath(parent)
    const canonicalPath = resolve(canonicalParent, basename(path))
    assertContained(canonicalParent, canonicalPath)

    // Idempotent reuse (restart safety): adopt the existing tree only when
    // it is a real directory, a worktree of this repository (common-directory
    // equality), and checked out on the expected branch.
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw this.conflict(path, branch, 'the path is not a real directory')
      }
      const canonicalExisting = await realpath(path)
      assertContained(canonicalParent, canonicalExisting)
      const [repositoryCommon, existingCommon, checkedOut] = await Promise.all([
        this.git(repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        this.git(canonicalExisting, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        this.git(canonicalExisting, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ])
      if (!samePath(repositoryCommon, existingCommon)) {
        throw this.conflict(path, branch, 'the path is a worktree of a different repository')
      }
      if (checkedOut !== branch) {
        throw this.conflict(path, branch, `the path is checked out on ${checkedOut}`)
      }
      return { path: canonicalExisting, branch, createdNow: false }
    } catch (error) {
      if (error instanceof DashboardDomainError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The path exists but is not a healthy worktree of this repository.
        throw this.conflict(path, branch, errorMessage(error))
      }
    }

    // Create: branch + worktree from the repository HEAD at provisioning.
    try {
      await this.git(repositoryRoot, ['worktree', 'add', '-b', branch, canonicalPath, 'HEAD'])
    } catch (error) {
      const message = errorMessage(error)
      if (!/A branch named .* already exists/i.test(message)) {
        throw new DashboardDomainError('task.worktreeFailed', `could not provision worktree ${canonicalPath}: ${message}`)
      }
      // A crashed earlier attempt created the branch but not the worktree.
      await this.git(repositoryRoot, ['worktree', 'add', canonicalPath, branch])
    }
    const baseCommit = await this.git(repositoryRoot, ['rev-parse', 'HEAD'])
    // Revalidate the created worktree (common-directory + toplevel).
    const [repositoryCommon, createdCommon, topLevel] = await Promise.all([
      this.git(repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.git(canonicalPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.git(canonicalPath, ['rev-parse', '--path-format=absolute', '--show-toplevel']),
    ])
    if (!samePath(repositoryCommon, createdCommon) || !samePath(canonicalPath, topLevel)) {
      throw new DashboardDomainError('task.worktreeFailed', `worktree validation failed for ${canonicalPath}`)
    }
    return { path: canonicalPath, branch, baseCommit, createdNow: true }
  }

  private git(cwd: string, args: readonly string[]): Promise<string> {
    return runGit(cwd, args, GIT_OPERATION_TIMEOUT_MS)
  }

  private conflict(path: string, expectedBranch: string, detail: string): DashboardDomainError {
    return new DashboardDomainError(
      'task.workspaceConflict',
      `task workspace at ${path} is occupied by a foreign worktree (expected branch ${expectedBranch}; ${detail})`,
    )
  }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
