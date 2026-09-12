/** Durable Project Run records and lossless Host-to-client projections (Phase 1). */

import type { ProjectId } from '../catalog/types.ts'
import type { TokenTotals } from '../runtime/types.ts'
import type { ProjectTaskView, TaskCountsView, TaskWorkerKindView } from '../tasks/types.ts'

export type RunId = string
export type RunEventId = string

export type ProjectRunSource = 'manual' | 'tracker' | 'schedule' | 'webhook' | 'repository-event' | 'system'

export type ProjectRunPhase =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'integrating'
  | 'validating'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'paused'
  | 'blocked'

/** Durable Run record stored in the `dsh_projects` domain `runs` table. */
export interface ProjectRunRecord {
  readonly id: RunId
  readonly projectId: ProjectId
  readonly goal: string
  readonly source: ProjectRunSource
  readonly sourceRef?: string
  readonly phase: ProjectRunPhase
  /** Phase recorded when the run entered `paused`/`blocked`; target of resume/unblock. */
  readonly suspendedFrom?: ProjectRunPhase
  readonly startedAt?: string
  readonly completedAt?: string
  readonly tokenUsage?: TokenTotals
  readonly resultSummary?: string
  readonly error?: string
  /** Additive (Phase 2): the plan currently active for this run, if any. */
  readonly activePlanId?: string
  /** Additive (Phase 3): session id of the most recent Coordinator Lead session. */
  readonly coordinatorSessionId?: string
  /** Additive (Phase 4): per-run task concurrency override (default 1). */
  readonly maxConcurrentAgents?: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly phaseChangedAt: string
  readonly version: number
}

/**
 * High-level run event types: Phase 1 run events + Phase 2 plan events +
 * Phase 3 coordinator events + Phase 4 task lifecycle.
 * The stream is per-run, so plan, coordinator, task, and run events
 * interleave on one seq.
 */
export type ProjectRunEventType =
  | 'run.created'
  | 'run.phase.changed'
  | 'run.completed'
  | 'plan.created'
  | 'plan.approval.requested'
  | 'plan.approved'
  | 'plan.rejected'
  | 'plan.superseded'
  | 'plan.completed'
  | 'run.replanned'
  | 'run.coordinator.started'
  | 'run.coordinator.completed'
  | 'run.coordinator.failed'
  | 'tasks.materialized'
  | 'task.ready'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'

/** High-level Run event; detailed agent activity stays in Harness session logs. */
export interface ProjectRunEventRecord {
  readonly id: RunEventId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly type: ProjectRunEventType
  readonly title: string
  readonly detail?: string
  /** Per-run monotonic sequence, starting at 1. */
  readonly seq: number
  readonly at: string
}

/** Client-facing Run row for list views. */
export interface ProjectRunView {
  readonly id: RunId
  readonly projectId: ProjectId
  readonly goal: string
  readonly source: ProjectRunSource
  readonly sourceRef?: string
  readonly phase: ProjectRunPhase
  readonly suspendedFrom?: ProjectRunPhase
  readonly startedAt?: string
  readonly completedAt?: string
  readonly tokenUsage?: TokenTotals
  readonly resultSummary?: string
  readonly error?: string
  /** Additive (Phase 2): the plan currently active for this run, if any. */
  readonly activePlanId?: string
  /** Additive (Phase 3): session id of the most recent Coordinator Lead session. */
  readonly coordinatorSessionId?: string
  /** Additive (Phase 4): per-run task concurrency override (default 1). */
  readonly maxConcurrentAgents?: number
  /** Additive (Phase 4): per-status task counts for this run, when the Host has a task service. */
  readonly taskCounts?: TaskCountsView
  readonly createdAt: string
  readonly updatedAt: string
  readonly phaseChangedAt: string
  readonly version: number
  /** Present in the global composite view. */
  readonly projectName?: string
}

/** Client-facing high-level Run event row. */
export interface ProjectRunEventView {
  readonly id: RunEventId
  readonly type: ProjectRunEventType
  readonly title: string
  readonly detail?: string
  readonly seq: number
  readonly at: string
}

/** Bounded Run projection embedded in `DashboardSnapshot.runs`. */
export interface ProjectRunSummary {
  readonly projectId?: ProjectId
  readonly runs: readonly ProjectRunView[]
  readonly total: number
  /** Additive (Phase 4): the task worker kind the Host can currently execute with. */
  readonly worker?: TaskWorkerKindView
}

export interface RunDetailView {
  readonly run: ProjectRunView
  readonly events: readonly ProjectRunEventView[]
  readonly truncated: boolean
  /** Additive (Phase 4): the run's tasks in plan order; absent when the Host has no task service. */
  readonly tasks?: readonly ProjectTaskView[]
}

export interface CreateRunInput {
  /** Defaults to the selected project; required in global mode. */
  readonly projectId?: ProjectId
  readonly goal: string
  readonly source?: ProjectRunSource
  readonly sourceRef?: string
}
