/**
 * Versioned Run Plans (Phase 2): immutable content versions with a validated
 * status lifecycle, atomic Run coupling (`activePlanId`), and the per-run
 * event stream. Plan *content* never mutates after creation; a replan creates
 * version N+1 (spec §10).
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectRunService } from '../runs/run-service.ts'
import { isTerminalRunPhase } from '../runs/state-machine.ts'
import type { ProjectRunEventRecord, ProjectRunRecord } from '../runs/types.ts'
import type { RunEventId, RunId } from '../runs/types.ts'
import type { ProjectId } from '../catalog/types.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import { PlanTransitionError, transitionPlan } from './state-machine.ts'
import type {
  CreatePlanInput,
  PlanId,
  PlannedTask,
  PlanSuccessCriterion,
  RunPlanPattern,
  RunPlanRecord,
  RunPlanStatus,
  TransitionPlanOptions,
} from './types.ts'

const PLAN_LIST_LIMIT = 50
const MAX_PLAN_RATIONALE_LENGTH = 2_000
const MAX_PLAN_TASKS = 50
const MAX_TASK_TITLE_LENGTH = 300
const MAX_TASK_DESCRIPTION_LENGTH = 4_000
const MAX_TASK_CRITERIA = 20
const MAX_CRITERION_LENGTH = 500
const EVENT_DETAIL_LIMIT = 200

/** Payload of the `dsh-projects/plan/created` Cordis event. */
export interface PlanCreatedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly planId: PlanId
  readonly version: number
  readonly pattern: RunPlanPattern
  readonly at: string
}

/** Payload of a `dsh-projects/plan/*` status-change Cordis event. */
export interface PlanStatusChangedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly planId: PlanId
  readonly version: number
  readonly from: RunPlanStatus
  readonly to: RunPlanStatus
  readonly at: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A versioned Run Plan was created (persisted first). */
    'dsh-projects/plan/created'(event: PlanCreatedEvent): void
    /** A plan moved to `awaiting-approval` (persisted first). */
    'dsh-projects/plan/approval-requested'(event: PlanStatusChangedEvent): void
    /** A plan was approved and became `active` (persisted first). */
    'dsh-projects/plan/approved'(event: PlanStatusChangedEvent): void
    /** A plan awaiting approval was rejected back to `draft` (persisted first). */
    'dsh-projects/plan/rejected'(event: PlanStatusChangedEvent): void
    /** A plan version was superseded by a newer one (persisted first). */
    'dsh-projects/plan/superseded'(event: PlanStatusChangedEvent): void
    /** The active plan completed (persisted first). */
    'dsh-projects/plan/completed'(event: PlanStatusChangedEvent): void
    /** A run's active plan changed because an older plan was superseded (persisted first). */
    'dsh-projects/run/replanned'(event: PlanStatusChangedEvent): void
  }
}

interface PlanTables {
  readonly plans: KvTable<PlanId, RunPlanRecord>
  readonly runs: KvTable<RunId, ProjectRunRecord>
  readonly events: KvTable<RunEventId, ProjectRunEventRecord>
}

/**
 * Phase 3 optional hooks. `onPlanStatus` is awaited after a plan status
 * transition has fully succeeded (plan update, built-in run coupling, event
 * append, Cordis emit); omitting it preserves the Phase 2 behavior.
 */
export interface RunPlanServiceHooks {
  readonly onPlanStatus?: (event: PlanStatusChangedEvent) => Promise<void>
}

/**
 * Owns Run Plan state inside the shared `dsh_projects` domain (opened by
 * {@link ProjectRunService}). Run coupling — setting/clearing
 * `run.activePlanId` and superseding the prior active plan — happens in the
 * same service so the two tables cannot drift apart.
 */
export class RunPlanService {
  private tables: PlanTables | undefined

  constructor(
    private readonly ctx: Context,
    private readonly runService: ProjectRunService,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly hooks: RunPlanServiceHooks = {},
  ) {}

  /** Borrow the shared domain tables; requires the Run service to be started. */
  start(): void {
    if (this.tables !== undefined) throw new Error('dsh-projects: Plan service is already started')
    const domain = this.runService.domain()
    this.tables = {
      plans: domain.table('plans'),
      runs: domain.table('runs'),
      events: domain.table('run_events'),
    }
  }

  /** Drop table references only; the Run service owns the shared domain lifecycle. Idempotent. */
  stop(): void {
    this.tables = undefined
  }

