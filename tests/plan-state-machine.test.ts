import { describe, expect, it } from 'vitest'
import {
  allowedPlanTransitions,
  isTerminalPlanStatus,
  PlanTransitionError,
  PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  transitionPlan,
} from '../src/plans/state-machine.ts'
import type { RunPlanRecord, RunPlanStatus } from '../src/plans/types.ts'

const PLAN_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'

function plan(status: RunPlanStatus, revision = 1): RunPlanRecord {
  return {
    id: PLAN_ID,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    version: 1,
    pattern: 'supervisor',
    rationale: 'test rationale',
    assumptions: ['assumption one'],
    successCriteria: [{ id: 'c1', description: 'it works' }],
    tasks: [
      { id: 't1', title: 'first', description: 'do the first thing', dependencies: [], acceptanceCriteria: ['done'] },
      { id: 't2', title: 'second', description: 'do the second thing', dependencies: ['t1'], acceptanceCriteria: [] },
    ],
    status,
    createdAt: '2026-08-14T02:00:00.000Z',
    revision,
  }
}

describe('plan status machine', () => {
  it('declares the five statuses and the two terminal ones', () => {
    expect([...PLAN_STATUSES]).toEqual(['draft', 'awaiting-approval', 'active', 'superseded', 'completed'])
    expect([...TERMINAL_PLAN_STATUSES]).toEqual(['superseded', 'completed'])
  })

  it('exposes the approved edge set per status', () => {
    expect(allowedPlanTransitions('draft')).toEqual(['awaiting-approval', 'active', 'superseded'])
    expect(allowedPlanTransitions('awaiting-approval')).toEqual(['active', 'draft', 'superseded'])
    expect(allowedPlanTransitions('active')).toEqual(['completed', 'superseded'])
    expect(allowedPlanTransitions('superseded')).toEqual([])
    expect(allowedPlanTransitions('completed')).toEqual([])
  })

  it('moves draft to awaiting-approval without touching the CAS revision', () => {
    const next = transitionPlan(plan('draft'), 'awaiting-approval', {})
    expect(next.status).toBe('awaiting-approval')
    expect(next.revision).toBe(1)
    expect(next.id).toBe(PLAN_ID)
  })

  it('keeps the plan content immutable across transitions', () => {
    const before = plan('draft')
    const next = transitionPlan(before, 'active', {})
    expect(next).not.toBe(before)
    expect(next.rationale).toBe(before.rationale)
    expect(next.pattern).toBe(before.pattern)
    expect(next.assumptions).toEqual(before.assumptions)
    expect(next.successCriteria).toEqual(before.successCriteria)
    expect(next.tasks).toEqual(before.tasks)
    expect(next.version).toBe(1)
    // The source record is not mutated in place.
    expect(before.status).toBe('draft')
  })

  it('bumps the CAS revision only on superseded and completed', () => {
    expect(transitionPlan(plan('draft'), 'awaiting-approval', {}).revision).toBe(1)
    expect(transitionPlan(plan('draft'), 'active', {}).revision).toBe(1)
    expect(transitionPlan(plan('awaiting-approval'), 'active', {}).revision).toBe(1)
    expect(transitionPlan(plan('awaiting-approval'), 'draft', {}).revision).toBe(1)
    expect(transitionPlan(plan('active', 3), 'completed', {}).revision).toBe(4)
    expect(transitionPlan(plan('draft', 2), 'superseded', { replanReason: 'why' }).revision).toBe(3)
  })

  it('stores a trimmed replan reason when superseding', () => {
    const next = transitionPlan(plan('active'), 'superseded', { replanReason: '  scope changed  ' })
    expect(next.status).toBe('superseded')
    expect(next.replanReason).toBe('scope changed')
  })

  it('rejects superseding without a replan reason', () => {
    expect(() => transitionPlan(plan('active'), 'superseded', {})).toThrow(PlanTransitionError)
    expect(() => transitionPlan(plan('draft'), 'superseded', { replanReason: '   ' })).toThrow(/requires a replan reason/)
  })

  it('rejects a transition to the same status', () => {
    expect(() => transitionPlan(plan('draft'), 'draft', {})).toThrow(/already draft/)
    expect(() => transitionPlan(plan('active'), 'active', {})).toThrow(PlanTransitionError)
  })

  it('rejects every edge outside the approved set', () => {
    const invalid: readonly (readonly [RunPlanStatus, RunPlanStatus])[] = [
      ['draft', 'completed'],
      ['awaiting-approval', 'awaiting-approval'],
      ['active', 'draft'],
      ['active', 'awaiting-approval'],
      ['superseded', 'draft'],
      ['superseded', 'active'],
      ['completed', 'draft'],
      ['completed', 'superseded'],
    ]
    for (const [from, to] of invalid) {
      expect(() => transitionPlan(plan(from), to, { replanReason: 'x' }), `${from} → ${to}`).toThrow(PlanTransitionError)
    }
  })

  it('treats only superseded and completed as terminal', () => {
    for (const status of PLAN_STATUSES) {
      expect(isTerminalPlanStatus(status)).toBe(TERMINAL_PLAN_STATUSES.includes(status))
    }
  })
})
