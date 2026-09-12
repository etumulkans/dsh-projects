import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dashboardCatalogDomainSpec } from '../src/catalog/spec.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

async function catalogFixture(): Promise<{
  context: Context
  catalog: ProjectCatalog
  projectId: string
  storage: MemoryStorage
  emit: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-runs-'))
  temporaryDirectories.push(root)
  const projectRoot = join(root, 'proj')
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, 'WORKFLOW.md'), localWorkflow())

  const { context, storage, emit } = memoryContext()
  const catalog = new ProjectCatalog(context, {
    currentProject: { root: projectRoot, policyPath: 'WORKFLOW.md', registerInCatalog: true },
    discoveryRoots: [],
  }, root)
  await catalog.start()
  const project = catalog.activeProject()!
  return { context, catalog, projectId: project.id, storage, emit }
}

function memoryContext(): { context: Context; storage: MemoryStorage; emit: ReturnType<typeof vi.fn> } {
  const storage = new MemoryStorage()
  const emit = vi.fn()
  const context = {
    logger: { info: vi.fn(), warn: vi.fn() },
    emit,
    storageDomain: { open: vi.fn(async () => storage.open()) },
  } as unknown as Context
  return { context, storage, emit }
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

describe('ProjectRunService', () => {
  it('rejects calls before start with run.notStarted', async () => {
    const { context, catalog } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await expect(service.createRun({ goal: 'x' }, { mode: 'global' })).rejects.toMatchObject({ dashboardCode: 'run.notStarted' })
    await expect(service.listForSnapshot({ mode: 'global' })).rejects.toMatchObject({ dashboardCode: 'run.notStarted' })
  })

  it('rejects double start', async () => {
    const { context, catalog } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    await expect(service.start()).rejects.toThrow('already started')
    await service.stop()
  })

  it('validates goal and project on create', async () => {
    const { context, catalog, projectId } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    try {
      await expect(service.createRun({ goal: '   ' }, { mode: 'project', projectId })).rejects.toMatchObject({
        dashboardCode: 'run.goalEmpty',
      })
      await expect(service.createRun({ goal: 'x'.repeat(4_001) }, { mode: 'project', projectId })).rejects.toMatchObject({
        dashboardCode: 'run.goalTooLong',
        params: { maxLength: 4_000 },
      })
      await expect(service.createRun({ goal: 'no project' }, { mode: 'global' })).rejects.toMatchObject({
        dashboardCode: 'run.projectRequired',
      })
      await expect(service.createRun({ goal: 'unknown project', projectId: 'nope' }, { mode: 'global' })).rejects.toMatchObject({
        dashboardCode: 'run.projectUnknown',
        params: { projectId: 'nope' },
      })
    } finally {
      await service.stop()
    }
  })

  it('creates a persisted created-phase run with its first event', async () => {
    const { context, catalog, projectId, storage, emit } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    try {
      const record = await service.createRun({ goal: 'Ship the slice', sourceRef: 'JIRA-9' }, { mode: 'project', projectId })
      expect(record).toMatchObject({
        projectId,
        goal: 'Ship the slice',
        source: 'manual',
        sourceRef: 'JIRA-9',
        phase: 'created',
        version: 1,
      })
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/u)

      const events = [...storage.tables.get('run_events')!.entries()]
      expect(events).toHaveLength(1)
      expect(events[0]![1]).toMatchObject({ runId: record.id, projectId, type: 'run.created', seq: 1 })

      expect(emit).toHaveBeenCalledWith('dsh-projects/run/created', {
        runId: record.id,
        projectId,
        goal: 'Ship the slice',
        source: 'manual',
        at: record.createdAt,
      })
    } finally {
      await service.stop()
    }
  })

  it('lists runs newest first with per-selection bounds', async () => {
    const { context, catalog, projectId } = await catalogFixture()
    let clock = 0
    const service = new ProjectRunService(context, catalog, () => new Date(Date.UTC(2026, 7, 14, 2, 0, clock++)).toISOString())
    await service.start()
    try {
      await service.createRun({ goal: 'first' }, { mode: 'project', projectId })
      const second = await service.createRun({ goal: 'second' }, { mode: 'project', projectId })
      const third = await service.createRun({ goal: 'third' }, { mode: 'project', projectId })

      const summary = await service.listForSnapshot({ mode: 'project', projectId })
      expect(summary.projectId).toBe(projectId)
      expect(summary.total).toBe(3)
      expect(summary.runs.map(run => run.goal)).toEqual(['third', 'second', 'first'])
      expect(summary.runs.every(run => run.projectName === undefined)).toBe(true)

      const global = await service.listForSnapshot({ mode: 'global' })
      expect(global.projectId).toBeUndefined()
      expect(global.total).toBe(3)
      expect(global.runs.every(run => run.projectName !== undefined)).toBe(true)
      expect(global.runs[0]!.id).toBe(third.id)
    } finally {
      await service.stop()
    }
  })

  it('returns run detail with newest-first events and truncation', async () => {
    const { context, catalog, projectId } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    try {
      const record = await service.createRun({ goal: 'detail me' }, { mode: 'project', projectId })
      await service.transitionRun(record.id, 'planning')
      await service.transitionRun(record.id, 'executing')

      const detail = await service.runDetail(record.id)
      expect(detail.run.id).toBe(record.id)
      expect(detail.run.version).toBe(3)
      expect(detail.events.map(event => event.type)).toEqual(['run.phase.changed', 'run.phase.changed', 'run.created'])
      expect(detail.events.map(event => event.seq)).toEqual([3, 2, 1])
      expect(detail.events[0]!.detail).toBe('planning → executing')
      expect(detail.truncated).toBe(false)

      await expect(service.runDetail('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
        dashboardCode: 'run.unknown',
      })
    } finally {
      await service.stop()
    }
  })

  it('applies valid transitions with CAS and event ordering', async () => {
    const { context, catalog, projectId, emit } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    try {
      const record = await service.createRun({ goal: 'transition' }, { mode: 'project', projectId })
      const planning = await service.transitionRun(record.id, 'planning', { expectedVersion: 1 })
      expect(planning).toMatchObject({ phase: 'planning', version: 2 })
      expect(emit).toHaveBeenLastCalledWith('dsh-projects/run/phase-changed', {
        runId: record.id,
        projectId,
        from: 'created',
        to: 'planning',
        at: planning.updatedAt,
      })

      const executing = await service.transitionRun(record.id, 'executing')
      expect(executing.startedAt).toBeDefined()

      const paused = await service.transitionRun(record.id, 'paused')
      expect(paused.suspendedFrom).toBe('executing')
      const resumed = await service.transitionRun(record.id, 'executing')
      expect(resumed.suspendedFrom).toBeUndefined()

      const done = await service.transitionRun(record.id, 'finalizing')
      await service.transitionRun(done.id, 'succeeded', { resultSummary: 'all good' })
      expect(emit).toHaveBeenLastCalledWith(
        'dsh-projects/run/completed',
        expect.objectContaining({ runId: record.id, phase: 'succeeded' }),
      )

      await expect(service.transitionRun(record.id, 'planning')).rejects.toMatchObject({
        dashboardCode: 'run.transitionInvalid',
        params: expect.objectContaining({ from: 'succeeded', to: 'planning' }),
      })
    } finally {
      await service.stop()
    }
  })

  it('rejects stale versions and unknown runs', async () => {
    const { context, catalog, projectId } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    try {
      const record = await service.createRun({ goal: 'cas' }, { mode: 'project', projectId })
      await service.transitionRun(record.id, 'planning')
      await expect(service.transitionRun(record.id, 'executing', { expectedVersion: 1 })).rejects.toMatchObject({
        dashboardCode: 'run.versionConflict',
        params: expect.objectContaining({ expectedVersion: 1, actualVersion: 2 }),
      })
      await expect(service.transitionRun('00000000-0000-4000-8000-000000000000', 'planning')).rejects.toMatchObject({
        dashboardCode: 'run.unknown',
      })
      await expect(service.transitionRun(record.id, 'created')).rejects.toMatchObject({
        dashboardCode: 'run.transitionInvalid',
      })
    } finally {
      await service.stop()
    }
  })

  it('persists runs and events across a restart on the same storage', async () => {
    const { context, catalog, projectId } = await catalogFixture()
    const first = new ProjectRunService(context, catalog)
    await first.start()
    const record = await first.createRun({ goal: 'survive restart' }, { mode: 'project', projectId })
    await first.transitionRun(record.id, 'planning')
    await first.transitionRun(record.id, 'paused')
    await first.stop()

    const second = new ProjectRunService(context, catalog)
    await second.start()
    try {
      const summary = await second.listForSnapshot({ mode: 'project', projectId })
      expect(summary.total).toBe(1)
      expect(summary.runs[0]).toMatchObject({ id: record.id, goal: 'survive restart', phase: 'paused', suspendedFrom: 'planning', version: 3 })

      const detail = await second.runDetail(record.id)
      expect(detail.events.map(event => event.type)).toEqual(['run.phase.changed', 'run.phase.changed', 'run.created'])
      expect(detail.truncated).toBe(false)

      const resumed = await second.transitionRun(record.id, 'planning')
      expect(resumed.phase).toBe('planning')
      expect(resumed.version).toBe(4)
    } finally {
      await second.stop()
    }
  })

  it('scopes events per run when multiple runs exist', async () => {
    const { context, catalog, projectId } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    try {
      const alpha = await service.createRun({ goal: 'alpha' }, { mode: 'project', projectId })
      const beta = await service.createRun({ goal: 'beta' }, { mode: 'project', projectId })
      await service.transitionRun(alpha.id, 'planning')
      await service.transitionRun(beta.id, 'canceled')

      const alphaDetail = await service.runDetail(alpha.id)
      expect(alphaDetail.events.map(event => event.type)).toEqual(['run.phase.changed', 'run.created'])
      expect(alphaDetail.events[0]!.seq).toBe(2)

      const betaDetail = await service.runDetail(beta.id)
      expect(betaDetail.events.map(event => event.type)).toEqual(['run.completed', 'run.created'])
      expect(betaDetail.events[0]!.detail).toBe('Run canceled')
    } finally {
      await service.stop()
    }
  })

  it('stop is idempotent and releases the tables', async () => {
    const { context, catalog } = await catalogFixture()
    const service = new ProjectRunService(context, catalog)
    await service.start()
    await service.stop()
    await expect(service.stop()).resolves.toBeUndefined()
    await expect(service.listForSnapshot({ mode: 'global' })).rejects.toMatchObject({ dashboardCode: 'run.notStarted' })
  })
})

function localWorkflow(): string {
  return `---
version: 1
project:
  name: Run Host
  agent_profile: default
tracker:
  kind: local
  provider:
    project_id: run-host
    context_label: Runs
  required_labels: []
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled]
policy: {}
---

Work on {{ issue.identifier }}: {{ issue.title }}.
`
}
