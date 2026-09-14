/** DSH Projects Phase 8 — artifact service tests (spec §11.1). */

import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectRunEventRecord, ProjectRunRecord } from '../src/runs/types.ts'
import { ProjectArtifactService, validateArtifact } from '../src/artifacts/artifact-service.ts'
import { MAX_ARTIFACT_CONTENT_LENGTH } from '../src/artifacts/spec.ts'
import { ARTIFACT_KINDS, type ProjectArtifactRecord } from '../src/artifacts/types.ts'
import { DashboardDomainError } from '../src/runtime/errors.ts'

const PROJECT_ID = 'proj-artifacts'
const PROJECT_ROOT = '/tmp/dsh-artifacts-proj'

type Fixture = {
  readonly ctx: Context
  readonly catalog: ProjectCatalog
  readonly runService: ProjectRunService
  readonly service: ProjectArtifactService
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
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Artifacts Project', root: PROJECT_ROOT } : undefined,
  } as unknown as ProjectCatalog
  const runService = new ProjectRunService(ctx, catalog)
  await runService.start()
  const service = new ProjectArtifactService(ctx, catalog, runService, () => '2026-09-10T00:00:00.000Z')
  service.start()
  return { ctx, catalog, runService, service, storage, projectId: PROJECT_ID }
}

/** Flush the fire-and-forget final-report generation (the run/completed listener). */
async function flush(): Promise<void> {
  await new Promise(resolve => { setImmediate(resolve) })
}

async function seedRun(f: Fixture, goal: string, terminal: 'succeeded' | 'failed' | 'canceled' = 'succeeded'): Promise<ProjectRunRecord> {
  const created = await f.runService.createRun({ goal }, { mode: 'project', projectId: f.projectId })
  let run = created
  const phases: readonly string[] = terminal === 'canceled'
    ? ['planning', 'canceled']
    : ['planning', 'executing', 'finalizing', terminal]
  for (const phase of phases) {
    run = await f.runService.transitionRun(run.id, phase as never, terminal === 'failed' ? { error: 'boom' } : { resultSummary: 'done' })
  }
  return run
}

function eventsFor(f: Fixture, runId: string): ProjectRunEventRecord[] {
  const rows: ProjectRunEventRecord[] = []
  for (const [, record] of f.storage.tables.get('run_events')!.entries()) rows.push(record as ProjectRunEventRecord)
  return rows.filter(record => record.runId === runId)
}

