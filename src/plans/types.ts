/** Versioned Run Plan model (Phase 2): immutable content versions with a small status lifecycle. */

import type { ProjectId } from '../catalog/types.ts'
import type { RunId } from '../runs/types.ts'

export type PlanId = string
export type RunPlanPattern =
  | 'direct'
  | 'prompt-chain'
  | 'parallel-workers'
  | 'supervisor'
  | 'router'
  | 'evaluation-loop'
export type RunPlanStatus = 'draft' | 'awaiting-approval' | 'active' | 'superseded' | 'completed'

/** One measurable outcome the plan is judged against (spec §10). */
export interface PlanSuccessCriterion {
  /** Positional id assigned at create time: `c1`..`cN`. */
  readonly id: string
  readonly description: string
}

/**
 * A planned step inside a plan (spec §11, plan-level only — execution tasks
 * arrive with the Phase 4 DAG). Dependencies reference earlier task ids of the
 * same plan, which makes unknown references, self-dependencies, and cycles
 * impossible by construction; the service still validates.
 */
export interface PlannedTask {
  /** Positional id assigned at create time: `t1`..`tN` (list order). */
  readonly id: string
  readonly title: string
  readonly description: string
  readonly dependencies: readonly string[]
  readonly acceptanceCriteria: readonly string[]
}

/**
 * One immutable content version of a Run's plan (spec §10). Only `status`
 * (and its CAS `revision`) may move after creation; "editing" a plan means
 * creating version N+1.
 */
export interface RunPlanRecord {
  readonly id: PlanId
  readonly runId: RunId
  readonly projectId: ProjectId
  /** Per-run plan version (1-based), immutable after creation. */
  readonly version: number
  readonly pattern: RunPlanPattern
  readonly rationale: string
  readonly assumptions: readonly string[]
  readonly successCriteria: readonly PlanSuccessCriterion[]
  readonly tasks: readonly PlannedTask[]
  readonly status: RunPlanStatus
  /** Required when this version supersedes a prior one (spec §10). */
  readonly replanReason?: string
  /** The plan this version replaces (version > 1 only). */
  readonly supersedesPlanId?: PlanId
  readonly createdAt: string
  /** Compare-and-set counter for status transitions; starts at 1. */
  readonly revision: number
}

/** Payload for `RunPlanService.createPlan` (service assigns ids and version). */
export interface CreatePlanInput {
  readonly runId: RunId
  readonly pattern: RunPlanPattern
  readonly rationale: string
  readonly assumptions?: readonly string[]
  /** Plain descriptions; the service assigns `c1`..`cN`. */
  readonly successCriteria?: readonly string[]
  readonly tasks?: readonly PlannedTaskInput[]
  /** Required when a prior plan version already exists for the run. */
  readonly replanReason?: string
}

/** One planned task as accepted over the RPC boundary (ids assigned by the service). */
export interface PlannedTaskInput {
  readonly title: string
  readonly description: string
  /** Ids of EARLIER tasks in the same list (`t1`..`t{position-1}`). */
  readonly dependencies?: readonly string[]
  readonly acceptanceCriteria?: readonly string[]
}

/** Options for `RunPlanService.transitionPlan`. */
export interface TransitionPlanOptions {
  /** Compare-and-set guard; omitted accepts the current revision. */
  readonly expectedRevision?: number
  /** Required when targeting `superseded`. */
  readonly replanReason?: string
}
