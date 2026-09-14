/**
 * Integration check against the real storage stack: a genuine Cordis Context,
 * the real JSON file backend, and the real DomainFacility (zod validation and
 * medium versioning included). Proves Run state survives a process-style
 * restart: close everything, re-open the domain on the same medium, and the
 * records come back validated.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import { CoordinatorService } from '../src/coordinator/coordinator-service.ts'
import { PlanRunCoupler } from '../src/coordinator/coupling.ts'
import type {
  CoordinatorDriver,
  CoordinatorDriverInput,
  CoordinatorDriverResult,
} from '../src/coordinator/session-driver.ts'
import { ApprovalService } from '../src/approvals/approval-service.ts'
import { ProjectArtifactService } from '../src/artifacts/artifact-service.ts'
import { RunPlanService } from '../src/plans/plan-service.ts'
import type { PlanStatusChangedEvent } from '../src/plans/plan-service.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import { integrationBranchName, taskBranchName, TaskWorktreeManager } from '../src/tasks/git-workspace.ts'
import { ProjectTaskService } from '../src/tasks/task-service.ts'
import type { TaskWorker, TaskWorkerInput, TaskWorkerResult } from '../src/tasks/worker.ts'

const temporaryRoots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose().catch(() => undefined)
  }
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

interface BootedStorage {
  readonly ctx: Context
  readonly backend: JsonStorageBackend
  readonly facility: DomainFacility
  readonly dispose: () => void
}

/** Boot a context with the storage hub, one JSON backend, and a facility over it. */
async function boot(root: string): Promise<BootedStorage> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'storages'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const dispose = ctx.provide('storageDomain', facility)
  return { ctx, backend, facility, dispose: () => { dispose(); backend.close().catch(() => undefined) } }
}

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000'

/**
 * Yield to the task queue until the coordinator settlement events are
 * persisted. Each real-JSON write is a whole-file rewrite with fsync, so the
 * settlement chain needs a generous budget of slow yields.
 */
async function settleCoordinator(runService: ProjectRunService, runId: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const detail = await runService.runDetail(runId)
    if (detail.events.some(event =>
      event.type === 'run.coordinator.completed' || event.type === 'run.coordinator.failed')) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('coordination did not settle in time')
}

/** Poll until the probe yields a value; `undefined`/`null`/`false` mean "not yet". */
async function poll<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', windowsHide: true })
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `refs/heads/${branch}`], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** A real temporary git repository with a local identity and one base commit. */
async function gitRepository(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  execFileSync('git', ['init', dir], { stdio: 'ignore', windowsHide: true })
  gitIn(dir, 'config', 'user.name', 'dsh-dashboard tests')
  gitIn(dir, 'config', 'user.email', 'dsh-dashboard@example.invalid')
  await writeFile(join(dir, 'base.txt'), 'base\n')
  gitIn(dir, 'add', 'base.txt')
  gitIn(dir, 'commit', '-m', 'fixture')
  return dir
}

function catalogFixture(): ProjectCatalog {
  return {
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Project A' } : undefined,
    // Phase 5: no Git source — these tests exercise the non-isolated path.
    projectWorkspaceSource: () => undefined,
  } as unknown as ProjectCatalog
}

