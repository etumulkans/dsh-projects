/** DSH Projects Phase 9 — trigger fire path tests (spec §10.2). */

import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectRunEventRecord, ProjectRunRecord } from '../src/runs/types.ts'
import { ProjectTriggerService } from '../src/triggers/trigger-service.ts'
import { DashboardDomainError } from '../src/runtime/errors.ts'
import type { TaskSourceRegistry } from '../src/task-source/index.ts'

const PROJECT_ID = 'proj-trigger-fire'
const PROJECT_ROOT = '/tmp/dsh-trigger-fire-proj'

type Fixture = {
  readonly ctx: Context
  readonly catalog: ProjectCatalog
  readonly runService: ProjectRunService
  readonly service: ProjectTriggerService
  readonly storage: MemoryStorage
  readonly projectId: string
}

const temporaryHandlers: Array<() => void> = []

afterEach(() => {
  for (const dispose of temporaryHandlers.splice(0)) dispose()
})

async function fixture(): Promise<Fixture> {
  const storage = new MemoryStorage()
  const emit = vi.fn()
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on(event: string, handler: (event: unknown) => void): () => void {
      let set = handlers.get(event)
      if (set === undefined) {
        set = new Set()
        handlers.set(event, set)
      }
      set.add(handler)
      const dispose = () => { set.delete(handler) }
      temporaryHandlers.push(dispose)
      return dispose
    },
    emit(event: string, payload: unknown) {
      emit(event, payload)
      const set = handlers.get(event)
      if (set !== undefined) for (const handler of [...set]) handler(payload)
    },
    storageDomain: { open: vi.fn(async () => storage.open()) },
  } as unknown as Context
  const catalog = {
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Fire Project', root: PROJECT_ROOT } : undefined,
  } as unknown as ProjectCatalog
  const runService = new ProjectRunService(ctx, catalog)
  await runService.start()
  const sources = { requireScoped: () => { throw new Error('no scoped source in this fixture') } } as unknown as TaskSourceRegistry
  const service = new ProjectTriggerService(ctx, catalog, runService, sources, () => '2026-09-10T00:00:00.000Z')
  service.start()
  return { ctx, catalog, runService, service, storage, projectId: PROJECT_ID }
}

function runsFor(f: Fixture): ProjectRunRecord[] {
  const rows: ProjectRunRecord[] = []
  for (const [, record] of f.storage.tables.get('runs')!.entries()) rows.push(record as ProjectRunRecord)
  return rows
}

function eventsFor(f: Fixture, runId: string): ProjectRunEventRecord[] {
  const rows: ProjectRunEventRecord[] = []
  for (const [, record] of f.storage.tables.get('run_events')!.entries()) rows.push(record as ProjectRunEventRecord)
  return rows.filter(record => record.runId === runId)
}

describe('trigger fire — the fire (spec §10.2)', () => {
  it('a tracker event fires a run (rendered goal, mapped source, approvalMode, trigger.fired event, lastFiredAt/lastRunId)', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'tracker',
      config: { sourceKind: 'linear', readyStates: ['ready'] },
      goalTemplate: 'Fix {{issue.key}}: {{issue.title}}',
      approvalMode: 'plan',
    })
    const run = await f.service.fire(trigger.id, {
      sourceEventKey: 'linear:LI-42:ready',
      data: { 'issue.key': 'LI-42', 'issue.title': 'Broken build', 'issue.state': 'ready', 'issue.url': '' },
    })
    expect(run).toBeDefined()
    expect(run!.goal).toBe('Fix LI-42: Broken build')
    expect(run!.source).toBe('tracker')
    expect(run!.sourceRef).toBe(trigger.id)
    expect(run!.approvalMode).toBe('plan')
    // The trigger.fired run event was appended to the created run.
    const fired = eventsFor(f, run!.id).filter(event => event.type === 'trigger.fired')
    expect(fired).toHaveLength(1)
    // The trigger's lastFiredAt/lastRunId were set.
    const updated = f.service.get(trigger.id)!
    expect(updated.lastFiredAt).toBe('2026-09-10T00:00:00.000Z')
    expect(updated.lastRunId).toBe(run!.id)
    // The dedupe record was persisted.
    expect(f.storage.tables.get('trigger_fires')!.get(`${trigger.id}:linear:LI-42:ready`)).toBeDefined()
  })

  it('an absent {{placeholder}} renders as the empty string', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'system',
      config: { event: 'e' },
      goalTemplate: 'Handle {{missing.key}} now',
    })
    const run = await f.service.fire(trigger.id, { sourceEventKey: 'k1', data: {} })
    expect(run!.goal).toBe('Handle  now')
  })
})

