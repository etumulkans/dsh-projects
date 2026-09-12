import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import { RunPlanService } from '../src/plans/plan-service.ts'
import { dshProjectsDomainSpec } from '../src/runs/spec.ts'
import { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectTaskRecord } from '../src/tasks/types.ts'
import { ProjectTaskService } from '../src/tasks/task-service.ts'
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
  readonly starts: Array<{ taskId: string; attempt: number; sessionId: string }>
  readonly stopped: string[]
  release(taskId: string, result?: TaskWorkerResult): void
}

/** A worker whose start() resolves only when the test releases it. */
function heldWorker(): HeldWorker {
  const outcomes = new Map<string, TaskWorkerResult>()
  const pending = new Map<string, (result: TaskWorkerResult) => void>()
  const starts: Array<{ taskId: string; attempt: number; sessionId: string }> = []
  const stopped: string[] = []
  const worker: TaskWorker = {
    kind: 'local',
    start(input: TaskWorkerInput): Promise<TaskWorkerResult> {
      starts.push({ taskId: input.taskId, attempt: input.attempt, sessionId: input.sessionId })
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

interface Fixture {
  ctx: Context
  runService: ProjectRunService
  planService: RunPlanService
  taskService: ProjectTaskService
  held: HeldWorker
  emit: ReturnType<typeof vi.fn>
  runId: string
}

async function fixture(overrides: {
  readonly maxConcurrentAgents?: number
  readonly worker?: TaskWorker
  readonly retryClock?: () => number
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
  const taskService = new ProjectTaskService(
    ctx,
    catalog,
    runService,
    held.worker,
    clock,
    overrides.retryClock ?? (() => Date.now()),
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
  return { ctx, runService, planService, taskService, held, emit, runId: run.id }
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
    const service = new ProjectTaskService(ctx, catalog, runService, new UnavailableWorker(), () => NOW)
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
    // the run stays executing (Phase 5 owns the all-done coupling — intent §3)
    const after = fx.runService.domain().table('runs').get(fx.runId)!
    expect(after.phase).toBe('executing')
    fx.planService.stop()
    fx.taskService.stop()
    await fx.runService.stop()
  })

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
