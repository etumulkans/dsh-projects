/** DSH Projects Phase 9 — trigger service tests (spec §10.1). */

import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectRunEventRecord } from '../src/runs/types.ts'
import { ProjectTriggerService, validateTrigger } from '../src/triggers/trigger-service.ts'
import { MAX_GOAL_TEMPLATE_LENGTH } from '../src/triggers/spec.ts'
import { TRIGGER_TYPES, type ProjectTriggerRecord, type TriggerType } from '../src/triggers/types.ts'
import { DashboardDomainError } from '../src/runtime/errors.ts'
import type { TaskSourceRegistry } from '../src/task-source/index.ts'

const PROJECT_ID = 'proj-triggers'
const PROJECT_ROOT = '/tmp/dsh-triggers-proj'

type Fixture = {
  readonly ctx: Context
  readonly catalog: ProjectCatalog
  readonly runService: ProjectRunService
  readonly service: ProjectTriggerService
  readonly storage: MemoryStorage
  readonly projectId: string
  readonly emit: ReturnType<typeof vi.fn>
}

const temporaryHandlers: Array<() => void> = []

afterEach(() => {
  for (const dispose of temporaryHandlers.splice(0)) dispose()
})

async function fixture(started = true): Promise<Fixture> {
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
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Triggers Project', root: PROJECT_ROOT } : undefined,
  } as unknown as ProjectCatalog
  const runService = new ProjectRunService(ctx, catalog)
  await runService.start()
  // The service holds the unscoped registry; CRUD + fire never touch it (only
  // pollDueTriggers does), so a stub is enough here.
  const sources = { requireScoped: () => { throw new Error('no scoped source in this fixture') } } as unknown as TaskSourceRegistry
  const service = new ProjectTriggerService(ctx, catalog, runService, sources, () => '2026-09-10T00:00:00.000Z')
  if (started) service.start()
  return { ctx, catalog, runService, service, storage, projectId: PROJECT_ID, emit }
}

function eventsFor(f: Fixture, runId: string): ProjectRunEventRecord[] {
  const rows: ProjectRunEventRecord[] = []
  for (const [, record] of f.storage.tables.get('run_events')!.entries()) rows.push(record as ProjectRunEventRecord)
  return rows.filter(record => record.runId === runId)
}

