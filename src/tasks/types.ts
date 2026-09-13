/** Durable Project Task records and lossless Host-to-client projections (Phase 4). */

import type { ProjectId } from '../catalog/types.ts'
import type { PlanId } from '../plans/types.ts'
import type { TokenTotals } from '../runtime/types.ts'
import type { RunId } from '../runs/types.ts'

export type { ProjectId } from '../catalog/types.ts'
export type { RunId } from '../runs/types.ts'

export type TaskId = string

export type ProjectTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'awaiting-review'
  | 'succeeded'
  | 'failed'
  | 'canceled'

/**
 * One durable execution task of a Run's active plan (spec §11). Materialized
 * from a plan version's `PlannedTask` list; `dependencies` are task UUIDs
 * resolved at materialization (plan positions `tN` → ids).
 */
export interface ProjectTaskRecord {
  readonly id: TaskId
  readonly runId: RunId
  /** The plan version that materialized this task. */
  readonly planId: PlanId
  /** Position id in the plan (`t1`..`tN`), kept for traceability. */
  readonly planTaskId: string
  readonly title: string
  readonly description: string
  /** Role label from the plan (master spec §15: labels + guidance, not limits). */
  readonly role?: string
  readonly dependencies: readonly string[]
  readonly status: ProjectTaskStatus
  /** Native agent identity of the last/current execution (session id or member name). */
  readonly assignedAgentId?: string
  /** Populated (Phase 5): the canonical per-task Git worktree path; absent for non-Git projects. */
  readonly workspaceId?: string
  /** Additive (Phase 5): the task branch (`dsh/run-<short>/<leaf>`); set with `workspaceId`. */
  readonly branch?: string
  /** Additive (Phase 5): the repository `HEAD` at worktree creation (full SHA). */
  readonly baseCommit?: string
  /** Additive (Phase 5): the task branch tip after the task's commit (full SHA; = `baseCommit` when the task produced no changes). */
  readonly headCommit?: string
  readonly acceptanceCriteria: readonly string[]
  /** Executions already STARTED (initial 0; bumps on `ready → running`). */
  readonly attempt: number
  /** Retry budget; defaults to the service constant at materialization. */
  readonly maxAttempts?: number
  /** Concise human-readable result (≤1000); terminal `succeeded` only. */
  readonly outputSummary?: string
  readonly error?: string
  /** Only when the runtime reported usage (master spec §29 — never invented). */
  readonly tokenUsage?: TokenTotals
  /** Turn count of the last execution, when the runtime reported it. */
  readonly turnCount?: number
  readonly startedAt?: string
  readonly completedAt?: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Compare-and-set counter for status transitions; starts at 1. */
  readonly version: number
}

/** Client-facing task row (lossless JSON projection of the record). */
export interface ProjectTaskView {
  readonly id: TaskId
  readonly runId: RunId
  readonly planId: PlanId
  readonly planTaskId: string
  readonly title: string
  readonly role?: string
  /** Dependency task titles are resolved by the Host; this carries the ids. */
  readonly dependencies: readonly string[]
  readonly status: ProjectTaskStatus
  readonly assignedAgentId?: string
  /** Additive (Phase 5): the task branch, when the task runs in its own worktree. */
  readonly branch?: string
  /** Additive (Phase 5): the repository `HEAD` at worktree creation. */
  readonly baseCommit?: string
  /** Additive (Phase 5): the task branch tip after the task's commit. */
  readonly headCommit?: string
  readonly acceptanceCriteria: readonly string[]
  readonly attempt: number
  readonly maxAttempts?: number
  readonly outputSummary?: string
  readonly error?: string
  readonly tokenUsage?: TokenTotals
  readonly turnCount?: number
  readonly startedAt?: string
  readonly completedAt?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

/** Per-status task counts for the snapshot run summary (additive). */
export interface TaskCountsView {
  readonly total: number
  readonly pending: number
  readonly ready: number
  readonly running: number
  readonly blocked: number
  readonly failed: number
  readonly succeeded: number
}

/** The worker kind a Host can currently execute tasks with (additive snapshot field). */
export type TaskWorkerKindView = 'local' | 'agent-team' | 'unavailable'

/** Payload of the `dsh-projects/tasks/materialized` Cordis event. */
export interface TasksMaterializedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly planId: PlanId
  readonly version: number
  readonly taskCount: number
  readonly at: string
}

/** Payload of a `dsh-projects/task/*` Cordis event. */
export interface TaskStatusEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly planId: PlanId
  readonly taskId: TaskId
  readonly status: ProjectTaskStatus
  readonly at: string
}
