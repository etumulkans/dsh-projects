/** DSH Projects Phase 7 — budget enforcement tests (spec §5, §9). */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCatalog } from '../src/catalog/catalog.ts'
import { checkBudget } from '../src/approvals/budgetCheck.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectRunRecord, RunBudget } from '../src/runs/types.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

function localWorkflow(): string {
  return '# Workflow\n\n```yaml\nstates: [todo, doing, done]\ninitial: todo\nterminal: [done]\ntransitions: [{ from: todo, to: doing }, { from: doing, to: done }]\n```\n'
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-budget-'))
  temporaryDirectories.push(root)
  const projectRoot = join(root, 'proj')
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, 'WORKFLOW.md'), localWorkflow())

  const storage = new MemoryStorage()
  const context = {
    logger: { info: vi.fn(), warn: vi.fn() },
    emit: vi.fn(),
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
  return { context, catalog, projectId, runService, storage }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** created → planning → paused (the only legal path to a suspended run). */
async function pause(f: Fixture, run: ProjectRunRecord): Promise<ProjectRunRecord> {
  const planning = await f.runService.transitionRun(run.id, 'planning')
  return f.runService.transitionRun(planning.id, 'paused')
}

describe('checkBudget (pure, spec §5.2)', () => {
  it('is unlimited when the budget is absent', () => {
    expect(checkBudget(undefined, 1_000_000, 'maxTotalTokens', [])).toBeUndefined()
  })

  it('is unlimited when the key is absent from the budget', () => {
    expect(checkBudget({ maxAgents: 5 }, 1_000, 'maxTotalTokens', [])).toBeUndefined()
  })

  it('treats a zero or negative limit as unset', () => {
    expect(checkBudget({ maxTotalTokens: 0 }, 10, 'maxTotalTokens', [])).toBeUndefined()
    expect(checkBudget({ maxTotalTokens: -5 }, 10, 'maxTotalTokens', [])).toBeUndefined()
  })

  it('returns undefined below the 80% warning threshold', () => {
    expect(checkBudget({ maxTotalTokens: 1000 }, 799, 'maxTotalTokens', [])).toBeUndefined()
  })

  it('warns at exactly 80% (and dedups via the warned array)', () => {
    const first = checkBudget({ maxTotalTokens: 1000 }, 800, 'maxTotalTokens', [])
    expect(first).toMatchObject({ key: 'maxTotalTokens', ratio: 0.8, warning: true, exceeded: false, usage: 800, limit: 1000 })
    const again = checkBudget({ maxTotalTokens: 1000 }, 900, 'maxTotalTokens', ['maxTotalTokens'])
    expect(again).toMatchObject({ warning: false, exceeded: false })
  })

  it('marks exceeded at exactly 100%', () => {
    const result = checkBudget({ maxRuntimeMinutes: 30 }, 30, 'maxRuntimeMinutes', [])
    expect(result).toMatchObject({ key: 'maxRuntimeMinutes', ratio: 1, warning: true, exceeded: true })
  })

  it('marks exceeded above 100% without re-warning', () => {
    const result = checkBudget({ maxTotalTokens: 1000 }, 1500, 'maxTotalTokens', ['maxTotalTokens'])
    expect(result).toMatchObject({ ratio: 1.5, warning: false, exceeded: true })
  })
})

describe('ProjectRunService.setRunBudget (spec §5.4)', () => {
  it('stamps the budget on a new run and reads it back', async () => {
    const f = await fixture()
    try {
      const budget: RunBudget = { maxTotalTokens: 10_000, maxRuntimeMinutes: 60 }
      const run = await f.runService.createRun({ goal: 'budgeted', budget }, { mode: 'project', projectId: f.projectId })
      expect(run.budget).toEqual(budget)
      expect(run.budgetWarnings).toBeUndefined()
    } finally {
      await f.runService.stop()
    }
  })

  it('refuses a budget while the run is not paused or blocked', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'active' }, { mode: 'project', projectId: f.projectId })
      const planning = await f.runService.transitionRun(run.id, 'planning')
      await expect(f.runService.setRunBudget(planning.id, { maxTotalTokens: 100 }))
        .rejects.toMatchObject({ dashboardCode: 'run.budgetPhaseInvalid', params: expect.objectContaining({ phase: 'planning' }) })
    } finally {
      await f.runService.stop()
    }
  })

  it('replaces the budget wholesale while paused', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'replace', budget: { maxTotalTokens: 100, maxAgents: 5 } }, { mode: 'project', projectId: f.projectId })
      await pause(f, run)
      const next = await f.runService.setRunBudget(run.id, { maxRuntimeMinutes: 30 })
      expect(next.budget).toEqual({ maxRuntimeMinutes: 30 })
      // The old keys are gone (wholesale replace).
      expect(next.budget?.maxTotalTokens).toBeUndefined()
      expect(next.budget?.maxAgents).toBeUndefined()
    } finally {
      await f.runService.stop()
    }
  })

  it('clears warnings for removed or changed keys, keeping unchanged ones', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'warnings' }, { mode: 'project', projectId: f.projectId })
      await pause(f, run)
      // Seed warnings for two keys.
      const storage = f.storage
      const runsTable = storage.tables.get('runs')!
      const current = runsTable.get(run.id) as ProjectRunRecord
      await runsTable.put(run.id, {
        ...current,
        budget: { maxTotalTokens: 1000, maxAgents: 10, maxRuntimeMinutes: 60 },
        budgetWarnings: ['maxTotalTokens', 'maxAgents'],
      })
      // Raise maxTotalTokens (changed → cleared), keep maxAgents (unchanged), remove maxRuntimeMinutes.
      const next = await f.runService.setRunBudget(run.id, { maxTotalTokens: 5000, maxAgents: 10 })
      expect(next.budgetWarnings).toEqual(['maxAgents'])
    } finally {
      await f.runService.stop()
    }
  })

  it('drops the budgetWarnings key entirely when nothing is kept', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'drop' }, { mode: 'project', projectId: f.projectId })
      await pause(f, run)
      const storage = f.storage
      const runsTable = storage.tables.get('runs')!
      const current = runsTable.get(run.id) as ProjectRunRecord
      await runsTable.put(run.id, {
        ...current,
        budget: { maxTotalTokens: 1000 },
        budgetWarnings: ['maxTotalTokens'],
      })
      const next = await f.runService.setRunBudget(run.id, { maxAgents: 5 })
      expect(next.budget).toEqual({ maxAgents: 5 })
      expect(next.budgetWarnings).toBeUndefined()
    } finally {
      await f.runService.stop()
    }
  })

  it('rejects an invalid budget (run.budgetInvalid)', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'invalid' }, { mode: 'project', projectId: f.projectId })
      await pause(f, run)
      await expect(f.runService.setRunBudget(run.id, { maxAgents: 0 } as RunBudget))
        .rejects.toMatchObject({ dashboardCode: 'run.budgetInvalid' })
      await expect(f.runService.setRunBudget(run.id, { unknownKey: 5 } as RunBudget))
        .rejects.toMatchObject({ dashboardCode: 'run.budgetInvalid' })
    } finally {
      await f.runService.stop()
    }
  })

  it('honors a CAS expectedVersion', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'cas' }, { mode: 'project', projectId: f.projectId })
      const paused = await pause(f, run)
      const version = paused.version
      await expect(f.runService.setRunBudget(run.id, { maxTotalTokens: 100 }, version + 5))
        .rejects.toMatchObject({ dashboardCode: 'run.versionConflict' })
      const next = await f.runService.setRunBudget(run.id, { maxTotalTokens: 100 }, version)
      expect(next.version).toBe(version + 1)
    } finally {
      await f.runService.stop()
    }
  })

  it('rejects an unknown run', async () => {
    const f = await fixture()
    try {
      await expect(f.runService.setRunBudget('missing', { maxTotalTokens: 100 }))
        .rejects.toMatchObject({ dashboardCode: 'run.unknown' })
    } finally {
      await f.runService.stop()
    }
  })
})