  /** Create one immutable plan version in status `draft` with its first event. */
  async createPlan(input: CreatePlanInput): Promise<RunPlanRecord> {
    const tables = this.requireStarted()
    const run = tables.runs.get(input.runId)
    if (run === undefined) {
      throw new DashboardDomainError('plan.runUnknown', `unknown Run ${input.runId}`, { runId: input.runId })
    }
    if (isTerminalRunPhase(run.phase)) {
      throw new DashboardDomainError('plan.runTerminal', `run ${input.runId} is ${run.phase}; plans cannot be created for terminal runs`, {
        runId: input.runId,
        phase: run.phase,
      })
    }
    const rationale = input.rationale.trim()
    if (rationale === '') {
      throw new DashboardDomainError('plan.rationaleEmpty', 'a plan rationale must not be empty')
    }
    if (rationale.length > MAX_PLAN_RATIONALE_LENGTH) {
      throw new DashboardDomainError('plan.rationaleTooLong', `a plan rationale must be at most ${MAX_PLAN_RATIONALE_LENGTH} characters`, {
        maxLength: MAX_PLAN_RATIONALE_LENGTH,
      })
    }
    const taskInputs = input.tasks ?? []
    if (taskInputs.length > MAX_PLAN_TASKS) {
      throw new DashboardDomainError('plan.tasksTooMany', `a plan may have at most ${MAX_PLAN_TASKS} tasks`, {
        max: MAX_PLAN_TASKS,
      })
    }
    if (input.pattern !== 'direct' && taskInputs.length === 0) {
      throw new DashboardDomainError('plan.patternRequiresTasks', `plan pattern ${input.pattern} requires at least one planned task`, {
        pattern: input.pattern,
      })
    }
    const tasks: PlannedTask[] = []
    for (let index = 0; index < taskInputs.length; index += 1) {
      const taskInput = taskInputs[index]!
      const id = `t${index + 1}`
      const title = taskInput.title.trim()
      if (title === '') {
        throw new DashboardDomainError('plan.taskTitleEmpty', `planned task ${id} requires a non-empty title`, { task: id })
      }
      if (title.length > MAX_TASK_TITLE_LENGTH) {
        throw new DashboardDomainError('plan.contentInvalid', `planned task ${id} title must be at most ${MAX_TASK_TITLE_LENGTH} characters`, {
          task: id,
          maxLength: MAX_TASK_TITLE_LENGTH,
        })
      }
      const description = taskInput.description.trim()
      if (description === '' || description.length > MAX_TASK_DESCRIPTION_LENGTH) {
        throw new DashboardDomainError('plan.contentInvalid', `planned task ${id} requires a description of at most ${MAX_TASK_DESCRIPTION_LENGTH} characters`, {
          task: id,
          maxLength: MAX_TASK_DESCRIPTION_LENGTH,
        })
      }
      const criteria = (taskInput.acceptanceCriteria ?? []).map(criterion => criterion.trim())
      if (criteria.length > MAX_TASK_CRITERIA
        || criteria.some(criterion => criterion === '' || criterion.length > MAX_CRITERION_LENGTH)) {
        throw new DashboardDomainError('plan.contentInvalid', `planned task ${id} requires at most ${MAX_TASK_CRITERIA} non-empty acceptance criteria`, {
          task: id,
          max: MAX_TASK_CRITERIA,
        })
      }
      for (const dependency of taskInput.dependencies ?? []) {
        // Dependencies may only reference EARLIER tasks: no self-deps, unknown
        // refs, or cycles are possible by construction (spec §11/§12 minimum).
        if (!/^t[1-9][0-9]*$/.test(dependency) || Number(dependency.slice(1)) >= index + 1) {
          throw new DashboardDomainError('plan.taskDependencyInvalid', `planned task ${id} may only depend on earlier tasks (t1..t${index})`, {
            task: id,
            dependency,
          })
        }
      }
      tasks.push({
        id,
        title,
        description,
        dependencies: [...(taskInput.dependencies ?? [])],
        acceptanceCriteria: [...criteria],
      })
    }
    const criteria = (input.successCriteria ?? []).map(description => description.trim())
    if (criteria.length > MAX_TASK_CRITERIA
      || criteria.some(description => description === '' || description.length > MAX_CRITERION_LENGTH)) {
      throw new DashboardDomainError('plan.contentInvalid', `a plan requires at most ${MAX_TASK_CRITERIA} non-empty success criteria`, {
        max: MAX_TASK_CRITERIA,
      })
    }
    const successCriteria: PlanSuccessCriterion[] = criteria.map((description, index) => ({
      id: `c${index + 1}`,
      description,
    }))

    let version = 0
    let supersedesPlanId: PlanId | undefined
    for (const [, existing] of tables.plans.entries()) {
      if (existing.runId === input.runId && existing.version > version) {
        version = existing.version
        supersedesPlanId = existing.id
      }
    }
    const replanRequired = version > 0
    const replanReason = input.replanReason?.trim()
    if (replanRequired && (replanReason === undefined || replanReason === '')) {
      throw new DashboardDomainError('plan.supersedeReasonMissing', `this run already has plan v${version}; creating v${version + 1} requires a replan reason`)
    }
    const at = this.clock()
    const record: RunPlanRecord = {
      id: randomUUID(),
      runId: input.runId,
      projectId: run.projectId,
      version: version + 1,
      pattern: input.pattern,
      rationale,
      assumptions: [...(input.assumptions ?? [])],
      successCriteria,
      tasks,
      status: 'draft',
      ...(replanRequired ? {
        replanReason: replanReason!,
        ...(supersedesPlanId === undefined ? {} : { supersedesPlanId }),
      } : {}),
      createdAt: at,
      revision: 1,
    }
    await tables.plans.put(record.id, record)
    await this.appendRunEvent({
      runId: input.runId,
      projectId: run.projectId,
      type: 'plan.created',
      title: `Plan v${record.version} created`,
      detail: `pattern=${record.pattern}, tasks=${tasks.length}`,
      at,
    })
    this.ctx.emit('dsh-projects/plan/created', {
      runId: input.runId,
      projectId: run.projectId,
      planId: record.id,
      version: record.version,
      pattern: record.pattern,
      at,
    })
    return record
  }