describe('trigger service — store (spec §10.1)', () => {
  it('create persists the record + the trigger.created Cordis event', async () => {
    const f = await fixture()
    const record = await f.service.create({
      projectId: f.projectId,
      type: 'schedule',
      config: { everyMs: 3_600_000 },
      goalTemplate: 'Nightly maintenance',
    })
    expect(record.id).toBeTruthy()
    expect(record.projectId).toBe(f.projectId)
    expect(record.type).toBe('schedule')
    expect(record.enabled).toBe(true)
    expect(record.config).toEqual({ everyMs: 3_600_000 })
    expect(record.goalTemplate).toBe('Nightly maintenance')
    expect(record.createdAt).toBe('2026-09-10T00:00:00.000Z')
    expect(record.updatedAt).toBe('2026-09-10T00:00:00.000Z')
    expect(f.storage.tables.get('project_triggers')!.get(record.id)).toEqual(record)
    expect(f.storage.tables.get('project_triggers')!.size).toBe(1)
    // The Cordis event was emitted (persisted first, then the event).
    expect(f.emit).toHaveBeenCalledWith('dsh-projects/trigger/created', { id: record.id, projectId: f.projectId, type: 'schedule' })
  })

  it('all six persistable types validate (manual is the exception)', async () => {
    const f = await fixture()
    const configs: Record<Exclude<TriggerType, 'manual'>, Record<string, unknown>> = {
      tracker: { sourceKind: 'linear', readyStates: ['ready'] },
      schedule: { everyMs: 1000 },
      webhook: { path: '/hooks/x', secretRef: 'ref-name' },
      'repository-event': { event: 'repo.push' },
      'pr-event': { event: 'pr.opened' },
      system: { event: 'dsh-projects/run/completed' },
    }
    for (const type of TRIGGER_TYPES) {
      if (type === 'manual') {
        await expect(f.service.create({ projectId: f.projectId, type, config: {}, goalTemplate: 'x' }))
          .rejects.toMatchObject({ dashboardCode: 'trigger.manualReserved' })
        continue
      }
      const record = await f.service.create({ projectId: f.projectId, type, config: configs[type], goalTemplate: 'goal' })
      expect(record.type).toBe(type)
    }
  })

  it('rejects a manual create with trigger.manualReserved', async () => {
    const f = await fixture()
    await expect(f.service.create({ projectId: f.projectId, type: 'manual', config: {}, goalTemplate: 'x' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.manualReserved' })
    expect(f.storage.tables.get('project_triggers')!.size).toBe(0)
  })

  it('enforces the goalTemplate bounds (1..500)', async () => {
    const f = await fixture()
    // Empty (whitespace-only) is rejected.
    await expect(f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: '   ' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { reason: 'empty-goal-template' } })
    // Over the bound is rejected.
    const tooLong = 'x'.repeat(MAX_GOAL_TEMPLATE_LENGTH + 1)
    await expect(f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: tooLong }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { reason: 'goal-template-too-long' } })
    // Exactly the bound is allowed.
    const atBound = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'x'.repeat(MAX_GOAL_TEMPLATE_LENGTH) })
    expect(atBound.goalTemplate).toHaveLength(MAX_GOAL_TEMPLATE_LENGTH)
  })

  it('validates the per-type config (right keys; exactly-one-of for schedule)', async () => {
    const f = await fixture()
    // tracker: needs a valid sourceKind + a non-empty readyStates.
    await expect(f.service.create({ projectId: f.projectId, type: 'tracker', config: { sourceKind: 'nope', readyStates: ['ready'] }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { field: 'sourceKind' } })
    await expect(f.service.create({ projectId: f.projectId, type: 'tracker', config: { sourceKind: 'linear', readyStates: [] }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { field: 'readyStates' } })
    // schedule: exactly one of everyMs / cron.
    await expect(f.service.create({ projectId: f.projectId, type: 'schedule', config: {}, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate' })
    await expect(f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000, cron: '* * * * *' }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate' })
    await expect(f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 100 }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate' })
    // webhook: needs path + secretRef (a ref, never a value).
    await expect(f.service.create({ projectId: f.projectId, type: 'webhook', config: { path: '/x' }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { field: 'secretRef' } })
    // system: needs a non-empty event.
    await expect(f.service.create({ projectId: f.projectId, type: 'system', config: { event: '' }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { field: 'event' } })
  })

  it('validates the approvalMode and scopes to the project', async () => {
    const f = await fixture()
    await expect(f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'g', approvalMode: 'nope' as never }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { field: 'approvalMode' } })
    const withMode = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'g', approvalMode: 'plan' })
    expect(withMode.approvalMode).toBe('plan')
    // Unknown project is rejected.
    await expect(f.service.create({ projectId: 'unknown', type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.badRequest' })
  })

  it('rejects a config/goalTemplate containing what looks like a secret; a webhook secretRef is allowed', async () => {
    const f = await fixture()
    // A goalTemplate that looks like a secret.
    await expect(f.service.create({
      projectId: f.projectId,
      type: 'schedule',
      config: { everyMs: 1000 },
      goalTemplate: 'run with api_key: supersecretvalue123',
    })).rejects.toMatchObject({ dashboardCode: 'trigger.containsSecrets' })
    // A config value that looks like a secret.
    await expect(f.service.create({
      projectId: f.projectId,
      type: 'system',
      config: { event: 'x', token: 'AKIAABCDEFGHIJKLMNOP' },
      goalTemplate: 'g',
    })).rejects.toMatchObject({ dashboardCode: 'trigger.containsSecrets' })
    // A webhook secretRef is a ref (allowed) — it does not match a secret pattern.
    const ok = await f.service.create({
      projectId: f.projectId,
      type: 'webhook',
      config: { path: '/hooks/deploys', secretRef: 'deploy-signing-key' },
      goalTemplate: 'Deploy {{webhook.id}}',
    })
    expect(ok.config).toEqual({ path: '/hooks/deploys', secretRef: 'deploy-signing-key' })
  })
})

describe('trigger service — CRUD (spec §10.1)', () => {
  it('list returns the project triggers newest-first', async () => {
    const f = await fixture()
    const a = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'a' })
    const b = await f.service.create({ projectId: f.projectId, type: 'system', config: { event: 'e' }, goalTemplate: 'b' })
    const listed = f.service.list(f.projectId)
    expect(listed.map(record => record.id)).toEqual([b.id, a.id])
    // A different project sees nothing.
    expect(f.service.list('other')).toEqual([])
  })

  it('get returns the record or undefined', async () => {
    const f = await fixture()
    const record = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'g' })
    expect(f.service.get(record.id)).toEqual(record)
    expect(f.service.get('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })

  it('update re-validates the patched config + bumps updatedAt', async () => {
    const f = await fixture()
    const record = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'old' })
    const updated = await f.service.update(record.id, { goalTemplate: 'new goal' })
    expect(updated.goalTemplate).toBe('new goal')
    expect(updated.config).toEqual({ everyMs: 1000 })
    expect(updated.updatedAt).toBe('2026-09-10T00:00:00.000Z')
    // An invalid patch is rejected (re-validated against the existing type).
    await expect(f.service.update(record.id, { config: {} })).rejects.toMatchObject({ dashboardCode: 'trigger.invalidCandidate' })
    // Unknown id.
    await expect(f.service.update('00000000-0000-4000-8000-000000000000', { goalTemplate: 'x' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.unknown' })
  })

  it('setEnabled flips the enabled flag + bumps updatedAt', async () => {
    const f = await fixture()
    const record = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'g' })
    expect(record.enabled).toBe(true)
    const disabled = await f.service.setEnabled(record.id, false)
    expect(disabled.enabled).toBe(false)
    expect(f.service.get(record.id)!.enabled).toBe(false)
    const enabled = await f.service.setEnabled(record.id, true)
    expect(enabled.enabled).toBe(true)
    await expect(f.service.setEnabled('00000000-0000-4000-8000-000000000000', true))
      .rejects.toMatchObject({ dashboardCode: 'trigger.unknown' })
  })

  it('delete removes the trigger row but keeps the trigger_fires rows', async () => {
    const f = await fixture()
    const record = await f.service.create({ projectId: f.projectId, type: 'system', config: { event: 'e' }, goalTemplate: 'g' })
    // Seed a fire record (the dedupe row) that must survive the delete.
    const run = await f.runService.createRun({ goal: 'g' }, { mode: 'project', projectId: f.projectId })
    await f.storage.tables.get('trigger_fires')!.put(`${record.id}:evt-1`, {
      id: `${record.id}:evt-1`,
      triggerId: record.id,
      sourceEventKey: 'evt-1',
      runId: run.id,
      firedAt: '2026-09-10T00:00:00.000Z',
    })
    await f.service.delete(record.id)
    expect(f.service.get(record.id)).toBeUndefined()
    expect(f.storage.tables.get('project_triggers')!.size).toBe(0)
    // The fire record is kept (the provenance of created runs).
    expect(f.storage.tables.get('trigger_fires')!.get(`${record.id}:evt-1`)).toBeDefined()
    await expect(f.service.delete('00000000-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ dashboardCode: 'trigger.unknown' })
  })
})

describe('trigger service — absent (spec §10.1)', () => {
  it('the service-not-started path throws trigger.notStarted', async () => {
    const f = await fixture(false)
    expect(() => f.service.list(f.projectId)).toThrow(DashboardDomainError)
    await expect(f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 1000 }, goalTemplate: 'g' }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.notStarted' })
    await expect(f.service.fire('00000000-0000-4000-8000-000000000000', { sourceEventKey: 'k', data: {} }))
      .rejects.toMatchObject({ dashboardCode: 'trigger.notStarted' })
  })
})

describe('trigger service — Phase 11 projection (spec §5.4)', () => {
  it('listProjected computes nextRunAt for an enabled schedule trigger (everyMs)', async () => {
    const f = await fixture()
    await f.service.create({
      projectId: f.projectId,
      type: 'schedule',
      config: { everyMs: 3_600_000 },
      goalTemplate: 'Hourly',
    })
    const views = f.service.listProjected(f.projectId)
    expect(views).toHaveLength(1)
    // createdAt = now = 2026-09-10T00:00:00.000Z, everyMs = 1h → next slot is +1h.
    expect(views[0]?.nextRunAt).toBe('2026-09-10T01:00:00.000Z')
    // No fires yet → recentFires is absent (not an empty array).
    expect(views[0]?.recentFires).toBeUndefined()
  })

  it('listProjected omits nextRunAt for a disabled schedule trigger', async () => {
    const f = await fixture()
    const record = await f.service.create({
      projectId: f.projectId,
      type: 'schedule',
      config: { everyMs: 3_600_000 },
      goalTemplate: 'Hourly',
    })
    await f.service.setEnabled(record.id, false)
    const views = f.service.listProjected(f.projectId)
    expect(views[0]?.nextRunAt).toBeUndefined()
  })

  it('listProjected omits nextRunAt for a non-schedule trigger', async () => {
    const f = await fixture()
    await f.service.create({
      projectId: f.projectId,
      type: 'webhook',
      config: { path: '/hooks/test', secretRef: 'env:HOOK' },
      goalTemplate: 'Hook',
    })
    const views = f.service.listProjected(f.projectId)
    expect(views[0]?.nextRunAt).toBeUndefined()
  })

  it('listProjected computes nextRunAt for a cron schedule trigger', async () => {
    const f = await fixture()
    await f.service.create({
      projectId: f.projectId,
      type: 'schedule',
      config: { cron: '*/5 * * * *' },
      goalTemplate: 'Every 5 minutes',
    })
    const views = f.service.listProjected(f.projectId)
    // createdAt = now = 2026-09-10T00:00:00.000Z, cron */5 → next slot is +5min.
    expect(views[0]?.nextRunAt).toBe('2026-09-10T00:05:00.000Z')
  })

  it('getProjected returns the record with projections', async () => {
    const f = await fixture()
    const record = await f.service.create({
      projectId: f.projectId,
      type: 'schedule',
      config: { everyMs: 3_600_000 },
      goalTemplate: 'Hourly',
    })
    const view = f.service.getProjected(record.id)
    expect(view).toBeDefined()
    expect(view?.id).toBe(record.id)
    expect(view?.nextRunAt).toBe('2026-09-10T01:00:00.000Z')
  })

  it('getProjected returns undefined for an unknown id', async () => {
    const f = await fixture()
    expect(f.service.getProjected('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })

  it('listProjected returns recentFires newest-first, bounded to 10', async () => {
    const f = await fixture()
    const record = await f.service.create({
      projectId: f.projectId,
      type: 'schedule',
      config: { everyMs: 3_600_000 },
      goalTemplate: 'Hourly',
    })
    const fires = f.storage.tables.get('trigger_fires')!
    // 12 fires with increasing timestamps → only the newest 10 should appear.
    for (let i = 0; i < 12; i += 1) {
      const key = `slot-${i}`
      const firedAt = new Date(Date.parse('2026-09-10T00:00:00.000Z') + i * 60_000).toISOString()
      await fires.put(`${record.id}:${key}`, {
        id: `${record.id}:${key}`,
        triggerId: record.id,
        sourceEventKey: key,
        runId: `run-${i}`,
        firedAt,
      })
    }
    const views = f.service.listProjected(f.projectId)
    const recent = views[0]?.recentFires
    expect(recent).toBeDefined()
    expect(recent).toHaveLength(10)
    // Newest first: the most recent fire (slot-11) is at the head.
    expect(recent![0]).toEqual({ firedAt: new Date(Date.parse('2026-09-10T00:00:00.000Z') + 11 * 60_000).toISOString(), runId: 'run-11', sourceEventKey: 'slot-11' })
    // The oldest of the kept 10 (slot-2) is at the tail; slot-0/slot-1 are dropped.
    expect(recent![9]).toEqual({ firedAt: new Date(Date.parse('2026-09-10T00:00:00.000Z') + 2 * 60_000).toISOString(), runId: 'run-2', sourceEventKey: 'slot-2' })
  })

  it('listProjected does not leak other triggers fires into recentFires', async () => {
    const f = await fixture()
    const a = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 3_600_000 }, goalTemplate: 'A' })
    const b = await f.service.create({ projectId: f.projectId, type: 'schedule', config: { everyMs: 3_600_000 }, goalTemplate: 'B' })
    const fires = f.storage.tables.get('trigger_fires')!
    await fires.put(`${a.id}:k`, { id: `${a.id}:k`, triggerId: a.id, sourceEventKey: 'k', runId: 'run-a', firedAt: '2026-09-10T00:30:00.000Z' })
    const views = f.service.listProjected(f.projectId)
    const viewForA = views.find(view => view.id === a.id)
    const viewForB = views.find(view => view.id === b.id)
    expect(viewForA?.recentFires).toHaveLength(1)
    expect(viewForB?.recentFires).toBeUndefined()
  })
})

describe('validateTrigger (pure, spec §5.4)', () => {
  it('returns the normalized fields for a valid input', () => {
    const fields = validateTrigger({
      projectId: PROJECT_ID,
      type: 'schedule',
      config: { everyMs: 2000, timezone: 'UTC' },
      goalTemplate: '  spaced  ',
      approvalMode: 'guarded',
    })
    expect(fields).toEqual({
      type: 'schedule',
      config: { everyMs: 2000, timezone: 'UTC' },
      goalTemplate: 'spaced',
      approvalMode: 'guarded',
    })
  })

  it('rejects an unknown type with the reason', () => {
    expect(() => validateTrigger({ projectId: PROJECT_ID, type: 'nope', config: {}, goalTemplate: 'g' }))
      .toThrow(DashboardDomainError)
    try {
      validateTrigger({ projectId: PROJECT_ID, type: 'nope', config: {}, goalTemplate: 'g' })
    } catch (error) {
      expect(error).toMatchObject({ dashboardCode: 'trigger.invalidCandidate', params: { reason: 'unknown-type', type: 'nope' } })
    }
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
