/** Durable Project Run lifecycle: storage, events, and the single transition authority. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ApprovalMode } from '../approvals/types.ts'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import type { ProjectCatalogSelection, ProjectId } from '../catalog/types.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import { isTerminalRunPhase, RunTransitionError, transitionRun, type RunTransitionContext } from './state-machine.ts'
import { dshProjectsDomainSpec, runBudgetSchema } from './spec.ts'
import type {
  CreateRunInput,
  ProjectRunEventRecord,
  ProjectRunEventView,
  ProjectRunPhase,
  ProjectRunRecord,
  ProjectRunView,
  ProjectRunSummary,
  RunBudget,
  RunDetailView,
  RunEventId,
  RunId,
} from './types.ts'

const SNAPSHOT_RUNS_PROJECT_LIMIT = 50
const SNAPSHOT_RUNS_GLOBAL_LIMIT = 100
const DETAIL_EVENTS_LIMIT = 100
const MAX_GOAL_LENGTH = 4_000

/** Payload of the `dsh-projects/run/created` Cordis event. */
export interface RunCreatedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly goal: string
  readonly source: string
  readonly at: string
}

/** Payload of the `dsh-projects/run/phase-changed` Cordis event. */
export interface RunPhaseChangedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly from: ProjectRunPhase
  readonly to: ProjectRunPhase
  readonly at: string
}

/** Payload of the `dsh-projects/run/completed` Cordis event. */
export interface RunCompletedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly phase: ProjectRunPhase
  readonly error?: string
  readonly at: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A Project Run was created (persisted first). */
    'dsh-projects/run/created'(event: RunCreatedEvent): void
    /** A Project Run moved between lifecycle phases (persisted first). */
    'dsh-projects/run/phase-changed'(event: RunPhaseChangedEvent): void
    /** A Project Run reached a terminal phase (persisted first). */
    'dsh-projects/run/completed'(event: RunCompletedEvent): void
  }
}

export interface TransitionRunOptions {
  /** Compare-and-set guard; omitted accepts the current version. */
  readonly expectedVersion?: number
  /** Carried onto the record when entering `failed`. */
  readonly error?: string
  /** Carried onto the record when entering `succeeded` (and, additive Phase 7, `paused` — the budget "why stopped" explanation, spec §5.3). */
  readonly resultSummary?: string
}

/**
 * Owns Run state in the `dsh_projects` Harness storage domain. Runs are
 * catalog-scoped but independent of the tracker orchestrator, so they exist
 * for a project even when its WORKFLOW.md is invalid, and every record
 * survives a process restart because the domain reloads on `start()`.
 */
