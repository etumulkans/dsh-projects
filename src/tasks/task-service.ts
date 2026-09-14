/**
 * DSH Projects Phase 5 — ProjectTaskService.
 *
 * Owns task state inside the shared `dsh_projects` domain (borrowed from the
 * Run service): materialization from the active plan version (via the Phase 3
 * `onPlanStatus` hook), the dependency-gated scheduling tick, execution
 * through the worker seam, per-task Git worktree isolation + commit-on-success
 * (Phase 5), the run completion pipeline (`integrating → validating →
 * finalizing → succeeded`), retries, retirement on supersede, and
 * run-canceled propagation (spec §6, §7).
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ApprovalService } from '../approvals/approval-service.ts'
import { requiresApproval } from '../approvals/approval-policy.ts'
import { checkBudget, type BudgetCheckResult } from '../approvals/budgetCheck.ts'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import type { ProjectId, ProjectWorkspaceSource } from '../catalog/types.ts'
import type { ProjectMemoryService } from '../memory/memory-service.ts'
import { TASK_MEMORY_BUDGET } from '../memory/retrieval.ts'
import type { PlanStatusChangedEvent } from '../plans/plan-service.ts'
import type { PlanId, RunPlanRecord } from '../plans/types.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import { addTokens, emptyTokens, type TokenTotals } from '../runtime/types.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import { isTerminalRunPhase } from '../runs/state-machine.ts'
import type { ProjectRunEventRecord, ProjectRunPhase, ProjectRunRecord } from '../runs/types.ts'
import type { RunEventId, RunId } from '../runs/types.ts'
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TASK_CONCURRENCY,
  EVENT_DETAIL_LIMIT,
  RECOVERY_STALE_MS,
  TICK_INTERVAL_MS,
} from './constants.ts'
import {
  TaskWorktreeManager,
  integrationBranchName,
  integrationWorktreePath,
  taskBranchName,
} from './git-workspace.ts'
import { MergeInOrderStrategy, verifyIntegration, type IntegrationOutcome, type IntegrationStrategy, type VerifyIntegrationResult } from './integration.ts'
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

/**
 * Phase 6 (spec §6.3): lifecycle hooks. `onRunSucceeded` fires
 * fire-and-forget after a run reaches `succeeded` (the distillation
 * trigger) and must never throw into the pipeline.
 */