describe('artifact service — store (spec §11.1)', () => {
  it('create persists the record + the artifact.created run event (run-scoped)', async () => {
    const f = await fixture()
    const run = await f.runService.createRun({ goal: 'g' }, { mode: 'project', projectId: f.projectId })
    const record = await f.service.create({
      projectId: f.projectId,
      runId: run.id,
      kind: 'plan',
      title: 'The plan',
    })
    expect(record.id).toBeTruthy()
    expect(record.projectId).toBe(f.projectId)
    expect(record.runId).toBe(run.id)
    expect(record.kind).toBe('plan')
    expect(record.title).toBe('The plan')
    expect(record.createdAt).toBe('2026-09-10T00:00:00.000Z')
    // Persisted in the table.
    expect(f.storage.tables.get('project_artifacts')!.get(record.id)).toEqual(record)
    // The run event was appended.
    const created = eventsFor(f, run.id).filter(e => e.type === 'artifact.created')
    expect(created).toHaveLength(1)
    expect(created[0]!.title).toBe('Artifact: The plan')
  })

  it('all 12 kinds validate (reference kinds carry their url/path)', () => {
    for (const kind of ARTIFACT_KINDS) {
      if (kind === 'final-report') {
        expect(() => validateArtifact({ projectId: PROJECT_ID, kind, title: 'x' })).toThrow(DashboardDomainError)
        continue
      }
      const extra = kind === 'pull-request' || kind === 'external-link'
        ? { url: 'https://example.com' }
        : kind === 'screenshot'
          ? { path: '/tmp/shot.png' }
          : {}
      const fields = validateArtifact({ projectId: PROJECT_ID, kind, title: 'x', ...extra })
      expect(fields.kind).toBe(kind)
    }
  })

  it('title bounds (1..200)', () => {
    expect(() => validateArtifact({ projectId: PROJECT_ID, kind: 'plan', title: '' })).toThrow(DashboardDomainError)
    expect(() => validateArtifact({ projectId: PROJECT_ID, kind: 'plan', title: '   ' })).toThrow(DashboardDomainError)
    expect(validateArtifact({ projectId: PROJECT_ID, kind: 'plan', title: 'a'.repeat(200) }).title).toBe('a'.repeat(200))
    expect(() => validateArtifact({ projectId: PROJECT_ID, kind: 'plan', title: 'a'.repeat(201) })).toThrow(DashboardDomainError)
  })

  it('content bound (≤ 64 KB)', () => {
    expect(validateArtifact({ projectId: PROJECT_ID, kind: 'plan', title: 'x', content: 'a'.repeat(MAX_ARTIFACT_CONTENT_LENGTH) }).content).toBeDefined()
    expect(() => validateArtifact({ projectId: PROJECT_ID, kind: 'plan', title: 'x', content: 'a'.repeat(MAX_ARTIFACT_CONTENT_LENGTH + 1) })).toThrow(DashboardDomainError)
  })

  it('path/url/metadata stored as-is', async () => {
    const f = await fixture()
    const record = await f.service.create({
      projectId: f.projectId,
      kind: 'log-reference',
      title: 'Logs',
      path: '/tmp/run.log',
      metadata: { size: 1234, owner: 'ci' },
    })
    expect(record.path).toBe('/tmp/run.log')
    expect(record.metadata).toEqual({ size: 1234, owner: 'ci' })
    expect(f.storage.tables.get('project_artifacts')!.get(record.id)).toEqual(record)
  })

  it('project-scoped (no runId) → no run event', async () => {
    const f = await fixture()
    const record = await f.service.create({ projectId: f.projectId, kind: 'research-report', title: 'Research' })
    expect(record.runId).toBeUndefined()
    // No run event was appended (there is no run).
    const allEvents: ProjectRunEventRecord[] = []
    for (const [, e] of f.storage.tables.get('run_events')!.entries()) allEvents.push(e as ProjectRunEventRecord)
    expect(allEvents.filter(e => e.type === 'artifact.created')).toHaveLength(0)
  })
})

describe('artifact service — content policy (spec §11.1)', () => {
  it('content > 64 KB → artifact.contentTooLarge (params maxLength)', async () => {
    const f = await fixture()
    await expect(f.service.create({
      projectId: f.projectId,
      kind: 'plan',
      title: 'x',
      content: 'a'.repeat(MAX_ARTIFACT_CONTENT_LENGTH + 1),
    })).rejects.toMatchObject({ dashboardCode: 'artifact.contentTooLarge', params: { maxLength: MAX_ARTIFACT_CONTENT_LENGTH } })
  })

  it('pull-request with no url → artifact.missingUrl', async () => {
    const f = await fixture()
    await expect(f.service.create({ projectId: f.projectId, kind: 'pull-request', title: 'PR' }))
      .rejects.toMatchObject({ dashboardCode: 'artifact.missingUrl' })
  })

  it('external-link with no url → artifact.missingUrl', async () => {
    const f = await fixture()
    await expect(f.service.create({ projectId: f.projectId, kind: 'external-link', title: 'Link' }))
      .rejects.toMatchObject({ dashboardCode: 'artifact.missingUrl' })
  })

  it('screenshot with no path/url → rejected', async () => {
    const f = await fixture()
    await expect(f.service.create({ projectId: f.projectId, kind: 'screenshot', title: 'Shot' }))
      .rejects.toBeInstanceOf(DashboardDomainError)
  })

  it('secrets in content → artifact.containsSecrets', async () => {
    const f = await fixture()
    await expect(f.service.create({
      projectId: f.projectId,
      kind: 'log-reference',
      title: 'Logs',
      content: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    })).rejects.toMatchObject({ dashboardCode: 'artifact.containsSecrets' })
  })

  it('secrets in metadata → artifact.containsSecrets', async () => {
    const f = await fixture()
    await expect(f.service.create({
      projectId: f.projectId,
      kind: 'log-reference',
      title: 'Logs',
      // The metadata is scanned as JSON; the secret must sit in a value.
      metadata: { config: 'token: abc123def456ghi789jkl012mno345' },
    })).rejects.toMatchObject({ dashboardCode: 'artifact.containsSecrets' })
  })
})

