import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCatalog } from '../src/catalog/catalog.ts'
import { CoordinatorService } from '../src/coordinator/coordinator-service.ts'
import { PlanRunCoupler } from '../src/coordinator/coupling.ts'
import type {
  CoordinatorDriver,
  CoordinatorDriverInput,
  CoordinatorDriverResult,
  CoordinatorPlanSubmission,
} from '../src/coordinator/session-driver.ts'
import { RunPlanService } from '../src/plans/plan-service.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

class MemoryStorage {
  readonly tables = new Map<string, MemoryKvTable<string, unknown>>()

  open(): Domain<typeof dshProjectsDomainSpec> {
    const tables = this.tables
    const domain = {
      name: dshProjectsDomainSpec.name,
      table(name: string) {
        let table = tables.get(name)
        if (table === undefined) {
          table = new MemoryKvTable<string, unknown>()
          tables.set(name, table)
        }
        return table
      },
      close: vi.fn(async () => undefined),
    } as unknown as Domain<typeof dshProjectsDomainSpec>
    return domain
  }
}

class MemoryKvTable<K extends string, V> implements KvTable<K, V> {
  private readonly records = new Map<K, V>()

  get size(): number { return this.records.size }
  get(key: K): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.records).entries() }
  keys(): IterableIterator<K> { return new Map(this.records).keys() }
  async put(key: K, value: V): Promise<void> { this.records.set(key, value) }
  async delete(key: K): Promise<boolean> { return this.records.delete(key) }
  async update(key: K, update: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new DomainError('missing-key', `missing key ${key}`)
    const next = update(current)
    this.records.set(key, next)
    return next
  }
}

const AGENT_PROFILE = { id: 'test', permissionPreset: 'test-preset', workerHost: 'local' }

interface CoordinatorFixture {
  context: Context
  catalog: ProjectCatalog
  projectId: string
  runService: ProjectRunService
  planService: RunPlanService
  coupler: PlanRunCoupler
  coordinator: CoordinatorService
  driver: FakeDriver
  emit: ReturnType<typeof vi.fn>
}

/** Configurable driver: records every call and runs one behavior per invocation. */
class FakeDriver implements CoordinatorDriver {
  readonly calls: CoordinatorDriverInput[] = []
  constructor(
    private readonly behavior: (input: CoordinatorDriverInput) => Promise<CoordinatorDriverResult> | CoordinatorDriverResult,
  ) {}

  start(input: CoordinatorDriverInput): Promise<CoordinatorDriverResult> {
    this.calls.push(input)
    return Promise.resolve(this.behavior(input))
  }
}

/** Submits one plan through the tool handler, then completes the session. */
function submittingDriver(submission: CoordinatorPlanSubmission): FakeDriver {
  return new FakeDriver(async (input) => {
    await input.onPlanSubmit(submission)
    return { kind: 'completed' }
  })
}

async function fixture(driver: FakeDriver): Promise<CoordinatorFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-coordinator-'))
  temporaryDirectories.push(root)
  const projectRoot = join(root, 'proj')
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, 'WORKFLOW.md'), localWorkflow())

  const storage = new MemoryStorage()
  const emit = vi.fn()
  const context = {
    logger: { info: vi.fn(), warn: vi.fn() },
    emit,
    storageDomain: { open: vi.fn(async () => storage.open()) },
  } as unknown as Context

  const catalog = new ProjectCatalog(context, {
    currentProject: { root: projectRoot, policyPath: 'WORKFLOW.md', registerInCatalog: true },
    discoveryRoots: [],
  }, root)
  await catalog.start()
  const projectId = catalog.activeProject()!.id
  const runService = new ProjectRunService(context, catalog)
  await runService.start()
  const coupler = new PlanRunCoupler(context, runService)
  const planService = new RunPlanService(context, runService, undefined, {
    onPlanStatus: event => coupler.handle(event),
  })
  planService.start()
  const coordinator = new CoordinatorService(context, catalog, runService, planService, AGENT_PROFILE, () => '2025-01-01T00:00:00.000Z', driver)
  coordinator.start()
  return { context, catalog, projectId, runService, planService, coupler, coordinator, driver, emit }
}

