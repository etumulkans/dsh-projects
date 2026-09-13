/**
 * DSH Projects Phase 3 — CoordinatorService (spec §5).
 *
 * Hands a `created`/`planning` run to one Coordinator Lead session (a native
 * Harness agent) that plans — never implements — and persists a validated,
 * versioned Run Plan through the existing {@link RunPlanService}. The run's
 * lifecycle phase follows the plan's approval state via the Phase 3 coupling
 * hook (spec §6); this service itself performs no plan-approval run moves.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { requiresApproval } from '../approvals/approval-policy.ts'
import type { AgentProfileConfig } from '../config.ts'
import type { ProjectId } from '../catalog/types.ts'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import type { ProjectMemoryService } from '../memory/memory-service.ts'
import { COORDINATOR_MEMORY_BUDGET } from '../memory/retrieval.ts'
import type { RunPlanService } from '../plans/plan-service.ts'
import type { RunId, ProjectRunEventRecord, ProjectRunRecord, RunEventId } from '../runs/types.ts'
import { dshProjectsDomainSpec } from '../runs/spec.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import { coordinatorGuidance, coordinatorPrompt } from './policy.ts'
import {
  HarnessCoordinatorDriver,
  type CoordinatorDriver,
  type CoordinatorDriverResult,
  type CoordinatorPlanSubmitted,
  type CoordinatorPlanSubmission,
} from './session-driver.ts'

/** Payload of the `dsh-projects/run/coordinator-started` Cordis event. */
export interface CoordinatorStartedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly sessionId: string
  readonly at: string
}

/** Payload of the `dsh-projects/run/coordinator-completed` Cordis event. */
export interface CoordinatorCompletedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly planId: string
  readonly version: number
  readonly at: string
}

/** Payload of the `dsh-projects/run/coordinator-failed` Cordis event. */
export interface CoordinatorFailedEvent {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly error: string
  readonly at: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A Coordinator Lead session was started for a Run (persisted first). */
    'dsh-projects/run/coordinator-started'(event: CoordinatorStartedEvent): void
    /** Coordinator planning completed with a persisted plan (persisted first). */
    'dsh-projects/run/coordinator-completed'(event: CoordinatorCompletedEvent): void
    /** A Coordinator session failed or ended blocked (persisted first). */
    'dsh-projects/run/coordinator-failed'(event: CoordinatorFailedEvent): void
  }
}

const MAX_SUMMARY_LENGTH = 1_000
const EVENT_DETAIL_LIMIT = 200

interface CoordinatorTables {
  readonly runs: KvTable<RunId, ProjectRunRecord>
  readonly events: KvTable<RunEventId, ProjectRunEventRecord>
}

interface InFlightCoordination {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

/**
 * One-shot coordination per trigger: starts a Lead session, persists the
 * session reference and the session's plan submission, applies the
 * direct-vs-orchestrated flow once the session completes cleanly, and leaves
 * the run retryable (`blocked`) when the session fails.
 */
export class CoordinatorService {
  private tables: CoordinatorTables | undefined
  private readonly inFlight = new Map<RunId, InFlightCoordination>()

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly runService: ProjectRunService,
    private readonly planService: RunPlanService,
    private readonly agentProfile: AgentProfileConfig,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly driver: CoordinatorDriver = new HarnessCoordinatorDriver(ctx),
    /** Phase 6 (spec §7.1): memory service for the first-turn prompt packet. */
    private readonly memory?: ProjectMemoryService,
  ) {}

  /** Borrow the shared domain tables; requires the Run service to be started. */
  start(): void {
    if (this.tables !== undefined) throw new Error('dsh-projects: Coordinator service is already started')
    const domain: Domain<typeof dshProjectsDomainSpec> = this.runService.domain()
    this.tables = {
      runs: domain.table('runs'),
      events: domain.table('run_events'),
    }
  }

