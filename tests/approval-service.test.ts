/** DSH Projects Phase 7 — approval service + policy tests (spec §4, §9). */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCatalog } from '../src/catalog/catalog.ts'
import { requiresApproval } from '../src/approvals/approval-policy.ts'
import { ApprovalService } from '../src/approvals/approval-service.ts'
import type { ApprovalMode, ApprovalRequestRecord, ApprovalStage } from '../src/approvals/types.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectRunEventRecord } from '../src/runs/types.ts'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-approvals-'))
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
  const service = new ApprovalService(context, catalog, runService)
  service.start()
  return { context, catalog, projectId, runService, service, storage, emit }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function eventsFor(f: Fixture, runId: string): ProjectRunEventRecord[] {
  const events = f.runService.domain().table('run_events')
  const rows: ProjectRunEventRecord[] = []
  for (const [, row] of events.entries()) {
    if (row.runId === runId) rows.push(row)
  }
  return rows
}

describe('requiresApproval (pure, spec §4.2)', () => {
  const cases: [ApprovalMode, ApprovalStage, boolean][] = [
    ['manual', 'plan', true],
    ['manual', 'merge', true],
    ['plan', 'plan', true],
    ['plan', 'merge', true],
    ['guarded', 'plan', false],
    ['guarded', 'merge', true],
    ['autonomous', 'plan', false],
    ['autonomous', 'merge', true],
  ]
  for (const [mode, stage, expected] of cases) {
    it(`${mode} / ${stage} → ${expected}`, () => {
      expect(requiresApproval(mode, stage)).toBe(expected)
    })
  }

  it('the merge gate applies in every mode', () => {
    for (const mode of ['manual', 'plan', 'guarded', 'autonomous'] as const) {
      expect(requiresApproval(mode, 'merge')).toBe(true)
    }
  })
})

describe('ApprovalService — lifecycle', () => {
  it('rejects calls before start with approval.notStarted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-approvals-'))
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
    const service = new ApprovalService(context, catalog, runService)
    const run = await runService.createRun({ goal: 'x' }, { mode: 'project', projectId: catalog.activeProject()!.id })
    await expect(service.requestApproval({ runId: run.id, type: 'plan', summary: 's' }))
      .rejects.toMatchObject({ dashboardCode: 'approval.notStarted' })
    await runService.stop()
  })

  it('rejects a double start and stops idempotently', async () => {
    const f = await fixture()
    try {
      expect(() => f.service.start()).toThrow('already started')
      f.service.stop()
      f.service.stop()
    } finally {
      await f.runService.stop()
    }
  })
})

