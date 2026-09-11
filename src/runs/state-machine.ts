/** Explicit, validated lifecycle transitions for Project Runs (spec §6, §58). */

import type { ProjectRunPhase, ProjectRunRecord } from './types.ts'

export const RUN_PHASES = [
  'created', 'planning', 'awaiting_approval', 'executing', 'integrating',
  'validating', 'finalizing', 'succeeded', 'failed', 'canceled', 'paused', 'blocked',
] as const satisfies readonly ProjectRunPhase[]

export const TERMINAL_RUN_PHASES: readonly ProjectRunPhase[] = ['succeeded', 'failed', 'canceled']

export const SUSPENDED_RUN_PHASES: readonly ProjectRunPhase[] = ['paused', 'blocked']

/** Static forward/back edges; suspended phases resolve dynamically to `suspendedFrom`. */
const ALLOWED_TRANSITIONS: Readonly<Record<ProjectRunPhase, readonly ProjectRunPhase[]>> = {
  created: ['planning', 'canceled'],
  planning: ['awaiting_approval', 'executing', 'paused', 'blocked', 'failed', 'canceled'],
  awaiting_approval: ['executing', 'planning', 'paused', 'blocked', 'failed', 'canceled'],
  executing: ['integrating', 'validating', 'finalizing', 'paused', 'blocked', 'failed', 'canceled'],
  integrating: ['validating', 'finalizing', 'paused', 'blocked', 'failed', 'canceled'],
  validating: ['finalizing', 'executing', 'paused', 'blocked', 'failed', 'canceled'],
  finalizing: ['succeeded', 'failed', 'canceled'],
  paused: ['failed', 'canceled'],
  blocked: ['failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
}

export interface RunTransitionContext {
  /** ISO timestamp for the transition; injectable for tests. */
  readonly now: string
  readonly error?: string
  readonly resultSummary?: string
}

export interface RunTransitionResult {
  readonly next: ProjectRunRecord
  /** True when a suspended run returned to its `suspendedFrom` phase. */
  readonly resumed: boolean
}

/** Rejected Run lifecycle transition; the service maps it to a stable Dashboard error code. */
export class RunTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunTransitionError'
  }
}

/** Phases reachable from `current` for this record; suspended phases resolve to their origin. */
export function allowedTransitions(current: ProjectRunPhase, suspendedFrom?: ProjectRunPhase): readonly ProjectRunPhase[] {
  if (current === 'paused' || current === 'blocked') {
    return suspendedFrom === undefined ? [] : [suspendedFrom, 'failed', 'canceled']
  }
  return ALLOWED_TRANSITIONS[current]
}

/**
 * Validate one transition and produce the next record. Pure: persistence and
 * event emission are the service's job; this is the single authority for Run
 * state invariants (spec §58).
 */
export function transitionRun(
  run: ProjectRunRecord,
  to: ProjectRunPhase,
  context: RunTransitionContext,
): RunTransitionResult {
  if (run.phase === to) {
    throw new RunTransitionError(`run ${run.id} is already in phase ${to}`)
  }
  const allowed = allowedTransitions(run.phase, run.suspendedFrom)
  if (!allowed.includes(to)) {
    throw new RunTransitionError(`invalid Run transition ${run.phase} → ${to} for run ${run.id}`)
  }
  const terminal = TERMINAL_RUN_PHASES.includes(to)
  const suspended = to === 'paused' || to === 'blocked'
  const startedAt = to === 'executing' ? (run.startedAt ?? context.now) : run.startedAt
  const error = to === 'failed' && context.error !== undefined ? context.error : run.error
  const resultSummary = to === 'succeeded' && context.resultSummary !== undefined
    ? context.resultSummary
    : run.resultSummary
  const next: ProjectRunRecord = {
    id: run.id,
    projectId: run.projectId,
    goal: run.goal,
    source: run.source,
    ...(run.sourceRef === undefined ? {} : { sourceRef: run.sourceRef }),
    phase: to,
    // Leaving a suspended phase always clears the recorded origin.
    ...(suspended ? { suspendedFrom: run.phase } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(terminal ? { completedAt: context.now } : run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.tokenUsage === undefined ? {} : { tokenUsage: run.tokenUsage }),
    ...(resultSummary === undefined ? {} : { resultSummary }),
    ...(error === undefined ? {} : { error }),
    // Phase 2: the active plan survives run phase transitions (only plan
    // coupling clears/sets it).
    ...(run.activePlanId === undefined ? {} : { activePlanId: run.activePlanId }),
    createdAt: run.createdAt,
    updatedAt: context.now,
    phaseChangedAt: context.now,
    version: run.version + 1,
  }
  return {
    next,
    resumed: (run.phase === 'paused' || run.phase === 'blocked') && to !== 'failed' && to !== 'canceled',
  }
}

/** Terminal runs cannot move; used to reject stale orchestration callbacks. */
export function isTerminalRunPhase(phase: ProjectRunPhase): boolean {
  return TERMINAL_RUN_PHASES.includes(phase)
}

export function isSuspendedRunPhase(phase: ProjectRunPhase): boolean {
  return SUSPENDED_RUN_PHASES.includes(phase)
}
