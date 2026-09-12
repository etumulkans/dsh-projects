/**
 * DSH Projects Phase 4 — ProjectTaskService.
 *
 * Owns task state inside the shared `dsh_projects` domain (borrowed from the
 * Run service): materialization from the active plan version (via the Phase 3
 * `onPlanStatus` hook), the dependency-gated scheduling tick, execution
 * through the worker seam, retries, retirement on supersede, and run-canceled
 * propagation (spec §7).
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import type { ProjectId } from '../catalog/types.ts'
import type { PlanStatusChangedEvent } from '../plans/plan-service.ts'
import type { PlanId, RunPlanRecord } from '../plans/types.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import { isTerminalRunPhase } from '../runs/state-machine.ts'
import type { ProjectRunEventRecord, ProjectRunRecord } from '../runs/types.ts'
import type { RunEventId, RunId } from '../runs/types.ts'
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TASK_CONCURRENCY,
  EVENT_DETAIL_LIMIT,
  TICK_INTERVAL_MS,
} from './constants.ts'
import { compareTasks, computeDependencyTransitions, pickReadyTasks, TaskGraphError, validateTaskGraph } from './scheduler.ts'
import { isTerminalTaskStatus, TaskTransitionError, transitionTask, type TaskTransitionContext } from './state-machine.ts'
import type { ProjectTaskRecord, ProjectTaskStatus, ProjectTaskView, TaskCountsView, TaskId, TaskStatusEvent, TasksMaterializedEvent } from './types.ts'
import { truncateSummary, type TaskWorker, type TaskWorkerResult } from './worker.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A plan's tasks materialized (persisted first). */
    'dsh-projects/tasks/materialized'(event: TasksMaterializedEvent): void
    /** A task became ready (persisted first). */
    'dsh-projects/task/ready'(event: TaskStatusEvent): void
    /** A task execution started (persisted first). */
    'dsh-projects/task/started'(event: TaskStatusEvent): void
    /** A task completed successfully (persisted first). */
    'dsh-projects/task/completed'(event: TaskStatusEvent): void
    /** A task reached terminal failure (persisted first). */
    'dsh-projects/task/failed'(event: TaskStatusEvent): void
  }
}

interface TaskTables {
  readonly tasks: KvTable<TaskId, ProjectTaskRecord>
  readonly runs: KvTable<RunId, ProjectRunRecord>
  readonly events: KvTable<RunEventId, ProjectRunEventRecord>
  readonly plans: KvTable<PlanId, RunPlanRecord>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lossless client projection of a task record (spec §3.3). */
function toTaskView(task: ProjectTaskRecord): ProjectTaskView {
  return {
    id: task.id,
    runId: task.runId,
    planId: task.planId,
    planTaskId: task.planTaskId,
    title: task.title,
    ...(task.role === undefined ? {} : { role: task.role }),
    dependencies: [...task.dependencies],
    status: task.status,
    ...(task.assignedAgentId === undefined ? {} : { assignedAgentId: task.assignedAgentId }),
    acceptanceCriteria: [...task.acceptanceCriteria],
    attempt: task.attempt,
    ...(task.maxAttempts === undefined ? {} : { maxAttempts: task.maxAttempts }),
    ...(task.outputSummary === undefined ? {} : { outputSummary: task.outputSummary }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.tokenUsage === undefined ? {} : { tokenUsage: task.tokenUsage }),
    ...(task.turnCount === undefined ? {} : { turnCount: task.turnCount }),
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: task.version,
  }
}

/**
 * Phase 4 task service. The worker seam is injected (spec §6): the local
 * Harness worker by default, the experimental Agent Teams worker when
 * configured and mounted, or the explicit unavailable state.
 */
export class ProjectTaskService {
  private tables: TaskTables | undefined
  private readonly inFlight = new Map<TaskId, AbortController>()
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private tickQueued = false
  private removePhaseListener: (() => void) | undefined
  private removeCompletedListener: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly runService: ProjectRunService,
    private readonly worker: TaskWorker,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly retryClock: () => number = () => Date.now(),
  ) {}