export interface ProjectTaskServiceHooks {
  onRunSucceeded?: (run: ProjectRunRecord) => void
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
    ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
    ...(task.branch === undefined ? {} : { branch: task.branch }),
    ...(task.baseCommit === undefined ? {} : { baseCommit: task.baseCommit }),
    ...(task.headCommit === undefined ? {} : { headCommit: task.headCommit }),
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
  private readonly configuredIntegrationStrategy?: IntegrationStrategy | undefined
  private lazyIntegrationStrategy?: IntegrationStrategy

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly runService: ProjectRunService,
    private readonly worker: TaskWorker,
    /** Phase 5: per-task worktree manager; `undefined` ⇒ no isolation at all (Phase 4 behavior; test seam). */
    private readonly worktreeManager?: TaskWorktreeManager,
    /** Phase 5: integration strategy seam (default `MergeInOrderStrategy`). */
    integrationStrategy?: IntegrationStrategy,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly retryClock: () => number = () => Date.now(),
    /** Phase 6 (spec §7.2): memory service for worker prompt injection. */
    private readonly memory?: ProjectMemoryService,
    /** Phase 6 (spec §6.3/§7.3): lifecycle hooks (onRunSucceeded → fire-and-forget distillation). */
    private readonly hooks?: ProjectTaskServiceHooks,
    /** Phase 7 (spec §4.5): approval service for the merge gate; `undefined` ⇒ no merge gate (test seam). */
    private readonly approvalService?: ApprovalService,
    /**
     * Phase 10 (spec §4.3): session-existence probe for restart reconciliation.
     * Returns `true` when the Harness session with the given id is still alive.
     * `undefined` ⇒ policy-fallback staleness (startedAt older than
     * RECOVERY_STALE_MS, or no assignedAgentId). Wired in `src/index.ts` to the
     * real installed `ctx.agents.get(sessionId) !== undefined`.
     */
    private readonly sessionAlive?: (sessionId: string) => boolean,
  ) {
    this.configuredIntegrationStrategy = integrationStrategy
  }

  /** The integration strategy in effect (lazily defaults to `MergeInOrderStrategy`). */
  private get integrationStrategy(): IntegrationStrategy {
    return this.configuredIntegrationStrategy ?? (this.lazyIntegrationStrategy ??= new MergeInOrderStrategy())
  }

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

  /**
   * Phase 10 (spec §4): startup reconciliation. Repairs the in-flight
   * execution a process restart orphaned: for each non-terminal Run it
   * interrupts stale `running` tasks (their Harness session is gone) —
   * re-queued within the attempt budget or failed when exhausted — and
   * re-drives the Run. Idempotent and CAS-guarded: a task that moved
   * concurrently (a live worker settled it) is a logged no-op, and a
   * terminal Run is never touched (spec §54 "do not blindly restart").
   *
   * Called from `src/index.ts` after `start()`, before `runtime.start()`.
   * A failure is logged by the caller, never fatal to boot.
   */
  async reconcileAfterRestart(): Promise<void> {
    const tables = this.tables
    if (tables === undefined) return // stopped — nothing to reconcile
    const now = this.clock()
    const nowMs = this.retryClock()
    for (const [, run] of tables.runs.entries()) {
      if (isTerminalRunPhase(run.phase)) continue // terminal Runs are never touched
      let runInterrupted = 0
      for (const task of this.tasksForRun(run.id)) {
        if (task.status !== 'running') continue
        if (!this.isStaleTask(task, nowMs)) continue // a live session is left untouched
        const outcome = await this.reconcileStaleTask(task, run, now)
        if (outcome !== 'left-alone' && outcome !== 'already-moved') runInterrupted++
      }
      if (runInterrupted > 0) {
        await this.appendRunEvent({
          runId: run.id,
          projectId: run.projectId,
          type: 'run.recovered',
          title: 'Run recovered',
          detail: `re-dispatched ${runInterrupted} interrupted task(s)`,
          at: now,
        })
        // Re-drive: the existing tick loop re-dispatches the re-queued `ready`
        // tasks (and the dead-DAG check blocks a Run whose DAG is dead). No
        // direct phase transition — the scheduler stays the single authority.
        await this.tick()
      }
    }
  }

  /**
   * Phase 10 (spec §5): interrupt one stale `running` task through the single
   * authority. Emits `task.interrupted`, then re-queues (`running → ready`,
   * the existing internal-retry edge) when `attempt < maxAttempts`, else fails
   * (`running → failed`) with the interruption reason. Each write is
   * CAS-guarded (`casTaskTransition` checks `current.status !== task.status`),
   * so a task that moved concurrently is a logged no-op. Returns the outcome
   * for the caller's `run.recovered` count.
   */
  private async reconcileStaleTask(
    task: ProjectTaskRecord,
    run: ProjectRunRecord,
    now: string,
  ): Promise<'requeued' | 'failed' | 'left-alone' | 'already-moved'> {
    const maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    await this.appendRunEvent({
      runId: task.runId,
      projectId: run.projectId,
      type: 'task.interrupted',
      title: 'Task interrupted',
      detail: `${task.title} (session lost on restart; attempt ${task.attempt}/${maxAttempts})`,
      at: now,
    })
    try {
      if (task.attempt < maxAttempts) {
        const next = await this.casTaskTransition(task, 'ready', { now })
        this.emitTaskEvent(next)
        return 'requeued'
      }
      const next = await this.casTaskTransition(task, 'failed', {
        now,
        error: 'interrupted: session lost on restart',
      })
      this.emitTaskEvent(next)
      return 'failed'
    } catch (error) {
      if (error instanceof TaskTransitionError) {
        // A live worker settled the task (or a concurrent reconcile moved it)
        // between the probe and the CAS — the interruption is already moot.
        this.ctx.logger.info('dsh-projects: stale task %s moved concurrently; reconcile no-op', task.id)
        return 'already-moved'
      }
      throw error
    }
  }

  /**
   * Phase 10 (spec §4.3): is a `running` task stale (its Harness session is
   * gone)? Probe-primary when the `sessionAlive` hook is wired (the real
   * installed `ctx.agents.get(sessionId) !== undefined`); policy-fallback when
   * it is not — stale when it has no `assignedAgentId` (a torn write) or its
   * `startedAt` is older than `RECOVERY_STALE_MS`. A task whose probe reports
   * the session is alive is never stale (§54 "do not blindly restart").
   */
  private isStaleTask(task: ProjectTaskRecord, nowMs: number): boolean {
    if (task.assignedAgentId === undefined) return true // never dispatched — a torn write
    if (this.sessionAlive !== undefined) {
      return !this.sessionAlive(task.assignedAgentId)
    }
    // Policy fallback: the probe is not wired (a test seam). Stale when the
    // task has been `running` longer than the bound.
    const startedAt = task.startedAt
    if (startedAt === undefined) return true
    const startedMs = Date.parse(startedAt)
    if (Number.isNaN(startedMs)) return true
    return nowMs - startedMs > RECOVERY_STALE_MS
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
    // Phase 7 (spec §5.1/§5.3): the per-task retry budget. `task.attempt` is
    // 0-based; refusing when it has reached the budget leaves the task
    // `failed` and the run unaffected (a human can raise the budget and retry).
    const run = tables.runs.get(task.runId)
    const maxRetries = run?.budget?.maxRetriesPerTask
    if (maxRetries !== undefined && task.attempt >= maxRetries) {
      throw new DashboardDomainError('task.retryBudgetExceeded', `task ${taskId} has used ${task.attempt} attempt(s); the run's retry budget is ${maxRetries}`, {
        attempt: task.attempt,
        max: maxRetries,
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
      // 0. Phase 7 (spec §5.1): the runtime budget, once per tick per
      // non-terminal run (cheap: `now - run.startedAt`).
      await this.checkRuntimeBudget(run)
      if (this.tables === undefined) return
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
      if (run.phase === 'integrating' || run.phase === 'validating' || run.phase === 'finalizing') {
        // 4. Run completion pipeline (Phase 5, spec §7).
        await this.driveCompletionPipeline(run)
        if (this.tables === undefined) return
        continue
      }
      if (run.phase !== 'executing') continue
      // 2. Dead-DAG run coupling (intent §7.1 item 9).
      await this.deadDagCheck(run, this.tasksForRun(runId))
      if (this.tables === undefined) return
      // 3. Execution under the concurrency limit.
      if (this.worker.kind === 'unavailable') continue
      // Phase 7 (spec §5.1): the budget's concurrency keys silently cap the
      // scheduler's ready-task pick (a concurrency bound, not a stop condition
      // — no event, no pause).
      let limit = run.maxConcurrentAgents ?? DEFAULT_TASK_CONCURRENCY
      const budget = run.budget
      if (budget !== undefined) {
        if (budget.maxConcurrentAgents !== undefined) limit = Math.min(limit, budget.maxConcurrentAgents)
        if (budget.maxAgents !== undefined) limit = Math.min(limit, budget.maxAgents)
      }
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
      // 4. All-succeeded completion detection (Phase 5, spec §7.1).
      await this.detectAllSucceeded(run)
      if (this.tables === undefined) return
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

  // ---------------------------------------------------------------------------
  // Phase 5 — per-task worktree isolation + run completion pipeline (spec §6, §7)
  // ---------------------------------------------------------------------------

  /**
   * The project's Git workspace source when Phase 5 isolation is active for
   * this run (a manager is configured AND the project is a Git worktree
   * source), else `undefined` — no isolation, Phase 4 behavior.
   */
  private gitSource(run: ProjectRunRecord): Extract<ProjectWorkspaceSource, { readonly strategy: 'worktree' }> | undefined {
    if (this.worktreeManager === undefined) return undefined
    const source = this.catalog.projectWorkspaceSource(run.projectId)
    return source?.strategy === 'worktree' ? source : undefined
  }

  /**
   * Spec §7.1 (executing → …): when every task succeeded, leave `executing`
   * for `integrating` (Git projects) or `finalizing` (non-Git projects).
   */
  private async detectAllSucceeded(run: ProjectRunRecord): Promise<void> {
    if (run.phase !== 'executing') return
    const tasks = this.tasksForRun(run.id)
    if (tasks.length === 0) return
    if (!tasks.every(task => task.status === 'succeeded')) return
    const target: 'integrating' | 'finalizing' = this.gitSource(run) !== undefined ? 'integrating' : 'finalizing'
    // Phase 7 (spec §4.5): the merge gate, at the `executing → integrating`
    // edge. When the mode requires a merge approval, pause at the gate:
    // request the approval object and move the run to `awaiting_approval`
    // (suspendedFrom: `executing`). The pipeline does not run until the
    // approval is resolved (the `onApprovalResolved` hook moves the run
    // `awaiting_approval → integrating` directly — resuming to `executing`
    // would re-trigger this detection and re-request the approval).
    if (target === 'integrating' && this.approvalService !== undefined) {
      const mode = run.approvalMode ?? 'plan'
      if (requiresApproval(mode, 'merge')) {
        const integrationBranch = integrationBranchName(run.id)
        const taskBranches = tasks
          .filter(task => task.status === 'succeeded' && task.branch !== undefined)
          .map(task => task.branch as string)
        await this.approvalService.requestApproval({
          runId: run.id,
          type: 'merge',
          summary: `Merge ${taskBranches.length} task branch(es) into ${integrationBranch}`,
          payload: { integrationBranch, taskBranches },
        })
        await this.safeTransitionRun(run.id, 'awaiting_approval')
        return
      }
    }
    await this.safeTransitionRun(run.id, target)
  }

  /**
   * Spec §7: drive a run through `integrating → validating → finalizing →
   * succeeded`. Every step re-reads persisted state; every run transition
   * goes through the Run service (the single authority — guard miss = logged
   * no-op). Blocked runs are never touched (resume is a human decision via
   * the existing run transition path).
   */
  private async driveCompletionPipeline(run: ProjectRunRecord): Promise<void> {
    if (run.phase !== 'integrating' && run.phase !== 'validating' && run.phase !== 'finalizing') return
    const tables = this.tables
    if (tables === undefined) return
    const source = this.gitSource(run)
    if (source === undefined) {
      // Non-Git (or no manager): only `finalizing` is reachable here — the
      // detection step sent these runs straight there.
      if (run.phase === 'finalizing') await this.finalizeRun(run, undefined)
      return
    }
    const tasks = this.tasksForRun(run.id)
    const integrationBranch = integrationBranchName(run.id)
    const taskBranches = tasks
      .filter(task => task.status === 'succeeded' && task.branch !== undefined)
      .map(task => task.branch as string)
    if (run.phase === 'integrating') {
      // Crash-safety leg (spec §7.2): a persisted `run.integration.completed`
      // event plus a verified integration means the crash happened between
      // the event and the phase move — no re-merge.
      let completed = false
      for (const [, event] of tables.events.entries()) {
        if (event.runId === run.id && event.type === 'run.integration.completed') {
          completed = true
          break
        }
      }
      if (completed) {
        const verification = await this.verifyRunIntegration(run, source, integrationBranch, taskBranches)
        if (this.tables === undefined) return
        if (verification.ok) {
          await this.safeTransitionRun(run.id, 'validating')
          return
        }
        const detail = this.verificationDetail(verification)
        await this.appendRunEvent({
          runId: run.id,
          projectId: run.projectId,
          type: 'run.integration.failed',
          title: 'Integration verification failed',
          detail,
          at: this.clock(),
        })
        await this.safeTransitionRun(run.id, 'blocked', { error: detail })
        return
      }
      await this.runIntegration(run, source, tasks, integrationBranch)
      return
    }
    if (run.phase === 'validating') {
      const verification = await this.verifyRunIntegration(run, source, integrationBranch, taskBranches)
      if (this.tables === undefined) return
      if (verification.ok) {
        await this.safeTransitionRun(run.id, 'finalizing')
        return
      }
      const detail = this.verificationDetail(verification)
      await this.appendRunEvent({
        runId: run.id,
        projectId: run.projectId,
        type: 'run.integration.failed',
        title: 'Integration verification failed',
        detail,
        at: this.clock(),
      })
      await this.safeTransitionRun(run.id, 'blocked', { error: detail })
      return
    }
    await this.finalizeRun(run, source)
  }

  /**
   * Spec §7.2: run the integration strategy once (a fresh attempt). On
   * success the result is attached to the run record (the coordinator
   * pattern) before the `run.integration.completed` event and the move to
   * `validating`. Conflict or strategy error → `run.integration.failed` +
   * the run is blocked (resumable; the next attempt re-merges fresh).
   */
  private async runIntegration(
    run: ProjectRunRecord,
    source: Extract<ProjectWorkspaceSource, { readonly strategy: 'worktree' }>,
    tasks: readonly ProjectTaskRecord[],
    integrationBranch: string,
  ): Promise<void> {
    if (this.tables === undefined) return
    await this.appendRunEvent({
      runId: run.id,
      projectId: run.projectId,
      type: 'run.integration.started',
      title: 'Integration started',
      detail: integrationBranch,
      at: this.clock(),
    })
    if (this.tables === undefined) return
    const refs = tasks.filter(
      (task): task is ProjectTaskRecord & { branch: string; headCommit: string; baseCommit: string } =>
        task.status === 'succeeded' && task.branch !== undefined && task.headCommit !== undefined && task.baseCommit !== undefined,
    ).map(task => ({
      planTaskId: task.planTaskId,
      branch: task.branch,
      headCommit: task.headCommit,
      baseCommit: task.baseCommit,
    }))
    let outcome: IntegrationOutcome
    try {
      outcome = await this.integrationStrategy.run({
        repositoryRoot: source.repositoryRoot,
        projectRoot: source.projectRoot,
        runId: run.id,
        tasks: refs,
      })
    } catch (error) {
      const detail = truncateSummary(errorMessage(error), EVENT_DETAIL_LIMIT)
      await this.appendRunEvent({
        runId: run.id,
        projectId: run.projectId,
        type: 'run.integration.failed',
        title: 'Integration failed',
        detail,
        at: this.clock(),
      })
      await this.safeTransitionRun(run.id, 'blocked', { error: detail })
      return
    }
    if (this.tables === undefined) return
    if (outcome.status === 'conflict') {
      const detail = truncateSummary(
        `integration conflict: ${outcome.conflictingPaths?.join(', ') ?? 'unknown'}`,
        EVENT_DETAIL_LIMIT,
      )
      await this.appendRunEvent({
        runId: run.id,
        projectId: run.projectId,
        type: 'run.integration.failed',
        title: 'Integration conflict',
        detail,
        at: this.clock(),
      })
      await this.safeTransitionRun(run.id, 'blocked', { error: detail })
      return
    }
    // Integrated: attach the result to the run record before the event, so a
    // crash in between still leaves a verifiable, completed integration.
    const now = this.clock()
    const head = outcome.integratedHead
    const attached = await this.requireStarted().runs
      .update(run.id, current => {
        if (current.phase !== 'integrating') {
          throw new Error(`run ${run.id} moved to ${current.phase} during integration`)
        }
        return {
          ...current,
          integrationBranch: outcome.integratedBranch,
          ...(head === undefined ? {} : { integrationHead: head }),
          updatedAt: now,
          version: current.version + 1,
        }
      })
      .then(() => true)
      .catch(error => {
        this.ctx.logger.warn('dsh-projects: could not record the integration result for run %s: %s', run.id, errorMessage(error))
        return false
      })
    if (!attached) return // the run moved concurrently (e.g. canceled) — no event, no transition
    if (this.tables === undefined) return
    await this.appendRunEvent({
      runId: run.id,
      projectId: run.projectId,
      type: 'run.integration.completed',
      title: 'Integration completed',
      detail: truncateSummary(
        `${outcome.integratedBranch} — merged: ${outcome.merged.join(', ') || 'none'}; skipped: ${outcome.skipped.join(', ') || 'none'}`,
        EVENT_DETAIL_LIMIT,
      ),
      at: this.clock(),
    })
    if (this.tables === undefined) return
    await this.safeTransitionRun(run.id, 'validating')
  }

  /**
   * Spec §5: structural verification of the integration (branch resolves,
   * worktree sound, every task branch merged in). A throw is treated as a
   * failed verification (defensive; the helper catches internally).
   */
  private async verifyRunIntegration(
    run: ProjectRunRecord,
    source: Extract<ProjectWorkspaceSource, { readonly strategy: 'worktree' }>,
    integrationBranch: string,
    taskBranches: readonly string[],
  ): Promise<VerifyIntegrationResult> {
    return verifyIntegration({
      repositoryRoot: source.repositoryRoot,
      integrationPath: integrationWorktreePath(source.projectRoot, run.id),
      integrationBranch,
      taskBranches,
    }).catch(() => ({ ok: false, missing: [integrationBranch] }))
  }

  /** The failed-verification detail line for events and the blocked error. */
  private verificationDetail(result: VerifyIntegrationResult): string {
    return truncateSummary(`integration verification failed: ${result.missing?.join(', ') ?? 'unknown'}`, EVENT_DETAIL_LIMIT)
  }

  /**
   * Spec §7.4: remove the task branches + the integration worktree (the
   * integration branch is kept), then transition to `succeeded` with the
   * integration summary. A persistently failing cleanup keeps the run in
   * `finalizing` (retried on the next tick) — never a fabricated `succeeded`.
   */
  private async finalizeRun(
    run: ProjectRunRecord,
    source: Extract<ProjectWorkspaceSource, { readonly strategy: 'worktree' }> | undefined,
  ): Promise<void> {
    if (this.tables === undefined) return
    if (source !== undefined && this.worktreeManager !== undefined) {
      let cleanupOk = true
      for (const task of this.tasksForRun(run.id)) {
        if (task.branch === undefined) continue
        await this.worktreeManager.removeBranch({
          repositoryRoot: source.repositoryRoot,
          branch: task.branch,
        }).catch(error => {
          cleanupOk = false
          this.ctx.logger.warn('dsh-projects: task branch removal failed for run %s (task %s): %s', run.id, task.planTaskId, errorMessage(error))
        })
      }
      if (this.tables === undefined) return
      await this.worktreeManager.removeTaskWorktree({
        repositoryRoot: source.repositoryRoot,
        projectRoot: source.projectRoot,
        path: integrationWorktreePath(source.projectRoot, run.id),
      }).catch(error => {
        cleanupOk = false
        this.ctx.logger.warn('dsh-projects: integration worktree removal failed for run %s: %s', run.id, errorMessage(error))
      })
      if (this.tables === undefined) return
      if (!cleanupOk) {
        // Persistently failing cleanup: stay in `finalizing` (spec §7.4).
        return
      }
    }
    const resultSummary = source === undefined
      ? 'all tasks succeeded (no Git isolation)'
      : `integrated branch ${run.integrationBranch ?? integrationBranchName(run.id)}${run.integrationHead !== undefined ? ` @ ${run.integrationHead.slice(0, 8)}` : ''}`
    const applied = await this.safeTransitionRun(run.id, 'succeeded', { resultSummary })
    // Phase 6 (spec §6.3): fire-and-forget distillation trigger. The hook
    // receives the fresh (post-transition) run record — `distillRun` only
    // acts on `succeeded` runs — and is never awaited.
    if (applied && this.hooks?.onRunSucceeded !== undefined) {
      const current = this.tables?.runs.get(run.id)
      if (current !== undefined) this.hooks.onRunSucceeded(current)
    }
  }

  /**
   * One pipeline transition through the Run service (the single authority).
   * A guard miss (the run moved concurrently — e.g. a human canceled during
   * integration) is a logged no-op, the PlanRunCoupler pattern.
   */
  private async safeTransitionRun(
    runId: RunId,
    to: ProjectRunPhase,
    context?: { readonly error?: string; readonly resultSummary?: string },
  ): Promise<boolean> {
    try {
      await this.runService.transitionRun(runId, to, {
        ...(context?.error === undefined ? {} : { error: context.error }),
        ...(context?.resultSummary === undefined ? {} : { resultSummary: context.resultSummary }),
      })
      return true
    } catch (error) {
      this.ctx.logger.warn('dsh-projects: pipeline transition to %s did not apply for run %s: %s', to, runId, errorMessage(error))
      return false
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
    // Phase 5: provision the per-task Git worktree before dispatch (spec §6).
    const provisioned = await this.provisionTaskWorktree(run, started, controller)
    if (this.tables === undefined) return undefined
    if (provisioned === undefined) return undefined // settled or retired — no dispatch
    return provisioned
  }

  /**
   * Phase 5 worktree provisioning for a task that just moved to `running`
   * (spec §6). Resolves to the updated started record (worktree identity
   * attached), the unchanged record when no isolation applies (non-Git
   * project or no manager), or `undefined` when provisioning failed and the
   * attempt was settled through the existing settlement path as a synthetic
   * failed worker result (attempt budget, backoff, and events apply
   * unchanged; the next attempt re-provisions idempotently).
   */
  private async provisionTaskWorktree(
    run: ProjectRunRecord,
    started: ProjectTaskRecord,
    controller: AbortController,
  ): Promise<ProjectTaskRecord | undefined> {
    if (this.worktreeManager === undefined) return started
    const source = this.gitSource(run)
    if (source === undefined) return started
    let provisioned
    try {
      provisioned = await this.worktreeManager.provisionTaskWorktree({
        repositoryRoot: source.repositoryRoot,
        projectRoot: source.projectRoot,
        runId: run.id,
        planTaskId: started.planTaskId,
      })
    } catch (error) {
      const message = `worktree provisioning failed: ${errorMessage(error)}`
      this.ctx.logger.warn('dsh-projects: %s (task %s)', message, started.id)
      if (this.inFlight.get(started.id) === controller) this.inFlight.delete(started.id)
      await this.settleResult(started.id, { kind: 'failed', error: message }).catch(settlementError => {
        this.ctx.logger.warn('dsh-projects: provisioning-failure settlement failed for task %s: %s', started.id, errorMessage(settlementError))
      })
      return undefined
    }
    // Second CAS: attach the Git identity. `running` → `running` is not a
    // transition, so a plain guarded record update (the coordinator pattern).
    try {
      return await this.requireStarted().tasks.update(started.id, current => {
        if (current.status !== 'running' || current.version !== started.version) {
          throw new TaskTransitionError(current.status, 'running')
        }
        return {
          ...current,
          workspaceId: provisioned.path,
          branch: taskBranchName(run.id, current.planTaskId),
          ...(provisioned.baseCommit === undefined ? {} : { baseCommit: provisioned.baseCommit }),
          updatedAt: this.clock(),
          version: current.version + 1,
        }
      })
    } catch (error) {
      if (error instanceof TaskTransitionError) {
        // The task moved concurrently (retired) — no dispatch.
        if (this.inFlight.get(started.id) === controller) this.inFlight.delete(started.id)
        return undefined
      }
      this.ctx.logger.warn('dsh-projects: could not record the worktree identity for task %s: %s', started.id, errorMessage(error))
      return started
    }
  }

  /**
   * Phase 5 commit-before-`succeeded` (spec §6). Resolves to the head commit
   * to attach to the task record, `null` when no commit applies (non-Git
   * task), or `undefined` when the commit failed and the attempt was settled
   * through the existing settlement path as a failed result (attempt budget
   * and backoff apply; the worktree is kept for the retry). A task can
   * never reach `succeeded` with uncommitted work.
   */
  private async commitTaskWork(
    task: ProjectTaskRecord,
    run: ProjectRunRecord,
  ): Promise<string | null | undefined> {
    if (this.worktreeManager === undefined) return null
    if (task.workspaceId === undefined || task.branch === undefined) return null
    const source = this.gitSource(run)
    if (source === undefined) return null
    try {
      const committed = await this.worktreeManager.commitTaskWork({
        path: task.workspaceId,
        planTaskId: task.planTaskId,
        title: task.title,
      })
      return committed.headCommit
    } catch (error) {
      const message = `commit failed: ${errorMessage(error)}`
      this.ctx.logger.warn('dsh-projects: %s (task %s)', message, task.id)
      await this.settleResult(task.id, { kind: 'failed', error: message }).catch(settlementError => {
        this.ctx.logger.warn('dsh-projects: commit-failure settlement failed for task %s: %s', task.id, errorMessage(settlementError))
      })
      return undefined
    }
  }

  /**
   * Phase 5: best-effort worktree removal for a just-succeeded task
   * (spec §6). The branch is kept; run finalization is the authoritative
   * cleanup, so a failure here is only a warning.
   */
  private async removeSucceededTaskWorktree(task: ProjectTaskRecord, run: ProjectRunRecord): Promise<void> {
    if (this.worktreeManager === undefined) return
    if (task.workspaceId === undefined) return
    const source = this.gitSource(run)
    if (source === undefined) return
    await this.worktreeManager.removeTaskWorktree({
      repositoryRoot: source.repositoryRoot,
      projectRoot: source.projectRoot,
      path: task.workspaceId,
    }).catch(error => {
      this.ctx.logger.warn(
        'dsh-projects: worktree removal failed for succeeded task %s (run finalization is the authoritative cleanup): %s',
        task.id,
        errorMessage(error),
      )
    })
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
      // Phase 6 (spec §7.2): the project memory packet (query = task title +
      // description, task budget); absent packet → field stays absent.
      const memoryContext = this.memory === undefined
        ? undefined
        : this.memory.packetFor({
            projectId: run.projectId,
            query: `${started.title} ${started.description}`,
            budgets: TASK_MEMORY_BUDGET,
          })
      const result = await this.worker.start({
        taskId: started.id,
        runId: started.runId,
        projectId: run.projectId,
        sessionId: started.assignedAgentId,
        // Phase 5: the per-task worktree when isolated; the shared tree otherwise.
        cwd: started.workspaceId ?? project.root,
        ...(started.branch === undefined ? {} : { branch: started.branch }),
        ...(memoryContext === undefined ? {} : { memoryContext }),
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
    // Phase 7 (spec §5.1): accumulate the task's token usage onto the run so
    // the token budget checks have a persisted usage source (`run.tokenUsage`),
    // then check the token budget keys against the fresh run record.
    if (result.tokenUsage !== undefined) {
      await this.accumulateRunTokenUsage(run, result.tokenUsage)
      if (this.tables === undefined) return
      const fresh = this.tables.runs.get(task.runId)
      if (fresh !== undefined) await this.checkTokenBudgets(fresh)
    }
    if (result.kind === 'succeeded' && result.summary !== undefined && result.summary.trim() !== '') {
      const summary = truncateSummary(result.summary.trim(), 1000)
      // Phase 5: commit the task's work before it may reach `succeeded`
      // (spec §6) — a commit failure settles the attempt as a failed result
      // (retryable); a task can never reach `succeeded` with uncommitted work.
      const committed = await this.commitTaskWork(task, run)
      if (this.tables === undefined) return
      if (committed === undefined) {
        // `undefined` here means the commit failed and the attempt was
        // settled through the failure path above.
        return
      }
      const headCommit = committed === null ? {} : { headCommit: committed }
      const next = await this.casTaskTransition(task, 'succeeded', { now, outputSummary: summary, ...identity, ...usage, ...turns, ...headCommit })
      await this.appendRunEvent({
        runId: task.runId,
        projectId: run.projectId,
        type: 'task.completed',
        title: 'Task completed',
        detail: truncateSummary(summary, EVENT_DETAIL_LIMIT),
        at: now,
      })
      this.emitTaskEvent(next)
      // Phase 5: a succeeded task's worktree is removed after its commit
      // (the branch is kept; run finalization is the authoritative cleanup).
      await this.removeSucceededTaskWorktree(task, run)
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

  /**
   * Phase 7 (spec §5.1): add one task's token usage onto the run's persisted
   * `tokenUsage` (creating it on first use). A run-record update, not a phase
   * transition — the budget check reads `run.tokenUsage` right after.
   */
  private async accumulateRunTokenUsage(run: ProjectRunRecord, usage: TokenTotals): Promise<void> {
    const tables = this.tables
    if (tables === undefined) return
    const now = this.clock()
    await tables.runs.update(run.id, current => ({
      ...current,
      tokenUsage: addTokens(current.tokenUsage ?? emptyTokens(), usage),
      updatedAt: now,
      version: current.version + 1,
    }))
  }

  /**
   * Phase 7 (spec §5.1/§5.2/§5.3): check the three token budget keys against
   * the run's accumulated `tokenUsage`. A warning appends the key to
   * `run.budgetWarnings` + a `run.budget.warning` event (once per key); an
   * exceeded key pauses the run with a `resultSummary` + a
   * `run.budget.exceeded` event.
   */
  private async checkTokenBudgets(run: ProjectRunRecord): Promise<void> {
    const usage = run.tokenUsage
    if (usage === undefined) return
    const checks: Array<[string, number]> = [
      ['maxTotalTokens', usage.total],
      ['maxInputTokens', usage.input],
      ['maxOutputTokens', usage.output],
    ]
    for (const [key, value] of checks) {
      if (this.tables === undefined) return
      const result = checkBudget(run.budget, value, key, run.budgetWarnings ?? [])
      if (result === undefined) continue
      if (result.exceeded) {
        await this.applyBudgetExceeded(run, result)
      } else if (result.warning) {
        await this.recordBudgetWarning(run, result)
      }
    }
  }

  /**
   * Phase 7 (spec §5.1/§5.2/§5.3): check `maxRuntimeMinutes` against the run's
   * elapsed wall-clock time (`now - run.startedAt`). Called once per tick per
   * non-terminal run.
   */
  private async checkRuntimeBudget(run: ProjectRunRecord): Promise<void> {
    const startedAt = run.startedAt
    if (startedAt === undefined) return
    const elapsedMs = this.retryClock() - Date.parse(startedAt)
    if (Number.isNaN(elapsedMs) || elapsedMs < 0) return
    const elapsedMinutes = elapsedMs / 60_000
    const result = checkBudget(run.budget, elapsedMinutes, 'maxRuntimeMinutes', run.budgetWarnings ?? [])
    if (result === undefined) return
    if (result.exceeded) {
      await this.applyBudgetExceeded(run, result)
    } else if (result.warning) {
      await this.recordBudgetWarning(run, result)
    }
  }

  /** Append the key to `run.budgetWarnings` (dedup) + a `run.budget.warning` event. */
  private async recordBudgetWarning(run: ProjectRunRecord, result: BudgetCheckResult): Promise<void> {
    const tables = this.tables
    if (tables === undefined) return
    const pct = Math.round(result.ratio * 100)
    await tables.runs.update(run.id, current => ({
      ...current,
      budgetWarnings: [...(current.budgetWarnings ?? []), result.key],
      updatedAt: this.clock(),
      version: current.version + 1,
    }))
    await this.appendRunEvent({
      runId: run.id,
      projectId: run.projectId,
      type: 'run.budget.warning',
      title: `Budget warning: ${result.key}`,
      detail: `${result.key} at ${pct}% of ${result.limit}`,
      at: this.clock(),
    })
  }

  /**
   * Exceeded budget (spec §5.3): append the key to `budgetWarnings`, a
   * `run.budget.exceeded` event, then pause the run with a `resultSummary`
   * explaining why execution stopped (the state machine accepts
   * `resultSummary` on `paused`).
   */
  private async applyBudgetExceeded(run: ProjectRunRecord, result: BudgetCheckResult): Promise<void> {
    const tables = this.tables
    if (tables === undefined) return
    const pct = Math.round(result.ratio * 100)
    await tables.runs.update(run.id, current => ({
      ...current,
      budgetWarnings: [...(current.budgetWarnings ?? []), result.key],
      updatedAt: this.clock(),
      version: current.version + 1,
    }))
    await this.appendRunEvent({
      runId: run.id,
      projectId: run.projectId,
      type: 'run.budget.exceeded',
      title: `Budget exceeded: ${result.key}`,
      detail: `${result.key} at ${pct}% of ${result.limit}`,
      at: this.clock(),
    })
    const summary = `Budget limit reached: ${result.key} (${result.usage} of ${result.limit})`
    try {
      await this.runService.transitionRun(run.id, 'paused', { resultSummary: summary })
    } catch (error) {
      // Guard miss (the run moved concurrently) = logged no-op; the warning +
      // exceeded events already record the budget state.
      this.ctx.logger.warn('dsh-projects: budget pause failed for run %s: %s', run.id, errorMessage(error))
    }
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