export class ProjectRunService {
  private openedDomain: Domain<typeof dshProjectsDomainSpec> | undefined
  private runs: KvTable<RunId, ProjectRunRecord> | undefined
  private events: KvTable<RunEventId, ProjectRunEventRecord> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly clock: () => string = () => new Date().toISOString(),
    /** Additive (Phase 7, spec §6.1): the conservative config default stamped on new runs when the input does not override it. */
    private readonly defaultApprovalMode?: ApprovalMode,
  ) {}

  /** Open the `dsh_projects` domain; all records become readable. */
  async start(): Promise<void> {
    if (this.openedDomain !== undefined) throw new Error('dsh-projects: Run service is already started')
    const domain = await this.ctx.storageDomain.open(dshProjectsDomainSpec)
    this.openedDomain = domain
    this.runs = domain.table('runs')
    this.events = domain.table('run_events')
  }

  /**
   * The opened `dsh_projects` domain. Sibling services (Phase 2 plans) borrow
   * this handle instead of opening the domain again — one open per domain
   * name; this service remains the owner that closes it on `stop()`.
   */
  domain(): Domain<typeof dshProjectsDomainSpec> {
    const domain = this.openedDomain
    if (domain === undefined) throw new DashboardDomainError('run.notStarted', 'Run service is not started')
    return domain
  }

  /** Drain and close the domain; idempotent. */
  async stop(): Promise<void> {
    const domain = this.openedDomain
    this.openedDomain = undefined
    this.runs = undefined
    this.events = undefined
    await domain?.close()
  }

  /** Create one manual/trigger Run in phase `created` and persist it with its first event. */
  async createRun(input: CreateRunInput, selection: ProjectCatalogSelection): Promise<ProjectRunRecord> {
    const runs = this.requireStarted()
    const goal = input.goal.trim()
    if (goal === '') {
      throw new DashboardDomainError('run.goalEmpty', 'a Run goal must not be empty')
    }
    if (goal.length > MAX_GOAL_LENGTH) {
      throw new DashboardDomainError('run.goalTooLong', `a Run goal must be at most ${MAX_GOAL_LENGTH} characters`, {
        maxLength: MAX_GOAL_LENGTH,
      })
    }
    const projectId = input.projectId ?? (selection.mode === 'project' ? selection.projectId : undefined)
    if (projectId === undefined) {
      throw new DashboardDomainError(
        'run.projectRequired',
        'a manual Run requires a project; select a project or pass projectId',
      )
    }
    if (this.catalog.project(projectId) === undefined) {
      throw new DashboardDomainError('run.projectUnknown', `unknown project ${projectId}`, { projectId })
    }
    const at = this.clock()
    const approvalMode = input.approvalMode ?? this.defaultApprovalMode
    const record: ProjectRunRecord = {
      id: randomUUID(),
      projectId,
      goal,
      source: input.source ?? 'manual',
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
      phase: 'created',
      // Additive (Phase 7): the approval mode (input override, else the
      // config default) and the budget limits (absent = unlimited).
      ...(approvalMode === undefined ? {} : { approvalMode }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      createdAt: at,
      updatedAt: at,
      phaseChangedAt: at,
      version: 1,
    }
    await runs.put(record.id, record)
    await this.appendEvent({
      runId: record.id,
      projectId,
      type: 'run.created',
      title: 'Run created',
      detail: goal.length > 200 ? `${goal.slice(0, 200)}…` : goal,
      at,
    })
    this.ctx.emit('dsh-projects/run/created', {
      runId: record.id,
      projectId,
      goal,
      source: record.source,
      at,
    })
    return record
  }

  /** Bounded newest-first Run projection for `DashboardSnapshot.runs`. */
  async listForSnapshot(selection: ProjectCatalogSelection): Promise<ProjectRunSummary> {
    const runs = this.requireStarted()
    const records: ProjectRunRecord[] = []
    for (const [, record] of runs.entries()) {
      if (selection.mode === 'project' && record.projectId !== selection.projectId) continue
      records.push(record)
    }
    const sorted = records.sort(compareRunsNewestFirst)
    const limit = selection.mode === 'project' ? SNAPSHOT_RUNS_PROJECT_LIMIT : SNAPSHOT_RUNS_GLOBAL_LIMIT
    const rows = sorted.slice(0, limit).map(record => this.toView(record, selection.mode === 'global'))
    return {
      ...(selection.mode === 'project' ? { projectId: selection.projectId } : {}),
      runs: rows,
      total: records.length,
    }
  }

  /** One Run plus its persisted high-level event stream, newest first. */
  async runDetail(runId: RunId): Promise<RunDetailView> {
    const runs = this.requireStarted()
    const events = this.requireEvents()
    const record = runs.get(runId)
    if (record === undefined) {
      throw new DashboardDomainError('run.unknown', `unknown Run ${runId}`, { runId })
    }
    const runEvents: ProjectRunEventRecord[] = []
    for (const [, event] of events.entries()) {
      if (event.runId === runId) runEvents.push(event)
    }
    runEvents.sort((left, right) => right.seq - left.seq || right.at.localeCompare(left.at))
    const truncated = runEvents.length > DETAIL_EVENTS_LIMIT
    const rows: ProjectRunEventView[] = runEvents.slice(0, DETAIL_EVENTS_LIMIT).map(event => ({
      id: event.id,
      type: event.type,
      title: event.title,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
      seq: event.seq,
      at: event.at,
    }))
    return { run: this.toView(record, false), events: rows, truncated }
  }

  /**
   * Validate and apply one lifecycle transition (spec §58 single authority).
   * The version compare-and-set runs inside the domain's atomic write chain,
   * so concurrent transitions cannot corrupt state.
   */
  async transitionRun(runId: RunId, to: ProjectRunPhase, options: TransitionRunOptions = {}): Promise<ProjectRunRecord> {
    const runs = this.requireStarted()
    const from = runs.get(runId)
    if (from === undefined) {
      throw new DashboardDomainError('run.unknown', `unknown Run ${runId}`, { runId })
    }
    const context: RunTransitionContext = {
      now: this.clock(),
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.resultSummary === undefined ? {} : { resultSummary: options.resultSummary }),
    }
    let next: ProjectRunRecord
    try {
      next = await runs.update(runId, current => {
        if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
          throw new DashboardDomainError(
            'run.versionConflict',
            `Run ${runId} changed concurrently (expected version ${options.expectedVersion}, found ${current.version})`,
            { expectedVersion: options.expectedVersion, actualVersion: current.version },
          )
        }
        return transitionRun(current, to, context).next
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new DashboardDomainError('run.unknown', `unknown Run ${runId}`, { runId })
      }
      if (error instanceof RunTransitionError) {
        throw new DashboardDomainError('run.transitionInvalid', error.message, {
          runId,
          from: from.phase,
          to,
        })
      }
      throw error
    }
    if (isTerminalRunPhase(next.phase)) {
      const detail = next.phase === 'failed'
        ? next.error ?? 'Run failed'
        : next.phase === 'succeeded'
          ? next.resultSummary ?? 'Run succeeded'
          : 'Run canceled'
      await this.appendEvent({
        runId: next.id,
        projectId: next.projectId,
        type: 'run.completed',
        title: `Run ${next.phase}`,
        detail,
        at: context.now,
      })
      this.ctx.emit('dsh-projects/run/completed', {
        runId: next.id,
        projectId: next.projectId,
        phase: next.phase,
        ...(next.error === undefined ? {} : { error: next.error }),
        at: context.now,
      })
    } else {
      await this.appendEvent({
        runId: next.id,
        projectId: next.projectId,
        type: 'run.phase.changed',
        title: `Run ${from.phase} → ${next.phase}`,
        detail: `${from.phase} → ${next.phase}`,
        at: context.now,
      })
      this.ctx.emit('dsh-projects/run/phase-changed', {
        runId: next.id,
        projectId: next.projectId,
        from: from.phase,
        to: next.phase,
        at: context.now,
      })
    }
    return next
  }

  /**
   * Additive (Phase 7, spec §5.4): replace the run's budget wholesale. Only
   * legal while the run is `paused` or `blocked` (the phases where a raise
   * makes sense). Keys removed or changed are cleared from `budgetWarnings`
   * so the 80% of the new limit can fire once more.
   */
  async setRunBudget(runId: RunId, budget: RunBudget, expectedVersion?: number): Promise<ProjectRunRecord> {
    const runs = this.requireStarted()
    const parsed = runBudgetSchema.safeParse(budget)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const key = issue !== undefined && typeof issue.path[0] === 'string' ? issue.path[0] : 'budget'
      const reason = issue !== undefined ? issue.message : 'invalid budget'
      throw new DashboardDomainError('run.budgetInvalid', `invalid Run budget: ${reason}`, { key, reason })
    }
    const from = runs.get(runId)
    if (from === undefined) {
      throw new DashboardDomainError('run.unknown', `unknown Run ${runId}`, { runId })
    }
    if (from.phase !== 'paused' && from.phase !== 'blocked') {
      throw new DashboardDomainError('run.budgetPhaseInvalid', `Run ${runId} is ${from.phase}; budgets can only be raised while paused or blocked`, {
        runId,
        phase: from.phase,
      })
    }
    const at = this.clock()
    let next: ProjectRunRecord
    try {
      next = await runs.update(runId, current => {
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          throw new DashboardDomainError(
            'run.versionConflict',
            `Run ${runId} changed concurrently (expected version ${expectedVersion}, found ${current.version})`,
            { expectedVersion, actualVersion: current.version },
          )
        }
        const oldBudget = current.budget
        const warned = current.budgetWarnings ?? []
        const kept = warned.filter(key => {
          const oldLimit = oldBudget === undefined ? undefined : (oldBudget as Record<string, number | undefined>)[key]
          const newLimit = (budget as Record<string, number | undefined>)[key]
          // A key removed from the budget can never warn again; a key whose
          // limit is unchanged keeps its warning (no re-fire).
          if (oldLimit === undefined || newLimit === undefined) return false
          return oldLimit === newLimit
        })
        // Destructure the old warnings out so a raised budget can clear them
        // (exactOptionalPropertyTypes: no `undefined` assignment).
        const { budgetWarnings: _dropped, ...rest } = current
        return {
          ...rest,
          budget,
          ...(kept.length > 0 ? { budgetWarnings: kept } : {}),
          updatedAt: at,
          version: current.version + 1,
        }
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new DashboardDomainError('run.unknown', `unknown Run ${runId}`, { runId })
      }
      throw error
    }
    // No dedicated event (spec §3.3): the record itself (budget + version
    // bump) is the audit trail.
    return next
  }

  private requireStarted(): KvTable<RunId, ProjectRunRecord> {
    const runs = this.runs
    if (runs === undefined) throw new DashboardDomainError('run.notStarted', 'Run service is not started')
    return runs
  }

  private requireEvents(): KvTable<RunEventId, ProjectRunEventRecord> {
    const events = this.events
    if (events === undefined) throw new DashboardDomainError('run.notStarted', 'Run service is not started')
    return events
  }

  private toView(record: ProjectRunRecord, withProjectName: boolean): ProjectRunView {
    const project = withProjectName ? this.catalog.project(record.projectId) : undefined
    return {
      ...record,
      ...(project === undefined ? {} : { projectName: project.name }),
    }
  }

  private async appendEvent(input: {
    readonly runId: RunId
    readonly projectId: ProjectId
    readonly type: ProjectRunEventRecord['type']
    readonly title: string
    readonly detail?: string
    readonly at: string
  }): Promise<void> {
    const events = this.requireEvents()
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
}

function compareRunsNewestFirst(left: ProjectRunRecord, right: ProjectRunRecord): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
}
