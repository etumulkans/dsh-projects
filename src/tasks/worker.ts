/**
 * DSH Projects Phase 4 — task worker seam.
 *
 * The service executes tasks through this narrow interface (the same
 * seam pattern as the Phase 3 `CoordinatorDriver`): tests inject a fake,
 * production adapters bind to the installed Harness runtime (spec §6).
 */

import { DashboardDomainError } from '../runtime/errors.ts'
import type { TokenTotals } from '../runtime/types.ts'
import type { ProjectId, RunId, TaskId } from './types.ts'

export type TaskWorkerKind = 'local' | 'agent-team' | 'unavailable'

export interface TaskWorkerInput {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly projectId: ProjectId
  /** Plugin-generated session id (`dsh-task-<uuid>`), as in Phase 3. */
  readonly sessionId: string
  /** The execution directory (Phase 5: the per-task worktree for Git projects; the project root otherwise). */
  readonly cwd: string
  /** Additive (Phase 5): the task branch, when `cwd` is a dedicated worktree. */
  readonly branch?: string
  readonly title: string
  readonly description: string
  readonly role?: string
  readonly acceptanceCriteria: readonly string[]
  /** The attempt about to start (1-based). */
  readonly attempt: number
  readonly signal: AbortSignal
}

export interface TaskWorkerResult {
  readonly kind: 'succeeded' | 'failed'
  /** Concise human-readable summary; required on success (≤1000). */
  readonly summary?: string
  /** Required on failure. */
  readonly error?: string
  /** The native agent identity actually used (session id / member name). */
  readonly agentId?: string
  /** Only when the runtime reported usage (never invented). */
  readonly tokenUsage?: TokenTotals
  /** Only when the runtime reported it. */
  readonly turnCount?: number
}

export interface TaskWorker {
  readonly kind: TaskWorkerKind
  /**
   * Runs one task to a terminal outcome. Resolves exactly once: a success
   * result, a failure result, or — when `signal` aborts — a failure with
   * `error: 'task execution aborted'`. Never rejects for expected outcomes;
   * it only rejects on adapter-level faults (e.g. the runtime itself).
   */
  start(input: TaskWorkerInput): Promise<TaskWorkerResult>
  /**
   * Best-effort stop of one live agent by the identity the worker reported
   * (or the session id placeholder). Resolves even when unknown.
   */
  stop(agentId: string): Promise<void>
}

/**
 * The explicit "no agent runtime mounted" state (spec §6.4): scheduling finds
 * no eligible worker and any explicit action surfaces
 * `task.workerUnavailable` — never a fake agent.
 */
export class UnavailableWorker implements TaskWorker {
  readonly kind: TaskWorkerKind = 'unavailable'

  async start(): Promise<TaskWorkerResult> {
    throw new DashboardDomainError('task.workerUnavailable', 'no agent runtime is mounted in this composition')
  }

  async stop(): Promise<void> {
    /* nothing to stop */
  }
}

/** Truncate a worker-reported summary to the persisted limit. */
export function truncateSummary(summary: string, limit: number): string {
  return summary.length > limit ? `${summary.slice(0, limit)}…` : summary
}