async function settle(fixture: CoordinatorFixture, runId: string): Promise<void> {
  // The settlement chain runs after the (fake) driver promise; yield to the
  // task queue until the coordinator outcome event is persisted.
  for (let i = 0; i < 50; i += 1) {
    const detail = await fixture.runService.runDetail(runId)
    if (detail.events.some(event =>
      event.type === 'run.coordinator.completed' || event.type === 'run.coordinator.failed')) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('coordination did not settle in time')
}

const directSubmission: CoordinatorPlanSubmission = {
  pattern: 'direct',
  rationale: 'small self-contained change',
  summary: 'Ship the change directly with one verification pass.',
}

const orchestratedSubmission: CoordinatorPlanSubmission = {
  pattern: 'supervisor',
  rationale: 'multiple components need dispatch',
  successCriteria: ['endpoint responds'],
  tasks: [{ title: 'Implement', description: 'write the code', acceptanceCriteria: ['tests pass'] }],
  summary: 'Supervisor dispatches implementation and review tasks.',
}

describe('CoordinatorService (Phase 3)', () => {
  it('rejects coordinate before start', async () => {
    const base = await fixture(new FakeDriver(() => ({ kind: 'completed' })))
    base.coordinator.stop()
    const run = await base.runService.createRun({ goal: 'x' }, { mode: 'project', projectId: base.projectId })
    await expect(base.coordinator.coordinate(run.id))
      .rejects.toMatchObject({ dashboardCode: 'coordinator.notStarted' })
    await base.runService.stop()
    await base.catalog.stop()
  })

  it('rejects runs that are not created or planning', async () => {
    const base = await fixture(new FakeDriver(() => ({ kind: 'completed' })))
    try {
      const run = await base.runService.createRun({ goal: 'x' }, { mode: 'project', projectId: base.projectId })
      await base.runService.transitionRun(run.id, 'planning')
      await base.runService.transitionRun(run.id, 'executing')
      await expect(base.coordinator.coordinate(run.id))
        .rejects.toMatchObject({ dashboardCode: 'coordinator.runPhaseInvalid', params: { runId: run.id, phase: 'executing' } })
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('rejects a second coordination while one is in flight', async () => {
    let release: ((result: CoordinatorDriverResult) => void) | undefined
    const gate = new FakeDriver(() => new Promise<CoordinatorDriverResult>(resolve => { release = resolve }))
    const base = await fixture(gate)
    try {
      const run = await base.runService.createRun({ goal: 'x' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await expect(base.coordinator.coordinate(run.id))
        .rejects.toMatchObject({ dashboardCode: 'coordinator.inProgress', params: { runId: run.id } })
      release?.({ kind: 'completed' })
      await settle(base, run.id)
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('moves a created run to planning, persists the session id, and records the started event', async () => {
    const base = await fixture(submittingDriver(directSubmission))
    try {
      const run = await base.runService.createRun({ goal: 'health endpoint' }, { mode: 'project', projectId: base.projectId })
      const returned = await base.coordinator.coordinate(run.id)
      expect(returned.phase).toBe('planning')
      expect(returned.coordinatorSessionId).toMatch(/^dsh-coordinator-[0-9a-f-]{36}$/u)
      const detail = await base.runService.runDetail(run.id)
      const started = detail.events.find(event => event.type === 'run.coordinator.started')
      expect(started?.detail).toBe(returned.coordinatorSessionId)
      expect(base.emit).toHaveBeenCalledWith('dsh-projects/run/coordinator-started', expect.objectContaining({
        runId: run.id,
        projectId: base.projectId,
        sessionId: returned.coordinatorSessionId,
      }))
      await settle(base, run.id)
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('direct flow: activates the submitted plan and moves the run to executing via the coupling hook', async () => {
    const base = await fixture(submittingDriver(directSubmission))
    try {
      const run = await base.runService.createRun({ goal: 'direct goal' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      const plans = base.planService.planList(run.id)
      expect(plans).toHaveLength(1)
      expect(plans[0]!.status).toBe('active')
      expect(plans[0]!.pattern).toBe('direct')
      const detail = await base.runService.runDetail(run.id)
      expect(detail.run.phase).toBe('executing')
      expect(detail.run.activePlanId).toBe(plans[0]!.id)
      const completed = detail.events.find(event => event.type === 'run.coordinator.completed')
      expect(completed?.detail).toBe(directSubmission.summary)
      expect(base.emit).toHaveBeenCalledWith('dsh-projects/run/coordinator-completed', expect.objectContaining({
        runId: run.id,
        planId: plans[0]!.id,
        version: 1,
      }))
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('orchestrated flow: requests plan approval and moves the run to awaiting_approval', async () => {
    const base = await fixture(submittingDriver(orchestratedSubmission))
    try {
      const run = await base.runService.createRun({ goal: 'orchestrated goal' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      const plans = base.planService.planList(run.id)
      expect(plans[0]!.status).toBe('awaiting-approval')
      expect((await base.runService.runDetail(run.id)).run.phase).toBe('awaiting_approval')

      // The existing plan UI completes the flow: approve → active + executing.
      await base.planService.transitionPlan(plans[0]!.id, 'active')
      const afterApproval = await base.runService.runDetail(run.id)
      expect(afterApproval.run.phase).toBe('executing')
      expect(afterApproval.run.activePlanId).toBe(plans[0]!.id)
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('rejecting the orchestrated plan returns the run to planning', async () => {
    const base = await fixture(submittingDriver(orchestratedSubmission))
    try {
      const run = await base.runService.createRun({ goal: 'rejectable' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      const plan = base.planService.planList(run.id)[0]!
      await base.planService.transitionPlan(plan.id, 'draft')
      expect((await base.runService.runDetail(run.id)).run.phase).toBe('planning')
      expect(base.planService.planList(run.id)[0]!.status).toBe('draft')
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('a completed session without a submitted plan blocks the run with a failure event', async () => {
    const base = await fixture(new FakeDriver(() => ({ kind: 'completed' })))
    try {
      const run = await base.runService.createRun({ goal: 'no plan' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      const detail = await base.runService.runDetail(run.id)
      expect(detail.run.phase).toBe('blocked')
      expect(detail.run.suspendedFrom).toBe('planning')
      const failed = detail.events.find(event => event.type === 'run.coordinator.failed')
      expect(failed?.detail).toBe('session completed without submitting a plan')
      expect(base.emit).toHaveBeenCalledWith('dsh-projects/run/coordinator-failed', expect.objectContaining({ runId: run.id }))
      expect(base.planService.planList(run.id)).toHaveLength(0)
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('a failed session blocks the run and records the driver error', async () => {
    const base = await fixture(new FakeDriver(() => ({ kind: 'failed', error: 'model exploded' })))
    try {
      const run = await base.runService.createRun({ goal: 'broken' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      const detail = await base.runService.runDetail(run.id)
      expect(detail.run.phase).toBe('blocked')
      expect(detail.events.find(event => event.type === 'run.coordinator.failed')?.detail).toBe('model exploded')
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('replan: the tool rejects a missing replan reason, then accepts the corrected submission', async () => {
    const base = await fixture(new FakeDriver(async (input) => {
      await expect(input.onPlanSubmit({ ...directSubmission })).rejects.toThrow(/replan/iu)
      await input.onPlanSubmit({ ...directSubmission, replanReason: 'first plan missed the tests' })
      return { kind: 'completed' }
    }))
    try {
      const run = await base.runService.createRun({ goal: 'replan' }, { mode: 'project', projectId: base.projectId })
      const first = await base.planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'first' })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      const plans = base.planService.planList(run.id)
      expect(plans.map(plan => plan.version).sort((a, b) => b - a)).toEqual([2, 1])
      const second = base.planService.planList(run.id).find(plan => plan.version === 2)!
      expect(second.status).toBe('active')
      expect(second.replanReason).toBe('first plan missed the tests')
      // The prior plan was never active, so supersede-on-activation does not
      // apply; it stays draft and is superseded manually or on activation.
      expect(first.status).toBe('draft')
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('rejects a second submission within the same session', async () => {
    const base = await fixture(new FakeDriver(async (input) => {
      await input.onPlanSubmit(directSubmission)
      await expect(input.onPlanSubmit(directSubmission)).rejects.toThrow(/already been submitted/u)
      return { kind: 'completed' }
    }))
    try {
      const run = await base.runService.createRun({ goal: 'once' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      expect(base.planService.planList(run.id)).toHaveLength(1)
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('rejects empty or over-long summaries as tool errors', async () => {
    const base = await fixture(new FakeDriver(async (input) => {
      await expect(input.onPlanSubmit({ ...directSubmission, summary: '   ' })).rejects.toThrow(/summary must not be empty/u)
      await expect(input.onPlanSubmit({ ...directSubmission, summary: 'x'.repeat(1_001) }))
        .rejects.toThrow(/at most 1000/u)
      return { kind: 'completed' }
    }))
    try {
      const run = await base.runService.createRun({ goal: 'summary' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      expect(base.planService.planList(run.id)).toHaveLength(0)
      expect((await base.runService.runDetail(run.id)).run.phase).toBe('blocked')
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('stop aborts the in-flight session signal', async () => {
    let release: (() => void) | undefined
    const gate = new FakeDriver(() => new Promise<CoordinatorDriverResult>(resolve => {
      release = () => { resolve({ kind: 'completed' }) }
    }))
    const base = await fixture(gate)
    const run = await base.runService.createRun({ goal: 'abort' }, { mode: 'project', projectId: base.projectId })
    await base.coordinator.coordinate(run.id)
    const signal = base.driver.calls[0]!.signal
    expect(signal.aborted).toBe(false)
    base.coordinator.stop()
    expect(signal.aborted).toBe(true)
    release?.()
    await base.runService.stop()
    await base.catalog.stop()
  })

  it('coupling guard: approving a plan while the run executes does not move the run', async () => {
    const base = await fixture(new FakeDriver(() => ({ kind: 'completed' })))
    try {
      const run = await base.runService.createRun({ goal: 'guard' }, { mode: 'project', projectId: base.projectId })
      await base.runService.transitionRun(run.id, 'planning')
      await base.runService.transitionRun(run.id, 'executing')
      const plan = await base.planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'late plan' })
      await base.planService.transitionPlan(plan.id, 'active')
      expect((await base.runService.runDetail(run.id)).run.phase).toBe('executing')
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })

  it('passes the configured agent profile and project root to the driver', async () => {
    const base = await fixture(submittingDriver(directSubmission))
    try {
      const run = await base.runService.createRun({ goal: 'config' }, { mode: 'project', projectId: base.projectId })
      await base.coordinator.coordinate(run.id)
      await settle(base, run.id)
      const call = base.driver.calls[0]!
      expect(call.permissionPreset).toBe('test-preset')
      expect(call.cwd).toBe(base.catalog.project(base.projectId)!.root)
      expect(call.prompt).toContain('Goal: config')
      expect(call.prompt).toContain('dsh_projects_submit_plan')
      expect(call.sessionId).toMatch(/^dsh-coordinator-/u)
    } finally {
      await base.runService.stop()
      await base.catalog.stop()
    }
  })
})

function localWorkflow(): string {
  return [
    '# Workflow',
    '',
    'states:',
    '  - name: todo',
    '  - name: doing',
    '  - name: done',
    '    terminal: true',
  ].join('\n')
}