  /** All plan versions for one run, newest version first, bounded. */
  planList(runId: RunId): RunPlanRecord[] {
    const tables = this.requireStarted()
    const rows: RunPlanRecord[] = []
    for (const [, plan] of tables.plans.entries()) {
      if (plan.runId === runId) rows.push(plan)
    }
    rows.sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt))
    return rows.slice(0, PLAN_LIST_LIMIT)
  }

  /** One plan by id. */
  planDetail(planId: PlanId): RunPlanRecord {
    const tables = this.requireStarted()
    const plan = tables.plans.get(planId)
    if (plan === undefined) {
      throw new DashboardDomainError('plan.unknown', `unknown plan ${planId}`, { planId })
    }
    return plan
  }

  /**
   * Validate and apply one plan status transition (single authority, spec §58)
   * with compare-and-set, then apply the Run coupling for the new status.
   */
  async transitionPlan(planId: PlanId, to: RunPlanStatus, options: TransitionPlanOptions = {}): Promise<RunPlanRecord> {
    const tables = this.requireStarted()
    const before = tables.plans.get(planId)
    if (before === undefined) {
      throw new DashboardDomainError('plan.unknown', `unknown plan ${planId}`, { planId })
    }
    const run = tables.runs.get(before.runId)
    if (to === 'active' && run !== undefined && isTerminalRunPhase(run.phase)) {
      throw new DashboardDomainError('plan.runTerminal', `run ${run.id} is ${run.phase}; plans cannot be activated for terminal runs`, {
        runId: run.id,
        phase: run.phase,
      })
    }
    let next: RunPlanRecord
    try {
      next = await tables.plans.update(planId, current => {
        if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
          throw new DashboardDomainError(
            'plan.revisionConflict',
            `plan ${planId} changed concurrently (expected revision ${options.expectedRevision}, found ${current.revision})`,
            { expectedRevision: options.expectedRevision, actualRevision: current.revision },
          )
        }
        return transitionPlan(current, to, {
          ...(options.replanReason === undefined ? {} : { replanReason: options.replanReason }),
        })
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new DashboardDomainError('plan.unknown', `unknown plan ${planId}`, { planId })
      }
      if (error instanceof PlanTransitionError) {
        throw new DashboardDomainError('plan.transitionInvalid', error.message, {
          runId: before.runId,
          from: before.status,
          to,
        })
      }
      throw error
    }
    const statusEvent = await this.applyRunCoupling(tables, run, before, next)
    // Phase 3: the guarded run-phase coupling observes the fully-persisted
    // transition; a hook failure never undoes the plan transition.
    await this.hooks.onPlanStatus?.(statusEvent)
    return next
  }

  /**
   * Keep `run.activePlanId` and the prior active plan consistent with the new
   * status, then append the matching run event(s) and emit Cordis events.
   * Returns the status-change payload so the Phase 3 hook can reuse it.
   */
  private async applyRunCoupling(
    tables: PlanTables,
    run: ProjectRunRecord | undefined,
    before: RunPlanRecord,
    next: RunPlanRecord,
  ): Promise<PlanStatusChangedEvent> {
    const at = this.clock()
    const statusEvent: PlanStatusChangedEvent = {
      runId: next.runId,
      projectId: next.projectId,
      planId: next.id,
      version: next.version,
      from: before.status,
      to: next.status,
      at,
    }
    switch (next.status) {
      case 'active': {
        // Spec §5.4: the prior active plan is retired with the NEW plan's stored
        // replan reason, or a default describing the activation.
        const activationReason = next.replanReason ?? `Plan v${next.version} activated`
        const priorId = run?.activePlanId
        if (priorId !== undefined && priorId !== next.id) {
          const prior = tables.plans.get(priorId)
          if (prior !== undefined && prior.status === 'active') {
            await tables.plans.update(priorId, current => transitionPlan(current, 'superseded', {
              replanReason: activationReason,
            }))
            await this.appendRunEvent({
              runId: next.runId,
              projectId: next.projectId,
              type: 'plan.superseded',
              title: `Plan v${prior.version} superseded`,
              detail: truncateDetail(activationReason),
              at,
            })
          }
        }
        if (run !== undefined) {
          await tables.runs.update(run.id, current => ({
            ...current,
            activePlanId: next.id,
            updatedAt: at,
            version: current.version + 1,
          }))
        }
        await this.appendRunEvent({
          runId: next.runId,
          projectId: next.projectId,
          type: 'plan.approved',
          title: `Plan v${next.version} approved`,
          at,
        })
        if (run !== undefined && priorId !== undefined && priorId !== next.id) {
          const prior = tables.plans.get(priorId)
          await this.appendRunEvent({
            runId: next.runId,
            projectId: next.projectId,
            type: 'run.replanned',
            title: 'Run replanned',
            detail: prior === undefined ? `Plan → v${next.version}` : `Plan v${prior.version} → v${next.version}`,
            at,
          })
          this.ctx.emit('dsh-projects/run/replanned', statusEvent)
        }
        this.ctx.emit('dsh-projects/plan/approved', statusEvent)
        return statusEvent
      }
      case 'superseded': {
        if (run !== undefined && run.activePlanId === next.id) {
          await tables.runs.update(run.id, current => {
            // Dropping the optional property requires omitting it, not deleting it.
            const { activePlanId: _cleared, ...rest } = current
            return { ...rest, updatedAt: at, version: current.version + 1 }
          })
        }
        await this.appendRunEvent({
          runId: next.runId,
          projectId: next.projectId,
          type: 'plan.superseded',
          title: `Plan v${next.version} superseded`,
          detail: truncateDetail(next.replanReason ?? 'superseded'),
          at,
        })
        this.ctx.emit('dsh-projects/plan/superseded', statusEvent)
        return statusEvent
      }
      case 'completed': {
        await this.appendRunEvent({
          runId: next.runId,
          projectId: next.projectId,
          type: 'plan.completed',
          title: `Plan v${next.version} completed`,
          at,
        })
        this.ctx.emit('dsh-projects/plan/completed', statusEvent)
        return statusEvent
      }
      case 'awaiting-approval': {
        await this.appendRunEvent({
          runId: next.runId,
          projectId: next.projectId,
          type: 'plan.approval.requested',
          title: `Plan v${next.version} approval requested`,
          at,
        })
        this.ctx.emit('dsh-projects/plan/approval-requested', statusEvent)
        return statusEvent
      }
      case 'draft': {
        await this.appendRunEvent({
          runId: next.runId,
          projectId: next.projectId,
          type: 'plan.rejected',
          title: `Plan v${next.version} rejected`,
          at,
        })
        this.ctx.emit('dsh-projects/plan/rejected', statusEvent)
        return statusEvent
      }
    }
  }

  /** Append one high-level event on the run's per-run seq (same stream as run events). */
  private async appendRunEvent(input: {
    readonly runId: RunId
    readonly projectId: ProjectId
    readonly type: ProjectRunEventRecord['type']
    readonly title: string
    readonly detail?: string
    readonly at: string
  }): Promise<void> {
    const events = this.requireStarted().events
    let seq = 0
    for (const [, existing] of events.entries()) {
      if (existing.runId === input.runId && existing.seq > seq) seq = existing.seq
    }
    const record: ProjectRunEventRecord = {
      id: randomUUID(),
      runId: input.runId,
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      seq: seq + 1,
      at: input.at,
    }
    await events.put(record.id, record)
  }

  private requireStarted(): PlanTables {
    const tables = this.tables
    if (tables === undefined) throw new DashboardDomainError('plan.notStarted', 'Plan service is not started')
    return tables
  }
}

function truncateDetail(value: string): string {
  return value.length <= EVENT_DETAIL_LIMIT ? value : `${value.slice(0, EVENT_DETAIL_LIMIT - 1)}…`
}
