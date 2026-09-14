/** DSH Projects Phase 8 — final-report generator tests (spec §11.2). */

import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectRunEventRecord, ProjectRunRecord } from '../src/runs/types.ts'
import type { ProjectTaskRecord } from '../src/tasks/types.ts'
import type { ProjectMemoryRecord } from '../src/memory/types.ts'
import type { ApprovalRequestRecord } from '../src/approvals/types.ts'
import { buildFinalReport } from '../src/artifacts/final-report.ts'
import { ProjectArtifactService } from '../src/artifacts/artifact-service.ts'
import type { ProjectArtifactRecord } from '../src/artifacts/types.ts'

const PROJECT_ID = 'proj-report'
const PROJECT_ROOT = '/tmp/dsh-report-proj'
const NOW = '2026-09-10T00:00:00.000Z'

const temporaryHandlers: Array<() => void> = []
afterEach(() => {
  for (const dispose of temporaryHandlers.splice(0)) dispose()
})

function makeRun(overrides: Partial<ProjectRunRecord> = {}): ProjectRunRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: PROJECT_ID,
    goal: 'Ship the feature',
    source: 'manual',
    phase: 'succeeded',
    startedAt: '2026-09-10T00:00:00.000Z',
    completedAt: '2026-09-10T00:03:12.000Z',
    resultSummary: 'All tasks passed',
    createdAt: NOW,
    updatedAt: NOW,
    phaseChangedAt: NOW,
    version: 1,
    ...overrides,
  }
}

function makeTask(overrides: Partial<ProjectTaskRecord> = {}): ProjectTaskRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    runId: '11111111-1111-4111-8111-111111111111',
    planId: '33333333-3333-4333-8333-333333333333',
    planTaskId: 't1',
    title: 'Implement the change',
    description: 'do it',
    dependencies: [],
    status: 'succeeded',
    acceptanceCriteria: [],
    attempt: 1,
    outputSummary: 'done',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  }
}

function makeMemory(overrides: Partial<ProjectMemoryRecord> = {}): ProjectMemoryRecord {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    projectId: PROJECT_ID,
    kind: 'decision',
    title: 'Chose approach A',
    body: 'because it is simpler',
    tags: [],
    status: 'active',
    pinned: false,
    confidence: 0.9,
    sourceRunId: '11111111-1111-4111-8111-111111111111',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  }
}

function makeArtifact(overrides: Partial<ProjectArtifactRecord> = {}): ProjectArtifactRecord {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    projectId: PROJECT_ID,
    kind: 'pull-request',
    title: 'PR',
    url: 'https://github.com/x/y/pull/1',
    createdAt: NOW,
    ...overrides,
  }
}

describe('buildFinalReport — the generator (spec §11.2)', () => {
  it('renders all 9 sections', () => {
    const report = buildFinalReport(makeRun(), [makeTask()], [makeMemory()], [], [makeArtifact()])
    const lines = report.split('\n')
    for (const header of ['Goal', 'Outcome', 'Changes', 'Validation', 'Git', 'Agents', 'Usage', 'Project knowledge learned', 'Remaining risks']) {
      expect(lines).toContain(header)
    }
  })

  it('an empty section renders its header + "None."', () => {
    const report = buildFinalReport(makeRun({ goal: '' }), [], [], [], [])
    const lines = report.split('\n')
    // Each empty section is its header immediately followed by "None."
    for (const header of ['Goal', 'Changes', 'Project knowledge learned', 'Remaining risks']) {
      const index = lines.indexOf(header)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(lines[index + 1]).toBe('None.')
    }
  })

  it('the resultSummary is included verbatim (Outcome)', () => {
    const report = buildFinalReport(makeRun({ resultSummary: 'budget stopped at 80%' }), [], [], [], [])
    expect(report).toContain('succeeded — budget stopped at 80%')
  })

  it('the Git section renders branch/head (a Git project)', () => {
    const report = buildFinalReport(makeRun({ integrationBranch: 'dsh/run-abc/integration', integrationHead: 'abcdef1234567890' }), [], [], [], [])
    expect(report).toContain('- Integrated branch dsh/run-abc/integration @ abcdef12')
    expect(report).toContain('Branch: dsh/run-abc/integration')
    expect(report).toContain('Commit: abcdef1234567890')
  })

  it('the Validation section renders "No Git isolation" (non-Git)', () => {
    const report = buildFinalReport(makeRun(), [], [], [], [])
    expect(report).toContain('- No Git isolation')
  })

  it('the PR line renders the pull-request artifact url (when present)', () => {
    const report = buildFinalReport(makeRun(), [], [], [], [makeArtifact()])
    expect(report).toContain('PR: https://github.com/x/y/pull/1')
  })

  it('the PR line is omitted (when absent)', () => {
    const report = buildFinalReport(makeRun(), [], [], [], [])
    expect(report).not.toContain('PR: ')
  })

  it('the knowledge section lists the run distilled memory titles', () => {
    const report = buildFinalReport(makeRun(), [], [makeMemory({ title: 'Chose approach A' }), makeMemory({ id: '44444444-4444-4444-8444-444444444445', title: 'Avoided approach B' })], [], [])
    expect(report).toContain('- Chose approach A')
    expect(report).toContain('- Avoided approach B')
  })

  it('the risks section lists the failed tasks + budget warnings', () => {
    const report = buildFinalReport(
      makeRun({ budgetWarnings: ['tokenUsage'] }),
      [makeTask({ status: 'failed', title: 'Broken task' }), makeTask({ planTaskId: 't2', id: '22222222-2222-4222-8222-222222222223', title: 'Ok task', status: 'succeeded' })],
      [], [], [],
    )
    expect(report).toContain('- Broken task (failed)')
    expect(report).toContain('- Budget warning: tokenUsage')
    // The succeeded task is not a risk (it appears in Changes, not as a risk).
    expect(report).not.toContain('- Ok task (failed)')
    expect(report).not.toContain('- Ok task (blocked)')
  })

  it('determinism: the same persisted records → byte-identical output', () => {
    const run = makeRun()
    const tasks = [makeTask()]
    const memory = [makeMemory()]
    const artifacts = [makeArtifact()]
    const a = buildFinalReport(run, tasks, memory, [], artifacts)
    const b = buildFinalReport(run, tasks, memory, [], artifacts)
    expect(a).toBe(b)
  })

  it('no fabricated data (a run with no tasks/integration/memory)', () => {
    const noSummaryRun: ProjectRunRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: PROJECT_ID,
      goal: 'Ship the feature',
      source: 'manual',
      phase: 'succeeded',
      startedAt: '2026-09-10T00:00:00.000Z',
      completedAt: '2026-09-10T00:03:12.000Z',
      createdAt: NOW,
      updatedAt: NOW,
      phaseChangedAt: NOW,
      version: 1,
    }
    const report = buildFinalReport(noSummaryRun, [], [], [], [])
    expect(report).toContain('\nChanges\nNone.\n')
    expect(report).toContain('\nProject knowledge learned\nNone.\n')
    expect(report).toContain('- No Git isolation')
    expect(report).toContain('Branch: None')
    expect(report).toContain('Commit: None')
  })
})

