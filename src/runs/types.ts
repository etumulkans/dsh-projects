/** Durable Project Run records and lossless Host-to-client projections (Phase 1). */

import type { ApprovalMode, ApprovalRequestRecord } from '../approvals/types.ts'
import type { ProjectArtifactRecord } from '../artifacts/types.ts'
import type { ProjectTriggerRecord } from '../triggers/types.ts'
import type { ProjectId } from '../catalog/types.ts'
import type { TokenTotals } from '../runtime/types.ts'
import type { ProjectTaskView, TaskCountsView, TaskWorkerKindView } from '../tasks/types.ts'

/**
 * Additive (Phase 7): the run's budget limits (master spec §30). All keys
 * optional; a key absent (or `budget` itself absent) is unlimited for that
 * key. `maxCost` is declared but unenforceable until a cost source exists
 * (spec §5.5).
 */
export interface RunBudget {
  readonly maxRuntimeMinutes?: number
  readonly maxTotalTokens?: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly maxAgents?: number
  readonly maxConcurrentAgents?: number
  readonly maxReplans?: number
  readonly maxRetriesPerTask?: number
  readonly maxCost?: number
}

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
  /** Additive (Phase 5): the integrated branch produced by the run's integration step (survives to `succeeded`). */
  readonly integrationBranch?: string
  /** Additive (Phase 5): the integrated branch tip at integration completion (full SHA). */
  readonly integrationHead?: string
  /** Additive (Phase 7): the approval mode governing this run (config default when absent). */
  readonly approvalMode?: ApprovalMode
  /** Additive (Phase 7): the run's budget limits. Absent or key-absent = unlimited for that key. */
  readonly budget?: RunBudget
  /** Additive (Phase 7): budget keys that already emitted their 80% warning (one warning per key per run). */
  readonly budgetWarnings?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly phaseChangedAt: string
  readonly version: number
}

/**
 * High-level run event types: Phase 1 run events + Phase 2 plan events +
 * Phase 3 coordinator events + Phase 4 task lifecycle + Phase 5 integration.
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
  // Additive (Phase 5): the run's integration step (spec §3.3).
  | 'run.integration.started'
  | 'run.integration.completed'
  | 'run.integration.failed'
  // Additive (Phase 6): memory distillation of a finished run (spec §3.3).
  | 'run.memory.distilled'
  | 'run.memory.distillation.failed'
  // Additive (Phase 7): the approval-object projection (spec §3.3).
  | 'run.approval.requested'
  | 'run.approval.resolved'
  // Additive (Phase 7): budget enforcement (spec §5.2).
  | 'run.budget.warning'
  | 'run.budget.exceeded'
  // Additive (Phase 8): the artifact projection (spec §3.2).
  | 'artifact.created'
  // Additive (Phase 8): final-report generation failure (spec §6.5).
  | 'run.report.failed'
  // Additive (Phase 9): a trigger created a run (spec §3.4).
  | 'trigger.fired'

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
  /** Additive (Phase 5): the integrated branch, when the run produced one. */
  readonly integrationBranch?: string
  /** Additive (Phase 5): the integrated branch tip at integration completion. */
  readonly integrationHead?: string
  /** Additive (Phase 7): the approval mode governing this run. */
  readonly approvalMode?: ApprovalMode
  /** Additive (Phase 7): the run's budget limits (absent = unlimited). */
  readonly budget?: RunBudget
  /** Additive (Phase 7): budget keys that already emitted their 80% warning. */
  readonly budgetWarnings?: readonly string[]
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
  /** Additive (Phase 7): the run's approval objects (newest first); absent when the Host has no approval service. */
  readonly approvals?: readonly ApprovalRequestRecord[]
  /** Additive (Phase 8): the run's artifacts (newest first); absent when the Host has no artifact service. */
  readonly artifacts?: readonly ProjectArtifactRecord[]
  /** Additive (Phase 8): the run's `final-report` artifact, when present. */
  readonly finalReport?: ProjectArtifactRecord
  /** Additive (Phase 9): the run's originating trigger (resolved from `sourceRef`), when present. */
  readonly trigger?: ProjectTriggerRecord
}

export interface CreateRunInput {
  /** Defaults to the selected project; required in global mode. */
  readonly projectId?: ProjectId
  readonly goal: string
  readonly source?: ProjectRunSource
  readonly sourceRef?: string
  /** Additive (Phase 7): per-run approval mode override (config default when absent). */
  readonly approvalMode?: ApprovalMode
  /** Additive (Phase 7): the run's budget limits (absent = unlimited). */
  readonly budget?: RunBudget
}
