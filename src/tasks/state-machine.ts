/**
 * DSH Projects Phase 4 — pure task state machine.
 *
 * Single authority for task status invariants: the allowed edges, the
 * rejected-no-op idempotency rule, and the next-record construction (CAS
 * `version` bump). Persistence, dependency coupling, events, and worker
 * dispatch live in `ProjectTaskService` — the same split as the run and plan
 * machines.
 */

import type { ProjectTaskRecord, ProjectTaskStatus } from './types.ts'

/**
 * Allowed task transitions (spec §4). `failed → ready` is the operator-retry
 * edge; `running → ready` is the internal retry edge (the service enforces
 * the attempt budget). `awaiting-review` has no edges in Phase 4 — it is
 * unreachable until Phase 7 approval modes.
 */
export const ALLOWED_TASK_TRANSITIONS: Readonly<Record<ProjectTaskStatus, readonly ProjectTaskStatus[]>> = {
  'pending': ['ready', 'blocked', 'canceled'],
  'ready': ['running', 'canceled'],
  'running': ['succeeded', 'failed', 'ready', 'canceled'],
  'blocked': ['ready', 'canceled'],
  'awaiting-review': [],
  'succeeded': [],
  'failed': ['ready'],
  'canceled': [],
}

/** Raised when a requested task transition violates the state machine. */
export class TaskTransitionError extends Error {
  constructor(status: ProjectTaskStatus, to: ProjectTaskStatus) {
    super(`task ${status} → ${to} is not an allowed transition`)
    this.name = 'TaskTransitionError'
  }
}

export function isTerminalTaskStatus(status: ProjectTaskStatus): boolean {
  return ALLOWED_TASK_TRANSITIONS[status].length === 0
}

export interface TaskTransitionContext {
  readonly now: string
  /** Required when targeting `failed`. */
  readonly error?: string
  /** Required when targeting `succeeded`. */
  readonly outputSummary?: string
  /** Required when targeting `running` (the next attempt number). */
  readonly attempt?: number
  /** Set on the first `→ running`; kept on later starts (refreshed). */
  readonly startedAt?: string
  /** Native agent identity of the execution (overwrites the placeholder). */
  readonly assignedAgentId?: string
  readonly tokenUsage?: ProjectTaskRecord['tokenUsage']
  readonly turnCount?: number
  /** Additive (Phase 5): the task branch tip after the task's commit (carried onto `succeeded`). */
  readonly headCommit?: string
}

/**
 * Validate one transition and build the next record (pure; no persistence).
 * Rejects transitions to the current status (idempotency comes from CAS,
 * not silent re-entry) and every edge outside `ALLOWED_TASK_TRANSITIONS`.
 * The next record bumps `version` and refreshes `updatedAt`; `completedAt`
 * is set on terminal entries.
 */
export function transitionTask(
  task: ProjectTaskRecord,
  to: ProjectTaskStatus,
  context: TaskTransitionContext,
): ProjectTaskRecord {
  if (to === task.status) {
    throw new TaskTransitionError(task.status, to)
  }
  if (!ALLOWED_TASK_TRANSITIONS[task.status].includes(to)) {
    throw new TaskTransitionError(task.status, to)
  }
  if (to === 'failed' && context.error === undefined) {
    throw new Error('transitionTask: targeting failed requires context.error')
  }
  if (to === 'succeeded' && context.outputSummary === undefined) {
    throw new Error('transitionTask: targeting succeeded requires context.outputSummary')
  }
  const next = {
    ...task,
    status: to,
    updatedAt: context.now,
    version: task.version + 1,
  }
  if (to === 'running') {
    if (context.attempt === undefined) throw new Error('transitionTask: targeting running requires context.attempt')
    next.attempt = context.attempt
    if (context.startedAt !== undefined) next.startedAt = context.startedAt
    if (context.assignedAgentId !== undefined) next.assignedAgentId = context.assignedAgentId
  }
  if (to === 'succeeded') {
    const summary = context.outputSummary
    if (summary === undefined) throw new Error('transitionTask: targeting succeeded requires context.outputSummary')
    next.outputSummary = summary
    next.completedAt = context.now
    if (context.assignedAgentId !== undefined) next.assignedAgentId = context.assignedAgentId
    if (context.tokenUsage !== undefined) next.tokenUsage = context.tokenUsage
    if (context.turnCount !== undefined) next.turnCount = context.turnCount
    if (context.headCommit !== undefined) next.headCommit = context.headCommit
  }
  if (to === 'failed') {
    const failure = context.error
    if (failure === undefined) throw new Error('transitionTask: targeting failed requires context.error')
    next.error = failure
    next.completedAt = context.now
    if (context.assignedAgentId !== undefined) next.assignedAgentId = context.assignedAgentId
    if (context.tokenUsage !== undefined) next.tokenUsage = context.tokenUsage
    if (context.turnCount !== undefined) next.turnCount = context.turnCount
  }
  if (to === 'canceled') {
    next.completedAt = context.now
    if (context.assignedAgentId !== undefined) next.assignedAgentId = context.assignedAgentId
  }
  return next
}
