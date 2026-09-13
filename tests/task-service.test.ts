import { execFileSync } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import {
  type MemoryDistillationDriver,
  type MemoryDistillationDriverInput,
  type MemoryDistillationDriverResult,
  type MemoryDistillationSubmission,
} from '../src/memory/distillation.ts'
import { ProjectMemoryService } from '../src/memory/memory-service.ts'
import { RunPlanService } from '../src/plans/plan-service.ts'
import { ApprovalService } from '../src/approvals/approval-service.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { RunBudget } from '../src/runs/types.ts'
import { DashboardDomainError } from '../src/runtime/errors.ts'
import type { TokenTotals } from '../src/runtime/types.ts'
import type { ProjectTaskRecord } from '../src/tasks/types.ts'
import { ProjectTaskService, type ProjectTaskServiceHooks } from '../src/tasks/task-service.ts'
import {
  integrationBranchName,
  integrationWorktreePath,
  taskBranchName,
  taskWorktreePath,
  type CommitTaskWorkInput,
  type ProvisionTaskWorktreeInput,
  type RemoveBranchInput,
  type RemoveTaskWorktreeInput,
  TaskWorktreeManager,
} from '../src/tasks/git-workspace.ts'
import {
  MergeInOrderStrategy,
  type IntegrationInput,
  type IntegrationOutcome,
  type IntegrationStrategy,
} from '../src/tasks/integration.ts'
import { UnavailableWorker, type TaskWorker, type TaskWorkerInput, type TaskWorkerResult } from '../src/tasks/worker.ts'

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000'
const PROJECT_ROOT = '/tmp/dsh-task-cwd'
const NOW = '2026-09-12T08:00:00.000Z'

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

interface HeldWorker {
  readonly worker: TaskWorker
  readonly starts: Array<{ taskId: string; attempt: number; sessionId: string; cwd: string; branch?: string; memoryContext?: string }>
  readonly stopped: string[]
  release(taskId: string, result?: TaskWorkerResult): void
}

/** A worker whose start() resolves only when the test releases it. */
function heldWorker(): HeldWorker {
  const outcomes = new Map<string, TaskWorkerResult>()
  const pending = new Map<string, (result: TaskWorkerResult) => void>()
  const starts: Array<{ taskId: string; attempt: number; sessionId: string; cwd: string; branch?: string; memoryContext?: string }> = []
  const stopped: string[] = []
  const worker: TaskWorker = {
    kind: 'local',
    start(input: TaskWorkerInput): Promise<TaskWorkerResult> {
      starts.push({
        taskId: input.taskId,
        attempt: input.attempt,
        sessionId: input.sessionId,
        cwd: input.cwd,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.memoryContext === undefined ? {} : { memoryContext: input.memoryContext }),
      })
      return new Promise(resolve => {
        pending.set(input.taskId, result => resolve(result))
      })
    },
    stop(agentId: string): Promise<void> {
      stopped.push(agentId)
      return Promise.resolve()
    },
  }
  return {
    worker,
    starts,
    stopped,
    release(taskId: string, result?: TaskWorkerResult) {
      const resolve = pending.get(taskId)
      if (resolve === undefined) throw new Error(`no held execution for ${taskId}`)
      pending.delete(taskId)
      resolve(result ?? outcomes.get(taskId) ?? { kind: 'succeeded', summary: `done ${taskId.slice(-6)}` })
    },
  }
}

/**
 * Poll until the probe yields a "ready" value. `undefined`/`null`/`false`
 * mean "not yet". NOTE: `vi.waitFor` is not used because this Vitest version
 * resolves it after a single call for synchronous probes (verified).
 */
async function waitFor<T>(probe: () => (T | undefined) | Promise<T | undefined>, what: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// Phase 5 Git fixtures: a real temporary repository plus a recording
// worktree manager (real behavior, observable calls, injected failures).
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = []

afterEach(async () => {
  const roots = temporaryRoots.splice(0)
  for (const root of roots) {
    await rm(root, { recursive: true, force: true })
  }
})

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}

/** A real temporary git repository with a local identity and one base commit. */
async function gitRepository(): Promise<string> {
  const root = join(tmpdir(), `dsh-task-git-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`)
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  temporaryRoots.push(root)
  execFileSync('git', ['init', repo], { stdio: 'ignore', windowsHide: true })
  gitIn(repo, 'config', 'user.name', 'dsh-dashboard tests')
  gitIn(repo, 'config', 'user.email', 'dsh-dashboard@example.invalid')
  await writeFile(join(repo, 'base.txt'), 'base\n')
  gitIn(repo, 'add', 'base.txt')
  gitIn(repo, 'commit', '-m', 'fixture')
  return repo
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `refs/heads/${branch}`], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The real TaskWorktreeManager with call recording and deterministic failures. */
class RecordingWorktreeManager extends TaskWorktreeManager {
  readonly provisions: Array<{ runId: string; planTaskId: string }> = []
  readonly commits: Array<{ path: string; planTaskId: string }> = []
  readonly removals: Array<{ path: string }> = []
  readonly branchRemovals: Array<{ branch: string }> = []
  provisionFailures = 0
  commitFailures = 0

  override async provisionTaskWorktree(input: ProvisionTaskWorktreeInput) {
    this.provisions.push({ runId: input.runId, planTaskId: input.planTaskId })
    if (this.provisionFailures > 0) {
      this.provisionFailures -= 1
      throw new DashboardDomainError('task.worktreeFailed', 'injected provisioning failure')
    }
    return super.provisionTaskWorktree(input)
  }

  override async commitTaskWork(input: CommitTaskWorkInput) {
    this.commits.push({ path: input.path, planTaskId: input.planTaskId })
    if (this.commitFailures > 0) {
      this.commitFailures -= 1
      throw new DashboardDomainError('task.commitFailed', 'injected commit failure')
    }
    return super.commitTaskWork(input)
  }

  override async removeTaskWorktree(input: RemoveTaskWorktreeInput) {
    this.removals.push({ path: input.path })
    return super.removeTaskWorktree(input)
  }

  override async removeBranch(input: RemoveBranchInput) {
    this.branchRemovals.push({ branch: input.branch })
    return super.removeBranch(input)
  }
}

interface WorkerInvocation {
  readonly cwd: string
  readonly branch?: string
  readonly attempt: number
  readonly startedAt: number
  readonly finishedAt: number
}

/**
 * A worker doing real dirty work in the given cwd: it writes a per-task,
 * per-attempt file (the branch leaf distinguishes tasks), so the commit
 * contract commits a real change. `delayMs` widens the window for the
 * parallelism proofs.
 */
function writingWorker(invocations: WorkerInvocation[] = [], delayMs = 300): TaskWorker {
  return {
    kind: 'local',
    async start(input: TaskWorkerInput): Promise<TaskWorkerResult> {
      const leaf = input.branch?.split('/').pop() ?? input.taskId.slice(0, 8)
      const startedAt = Date.now()
      await new Promise(resolve => setTimeout(resolve, delayMs))
      await writeFile(join(input.cwd, `work-${leaf}-a${input.attempt}.txt`), 'work\n')
      invocations.push({
        cwd: input.cwd,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        attempt: input.attempt,
        startedAt,
        finishedAt: Date.now(),
      })
      return { kind: 'succeeded', summary: `wrote work-${leaf}-a${input.attempt}.txt` }
    },
    async stop() { /* nothing to stop */ },
  }
}

/** Every task writes the same file with task-specific content → add/add conflict. */
function sharedFileWorker(): TaskWorker {
  return {
    kind: 'local',
    async start(input: TaskWorkerInput): Promise<TaskWorkerResult> {
      const leaf = input.branch?.split('/').pop() ?? input.taskId.slice(0, 8)
      await new Promise(resolve => setTimeout(resolve, 300))
      await writeFile(join(input.cwd, 'shared.txt'), `${leaf}\n`)
      return { kind: 'succeeded', summary: 'wrote shared.txt' }
    },
    async stop() { /* nothing to stop */ },
  }
}

