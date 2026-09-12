import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TASK_TRANSITIONS,
  TaskTransitionError,
  isTerminalTaskStatus,
  transitionTask,
} from '../src/tasks/state-machine.ts'
import type { ProjectTaskRecord, ProjectTaskStatus } from '../src/tasks/types.ts'

const NOW = '2026-09-12T08:00:00.000Z'
const LATER = '2026-09-12T08:05:00.000Z'

function task(overrides: Partial<ProjectTaskRecord> = {}): ProjectTaskRecord {
  return {
    id: 'task-1',
    runId: 'run-1',
    planId: 'plan-1',
    planTaskId: 't1',
    title: 'first task',
    description: 'do the work',
    dependencies: [],
    status: 'pending',
    acceptanceCriteria: [],
    attempt: 0,
    createdAt: '2026-09-12T07:00:00.000Z',
    updatedAt: '2026-09-12T07:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

describe('task state machine (spec §4)', () => {
  it('exposes the full allowed-edge table', () => {
    expect(ALLOWED_TASK_TRANSITIONS).toEqual({
      'pending': ['ready', 'blocked', 'canceled'],
      'ready': ['running', 'canceled'],
      'running': ['succeeded', 'failed', 'ready', 'canceled'],
      'blocked': ['ready', 'canceled'],
      'awaiting-review': [],
      'succeeded': [],
      'failed': ['ready'],
      'canceled': [],
    })
  })

  it('treats succeeded/failed/canceled/awaiting-review as terminal (no outgoing edges)', () => {
    for (const status of ['succeeded', 'failed', 'canceled', 'awaiting-review'] as const) {
      if (status !== 'failed') expect(isTerminalTaskStatus(status)).toBe(true)
    }
    // `failed` has the operator-retry edge, so it is not terminal.
    expect(isTerminalTaskStatus('failed')).toBe(false)
    for (const status of ['pending', 'ready', 'running', 'blocked'] as const) {
      expect(isTerminalTaskStatus(status)).toBe(false)
    }
  })

  it('rejects a transition to the current status as a rejected no-op', () => {
    for (const status of Object.keys(ALLOWED_TASK_TRANSITIONS) as ProjectTaskStatus[]) {
      expect(() => transitionTask(task({ id: 'x', status }), status, { now: NOW }))
        .toThrow(TaskTransitionError)
    }
  })

  it('rejects edges outside the allowed table', () => {
    expect(() => transitionTask(task(), 'running', { now: NOW })).toThrow(TaskTransitionError)
    expect(() => transitionTask(task({ status: 'ready' }), 'succeeded', { now: NOW, outputSummary: 's' }))
      .toThrow(TaskTransitionError)
    expect(() => transitionTask(task({ status: 'succeeded' }), 'ready', { now: NOW }))
      .toThrow(TaskTransitionError)
    expect(() => transitionTask(task({ status: 'pending' }), 'running', { now: NOW, attempt: 1 }))
      .toThrow(TaskTransitionError)
  })

  it('pending → ready / blocked / canceled bumps version and refreshes updatedAt', () => {
    const ready = transitionTask(task(), 'ready', { now: NOW })
    expect(ready).toMatchObject({ status: 'ready', version: 2, updatedAt: NOW })
    const blocked = transitionTask(task(), 'blocked', { now: NOW })
    expect(blocked).toMatchObject({ status: 'blocked', version: 2 })
    const canceled = transitionTask(task(), 'canceled', { now: NOW })
    expect(canceled).toMatchObject({ status: 'canceled', version: 2, completedAt: NOW })
  })

  it('ready → running requires the attempt number and records the identity', () => {
    expect(() => transitionTask(task({ status: 'ready' }), 'running', { now: NOW })).toThrow(/attempt/)
    const running = transitionTask(task({ status: 'ready' }), 'running', {
      now: NOW,
      attempt: 1,
      startedAt: NOW,
      assignedAgentId: 'dsh-task-abc',
    })
    expect(running).toMatchObject({
      status: 'running',
      attempt: 1,
      startedAt: NOW,
      assignedAgentId: 'dsh-task-abc',
      version: 2,
    })
  })

  it('running → succeeded requires an output summary and sets completedAt', () => {
    const running = task({ status: 'running', attempt: 1 })
    expect(() => transitionTask(running, 'succeeded', { now: NOW })).toThrow(/outputSummary/)
    const done = transitionTask(running, 'succeeded', {
      now: LATER,
      outputSummary: 'finished the work',
      tokenUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 },
      turnCount: 2,
    })
    expect(done).toMatchObject({
      status: 'succeeded',
      outputSummary: 'finished the work',
      completedAt: LATER,
      turnCount: 2,
      version: 2,
    })
    expect(done.tokenUsage).toMatchObject({ total: 15 })
  })

  it('running → failed requires an error message and sets completedAt', () => {
    const running = task({ status: 'running', attempt: 2 })
    expect(() => transitionTask(running, 'failed', { now: LATER })).toThrow(/error/)
    const failed = transitionTask(running, 'failed', { now: LATER, error: 'boom' })
    expect(failed).toMatchObject({ status: 'failed', error: 'boom', completedAt: LATER, attempt: 2 })
  })

  it('running → ready is the internal retry edge (attempt kept, error/summary not required)', () => {
    const running = task({ status: 'running', attempt: 1 })
    const back = transitionTask(running, 'ready', { now: LATER })
    expect(back).toMatchObject({ status: 'ready', attempt: 1, version: 2 })
    expect('completedAt' in back).toBe(false)
  })

  it('failed → ready is the operator-retry edge', () => {
    const failed = task({ status: 'failed', error: 'boom', attempt: 3 })
    const retried = transitionTask(failed, 'ready', { now: LATER })
    expect(retried).toMatchObject({ status: 'ready', version: 2 })
    expect(retried.error).toBe('boom')
  })

  it('blocked → ready is the dependency-recovery edge', () => {
    const blocked = task({ status: 'blocked' })
    const ready = transitionTask(blocked, 'ready', { now: NOW })
    expect(ready).toMatchObject({ status: 'ready', version: 2 })
  })

  it('never mutates the input record', () => {
    const running = task({ status: 'running', attempt: 1 })
    const before = JSON.stringify(running)
    transitionTask(running, 'succeeded', { now: LATER, outputSummary: 'done' })
    expect(JSON.stringify(running)).toBe(before)
  })
})