type Fixture = {
  readonly ctx: Context
  readonly runService: ProjectRunService
  readonly service: ProjectArtifactService
  readonly storage: MemoryStorage
}

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
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Report Project', root: PROJECT_ROOT } : undefined,
  } as unknown as ProjectCatalog
  const runService = new ProjectRunService(ctx, catalog)
  await runService.start()
  const service = new ProjectArtifactService(ctx, catalog, runService, () => NOW)
  service.start()
  return { ctx, runService, service, storage }
}

async function flush(): Promise<void> {
  await new Promise(resolve => { setImmediate(resolve) })
}

async function seedTerminalRun(f: Fixture, terminal: 'succeeded' | 'failed' | 'canceled'): Promise<ProjectRunRecord> {
  const created = await f.runService.createRun({ goal: 'g' }, { mode: 'project', projectId: PROJECT_ID })
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

function finalReports(f: Fixture, runId: string): ProjectArtifactRecord[] {
  const rows: ProjectArtifactRecord[] = []
  for (const [, record] of f.storage.tables.get('project_artifacts')!.entries()) rows.push(record as ProjectArtifactRecord)
  return rows.filter(record => record.runId === runId && record.kind === 'final-report')
}

describe('buildFinalReport — the terminal trigger (spec §11.2)', () => {
  it('the run/completed event fires generateFinalReport (succeeded/failed/canceled)', async () => {
    for (const terminal of ['succeeded', 'failed', 'canceled'] as const) {
      const f = await fixture()
      const run = await seedTerminalRun(f, terminal)
      await flush()
      expect(finalReports(f, run.id)).toHaveLength(1)
    }
  })

  it('a blocked/paused transition does not fire it (resumable, not terminal)', async () => {
    const f = await fixture()
    const created = await f.runService.createRun({ goal: 'g' }, { mode: 'project', projectId: PROJECT_ID })
    const planning = await f.runService.transitionRun(created.id, 'planning' as never, {})
    await f.runService.transitionRun(planning.id, 'executing' as never, {})
    await f.runService.transitionRun(planning.id, 'blocked' as never, { error: 'waiting' })
    await flush()
    expect(finalReports(f, created.id)).toHaveLength(0)
  })

  it('the generation is fire-and-forget (the transition completes regardless)', async () => {
    const f = await fixture()
    // The transition resolves before the (async) report generation finishes.
    const run = await seedTerminalRun(f, 'succeeded')
    // The run is terminal even if the report is still in flight.
    expect(run.phase).toBe('succeeded')
    await flush()
    expect(finalReports(f, run.id)).toHaveLength(1)
  })

  it('idempotency: one final-report row per run', async () => {
    const f = await fixture()
    const run = await seedTerminalRun(f, 'succeeded')
    await flush()
    // A second on-demand generation replaces in place (no second row).
    await f.service.generateFinalReport(run.id, 'on-demand')
    expect(finalReports(f, run.id)).toHaveLength(1)
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
