/**
 * Integration check against the real storage stack: a genuine Cordis Context,
 * the real JSON file backend, and the real DomainFacility (zod validation and
 * medium versioning included). Proves Run state survives a process-style
 * restart: close everything, re-open the domain on the same medium, and the
 * records come back validated.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'

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

function catalogFixture(): ProjectCatalog {
  return {
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Project A' } : undefined,
  } as unknown as ProjectCatalog
}

describe('ProjectRunService against real JSON storage', () => {
  it('persists runs and events across a domain reopen on the same medium', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projects-run-it-'))
    temporaryRoots.push(root)
    const { ctx, facility, dispose } = await boot(root)
    const clock = () => new Date(Date.UTC(2026, 7, 14, 2, 0, 0)).toISOString()

    // --- boot 1: create and suspend a run, then shut the process down ---
    const first = new ProjectRunService(ctx, catalogFixture(), clock)
    await first.start()
    const run = await first.createRun(
      { goal: 'Integration: survive a real storage restart', sourceRef: 'IT-1' },
      { mode: 'project', projectId: PROJECT_ID },
    )
    expect(run).toMatchObject({ phase: 'created', version: 1 })
    await first.transitionRun(run.id, 'planning')
    await first.transitionRun(run.id, 'executing')
    const paused = await first.transitionRun(run.id, 'paused')
    expect(paused).toMatchObject({ phase: 'paused', suspendedFrom: 'executing', version: 4 })
    await first.stop()
    await facility.closeAll()

    // --- boot 2: fresh service instance over the same medium ---
    const second = new ProjectRunService(ctx, catalogFixture(), clock)
    await second.start()
    try {
      const summary = await second.listForSnapshot({ mode: 'project', projectId: PROJECT_ID })
      expect(summary.total).toBe(1)
      expect(summary.runs[0]).toMatchObject({
        id: run.id,
        goal: 'Integration: survive a real storage restart',
        sourceRef: 'IT-1',
        phase: 'paused',
        suspendedFrom: 'executing',
        version: 4,
      })

      const detail = await second.runDetail(run.id)
      expect(detail.truncated).toBe(false)
      expect(detail.events.map(event => event.type)).toEqual([
        'run.phase.changed',
        'run.phase.changed',
        'run.phase.changed',
        'run.created',
      ])
      expect(detail.events.map(event => event.seq)).toEqual([4, 3, 2, 1])
      expect(detail.events[0]!).toMatchObject({ type: 'run.phase.changed', detail: 'executing → paused' })

      const resumed = await second.transitionRun(run.id, 'executing')
      expect(resumed).toMatchObject({ phase: 'executing', version: 5 })
      expect(resumed.suspendedFrom).toBeUndefined()

      await second.transitionRun(run.id, 'finalizing')
      const done = await second.transitionRun(run.id, 'succeeded', { resultSummary: 'integration complete' })
      expect(done.completedAt).toBe(clock())
      expect(done.resultSummary).toBe('integration complete')
      expect(done.version).toBe(7)

      await expect(second.transitionRun(run.id, 'planning')).rejects.toMatchObject({
        dashboardCode: 'run.transitionInvalid',
        params: { from: 'succeeded', to: 'planning' },
      })
    } finally {
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
    expect(Object.keys(medium.tables).sort()).toEqual(['run_events', 'runs'])
    expect(Object.keys(medium.tables.runs ?? {})).toHaveLength(1)
    // 4 boot-1 events + 3 boot-2 events (resume, finalize, completed)
    expect(Object.keys(medium.tables.run_events ?? {})).toHaveLength(7)

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
})