  /** Borrow the shared domain tables, subscribe run-phase events, start the tick. */
  start(): void {
    if (this.tables !== undefined) throw new Error('dsh-projects: Task service is already started')
    const domain = this.runService.domain()
    this.tables = {
      tasks: domain.table('tasks'),
      runs: domain.table('runs'),
      events: domain.table('run_events'),
      plans: domain.table('plans'),
    }
    // Cancellation retirement. `canceled` is a terminal run phase, so the
    // Run service signals it through `dsh-projects/run/completed` (the
    // `phase-changed` event is reserved for non-terminal moves — but both
    // are handled so a future semantics change cannot drop the coupling).
    const onRunCanceled = (event: { runId?: string; to?: string; phase?: string }): void => {
      const canceled = event.to === 'canceled' || event.phase === 'canceled'
      if (canceled && event.runId !== undefined) {
        void this.retireTasksForRun(event.runId).catch(error => {
          this.ctx.logger.warn('dsh-projects: task retirement failed for run %s: %s', event.runId, errorMessage(error))
        })
      }
    }
    this.removePhaseListener = this.ctx.on('dsh-projects/run/phase-changed', onRunCanceled)
    this.removeCompletedListener = this.ctx.on('dsh-projects/run/completed', onRunCanceled)
    this.tickTimer = setInterval(() => {
      void this.tick().catch(error => {
        this.ctx.logger.warn('dsh-projects: task tick failed: %s', errorMessage(error))
      })
    }, TICK_INTERVAL_MS)
    this.tickTimer.unref?.()
  }

  /**
   * Abort in-flight worker signals, clear the tick, unsubscribe, drop table
   * references. Idempotent; does not mutate persisted state (orphan
   * reconciliation is Phase 10).
   */
  stop(): void {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    this.removePhaseListener?.()
    this.removePhaseListener = undefined
    this.removeCompletedListener?.()
    this.removeCompletedListener = undefined
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
    this.tables = undefined
  }

  /** The worker kind this Host can currently execute tasks with (spec §6.4). */
  workerKind(): 'local' | 'agent-team' | 'unavailable' {
    return this.worker.kind
  }

  /**
   * The run's tasks in deterministic (createdAt, id) order, projected to the
   * client view (spec §9: `runDetail` additive `tasks`). Empty when the run
   * has none; `task.notStarted` when the service is stopped.
   */
  taskList(runId: RunId): readonly ProjectTaskView[] {
    return this.tasksForRun(runId).map(toTaskView)
  }

  /** Per-status task counts for the snapshot run summary (spec §9). */
  taskCounts(runId: RunId): TaskCountsView {
    const tasks = this.tasksForRun(runId)
    const count = (status: ProjectTaskStatus): number =>
      tasks.reduce((n, task) => (task.status === status ? n + 1 : n), 0)
    return {
      total: tasks.length,
      pending: count('pending'),
      ready: count('ready'),
      running: count('running'),
      blocked: count('blocked'),
      failed: count('failed'),
      succeeded: count('succeeded'),
    }
  }

  /**
   * The Phase 4 half of the `RunPlanStatus` hook (wired next to
   * `PlanRunCoupler`): materialize on `active`, retire on `superseded`/
   * `completed`. A failure never undoes the plan transition — the caller
   * (the plan service) already logged the hook error.
   */
  async handlePlanStatus(event: PlanStatusChangedEvent): Promise<void> {
    const tables = this.requireStarted()
    const run = tables.runs.get(event.runId)
    if (run === undefined) return
    if (run.activePlanId !== event.planId) return
    switch (event.to) {
      case 'active': {
        const plan = tables.plans.get(event.planId)
        if (plan === undefined) return
        await this.retireTasksForRun(event.runId)
        await this.materializeTasks(run, plan)
        return
      }
      case 'superseded':
      case 'completed':
        await this.retireTasksForRun(event.runId)
        return
      default:
        return
    }
  }