/**
 * First `run()` is a pure fake conflict outcome (no Git touched — proves the
 * strategy seam accepts injected outcomes); the second delegates to the real
 * merge-in-order strategy.
 */
class ConflictOnceStrategy implements IntegrationStrategy {
  readonly name = 'conflict-once'
  calls = 0
  private readonly inner = new MergeInOrderStrategy()

  async run(input: IntegrationInput): Promise<IntegrationOutcome> {
    this.calls += 1
    if (this.calls === 1) {
      return {
        status: 'conflict',
        integratedBranch: integrationBranchName(input.runId),
        merged: [],
        skipped: input.tasks.map(task => task.planTaskId),
        conflictingPaths: ['src/clash.ts'],
      }
    }
    return this.inner.run(input)
  }
}

interface Fixture {
  ctx: Context
  runService: ProjectRunService
  planService: RunPlanService
  taskService: ProjectTaskService
  held: HeldWorker
  emit: ReturnType<typeof vi.fn>
  runId: string
  /** Phase 6: the fixture's fake catalog (memory services borrow it). */
  catalog: ProjectCatalog
  /** Phase 6: the fixture's memory service, when `overrides.memoryFactory` was given. */
  memory?: ProjectMemoryService | undefined
  /** Phase 7: the fixture's approval service, when `overrides.withApproval` was given. */
  approvalService?: ApprovalService | undefined
}

async function fixture(overrides: {
  readonly maxConcurrentAgents?: number
  readonly worker?: TaskWorker
  readonly retryClock?: () => number
  /** Phase 5: real TaskWorktreeManager for Git-isolation tests (absent = Phase 4 behavior). */
  readonly worktreeManager?: TaskWorktreeManager
  /** Phase 5: deterministic integration strategy (absent = service default merge-in-order). */
  readonly integrationStrategy?: IntegrationStrategy
  /** Phase 5: the run's project workspace source (absent = controlled-directory). */
  readonly workspaceSource?: { readonly strategy: 'worktree'; readonly projectRoot: string; readonly repositoryRoot: string }
  /** Phase 6: build the memory service for the task service (absent = no memory). */
  readonly memoryFactory?: (ctx: Context, catalog: ProjectCatalog, runService: ProjectRunService) => ProjectMemoryService
  /** Phase 6: service hooks (e.g. onRunSucceeded for fire-and-forget distillation). */
  readonly hooks?: ProjectTaskServiceHooks
  /** Phase 7: build an approval service for the merge gate (absent = no merge gate). */
  readonly withApproval?: boolean
  /** Phase 7: the run's budget, stamped directly on the record after creation. */
  readonly budget?: RunBudget
} = {}): Promise<Fixture> {
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
      return () => { set.delete(handler) }
    },
    emit(event: string, payload: unknown) {
      emit(event, payload)
      const set = handlers.get(event)
      if (set !== undefined) for (const handler of [...set]) handler(payload)
    },
    storageDomain: { open: vi.fn(async () => storage.open()) },
  } as unknown as Context
  const catalog = {
    project: (id: string) => id === PROJECT_ID ? { id, name: 'Project A', root: PROJECT_ROOT } : undefined,
    projectWorkspaceSource: (id: string) => id === PROJECT_ID
      ? overrides.workspaceSource
        ?? { strategy: 'controlled-directory' as const, projectRoot: PROJECT_ROOT }
      : undefined,
  } as unknown as ProjectCatalog
  const clock = () => NOW
  const runService = new ProjectRunService(ctx, catalog, clock)
  await runService.start()
  const run = await runService.createRun(
    { goal: 'task service test', sourceRef: 'T-1' },
    { mode: 'project', projectId: PROJECT_ID },
  )
  await runService.transitionRun(run.id, 'planning')
  await runService.transitionRun(run.id, 'executing')
  const held = overrides.worker === undefined ? heldWorker() : {
    worker: overrides.worker,
    starts: [],
    stopped: [],
    release: () => undefined,
  }
  const memory = overrides.memoryFactory === undefined ? undefined : overrides.memoryFactory(ctx, catalog, runService)
  if (memory !== undefined) memory.start()
  const approvalService = overrides.withApproval === true ? new ApprovalService(ctx, catalog, runService, {
    // Mirror the composition hook (src/index.ts): a resolved merge approval
    // moves the run off the gate — approved → integrating, rejected → blocked.
    onApprovalResolved: async record => {
      if (record.type !== 'merge') return
      const target = record.status === 'approved' ? 'integrating' : 'blocked'
      try {
        await runService.transitionRun(record.runId, target)
      } catch {
        /* guard miss = logged no-op, matching the composition hook */
      }
    },
  }) : undefined
  if (approvalService !== undefined) approvalService.start()
  const taskService = new ProjectTaskService(
    ctx,
    catalog,
    runService,
    held.worker,
    overrides.worktreeManager,
    overrides.integrationStrategy,
    clock,
    overrides.retryClock ?? (() => Date.now()),
    memory,
    overrides.hooks,
    approvalService,
  )
  taskService.start()
  const planService = new RunPlanService(ctx, runService, clock, {
    onPlanStatus: event => taskService.handlePlanStatus(event),
  })
  planService.start()
  const maxConcurrentAgents = overrides.maxConcurrentAgents
  if (maxConcurrentAgents !== undefined) {
    await runService.domain().table('runs').update(run.id, current => ({
      ...current,
      maxConcurrentAgents,
      version: current.version + 1,
    }))
  }
  if (overrides.budget !== undefined) {
    await runService.domain().table('runs').update(run.id, current => ({
      ...current,
      budget: overrides.budget,
      version: current.version + 1,
    }))
  }
  return { ctx, runService, planService, taskService, held, emit, runId: run.id, catalog, memory, approvalService }
}

