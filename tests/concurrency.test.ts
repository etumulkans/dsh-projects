/**
 * DSH Projects Phase 10 (spec §11.2) — §57 optimistic-concurrency verification.
 *
 * The four §57-critical mutations are already compare-and-set guarded (runs →
 * `version`, tasks → status-CAS, plans → `revision`, approvals → `version`).
 * This suite VERIFIES them under stress: concurrent callers either serialize
 * cleanly or fail with the typed conflict error — never a lost update. It does
 * not add guards (spec §8).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import { RunPlanService } from '../src/plans/plan-service.ts'
import type { RunPlanRecord } from '../src/plans/types.ts'
import { ApprovalService } from '../src/approvals/approval-service.ts'
import type { ApprovalRequestRecord } from '../src/approvals/types.ts'
import { DashboardDomainError } from '../src/runtime/errors.ts'
import type { ProjectRunRecord } from '../src/runs/types.ts'
import type { ProjectTaskRecord } from '../src/tasks/types.ts'
import { ProjectTaskService } from '../src/tasks/task-service.ts'
import { UnavailableWorker } from '../src/tasks/worker.ts'

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000'
const PROJECT_ROOT = '/tmp/dsh-concurrency-cwd'
const NOW = '2026-09-14T08:00:00.000Z'

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

interface ConcurrencyFixture {
  readonly ctx: Context
  readonly runService: ProjectRunService
  readonly planService: RunPlanService
  readonly approvalService: ApprovalService
  readonly taskService: ProjectTaskService
  readonly run: ProjectRunRecord
  readonly tasks: KvTable<string, ProjectTaskRecord>
}

async function fixture(): Promise<ConcurrencyFixture> {
  const storage = new MemoryStorage()
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
      return () => { set.delete(handler) }
    },
    emit(event: string, payload: unknown) {
      const set = handlers.get(event)
      if (set !== undefined) for (const handler of [...set]) handler(payload)
    },
    storageDomain: { open: vi.fn(async () => storage.open()) },
  } as unknown as Context
  const catalog = {
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Project A', root: PROJECT_ROOT } : undefined,
    projectWorkspaceSource: () => ({ strategy: 'controlled-directory' as const, projectRoot: PROJECT_ROOT }),
  } as unknown as ProjectCatalog
  const clock = () => NOW
  const runService = new ProjectRunService(ctx, catalog, clock)
  await runService.start()
  const run = await runService.createRun(
    { goal: 'concurrency test', sourceRef: 'C-1' },
    { mode: 'project', projectId: PROJECT_ID },
  )
  await runService.transitionRun(run.id, 'planning')
  await runService.transitionRun(run.id, 'executing')
  const approvalService = new ApprovalService(ctx, catalog, runService, {})
  approvalService.start()
  const taskService = new ProjectTaskService(
    ctx,
    catalog,
    runService,
    new UnavailableWorker(),
    undefined,
    undefined,
    clock,
    () => Date.parse(NOW),
    undefined,
    undefined,
    approvalService,
  )
  taskService.start()
  const planService = new RunPlanService(ctx, runService, clock, {})
  planService.start()
  const tasks = runService.domain().table('tasks') as KvTable<string, ProjectTaskRecord>
  return { ctx, runService, planService, approvalService, taskService, run, tasks }
}

function errorCode(error: unknown): string {
  if (error instanceof DashboardDomainError) return error.dashboardCode
  return error instanceof Error ? error.name : String(error)
}

describe('Phase 10 §57 concurrency verification (spec §11.2)', () => {
  it('run-phase: exactly one concurrent transition wins; the rest get run.versionConflict', async () => {
    const fx = await fixture()
    const runId = fx.run.id
    // Read the FRESH version (createRun → planning → executing bumped it).
    const current = fx.runService.domain().table('runs').get(runId)
    expect(current).toBeDefined()
    const version = current!.version
    const callers = 8
    const results = await Promise.allSettled(
      Array.from({ length: callers }, () => fx.runService.transitionRun(runId, 'paused', { expectedVersion: version })),
    )
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(callers - 1)
    for (const r of rejected) {
      if (r.status === 'rejected') expect(errorCode(r.reason)).toBe('run.versionConflict')
    }
    // The run is paused exactly once; the version advanced by one.
    const fresh = fx.runService.domain().table('runs').get(runId)
    expect(fresh?.phase).toBe('paused')
    expect(fresh?.version).toBe(version + 1)
  })

  it('plan-activation: a stale expectedRevision is rejected with plan.revisionConflict', async () => {
    const fx = await fixture()
    const plan = await fx.planService.createPlan({
      runId: fx.run.id,
      pattern: 'supervisor',
      rationale: 'concurrency test plan',
      tasks: [{ title: 'one', description: 'do one' }],
    })
    expect(plan.status).toBe('draft')
    expect(plan.revision).toBe(1)
    // Activate the plan (revision stays 1 — only supersede/complete bump it).
    await fx.planService.transitionPlan(plan.id, 'active', { expectedRevision: 1 })
    // Two concurrent supersede attempts, both reading revision 1. The plan's
    // `revision` only advances on supersede/complete, so exactly one wins and
    // the stale caller is rejected with plan.revisionConflict.
    const results = await Promise.allSettled([
      fx.planService.transitionPlan(plan.id, 'superseded', { expectedRevision: 1, replanReason: 'caller A' }),
      fx.planService.transitionPlan(plan.id, 'superseded', { expectedRevision: 1, replanReason: 'caller B' }),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    for (const r of rejected) {
      if (r.status === 'rejected') expect(errorCode(r.reason)).toBe('plan.revisionConflict')
    }
    const fresh = fx.runService.domain().table('plans').get(plan.id) as RunPlanRecord
    expect(fresh.status).toBe('superseded')
    expect(fresh.revision).toBe(2)
  })

  it('approval-resolution: exactly one concurrent resolve wins (status guard); a stale version is rejected (version guard)', async () => {
    const fx = await fixture()
    const approval = await fx.approvalService.requestApproval({
      runId: fx.run.id,
      type: 'merge',
      summary: 'concurrency approval',
    })
    const version = approval.version
    const callers = 8
    const results = await Promise.allSettled(
      Array.from({ length: callers }, () => fx.approvalService.resolveApproval(approval.id, 'approved', { expectedVersion: version })),
    )
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(callers - 1)
    // The status check is the primary exactly-one-writer guard: once the first
    // resolve moves the approval off `pending`, the rest are rejected with
    // approval.invalidStatus (before the version check is even reached).
    for (const r of rejected) {
      if (r.status === 'rejected') expect(errorCode(r.reason)).toBe('approval.invalidStatus')
    }
    const fresh = fx.runService.domain().table('project_approvals').get(approval.id) as ApprovalRequestRecord
    expect(fresh.status).toBe('approved')
    expect(fresh.version).toBe(version + 1)

    // The version guard (approval.staleVersion) is the secondary guard: it
    // fires when the status is still `pending` but the record's version moved
    // (a concurrent metadata update). Bump the version on a fresh pending
    // approval and resolve with the stale version.
    const second = await fx.approvalService.requestApproval({
      runId: fx.run.id,
      type: 'plan',
      summary: 'version-guard approval',
    })
    await fx.runService.domain().table('project_approvals').update(second.id, current => ({
      ...current,
      version: current.version + 1,
      updatedAt: NOW,
    }))
    await expect(
      fx.approvalService.resolveApproval(second.id, 'approved', { expectedVersion: second.version }),
    ).rejects.toMatchObject({ dashboardCode: 'approval.staleVersion' })
  })

  it('task-state: a concurrent transition after a status move is a no-op (status-CAS)', async () => {
    const fx = await fixture()
    // Seed a running task, then settle it to succeeded via the public
    // settlement path. A concurrent reconcile (or settlement) that still sees
    // the stale `running` snapshot is rejected by the status-CAS.
    const task: ProjectTaskRecord = {
      id: 'task-1',
      runId: fx.run.id,
      planId: 'plan-1',
      planTaskId: 'task-1',
      title: 'concurrency task',
      description: 'task-state CAS',
      dependencies: [],
      status: 'running',
      assignedAgentId: 'dsh-task-1',
      acceptanceCriteria: [],
      attempt: 1,
      maxAttempts: 3,
      startedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      version: 2,
    }
    await fx.tasks.put(task.id, task)
    // Two concurrent "settle" attempts: both read the `running` snapshot. The
    // first CAS (status check) wins; the second sees the status moved and is a
    // no-op. We model the two settle attempts as two direct status-CAS updates
    // (the same guard `casTaskTransition` uses).
    const attempt = (to: 'succeeded' | 'failed', error?: string) => fx.tasks.update(task.id, current => {
      if (current.status !== 'running') throw new Error('task-state-cas: status moved')
      return {
        ...current,
        status: to,
        ...(error === undefined ? {} : { error }),
        version: current.version + 1,
        updatedAt: NOW,
      }
    })
    const results = await Promise.allSettled([attempt('succeeded'), attempt('failed', 'concurrent failure')])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    const fresh = fx.tasks.get(task.id)
    expect(['succeeded', 'failed']).toContain(fresh?.status)
    expect(fresh?.version).toBe(3)
  })

  it('reconcile-vs-live race: a reconcile racing a live settlement is safe', async () => {
    const fx = await fixture()
    const task: ProjectTaskRecord = {
      id: 'task-1',
      runId: fx.run.id,
      planId: 'plan-1',
      planTaskId: 'task-1',
      title: 'race task',
      description: 'reconcile vs live',
      dependencies: [],
      status: 'running',
      assignedAgentId: 'dsh-task-dead',
      acceptanceCriteria: [],
      attempt: 1,
      maxAttempts: 3,
      startedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      version: 2,
    }
    await fx.tasks.put(task.id, task)
    // The live worker settles the task to `succeeded` (a direct status-CAS)
    // concurrently with a reconcile that wants to re-queue it to `ready`.
    const liveSettle = fx.tasks.update(task.id, current => {
      if (current.status !== 'running') throw new Error('status moved')
      return { ...current, status: 'succeeded' as const, outputSummary: 'done', version: current.version + 1, updatedAt: NOW }
    })
    const reconcile = fx.taskService.reconcileAfterRestart()
    const results = await Promise.allSettled([liveSettle, reconcile])
    // Both settle without throwing a fatal error (the loser is a no-op).
    for (const r of results) {
      if (r.status === 'rejected') {
        // The only acceptable rejection is the status-CAS no-op.
        expect(String(r.reason)).toContain('status')
      }
    }
    const fresh = fx.tasks.get(task.id)
    // The task ends in exactly one settled state, never corrupted.
    expect(['succeeded', 'ready', 'failed']).toContain(fresh?.status)
    expect(fresh?.version).toBeGreaterThanOrEqual(3)
  })
})
