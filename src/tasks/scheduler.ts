/**
 * DSH Projects Phase 4 — pure task DAG scheduler.
 *
 * Pure functions over a run's task list: graph validation (cycle / unknown
 * / self dependencies), the minimal dependency-driven transition set, and
 * ready-task picking under the concurrency limit and retry backoff.
 * Generalizes the existing `orchestrator/scheduling.ts` helpers —
 * `failureRetryDelay` is reused as-is (spec §5).
 */

import { failureRetryDelay } from '../orchestrator/scheduling.ts'
import { MAX_RETRY_DELAY_MS } from './constants.ts'
import type { ProjectTaskRecord, ProjectTaskStatus } from './types.ts'

/** Raised when a would-be task graph is invalid (unknown/self dep, cycle). */
export class TaskGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskGraphError'
  }
}

/**
 * Validate the dependency graph: unknown dependencies, self-dependencies,
 * and cycles (Kahn's algorithm). `tasks` are the would-be records of one
 * materialization batch (their `dependencies` must already reference task
 * ids of the same batch).
 */
export function validateTaskGraph(tasks: readonly ProjectTaskRecord[]): void {
  const byId = new Map<string, ProjectTaskRecord>()
  for (const task of tasks) byId.set(task.id, task)
  const inDegree = new Map<string, number>()
  for (const task of tasks) {
    if (task.dependencies.includes(task.id)) {
      throw new TaskGraphError(`task ${task.id} depends on itself`)
    }
    const unknown = task.dependencies.find(dep => byId.has(dep) === false)
    if (unknown !== undefined) {
      throw new TaskGraphError(`task ${task.id} depends on unknown task ${unknown}`)
    }
    inDegree.set(task.id, task.dependencies.length)
  }
  // Kahn: peel nodes whose dependencies all resolved.
  const remaining = new Map(inDegree)
  let resolved = 0
  while (true) {
    const ready = tasks.filter(task => remaining.get(task.id) === 0 && remaining.has(task.id))
    if (ready.length === 0) break
    for (const task of ready) remaining.delete(task.id)
    resolved += ready.length
    for (const task of tasks) {
      for (const dep of task.dependencies) {
        const degree = remaining.get(task.id)
        if (degree !== undefined && ready.some(done => done.id === dep)) {
          remaining.set(task.id, degree - 1)
        }
      }
    }
  }
  if (resolved !== tasks.length) {
    throw new TaskGraphError(`task graph contains a cycle (${tasks.length - resolved} task(s) unresolvable)`)
  }
}

export interface DependencyTransition {
  readonly taskId: string
  readonly to: 'ready' | 'blocked'
}

function statusOf(tasks: readonly ProjectTaskRecord[], taskId: string): ProjectTaskStatus | undefined {
  for (const task of tasks) if (task.id === taskId) return task.status
  return undefined
}

/**
 * The minimal transition set that brings statuses in line with the
 * dependency facts (pure, idempotent — returns [] when nothing changes):
 * - `pending`, all deps succeeded        → `ready`
 * - `pending`, any dep terminal `failed` → `blocked`
 * - `blocked`, all deps succeeded again  → `ready` (dependency recovery)
 */
export function computeDependencyTransitions(
  tasks: readonly ProjectTaskRecord[],
): readonly DependencyTransition[] {
  const transitions: DependencyTransition[] = []
  for (const task of tasks) {
    if (task.status !== 'pending' && task.status !== 'blocked') continue
    let allSucceeded = true
    let anyFailed = false
    for (const dep of task.dependencies) {
      const depStatus = statusOf(tasks, dep)
      if (depStatus !== 'succeeded') allSucceeded = false
      if (depStatus === 'failed') anyFailed = true
    }
    if (task.status === 'pending') {
      if (anyFailed) transitions.push({ taskId: task.id, to: 'blocked' })
      else if (allSucceeded) transitions.push({ taskId: task.id, to: 'ready' })
    } else if (task.status === 'blocked' && allSucceeded) {
      transitions.push({ taskId: task.id, to: 'ready' })
    }
  }
  return transitions
}

/**
 * Deterministic pick order: earliest `createdAt`, then id (the task analogue
 * of `compareCandidates` from `orchestrator/scheduling.ts`).
 */
export function compareTasks(left: ProjectTaskRecord, right: ProjectTaskRecord): number {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt)
  if (byCreatedAt !== 0) return byCreatedAt
  return left.id.localeCompare(right.id)
}

/**
 * The ready tasks eligible for an execution slot now (pure): status
 * `ready`, a concurrency slot free (`running` < limit), and — for retried
 * tasks — the retry backoff elapsed:
 * `updatedAt + failureRetryDelay(attempt, MAX_RETRY_DELAY_MS) ≤ now`.
 * First attempts (attempt === 0, never started) have no backoff. Returns at
 * most `limit - runningCount` ids in `compareTasks` order.
 */
export function pickReadyTasks(
  tasks: readonly ProjectTaskRecord[],
  limit: number,
  now: number,
): readonly string[] {
  const running = tasks.filter(task => task.status === 'running').length
  const freeSlots = limit - running
  if (freeSlots <= 0) return []
  const eligible = tasks
    .filter(task => task.status === 'ready')
    .filter(task => {
      if (task.attempt === 0) return true
      const dueAt = new Date(task.updatedAt).getTime() + failureRetryDelay(task.attempt, MAX_RETRY_DELAY_MS)
      return dueAt <= now
    })
    .sort((a, b) => compareTasks(a, b))
  return eligible.slice(0, freeSlots).map(task => task.id)
}