describe('artifact service — append-only (spec §11.1)', () => {
  it('no update/delete method exists (service surface)', async () => {
    const f = await fixture()
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(f.service))).not.toContain('update')
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(f.service))).not.toContain('delete')
  })

  it('a re-create is a new row (not a mutation)', async () => {
    const f = await fixture()
    const first = await f.service.create({ projectId: f.projectId, kind: 'plan', title: 'Plan v1' })
    const second = await f.service.create({ projectId: f.projectId, kind: 'plan', title: 'Plan v1' })
    expect(second.id).not.toBe(first.id)
    expect((f.storage.tables.get('project_artifacts')!.get(first.id) as ProjectArtifactRecord).title).toBe('Plan v1')
    const rows = f.service.list({ projectId: f.projectId })
    expect(rows).toHaveLength(2)
  })
})

describe('artifact service — final-report (spec §11.1)', () => {
  it('a manual final-report create → artifact.kindReserved', async () => {
    const f = await fixture()
    await expect(f.service.create({ projectId: f.projectId, kind: 'final-report', title: 'x' }))
      .rejects.toMatchObject({ dashboardCode: 'artifact.kindReserved' })
  })

  it('the generator is idempotent (in-place replace, no second row)', async () => {
    const f = await fixture()
    const run = await seedRun(f, 'goal')
    const first = await f.service.generateFinalReport(run.id, 'on-demand')
    expect(first).toBeDefined()
    const second = await f.service.generateFinalReport(run.id, 'on-demand')
    expect(second).toBeDefined()
    expect(second!.id).toBe(first!.id)
    const rows = f.service.list({ runId: run.id }).filter(a => a.kind === 'final-report')
    expect(rows).toHaveLength(1)
  })
})

describe('artifact service — list (spec §11.1)', () => {
  it('newest-first (deterministic ordering)', async () => {
    const f = await fixture()
    // Use distinct timestamps by creating with an advancing clock.
    let tick = 0
    const service = new ProjectArtifactService(f.ctx, f.catalog, f.runService, () => `2026-09-10T00:00:0${tick++}.000Z`)
    service.start()
    const a = await service.create({ projectId: f.projectId, kind: 'plan', title: 'A' })
    const b = await service.create({ projectId: f.projectId, kind: 'diff', title: 'B' })
    const c = await service.create({ projectId: f.projectId, kind: 'test-report', title: 'C' })
    const rows = service.list({ projectId: f.projectId })
    expect(rows.map(r => r.id)).toEqual([c.id, b.id, a.id])
  })

  it('the kind filter', async () => {
    const f = await fixture()
    await f.service.create({ projectId: f.projectId, kind: 'plan', title: 'A' })
    await f.service.create({ projectId: f.projectId, kind: 'diff', title: 'B' })
    const plans = f.service.list({ projectId: f.projectId, kind: 'plan' })
    expect(plans).toHaveLength(1)
    expect(plans[0]!.kind).toBe('plan')
  })

  it('at least one of runId/projectId (both absent → artifact.badRequest)', async () => {
    const f = await fixture()
    expect(() => f.service.list({})).toThrow(DashboardDomainError)
  })
})

describe('artifact service — get (spec §11.1)', () => {
  it('a known id → the record; an unknown id → undefined', async () => {
    const f = await fixture()
    const record = await f.service.create({ projectId: f.projectId, kind: 'plan', title: 'A' })
    expect(f.service.get(record.id)).toEqual(record)
    expect(f.service.get('00000000-0000-4000-8000-000000000000')).toBeUndefined()
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
