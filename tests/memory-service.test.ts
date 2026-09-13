/** DSH Projects Phase 6 — memory service tests (spec §12.2). */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectRunEventRecord, ProjectRunRecord } from '../src/runs/types.ts'
import type { ProjectTaskRecord } from '../src/tasks/types.ts'
import { COORDINATOR_MEMORY_BUDGET } from '../src/memory/retrieval.ts'
import {
  findSupersessionTarget,
  ProjectMemoryService,
  validateMemoryCandidate,
} from '../src/memory/memory-service.ts'
import type {
  MemoryDistillationDriver,
  MemoryDistillationDriverInput,
  MemoryDistillationDriverResult,
  MemoryDistillationSubmission,
} from '../src/memory/distillation.ts'
import { MEMORY_KINDS, type ProjectMemoryRecord } from '../src/memory/types.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

function localWorkflow(): string {
  return '# Workflow\n\n```yaml\nstates: [todo, doing, done]\ninitial: todo\nterminal: [done]\ntransitions: [{ from: todo, to: doing }, { from: doing, to: done }]\n```\n'
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-memory-'))
  temporaryDirectories.push(root)
  const projectDir = join(root, 'proj')
  await mkdir(projectDir)
  const projectRoot = await realpath(projectDir)
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
  const project = catalog.activeProject()!
  const runService = new ProjectRunService(context, catalog)
  await runService.start()
  const service = new ProjectMemoryService(context, catalog, runService, undefined, () => '2026-09-10T00:00:00.000Z')
  service.start()
  return { context, catalog, runService, service, projectId: project.id, projectRoot, storage }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function seedSucceededRun(f: Fixture, goal: string): Promise<ProjectRunRecord> {
  const created = await f.runService.createRun({ goal }, { mode: 'project', projectId: f.projectId })
  let run = created
  for (const phase of ['planning', 'executing', 'finalizing', 'succeeded'] as const) {
    run = await f.runService.transitionRun(run.id, phase, { resultSummary: 'done' })
  }
  return run
}

function seedTask(runId: string, overrides: Partial<ProjectTaskRecord> & { planTaskId: string }): ProjectTaskRecord {
  return {
    id: `task-${overrides.planTaskId}`,
    runId,
    planId: 'plan-1',
    title: 'Do the thing',
    description: 'Do the thing properly',
    dependencies: [],
    status: 'succeeded',
    acceptanceCriteria: [],
    attempt: 1,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

function eventsFor(f: Fixture, runId: string): ProjectRunEventRecord[] {
  const events = f.runService.domain().table('run_events')
  const rows: ProjectRunEventRecord[] = []
  for (const [, row] of events.entries()) {
    if (row.runId === runId) rows.push(row)
  }
  return rows
}

class FakeMemoryDriver implements MemoryDistillationDriver {
  input: MemoryDistillationDriverInput | undefined
  behavior: { kind: MemoryDistillationDriverResult['kind']; error?: string; submission?: MemoryDistillationSubmission } = {
    kind: 'completed',
    submission: { entries: [] },
  }

  async start(input: MemoryDistillationDriverInput): Promise<MemoryDistillationDriverResult> {
    this.input = input
    if (this.behavior.submission !== undefined) {
      await input.onMemorySubmit(this.behavior.submission)
    }
    return { kind: this.behavior.kind, ...(this.behavior.error === undefined ? {} : { error: this.behavior.error }) }
  }
}

async function memoryServiceWithDriver(f: Fixture, driver: FakeMemoryDriver): Promise<ProjectMemoryService> {
  const service = new ProjectMemoryService(f.context, f.catalog, f.runService, driver, () => '2026-09-10T00:00:00.000Z')
  service.start()
  return service
}

function expectInvalidCandidate(run: () => unknown, reason: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught, 'expected memory.invalidCandidate to be thrown').not.toBeUndefined()
  expect((caught as { dashboardCode?: string }).dashboardCode).toBe('memory.invalidCandidate')
  expect((caught as { params?: { reason?: string } }).params?.reason).toBe(reason)
}

describe('validateMemoryCandidate (pure, spec §4.2)', () => {
  const base = { kind: 'testing', title: 'Tests need Postgres', body: 'Start postgres first.' }

  it('returns normalized fields for a valid candidate', () => {
    expect(validateMemoryCandidate({ ...base, tags: ['ci', ' CI', 'postgres'], confidence: 0.9 })).toEqual({
      kind: 'testing', title: 'Tests need Postgres', body: 'Start postgres first.', tags: ['ci', 'postgres'], confidence: 0.9,
    })
  })

  const invalid: [string, () => void, string][] = [
    ['unknown-kind', () => validateMemoryCandidate({ ...base, kind: 'vibe' }), 'unknown-kind'],
    ['empty-title', () => validateMemoryCandidate({ ...base, title: '   ' }), 'empty-title'],
    ['title-too-long', () => validateMemoryCandidate({ ...base, title: 'x'.repeat(201) }), 'title-too-long'],
    ['empty-body', () => validateMemoryCandidate({ ...base, body: ' ' }), 'empty-body'],
    ['body-too-long', () => validateMemoryCandidate({ ...base, body: 'x'.repeat(12_001) }), 'body-too-long'],
    ['too-many-tags', () => validateMemoryCandidate({ ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), 'too-many-tags'],
    ['invalid-tag (blank)', () => validateMemoryCandidate({ ...base, tags: ['ok', '  '] }), 'invalid-tag'],
    ['invalid-tag (too long)', () => validateMemoryCandidate({ ...base, tags: ['x'.repeat(41)] }), 'invalid-tag'],
    ['invalid-confidence (negative)', () => validateMemoryCandidate({ ...base, confidence: -0.1 }), 'invalid-confidence'],
    ['invalid-confidence (> 1)', () => validateMemoryCandidate({ ...base, confidence: 1.5 }), 'invalid-confidence'],
    ['invalid-confidence (NaN)', () => validateMemoryCandidate({ ...base, confidence: Number.NaN }), 'invalid-confidence'],
  ]
  for (const [label, run, reason] of invalid) {
    it(`rejects ${label} with memory.invalidCandidate`, () => expectInvalidCandidate(run, reason))
  }

  it('rejects the four secret shapes (contains-secrets)', () => {
    const secrets: [string, string][] = [
      ['key value', 'the api_key: AbCdEfGh12345 is configured'],
      ['aws key', 'deploy with AKIAABCDEFGHIJKLMNOP'],
      ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
      ['bearer token', 'use Bearer abcdefghijklmnopqrstuvwxyz123 in the header'],
    ]
    for (const [label, body] of secrets) {
      expectInvalidCandidate(() => validateMemoryCandidate({ ...base, body }), 'contains-secrets')
    }
  })
})

describe('findSupersessionTarget (pure, spec §4.3)', () => {
  const entry = (overrides: Partial<ProjectMemoryRecord> & { id: string }): ProjectMemoryRecord => ({
    projectId: 'p1', kind: 'environment', title: 'Node version is 20', body: 'b', tags: [],
    status: 'active', createdAt: 't', updatedAt: 't', version: 1, ...overrides,
  })

  it('supersedes at containment overlap ≥ 0.6 in the same kind', () => {
    const target = findSupersessionTarget(
      { kind: 'environment', title: 'Node version was upgraded to 22', tags: [] },
      [entry({ id: 'e1', title: 'Node version is 20' })],
    )
    expect(target?.id).toBe('e1')
  })

  it('never targets other kinds, superseded, or archived entries', () => {
    const pool = [
      entry({ id: 'other-kind', kind: 'testing' }),
      entry({ id: 'superseded', status: 'superseded' }),
      entry({ id: 'archived', status: 'archived' }),
    ]
    expect(findSupersessionTarget({ kind: 'environment', title: 'Node version was upgraded to 22', tags: [] }, pool)).toBeUndefined()
  })

  it('breaks ties on the lexicographically smallest id', () => {
    const pool = [entry({ id: 'zzz' }), entry({ id: 'aaa' }), entry({ id: 'mmm' })]
    expect(findSupersessionTarget({ kind: 'environment', title: 'Node version is 20', tags: [] }, pool)?.id).toBe('aaa')
  })

  it('returns undefined below the threshold', () => {
    expect(findSupersessionTarget(
      { kind: 'environment', title: 'Kubernetes ingress controller', tags: [] },
      [entry({ id: 'e1', title: 'Node version is 20' })],
    )).toBeUndefined()
  })
})

describe('ProjectMemoryService — store', () => {
  it('rejects calls before start with memory.notStarted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-memory-'))
    temporaryDirectories.push(root)
    const projectRoot = join(root, 'proj')
    await mkdir(projectRoot)
    await writeFile(join(projectRoot, 'WORKFLOW.md'), localWorkflow())
    const storage = new MemoryStorage()
    const context = { logger: { info: vi.fn(), warn: vi.fn() }, emit: vi.fn(), storageDomain: { open: vi.fn(async () => storage.open()) } } as unknown as Context
    const catalog = new ProjectCatalog(context, { currentProject: { root: projectRoot, policyPath: 'WORKFLOW.md', registerInCatalog: true }, discoveryRoots: [] }, root)
    await catalog.start()
    const runService = new ProjectRunService(context, catalog)
    await runService.start()
    const service = new ProjectMemoryService(context, catalog, runService, undefined)
    await expect(service.list({ projectId: catalog.activeProject()!.id })).rejects.toMatchObject({ dashboardCode: 'memory.notStarted' })
  })

  it('rejects double start', async () => {
    const f = await fixture()
    expect(() => f.service.start()).toThrow('already started')
  })

  it('creates a manual note and counts per kind (zero-filled)', async () => {
    const f = await fixture()
    const { entry } = await f.service.create({
      projectId: f.projectId, kind: 'testing', title: 'Tests need Postgres', body: 'Start postgres first.', tags: ['ci'],
    })
    expect(entry).toMatchObject({ kind: 'testing', status: 'active', version: 1, createdAt: '2026-09-10T00:00:00.000Z' })
    const { entries, counts } = await f.service.list({ projectId: f.projectId })
    expect(entries.map(e => e.id)).toEqual([entry.id])
    expect(Object.keys(counts).sort()).toEqual([...MEMORY_KINDS].sort())
    expect(counts.testing).toBe(1)
    expect(counts.architecture).toBe(0)
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('rejects unknown projects with memory.projectNotFound', async () => {
    const f = await fixture()
    await expect(f.service.create({ projectId: 'nope', kind: 'testing', title: 't', body: 'b' }))
      .rejects.toMatchObject({ dashboardCode: 'memory.projectNotFound', params: { projectId: 'nope' } })
    await expect(f.service.list({ projectId: 'nope' })).rejects.toMatchObject({ dashboardCode: 'memory.projectNotFound' })
  })

  it('applies dedup/supersession on create (never deletes)', async () => {
    const f = await fixture()
    const old = (await f.service.create({
      projectId: f.projectId, kind: 'environment', title: 'Node version is 20', body: 'The runtime is Node 20.',
    })).entry
    const { entry, supersededId } = await f.service.create({
      projectId: f.projectId, kind: 'environment', title: 'Node version was upgraded to 22', body: 'The runtime is now Node 22.',
    })
    expect(supersededId).toBe(old.id)
    expect(entry.supersedes).toBe(old.id)
    const memory = f.runService.domain().table('memory')
    const storedOld = memory.get(old.id)!
    expect(storedOld.status).toBe('superseded')
    expect(storedOld.version).toBe(2)
    expect(memory.get(entry.id)!.status).toBe('active')
    // Superseded entries drop out of the active pool but are never deleted.
    const { entries } = await f.service.list({ projectId: f.projectId })
    expect(entries.map(e => e.id)).toEqual([entry.id])
    // Spec §5: superseded entries stay out of list results even with
    // includeArchived (they remain reachable via the supersedes link).
    const { entries: withHistory } = await f.service.list({ projectId: f.projectId, includeArchived: true })
    expect(withHistory.map(e => e.id)).toEqual([entry.id])
  })

  it('does not supersede across kinds or below the threshold', async () => {
    const f = await fixture()
    const env = (await f.service.create({
      projectId: f.projectId, kind: 'environment', title: 'Node version is 20', body: 'The runtime is Node 20.',
    })).entry
    const { supersededId } = await f.service.create({
      projectId: f.projectId, kind: 'testing', title: 'Node version is 20', body: 'same words, other kind',
    })
    expect(supersededId).toBeUndefined()
    const { entries } = await f.service.list({ projectId: f.projectId })
    expect(entries).toHaveLength(2)
    expect(entries.find(e => e.id === env.id)!.status).toBe('active')
  })

  it('updates with CAS (version bump, only provided fields)', async () => {
    const f = await fixture()
    const { entry } = await f.service.create({
      projectId: f.projectId, kind: 'convention', title: 'Old title', body: 'Old body.', tags: ['a'],
    })
    const next = await f.service.update(entry.id, 1, { title: 'New title', pinned: true })
    expect(next).toMatchObject({ title: 'New title', body: 'Old body.', tags: ['a'], pinned: true, version: 2 })
    expect(next.updatedAt).toBe('2026-09-10T00:00:00.000Z')
  })

  it('rejects empty patches, unknown ids, superseded entries, and CAS misses', async () => {
    const f = await fixture()
    const { entry } = await f.service.create({
      projectId: f.projectId, kind: 'environment', title: 'Node version is 20', body: 'The runtime is Node 20.',
    })
    await expect(f.service.update(entry.id, 1, {})).rejects.toMatchObject({
      dashboardCode: 'memory.invalidCandidate',
      params: { reason: 'empty-patch' },
    })
    await expect(f.service.update('unknown-id', 1, { title: 'x' })).rejects.toMatchObject({ dashboardCode: 'memory.unknown' })
    // Make it superseded via a deduping create, then try to update it.
    const { entry: newer, supersededId } = await f.service.create({
      projectId: f.projectId, kind: 'environment', title: 'Node version was upgraded to 22', body: 'The runtime is now Node 22.',
    })
    expect(supersededId).toBe(entry.id)
    await expect(f.service.update(entry.id, 2, { title: 'x' })).rejects.toMatchObject({ dashboardCode: 'memory.immutable' })
    const bumped = await f.service.update(newer.id, 1, { body: 'b2' })
    await expect(f.service.update(newer.id, 1, { body: 'stale' })).rejects.toMatchObject({ dashboardCode: 'memory.staleVersion' })
    expect(bumped.version).toBe(2)
  })

  it('validates patched fields with the §4.2 reasons', async () => {
    const f = await fixture()
    const { entry } = await f.service.create({ projectId: f.projectId, kind: 'testing', title: 't', body: 'b' })
    await expect(f.service.update(entry.id, 1, { body: 'api_key: AbCdEfGh12345' })).rejects.toMatchObject({
      dashboardCode: 'memory.invalidCandidate',
      params: { reason: 'contains-secrets' },
    })
    await expect(f.service.update(entry.id, 1, { title: 'x'.repeat(201) })).rejects.toMatchObject({
      dashboardCode: 'memory.invalidCandidate',
      params: { reason: 'title-too-long' },
    })
  })

  it('sets status with the legal transitions only', async () => {
    const f = await fixture()
    const { entry } = await f.service.create({ projectId: f.projectId, kind: 'operations', title: 'Ops note', body: 'b' })
    const archived = await f.service.setStatus(entry.id, 1, 'archived')
    expect(archived).toMatchObject({ status: 'archived', version: 2 })
    await expect(f.service.setStatus(entry.id, 2, 'archived')).rejects.toMatchObject({ dashboardCode: 'memory.invalidStatus' })
    await expect(f.service.setStatus(entry.id, 2, 'superseded')).rejects.toMatchObject({ dashboardCode: 'memory.invalidStatus' })
    await expect(f.service.setStatus(entry.id, 1, 'active')).rejects.toMatchObject({ dashboardCode: 'memory.staleVersion' })
    await expect(f.service.setStatus('unknown-id', 1, 'archived')).rejects.toMatchObject({ dashboardCode: 'memory.unknown' })
    const reactivated = await f.service.setStatus(entry.id, 2, 'active')
    expect(reactivated).toMatchObject({ status: 'active', version: 3 })
    const obsolete = await f.service.setStatus(entry.id, 3, 'superseded')
    expect(obsolete).toMatchObject({ status: 'superseded', version: 4 })
    await expect(f.service.setStatus(entry.id, 4, 'active')).rejects.toMatchObject({ dashboardCode: 'memory.immutable' })
  })

  it('excludes superseded from list/pool and includes archived on request', async () => {
    const f = await fixture()
    const { entry } = await f.service.create({ projectId: f.projectId, kind: 'finding', title: 'F', body: 'b' })
    await f.service.setStatus(entry.id, 1, 'archived')
    let { entries } = await f.service.list({ projectId: f.projectId })
    expect(entries).toHaveLength(0)
    const counts = (await f.service.list({ projectId: f.projectId })).counts
    expect(counts.finding).toBe(0) // archived is not active
    ;({ entries } = await f.service.list({ projectId: f.projectId, includeArchived: true }))
    expect(entries.map(e => e.id)).toEqual([entry.id])
  })
})

describe('ProjectMemoryService — retrieval + packet', () => {
  it('searches the active pool with query/kinds/tags', async () => {
    const f = await fixture()
    await f.service.create({ projectId: f.projectId, kind: 'testing', title: 'Integration tests need Postgres', body: 'start it first', tags: ['ci'] })
    await f.service.create({ projectId: f.projectId, kind: 'architecture', title: 'Gateway layout', body: 'nginx fronts the api' })
    const byQuery = f.service.search({ projectId: f.projectId, query: 'postgres' })
    expect(byQuery.map(e => e.kind)).toEqual(['testing'])
    const byKind = f.service.search({ projectId: f.projectId, kinds: ['architecture'] })
    expect(byKind.map(e => e.kind)).toEqual(['architecture'])
    const byTag = f.service.search({ projectId: f.projectId, tags: ['CI'] })
    expect(byTag).toHaveLength(1)
  })

  it('packetFor returns undefined when empty and a bounded packet otherwise', async () => {
    const f = await fixture()
    expect(f.service.packetFor({ projectId: f.projectId, query: 'nothing', budgets: COORDINATOR_MEMORY_BUDGET })).toBeUndefined()
    await f.service.create({ projectId: f.projectId, kind: 'testing', title: 'Tests need Postgres', body: 'start postgres first' })
    const packet = f.service.packetFor({ projectId: f.projectId, query: 'postgres', budgets: COORDINATOR_MEMORY_BUDGET })
    expect(packet).toBeDefined()
    expect(packet!.startsWith('PROJECT MEMORY (knowledge persisted from earlier runs — verify before relying on it):')).toBe(true)
    expect(packet!).toContain('TESTING:')
  })
})

describe('ProjectMemoryService — distillation (spec §6.3, §12.4)', () => {
  it('is a silent no-op without a driver', async () => {
    const f = await fixture()
    const run = await seedSucceededRun(f, 'Make it work')
    const result = await f.service.distillRun(run)
    expect(result).toEqual({ persisted: 0, superseded: 0 })
    expect(eventsFor(f, run.id).filter(e => e.type.startsWith('run.memory'))).toHaveLength(0)
  })

  it('skips runs that are not succeeded (driver never called)', async () => {
    const f = await fixture()
    const driver = new FakeMemoryDriver()
    const service = await memoryServiceWithDriver(f, driver)
    const created = await f.runService.createRun({ goal: 'g' }, { mode: 'project', projectId: f.projectId })
    const result = await service.distillRun(created)
    expect(result).toEqual({ persisted: 0, superseded: 0 })
    expect(driver.input).toBeUndefined()
  })

  it('persists the submission, stamps provenance, and emits run.memory.distilled', async () => {
    const f = await fixture()
    const driver = new FakeMemoryDriver()
    driver.behavior = {
      kind: 'completed',
      submission: {
        entries: [
          { kind: 'testing', title: 'Integration tests need Postgres', body: 'Start postgres and redis before the integration suite.', tags: ['ci'], confidence: 0.9, sourceTaskId: 'task-t1' },
          { kind: 'environment', title: 'Node version is 22', body: 'The runtime was upgraded to Node 22.' },
        ],
      },
    }
    const service = await memoryServiceWithDriver(f, driver)
    const run = await seedSucceededRun(f, 'Make the pipeline green')
    const task = seedTask(run.id, { planTaskId: 't1', title: 'Fix the flaky test', outputSummary: 'Added a retry and a real postgres service.' })
    await f.runService.domain().table('tasks').put(task.id, task)

    const result = await service.distillRun(run)
    expect(result).toEqual({ persisted: 2, superseded: 0 })

    // Driver input (spec §6.2 prompt sections, §6.1 session shape).
    const input = driver.input!
    expect(input.sessionId).toMatch(/^dsh-memory-/)
    expect(input.cwd).toBe(f.projectRoot)
    expect(input.permissionPreset).toBe('workspace-write')
    expect(input.prompt).toContain('You are distilling durable project memory from a completed run.')
    expect(input.prompt).toContain('Run goal: Make the pipeline green')
    expect(input.prompt).toContain('t1 [succeeded] Fix the flaky test — Added a retry and a real postgres service.')
    expect(input.prompt).toContain('Already stored (do not resubmit duplicates): none')
    expect(input.prompt).toContain('WRITE POLICY (persist only reusable project knowledge):')
    expect(input.prompt).toContain('Submit zero entries if nothing is reusable.')

    // Persisted entries carry the provenance.
    const { entries } = await f.service.list({ projectId: f.projectId })
    expect(entries).toHaveLength(2)
    const testing = entries.find(e => e.kind === 'testing')!
    expect(testing).toMatchObject({
      sourceRunId: run.id, sourceTaskId: 'task-t1', status: 'active', confidence: 0.9,
    })
    expect(testing.sourceSessionId).toBe(input.sessionId)

    // The distilled event with the exact detail.
    const memoryEvents = eventsFor(f, run.id).filter(e => e.type.startsWith('run.memory'))
    expect(memoryEvents).toHaveLength(1)
    expect(memoryEvents[0]).toMatchObject({
      type: 'run.memory.distilled',
      detail: '2 entries persisted (0 superseded)',
      seq: 6, // run.created + 3 phase-changed + run.completed + this
    })
  })

  it('lists already-stored titles in the prompt', async () => {
    const f = await fixture()
    await f.service.create({ projectId: f.projectId, kind: 'environment', title: 'Node version is 22', body: 'b' })
    const driver = new FakeMemoryDriver()
    const service = await memoryServiceWithDriver(f, driver)
    const run = await seedSucceededRun(f, 'goal')
    await service.distillRun(run)
    expect(driver.input!.prompt).toContain('Already stored (do not resubmit duplicates):\n- Node version is 22')
  })

  it('supersedes duplicates during distillation and counts them', async () => {
    const f = await fixture()
    await f.service.create({ projectId: f.projectId, kind: 'environment', title: 'Node version is 20', body: 'The runtime is Node 20.' })
    const driver = new FakeMemoryDriver()
    driver.behavior = {
      kind: 'completed',
      submission: { entries: [{ kind: 'environment', title: 'Node version was upgraded to 22', body: 'The runtime is now Node 22.' }] },
    }
    const service = await memoryServiceWithDriver(f, driver)
    const run = await seedSucceededRun(f, 'goal')
    const result = await service.distillRun(run)
    expect(result).toEqual({ persisted: 1, superseded: 1 })
    const memoryEvents = eventsFor(f, run.id).filter(e => e.type === 'run.memory.distilled')
    expect(memoryEvents[0]?.detail).toBe('1 entries persisted (1 superseded)')
    const { entries } = await f.service.list({ projectId: f.projectId })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toBe('Node version was upgraded to 22')
    expect(entries[0]!.supersedes).toBeDefined()
  })

  it('emits run.memory.distillation.failed (never throws) on driver failure', async () => {
    const f = await fixture()
    const driver = new FakeMemoryDriver()
    driver.behavior = { kind: 'failed', error: 'model exploded' }
    const service = await memoryServiceWithDriver(f, driver)
    const run = await seedSucceededRun(f, 'goal')
    const result = await service.distillRun(run)
    expect(result).toEqual({ persisted: 0, superseded: 0 })
    const failed = eventsFor(f, run.id).filter(e => e.type === 'run.memory.distillation.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.detail).toBe('model exploded')
  })

  it('emits run.memory.distillation.failed for blocked sessions', async () => {
    const f = await fixture()
    const driver = new FakeMemoryDriver()
    driver.behavior = { kind: 'blocked', error: 'the memory distillation session ended blocked' }
    const service = await memoryServiceWithDriver(f, driver)
    const run = await seedSucceededRun(f, 'goal')
    await service.distillRun(run)
    expect(eventsFor(f, run.id).filter(e => e.type === 'run.memory.distillation.failed')).toHaveLength(1)
  })

  it('skips invalid candidates per-candidate (warn, not throw) and persists the rest', async () => {
    const f = await fixture()
    const driver = new FakeMemoryDriver()
    driver.behavior = {
      kind: 'completed',
      submission: {
        entries: [
          { kind: 'vibe', title: 'bad kind', body: 'b' },
          { kind: 'testing', title: 'has a secret', body: 'password: AbCdEfGh12345' },
          { kind: 'testing', title: 'Good entry', body: 'Start postgres first.' },
        ],
      },
    }
    const service = await memoryServiceWithDriver(f, driver)
    const run = await seedSucceededRun(f, 'goal')
    const result = await service.distillRun(run)
    expect(result).toEqual({ persisted: 1, superseded: 0 })
    expect(f.context.logger.warn).toHaveBeenCalled()
    const { entries } = await f.service.list({ projectId: f.projectId })
    expect(entries.map(e => e.title)).toEqual(['Good entry'])
  })

  it('emits no memory event when the session completes with zero entries', async () => {
    const f = await fixture()
    const driver = new FakeMemoryDriver()
    driver.behavior = { kind: 'completed', submission: { entries: [] } }
    const service = await memoryServiceWithDriver(f, driver)
    const run = await seedSucceededRun(f, 'goal')
    const result = await service.distillRun(run)
    expect(result).toEqual({ persisted: 0, superseded: 0 })
    expect(eventsFor(f, run.id).filter(e => e.type.startsWith('run.memory'))).toHaveLength(0)
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