describe('ApprovalService — request / resolve / expire (spec §4.3)', () => {
  it('requests a pending object with its event and emit', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'approve' }, { mode: 'project', projectId: f.projectId })
      const record = await f.service.requestApproval({
        runId: run.id,
        type: 'plan',
        summary: 'Plan v1 approval requested',
        payload: { planId: 'plan-1', version: 1 },
      })
      expect(record).toMatchObject({
        projectId: f.projectId,
        runId: run.id,
        type: 'plan',
        status: 'pending',
        version: 1,
        payload: { planId: 'plan-1', version: 1 },
      })
      expect(record.resolvedAt).toBeUndefined()
      expect(record.resolvedBy).toBeUndefined()

      const events = eventsFor(f, run.id)
      expect(events.map(event => event.type)).toEqual(['run.created', 'run.approval.requested'])
      expect(f.emit).toHaveBeenCalledWith('dsh-projects/approval/requested', expect.objectContaining({
        approvalId: record.id,
        runId: run.id,
        type: 'plan',
      }))
    } finally {
      await f.runService.stop()
    }
  })

  it('rejects an unknown run', async () => {
    const f = await fixture()
    try {
      await expect(f.service.requestApproval({ runId: 'nope', type: 'plan', summary: 's' }))
        .rejects.toMatchObject({ dashboardCode: 'approval.runUnknown', params: { runId: 'nope' } })
    } finally {
      await f.runService.stop()
    }
  })

  it('is idempotent per (run, type) while pending', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'idem' }, { mode: 'project', projectId: f.projectId })
      const first = await f.service.requestApproval({ runId: run.id, type: 'merge', summary: 'first' })
      const second = await f.service.requestApproval({ runId: run.id, type: 'merge', summary: 'second' })
      expect(second.id).toBe(first.id)
      expect(second.summary).toBe('first')
      // A different type on the same run is a separate object.
      const other = await f.service.requestApproval({ runId: run.id, type: 'plan', summary: 'plan' })
      expect(other.id).not.toBe(first.id)
    } finally {
      await f.runService.stop()
    }
  })

  it('supersedes a terminal object with a new pending one (audit trail retained)', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'supersede' }, { mode: 'project', projectId: f.projectId })
      const first = await f.service.requestApproval({ runId: run.id, type: 'plan', summary: 'v1' })
      await f.service.resolveApproval(first.id, 'rejected')
      const second = await f.service.requestApproval({ runId: run.id, type: 'plan', summary: 'v2' })
      expect(second.id).not.toBe(first.id)
      expect(second.status).toBe('pending')
      // Both objects retained.
      const all = f.service.listApprovals(run.id)
      expect(all).toHaveLength(2)
    } finally {
      await f.runService.stop()
    }
  })

  it('resolves with CAS, defaulting resolvedBy to dashboard', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'resolve' }, { mode: 'project', projectId: f.projectId })
      const record = await f.service.requestApproval({ runId: run.id, type: 'merge', summary: 'merge' })
      const resolved = await f.service.resolveApproval(record.id, 'approved')
      expect(resolved).toMatchObject({ status: 'approved', version: 2, resolvedBy: 'dashboard' })
      expect(resolved.resolvedAt).toBeDefined()
      expect(eventsFor(f, run.id).map(event => event.type)).toEqual([
        'run.created', 'run.approval.requested', 'run.approval.resolved',
      ])
      expect(f.emit).toHaveBeenCalledWith('dsh-projects/approval/resolved', expect.objectContaining({
        approvalId: record.id, status: 'approved', resolvedBy: 'dashboard',
      }))
    } finally {
      await f.runService.stop()
    }
  })

  it('rejects resolving a terminal object and a stale version', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'terminal' }, { mode: 'project', projectId: f.projectId })
      const record = await f.service.requestApproval({ runId: run.id, type: 'plan', summary: 's' })
      await f.service.resolveApproval(record.id, 'approved')
      await expect(f.service.resolveApproval(record.id, 'rejected'))
        .rejects.toMatchObject({ dashboardCode: 'approval.invalidStatus', params: expect.objectContaining({ status: 'approved' }) })

      const second = await f.service.requestApproval({ runId: run.id, type: 'merge', summary: 'm' })
      await expect(f.service.resolveApproval(second.id, 'approved', { expectedVersion: 99 }))
        .rejects.toMatchObject({ dashboardCode: 'approval.staleVersion' })
    } finally {
      await f.runService.stop()
    }
  })

  it('rejects an unknown id', async () => {
    const f = await fixture()
    try {
      await expect(f.service.resolveApproval('missing', 'approved'))
        .rejects.toMatchObject({ dashboardCode: 'approval.unknown' })
      await expect(f.service.expireApproval('missing'))
        .rejects.toMatchObject({ dashboardCode: 'approval.unknown' })
    } finally {
      await f.runService.stop()
    }
  })

  it('expires a pending object (the only path to expired)', async () => {
    const f = await fixture()
    try {
      const run = await f.runService.createRun({ goal: 'expire' }, { mode: 'project', projectId: f.projectId })
      const record = await f.service.requestApproval({ runId: run.id, type: 'plan', summary: 's' })
      const expired = await f.service.expireApproval(record.id)
      expect(expired).toMatchObject({ status: 'expired', version: 2, resolvedBy: 'system' })
      expect(eventsFor(f, run.id).map(event => event.type)).toEqual([
        'run.created', 'run.approval.requested', 'run.approval.resolved',
      ])
      // An expired object cannot be resolved.
      await expect(f.service.resolveApproval(record.id, 'approved'))
        .rejects.toMatchObject({ dashboardCode: 'approval.invalidStatus' })
    } finally {
      await f.runService.stop()
    }
  })

  it('lists newest first, filtered by run and project', async () => {
    const f = await fixture()
    try {
      const runA = await f.runService.createRun({ goal: 'A' }, { mode: 'project', projectId: f.projectId })
      const runB = await f.runService.createRun({ goal: 'B' }, { mode: 'project', projectId: f.projectId })
      const a1 = await f.service.requestApproval({ runId: runA.id, type: 'plan', summary: 'a1' })
      const b1 = await f.service.requestApproval({ runId: runB.id, type: 'plan', summary: 'b1' })
      const a2 = await f.service.requestApproval({ runId: runA.id, type: 'merge', summary: 'a2' })

      const forRunA = f.service.listApprovals(runA.id)
      expect(forRunA.map(record => record.id)).toEqual([a2.id, a1.id])
      const all = f.service.listApprovals()
      expect(all).toHaveLength(3)
      const byProject = f.service.listApprovals(undefined, f.projectId)
      expect(byProject).toHaveLength(3)
      expect(f.service.pendingFor(runA.id, 'plan')?.id).toBe(a1.id)
      expect(f.service.pendingFor(runA.id, 'merge')?.id).toBe(a2.id)
      expect(f.service.pendingFor(runA.id, 'git-push')).toBeUndefined()
      expect(b1.id).toBeDefined()
    } finally {
      await f.runService.stop()
    }
  })

  it('fires the onApprovalResolved hook on resolve and expire', async () => {
    const f = await fixture()
    try {
      const onResolved: ApprovalRequestRecord[] = []
      const hooked = new ApprovalService(f.context, f.catalog, f.runService, { onApprovalResolved: record => { onResolved.push(record); return Promise.resolve() } })
      hooked.start()
      const run = await f.runService.createRun({ goal: 'hook' }, { mode: 'project', projectId: f.projectId })
      const record = await hooked.requestApproval({ runId: run.id, type: 'plan', summary: 's' })
      await hooked.resolveApproval(record.id, 'approved')
      const record2 = await hooked.requestApproval({ runId: run.id, type: 'merge', summary: 'm' })
      await hooked.expireApproval(record2.id)
      expect(onResolved.map(r => r.id)).toEqual([record.id, record2.id])
      expect(onResolved[1]?.status).toBe('expired')
      hooked.stop()
    } finally {
      await f.runService.stop()
    }
  })
})
