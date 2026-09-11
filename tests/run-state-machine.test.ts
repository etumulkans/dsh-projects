import { describe, expect, it } from 'vitest'
import type { ProjectRunRecord } from '../src/runs/types.ts'
import {
  allowedTransitions,
  isSuspendedRunPhase,
  isTerminalRunPhase,
  RunTransitionError,
  transitionRun,
} from '../src/runs/state-machine.ts'

const baseRun: ProjectRunRecord = {
  id: '11111111-2222-4333-8444-555555555555',
  projectId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  goal: 'Implement the vertical slice',
  source: 'manual',
  phase: 'created',
  createdAt: '2026-08-14T02:00:00.000Z',
  updatedAt: '2026-08-14T02:00:00.000Z',
  phaseChangedAt: '2026-08-14T02:00:00.000Z',
  version: 1,
}

function inPhase(phase: ProjectRunRecord['phase'], patch: Partial<ProjectRunRecord> = {}): ProjectRunRecord {
  return { ...baseRun, phase, ...patch }
}

const NOW = '2026-08-14T02:05:00.000Z'

describe('run state machine', () => {
  it('exposes the full transition table', () => {
    expect([...allowedTransitions('created')]).toEqual(['planning', 'canceled'])
    expect([...allowedTransitions('planning')]).toEqual(['awaiting_approval', 'executing', 'paused', 'blocked', 'failed', 'canceled'])
    expect([...allowedTransitions('awaiting_approval')]).toEqual(['executing', 'planning', 'paused', 'blocked', 'failed', 'canceled'])
    expect([...allowedTransitions('executing')]).toEqual(['integrating', 'validating', 'finalizing', 'paused', 'blocked', 'failed', 'canceled'])
    expect([...allowedTransitions('integrating')]).toEqual(['validating', 'finalizing', 'paused', 'blocked', 'failed', 'canceled'])
    expect([...allowedTransitions('validating')]).toEqual(['finalizing', 'executing', 'paused', 'blocked', 'failed', 'canceled'])
    expect([...allowedTransitions('finalizing')]).toEqual(['succeeded', 'failed', 'canceled'])
    expect([...allowedTransitions('paused')]).toEqual([])
    expect([...allowedTransitions('blocked')]).toEqual([])
    expect([...allowedTransitions('succeeded')]).toEqual([])
    expect([...allowedTransitions('failed')]).toEqual([])
    expect([...allowedTransitions('canceled')]).toEqual([])
  })

  it('resolves suspended phases to their recorded origin', () => {
    expect([...allowedTransitions('paused', 'executing')]).toEqual(['executing', 'failed', 'canceled'])
    expect([...allowedTransitions('blocked', 'planning')]).toEqual(['planning', 'failed', 'canceled'])
    expect([...allowedTransitions('paused', undefined)]).toEqual([])
    expect([...allowedTransitions('blocked', undefined)]).toEqual([])
  })

  it('rejects transitions that are not allowed', () => {
    expect(() => transitionRun(inPhase('created'), 'executing', { now: NOW })).toThrow(RunTransitionError)
    expect(() => transitionRun(inPhase('created'), 'planning', { now: NOW })).not.toThrow()
    expect(() => transitionRun(inPhase('finalizing'), 'executing', { now: NOW })).toThrow(RunTransitionError)
    expect(() => transitionRun(inPhase('executing'), 'succeeded', { now: NOW })).toThrow(RunTransitionError)
    expect(() => transitionRun(inPhase('succeeded'), 'planning', { now: NOW })).toThrow(RunTransitionError)
    expect(() => transitionRun(inPhase('failed'), 'canceled', { now: NOW })).toThrow(RunTransitionError)
    expect(() => transitionRun(inPhase('canceled'), 'planning', { now: NOW })).toThrow(RunTransitionError)
  })

  it('rejects self-transitions', () => {
    expect(() => transitionRun(inPhase('planning'), 'planning', { now: NOW })).toThrow(RunTransitionError)
    expect(() => transitionRun(inPhase('created'), 'created', { now: NOW })).toThrow(RunTransitionError)
  })

  it('sets startedAt once when entering executing and preserves it afterwards', () => {
    const planned = inPhase('planning')
    const executing = transitionRun(planned, 'executing', { now: NOW }).next
    expect(executing.startedAt).toBe(NOW)
    const validating = transitionRun(executing, 'validating', { now: '2026-08-14T02:06:00.000Z' }).next
    expect(validating.startedAt).toBe(NOW)
  })

  it('sets completedAt exactly when entering a terminal phase', () => {
    expect(transitionRun(inPhase('finalizing'), 'succeeded', { now: NOW }).next.completedAt).toBe(NOW)
    expect(transitionRun(inPhase('planning'), 'failed', { now: NOW }).next.completedAt).toBe(NOW)
    expect(transitionRun(inPhase('created'), 'canceled', { now: NOW }).next.completedAt).toBe(NOW)
    const nonTerminal = transitionRun(inPhase('created'), 'planning', { now: NOW }).next
    expect(nonTerminal.completedAt).toBeUndefined()
  })

  it('carries error and resultSummary only onto the matching terminal phase', () => {
    const failed = transitionRun(inPhase('planning'), 'failed', { now: NOW, error: 'boom' }).next
    expect(failed.error).toBe('boom')
    expect(failed.resultSummary).toBeUndefined()
    const succeeded = transitionRun(inPhase('finalizing'), 'succeeded', { now: NOW, resultSummary: 'done' }).next
    expect(succeeded.resultSummary).toBe('done')
    expect(succeeded.error).toBeUndefined()
    const canceled = transitionRun(inPhase('planning'), 'canceled', { now: NOW, error: 'ignored' }).next
    expect(canceled.error).toBeUndefined()
  })

  it('records suspendedFrom when entering a suspended phase and clears it when leaving', () => {
    const paused = transitionRun(inPhase('executing'), 'paused', { now: NOW })
    expect(paused.next.phase).toBe('paused')
    expect(paused.next.suspendedFrom).toBe('executing')
    expect(isSuspendedRunPhase(paused.next.phase)).toBe(true)

    const resumed = transitionRun(paused.next, 'executing', { now: NOW })
    expect(resumed.resumed).toBe(true)
    expect(resumed.next.phase).toBe('executing')
    expect(resumed.next.suspendedFrom).toBeUndefined()

    const blocked = transitionRun(inPhase('validating'), 'blocked', { now: NOW })
    expect(blocked.next.suspendedFrom).toBe('validating')
    const failedFromBlocked = transitionRun(blocked.next, 'failed', { now: NOW })
    expect(failedFromBlocked.resumed).toBe(false)
    expect(failedFromBlocked.next.suspendedFrom).toBeUndefined()
  })

  it('allows a suspended run to fail or cancel without a resume', () => {
    const paused = transitionRun(inPhase('awaiting_approval'), 'paused', { now: NOW }).next
    expect(allowedTransitions(paused.phase, paused.suspendedFrom)).toEqual(['awaiting_approval', 'failed', 'canceled'])
    const failed = transitionRun(paused, 'failed', { now: NOW })
    expect(failed.resumed).toBe(false)
    expect(failed.next.phase).toBe('failed')
  })

  it('bumps version and timestamps on every accepted transition', () => {
    const next = transitionRun(inPhase('created'), 'planning', { now: NOW })
    expect(next.next.version).toBe(2)
    expect(next.next.updatedAt).toBe(NOW)
    expect(next.next.phaseChangedAt).toBe(NOW)
    expect(next.next.createdAt).toBe(baseRun.createdAt)
    const again = transitionRun(next.next, 'executing', { now: '2026-08-14T02:06:00.000Z' })
    expect(again.next.version).toBe(3)
  })

  it('classifies terminal and suspended phases', () => {
    expect(isTerminalRunPhase('succeeded')).toBe(true)
    expect(isTerminalRunPhase('failed')).toBe(true)
    expect(isTerminalRunPhase('canceled')).toBe(true)
    expect(isTerminalRunPhase('finalizing')).toBe(false)
    expect(isSuspendedRunPhase('paused')).toBe(true)
    expect(isSuspendedRunPhase('blocked')).toBe(true)
    expect(isSuspendedRunPhase('planning')).toBe(false)
  })

  it('keeps unrelated record fields across transitions', () => {
    const withUsage = inPhase('executing', {
      source: 'tracker',
      sourceRef: 'ENG-1',
      startedAt: '2026-08-14T02:01:00.000Z',
      tokenUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, total: 15 },
    })
    const next = transitionRun(withUsage, 'integrating', { now: NOW }).next
    expect(next).toMatchObject({
      id: baseRun.id,
      projectId: baseRun.projectId,
      goal: baseRun.goal,
      source: 'tracker',
      sourceRef: 'ENG-1',
      startedAt: '2026-08-14T02:01:00.000Z',
      tokenUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, total: 15 },
    })
  })
})
