import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCatalog } from '../src/catalog/catalog.ts'
import { RunPlanService } from '../src/plans/plan-service.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-plans-'))
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
  const planService = new RunPlanService(context, runService)
  planService.start()
  return { context, catalog, projectId, runService, planService, storage, emit }
}

interface StoppedFixture {
  context: Context
  catalog: ProjectCatalog
  projectId: string
  storage: MemoryStorage
}

async function restart(base: Awaited<ReturnType<typeof fixture>>): Promise<StoppedFixture> {
  base.planService.stop()
  await base.runService.stop()
  return { context: base.context, catalog: base.catalog, projectId: base.projectId, storage: base.storage }
}

async function bootAgain(base: StoppedFixture): Promise<{ runService: ProjectRunService; planService: RunPlanService }> {
  const runService = new ProjectRunService(base.context, base.catalog)
  await runService.start()
  const planService = new RunPlanService(base.context, runService)
  planService.start()
  return { runService, planService }
}

function memoryContextStorage(): MemoryStorage {
  return new MemoryStorage()
}

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

const UUID = '00000000-0000-4000-8000-000000000000'

describe('RunPlanService', () => {
  it('rejects calls before the Run service is started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-plans-'))
    temporaryDirectories.push(root)
    const projectRoot = join(root, 'proj')
    await mkdir(projectRoot)
    await writeFile(join(projectRoot, 'WORKFLOW.md'), localWorkflow())
    const context = {
      logger: { info: vi.fn(), warn: vi.fn() },
      emit: vi.fn(),
      storageDomain: { open: vi.fn(async () => memoryContextStorage().open()) },
    } as unknown as Context
    const catalog = new ProjectCatalog(context, {
      currentProject: { root: projectRoot, policyPath: 'WORKFLOW.md', registerInCatalog: true },
      discoveryRoots: [],
    }, root)
    await catalog.start()
    const runService = new ProjectRunService(context, catalog)
    const planService = new RunPlanService(context, runService)
    expect(() => planService.start()).toThrow(/Run service is not started|notStarted/u)
    await expect(planService.createPlan({ runId: UUID, pattern: 'direct', rationale: 'x' }))
      .rejects.toMatchObject({ dashboardCode: 'plan.notStarted' })
    await catalog.stop()
  })

  it('rejects a double start and an idempotent stop', async () => {
    const base = await fixture()
    expect(() => base.planService.start()).toThrow('already started')
    base.planService.stop()
    base.planService.stop()
    await expect(base.planService.createPlan({ runId: UUID, pattern: 'direct', rationale: 'x' }))
      .rejects.toMatchObject({ dashboardCode: 'plan.notStarted' })
    await base.runService.stop()
  })

  it('validates createPlan inputs in the spec order', async () => {
    const { planService, runService, projectId } = await fixture()
    try {
      await expect(planService.createPlan({ runId: UUID, pattern: 'direct', rationale: 'x' }))
        .rejects.toMatchObject({ dashboardCode: 'plan.runUnknown', params: { runId: UUID } })

      const run = await runService.createRun({ goal: 'target' }, { mode: 'project', projectId })
      await runService.transitionRun(run.id, 'canceled')
      await expect(planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'x' }))
        .rejects.toMatchObject({ dashboardCode: 'plan.runTerminal', params: expect.objectContaining({ runId: run.id, phase: 'canceled' }) })

      const live = await runService.createRun({ goal: 'live' }, { mode: 'project', projectId })
      const baseInput = { runId: live.id, pattern: 'supervisor' as const }
      await expect(planService.createPlan({ ...baseInput, rationale: '   ' }))
        .rejects.toMatchObject({ dashboardCode: 'plan.rationaleEmpty' })
      await expect(planService.createPlan({ ...baseInput, rationale: 'x'.repeat(2_001), tasks: [{ title: 't', description: 'd' }] }))
        .rejects.toMatchObject({ dashboardCode: 'plan.rationaleTooLong', params: { maxLength: 2_000 } })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: Array.from({ length: 51 }, (_, index) => ({ title: `t${index}`, description: 'd' })),
      })).rejects.toMatchObject({ dashboardCode: 'plan.tasksTooMany', params: { max: 50 } })
      await expect(planService.createPlan({ ...baseInput, rationale: 'r' }))
        .rejects.toMatchObject({ dashboardCode: 'plan.patternRequiresTasks', params: { pattern: 'supervisor' } })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: [{ title: '  ', description: 'd' }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.taskTitleEmpty', params: { task: 't1' } })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: [{ title: 'x'.repeat(301), description: 'd' }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.contentInvalid', params: expect.objectContaining({ task: 't1', maxLength: 300 }) })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: [{ title: 't', description: '   ' }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.contentInvalid' })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: [{ title: 't', description: 'x'.repeat(4_001) }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.contentInvalid' })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: [{ title: 't', description: 'd', acceptanceCriteria: ['c'.repeat(501)] }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.contentInvalid' })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: [{ title: 't', description: 'd', dependencies: ['t2'] }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.taskDependencyInvalid', params: { task: 't1', dependency: 't2' } })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        tasks: [{ title: 'a', description: 'd' }, { title: 'b', description: 'd', dependencies: ['t3'] }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.taskDependencyInvalid', params: { task: 't2', dependency: 't3' } })
      await expect(planService.createPlan({
        ...baseInput,
        rationale: 'r',
        successCriteria: ['x'.repeat(501)],
        tasks: [{ title: 't', description: 'd' }],
      })).rejects.toMatchObject({ dashboardCode: 'plan.contentInvalid', params: { max: 20 } })
    } finally {
      await runService.stop()
    }
  })

  it('creates a draft plan with assigned ids, its event, and the Cordis emit', async () => {
    const { planService, runService, projectId, storage, emit } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'planned' }, { mode: 'project', projectId })
      const plan = await planService.createPlan({
        runId: run.id,
        pattern: 'supervisor',
        rationale: 'coordinate the work',
        assumptions: ['a1', 'a2'],
        successCriteria: ['s1', 's2'],
        tasks: [
          { title: 'first', description: 'do it', acceptanceCriteria: ['ac1'] },
          { title: 'second', description: 'more', dependencies: ['t1'] },
        ],
      })

      expect(plan).toMatchObject({
        runId: run.id,
        projectId,
        version: 1,
        pattern: 'supervisor',
        rationale: 'coordinate the work',
        status: 'draft',
        revision: 1,
      })
      expect(plan).not.toHaveProperty('replanReason')
      expect(plan).not.toHaveProperty('supersedesPlanId')
      expect(plan.id).toMatch(/^[0-9a-f-]{36}$/u)
      expect(plan.assumptions).toEqual(['a1', 'a2'])
      expect(plan.successCriteria).toEqual([{ id: 'c1', description: 's1' }, { id: 'c2', description: 's2' }])
      expect(plan.tasks.map(task => task.id)).toEqual(['t1', 't2'])
      expect(plan.tasks[1]).toMatchObject({ id: 't2', dependencies: ['t1'], acceptanceCriteria: [] })

      const events = [...storage.tables.get('run_events')!.entries()].map(([, record]) => record as { type: string; seq: number; runId: string })
      expect(events.map(event => [event.type, event.seq])).toEqual([
        ['run.created', 1],
        ['plan.created', 2],
      ])
      expect(events.every(event => event.runId === run.id)).toBe(true)
      expect(emit).toHaveBeenCalledWith('dsh-projects/plan/created', {
        runId: run.id,
        projectId,
        planId: plan.id,
        version: 1,
        pattern: 'supervisor',
        at: plan.createdAt,
      })
    } finally {
      await runService.stop()
    }
  })

  it('numbers replans from the newest version and records the supersession', async () => {
    const { planService, runService, projectId } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'replan' }, { mode: 'project', projectId })
      const first = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'first cut' })
      const second = await planService.createPlan({
        runId: run.id,
        pattern: 'direct',
        rationale: 'narrowed scope',
        replanReason: '  scope narrowed  ',
      })
      expect(second.version).toBe(2)
      expect(second.replanReason).toBe('scope narrowed')
      expect(second.supersedesPlanId).toBe(first.id)

      const list = planService.planList(run.id)
      expect(list.map(item => item.version)).toEqual([2, 1])
      expect(planService.planDetail(second.id)).toBe(second)
      let unknown: unknown
      try {
        planService.planDetail('99999999-9999-4999-8999-999999999999')
      } catch (error) {
        unknown = error
      }
      expect(unknown).toMatchObject({ dashboardCode: 'plan.unknown' })
    } finally {
      await runService.stop()
    }
  })

  it('requires a replan reason for every version after the first', async () => {
    const { planService, runService, projectId } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'reason' }, { mode: 'project', projectId })
      await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'one' })
      await expect(planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'two' }))
        .rejects.toMatchObject({ dashboardCode: 'plan.supersedeReasonMissing' })
      await expect(planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'two', replanReason: '   ' }))
        .rejects.toMatchObject({ dashboardCode: 'plan.supersedeReasonMissing' })
    } finally {
      await runService.stop()
    }
  })

  it('lists plans per run, newest first, bounded at 50', async () => {
    const { planService, runService, projectId } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'many' }, { mode: 'project', projectId })
      const other = await runService.createRun({ goal: 'other' }, { mode: 'project', projectId })
      for (let index = 1; index <= 51; index += 1) {
        await planService.createPlan({
          runId: run.id,
          pattern: 'direct',
          rationale: `v${index}`,
          ...(index > 1 ? { replanReason: 'next' } : {}),
        })
      }
      await planService.createPlan({ runId: other.id, pattern: 'direct', rationale: 'other v1' })

      const list = planService.planList(run.id)
      expect(list).toHaveLength(50)
      expect(list[0]).toMatchObject({ version: 51 })
      expect(list[49]).toMatchObject({ version: 2 })
      expect(planService.planList(other.id)).toHaveLength(1)
    } finally {
      await runService.stop()
    }
  })

  it('transitions with CAS, invalid edges, and unknown plans', async () => {
    const { planService, runService, projectId } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'cas' }, { mode: 'project', projectId })
      const plan = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'r' })

      const awaiting = await planService.transitionPlan(plan.id, 'awaiting-approval', { expectedRevision: 1 })
      expect(awaiting).toMatchObject({ status: 'awaiting-approval', revision: 1 })

      await expect(planService.transitionPlan(plan.id, 'active', { expectedRevision: 9 }))
        .rejects.toMatchObject({
          dashboardCode: 'plan.revisionConflict',
          params: { expectedRevision: 9, actualRevision: 1 },
        })

      await expect(planService.transitionPlan(plan.id, 'completed'))
        .rejects.toMatchObject({
          dashboardCode: 'plan.transitionInvalid',
          params: expect.objectContaining({ runId: run.id, from: 'awaiting-approval', to: 'completed' }),
        })

      await expect(planService.transitionPlan('99999999-9999-4999-8999-999999999999', 'active'))
        .rejects.toMatchObject({ dashboardCode: 'plan.unknown', params: { planId: '99999999-9999-4999-8999-999999999999' } })
    } finally {
      await runService.stop()
    }
  })

  it('activates a plan, coupling run.activePlanId, the approved event, and the emit', async () => {
    const { planService, runService, projectId, storage, emit } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'activate' }, { mode: 'project', projectId })
      const plan = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'r' })

      const active = await planService.transitionPlan(plan.id, 'active')
      expect(active).toMatchObject({ status: 'active', revision: 1 })

      const storedRun = storage.tables.get('runs')!.get(run.id) as { activePlanId?: string; version: number } | undefined
      expect(storedRun).toMatchObject({ activePlanId: plan.id, version: 2 })

      const events = [...storage.tables.get('run_events')!.entries()]
        .map(([, record]) => record as { type: string; seq: number })
      expect(events.map(event => [event.type, event.seq])).toEqual([
        ['run.created', 1],
        ['plan.created', 2],
        ['plan.approved', 3],
      ])
      expect(emit).toHaveBeenLastCalledWith('dsh-projects/plan/approved', expect.objectContaining({
        runId: run.id,
        planId: plan.id,
        from: 'draft',
        to: 'active',
      }))
    } finally {
      await runService.stop()
    }
  })

  it('supersedes the prior active plan when a newer plan activates, emitting run.replanned', async () => {
    const { planService, runService, projectId, storage, emit } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'replanned' }, { mode: 'project', projectId })
      const v1 = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'one' })
      await planService.transitionPlan(v1.id, 'active')
      const v2 = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'two', replanReason: 'pivot' })
      await planService.transitionPlan(v2.id, 'active')

      expect(planService.planDetail(v1.id)).toMatchObject({ status: 'superseded', replanReason: 'pivot' })
      const storedRun = storage.tables.get('runs')!.get(run.id) as { activePlanId?: string; version: number } | undefined
      expect(storedRun).toMatchObject({ activePlanId: v2.id, version: 3 })

      const events = [...storage.tables.get('run_events')!.entries()]
        .map(([, record]) => record as { type: string; title: string; detail?: string })
      const types = events.map(event => event.type)
      expect(types).toEqual(['run.created', 'plan.created', 'plan.approved', 'plan.created', 'plan.superseded', 'plan.approved', 'run.replanned'])
      const replanned = events.find(event => event.type === 'run.replanned')
      expect(replanned).toMatchObject({ title: 'Run replanned', detail: 'Plan v1 → v2' })
      expect(emit).toHaveBeenCalledWith('dsh-projects/run/replanned', expect.objectContaining({ runId: run.id, planId: v2.id }))
    } finally {
      await runService.stop()
    }
  })

  it('clears run.activePlanId when the active plan is superseded directly', async () => {
    const { planService, runService, projectId, storage } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'clear' }, { mode: 'project', projectId })
      const plan = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'r' })
      await planService.transitionPlan(plan.id, 'active')

      const superseded = await planService.transitionPlan(plan.id, 'superseded', { replanReason: 'manual stop' })
      expect(superseded).toMatchObject({ status: 'superseded', revision: 2, replanReason: 'manual stop' })

      const storedRun = storage.tables.get('runs')!.get(run.id) as Record<string, unknown> | undefined
      expect(storedRun).toBeDefined()
      expect(storedRun).not.toHaveProperty('activePlanId')

      const events = [...storage.tables.get('run_events')!.entries()]
        .map(([, record]) => record as { type: string })
      expect(events.map(event => event.type)).toEqual(['run.created', 'plan.created', 'plan.approved', 'plan.superseded'])
    } finally {
      await runService.stop()
    }
  })

  it('records approval request, rejection, and completion with their events', async () => {
    const { planService, runService, projectId, storage } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'lifecycle' }, { mode: 'project', projectId })
      const plan = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'r' })

      await planService.transitionPlan(plan.id, 'awaiting-approval')
      await planService.transitionPlan(plan.id, 'draft')
      await planService.transitionPlan(plan.id, 'active')
      const completed = await planService.transitionPlan(plan.id, 'completed')
      expect(completed).toMatchObject({ status: 'completed', revision: 2 })

      const events = [...storage.tables.get('run_events')!.entries()]
        .map(([, record]) => record as { type: string })
      expect(events.map(event => event.type)).toEqual([
        'run.created',
        'plan.created',
        'plan.approval.requested',
        'plan.rejected',
        'plan.approved',
        'plan.completed',
      ])

      await expect(planService.transitionPlan(plan.id, 'superseded', { replanReason: 'x' }))
        .rejects.toMatchObject({ dashboardCode: 'plan.transitionInvalid' })
    } finally {
      await runService.stop()
    }
  })

  it('refuses to activate a plan whose run is already terminal', async () => {
    const { planService, runService, projectId } = await fixture()
    try {
      const run = await runService.createRun({ goal: 'terminal' }, { mode: 'project', projectId })
      const plan = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'r' })
      await runService.transitionRun(run.id, 'canceled')
      await expect(planService.transitionPlan(plan.id, 'active'))
        .rejects.toMatchObject({ dashboardCode: 'plan.runTerminal', params: expect.objectContaining({ runId: run.id, phase: 'canceled' }) })
      // Draft moves that do not activate the run coupling are still allowed.
      const awaiting = await planService.transitionPlan(plan.id, 'awaiting-approval')
      expect(awaiting.status).toBe('awaiting-approval')
    } finally {
      await runService.stop()
    }
  })

  it('persists plans and the run coupling across a restart on the same storage', async () => {
    const base = await fixture()
    const run = await base.runService.createRun({ goal: 'survive' }, { mode: 'project', projectId: base.projectId })
    const plan = await base.planService.createPlan({ runId: run.id, pattern: 'supervisor', rationale: 'r', tasks: [{ title: 't', description: 'd' }] })
    await base.planService.transitionPlan(plan.id, 'active')
    const stopped = await restart(base)

    const { runService, planService } = await bootAgain(stopped)
    try {
      const list = planService.planList(run.id)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id: plan.id, status: 'active', version: 1, revision: 1 })

      const summary = await runService.listForSnapshot({ mode: 'project', projectId: base.projectId })
      expect(summary.runs[0]).toMatchObject({ id: run.id, activePlanId: plan.id })

      const detail = await runService.runDetail(run.id)
      expect(detail.events.map(event => event.type)).toEqual(['plan.approved', 'plan.created', 'run.created'])
      expect(detail.truncated).toBe(false)

      // The re-opened service keeps working: a new version can be planned.
      const next = await planService.createPlan({ runId: run.id, pattern: 'direct', rationale: 'again', replanReason: 'restarted' })
      expect(next.version).toBe(2)
      expect(next.supersedesPlanId).toBe(plan.id)
    } finally {
      planService.stop()
      await runService.stop()
    }
  })
})

function localWorkflow(): string {
  return `---
version: 1
project:
  name: Plan Host
  agent_profile: default
tracker:
  kind: local
  provider:
    project_id: plan-host
    context_label: Plans
  required_labels: []
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled]
policy: {}
---

Work on {{ issue.identifier }}: {{ issue.title }}.
`
}
