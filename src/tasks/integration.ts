/**
 * DSH Projects Phase 5 — run integration strategy (spec §5).
 *
 * The strategy is a seam (master spec §17: “The exact strategy should be
 * configurable. Support at minimum a clean, deterministic integration
 * path.”). The only shipped implementation, `MergeInOrderStrategy`, merges
 * the run's non-empty task branches into the integration branch in numeric
 * plan-task order inside a dedicated integration worktree. A conflict is a
 * structured failure (conflicting paths captured, merge aborted) — no force
 * resolution, no silent skip; the integration worktree + branch are kept
 * for inspection until the next (re)run or run finalization.
 */

import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runGit } from '../workspace/git.ts'
import { GIT_OPERATION_TIMEOUT_MS } from './constants.ts'
import { TaskWorktreeManager, integrationBranchName, integrationWorktreePath } from './git-workspace.ts'

/** One succeeded task's immutable branch identity (spec §5). */
export interface IntegrationTaskRef {
  readonly planTaskId: string
  readonly branch: string
  readonly headCommit: string
  readonly baseCommit: string
}

export interface IntegrationInput {
  readonly repositoryRoot: string
  readonly projectRoot: string
  readonly runId: string
  /** The run's succeeded tasks, in any order (the strategy sorts plan order). */
  readonly tasks: readonly IntegrationTaskRef[]
}

export interface IntegrationOutcome {
  readonly status: 'integrated' | 'conflict'
  readonly integratedBranch: string
  /** Tip of the integration branch (absent on conflict). */
  readonly integratedHead?: string
  /** Merged `planTaskId`s in plan order. */
  readonly merged: readonly string[]
  /** Tasks that produced no commits (`headCommit === baseCommit`). */
  readonly skipped: readonly string[]
  /** Conflicting file paths when `status === 'conflict'`. */
  readonly conflictingPaths?: readonly string[]
}

/** The integration strategy seam (spec §5). */
export interface IntegrationStrategy {
  readonly name: string
  run(input: IntegrationInput): Promise<IntegrationOutcome>
}

/** Numeric position of a `t<n>` plan task id (plan order). */
function planPosition(planTaskId: string): number {
  const match = /^t([1-9][0-9]*)$/.exec(planTaskId)
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1])
}

/**
 * The deterministic merge-in-order integration strategy (spec §5):
 * fresh integration worktree from the repository `HEAD`, then one
 * `git merge --no-ff <taskBranch>` per non-empty task in plan order.
 * Re-runs (resume after a failed attempt) remove the previous attempt's
 * integration worktree + branch first (best-effort) — deterministic.
 */
export class MergeInOrderStrategy implements IntegrationStrategy {
  readonly name = 'merge-in-order'

  constructor(private readonly worktrees: TaskWorktreeManager = new TaskWorktreeManager()) {}

  async run(input: IntegrationInput): Promise<IntegrationOutcome> {
    const branch = integrationBranchName(input.runId)
    const path = integrationWorktreePath(input.projectRoot, input.runId)
    // Deterministic re-run: previous attempt's integration worktree + branch
    // are removed first (best-effort), then a fresh worktree is provisioned.
    await this.worktrees
      .removeTaskWorktree({ repositoryRoot: input.repositoryRoot, projectRoot: input.projectRoot, path })
      .catch(() => undefined)
    await this.worktrees.removeBranch({ repositoryRoot: input.repositoryRoot, branch }).catch(() => undefined)
    await this.worktrees.provisionIntegrationWorktree({
      repositoryRoot: input.repositoryRoot,
      projectRoot: input.projectRoot,
      runId: input.runId,
    })

    const ordered = [...input.tasks].sort((a, b) => planPosition(a.planTaskId) - planPosition(b.planTaskId))
    const merged: string[] = []
    const skipped: string[] = []
    for (const task of ordered) {
      if (task.headCommit === task.baseCommit) {
        skipped.push(task.planTaskId)
        continue
      }
      try {
        await this.git(path, ['merge', '--no-ff', task.branch, '-m', `dsh merge ${task.planTaskId}`])
      } catch {
        const conflictingPaths = await this.git(path, ['diff', '--name-only', '--diff-filter=U'])
          .then(output => output.split(/\r?\n/).filter(entry => entry !== ''))
          .catch((): string[] => [])
        await this.git(path, ['merge', '--abort']).catch(() => undefined)
        return {
          status: 'conflict',
          integratedBranch: branch,
          merged,
          skipped,
          conflictingPaths: conflictingPaths.length > 0 ? conflictingPaths : ['unknown'],
        }
      }
      merged.push(task.planTaskId)
    }
    const integratedHead = await this.git(path, ['rev-parse', 'HEAD'])
    return { status: 'integrated', integratedBranch: branch, integratedHead, merged, skipped }
  }

  private git(cwd: string, args: readonly string[]): Promise<string> {
    return runGit(cwd, args, GIT_OPERATION_TIMEOUT_MS)
  }
}

export interface VerifyIntegrationInput {
  readonly repositoryRoot: string
  readonly integrationPath: string
  readonly integrationBranch: string
  /** Every merged task branch (all succeeded tasks, including skipped ones). */
  readonly taskBranches: readonly string[]
}

export interface VerifyIntegrationResult {
  readonly ok: boolean
  /** The branches/paths that failed verification. */
  readonly missing?: readonly string[]
}

/**
 * Structural validation of a completed integration (the validating-phase
 * check, spec §5): the branch resolves (`rev-parse --verify`), the worktree
 * is sound (common-directory check), and every merged task branch is an
 * ancestor of the integrated branch (`merge-base --is-ancestor`). Running
 * project test/build commands is a non-goal (§14).
 */
export async function verifyIntegration(input: VerifyIntegrationInput): Promise<VerifyIntegrationResult> {
  const git = (cwd: string, args: readonly string[]): Promise<string> => runGit(cwd, args, GIT_OPERATION_TIMEOUT_MS)
  try {
    await git(input.repositoryRoot, ['rev-parse', '--verify', `${input.integrationBranch}^{commit}`])
  } catch {
    return { ok: false, missing: [input.integrationBranch] }
  }
  try {
    const info = await lstat(input.integrationPath)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { ok: false, missing: [input.integrationPath] }
    }
    const canonicalPath = await realpath(input.integrationPath)
    const [repositoryCommon, worktreeCommon] = await Promise.all([
      git(input.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(canonicalPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    if (!samePath(repositoryCommon, worktreeCommon)) {
      return { ok: false, missing: [input.integrationPath] }
    }
  } catch {
    return { ok: false, missing: [input.integrationPath] }
  }
  const missing: string[] = []
  for (const taskBranch of input.taskBranches) {
    try {
      await git(input.repositoryRoot, ['merge-base', '--is-ancestor', taskBranch, input.integrationBranch])
    } catch {
      missing.push(taskBranch)
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight
}