  /** Abort in-flight sessions; idempotent. */
  stop(): void {
    for (const { controller } of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
    this.tables = undefined
  }

  /**
   * Start one coordination for a `created`/`planning` run. Returns the run
   * record as soon as the planning move + session reference + started event
   * are persisted; the session itself continues in the background (spec §5.2).
   */
  async coordinate(runId: RunId): Promise<ProjectRunRecord> {
    const tables = this.requireStarted()
    const detail = await this.runService.runDetail(runId)
    const run = detail.run
    if (run.phase !== 'created' && run.phase !== 'planning') {
      throw new DashboardDomainError(
        'coordinator.runPhaseInvalid',
        `run ${runId} is ${run.phase}; the Coordinator only plans created or planning runs`,
        { runId, phase: run.phase },
      )
    }
    if (this.inFlight.has(runId)) {
      throw new DashboardDomainError('coordinator.inProgress', `a coordination is already running for run ${runId}`, { runId })
    }
    const project = this.catalog.project(run.projectId)
    if (project === undefined) {
      throw new DashboardDomainError('coordinator.projectUnknown', `run ${runId} references unknown project ${run.projectId}`, {
        runId,
        projectId: run.projectId,
      })
    }
    if (run.phase === 'created') {
      await this.runService.transitionRun(runId, 'planning')
    }
    const sessionId = `dsh-coordinator-${randomUUID()}`
    await tables.runs.update(runId, current => ({
      ...current,
      coordinatorSessionId: sessionId,
      updatedAt: this.clock(),
      version: current.version + 1,
    }))
    const updated = tables.runs.get(runId)
    if (updated === undefined) throw new DashboardDomainError('run.unknown', `unknown Run ${runId}`, { runId })
    const at = this.clock()
    await this.appendRunEvent({
      runId,
      projectId: run.projectId,
      type: 'run.coordinator.started',
      title: 'Coordinator started',
      detail: truncateDetail(sessionId),
      at,
    })
    this.ctx.emit('dsh-projects/run/coordinator-started', {
      runId,
      projectId: run.projectId,
      sessionId,
      at,
    })
    const prompt = this.buildPrompt(updated, project)
    const controller = new AbortController()
    const submitted: { plan?: CoordinatorPlanSubmitted; summary?: string } = {}
    const onPlanSubmit = (input: CoordinatorPlanSubmission): Promise<CoordinatorPlanSubmitted> =>
      this.handlePlanSubmit(runId, input, submitted)
    const promise = this.driver
      .start({
        sessionId,
        cwd: project.root,
        permissionPreset: this.agentProfile.permissionPreset,
        ...(this.agentProfile.agentPreset === undefined ? {} : { agentPreset: this.agentProfile.agentPreset }),
        prompt,
        signal: controller.signal,
        onPlanSubmit,
      })
      .then(result => this.settle(runId, run.projectId, result, submitted))
      .catch(error => {
        this.ctx.logger.warn(
          'dsh-projects: coordinator settlement failed for run %s: %s',
          runId,
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => {
        this.inFlight.delete(runId)
      })
    this.inFlight.set(runId, { controller, promise })
    return updated
  }

  /** The `dsh_projects_submit_plan` tool handler (spec §5.4). */
  private async handlePlanSubmit(
    runId: RunId,
    input: CoordinatorPlanSubmission,
    submitted: { plan?: CoordinatorPlanSubmitted; summary?: string },
  ): Promise<CoordinatorPlanSubmitted> {
    if (submitted.plan !== undefined) {
      throw new Error('a plan has already been submitted for this run; do not submit again')
    }
    const summary = input.summary.trim()
    if (summary === '') throw new Error('a plan summary must not be empty')
    if (summary.length > MAX_SUMMARY_LENGTH) {
      throw new Error(`a plan summary must be at most ${MAX_SUMMARY_LENGTH} characters`)
    }
    // Full Phase 2 validation applies; a rejection is rethrown to the agent as
    // a tool error so it can correct and resubmit.
    const plan = await this.planService.createPlan({
      runId,
      pattern: input.pattern,
      rationale: input.rationale,
      ...(input.assumptions === undefined ? {} : { assumptions: [...input.assumptions] }),
      ...(input.successCriteria === undefined ? {} : { successCriteria: [...input.successCriteria] }),
      ...(input.tasks === undefined ? {} : {
        tasks: input.tasks.map(task => ({
          title: task.title,
          description: task.description,
          ...(task.role === undefined ? {} : { role: task.role }),
          ...(task.dependencies === undefined ? {} : { dependencies: [...task.dependencies] }),
          ...(task.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: [...task.acceptanceCriteria] }),
        })),
      }),
      ...(input.replanReason === undefined ? {} : { replanReason: input.replanReason }),
    })
    const reference: CoordinatorPlanSubmitted = {
      planId: plan.id,
      version: plan.version,
      pattern: plan.pattern,
      status: plan.status,
    }
    submitted.plan = reference
    submitted.summary = summary
    return reference
  }

  /**
   * Post-session flow (spec §5.2 step 11). A clean session with a submitted
   * plan activates it (direct) or requests approval (orchestrated) — the run
   * phase then follows through the coupling hook. A failed/blocked session or
   * a clean session without a plan leaves the run retryable in `blocked`.
   */
  private async settle(
    runId: RunId,
    projectId: ProjectId,
    result: CoordinatorDriverResult,
    submitted: { plan?: CoordinatorPlanSubmitted; summary?: string },
  ): Promise<void> {
    const at = this.clock()
    if (result.kind === 'completed' && submitted.plan !== undefined && submitted.summary !== undefined) {
      if (submitted.plan.pattern === 'direct') {
        await this.planService.transitionPlan(submitted.plan.planId, 'active')
      } else {
        // Phase 7 (spec §4.4): consult the approval-mode policy. `manual`/`plan`
        // gate the plan (awaiting-approval, today's behavior); `guarded`/
        // `autonomous` activate it directly (the direct-pattern path). The mode
        // comes from the run record (config default `plan` when absent).
        const run = this.tables?.runs.get(runId)
        const mode = run?.approvalMode ?? 'plan'
        if (requiresApproval(mode, 'plan')) {
          await this.planService.transitionPlan(submitted.plan.planId, 'awaiting-approval')
        } else {
          await this.planService.transitionPlan(submitted.plan.planId, 'active')
        }
      }
      await this.appendRunEvent({
        runId,
        projectId,
        type: 'run.coordinator.completed',
        title: 'Coordinator planning complete',
        detail: submitted.summary,
        at,
      })
      this.ctx.emit('dsh-projects/run/coordinator-completed', {
        runId,
        projectId,
        planId: submitted.plan.planId,
        version: submitted.plan.version,
        at,
      })
      return
    }
    const error = result.kind === 'completed' ? 'session completed without submitting a plan' : result.error ?? 'coordinator session failed'
    try {
      await this.runService.transitionRun(runId, 'blocked')
    } catch (transitionError) {
      // The run may have been paused/canceled meanwhile; the failure below
      // still records the session outcome.
      this.ctx.logger.warn(
        'dsh-projects: could not move run %s to blocked: %s',
        runId,
        transitionError instanceof Error ? transitionError.message : String(transitionError),
      )
    }
    await this.appendRunEvent({
      runId,
      projectId,
      type: 'run.coordinator.failed',
      title: 'Coordinator failed',
      detail: truncateDetail(error),
      at,
    })
    this.ctx.emit('dsh-projects/run/coordinator-failed', {
      runId,
      projectId,
      error,
      at,
    })
  }

  /** First-turn prompt: guidance + real-state context (spec §4, §5.2 step 9). */
  private buildPrompt(run: ProjectRunRecord, project: { readonly name: string; readonly root: string }): string {
    const plans = this.planService.planList(run.id).map(plan => ({
      version: plan.version,
      status: plan.status,
      pattern: plan.pattern,
      rationale: plan.rationale,
      ...(plan.replanReason === undefined ? {} : { replanReason: plan.replanReason }),
    }))
    const base = [
      coordinatorGuidance(),
      '',
      coordinatorPrompt({
        goal: run.goal,
        projectName: project.name,
        projectRoot: project.root,
        runPhase: run.phase,
        existingPlans: plans,
      }),
    ].join('\n')
    // Phase 6 (spec §7.1): append the project memory packet (query = run
    // goal) after the existing prompt section; no packet → byte-identical.
    if (this.memory === undefined) return base
    const packet = this.memory.packetFor({ projectId: run.projectId, query: run.goal, budgets: COORDINATOR_MEMORY_BUDGET })
    return packet === undefined ? base : `${base}\n\n${packet}`
  }

  /** Append one high-level event on the run's per-run seq (shared stream). */
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

  private requireStarted(): CoordinatorTables {
    const tables = this.tables
    if (tables === undefined) throw new DashboardDomainError('coordinator.notStarted', 'Coordinator service is not started')
    return tables
  }
}

function truncateDetail(value: string): string {
  return value.length <= EVENT_DETAIL_LIMIT ? value : `${value.slice(0, EVENT_DETAIL_LIMIT - 1)}…`
}