describe('trigger fire — idempotency (spec §10.2, the core guarantee)', () => {
  it('the same (triggerId, sourceEventKey) fires once — a duplicate is a no-op', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'tracker',
      config: { sourceKind: 'linear', readyStates: ['ready'] },
      goalTemplate: 'Fix {{issue.key}}',
    })
    const event = { sourceEventKey: 'linear:LI-1:ready', data: { 'issue.key': 'LI-1' } }
    const first = await f.service.fire(trigger.id, event)
    const firstFiredAt = f.service.get(trigger.id)!.lastFiredAt
    expect(first).toBeDefined()
    expect(runsFor(f)).toHaveLength(1)

    // The duplicate event returns the existing run (no second run, no second event).
    const second = await f.service.fire(trigger.id, event)
    expect(second!.id).toBe(first!.id)
    expect(runsFor(f)).toHaveLength(1)
    expect(eventsFor(f, first!.id).filter(e => e.type === 'trigger.fired')).toHaveLength(1)
    // lastFiredAt is unchanged.
    expect(f.service.get(trigger.id)!.lastFiredAt).toBe(firstFiredAt)
  })

  it('a process restart does not re-fire (the trigger_fires record survives a reopen)', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'tracker',
      config: { sourceKind: 'linear', readyStates: ['ready'] },
      goalTemplate: 'Fix {{issue.key}}',
    })
    const event = { sourceEventKey: 'linear:LI-9:ready', data: { 'issue.key': 'LI-9' } }
    const first = await f.service.fire(trigger.id, event)
    expect(first).toBeDefined()
    expect(runsFor(f)).toHaveLength(1)

    // Simulate a process restart: a fresh service instance over the same storage
    // (the trigger_fires + runs + project_triggers tables all survive).
    f.service.stop()
    const restarted = new ProjectTriggerService(f.ctx, f.catalog, f.runService, { requireScoped: () => { throw new Error('x') } } as unknown as TaskSourceRegistry, () => '2026-09-10T01:00:00.000Z')
    restarted.start()
    const again = await restarted.fire(trigger.id, event)
    expect(again!.id).toBe(first!.id)
    expect(runsFor(f)).toHaveLength(1)
    // The dedupe record is intact (the restart did not create a new one).
    expect(f.storage.tables.get('trigger_fires')!.size).toBe(1)
  })
})

describe('trigger fire — disabled (spec §10.2)', () => {
  it('a disabled trigger fire is a no-op (undefined, no run, no event)', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'system',
      config: { event: 'e' },
      goalTemplate: 'g',
    })
    await f.service.setEnabled(trigger.id, false)
    const result = await f.service.fire(trigger.id, { sourceEventKey: 'k', data: {} })
    expect(result).toBeUndefined()
    expect(runsFor(f)).toHaveLength(0)
    expect(f.storage.tables.get('trigger_fires')!.size).toBe(0)
  })
})

describe('trigger fire — goal render bounds (spec §10.2)', () => {
  it('an all-placeholder template with no data → trigger.goalEmpty', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'system',
      config: { event: 'e' },
      goalTemplate: '{{only.placeholder}}',
    })
    await expect(f.service.fire(trigger.id, { sourceEventKey: 'k', data: {} }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.goalEmpty' })
    expect(runsFor(f)).toHaveLength(0)
  })

  it('a render longer than MAX_GOAL_LENGTH → trigger.goalTooLong', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'system',
      config: { event: 'e' },
      goalTemplate: '{{big}}',
    })
    const huge = 'x'.repeat(4_001)
    await expect(f.service.fire(trigger.id, { sourceEventKey: 'k', data: { big: huge } }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.goalTooLong' })
    expect(runsFor(f)).toHaveLength(0)
  })
})

describe('trigger fire — failure (spec §10.2)', () => {
  it('a fire where the run create throws → warn log + no fire record + no run', async () => {
    const f = await fixture()
    // A trigger whose project is unknown to the run service (createRun throws).
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'system',
      config: { event: 'e' },
      goalTemplate: 'g',
    })
    // Force createRun to throw (an unknown project selection).
    const original = f.runService.createRun.bind(f.runService)
    vi.spyOn(f.runService, 'createRun').mockRejectedValueOnce(new DashboardDomainError('run.projectUnknown', 'unknown project', {}))
    await expect(f.service.fire(trigger.id, { sourceEventKey: 'k', data: {} }))
      .rejects.toMatchObject({ dashboardCode: 'run.projectUnknown' })
    // No fire record, no run, the trigger is unchanged.
    expect(f.storage.tables.get('trigger_fires')!.size).toBe(0)
    expect(runsFor(f)).toHaveLength(0)
    expect(f.service.get(trigger.id)!.lastRunId).toBeUndefined()
    vi.restoreAllMocks()
    void original
  })
})

describe('trigger fire — manual (Run now) (spec §10.2)', () => {
  it('a triggerFire without an event creates a new run each call (non-idempotent)', async () => {
    const f = await fixture()
    const trigger = await f.service.create({
      projectId: f.projectId,
      type: 'system',
      config: { event: 'e' },
      goalTemplate: 'Run now',
    })
    // The handler synthesizes a `manual:<uuid>` event when none is provided —
    // each call has a distinct sourceEventKey, so each fires a new run.
    const first = await f.service.fire(trigger.id, { sourceEventKey: `manual:${crypto.randomUUID()}`, data: {} })
    const second = await f.service.fire(trigger.id, { sourceEventKey: `manual:${crypto.randomUUID()}`, data: {} })
    expect(first!.id).not.toBe(second!.id)
    expect(runsFor(f)).toHaveLength(2)
  })
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