describe('ProjectTaskService (spec §7)', () => {
  it('rejects calls before start with task.notStarted', async () => {
    const storage = new MemoryStorage()
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emit: vi.fn(),
      on: vi.fn(() => () => undefined),
      storageDomain: { open: vi.fn(async () => storage.open()) },
    } as unknown as Context
    const catalog = { project: () => undefined } as unknown as ProjectCatalog
    const runService = new ProjectRunService(ctx, catalog, () => NOW)
    await runService.start()
    const service = new ProjectTaskService(ctx, catalog, runService, new UnavailableWorker(), undefined, undefined, () => NOW)
    await expect(service.taskRetry('unknown')).rejects.toMatchObject({ dashboardCode: 'task.notStarted' })
    expect(() => service.taskList('run-1')).toThrow(/task\.notStarted|not started/i)
    await runService.stop()
  })

  it('materializes the active plan as pending tasks with mapped dependencies', async () => {
    const fx = await fixture()
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'supervisor',
      rationale: 'three-task chain',
      tasks: [
        { title: 'first', description: 'a', dependencies: [] },
        { title: 'second', description: 'b', dependencies: ['t1'], role: 'worker' },
        { title: 'third', description: 'c', dependencies: ['t2'] },
      ],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    // the materialization tick has started the first (ready) task; hold it
    const firstStart = await waitFor(() => fx.held.starts.at(-1), 'first task start')
    const tasks = fx.taskService.taskList(fx.runId)
    expect(tasks).toHaveLength(3)
    const byPlanId = new Map(tasks.map(task => [task.planTaskId, task]))
    // list order is (createdAt, id) — assert per task, not by position
    expect(byPlanId.get('t1')).toMatchObject({ status: 'running', dependencies: [] })
    expect(byPlanId.get('t2')).toMatchObject({ status: 'pending', role: 'worker' })
    expect(byPlanId.get('t3')).toMatchObject({ status: 'pending' })
    expect(byPlanId.get('t2')!.dependencies).toEqual([byPlanId.get('t1')!.id])
    expect(byPlanId.get('t3')!.dependencies).toEqual([byPlanId.get('t2')!.id])
    expect(fx.taskService.taskCounts(fx.runId)).toMatchObject({ total: 3, running: 1, pending: 2 })
    const detail = await fx.runService.runDetail(fx.runId)
    expect(detail.events.map(event => event.type)).toContain('tasks.materialized')
    expect(fx.emit).toHaveBeenCalledWith('dsh-projects/tasks/materialized', expect.objectContaining({
      runId: fx.runId,
      planId: plan.id,
      taskCount: 3,
    }))
    // release the chain to completion (also proves the wave ordering)
    fx.held.release(firstStart!.taskId, { kind: 'succeeded', summary: 'first done' })
    const secondStart = await waitFor(() => fx.held.starts.at(1), 'second task start')
    fx.held.release(secondStart!.taskId, { kind: 'succeeded', summary: 'second done' })
    const thirdStart = await waitFor(() => fx.held.starts.at(2), 'third task start')
    fx.held.release(thirdStart!.taskId, { kind: 'succeeded', summary: 'third done' })
    await waitFor(() => fx.taskService.taskList(fx.runId).every(task => task.status === 'succeeded'), 'all three succeeded')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('does not start held tasks when the worker holds them: dependency gating + completion', async () => {
    const fx = await fixture()
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'two-task chain',
      tasks: [
        { title: 'a', description: 'a' },
        { title: 'b', description: 'b', dependencies: ['t1'] },
      ],
    })
    const activation = fx.planService.transitionPlan(plan.id, 'active')
    // materialization ends with a tick that starts the first (ready) task.
    const firstStart = await waitFor<{ taskId: string; attempt: number; sessionId: string }>(
      () => fx.held.starts.at(-1),
      'first task start',
    )
    expect(firstStart).toMatchObject({ attempt: 1 })
    const firstId = firstStart.taskId
    expect(fx.held.starts).toHaveLength(1) // the dependent stays pending
    // while running: task.started event + running status
    const running = fx.taskService.taskList(fx.runId)
    expect(running.find(task => task.id === firstId)).toMatchObject({ status: 'running', attempt: 1 })
    expect(running.find(task => task.id !== firstId)).toMatchObject({ status: 'pending' })
    fx.held.release(firstId, { kind: 'succeeded', summary: 'first done', agentId: firstStart.sessionId })
    await activation
    await waitFor(() => {
      const current = fx.taskService.taskList(fx.runId).find(task => task.id === firstId)!
      return current.status === 'succeeded' ? current : undefined
    }, 'first task settled')
    const settled = fx.taskService.taskList(fx.runId)
    expect(settled.find(task => task.id === firstId)).toMatchObject({ status: 'succeeded', outputSummary: 'first done' })
    // dependency recovery: the second task became ready and was picked up by the tick
    const secondStart = await waitFor<{ taskId: string; attempt: number; sessionId: string }>(
      () => fx.held.starts.at(1),
      'second task start',
    )
    expect(secondStart.attempt).toBe(1)
    fx.held.release(secondStart.taskId, { kind: 'succeeded', summary: 'second done' })
    await waitFor(() => {
      const tasks = fx.taskService.taskList(fx.runId)
      return tasks.every(task => task.status === 'succeeded')
    }, 'all succeeded')
    const detail = await fx.runService.runDetail(fx.runId)
    expect(detail.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'tasks.materialized', 'task.started', 'task.completed', 'task.ready', 'task.started', 'task.completed',
    ]))
    // Phase 5 owns the all-done coupling (spec §3.3): this fixture's project
    // has no Git source, so the run moves executing -> finalizing ->
    // succeeded as the completion pipeline advances it.
    await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded', 10_000)
    const after = fx.runService.domain().table('runs').get(fx.runId)!
    expect(after.phase).toBe('succeeded')
    expect(after.resultSummary).toBeDefined()
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 15_000)

  it('retries a failed task with backoff until the attempt budget is exhausted', async () => {
    let clockMs = Date.parse('2026-09-12T08:00:00.000Z')
    const advance = (ms: number): void => { clockMs += ms }
    const fx = await fixture({ retryClock: () => clockMs })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'flaky single task',
      tasks: [{ title: 'flaky', description: 'fails twice' }],
    })
    const activation = fx.planService.transitionPlan(plan.id, 'active')
    const first = await waitFor(() => fx.held.starts.at(-1), 'first attempt')
    fx.held.release(first!.taskId, { kind: 'failed', error: 'first failure' })
    await activation
    // settlement re-queues the task (running → ready); wait for it
    await waitFor(() => {
      const current = fx.taskService.taskList(fx.runId)[0]!
      return current.status === 'ready' ? current : undefined
    }, 're-queued ready')
    const task = fx.taskService.taskList(fx.runId)[0]!
    expect(task).toMatchObject({ status: 'ready', attempt: 1 })
    // backoff: failureRetryDelay(1) = 10_000 ms from updatedAt
    expect(fx.held.starts).toHaveLength(1)
    await fx.taskService.tick()
    expect(fx.held.starts).toHaveLength(1) // still in backoff
    advance(10_001)
    await fx.taskService.tick()
    const second = await waitFor(() => fx.held.starts.at(1), 'second attempt')
    expect(second!.attempt).toBe(2)
    fx.held.release(second!.taskId, { kind: 'failed', error: 'second failure' })
    await waitFor(() => {
      const current = fx.taskService.taskList(fx.runId)[0]!
      return current.status === 'ready' ? current : undefined
    }, 're-queued after second failure')
    // failureRetryDelay(2) = 20_000 ms
    advance(20_001)
    await fx.taskService.tick()
    const third = await waitFor(() => fx.held.starts.at(2), 'third attempt')
    expect(third!.attempt).toBe(3)
    fx.held.release(third!.taskId, { kind: 'failed', error: 'third failure' })
    await waitFor(() => {
      const current = fx.taskService.taskList(fx.runId)[0]!
      return current.status === 'failed'
    }, 'exhausted to failed')
    const exhausted = fx.taskService.taskList(fx.runId)[0]!
    expect(exhausted).toMatchObject({ status: 'failed', error: 'third failure', attempt: 3 })
    const detail = await fx.runService.runDetail(fx.runId)
    expect(detail.events.some(event => event.type === 'task.failed')).toBe(true)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('blocks dependents on a failed task and couples the run to blocked when the DAG is dead', async () => {
    const fx = await fixture()
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'supervisor',
      rationale: 'one failure kills the branch',
      tasks: [
        { title: 'bad', description: 'always fails' },
        { title: 'dependent', description: 'waits', dependencies: ['t1'] },
      ],
    })
    // exhaust the attempts of the bad task
    const activation = fx.planService.transitionPlan(plan.id, 'active')
    const first = await waitFor(() => fx.held.starts.at(-1), 'first attempt')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fx.held.release(first!.taskId, { kind: 'failed', error: `failure ${attempt}` })
      // wait for the next attempt start (backoff elapses instantly: retryClock = Date.now()
      // and the updatedAt clock is frozen in the past)
      if (attempt < 3) {
        await waitFor(() => fx.held.starts.at(attempt), `attempt ${attempt + 1}`)
      }
    }
    await activation
    await waitFor(() => {
      const tasks = fx.taskService.taskList(fx.runId)
      return tasks.find(task => task.planTaskId === 't2')?.status === 'blocked'
    }, 'dependent blocked', 5_000)
    // dead DAG: run executing + all live blocked + a failed task → run blocked
    await waitFor(() => {
      const run = fx.runService.domain().table('runs').get(fx.runId)!
      return run.phase === 'blocked' ? run : undefined
    }, 'run blocked', 5_000)
    const run = fx.runService.domain().table('runs').get(fx.runId)!
    expect(run.phase).toBe('blocked')
    expect(run.suspendedFrom).toBe('executing') // retryable via the existing resume path
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('retires non-terminal tasks when the run is canceled', async () => {
    const fx = await fixture()
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'two tasks, one running',
      tasks: [
        { title: 'a', description: 'a' },
        { title: 'b', description: 'b', dependencies: ['t1'] },
      ],
    })
    const activation = fx.planService.transitionPlan(plan.id, 'active')
    const first = await waitFor(() => fx.held.starts.at(-1), 'first start')
    expect(first!.sessionId).toMatch(/^dsh-task-/)
    // emit the run phase-changed event the Run service emits on cancel
    await fx.runService.transitionRun(fx.runId, 'canceled')
    await waitFor(() => {
      const tasks = fx.taskService.taskList(fx.runId)
      return tasks.every(task => task.status === 'canceled')
    }, 'all tasks canceled')
    const tasks = fx.taskService.taskList(fx.runId)
    expect(tasks.map(task => task.status)).toEqual(['canceled', 'canceled'])
    expect(fx.held.stopped).toEqual([first!.sessionId]) // the running task's worker was stopped
    // the held execution is released late; settlement sees the canceled status
    // and is a stale no-op
    fx.held.release(first!.taskId, { kind: 'succeeded', summary: 'late result' })
    await activation
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('taskRetry: re-queues failed tasks, rejects non-failed and unknown ids', async () => {
    const fx = await fixture()
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'retry surface',
      tasks: [{ title: 'a', description: 'a' }],
    })
    const activation = fx.planService.transitionPlan(plan.id, 'active')
    // Exhaust the attempts (the default backoff elapses instantly: the frozen
    // updatedAt clock is in the past of retryClock = Date.now()).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitFor(() => fx.held.starts.at(attempt - 1), `attempt ${attempt}`)
      fx.held.release(fx.held.starts[attempt - 1]!.taskId, { kind: 'failed', error: `failure ${attempt}` })
    }
    await activation
    await waitFor(() => {
      const tasks = fx.taskService.taskList(fx.runId)
      return tasks[0]!.status === 'failed' ? tasks[0] : undefined
    }, 'exhausted to failed')
    const failedTask = fx.taskService.taskList(fx.runId)[0]!
    expect(failedTask.attempt).toBe(3)
    // failed id → ready, then picked up on the next tick (backoff elapses instantly)
    // If the exhaustion already dead-locked the run, the operator resumes it
    // via the existing resume path first, so the retry tick can pick the task
    // up (the tick only executes for runs in `executing`).
    const maybeBlocked = fx.runService.domain().table('runs').get(fx.runId)!
    if (maybeBlocked.phase === 'blocked') {
      await fx.runService.transitionRun(fx.runId, 'executing')
    }
    const retried = await fx.taskService.taskRetry(failedTask.id)
    expect(retried.status).toBe('ready')
    const restart = await waitFor(() => fx.held.starts.at(3), 'retry start')
    expect(restart!.taskId).toBe(failedTask.id)
    expect(restart!.attempt).toBe(4)
    fx.held.release(restart!.taskId, { kind: 'succeeded', summary: 'recovered' })
    await waitFor(() => {
      const current = fx.taskService.taskList(fx.runId)[0]!
      return current.status === 'succeeded' ? current : undefined
    }, 'recovered to succeeded')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('taskRetry: rejects non-failed tasks and unknown ids with stable codes', async () => {
    const fx = await fixture({ worker: new UnavailableWorker() })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'no runtime, tasks stay scheduled',
      tasks: [{ title: 'a', description: 'a' }],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    const task = fx.taskService.taskList(fx.runId)[0]!
    expect(task.status).toBe('ready')
    await expect(fx.taskService.taskRetry('00000000-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ dashboardCode: 'task.unknown' })
    await expect(fx.taskService.taskRetry(task.id))
      .rejects.toMatchObject({ dashboardCode: 'task.retryNotAllowed' })
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('respects the run concurrency limit (default 1, override 2)', async () => {
    const fx = await fixture({ maxConcurrentAgents: 2 })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'two independent tasks',
      tasks: [
        { title: 'a', description: 'a' },
        { title: 'b', description: 'b' },
      ],
    })
    const activation = fx.planService.transitionPlan(plan.id, 'active')
    await waitFor(() => fx.held.starts.length >= 2 ? fx.held.starts : undefined, 'both starts')
    expect(fx.held.starts).toHaveLength(2)
    for (const start of fx.held.starts) {
      fx.held.release(start.taskId, { kind: 'succeeded', summary: 'ok' })
    }
    await activation
    await waitFor(() => fx.taskService.taskList(fx.runId).every(task => task.status === 'succeeded'), 'both succeeded')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('leaves tasks scheduled without executing when the worker is unavailable', async () => {
    const fx = await fixture({ worker: new UnavailableWorker() })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'no runtime mounted',
      tasks: [{ title: 'a', description: 'a' }],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    await fx.taskService.tick()
    const tasks = fx.taskService.taskList(fx.runId)
    expect(tasks).toHaveLength(1)
    // dependency transitions still apply (honest scheduling state); no
    // execution happens and no fake identity is assigned
    expect(tasks[0]!.status).toBe('ready')
    expect(tasks[0]!.assignedAgentId).toBeUndefined()
    expect(fx.taskService.workerKind()).toBe('unavailable')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('materialization rejects an invalid dependency graph with task.dagInvalid (defensive)', async () => {
    const fx = await fixture()
    // Plant a plan record with a cyclic dependency directly (the plan service
    // would have rejected it at creation; this exercises the service guard).
    const run = fx.runService.domain().table('runs').get(fx.runId)!
    const now = NOW
    const cyclicPlan = {
      id: '11111111-1111-4111-8111-111111111111',
      runId: fx.runId,
      projectId: PROJECT_ID,
      version: 1,
      pattern: 'direct',
      rationale: 'cyclic',
      assumptions: [],
      successCriteria: [],
      tasks: [
        { id: 't1', title: 'a', description: 'a', dependencies: ['t2'], acceptanceCriteria: [] },
        { id: 't2', title: 'b', description: 'b', dependencies: ['t1'], acceptanceCriteria: [] },
      ],
      status: 'active',
      createdAt: now,
      revision: 1,
    }
    await fx.runService.domain().table('plans').put(cyclicPlan.id, cyclicPlan as never)
    await fx.runService.domain().table('runs').update(run.id, current => ({
      ...current,
      activePlanId: cyclicPlan.id,
      version: current.version + 1,
    }))
    await expect(fx.taskService.handlePlanStatus({
      runId: fx.runId,
      projectId: PROJECT_ID,
      planId: cyclicPlan.id,
      version: 1,
      from: 'draft',
      to: 'active',
      at: now,
    })).rejects.toMatchObject({ dashboardCode: 'task.dagInvalid' })
    expect(fx.taskService.taskList(fx.runId)).toHaveLength(0)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

  it('retires the old tasks when a new plan version is activated', async () => {
    const fx = await fixture()
    const v1 = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'version one',
      tasks: [{ title: 'old', description: 'old' }],
    })
    const activation = fx.planService.transitionPlan(v1.id, 'active')
    const first = await waitFor(() => fx.held.starts.at(-1), 'old task start')
    // supersede while the old task is still running
    const v2 = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'version two',
      replanReason: 'scope changed',
      tasks: [{ title: 'new', description: 'new' }],
    })
    const second = fx.planService.transitionPlan(v2.id, 'active')
    // the v2 activation retires the old (running) task and materializes the new
    // one, whose materialization tick immediately starts it (held)
    const restart = await waitFor(() => fx.held.starts.at(1), 'new task start')
    await waitFor(() => {
      const tasks = fx.taskService.taskList(fx.runId)
      return tasks.find(task => task.planId === v1.id)?.status === 'canceled'
    }, 'old task canceled')
    const tasks = fx.taskService.taskList(fx.runId)
    expect(tasks).toHaveLength(2) // old (canceled) + new (running, held)
    expect(tasks.find(task => task.planId === v1.id)).toMatchObject({ status: 'canceled' })
    expect(tasks.find(task => task.planId === v2.id)).toMatchObject({ status: 'running' })
    expect(fx.held.stopped).toEqual([first!.sessionId])
    fx.held.release(first!.taskId, { kind: 'succeeded', summary: 'late result' }) // stale: must be ignored
    fx.held.release(restart!.taskId, { kind: 'succeeded', summary: 'new done' })
    await activation
    await second
    await waitFor(() => {
      const tasks = fx.taskService.taskList(fx.runId)
      return tasks.filter(task => task.planId === v2.id).every(task => task.status === 'succeeded')
    }, 'new task succeeded')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })
})

describe('ProjectTaskService Phase 5 Git pipeline (spec §6/§7/§12)', () => {
  it('provisions a worktree per task, commits on success, integrates, verifies, and finalizes to succeeded', async () => {
    const repo = await gitRepository()
    const manager = new RecordingWorktreeManager()
    const invocations: WorkerInvocation[] = []
    const fx = await fixture({
      worktreeManager: manager,
      worker: writingWorker(invocations),
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'git pipeline',
      tasks: [{ title: 'a', description: 'a' }],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    await waitFor(() => (invocations.length === 1 ? invocations[0] : undefined), 'worker dispatch', 10_000)
    // the worker ran in the per-task worktree on the task branch
    expect(invocations[0]!.cwd).toContain(join('worktree', `run-${fx.runId.slice(0, 8)}`, 't1'))
    expect(invocations[0]!.branch).toBe(taskBranchName(fx.runId, 't1'))
    // the task record carries the Git identity (the view omits the internal
    // workspaceId, so the canonical path is checked on the raw record)
    const task = fx.taskService.taskList(fx.runId)[0]!
    expect(task.branch).toBe(taskBranchName(fx.runId, 't1'))
    expect(task.baseCommit).toBeDefined()
    const taskRecord = fx.runService.domain().table('tasks').get(task.id) as ProjectTaskRecord
    expect(taskRecord.workspaceId).toBe(invocations[0]!.cwd)
    // the commit contract ran: dirty tree → real commit → headCommit ≠ baseCommit
    await waitFor(() => {
      const t = fx.taskService.taskList(fx.runId)[0]!
      return t.status === 'succeeded' && t.headCommit !== undefined && t.headCommit !== t.baseCommit ? t : undefined
    }, 'task succeeded with a commit', 20_000)
    expect(manager.commits).toHaveLength(1)
    // the completion pipeline: integrating → validating → finalizing → succeeded
    const run = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded', 40_000)
    expect(run.integrationBranch).toBe(integrationBranchName(fx.runId))
    expect(run.integrationHead).toBeDefined()
    expect(run.resultSummary).toBe(`integrated branch ${integrationBranchName(fx.runId)} @ ${run.integrationHead!.slice(0, 8)}`)
    const detail = await fx.runService.runDetail(fx.runId)
    const events = detail.events.map(event => event.type)
    expect(events).toContain('run.integration.started')
    expect(events).toContain('run.integration.completed')
    // finalization cleaned up: task branch + both worktrees gone; the
    // integration branch is kept for the operator
    expect(manager.branchRemovals).toEqual([{ branch: taskBranchName(fx.runId, 't1') }])
    expect(branchExists(repo, taskBranchName(fx.runId, 't1'))).toBe(false)
    expect(branchExists(repo, integrationBranchName(fx.runId))).toBe(true)
    expect(await pathExists(taskWorktreePath(repo, fx.runId, 't1'))).toBe(false)
    expect(await pathExists(integrationWorktreePath(repo, fx.runId))).toBe(false)
    // the succeeded task's worktree was already removed right after its commit
    expect(manager.removals.map(entry => entry.path)).toContain(invocations[0]!.cwd)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 45_000)

  it('blocks on an integration conflict and resumes to succeeded on the next attempt', async () => {
    const repo = await gitRepository()
    const strategy = new ConflictOnceStrategy()
    const fx = await fixture({
      worktreeManager: new RecordingWorktreeManager(),
      worker: writingWorker(),
      integrationStrategy: strategy,
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'conflict then resume',
      tasks: [
        { title: 'a', description: 'a' },
        { title: 'b', description: 'b' },
      ],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    // first attempt: the fake conflict → blocked, resumable from `integrating`
    const blocked = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'blocked' ? current : undefined
    }, 'run blocked', 25_000)
    expect(blocked.suspendedFrom).toBe('integrating')
    // the record carries no error on `blocked` (only `failed` transitions
    // persist one); the conflict detail lives on the run event
    expect(strategy.calls).toBe(1)
    let detail = await fx.runService.runDetail(fx.runId)
    const failedEvents = detail.events.filter(event => event.type === 'run.integration.failed')
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]!.detail).toContain('src/clash.ts')
    // the task branches survive the blocked attempt (a fresh re-merge uses them)
    expect(branchExists(repo, taskBranchName(fx.runId, 't1'))).toBe(true)
    expect(branchExists(repo, taskBranchName(fx.runId, 't2'))).toBe(true)
    // the operator resumes via the existing run transition path; the second
    // attempt is a real merge
    await fx.runService.transitionRun(fx.runId, 'integrating')
    const run = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded after resume', 40_000)
    expect(strategy.calls).toBe(2)
    expect(run.integrationBranch).toBe(integrationBranchName(fx.runId))
    detail = await fx.runService.runDetail(fx.runId)
    const started = detail.events.filter(event => event.type === 'run.integration.started')
    const completed = detail.events.filter(event => event.type === 'run.integration.completed')
    expect(started).toHaveLength(2)
    expect(completed).toHaveLength(1)
    expect(branchExists(repo, integrationBranchName(fx.runId))).toBe(true)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 45_000)

  it('advances from a persisted integration-completed event without re-merging (crash safety)', async () => {
    const repo = await gitRepository()
    const fx = await fixture({
      worktreeManager: new RecordingWorktreeManager(),
      worker: writingWorker(),
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    // Simulate a crash between the persisted `run.integration.completed` event
    // and the phase move: reject the first transition to `validating`.
    let rejectValidatingOnce = true
    const original = fx.runService.transitionRun.bind(fx.runService)
    const spy = vi.spyOn(fx.runService, 'transitionRun').mockImplementation(((runId, to, options) => {
      if (rejectValidatingOnce && to === 'validating') {
        rejectValidatingOnce = false
        return Promise.reject(new Error('simulated crash before the phase move'))
      }
      return original(runId, to, options)
    }) as typeof fx.runService.transitionRun)
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'crash safety',
      tasks: [{ title: 'a', description: 'a' }],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    const run = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded after simulated crash', 40_000)
    spy.mockRestore()
    expect(run.integrationBranch).toBe(integrationBranchName(fx.runId))
    const detail = await fx.runService.runDetail(fx.runId)
    const started = detail.events.filter(event => event.type === 'run.integration.started')
    const completed = detail.events.filter(event => event.type === 'run.integration.completed')
    // exactly one merge attempt: the crash-safety leg verified the persisted
    // integration and advanced without re-running the strategy
    expect(started).toHaveLength(1)
    expect(completed).toHaveLength(1)
    expect(branchExists(repo, integrationBranchName(fx.runId))).toBe(true)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 45_000)

  it('settles a provisioning failure as a retryable failure and re-provisions on retry', async () => {
    const repo = await gitRepository()
    const manager = new RecordingWorktreeManager()
    manager.provisionFailures = 1
    const fx = await fixture({
      worktreeManager: manager,
      worker: writingWorker(),
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'provisioning failure',
      tasks: [{ title: 'a', description: 'a' }],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    // attempt 1: provisioning fails → synthetic failed result → `ready` (retryable)
    await waitFor(() => {
      const t = fx.taskService.taskList(fx.runId)[0]!
      return t.attempt >= 2 || t.status === 'succeeded' ? t : undefined
    }, 'retry started', 25_000)
    expect(manager.provisions).toHaveLength(2)
    expect(manager.provisions[0]).toEqual({ runId: fx.runId, planTaskId: 't1' })
    // attempt 2 succeeds end-to-end through the pipeline
    const run = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded', 40_000)
    expect(run.integrationBranch).toBe(integrationBranchName(fx.runId))
    const detail = await fx.runService.runDetail(fx.runId)
    // one initial ready (dependency transition) plus one retry-ready
    const retryEvents = detail.events.filter(
      event => event.type === 'task.ready' && (event.detail ?? '').includes('retry after failure'),
    )
    expect(retryEvents).toHaveLength(1)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 45_000)

  it('keeps the worktree on a commit failure and reuses it without reset on retry', async () => {
    const repo = await gitRepository()
    const manager = new RecordingWorktreeManager()
    manager.commitFailures = 1
    const fx = await fixture({
      worktreeManager: manager,
      worker: writingWorker(),
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'commit failure',
      tasks: [{ title: 'a', description: 'a' }],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    const run = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded', 45_000)
    expect(run.integrationBranch).toBe(integrationBranchName(fx.runId))
    // both attempts provisioned (the second was an idempotent reuse) and the
    // commit ran on both attempts (the first injected, the second real)
    expect(manager.provisions).toHaveLength(2)
    expect(manager.commits).toHaveLength(2)
    const task = fx.taskService.taskList(fx.runId)[0]!
    expect(task.attempt).toBe(2)
    expect(task.headCommit).toBeDefined()
    expect(task.headCommit).not.toBe(task.baseCommit)
    // the reused worktree kept attempt 1's uncommitted file: the integrated
    // tree contains the files of both attempts (no reset on reuse)
    const files = gitIn(repo, 'ls-tree', '-r', '--name-only', integrationBranchName(fx.runId)).split('\n').filter(Boolean)
    expect(files).toContain('work-t1-a1.txt')
    expect(files).toContain('work-t1-a2.txt')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 60_000)

  it('keeps Phase 4 behavior for non-Git projects even when a manager is mounted', async () => {
    const manager = new RecordingWorktreeManager()
    const fx = await fixture({ worktreeManager: manager })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'non-git with manager',
      tasks: [{ title: 'a', description: 'a' }],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    const first = await waitFor(() => fx.held.starts.at(-1), 'task start')
    expect(first!.cwd).toBe(PROJECT_ROOT) // the shared tree — no worktree
    expect(first!.branch).toBeUndefined()
    fx.held.release(first!.taskId, { kind: 'succeeded', summary: 'done' })
    const run = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded', 10_000)
    expect(run.resultSummary).toBe('all tasks succeeded (no Git isolation)')
    expect(run.integrationBranch).toBeUndefined()
    const task = fx.taskService.taskList(fx.runId)[0]!
    expect(task).toMatchObject({ status: 'succeeded' })
    expect(task.branch).toBeUndefined()
    expect(task.headCommit).toBeUndefined()
    const taskRecord = fx.runService.domain().table('tasks').get(task.id) as ProjectTaskRecord
    expect(taskRecord.workspaceId).toBeUndefined()
    // the manager was never touched
    expect(manager.provisions).toHaveLength(0)
    expect(manager.commits).toHaveLength(0)
    expect(manager.removals).toHaveLength(0)
    expect(manager.branchRemovals).toHaveLength(0)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 15_000)

  it('integrates disjoint parallel tasks (maxConcurrentAgents 2) into one branch', async () => {
    const repo = await gitRepository()
    const manager = new RecordingWorktreeManager()
    const invocations: WorkerInvocation[] = []
    const fx = await fixture({
      maxConcurrentAgents: 2,
      worktreeManager: manager,
      worker: writingWorker(invocations, 800),
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'parallel disjoint',
      tasks: [
        { title: 'a', description: 'a' },
        { title: 'b', description: 'b' },
      ],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    await waitFor(() => (invocations.length === 2 ? invocations.length : undefined), 'both dispatched', 10_000)
    // real parallelism in separate worktrees: the second task started before
    // the first finished
    const starts = invocations.map(invocation => invocation.startedAt).sort((a, b) => a - b)
    const finishes = invocations.map(invocation => invocation.finishedAt).sort((a, b) => a - b)
    expect(starts[1]!).toBeLessThan(finishes[0]!)
    expect(new Set(invocations.map(invocation => invocation.cwd)).size).toBe(2)
    expect(invocations.map(invocation => invocation.branch).sort()).toEqual(
      [taskBranchName(fx.runId, 't1'), taskBranchName(fx.runId, 't2')].sort(),
    )
    const run = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'succeeded' ? current : undefined
    }, 'run succeeded', 40_000)
    expect(run.integrationBranch).toBe(integrationBranchName(fx.runId))
    // the integration branch contains both tasks' files
    const files = gitIn(repo, 'ls-tree', '-r', '--name-only', integrationBranchName(fx.runId)).split('\n').filter(Boolean)
    expect(files).toContain('work-t1-a1.txt')
    expect(files).toContain('work-t2-a1.txt')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 45_000)

  it('lets parallel tasks with conflicting edits succeed in their worktrees and blocks at integration', async () => {
    const repo = await gitRepository()
    const fx = await fixture({
      maxConcurrentAgents: 2,
      worktreeManager: new RecordingWorktreeManager(),
      worker: sharedFileWorker(),
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    const plan = await fx.planService.createPlan({
      runId: fx.runId,
      pattern: 'direct',
      rationale: 'parallel conflict',
      tasks: [
        { title: 'a', description: 'a' },
        { title: 'b', description: 'b' },
      ],
    })
    await fx.planService.transitionPlan(plan.id, 'active')
    const blocked = await waitFor(() => {
      const current = fx.runService.domain().table('runs').get(fx.runId)!
      return current.phase === 'blocked' ? current : undefined
    }, 'run blocked', 30_000)
    // both tasks succeeded in their isolated worktrees (the Phase 4
    // concurrency rationale); the conflict only surfaces at integration
    const tasks = fx.taskService.taskList(fx.runId)
    expect(tasks.every(task => task.status === 'succeeded')).toBe(true)
    expect(blocked.suspendedFrom).toBe('integrating')
    const detail = await fx.runService.runDetail(fx.runId)
    const failed = detail.events.filter(event => event.type === 'run.integration.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.detail).toContain('shared.txt')
    // the conflicted merge was aborted: the task branches are intact for a
    // resumed re-merge
    expect(branchExists(repo, taskBranchName(fx.runId, 't1'))).toBe(true)
    expect(branchExists(repo, taskBranchName(fx.runId, 't2'))).toBe(true)
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  }, 45_000)
})

// ---------------------------------------------------------------------------
// Phase 6: project memory injection + run-completion distillation (spec §6.3, §7.2)
// ---------------------------------------------------------------------------

/** A deterministic distillation driver: submits its entries after a delay. */
class FakeDistillationDriver implements MemoryDistillationDriver {
  readonly inputs: MemoryDistillationDriverInput[] = []
  constructor(
    private readonly delayMs: number,
    private readonly submit: (input: MemoryDistillationDriverInput) => MemoryDistillationSubmission,
  ) {}

  start(input: MemoryDistillationDriverInput): Promise<MemoryDistillationDriverResult> {
    this.inputs.push(input)
    return new Promise<MemoryDistillationDriverResult>(resolve => {
      setTimeout(() => {
        void input.onMemorySubmit(this.submit(input)).then(() => {
          resolve({ kind: 'completed' })
        })
      }, this.delayMs)
    })
  }
}

describe('ProjectTaskService Phase 6 project memory (spec §6.3, §7.2)', () => {
  it('passes the project memory packet to the worker input (spec §7.2)', async () => {
    const fx = await fixture({
      memoryFactory: (ctx, catalog, runService) => new ProjectMemoryService(ctx, catalog, runService, undefined),
    })
    try {
      await fx.memory!.create({
        projectId: PROJECT_ID,
        kind: 'testing',
        title: 'Tests need Postgres',
        body: 'start postgres first',
      })
      const plan = await fx.planService.createPlan({
        runId: fx.runId,
        pattern: 'direct',
        rationale: 'memory injection',
        tasks: [{ title: 'postgres fix', description: 'make the tests green' }],
      })
      await fx.planService.transitionPlan(plan.id, 'active')
      const firstStart = await waitFor(() => fx.held.starts.at(-1), 'first task start')
      const packet = firstStart.memoryContext
      expect(packet).toBeDefined()
      expect(packet!).toContain('PROJECT MEMORY (knowledge persisted from earlier runs — verify before relying on it):')
      expect(packet!).toContain('TESTING:')
      expect(packet!).toContain('- Tests need Postgres: start postgres first')
      fx.held.release(firstStart.taskId, { kind: 'succeeded', summary: 'done' })
      await waitFor(() => fx.taskService.taskList(fx.runId).every(task => task.status === 'succeeded'), 'task succeeded')
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  })

  it('omits memoryContext from the worker input when no memory service is wired (spec §7.2)', async () => {
    const fx = await fixture()
    try {
      const plan = await fx.planService.createPlan({
        runId: fx.runId,
        pattern: 'direct',
        rationale: 'no memory',
        tasks: [{ title: 'a', description: 'a' }],
      })
      await fx.planService.transitionPlan(plan.id, 'active')
      const firstStart = await waitFor(() => fx.held.starts.at(-1), 'first task start')
      expect(firstStart.memoryContext).toBeUndefined()
      fx.held.release(firstStart.taskId, { kind: 'succeeded', summary: 'done' })
      await waitFor(() => fx.taskService.taskList(fx.runId).every(task => task.status === 'succeeded'), 'task succeeded')
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  })

  it('fires onRunSucceeded once with the fresh succeeded record (spec §6.3)', async () => {
    const seen: Array<{ id: string; phase: string }> = []
    const fx = await fixture({
      hooks: { onRunSucceeded: run => { seen.push({ id: run.id, phase: run.phase }) } },
    })
    try {
      const plan = await fx.planService.createPlan({
        runId: fx.runId,
        pattern: 'direct',
        rationale: 'hook',
        tasks: [{ title: 'a', description: 'a' }],
      })
      await fx.planService.transitionPlan(plan.id, 'active')
      const firstStart = await waitFor(() => fx.held.starts.at(-1), 'first task start')
      fx.held.release(firstStart.taskId, { kind: 'succeeded', summary: 'done' })
      await waitFor(() => {
        const current = fx.runService.domain().table('runs').get(fx.runId)!
        return current.phase === 'succeeded' ? current : undefined
      }, 'run succeeded', 10_000)
      // fire-and-forget: the hook fires as part of the completion pipeline,
      // not before the transition is applied
      await waitFor(() => (seen.length === 1 ? seen : undefined), 'hook fired', 5_000)
      expect(seen).toEqual([{ id: fx.runId, phase: 'succeeded' }])
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 20_000)

  it('distills run 1 and passes the memory to run 2 worker inputs (spec §12.5)', async () => {
    const driver = new FakeDistillationDriver(300, () => ({
      entries: [
        { kind: 'testing', title: 'Tests need Postgres', body: 'start postgres first' },
        { kind: 'convention', title: 'Use pnpm', body: 'always pnpm, never npm' },
      ],
    }))
    let fx: Awaited<ReturnType<typeof fixture>>
    fx = await fixture({
      memoryFactory: (ctx, catalog, runService) => new ProjectMemoryService(ctx, catalog, runService, driver),
      hooks: { onRunSucceeded: run => { void fx.memory!.distillRun(run) } },
    })
    try {
      // run #1: one task to completion
      const plan = await fx.planService.createPlan({
        runId: fx.runId,
        pattern: 'direct',
        rationale: 'run one',
        tasks: [{ title: 'a', description: 'a' }],
      })
      await fx.planService.transitionPlan(plan.id, 'active')
      const firstStart = await waitFor(() => fx.held.starts.at(-1), 'run 1 task start')
      fx.held.release(firstStart.taskId, { kind: 'succeeded', summary: 'run 1 done' })
      const run1 = await waitFor(() => {
        const current = fx.runService.domain().table('runs').get(fx.runId)!
        return current.phase === 'succeeded' ? current : undefined
      }, 'run 1 succeeded', 10_000)
      expect(run1.phase).toBe('succeeded')
      // fire-and-forget: the run is already succeeded while the (slow)
      // distillation session is still in flight
      expect(await fx.memory!.list({ projectId: PROJECT_ID })).toMatchObject({ entries: [] })
      await waitFor(() => (driver.inputs.length === 1 ? driver.inputs : undefined), 'distillation started', 5_000)
      expect(driver.inputs[0]!.sessionId).toMatch(/^dsh-memory-/u)
      const entries = await waitFor(async () => {
        const list = await fx.memory!.list({ projectId: PROJECT_ID })
        return list.entries.length === 2 ? list.entries : undefined
      }, 'distillation persisted', 5_000)
      expect(entries.map(entry => entry.title).sort()).toEqual(['Tests need Postgres', 'Use pnpm'])
      expect(entries.every(entry => entry.sourceRunId === fx.runId)).toBe(true)
      const detail = await fx.runService.runDetail(fx.runId)
      const distilled = detail.events.filter(event => event.type === 'run.memory.distilled')
      expect(distilled).toHaveLength(1)
      expect(distilled[0]!.detail).toBe('2 entries persisted (0 superseded)')
      // run #2 in the same project: its task worker input carries run 1's memory
      const run2 = await fx.runService.createRun({ goal: 'second goal' }, { mode: 'project', projectId: PROJECT_ID })
      await fx.runService.transitionRun(run2.id, 'planning')
      await fx.runService.transitionRun(run2.id, 'executing')
      const plan2 = await fx.planService.createPlan({
        runId: run2.id,
        pattern: 'direct',
        rationale: 'run two',
        tasks: [{ title: 'postgres fix', description: 'again' }],
      })
      await fx.planService.transitionPlan(plan2.id, 'active')
      const secondStart = await waitFor(() => fx.held.starts.at(1), 'run 2 task start')
      expect(secondStart.memoryContext).toBeDefined()
      expect(secondStart.memoryContext).toContain('start postgres first')
      // spec §5: with a query, only score > 0 entries are returned — the
      // non-matching convention entry stays out of the packet
      expect(secondStart.memoryContext).not.toContain('always pnpm, never npm')
      fx.held.release(secondStart.taskId, { kind: 'succeeded', summary: 'run 2 done' })
      await waitFor(() => fx.taskService.taskList(run2.id).every(task => task.status === 'succeeded'), 'run 2 task succeeded')
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 30_000)
})

function tokens(total: number): TokenTotals {
  return { input: Math.floor(total * 0.6), output: Math.floor(total * 0.4), cacheRead: 0, cacheWrite: 0, reasoning: 0, total }
}

/** A plan of `count` independent tasks (no dependencies) on the fixture run. */
async function independentPlan(fx: Fixture, count: number) {
  const tasks = Array.from({ length: count }, (_, index) => ({ title: `task ${index + 1}`, description: `d${index + 1}` }))
  const plan = await fx.planService.createPlan({ runId: fx.runId, pattern: 'direct', rationale: 'budget test', tasks })
  await fx.planService.transitionPlan(plan.id, 'active')
  return plan
}

describe('ProjectTaskService Phase 7 budgets + merge gate (spec §4.5, §5)', () => {
  it('caps the scheduler on the budget concurrency keys (silent)', async () => {
    // run allows 5 concurrent, budget caps to 2 → only 2 of 3 start.
    const fx = await fixture({ maxConcurrentAgents: 5, budget: { maxConcurrentAgents: 2 } })
    try {
      await independentPlan(fx, 3)
      await waitFor(() => fx.held.starts.length >= 2, 'two tasks started under the cap')
      // The third stays ready (cap 2), and no budget event was emitted.
      expect(fx.held.starts).toHaveLength(2)
      expect(fx.taskService.taskCounts(fx.runId)).toMatchObject({ running: 2, ready: 1 })
      // The concurrency cap is silent: no budget event is recorded.
      const detail = await fx.runService.runDetail(fx.runId)
      expect(detail.events.map(event => event.type)).not.toContain('run.budget.warning')
      expect(detail.events.map(event => event.type)).not.toContain('run.budget.exceeded')
      // Releasing one frees a slot → the third starts.
      fx.held.release(fx.held.starts[0]!.taskId, { kind: 'succeeded', summary: 'one' })
      await waitFor(() => fx.held.starts.length >= 3, 'third task started after a slot freed')
      expect(fx.held.starts).toHaveLength(3)
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 20_000)

  it('also caps on the maxAgents key', async () => {
    const fx = await fixture({ maxConcurrentAgents: 5, budget: { maxAgents: 1 } })
    try {
      await independentPlan(fx, 3)
      await waitFor(() => fx.held.starts.length >= 1, 'one task started')
      expect(fx.held.starts).toHaveLength(1)
      expect(fx.taskService.taskCounts(fx.runId)).toMatchObject({ running: 1, ready: 2 })
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 20_000)

  it('pauses the run when a token budget is exceeded, with a result summary', async () => {
    const fx = await fixture({ budget: { maxTotalTokens: 100 } })
    try {
      await independentPlan(fx, 1)
      const start = await waitFor(() => fx.held.starts.at(-1), 'task start')
      fx.held.release(start!.taskId, { kind: 'succeeded', summary: 'big', tokenUsage: tokens(150) })
      const detail = await waitFor(async () => {
        const record = await fx.runService.runDetail(fx.runId)
        return record.run.phase === 'paused' ? record : undefined
      }, 'run paused on token budget')
      expect(detail.run.tokenUsage?.total).toBe(150)
      expect(detail.run.budgetWarnings).toEqual(['maxTotalTokens'])
      expect(detail.run.resultSummary).toMatch(/maxTotalTokens/)
      expect(detail.events.map(event => event.type)).toContain('run.budget.exceeded')
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 20_000)

  it('warns once at 80% of a token budget without pausing', async () => {
    const fx = await fixture({ budget: { maxTotalTokens: 1000 } })
    try {
      await independentPlan(fx, 1)
      const start = await waitFor(() => fx.held.starts.at(-1), 'task start')
      fx.held.release(start!.taskId, { kind: 'succeeded', summary: 'mid', tokenUsage: tokens(850) })
      await waitFor(() => fx.taskService.taskList(fx.runId).every(task => task.status === 'succeeded'), 'task succeeded')
      const detail = await fx.runService.runDetail(fx.runId)
      // The 80% warning does not pause the run (it kept executing/finalizing).
      expect(detail.run.phase).not.toBe('paused')
      expect(detail.run.tokenUsage?.total).toBe(850)
      expect(detail.run.budgetWarnings).toEqual(['maxTotalTokens'])
      // The 80% warning is a persisted run event, emitted exactly once per key.
      const warnings = detail.events.filter(event => event.type === 'run.budget.warning')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.title).toMatch(/maxTotalTokens/)
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 20_000)

  it('pauses the run when the runtime budget is exceeded', async () => {
    // The run started at NOW; the retry clock is 2 minutes later and the budget is 1 minute.
    const fx = await fixture({ budget: { maxRuntimeMinutes: 1 }, retryClock: () => Date.parse(NOW) + 2 * 60_000 })
    try {
      await independentPlan(fx, 1)
      await waitFor(() => fx.held.starts.at(-1), 'task start')
      const detail = await waitFor(async () => {
        const record = await fx.runService.runDetail(fx.runId)
        return record.run.phase === 'paused' ? record : undefined
      }, 'run paused on runtime budget')
      expect(detail.run.budgetWarnings).toEqual(['maxRuntimeMinutes'])
      expect(detail.run.resultSummary).toMatch(/maxRuntimeMinutes/)
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 20_000)

  it('refuses a retry once the run budget maxRetriesPerTask is exhausted', async () => {
    // maxRetriesPerTask 0 = no manual retries allowed. Exhaust the task's
    // automatic attempt budget (default 3) so it settles `failed`, then the
    // manual retry is refused by the run's retry budget.
    const fx = await fixture({ budget: { maxRetriesPerTask: 0 } })
    try {
      await independentPlan(fx, 1)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const start = await waitFor(() => fx.held.starts.at(-1), `task attempt ${attempt} start`)
        fx.held.release(start!.taskId, { kind: 'failed', summary: `boom ${attempt}` })
        // Wait for the automatic retry to re-start (or the task to settle failed).
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await waitFor(() => fx.taskService.taskList(fx.runId).some(task => task.status === 'failed'), 'task failed')
      const task = fx.taskService.taskList(fx.runId)[0]!
      expect(task.status).toBe('failed')
      await expect(fx.taskService.taskRetry(task.id)).rejects.toMatchObject({
        dashboardCode: 'task.retryBudgetExceeded',
        params: expect.objectContaining({ max: 0 }),
      })
      // The task stays failed and the run is unaffected.
      expect(fx.taskService.taskList(fx.runId)[0]!.status).toBe('failed')
    } finally {
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 20_000)

  it('gates the merge on approval when the mode requires it', async () => {
    // A real git repo + worktree manager so the run targets `integrating`
    // (the merge gate lives on the `executing → integrating` edge). A writing
    // worker produces a real change so the task's worktree commit succeeds.
    const repo = await gitRepository()
    const invocations: WorkerInvocation[] = []
    const fx = await fixture({
      withApproval: true,
      worker: writingWorker(invocations, 50),
      worktreeManager: new TaskWorktreeManager(),
      workspaceSource: { strategy: 'worktree', projectRoot: repo, repositoryRoot: repo },
    })
    const approvalService = fx.approvalService!
    // Stamp approvalMode 'plan' (requires merge approval) onto the run.
    await fx.runService.domain().table('runs').update(fx.runId, current => ({
      ...current,
      approvalMode: 'plan',
      version: current.version + 1,
    }))
    try {
      await independentPlan(fx, 1)
      await waitFor(() => invocations.length >= 1, 'task executed')
      // All succeeded → detectAllSucceeded → merge gate → awaiting_approval.
      await waitFor(async () => {
        const record = await fx.runService.runDetail(fx.runId)
        return record.run.phase === 'awaiting_approval' ? record : undefined
      }, 'run awaiting merge approval')
      const pending = approvalService.pendingFor(fx.runId, 'merge')
      expect(pending).toBeDefined()
      expect(pending!.type).toBe('merge')
      // Approving resumes directly into integrating (the new edge).
      await approvalService.resolveApproval(pending!.id, 'approved')
      const resumed = await waitFor(async () => {
        const record = await fx.runService.runDetail(fx.runId)
        return record.run.phase === 'integrating' ? record : undefined
      }, 'run integrating after approval')
      expect(resumed.run.phase).toBe('integrating')
    } finally {
      approvalService.stop()
      fx.planService.stop()
      fx.taskService.stop()
      await fx.runService.stop()
    }
  }, 30_000)
})
