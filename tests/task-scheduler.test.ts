import { describe, expect, it } from 'vitest'
import {
  TaskGraphError,
  compareTasks,
  computeDependencyTransitions,
  pickReadyTasks,
  validateTaskGraph,
} from '../src/tasks/scheduler.ts'
import type { ProjectTaskRecord, ProjectTaskStatus } from '../src/tasks/types.ts'

function task(
  id: string,
  overrides: Partial<ProjectTaskRecord> = {},
): ProjectTaskRecord {
  return {
    id,
    runId: 'run-1',
    planId: 'plan-1',
    planTaskId: `t${id.length}`,
    title: `task ${id}`,
    description: 'work',
    dependencies: [],
    status: 'pending',
    acceptanceCriteria: [],
    attempt: 0,
    createdAt: `2026-09-12T07:0${id.length % 10}:00.000Z`,
    updatedAt: '2026-09-12T07:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

const NOW = Date.UTC(2026, 8, 12, 8, 0, 0)

describe('validateTaskGraph (spec §5)', () => {
  it('accepts a valid diamond DAG', () => {
    const tasks = [
      task('a'),
      task('b', { dependencies: ['a'] }),
      task('c', { dependencies: ['a'] }),
      task('d', { dependencies: ['b', 'c'] }),
    ]
    expect(() => validateTaskGraph(tasks)).not.toThrow()
  })

  it('rejects a self-dependency', () => {
    expect(() => validateTaskGraph([task('a', { dependencies: ['a'] })])).toThrow(TaskGraphError)
  })

  it('rejects a dependency on an unknown task', () => {
    expect(() => validateTaskGraph([task('a', { dependencies: ['ghost'] })]))
      .toThrow(/unknown task ghost/)
  })

  it('rejects a cycle', () => {
    const tasks = [
      task('a', { dependencies: ['b'] }),
      task('b', { dependencies: ['a'] }),
    ]
    expect(() => validateTaskGraph(tasks)).toThrow(/cycle/)
  })

  it('rejects a partial cycle in an otherwise valid graph', () => {
    const tasks = [
      task('a'),
      task('b', { dependencies: ['a'] }),
      task('c', { dependencies: ['d'] }),
      task('d', { dependencies: ['c'] }),
    ]
    expect(() => validateTaskGraph(tasks)).toThrow(/cycle/)
  })
})

describe('computeDependencyTransitions (spec §5)', () => {
  it('is idempotent: no transitions when statuses already match the dependency facts', () => {
    const tasks = [
      task('a', { status: 'succeeded' as ProjectTaskStatus }),
      task('b', { dependencies: ['a'], status: 'ready' as ProjectTaskStatus }),
    ]
    expect(computeDependencyTransitions(tasks)).toEqual([])
  })

  it('moves a pending task to ready when all its dependencies succeeded', () => {
    const tasks = [
      task('a', { status: 'succeeded' as ProjectTaskStatus }),
      task('b', { status: 'succeeded' as ProjectTaskStatus }),
      task('c', { dependencies: ['a', 'b'] }),
    ]
    expect(computeDependencyTransitions(tasks)).toEqual([{ taskId: 'c', to: 'ready' }])
  })

  it('moves a pending task to blocked when any dependency failed', () => {
    const tasks = [
      task('a', { status: 'succeeded' as ProjectTaskStatus }),
      task('b', { status: 'failed' as ProjectTaskStatus, error: 'boom' }),
      task('c', { dependencies: ['a', 'b'] }),
    ]
    expect(computeDependencyTransitions(tasks)).toEqual([{ taskId: 'c', to: 'blocked' }])
  })

  it('recovers a blocked task to ready once its dependencies all succeed again', () => {
    const tasks = [
      task('a', { status: 'succeeded' as ProjectTaskStatus }),
      task('b', { dependencies: ['a'], status: 'blocked' as ProjectTaskStatus }),
    ]
    expect(computeDependencyTransitions(tasks)).toEqual([{ taskId: 'b', to: 'ready' }])
  })

  it('leaves a blocked task blocked while a dependency is still running', () => {
    const tasks = [
      task('a', { status: 'running' as ProjectTaskStatus }),
      task('b', { dependencies: ['a'], status: 'blocked' as ProjectTaskStatus }),
    ]
    expect(computeDependencyTransitions(tasks)).toEqual([])
  })

  it('ignores tasks outside pending/blocked', () => {
    const tasks = [
      task('a', { status: 'ready' as ProjectTaskStatus }),
      task('b', { status: 'running' as ProjectTaskStatus }),
    ]
    expect(computeDependencyTransitions(tasks)).toEqual([])
  })
})

describe('pickReadyTasks (spec §5)', () => {
  it('picks ready first-attempt tasks in deterministic order up to the limit', () => {
    const tasks = [
      task('z', { status: 'ready' as ProjectTaskStatus, createdAt: '2026-09-12T07:02:00.000Z' }),
      task('a', { status: 'ready' as ProjectTaskStatus, createdAt: '2026-09-12T07:01:00.000Z' }),
      task('m', { status: 'ready' as ProjectTaskStatus, createdAt: '2026-09-12T07:01:00.000Z' }),
      task('p', { status: 'pending' as ProjectTaskStatus }),
    ]
    expect(pickReadyTasks(tasks, 1, NOW)).toEqual(['a'])
    expect(pickReadyTasks(tasks, 3, NOW)).toEqual(['a', 'm', 'z'])
  })

  it('reserves slots for running tasks', () => {
    const tasks = [
      task('r', { status: 'running' as ProjectTaskStatus }),
      task('r2', { status: 'running' as ProjectTaskStatus }),
      task('a', { status: 'ready' as ProjectTaskStatus }),
    ]
    expect(pickReadyTasks(tasks, 2, NOW)).toEqual([])
    expect(pickReadyTasks(tasks, 3, NOW)).toEqual(['a'])
  })

  it('applies retry backoff: a retried task is skipped until updatedAt + delay', () => {
    const updatedAt = new Date(Date.UTC(2026, 8, 12, 7, 0, 0)).toISOString()
    const retried = task('r', {
      status: 'ready' as ProjectTaskStatus,
      attempt: 1,
      updatedAt,
    })
    // failureRetryDelay(1, 300_000) = 10_000 ms
    const dueAt = Date.parse(updatedAt) + 10_000
    expect(pickReadyTasks([retried], 1, dueAt - 1)).toEqual([])
    expect(pickReadyTasks([retried], 1, dueAt)).toEqual(['r'])
    // backoff doubles with the attempt number: delay(3) = 40_000 ms
    const attempt3 = task('r3', { status: 'ready' as ProjectTaskStatus, attempt: 3, updatedAt })
    expect(pickReadyTasks([attempt3], 1, dueAt)).toEqual([])
    expect(pickReadyTasks([attempt3], 1, Date.parse(updatedAt) + 40_000)).toEqual(['r3'])
  })

  it('returns [] when nothing is ready', () => {
    expect(pickReadyTasks([task('a', { status: 'pending' as ProjectTaskStatus })], 1, NOW)).toEqual([])
  })
})

describe('compareTasks', () => {
  it('orders by createdAt then id', () => {
    const a = task('a', { createdAt: '2026-09-12T07:00:00.000Z' })
    const b = task('b', { createdAt: '2026-09-12T07:01:00.000Z' })
    expect(compareTasks(a, b)).toBeLessThan(0)
    expect(compareTasks(b, a)).toBeGreaterThan(0)
    const c = task('c', { createdAt: '2026-09-12T07:00:00.000Z' })
    expect(compareTasks(a, c)).toBeLessThan(0)
  })
})