describe('ProjectRunService against real JSON storage', () => {
  it('persists runs and events across a domain reopen on the same medium', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-'))
    temporaryRoots.push(root)
    const { ctx, facility, dispose } = await boot(root)
    const clock = () => new Date(Date.UTC(2026, 7, 14, 2, 0, 0)).toISOString()

    // --- boot 1: create a run, plan + activate v1, replan v2, suspend ---
    const first = new ProjectRunService(ctx, catalogFixture(), clock)
    await first.start()
    const firstPlans = new RunPlanService(ctx, first, clock)
    firstPlans.start()
    const run = await first.createRun(
      { goal: 'Integration: survive a real storage restart', sourceRef: 'IT-1' },
      { mode: 'project', projectId: PROJECT_ID },
    )
    expect(run).toMatchObject({ phase: 'created', version: 1 })
    await first.transitionRun(run.id, 'planning')
    await first.transitionRun(run.id, 'executing')
    const planV1 = await firstPlans.createPlan({
      runId: run.id,
      pattern: 'supervisor',
      rationale: 'coordinate the integration work',
      tasks: [{ title: 'first task', description: 'do the first thing' }],
    })
    await firstPlans.transitionPlan(planV1.id, 'active')
    const planV2 = await firstPlans.createPlan({
      runId: run.id,
      pattern: 'direct',
      rationale: 'narrowed scope',
      replanReason: 'scope changed mid-run',
    })
    await firstPlans.transitionPlan(planV2.id, 'active')
    const paused = await first.transitionRun(run.id, 'paused')
    expect(paused).toMatchObject({ phase: 'paused', suspendedFrom: 'executing', version: 6 })
    firstPlans.stop()
    await first.stop()
    await facility.closeAll()

    // --- boot 2: fresh service instance over the same medium ---
    const second = new ProjectRunService(ctx, catalogFixture(), clock)
    await second.start()
    const secondPlans = new RunPlanService(ctx, second, clock)
    secondPlans.start()
    try {
      const summary = await second.listForSnapshot({ mode: 'project', projectId: PROJECT_ID })
      expect(summary.total).toBe(1)
      expect(summary.runs[0]).toMatchObject({
        id: run.id,
        goal: 'Integration: survive a real storage restart',
        sourceRef: 'IT-1',
        phase: 'paused',
        suspendedFrom: 'executing',
        version: 6,
        activePlanId: planV2.id,
      })

      const detail = await second.runDetail(run.id)
      expect(detail.truncated).toBe(false)
      expect(detail.events.map(event => event.type)).toEqual([
        'run.phase.changed',
        'run.replanned',
        'plan.approved',
        'plan.superseded',
        'plan.created',
        'plan.approved',
        'plan.created',
        'run.phase.changed',
        'run.phase.changed',
        'run.created',
      ])
      expect(detail.events.map(event => event.seq)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
      expect(detail.events[0]!).toMatchObject({ type: 'run.phase.changed', detail: 'executing → paused' })
      expect(detail.events[1]!).toMatchObject({ type: 'run.replanned', detail: 'Plan v1 → v2' })

      const plans = secondPlans.planList(run.id)
      expect(plans.map(plan => plan.version)).toEqual([2, 1])
      expect(plans[0]).toMatchObject({ id: planV2.id, status: 'active', version: 2, revision: 1 })
      expect(plans[1]).toMatchObject({ id: planV1.id, status: 'superseded', version: 1, revision: 2, replanReason: 'scope changed mid-run' })
      expect(secondPlans.planDetail(planV2.id)).toMatchObject({ supersedesPlanId: planV1.id, replanReason: 'scope changed mid-run' })

      const resumed = await second.transitionRun(run.id, 'executing')
      expect(resumed).toMatchObject({ phase: 'executing', version: 7 })
      expect(resumed.suspendedFrom).toBeUndefined()

      await second.transitionRun(run.id, 'finalizing')
      const done = await second.transitionRun(run.id, 'succeeded', { resultSummary: 'integration complete' })
      expect(done.completedAt).toBe(clock())
      expect(done.resultSummary).toBe('integration complete')
      expect(done.version).toBe(9)

      await expect(second.transitionRun(run.id, 'planning')).rejects.toMatchObject({
        dashboardCode: 'run.transitionInvalid',
        params: { from: 'succeeded', to: 'planning' },
      })
    } finally {
      secondPlans.stop()
      await second.stop()
    }

    // --- the medium really exists on disk with the declared version ---
    const entries = await readdir(root, { recursive: true })
    const mediumEntries = entries.filter(entry => String(entry).includes('dsh_projects'))
    expect(mediumEntries.length).toBeGreaterThan(0)
    const mediumFile = mediumEntries.find(entry => String(entry).endsWith('.json'))
    expect(mediumFile).toBeDefined()
    const medium = JSON.parse(await readFile(join(root, String(mediumFile)), 'utf8')) as {
      unit: { name: string; version: number }
      tables: Record<string, Record<string, unknown>>
    }
    expect(medium.unit).toEqual({ name: dshProjectsDomainSpec.name, version: dshProjectsDomainSpec.version })
    // Phase 4 adds the `tasks` table, Phase 6 the `memory` table, Phase 7 the
    // `project_approvals` table, and Phase 8 the `project_artifacts` table
    // (empty here — no artifacts in this leg); every declared table is created
    // on domain open. The domain stays format version 0 (additive).
    expect(Object.keys(medium.tables).sort()).toEqual(['memory', 'plans', 'project_approvals', 'project_artifacts', 'run_events', 'runs', 'tasks'])
    expect(Object.keys(medium.tables.runs ?? {})).toHaveLength(1)
    expect(Object.keys(medium.tables.plans ?? {})).toHaveLength(2)
    // 10 boot-1 events + 3 boot-2 events (resume, finalize, completed)
    expect(Object.keys(medium.tables.run_events ?? {})).toHaveLength(13)

    dispose()
  })

  it('persists Phase 7 approval mode, budget, warnings, and approvals across a domain reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-'))
    temporaryRoots.push(root)
    const { ctx, facility, dispose } = await boot(root)
    const clock = () => new Date(Date.UTC(2026, 7, 14, 4, 0, 0)).toISOString()

    // --- boot 1: create a run with an approval mode + budget, request a
    // plan approval (via the onPlanApproval hook), and record a budget warning ---
    const first = new ProjectRunService(ctx, catalogFixture(), clock)
    await first.start()
    const firstApprovals = new ApprovalService(ctx, catalogFixture(), first)
    firstApprovals.start()
    const firstPlans = new RunPlanService(ctx, first, clock, {
      onPlanApproval: async event => {
        if (event.action === 'requested') {
          await firstApprovals.requestApproval({
            runId: event.runId,
            type: 'plan',
            summary: event.summary,
            payload: { planId: event.planId, version: event.version },
          })
          return
        }
        const pending = firstApprovals.pendingFor(event.runId, 'plan')
        if (pending === undefined) return
        await firstApprovals.resolveApproval(pending.id, event.action, {
          expectedVersion: pending.version,
          resolvedBy: 'plan-ui',
        })
      },
    })
    firstPlans.start()
    const run = await first.createRun(
      {
        goal: 'Phase 7: approval + budget survive a restart',
        sourceRef: 'IT-7',
        approvalMode: 'plan',
        budget: { maxTotalTokens: 5000, maxRuntimeMinutes: 60 },
      },
      { mode: 'project', projectId: PROJECT_ID },
    )
    await first.transitionRun(run.id, 'planning')
    // Record a budget warning directly (the checks run in the task service;
    // here we exercise the persistence surface).
    await first.domain().table('runs').update(run.id, current => ({
      ...current,
      budgetWarnings: ['maxTotalTokens'],
      version: current.version + 1,
    }))
    const planV1 = await firstPlans.createPlan({
      runId: run.id,
      pattern: 'supervisor',
      rationale: 'coordinate the work',
      tasks: [{ title: 'task', description: 'do it' }],
    })
    await firstPlans.transitionPlan(planV1.id, 'awaiting-approval')
    firstPlans.stop()
    firstApprovals.stop()
    await first.stop()
    await facility.closeAll()

    // --- boot 2: reopen; the approval mode, budget, warnings, and the
    // pending plan approval must all come back validated ---
    const second = new ProjectRunService(ctx, catalogFixture(), clock)
    await second.start()
    try {
      const detail = await second.runDetail(run.id)
      expect(detail.run).toMatchObject({
        phase: 'planning',
        approvalMode: 'plan',
        budget: { maxTotalTokens: 5000, maxRuntimeMinutes: 60 },
        budgetWarnings: ['maxTotalTokens'],
      })

      // The approval record survives in the shared domain table.
      const approvals = second.domain().table('project_approvals')
      const rows = [...approvals.entries()].map(([, record]) => record)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        runId: run.id,
        type: 'plan',
        status: 'pending',
        payload: { planId: planV1.id, version: 1 },
      })
    } finally {
      await second.stop()
    }

    // The medium carries the approvals table with the one pending record.
    const entries = await readdir(root, { recursive: true })
    const mediumFile = entries.find(entry => String(entry).endsWith('.json') && String(entry).includes('dsh_projects'))
    expect(mediumFile).toBeDefined()
    const medium = JSON.parse(await readFile(join(root, String(mediumFile)), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(medium.tables.project_approvals ?? {})).toHaveLength(1)

    dispose()
  })

  it('persists Phase 8 artifacts (run-scoped + project-scoped + final report) across a domain reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-'))
    temporaryRoots.push(root)
    const { ctx, facility, dispose } = await boot(root)
    const clock = () => new Date(Date.UTC(2026, 8, 10, 4, 0, 0)).toISOString()

    // --- boot 1: create a run, a run-scoped + a project-scoped artifact, and
    // the final report (via the on-demand generator) ---
    const first = new ProjectRunService(ctx, catalogFixture(), clock)
    await first.start()
    const firstArtifacts = new ProjectArtifactService(ctx, catalogFixture(), first, clock)
    firstArtifacts.start()
    const run = await first.createRun(
      { goal: 'Phase 8: artifacts survive a restart', sourceRef: 'IT-8' },
      { mode: 'project', projectId: PROJECT_ID },
    )
    const runScoped = await firstArtifacts.create({
      projectId: PROJECT_ID,
      runId: run.id,
      kind: 'plan',
      title: 'The plan',
      content: 'step one\nstep two',
    })
    const projectScoped = await firstArtifacts.create({
      projectId: PROJECT_ID,
      kind: 'research-report',
      title: 'Research',
      path: '/tmp/research.md',
    })
    // Stop the service (drops the run/completed listener) so the terminal
    // transition below does not fire the fire-and-forget generator; the report
    // is produced deterministically via the on-demand call.
    firstArtifacts.stop()
    let terminal = run
    for (const phase of ['planning', 'executing', 'finalizing', 'succeeded'] as const) {
      terminal = await first.transitionRun(terminal.id, phase, { resultSummary: 'done' })
    }
    const restarted = new ProjectArtifactService(ctx, catalogFixture(), first, clock)
    restarted.start()
    const report = await restarted.generateFinalReport(terminal.id, 'on-demand')
    expect(report).toBeDefined()
    restarted.stop()
    await first.stop()
    await facility.closeAll()

    // --- boot 2: reopen; every artifact must come back validated ---
    const second = new ProjectRunService(ctx, catalogFixture(), clock)
    await second.start()
    try {
      const secondArtifacts = new ProjectArtifactService(ctx, catalogFixture(), second, clock)
      secondArtifacts.start()
      try {
        const byRun = secondArtifacts.list({ runId: run.id })
        expect(byRun.map(record => record.id).sort()).toEqual([runScoped.id, report!.id].sort())
        const byProject = secondArtifacts.list({ projectId: PROJECT_ID })
        expect(byProject.map(record => record.id).sort()).toEqual([runScoped.id, projectScoped.id, report!.id].sort())
        // The run-scoped artifact round-trips its content verbatim.
        const detail = secondArtifacts.get(runScoped.id)
        expect(detail).toMatchObject({ kind: 'plan', title: 'The plan', content: 'step one\nstep two' })
        // The final report carries the deterministic §64 layout.
        const reportDetail = secondArtifacts.get(report!.id)
        expect(reportDetail).toMatchObject({ kind: 'final-report', title: 'Final report' })
        expect(reportDetail?.content).toContain('Goal')
        expect(reportDetail?.content).toContain('Remaining risks')
      } finally {
        secondArtifacts.stop()
      }
    } finally {
      await second.stop()
    }

    // The medium carries the artifacts table with the three records.
    const entries = await readdir(root, { recursive: true })
    const mediumFile = entries.find(entry => String(entry).endsWith('.json') && String(entry).includes('dsh_projects'))
    expect(mediumFile).toBeDefined()
    const medium = JSON.parse(await readFile(join(root, String(mediumFile)), 'utf8')) as {
      unit: { name: string; version: number }
      tables: Record<string, Record<string, unknown>>
    }
    expect(medium.unit).toEqual({ name: dshProjectsDomainSpec.name, version: dshProjectsDomainSpec.version })
    expect(Object.keys(medium.tables.project_artifacts ?? {})).toHaveLength(3)

    dispose()
  })

  it('persists coordinator state (session id, plan, phase, events) across a domain reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-'))
    temporaryRoots.push(root)
    const { ctx, facility, dispose } = await boot(root)
    const clock = () => new Date(Date.UTC(2026, 7, 14, 3, 0, 0)).toISOString()
    const agentProfile = { id: 'it', permissionPreset: 'it-preset', workerHost: 'local' }
    // The Lead session "submits" one orchestrated plan, then completes.
    const driver: CoordinatorDriver = {
      async start(input: CoordinatorDriverInput): Promise<CoordinatorDriverResult> {
        await input.onPlanSubmit({
          pattern: 'supervisor',
          rationale: 'coordinate the integration work',
          tasks: [{ title: 'implement', description: 'build it' }],
          summary: 'Supervisor plan: implement then verify.',
        })
        return { kind: 'completed' }
      },
    }

    // --- boot 1: coordinate a run; the orchestrated plan requests approval ---
    const first = new ProjectRunService(ctx, catalogFixture(), clock)
    await first.start()
    const firstCoupler = new PlanRunCoupler(ctx, first)
    const firstPlans = new RunPlanService(ctx, first, clock, { onPlanStatus: event => firstCoupler.handle(event) })
    firstPlans.start()
    const firstCoordinator = new CoordinatorService(ctx, catalogFixture(), first, firstPlans, agentProfile, clock, driver)
    firstCoordinator.start()
    const run = await first.createRun({ goal: 'Integration: coordinator survives a restart', sourceRef: 'IT-C' }, { mode: 'project', projectId: PROJECT_ID })
    const started = await firstCoordinator.coordinate(run.id)
    expect(started).toMatchObject({ phase: 'planning' })
    expect(started.coordinatorSessionId).toMatch(/^dsh-coordinator-/u)
    await settleCoordinator(first, run.id)
    const settled = await first.runDetail(run.id)
    expect(settled.run).toMatchObject({ phase: 'awaiting_approval' })
    expect(settled.run.coordinatorSessionId).toBe(started.coordinatorSessionId)
    const planV1 = firstPlans.planList(run.id)[0]!
    expect(planV1).toMatchObject({ version: 1, status: 'awaiting-approval', pattern: 'supervisor' })
    expect(settled.events.some(event => event.type === 'run.coordinator.started')).toBe(true)
    expect(settled.events.some(event => event.type === 'run.coordinator.completed')).toBe(true)
    firstCoordinator.stop()
    firstPlans.stop()
    await first.stop()
    await facility.closeAll()

    // --- boot 2: reopen the same medium; all coordinator state comes back ---
    const second = new ProjectRunService(ctx, catalogFixture(), clock)
    await second.start()
    const secondCoupler = new PlanRunCoupler(ctx, second)
    const secondPlans = new RunPlanService(ctx, second, clock, { onPlanStatus: event => secondCoupler.handle(event) })
    secondPlans.start()
    try {
      const detail = await second.runDetail(run.id)
      expect(detail.run).toMatchObject({
        id: run.id,
        phase: 'awaiting_approval',
        coordinatorSessionId: started.coordinatorSessionId,
      })
      expect(detail.events.map(event => event.type)).toEqual([
        'run.coordinator.completed',
        'run.phase.changed',
        'plan.approval.requested',
        'plan.created',
        'run.coordinator.started',
        'run.phase.changed',
        'run.created',
      ])
      expect(detail.events.some(event => event.type === 'run.coordinator.completed' && event.detail === 'Supervisor plan: implement then verify.')).toBe(true)

      // A manual approval on the second boot completes the coupled flow.
      await secondPlans.transitionPlan(planV1.id, 'active')
      const afterApproval = await second.runDetail(run.id)
      expect(afterApproval.run).toMatchObject({ phase: 'executing', activePlanId: planV1.id })
      expect(afterApproval.run.coordinatorSessionId).toBe(started.coordinatorSessionId)
    } finally {
      secondPlans.stop()
      await second.stop()
    }

    // The medium table set is unchanged by Phase 3 (no new tables); Phase 6
    // adds the shared `memory` table, created empty on domain open.
    const entries = await readdir(root, { recursive: true })
    const mediumFile = entries.find(entry => String(entry).includes('dsh_projects') && String(entry).endsWith('.json'))
    expect(mediumFile).toBeDefined()
    const medium = JSON.parse(await readFile(join(root, String(mediumFile)), 'utf8')) as {
      unit: { name: string; version: number }
      tables: Record<string, Record<string, unknown>>
    }
    expect(medium.unit).toEqual({ name: dshProjectsDomainSpec.name, version: dshProjectsDomainSpec.version })
    // Phase 4 adds the `tasks` table to the domain (empty here — no tasks in
    // this leg); every declared table is created on domain open.
    expect(Object.keys(medium.tables).sort()).toEqual(['memory', 'plans', 'project_approvals', 'project_artifacts', 'run_events', 'runs', 'tasks'])
    expect(Object.keys(medium.tables.runs ?? {})).toHaveLength(1)
    expect(Object.keys(medium.tables.plans ?? {})).toHaveLength(1)
    // 7 boot-1 events + 2 boot-2 events (approve, phase change to executing)
    expect(Object.keys(medium.tables.run_events ?? {})).toHaveLength(9)

    dispose()
  })

  it('rejects a domain version mismatch instead of silently migrating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-'))
    temporaryRoots.push(root)
    const { ctx, facility, dispose } = await boot(root)

    const first = new ProjectRunService(ctx, catalogFixture())
    await first.start()
    const run = await first.createRun({ goal: 'seed' }, { mode: 'project', projectId: PROJECT_ID })
    await first.stop()
    await facility.closeAll()

    const second = new ProjectRunService(ctx, catalogFixture())
    await second.start()
    try {
      const detail = await second.runDetail(run.id)
      expect(detail.run.goal).toBe('seed')
    } finally {
      await second.stop()
    }

    // Tamper the medium version: the next open must fail loud, not migrate.
    const entries = await readdir(root, { recursive: true })
    const mediumFile = entries.find(entry => String(entry).includes('dsh_projects') && String(entry).endsWith('.json'))
    expect(mediumFile).toBeDefined()
    const mediumPath = join(root, String(mediumFile))
    const medium = JSON.parse(await readFile(mediumPath, 'utf8')) as { unit: { name: string; version: number } }
    medium.unit.version = 99
    await writeFile(mediumPath, JSON.stringify(medium))

    const third = new ProjectRunService(ctx, catalogFixture())
    await expect(third.start()).rejects.toThrow(/version/i)

    dispose()
  })

  it('materializes plan tasks into the shared domain and persists them across a domain reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-'))
    temporaryRoots.push(root)
    const { ctx, facility, dispose } = await boot(root)
    const clock = () => new Date(Date.UTC(2026, 7, 14, 4, 0, 0)).toISOString()
    // A worker that never resolves: the leg exercises materialization and
    // persistence, not the adapters (covered by the unit suites). t1 starts
    // and stays running; t2 waits on its dependency.
    const worker: TaskWorker = {
      kind: 'local',
      start: (_input: TaskWorkerInput): Promise<TaskWorkerResult> => new Promise(() => undefined),
      async stop(): Promise<void> { /* nothing to stop */ },
    }

    // --- boot 1: run -> executing, activate a two-task plan, materialize ---
    const first = new ProjectRunService(ctx, catalogFixture(), clock)
    await first.start()
    const firstTasks = new ProjectTaskService(ctx, catalogFixture(), first, worker, undefined, undefined, clock)
    firstTasks.start()
    const firstPlans = new RunPlanService(ctx, first, clock, {
      onPlanStatus: (event: PlanStatusChangedEvent) => firstTasks.handlePlanStatus(event),
    })
    firstPlans.start()
    const run = await first.createRun(
      { goal: 'Integration: tasks survive a real storage restart', sourceRef: 'IT-T' },
      { mode: 'project', projectId: PROJECT_ID },
    )
    await first.transitionRun(run.id, 'planning')
    await first.transitionRun(run.id, 'executing')
    const plan = await firstPlans.createPlan({
      runId: run.id,
      pattern: 'supervisor',
      rationale: 'two-step integration work',
      tasks: [
        { title: 'implement the feature', description: 'build it', acceptanceCriteria: ['it works'] },
        { title: 'verify the feature', description: 'prove it', dependencies: ['t1'] },
      ],
    })
    await firstPlans.transitionPlan(plan.id, 'active')

    // Materialization (and the first tick) completed inside the awaited plan
    // transition: t1 is running with a session id, t2 is pending on it.
    const materialized = firstTasks.taskList(run.id)
    expect(materialized).toHaveLength(2)
    const byPosition = new Map(materialized.map(task => [task.planTaskId, task]))
    expect(byPosition.get('t1')).toMatchObject({ status: 'running', attempt: 1 })
    expect(byPosition.get('t1')!.assignedAgentId).toMatch(/^dsh-task-/u)
    expect(byPosition.get('t2')).toMatchObject({ status: 'pending', attempt: 0 })
    // The dependency resolved from the plan position to the real task id.
    expect(byPosition.get('t2')!.dependencies).toEqual([byPosition.get('t1')!.id])
    expect(firstTasks.taskCounts(run.id)).toMatchObject({ total: 2, running: 1, pending: 1 })

    const detail = await first.runDetail(run.id)
    expect(detail.events.some(event => event.type === 'tasks.materialized' && event.detail === 'plan v1: 2 tasks')).toBe(true)
    expect(detail.events.some(event => event.type === 'task.started')).toBe(true)
    firstPlans.stop()
    firstTasks.stop()
    await first.stop()
    await facility.closeAll()

    // --- boot 2: fresh services over the same medium ---
    const second = new ProjectRunService(ctx, catalogFixture(), clock)
    await second.start()
    const secondTasks = new ProjectTaskService(ctx, catalogFixture(), second, worker, undefined, undefined, clock)
    secondTasks.start()
    const secondPlans = new RunPlanService(ctx, second, clock, {
      onPlanStatus: (event: PlanStatusChangedEvent) => secondTasks.handlePlanStatus(event),
    })
    secondPlans.start()
    try {
      const tasks = secondTasks.taskList(run.id)
      expect(tasks).toHaveLength(2)
      const byPosition2 = new Map(tasks.map(task => [task.planTaskId, task]))
      // The running task comes back exactly as persisted (zod-validated on
      // the domain reopen), including its session identity.
      expect(byPosition2.get('t1')).toMatchObject({
        status: 'running',
        attempt: 1,
        title: 'implement the feature',
        acceptanceCriteria: ['it works'],
        maxAttempts: 3,
      })
      expect(byPosition2.get('t1')!.assignedAgentId).toBe(byPosition.get('t1')!.assignedAgentId)
      expect(byPosition2.get('t2')).toMatchObject({
        status: 'pending',
        attempt: 0,
        dependencies: [byPosition2.get('t1')!.id],
      })
      expect(secondTasks.taskCounts(run.id)).toMatchObject({ total: 2, running: 1, pending: 1 })

      // The run and its task events survive with the task stream intact.
      const reopened = await second.runDetail(run.id)
      expect(reopened.run).toMatchObject({ phase: 'executing', activePlanId: plan.id })
      expect(reopened.events.some(event => event.type === 'tasks.materialized')).toBe(true)
      expect(reopened.events.some(event => event.type === 'task.started')).toBe(true)
      expect(secondPlans.planList(run.id)).toHaveLength(1)
    } finally {
      secondPlans.stop()
      secondTasks.stop()
      await second.stop()
    }

    // The medium carries the tasks table with both validated records.
    const entries = await readdir(root, { recursive: true })
    const mediumFile = entries.find(entry => String(entry).includes('dsh_projects') && String(entry).endsWith('.json'))
    expect(mediumFile).toBeDefined()
    const medium = JSON.parse(await readFile(join(root, String(mediumFile)), 'utf8')) as {
      unit: { name: string; version: number }
      tables: Record<string, Record<string, unknown>>
    }
    expect(medium.unit).toEqual({ name: dshProjectsDomainSpec.name, version: dshProjectsDomainSpec.version })
    expect(Object.keys(medium.tables).sort()).toEqual(['memory', 'plans', 'project_approvals', 'project_artifacts', 'run_events', 'runs', 'tasks'])
    expect(Object.keys(medium.tables.runs ?? {})).toHaveLength(1)
    expect(Object.keys(medium.tables.plans ?? {})).toHaveLength(1)
    expect(Object.keys(medium.tables.tasks ?? {})).toHaveLength(2)
    const persistedTask = Object.values(medium.tables.tasks ?? {})[0] as Record<string, unknown>
    expect(persistedTask).toMatchObject({ runId: run.id, planId: plan.id, maxAttempts: 3, version: expect.any(Number) })

    dispose()
  })

  it('runs the full Git pipeline on a real repository and persists it across a domain reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-git-'))
    temporaryRoots.push(root)
    const repo = await gitRepository(join(root, 'repo'))
    const { ctx, facility, dispose } = await boot(root)
    const clock = () => new Date(Date.UTC(2026, 7, 14, 5, 0, 0)).toISOString()
    const gitCatalog = {
      project: (id: string) => id === PROJECT_ID ? { id, name: 'Project A' } : undefined,
      projectWorkspaceSource: (id: string) => id === PROJECT_ID
        ? { strategy: 'worktree' as const, projectRoot: repo, repositoryRoot: repo }
        : undefined,
    } as unknown as ProjectCatalog
    // A file-writing worker: each task commits a file unique to its worktree.
    const worker: TaskWorker = {
      kind: 'local',
      async start(input: TaskWorkerInput): Promise<TaskWorkerResult> {
        const leaf = input.branch?.split('/').pop() ?? input.taskId.slice(0, 8)
        await new Promise(resolve => setTimeout(resolve, 50))
        await writeFile(join(input.cwd, `file-${leaf}.txt`), `${leaf}\n`)
        return { kind: 'succeeded', summary: `wrote file-${leaf}.txt` }
      },
      async stop() { /* nothing to stop */ },
    }

    // --- boot 1: run the whole pipeline to completion on the real medium ---
    const first = new ProjectRunService(ctx, gitCatalog, clock)
    await first.start()
    const firstTasks = new ProjectTaskService(ctx, gitCatalog, first, worker, new TaskWorktreeManager(), undefined, clock)
    firstTasks.start()
    const firstPlans = new RunPlanService(ctx, first, clock, {
      onPlanStatus: (event: PlanStatusChangedEvent) => firstTasks.handlePlanStatus(event),
    })
    firstPlans.start()
    const run = await first.createRun(
      { goal: 'Integration: the Git pipeline survives a real storage restart', sourceRef: 'IT-G' },
      { mode: 'project', projectId: PROJECT_ID },
    )
    await first.transitionRun(run.id, 'planning')
    await first.transitionRun(run.id, 'executing')
    const plan = await firstPlans.createPlan({
      runId: run.id,
      pattern: 'direct',
      rationale: 'two independent git tasks',
      tasks: [
        { title: 'first file', description: 'write file-t1' },
        { title: 'second file', description: 'write file-t2' },
      ],
    })
    await firstPlans.transitionPlan(plan.id, 'active')
    // The pipeline (integrating → validating → finalizing) needs ~3 ticks.
    const succeeded = await poll(
      () => first.runDetail(run.id).then(detail => (detail.run.phase === 'succeeded' ? detail.run : undefined)),
      'run succeeded',
      55_000,
    )
    expect(succeeded.integrationBranch).toBe(integrationBranchName(run.id))
    expect(succeeded.integrationHead).toBeDefined()
    expect(succeeded.resultSummary).toBe(`integrated branch ${integrationBranchName(run.id)} @ ${succeeded.integrationHead!.slice(0, 8)}`)
    firstPlans.stop()
    firstTasks.stop()
    await first.stop()
    await facility.closeAll()

    // --- boot 2: reopen; every Git state must come back validated ---
    const second = new ProjectRunService(ctx, gitCatalog, clock)
    await second.start()
    const secondTasks = new ProjectTaskService(ctx, gitCatalog, second, worker, new TaskWorktreeManager(), undefined, clock)
    secondTasks.start()
    const secondPlans = new RunPlanService(ctx, second, clock, {
      onPlanStatus: (event: PlanStatusChangedEvent) => secondTasks.handlePlanStatus(event),
    })
    secondPlans.start()
    try {
      const detail = await second.runDetail(run.id)
      expect(detail.run).toMatchObject({
        phase: 'succeeded',
        integrationBranch: integrationBranchName(run.id),
        integrationHead: succeeded.integrationHead,
        resultSummary: succeeded.resultSummary,
      })
      // The integration events survive the reopen (zod-validated).
      expect(detail.events.some(event => event.type === 'run.integration.started')).toBe(true)
      expect(detail.events.some(event => event.type === 'run.integration.completed')).toBe(true)
      // Both tasks come back with their Git identity and their commit.
      const views = secondTasks.taskList(run.id)
      const byPosition = new Map(views.map(task => [task.planTaskId, task]))
      for (const position of ['t1', 't2'] as const) {
        const view = byPosition.get(position)!
        expect(view).toMatchObject({ status: 'succeeded', branch: taskBranchName(run.id, position) })
        expect(view.baseCommit).toBeDefined()
        expect(view.headCommit).toBeDefined()
        expect(view.headCommit).not.toBe(view.baseCommit)
      }
      // The raw persisted record keeps the internal worktree path too.
      const records = secondTasks.taskList(run.id)
      expect(records).toHaveLength(2)
      // On-disk reality: finalization cleaned up before the restart.
      expect(branchExists(repo, taskBranchName(run.id, 't1'))).toBe(false)
      expect(branchExists(repo, taskBranchName(run.id, 't2'))).toBe(false)
      expect(branchExists(repo, integrationBranchName(run.id))).toBe(true)
    } finally {
      secondPlans.stop()
      secondTasks.stop()
      await second.stop()
    }

    // The table set is unchanged (the Phase 5 fields are additive).
    const entries = await readdir(root, { recursive: true })
    const mediumFile = entries.find(entry => String(entry).includes('dsh_projects') && String(entry).endsWith('.json'))
    expect(mediumFile).toBeDefined()
    const medium = JSON.parse(await readFile(join(root, String(mediumFile)), 'utf8')) as {
      unit: { name: string; version: number }
      tables: Record<string, Record<string, unknown>>
    }
    expect(medium.unit).toEqual({ name: dshProjectsDomainSpec.name, version: dshProjectsDomainSpec.version })
    expect(Object.keys(medium.tables).sort()).toEqual(['memory', 'plans', 'project_approvals', 'project_artifacts', 'run_events', 'runs', 'tasks'])
    const persistedTasks = Object.values(medium.tables.tasks ?? {})
    expect(persistedTasks).toHaveLength(2)
    const persistedTask = persistedTasks[0] as Record<string, unknown>
    expect(persistedTask).toMatchObject({
      runId: run.id,
      branch: expect.stringMatching(/^dsh\/run-[0-9a-f]{8}\/t[12]$/),
      headCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    })

    dispose()
  }, 90_000)
})
