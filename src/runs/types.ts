/** Durable Project Run records and lossless Host-to-client projections (Phase 1). */

import type { ProjectId } from '../catalog/types.ts'
import type { TokenTotals } from '../runtime/types.ts'

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
  readonly createdAt: string
  readonly updatedAt: string
  readonly phaseChangedAt: string
  readonly version: number
}

/**
 * High-level run event types: Phase 1 run events + Phase 2 plan events.
 * The stream is per-run, so plan and run events interleave on one seq.
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
}

export interface RunDetailView {
  readonly run: ProjectRunView
  readonly events: readonly ProjectRunEventView[]
  readonly truncated: boolean
}

export interface CreateRunInput {
  /** Defaults to the selected project; required in global mode. */
  readonly projectId?: ProjectId
  readonly goal: string
  readonly source?: ProjectRunSource
  readonly sourceRef?: string
}
