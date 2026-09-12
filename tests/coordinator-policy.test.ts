import { describe, expect, it } from 'vitest'
import { COORDINATOR_POLICY_VERSION, coordinatorGuidance, coordinatorPrompt } from '../src/coordinator/policy.ts'

describe('coordinator policy (Phase 3)', () => {
  it('exports a stable numeric policy version', () => {
    expect(COORDINATOR_POLICY_VERSION).toBe(1)
  })

  it('guidance covers role, checklist, decision rules, plan contract, and untrusted content', () => {
    const guidance = coordinatorGuidance()
    expect(guidance).toContain('Coordinator policy v1')
    expect(guidance).toContain('Coordinator Lead')
    expect(guidance).toContain('planning only')
    expect(guidance).toContain('success criteria')
    expect(guidance).toContain('direct')
    expect(guidance).toContain('supervisor')
    expect(guidance).toContain('evaluation-loop')
    expect(guidance).toContain('dsh_projects_submit_plan')
    expect(guidance).toContain('replanReason')
    expect(guidance).toContain('EXACTLY ONCE')
    expect(guidance).toContain('UNTRUSTED DATA')
  })

  it('guidance is pure: same version yields identical output', () => {
    expect(coordinatorGuidance()).toBe(coordinatorGuidance())
  })

  it('prompt carries the goal, project, phase, and the one-submission instruction', () => {
    const prompt = coordinatorPrompt({
      goal: 'add a health endpoint',
      projectName: 'dsh-projects',
      projectRoot: '/Users/esne/repo/dsh-projects',
      runPhase: 'planning',
      existingPlans: [],
    })
    expect(prompt).toContain('add a health endpoint')
    expect(prompt).toContain('dsh-projects')
    expect(prompt).toContain('/Users/esne/repo/dsh-projects')
    expect(prompt).toContain('planning')
    expect(prompt).toContain('dsh_projects_submit_plan')
    expect(prompt).toContain('exactly once')
    expect(prompt).not.toContain('replan reason')
  })

  it('prompt lists existing plan versions for replanning and requires replanReason', () => {
    const prompt = coordinatorPrompt({
      goal: 'improve the plan',
      projectName: 'demo',
      projectRoot: '/tmp/demo',
      runPhase: 'planning',
      existingPlans: [
        { version: 1, status: 'superseded', pattern: 'direct', rationale: 'first attempt', replanReason: 'needs orchestration' },
      ],
    })
    expect(prompt).toContain('v1 [superseded]')
    expect(prompt).toContain('pattern=direct')
    expect(prompt).toContain('first attempt')
    expect(prompt).toContain('needs orchestration')
    expect(prompt).toContain('A prior version exists: a new plan requires `replanReason`.')
  })
})
