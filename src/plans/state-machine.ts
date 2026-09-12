/** Explicit, validated status transitions for versioned Run Plans (spec §10, §58). */

import type { RunPlanRecord, RunPlanStatus } from './types.ts'

export const PLAN_STATUSES: readonly RunPlanStatus[] = [
  'draft', 'awaiting-approval', 'active', 'superseded', 'completed',
]

export const TERMINAL_PLAN_STATUSES: readonly RunPlanStatus[] = ['superseded', 'completed']

/**
 * Plan status edges. Plan *content* is immutable — this machine moves only
 * `status`; a replan creates version N+1 and supersedes the older version.
 */
const ALLOWED_PLAN_TRANSITIONS: Readonly<Record<RunPlanStatus, readonly RunPlanStatus[]>> = {
  'draft': ['awaiting-approval', 'active', 'superseded'],
  'awaiting-approval': ['active', 'draft', 'superseded'],
  'active': ['completed', 'superseded'],
  'superseded': [],
  'completed': [],
}

/** Rejected plan status transition; the service maps it to a stable Dashboard error code. */
export class PlanTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanTransitionError'
  }
}

export interface PlanTransitionContext {
  /** Required when targeting `superseded`; stored on the record. */
  readonly replanReason?: string
}

/** Statuses reachable from `current`. */
export function allowedPlanTransitions(current: RunPlanStatus): readonly RunPlanStatus[] {
  return ALLOWED_PLAN_TRANSITIONS[current]
}

/**
 * Validate one status transition and produce the next record. Pure:
 * persistence, run coupling, and event emission are the service's job; this
 * is the single authority for plan status invariants (spec §58).
 * `revision` (CAS) bumps only on the terminal-moving edges.
 */
export function transitionPlan(
  plan: RunPlanRecord,
  to: RunPlanStatus,
  context: PlanTransitionContext,
): RunPlanRecord {
  if (plan.status === to) {
    throw new PlanTransitionError(`plan ${plan.id} (v${plan.version}) is already ${to}`)
  }
  if (!ALLOWED_PLAN_TRANSITIONS[plan.status].includes(to)) {
    throw new PlanTransitionError(`invalid plan transition ${plan.status} → ${to} for plan ${plan.id}`)
  }
  if (to === 'superseded' && (context.replanReason === undefined || context.replanReason.trim() === '')) {
    throw new PlanTransitionError(`superseding plan ${plan.id} requires a replan reason`)
  }
  const next: RunPlanRecord = {
    ...plan,
    status: to,
    // Superseding records why the version was retired (spec §10).
    ...(to === 'superseded' && context.replanReason !== undefined
      ? { replanReason: context.replanReason.trim() }
      : {}),
    revision: to === 'superseded' || to === 'completed' ? plan.revision + 1 : plan.revision,
  }
  return next
}

/** Terminal plans cannot move; used to reject stale orchestration callbacks. */
export function isTerminalPlanStatus(status: RunPlanStatus): boolean {
  return TERMINAL_PLAN_STATUSES.includes(status)
}