  /** Operator retry (spec §9): re-queue one `failed` task. */
  async taskRetry(taskId: TaskId): Promise<ProjectTaskRecord> {
    const tables = this.requireStarted()
    const task = tables.tasks.get(taskId)
    if (task === undefined) {
      throw new DashboardDomainError('task.unknown', `unknown task ${taskId}`, { taskId })
    }
    if (task.status !== 'failed') {
      throw new DashboardDomainError('task.retryNotAllowed', `task ${taskId} is ${task.status}; only failed tasks can be retried`, {
        taskId,
        status: task.status,
      })
    }
    const next = await tables.tasks.update(taskId, current => {
      if (current.status !== 'failed') {
        throw new DashboardDomainError('task.retryNotAllowed', `task ${taskId} is no longer failed (now ${current.status})`, {
          taskId,
          status: current.status,
        })
      }
      return transitionTask(current, 'ready', { now: this.clock() })
    })
    void this.tick().catch(error => {
      this.ctx.logger.warn('dsh-projects: task tick after retry failed: %s', errorMessage(error))
    })
    return next
  }

  /**
   * The single application point for scheduling decisions (spec §7.2):
   * dependency transitions, the dead-DAG run coupling, and ready-task
   * execution. Re-entrant calls coalesce into one trailing run.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickQueued = true
      return
    }
    this.ticking = true
    try {
      await this.tickOnce()
    } finally {
      this.ticking = false
      if (this.tickQueued) {
        this.tickQueued = false
        await this.tick()
      }
    }
  }

  private async tickOnce(): Promise<void> {
    const tables = this.requireStarted()
    const now = this.retryClock()
    for (const [runId, run] of tables.runs.entries()) {
      if (isTerminalRunPhase(run.phase)) continue
      // 1. Dependency-driven transitions.
      let tasks = this.tasksForRun(runId)
      if (tasks.length === 0) continue
      for (const transition of computeDependencyTransitions(tasks)) {
        if (this.tables === undefined) return
        const task = tasks.find(candidate => candidate.id === transition.taskId)
        if (task === undefined) continue
        try {
          const next = await this.casTaskTransition(task, transition.to, { now: this.clock() })
          if (transition.to === 'ready') {
            await this.appendRunEvent({
              runId: task.runId,
              projectId: run.projectId,
              type: 'task.ready',
              title: 'Task ready',
              detail: task.title,
              at: this.clock(),
            })
            this.emitTaskEvent(next)
          }
          tasks = this.tasksForRun(runId)
        } catch (error) {
          if (error instanceof TaskTransitionError) continue
          this.ctx.logger.warn('dsh-projects: task transition failed for %s: %s', task.id, errorMessage(error))
        }
      }
      if (run.phase !== 'executing') continue
      // 2. Dead-DAG run coupling (intent §7.1 item 9).
      await this.deadDagCheck(run, this.tasksForRun(runId))
      if (this.tables === undefined) return
      // 3. Execution under the concurrency limit.
      if (this.worker.kind === 'unavailable') continue
      const limit = run.maxConcurrentAgents ?? DEFAULT_TASK_CONCURRENCY
      tasks = this.tasksForRun(runId)
      for (const taskId of pickReadyTasks(tasks, limit, now)) {
        const task = tasks.find(candidate => candidate.id === taskId)
        if (task === undefined) continue
        const started = await this.beginExecution(task)
        if (this.tables === undefined) return
        if (started !== undefined) {
          void this.executeTask(started)
        }
        tasks = this.tasksForRun(runId)
      }
    }
  }

  private async deadDagCheck(run: ProjectRunRecord, tasks: readonly ProjectTaskRecord[]): Promise<void> {
    if (run.phase !== 'executing') return
    if (tasks.length === 0) return
    const live = tasks.filter(task => !isTerminalTaskStatus(task.status))
    if (live.length === 0) return
    if (live.some(task => task.status === 'pending' || task.status === 'ready' || task.status === 'running')) return
    if (!tasks.some(task => task.status === 'failed')) return
    try {
      await this.runService.transitionRun(run.id, 'blocked', {
        error: 'task DAG deadlocked: remaining tasks are blocked on failed dependencies',
      })
    } catch (error) {
      // Guard miss (the run moved concurrently) = logged no-op, the
      // PlanRunCoupler pattern.
      this.ctx.logger.warn('dsh-projects: could not block run %s: %s', run.id, errorMessage(error))
    }
  }

  private async beginExecution(task: ProjectTaskRecord): Promise<ProjectTaskRecord | undefined> {
    const tables = this.requireStarted()
    const run = tables.runs.get(task.runId)
    if (run === undefined) return undefined
    const project = this.catalog.project(run.projectId)
    if (project === undefined) {
      this.ctx.logger.warn('dsh-projects: project %s for task %s is not in the catalog; leaving the task ready', run.projectId, task.id)
      return undefined
    }
    const sessionId = `dsh-task-${randomUUID()}`
    const controller = new AbortController()
    this.inFlight.set(task.id, controller)
    let started: ProjectTaskRecord
    try {
      started = await this.casTaskTransition(task, 'running', {
        now: this.clock(),
        attempt: task.attempt + 1,
        startedAt: this.clock(),
        assignedAgentId: sessionId,
      })
    } catch (error) {
      // Ownership-checked: a newer attempt may have replaced the entry.
      if (this.inFlight.get(task.id) === controller) this.inFlight.delete(task.id)
      if (error instanceof TaskTransitionError) return undefined // moved concurrently (retired) — no-op
      this.ctx.logger.warn('dsh-projects: could not start task %s: %s', task.id, errorMessage(error))
      return undefined
    }
    const maxAttempts = started.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    try {
      await this.appendRunEvent({
        runId: started.runId,
        projectId: run.projectId,
        type: 'task.started',
        title: 'Task started',
        detail: `agent ${sessionId.slice(-8)}, attempt ${started.attempt}/${maxAttempts}`,
        at: this.clock(),
      })
      this.emitTaskEvent(started)
    } catch (error) {
      if (this.inFlight.get(started.id) === controller) this.inFlight.delete(started.id)
      this.ctx.logger.warn('dsh-projects: could not record the start of task %s: %s', started.id, errorMessage(error))
      return undefined
    }
    return started
  }

  /**
   * The fire-and-forget execution half: the worker call and result
   * settlement run outside the tick loop so a `maxConcurrentAgents > 1`
   * wave starts in parallel (spec §7.2). Stale results (the task moved
   * meanwhile — retirement) are a logged no-op inside `settleResult`.
   *
   * `inFlight` holds one controller per task id across time; settlement of
   * attempt N may finish after attempt N+1 has begun (settlement triggers
   * the tick that starts the next attempt), so every removal is
   * ownership-checked against the controller this execution holds.
   */
  private async executeTask(started: ProjectTaskRecord): Promise<void> {
    const tables = this.tables
    const controller = this.inFlight.get(started.id)
    if (tables === undefined || controller === undefined || started.assignedAgentId === undefined) {
      if (controller !== undefined && this.inFlight.get(started.id) === controller) this.inFlight.delete(started.id)
      return
    }
    const run = tables.runs.get(started.runId)
    const project = run === undefined ? undefined : this.catalog.project(run.projectId)
    if (run === undefined || project === undefined) {
      if (this.inFlight.get(started.id) === controller) this.inFlight.delete(started.id)
      this.ctx.logger.warn('dsh-projects: run/project vanished before task %s execution', started.id)
      return
    }
    try {
      const result = await this.worker.start({
        taskId: started.id,
        runId: started.runId,
        projectId: run.projectId,
        sessionId: started.assignedAgentId,
        cwd: project.root,
        title: started.title,
        description: started.description,
        ...(started.role === undefined ? {} : { role: started.role }),
        acceptanceCriteria: [...started.acceptanceCriteria],
        attempt: started.attempt,
        signal: controller.signal,
      })
      await this.settleResult(started.id, result)
    } catch (error) {
      if (error instanceof TaskTransitionError) return // moved concurrently (retired) — no-op
      this.ctx.logger.warn('dsh-projects: task execution failed for %s: %s', started.id, errorMessage(error))
    } finally {
      if (this.inFlight.get(started.id) === controller) this.inFlight.delete(started.id)
    }
  }

  private async settleResult(taskId: TaskId, result: TaskWorkerResult): Promise<void> {
    if (this.tables === undefined) return // stopped — no state mutation (Phase 10 owns reconciliation)
    const tables = this.tables
    const task = tables.tasks.get(taskId)
    if (task === undefined) {
      this.ctx.logger.warn('dsh-projects: stale worker result for unknown task %s', taskId)
      return
    }
    if (task.status !== 'running') {
      this.ctx.logger.warn('dsh-projects: stale worker result for task %s (status %s)', taskId, task.status)
      return
    }
    const run = tables.runs.get(task.runId)
    if (run === undefined) return
    const now = this.clock()
    const maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const identity = result.agentId === undefined ? {} : { assignedAgentId: result.agentId }
    const usage = result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }
    const turns = result.turnCount === undefined ? {} : { turnCount: result.turnCount }
    if (result.kind === 'succeeded' && result.summary !== undefined && result.summary.trim() !== '') {
      const summary = truncateSummary(result.summary.trim(), 1000)
      const next = await this.casTaskTransition(task, 'succeeded', { now, outputSummary: summary, ...identity, ...usage, ...turns })
      await this.appendRunEvent({
        runId: task.runId,
        projectId: run.projectId,
        type: 'task.completed',
        title: 'Task completed',
        detail: truncateSummary(summary, EVENT_DETAIL_LIMIT),
        at: now,
      })
      this.emitTaskEvent(next)
      await this.tick()
      return
    }
    const error = result.kind === 'failed' ? (result.error ?? 'task execution failed') : 'worker returned no usable summary'
    if (task.attempt < maxAttempts) {
      const next = await this.casTaskTransition(task, 'ready', { now, ...identity, ...usage, ...turns })
      await this.appendRunEvent({
        runId: task.runId,
        projectId: run.projectId,
        type: 'task.ready',
        title: 'Task ready',
        detail: `${task.title} (retry after failure)`,
        at: now,
      })
      this.emitTaskEvent(next)
      await this.tick()
      return
    }
    const next = await this.casTaskTransition(task, 'failed', { now, error, ...identity, ...usage, ...turns })
    await this.appendRunEvent({
      runId: task.runId,
      projectId: run.projectId,
      type: 'task.failed',
      title: 'Task failed',
      detail: `${error}; attempt ${task.attempt}/${maxAttempts}`,
      at: now,
    })
    this.emitTaskEvent(next)
    await this.tick()
  }

  /**
   * Retire every non-terminal task of a run (plan supersede / run
   * cancellation): `canceled`, running tasks' workers stopped. No run event —
   * the run/plan stream already carries the reason (spec §3.4).
   */
  private async retireTasksForRun(runId: RunId): Promise<void> {
    const tables = this.requireStarted()
    const now = this.clock()
    for (const task of this.tasksForRun(runId)) {
      if (isTerminalTaskStatus(task.status)) continue
      if (task.status === 'running' && task.assignedAgentId !== undefined) {
        await this.worker.stop(task.assignedAgentId).catch(error => {
          this.ctx.logger.warn('dsh-projects: worker stop failed for task %s: %s', task.id, errorMessage(error))
        })
      }
      try {
        await this.casTaskTransition(task, 'canceled', {
          now,
          ...(task.assignedAgentId === undefined ? {} : { assignedAgentId: task.assignedAgentId }),
        })
      } catch (error) {
        if (error instanceof TaskTransitionError) continue // already moved concurrently
        this.ctx.logger.warn('dsh-projects: task retirement failed for %s: %s', task.id, errorMessage(error))
      }
    }
  }

  private async materializeTasks(run: ProjectRunRecord, plan: RunPlanRecord): Promise<void> {
    const tables = this.requireStarted()
    if (plan.tasks.length === 0) {
      this.ctx.logger.info('dsh-projects: plan %s has no tasks; run %s has nothing to execute', plan.id, run.id)
      return
    }
    const now = this.clock()
    const idByPlanTask = new Map<string, string>()
    for (const planned of plan.tasks) idByPlanTask.set(planned.id, randomUUID())
    const records: ProjectTaskRecord[] = plan.tasks.map(planned => {
      const id = idByPlanTask.get(planned.id)
      if (id === undefined) throw new Error(`dsh-projects: no id assigned for plan task ${planned.id}`)
      return {
        id,
        runId: run.id,
        planId: plan.id,
        planTaskId: planned.id,
        title: planned.title,
        description: planned.description,
        ...(planned.role === undefined ? {} : { role: planned.role }),
        dependencies: planned.dependencies.map(dep => idByPlanTask.get(dep) ?? dep),
        status: 'pending',
        acceptanceCriteria: [...planned.acceptanceCriteria],
        attempt: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
    })
    try {
      validateTaskGraph(records)
    } catch (error) {
      if (error instanceof TaskGraphError) {
        throw new DashboardDomainError('task.dagInvalid', error.message, { planId: plan.id })
      }
      throw error
    }
    for (const record of records) await tables.tasks.put(record.id, record)
    await this.appendRunEvent({
      runId: run.id,
      projectId: run.projectId,
      type: 'tasks.materialized',
      title: 'Tasks materialized',
      detail: `plan v${plan.version}: ${records.length} tasks`,
      at: now,
    })
    const payload: TasksMaterializedEvent = {
      runId: run.id,
      projectId: run.projectId,
      planId: plan.id,
      version: plan.version,
      taskCount: records.length,
      at: now,
    }
    this.ctx.emit('dsh-projects/tasks/materialized', payload)
    await this.tick()
  }

  /**
   * CAS task transition: the pure machine inside the domain write chain.
   * `TaskTransitionError` propagates as-is — callers distinguish an expected
   * concurrent move (logged no-op) from a real invariant violation.
   */
  private async casTaskTransition(
    task: ProjectTaskRecord,
    to: ProjectTaskStatus,
    context: TaskTransitionContext,
  ): Promise<ProjectTaskRecord> {
    return await this.requireStarted().tasks.update(task.id, current => {
      if (current.status !== task.status) {
        throw new TaskTransitionError(current.status, to)
      }
      return transitionTask(current, to, context)
    })
  }

  /** The run's tasks in deterministic (createdAt, id) order. */
  private tasksForRun(runId: RunId): ProjectTaskRecord[] {
    const tasks: ProjectTaskRecord[] = []
    for (const [, task] of this.requireStarted().tasks.entries()) {
      if (task.runId === runId) tasks.push(task)
    }
    tasks.sort(compareTasks)
    return tasks
  }

  private emitTaskEvent(task: ProjectTaskRecord): void {
    const run = this.requireStarted().runs.get(task.runId)
    if (run === undefined) return
    const payload: TaskStatusEvent = {
      runId: task.runId,
      projectId: run.projectId,
      planId: task.planId,
      taskId: task.id,
      status: task.status,
      at: task.updatedAt,
    }
    if (task.status === 'ready') this.ctx.emit('dsh-projects/task/ready', payload)
    else if (task.status === 'running') this.ctx.emit('dsh-projects/task/started', payload)
    else if (task.status === 'succeeded') this.ctx.emit('dsh-projects/task/completed', payload)
    else if (task.status === 'failed') this.ctx.emit('dsh-projects/task/failed', payload)
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
      ...(input.detail === undefined || input.detail === '' ? {} : { detail: input.detail }),
      seq: seq + 1,
      at: input.at,
    }
    await events.put(record.id, record)
  }

  private requireStarted(): TaskTables {
    const tables = this.tables
    if (tables === undefined) throw new DashboardDomainError('task.notStarted', 'Task service is not started')
    return tables
  }
}
