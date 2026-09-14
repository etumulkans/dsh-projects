import { describe, expect, it, vi } from 'vitest'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import { handleDashboardRpc } from '../src/rpc/handler.ts'
import { DashboardDomainError, decodeDashboardError } from '../src/runtime/errors.ts'
import type { DashboardRuntimeCoordinator } from '../src/runtime/coordinator.ts'
import type { RunPlanService } from '../src/plans/plan-service.ts'
import type { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectMemoryService } from '../src/memory/memory-service.ts'
import type { ProjectTaskService } from '../src/tasks/task-service.ts'
import type { ProjectCatalogSelection } from '../src/catalog/types.ts'
import type { ApprovalService } from '../src/approvals/approval-service.ts'
import type { ProjectArtifactService } from '../src/artifacts/artifact-service.ts'

describe('Dashboard RPC project switching', () => {
  it('loads a validated timeline page without refreshing the Dashboard snapshot', async () => {
    const page = { events: [], coverage: 'provider-summary', truncated: false } as const
    const issueTimeline = vi.fn(() => page)
    const runtime = { issueTimeline } as unknown as DashboardRuntimeCoordinator

    const result = await handleDashboardRpc(
      runtime,
      'timeline',
      { key: 'local:demo:1', cursor: 'timeline:2026-08-14T10%3A00%3A00.000Z|event-1', limit: 30 },
      new AbortController().signal,
    )

    expect(issueTimeline).toHaveBeenCalledWith('local:demo:1', { cursor: 'timeline:2026-08-14T10%3A00%3A00.000Z|event-1', limit: 30 })
    expect(result).toEqual({ ok: true, value: page })
  })

  it('rejects invalid timeline pagination before dispatch', async () => {
    const issueTimeline = vi.fn()
    const runtime = { issueTimeline } as unknown as DashboardRuntimeCoordinator
    const result = await handleDashboardRpc(runtime, 'timeline', { key: 'local:demo:1', limit: 0 }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(issueTimeline).not.toHaveBeenCalled()
  })

  it('switches to the global composite selection', async () => {
    const switchGlobal = vi.fn(async () => undefined)
    const runtime = {
      switchGlobal,
      snapshot: vi.fn(async () => fixtureSnapshot),
    } as unknown as DashboardRuntimeCoordinator

    const result = await handleDashboardRpc(runtime, 'switchGlobal', {}, new AbortController().signal)

    expect(switchGlobal).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, value: fixtureSnapshot })
  })

  it('dispatches a non-empty project id and returns the post-switch snapshot', async () => {
    const switchProject = vi.fn(async () => undefined)
    const runtime = {
      switchProject,
      snapshot: vi.fn(async () => fixtureSnapshot),
    } as unknown as DashboardRuntimeCoordinator

    const result = await handleDashboardRpc(
      runtime,
      'switchProject',
      { projectId: 'project-2' },
      new AbortController().signal,
    )

    expect(switchProject).toHaveBeenCalledWith('project-2')
    expect(result).toEqual({ ok: true, value: fixtureSnapshot })
  })

  it('preserves structured validation errors and rejects empty project ids before dispatch', async () => {
    const switchProject = vi.fn(async () => {
      throw new DashboardDomainError(
        'project.workflowInvalid',
        'cannot switch to Invalid: invalid workflow',
        { project: 'Invalid', reason: 'invalid workflow' },
      )
    })
    const runtime = { switchProject } as unknown as DashboardRuntimeCoordinator

    const invalid = await handleDashboardRpc(
      runtime,
      'switchProject',
      { projectId: 'invalid-project' },
      new AbortController().signal,
    )
    expect(invalid.ok).toBe(false)
    if (invalid.ok) throw new Error('expected failure')
    expect(invalid.error.code).toBe('bad-request')
    expect(decodeDashboardError(invalid.error.message)).toMatchObject({
      dashboardCode: 'project.workflowInvalid',
      params: { project: 'Invalid', reason: 'invalid workflow' },
    })

    switchProject.mockClear()
    const missing = await handleDashboardRpc(
      runtime,
      'switchProject',
      { projectId: '  ' },
      new AbortController().signal,
    )
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(switchProject).not.toHaveBeenCalled()
  })
})

function fakeRunService(overrides: Partial<Record<'createRun' | 'listForSnapshot' | 'runDetail' | 'transitionRun' | 'setRunBudget', unknown>> = {}) {
  return {
    createRun: vi.fn(async () => ({})),
    listForSnapshot: vi.fn(async () => ({ runs: [], total: 0 })),
    runDetail: vi.fn(async () => ({ run: {}, events: [], truncated: false })),
    transitionRun: vi.fn(async () => ({})),
    setRunBudget: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as ProjectRunService
}

function fakeRuntime(selection: ProjectCatalogSelection) {
  return {
    selection: vi.fn(() => selection),
    snapshot: vi.fn(async () => ({ ...fixtureSnapshot, runs: undefined })),
    refresh: vi.fn(async () => undefined),
  } as unknown as DashboardRuntimeCoordinator
}

describe('Dashboard RPC Project Runs', () => {
  it('attaches the bounded runs projection to state and refresh', async () => {
    const projection = { runs: [{ id: 'run-1' }], total: 1 }
    const listForSnapshot = vi.fn(async () => projection)
    const runs = fakeRunService({ listForSnapshot })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const state = await handleDashboardRpc(runtime, 'state', {}, new AbortController().signal, Promise.resolve(), runs)
    expect(state).toEqual({ ok: true, value: expect.objectContaining({ runs: projection }) })
    expect(listForSnapshot).toHaveBeenLastCalledWith({ mode: 'project', projectId: 'p1' })

    const refresh = await handleDashboardRpc(runtime, 'refresh', {}, new AbortController().signal, Promise.resolve(), runs)
    expect(refresh).toEqual({ ok: true, value: expect.objectContaining({ runs: projection }) })
  })

  it('returns the base snapshot when the Run service is absent', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const state = await handleDashboardRpc(runtime, 'state', {}, new AbortController().signal)
    expect(state).toEqual({ ok: true, value: expect.objectContaining({ runs: undefined }) })
  })

  it('creates a run from a validated payload using the current selection', async () => {
    const createRun = vi.fn(async () => ({}))
    const runs = fakeRunService({ createRun })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'runCreate',
      { goal: 'Ship it', source: 'tracker', sourceRef: 'ENG-1' },
      new AbortController().signal,
      Promise.resolve(),
      runs,
    )

    expect(createRun).toHaveBeenCalledWith(
      { goal: 'Ship it', source: 'tracker', sourceRef: 'ENG-1' },
      { mode: 'project', projectId: 'p1' },
    )
    expect(result).toMatchObject({ ok: true })
  })

  it('rejects invalid runCreate payloads before dispatch', async () => {
    const createRun = vi.fn(async () => ({}))
    const runs = fakeRunService({ createRun })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const signal = () => new AbortController().signal

    const emptyGoal = await handleDashboardRpc(runtime, 'runCreate', { goal: '   ' }, signal(), Promise.resolve(), runs)
    expect(emptyGoal).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const badSource = await handleDashboardRpc(runtime, 'runCreate', { goal: 'x', source: 'nope' }, signal(), Promise.resolve(), runs)
    expect(badSource).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    expect(createRun).not.toHaveBeenCalled()
  })

  it('loads run detail by id', async () => {
    const runDetail = vi.fn(async () => ({ run: { id: 'run-1' }, events: [], truncated: false }))
    const runs = fakeRunService({ runDetail })
    const runtime = fakeRuntime({ mode: 'global' })

    const result = await handleDashboardRpc(runtime, 'runDetail', { runId: 'run-1' }, new AbortController().signal, Promise.resolve(), runs)

    expect(runDetail).toHaveBeenCalledWith('run-1')
    expect(result).toEqual({ ok: true, value: { run: { id: 'run-1' }, events: [], truncated: false } })
  })

  it('rejects runDetail without a run id', async () => {
    const runDetail = vi.fn(async () => ({}))
    const runs = fakeRunService({ runDetail })
    const runtime = fakeRuntime({ mode: 'global' })
    const result = await handleDashboardRpc(runtime, 'runDetail', {}, new AbortController().signal, Promise.resolve(), runs)
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(runDetail).not.toHaveBeenCalled()
  })

  it('applies a validated transition with an optional CAS version', async () => {
    const transitionRun = vi.fn(async () => ({}))
    const runs = fakeRunService({ transitionRun })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'runTransition',
      { runId: 'run-1', to: 'planning', expectedVersion: 2 },
      new AbortController().signal,
      Promise.resolve(),
      runs,
    )

    expect(transitionRun).toHaveBeenCalledWith('run-1', 'planning', { expectedVersion: 2 })
    expect(result).toMatchObject({ ok: true })
  })

  it('carries terminal error and resultSummary options through', async () => {
    const transitionRun = vi.fn(async () => ({}))
    const runs = fakeRunService({ transitionRun })
    const runtime = fakeRuntime({ mode: 'global' })

    await handleDashboardRpc(
      runtime,
      'runTransition',
      { runId: 'run-1', to: 'failed', error: 'boom' },
      new AbortController().signal,
      Promise.resolve(),
      runs,
    )
    await handleDashboardRpc(
      runtime,
      'runTransition',
      { runId: 'run-1', to: 'succeeded', resultSummary: 'done' },
      new AbortController().signal,
      Promise.resolve(),
      runs,
    )

    expect(transitionRun).toHaveBeenNthCalledWith(1, 'run-1', 'failed', { error: 'boom' })
    expect(transitionRun).toHaveBeenNthCalledWith(2, 'run-1', 'succeeded', { resultSummary: 'done' })
  })

  it('rejects invalid runTransition payloads before dispatch', async () => {
    const transitionRun = vi.fn(async () => ({}))
    const runs = fakeRunService({ transitionRun })
    const runtime = fakeRuntime({ mode: 'global' })
    const signal = () => new AbortController().signal

    const badPhase = await handleDashboardRpc(runtime, 'runTransition', { runId: 'r', to: 'sideways' }, signal(), Promise.resolve(), runs)
    expect(badPhase).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const badVersion = await handleDashboardRpc(runtime, 'runTransition', { runId: 'r', to: 'planning', expectedVersion: 0 }, signal(), Promise.resolve(), runs)
    expect(badVersion).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const emptyError = await handleDashboardRpc(runtime, 'runTransition', { runId: 'r', to: 'failed', error: '  ' }, signal(), Promise.resolve(), runs)
    expect(emptyError).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    expect(transitionRun).not.toHaveBeenCalled()
  })

  it('maps a concurrent version conflict to a structured bad request', async () => {
    const transitionRun = vi.fn(async () => {
      throw new DashboardDomainError('run.versionConflict', 'conflict', { expectedVersion: 1, actualVersion: 2 })
    })
    const runs = fakeRunService({ transitionRun })
    const runtime = fakeRuntime({ mode: 'global' })

    const result = await handleDashboardRpc(
      runtime,
      'runTransition',
      { runId: 'r', to: 'planning', expectedVersion: 1 },
      new AbortController().signal,
      Promise.resolve(),
      runs,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (result.ok) throw new Error('expected failure')
    expect(decodeDashboardError(result.error.message)).toMatchObject({
      dashboardCode: 'run.versionConflict',
      params: { expectedVersion: 1, actualVersion: 2 },
    })
  })

  it('reports run endpoints as unavailable when no Run service is mounted', async () => {
    const runtime = fakeRuntime({ mode: 'global' })
    const signal = () => new AbortController().signal
    const created = await handleDashboardRpc(runtime, 'runCreate', { goal: 'x' }, signal(), Promise.resolve())
    const detail = await handleDashboardRpc(runtime, 'runDetail', { runId: 'r' }, signal(), Promise.resolve())
    const transition = await handleDashboardRpc(runtime, 'runTransition', { runId: 'r', to: 'planning' }, signal(), Promise.resolve())
    expect(created).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(detail).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(transition).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
})

function fakePlanService(overrides: Partial<Record<'createPlan' | 'planList' | 'planDetail' | 'transitionPlan', unknown>> = {}) {
  return {
    createPlan: vi.fn(async () => ({})),
    planList: vi.fn(() => []),
    planDetail: vi.fn(() => ({})),
    transitionPlan: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as RunPlanService
}

const PLAN_RUN_ID = 'd0488e0a-7137-41c8-a09c-07c1a0e90f58'
const PLAN_A_ID = 'aaaa1111-2222-4333-8444-555566667777'
const PLAN_B_ID = 'bbbb1111-2222-4333-8444-555566667777'

describe('Dashboard RPC Run Plans', () => {
  it('creates a plan from a validated payload and returns the record', async () => {
    const createPlan = vi.fn(async () => ({ id: PLAN_A_ID, version: 1 }))
    const plans = fakePlanService({ createPlan })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'planCreate',
      {
        runId: PLAN_RUN_ID,
        pattern: 'supervisor',
        rationale: 'coordinate it',
        assumptions: ['a1'],
        successCriteria: ['s1'],
        tasks: [{ title: 'first', description: 'do it', dependencies: [], acceptanceCriteria: ['ac'] }],
        replanReason: 'pivot',
      },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      plans,
    )

    expect(createPlan).toHaveBeenCalledWith({
      runId: PLAN_RUN_ID,
      pattern: 'supervisor',
      rationale: 'coordinate it',
      assumptions: ['a1'],
      successCriteria: ['s1'],
      tasks: [{ title: 'first', description: 'do it', dependencies: [], acceptanceCriteria: ['ac'] }],
      replanReason: 'pivot',
    })
    expect(result).toEqual({ ok: true, value: { id: PLAN_A_ID, version: 1 } })
  })

  it('omits empty optional plan fields before dispatch', async () => {
    const createPlan = vi.fn(async () => ({}))
    const plans = fakePlanService({ createPlan })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    await handleDashboardRpc(
      runtime,
      'planCreate',
      { runId: PLAN_RUN_ID, pattern: 'direct', rationale: '  simple  ' },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      plans,
    )

    expect(createPlan).toHaveBeenCalledWith({ runId: PLAN_RUN_ID, pattern: 'direct', rationale: 'simple' })
  })

  it('rejects invalid planCreate payloads before dispatch', async () => {
    const createPlan = vi.fn(async () => ({}))
    const plans = fakePlanService({ createPlan })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const signal = () => new AbortController().signal

    const missingRun = await handleDashboardRpc(runtime, 'planCreate', { pattern: 'direct', rationale: 'r' }, signal(), Promise.resolve(), undefined, plans)
    expect(missingRun).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const nonUuidRun = await handleDashboardRpc(runtime, 'planCreate', { runId: 'not-a-uuid', pattern: 'direct', rationale: 'r' }, signal(), Promise.resolve(), undefined, plans)
    expect(nonUuidRun).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const badPattern = await handleDashboardRpc(runtime, 'planCreate', { runId: PLAN_RUN_ID, pattern: 'swarm', rationale: 'r' }, signal(), Promise.resolve(), undefined, plans)
    expect(badPattern).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const badTask = await handleDashboardRpc(
      runtime,
      'planCreate',
      { runId: PLAN_RUN_ID, pattern: 'direct', rationale: 'r', tasks: [{ title: 'only title' }] },
      signal(),
      Promise.resolve(),
      undefined,
      plans,
    )
    expect(badTask).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const badArray = await handleDashboardRpc(
      runtime,
      'planCreate',
      { runId: PLAN_RUN_ID, pattern: 'direct', rationale: 'r', assumptions: 'not-an-array' },
      signal(),
      Promise.resolve(),
      undefined,
      plans,
    )
    expect(badArray).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    expect(createPlan).not.toHaveBeenCalled()
  })

  it('lists and loads plans by id', async () => {
    const list = [{ id: PLAN_B_ID, version: 2 }, { id: PLAN_A_ID, version: 1 }]
    const plans = fakePlanService({ planList: vi.fn(() => list), planDetail: vi.fn(() => list[1]!) })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const listed = await handleDashboardRpc(runtime, 'planList', { runId: PLAN_RUN_ID }, new AbortController().signal, Promise.resolve(), undefined, plans)
    expect(listed).toEqual({ ok: true, value: list })

    const detailed = await handleDashboardRpc(runtime, 'planDetail', { planId: PLAN_A_ID }, new AbortController().signal, Promise.resolve(), undefined, plans)
    expect(detailed).toEqual({ ok: true, value: { id: PLAN_A_ID, version: 1 } })

    const missing = await handleDashboardRpc(runtime, 'planDetail', {}, new AbortController().signal, Promise.resolve(), undefined, plans)
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const nonUuid = await handleDashboardRpc(runtime, 'planDetail', { planId: 'nope' }, new AbortController().signal, Promise.resolve(), undefined, plans)
    expect(nonUuid).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('applies a validated plan transition with an optional CAS revision', async () => {
    const transitionPlan = vi.fn(async () => ({ id: PLAN_A_ID, status: 'active' }))
    const plans = fakePlanService({ transitionPlan })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'planTransition',
      { planId: PLAN_A_ID, status: 'active', expectedRevision: 2, replanReason: 'moved' },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      plans,
    )

    expect(transitionPlan).toHaveBeenCalledWith(PLAN_A_ID, 'active', { expectedRevision: 2, replanReason: 'moved' })
    expect(result).toEqual({ ok: true, value: { id: PLAN_A_ID, status: 'active' } })
  })

  it('rejects invalid planTransition payloads before dispatch', async () => {
    const transitionPlan = vi.fn(async () => ({}))
    const plans = fakePlanService({ transitionPlan })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const signal = () => new AbortController().signal

    const badStatus = await handleDashboardRpc(runtime, 'planTransition', { planId: PLAN_A_ID, status: 'sideways' }, signal(), Promise.resolve(), undefined, plans)
    expect(badStatus).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const badRevision = await handleDashboardRpc(runtime, 'planTransition', { planId: PLAN_A_ID, status: 'active', expectedRevision: 0 }, signal(), Promise.resolve(), undefined, plans)
    expect(badRevision).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const missingId = await handleDashboardRpc(runtime, 'planTransition', { status: 'active' }, signal(), Promise.resolve(), undefined, plans)
    expect(missingId).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const nonUuid = await handleDashboardRpc(runtime, 'planTransition', { planId: 'nope', status: 'active' }, signal(), Promise.resolve(), undefined, plans)
    expect(nonUuid).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    expect(transitionPlan).not.toHaveBeenCalled()
  })

  it('maps a plan revision conflict to a structured bad request', async () => {
    const transitionPlan = vi.fn(async () => {
      throw new DashboardDomainError('plan.revisionConflict', 'conflict', { expectedRevision: 1, actualRevision: 2 })
    })
    const plans = fakePlanService({ transitionPlan })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'planTransition',
      { planId: PLAN_A_ID, status: 'active', expectedRevision: 1 },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      plans,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (result.ok) throw new Error('expected failure')
    expect(decodeDashboardError(result.error.message)).toMatchObject({
      dashboardCode: 'plan.revisionConflict',
      params: { expectedRevision: 1, actualRevision: 2 },
    })
  })

  it('reports plan endpoints as unavailable when no Plan service is mounted', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const signal = () => new AbortController().signal
    const created = await handleDashboardRpc(runtime, 'planCreate', { runId: 'r', pattern: 'direct', rationale: 'r' }, signal(), Promise.resolve())
    const listed = await handleDashboardRpc(runtime, 'planList', { runId: 'r' }, signal(), Promise.resolve())
    const detailed = await handleDashboardRpc(runtime, 'planDetail', { planId: 'p' }, signal(), Promise.resolve())
    const transition = await handleDashboardRpc(runtime, 'planTransition', { planId: 'p', status: 'active' }, signal(), Promise.resolve())
    expect(created).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(listed).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(detailed).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(transition).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
})

describe('Dashboard RPC Coordinator (Phase 3)', () => {
  it('dispatches a validated runCoordinate and returns the run record', async () => {
    const coordinate = vi.fn(async () => ({ id: PLAN_RUN_ID, phase: 'planning', coordinatorSessionId: 'dsh-coordinator-abc' }))
    const coordinator = { coordinate } as unknown as import('../src/coordinator/coordinator-service.ts').CoordinatorService
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'runCoordinate',
      { runId: PLAN_RUN_ID },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      undefined,
      coordinator,
    )

    expect(coordinate).toHaveBeenCalledWith(PLAN_RUN_ID)
    expect(result).toEqual({ ok: true, value: { id: PLAN_RUN_ID, phase: 'planning', coordinatorSessionId: 'dsh-coordinator-abc' } })
  })

  it('rejects runCoordinate payloads before dispatch', async () => {
    const coordinate = vi.fn(async () => ({}))
    const coordinator = { coordinate } as unknown as import('../src/coordinator/coordinator-service.ts').CoordinatorService
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const signal = () => new AbortController().signal

    const missing = await handleDashboardRpc(runtime, 'runCoordinate', {}, signal(), Promise.resolve(), undefined, undefined, coordinator)
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const nonUuid = await handleDashboardRpc(runtime, 'runCoordinate', { runId: 'nope' }, signal(), Promise.resolve(), undefined, undefined, coordinator)
    expect(nonUuid).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    expect(coordinate).not.toHaveBeenCalled()
  })

  it('maps coordinator domain errors to structured bad requests', async () => {
    const coordinate = vi.fn(async () => {
      throw new DashboardDomainError('coordinator.runPhaseInvalid', 'wrong phase', { runId: PLAN_RUN_ID, phase: 'executing' })
    })
    const coordinator = { coordinate } as unknown as import('../src/coordinator/coordinator-service.ts').CoordinatorService
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'runCoordinate',
      { runId: PLAN_RUN_ID },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      undefined,
      coordinator,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (result.ok) throw new Error('expected failure')
    expect(decodeDashboardError(result.error.message)).toMatchObject({
      dashboardCode: 'coordinator.runPhaseInvalid',
      params: { runId: PLAN_RUN_ID, phase: 'executing' },
    })
  })

  it('reports runCoordinate as unavailable when no Coordinator service is mounted', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const result = await handleDashboardRpc(runtime, 'runCoordinate', { runId: PLAN_RUN_ID }, new AbortController().signal, Promise.resolve())
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
})

function fakeTaskService(overrides: Partial<Record<'taskList' | 'taskCounts' | 'taskRetry' | 'workerKind', unknown>> = {}) {
  return {
    taskList: vi.fn(() => []),
    taskCounts: vi.fn(() => ({ total: 0, pending: 0, ready: 0, running: 0, blocked: 0, failed: 0, succeeded: 0 })),
    taskRetry: vi.fn(async () => ({})),
    workerKind: vi.fn(() => 'local'),
    ...overrides,
  } as unknown as ProjectTaskService
}

const TASK_ID = 'c1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8'

describe('Dashboard RPC Task execution', () => {
  it('dispatches taskRetry with a validated uuid taskId', async () => {
    const taskRetry = vi.fn(async (taskId: string) => ({ id: taskId, status: 'ready' }))
    const tasks = fakeTaskService({ taskRetry })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'taskRetry',
      { taskId: TASK_ID },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      undefined,
      undefined,
      tasks,
    )

    expect(taskRetry).toHaveBeenCalledWith(TASK_ID)
    expect(result).toEqual({ ok: true, value: { id: TASK_ID, status: 'ready' } })
  })

  it('rejects invalid taskRetry payloads and a missing service before dispatch', async () => {
    const taskRetry = vi.fn(async () => ({}))
    const tasks = fakeTaskService({ taskRetry })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const signal = () => new AbortController().signal

    const nonUuid = await handleDashboardRpc(
      runtime, 'taskRetry', { taskId: 'nope' }, signal(), Promise.resolve(), undefined, undefined, undefined, tasks,
    )
    expect(nonUuid).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const missing = await handleDashboardRpc(
      runtime, 'taskRetry', {}, signal(), Promise.resolve(), undefined, undefined, undefined, tasks,
    )
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const unmounted = await handleDashboardRpc(runtime, 'taskRetry', { taskId: TASK_ID }, signal(), Promise.resolve())
    expect(unmounted).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    expect(taskRetry).not.toHaveBeenCalled()
  })

  it('carries taskRetry domain errors as structured bad requests', async () => {
    const taskRetry = vi.fn(async () => {
      throw new DashboardDomainError('task.retryNotAllowed', 'not retryable', { taskId: TASK_ID, status: 'ready' })
    })
    const tasks = fakeTaskService({ taskRetry })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'taskRetry',
      { taskId: TASK_ID },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      undefined,
      undefined,
      tasks,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (result.ok) throw new Error('expected failure')
    expect(decodeDashboardError(result.error.message)).toMatchObject({
      dashboardCode: 'task.retryNotAllowed',
      params: { taskId: TASK_ID, status: 'ready' },
    })

    // task.unknown rides the same structured mapping
    const unknownService = fakeTaskService({
      taskRetry: vi.fn(async () => {
        throw new DashboardDomainError('task.unknown', 'unknown task', { taskId: TASK_ID })
      }),
    })
    const unknown = await handleDashboardRpc(
      runtime,
      'taskRetry',
      { taskId: TASK_ID },
      new AbortController().signal,
      Promise.resolve(),
      undefined,
      undefined,
      undefined,
      unknownService,
    )
    expect(unknown).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (unknown.ok) throw new Error('expected failure')
    expect(decodeDashboardError(unknown.error.message)).toMatchObject({
      dashboardCode: 'task.unknown',
      params: { taskId: TASK_ID },
    })
  })

  it('attaches the run tasks to runDetail only when a task service is mounted', async () => {
    const taskList = vi.fn(() => [{ id: TASK_ID, status: 'succeeded' }])
    const tasks = fakeTaskService({ taskList })
    const runs = fakeRunService({ runDetail: vi.fn(async () => ({ run: { id: PLAN_RUN_ID }, events: [], truncated: false })) })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const withTasks = await handleDashboardRpc(
      runtime,
      'runDetail',
      { runId: PLAN_RUN_ID },
      new AbortController().signal,
      Promise.resolve(),
      runs,
      undefined,
      undefined,
      tasks,
    )
    expect(taskList).toHaveBeenCalledWith(PLAN_RUN_ID)
    expect(withTasks).toMatchObject({
      ok: true,
      value: expect.objectContaining({
        run: { id: PLAN_RUN_ID },
        tasks: [{ id: TASK_ID, status: 'succeeded' }],
      }),
    })

    const withoutTasks = await handleDashboardRpc(
      runtime, 'runDetail', { runId: PLAN_RUN_ID }, new AbortController().signal, Promise.resolve(), runs,
    )
    expect(withoutTasks).toMatchObject({ ok: true, value: expect.objectContaining({ run: { id: PLAN_RUN_ID } }) })
    if (withoutTasks.ok) expect(withoutTasks.value).not.toHaveProperty('tasks')
  })

  it('passes the Phase 5 Git fields through runDetail, run views, and the event stream', async () => {
    // The RPC layer never re-derives Git state: the view, the task rows, and
    // the integration events must arrive exactly as the services report them.
    const integrationBranch = 'dsh/run-a1b2c3d4/integration'
    const runView = {
      id: PLAN_RUN_ID,
      phase: 'succeeded',
      integrationBranch,
      integrationHead: '9e8d7c6b5a493827160514233241506978879605',
      resultSummary: `integrated branch ${integrationBranch} @ 9e8d7c6b`,
    }
    const events = [
      {
        id: 'e-int-start', runId: PLAN_RUN_ID, type: 'run.integration.started',
        title: 'Integration started', detail: integrationBranch, seq: 9, at: '2026-08-14T10:00:00.000Z',
      },
      {
        id: 'e-int-done', runId: PLAN_RUN_ID, type: 'run.integration.completed',
        title: 'Integration completed',
        detail: '2 task branch(es) into dsh/run-a1b2c3d4/integration @ 9e8d7c6b',
        seq: 10, at: '2026-08-14T10:00:05.000Z',
      },
    ]
    const gitTask = {
      id: TASK_ID,
      planTaskId: 't1',
      status: 'succeeded',
      branch: 'dsh/run-a1b2c3d4/t1',
      baseCommit: '1111111111111111111111111111111111111111',
      headCommit: '2222222222222222222222222222222222222222',
    }
    const taskList = vi.fn(() => [gitTask])
    const runs = fakeRunService({
      runDetail: vi.fn(async () => ({ run: runView, events, truncated: false })),
      listForSnapshot: vi.fn(async () => ({ runs: [runView], total: 1 })),
    })
    const tasks = fakeTaskService({ taskList })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const detail = await handleDashboardRpc(
      runtime, 'runDetail', { runId: PLAN_RUN_ID }, new AbortController().signal, Promise.resolve(), runs, undefined, undefined, tasks,
    )
    expect(detail).toMatchObject({
      ok: true,
      value: expect.objectContaining({
        run: expect.objectContaining({ integrationBranch, integrationHead: runView.integrationHead }),
        tasks: [expect.objectContaining({ branch: gitTask.branch, baseCommit: gitTask.baseCommit, headCommit: gitTask.headCommit })],
      }),
    })
    if (detail.ok) {
      const value = detail.value as { events?: readonly { type: string; detail?: string }[] }
      expect(value.events).toEqual(events)
    }

    // The same fields ride the bounded runs projection (state/refresh).
    const state = await handleDashboardRpc(runtime, 'state', {}, new AbortController().signal, Promise.resolve(), runs)
    expect(state).toMatchObject({
      ok: true,
      value: expect.objectContaining({ runs: { runs: [expect.objectContaining({ integrationBranch })], total: 1 } }),
    })

    // A blocked run's integration-failed event (conflict paths) passes through too.
    const blockedView = { id: PLAN_RUN_ID, phase: 'blocked', suspendedFrom: 'integrating', integrationBranch }
    const failedEvent = {
      id: 'e-int-fail', runId: PLAN_RUN_ID, type: 'run.integration.failed',
      title: 'Integration failed', detail: 'integration conflict: src/clash.ts', seq: 11,
      at: '2026-08-14T10:01:00.000Z',
    }
    const blockedRuns = fakeRunService({ runDetail: vi.fn(async () => ({ run: blockedView, events: [failedEvent], truncated: false })) })
    const blocked = await handleDashboardRpc(
      runtime, 'runDetail', { runId: PLAN_RUN_ID }, new AbortController().signal, Promise.resolve(), blockedRuns,
    )
    if (blocked.ok) {
      expect(blocked.value).toMatchObject({
        run: expect.objectContaining({ phase: 'blocked', suspendedFrom: 'integrating', integrationBranch }),
        events: [failedEvent],
      })
    } else {
      throw new Error('expected success')
    }
  })

  it('enriches state and refresh with the worker kind and per-run task counts', async () => {
    const counts = { total: 2, pending: 0, ready: 0, running: 1, blocked: 0, failed: 0, succeeded: 1 }
    const taskCounts = vi.fn((runId: string) => (runId === 'run-1' ? counts : { ...counts, total: 0 }))
    const tasks = fakeTaskService({ taskCounts })
    const projection = { runs: [{ id: 'run-1' }, { id: 'run-2' }], total: 2 }
    const runs = fakeRunService({ listForSnapshot: vi.fn(async () => projection) })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const state = await handleDashboardRpc(
      runtime, 'state', {}, new AbortController().signal, Promise.resolve(), runs, undefined, undefined, tasks,
    )
    expect(state).toEqual({
      ok: true,
      value: expect.objectContaining({
        runs: expect.objectContaining({
          worker: 'local',
          runs: [
            expect.objectContaining({ id: 'run-1', taskCounts: counts }),
            expect.objectContaining({ id: 'run-2', taskCounts: { ...counts, total: 0 } }),
          ],
        }),
      }),
    })
    expect(taskCounts).toHaveBeenNthCalledWith(1, 'run-1')
    expect(taskCounts).toHaveBeenNthCalledWith(2, 'run-2')

    const refresh = await handleDashboardRpc(
      runtime, 'refresh', {}, new AbortController().signal, Promise.resolve(), runs, undefined, undefined, tasks,
    )
    expect(refresh).toMatchObject({ ok: true, value: expect.objectContaining({ runs: expect.objectContaining({ worker: 'local' }) }) })

    const plain = await handleDashboardRpc(runtime, 'state', {}, new AbortController().signal, Promise.resolve(), runs)
    expect(plain).toMatchObject({ ok: true, value: expect.objectContaining({ runs: projection }) })
    if (plain.ok) {
      expect(plain.value).not.toHaveProperty('worker')
      expect((plain.value as { runs?: { runs?: unknown[] } }).runs?.runs?.[0]).not.toHaveProperty('taskCounts')
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 6: Project Memory endpoints (spec §9)
// ---------------------------------------------------------------------------

const MEMORY_ID = '5b0e6c9e-4a2d-4c8e-9f1b-3d7e5a6b8c9d'

function fakeMemoryService(overrides: Partial<Record<'list' | 'create' | 'update' | 'setStatus', unknown>> = {}) {
  return {
    list: vi.fn(async () => ({ entries: [], counts: {} })),
    create: vi.fn(async () => ({ entry: { id: MEMORY_ID } })),
    update: vi.fn(async () => ({ id: MEMORY_ID })),
    setStatus: vi.fn(async () => ({ id: MEMORY_ID })),
    ...overrides,
  } as unknown as ProjectMemoryService
}

describe('Dashboard RPC Project Memory (spec §9)', () => {
  const signal = () => new AbortController().signal

  it('memoryList passes the query filters through and returns entries + zero-filled counts', async () => {
    const counts = { architecture: 1, decision: 0 }
    const list = vi.fn(async () => ({ entries: [{ id: MEMORY_ID, kind: 'architecture' }], counts }))
    const memory = fakeMemoryService({ list })
    const result = await handleDashboardRpc(
      fakeRuntime({ mode: 'project', projectId: 'p1' }),
      'memoryList',
      { projectId: 'p1', query: 'postgres', kinds: ['testing'], tags: ['db'], limit: 10, includeArchived: true },
      signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(result).toMatchObject({ ok: true, value: { entries: [{ id: MEMORY_ID, kind: 'architecture' }], counts } })
    expect(list).toHaveBeenCalledWith({
      projectId: 'p1',
      query: 'postgres',
      kinds: ['testing'],
      tags: ['db'],
      limit: 10,
      includeArchived: true,
    })
    // without optional filters the payload stays minimal
    const minimal = vi.fn(async () => ({ entries: [], counts: {} }))
    const minimalResult = await handleDashboardRpc(
      fakeRuntime({ mode: 'project', projectId: 'p1' }),
      'memoryList',
      { projectId: 'p1' },
      signal(), Promise.resolve(), undefined, undefined, undefined, undefined, fakeMemoryService({ list: minimal }),
    )
    expect(minimalResult).toMatchObject({ ok: true })
    expect(minimal).toHaveBeenCalledWith({ projectId: 'p1' })
  })

  it('memoryList rejects an unmounted service, a missing projectId, and invalid filters', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const unmounted = await handleDashboardRpc(runtime, 'memoryList', { projectId: 'p1' }, signal())
    expect(unmounted).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('not mounted') } })
    const missing = await handleDashboardRpc(
      runtime, 'memoryList', {}, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, fakeMemoryService(),
    )
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('projectId') } })
    const memory = fakeMemoryService()
    const badKinds = await handleDashboardRpc(
      runtime, 'memoryList', { projectId: 'p1', kinds: ['nope'] }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(badKinds).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('kinds') } })
    const badLimit = await handleDashboardRpc(
      runtime, 'memoryList', { projectId: 'p1', limit: 0 }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(badLimit).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('limit') } })
    expect(memory.list).not.toHaveBeenCalled()
  })

  it('memoryCreate passes the candidate through and surfaces the supersession link', async () => {
    const entry = { id: MEMORY_ID, kind: 'testing', title: 'Tests need Postgres', body: 'start postgres first', status: 'active', version: 2 }
    const create = vi.fn(async () => ({ entry, supersededId: 'old-entry' }))
    const memory = fakeMemoryService({ create })
    const result = await handleDashboardRpc(
      fakeRuntime({ mode: 'project', projectId: 'p1' }),
      'memoryCreate',
      { projectId: 'p1', kind: 'testing', title: 'Tests need Postgres', body: 'start postgres first', tags: ['db'], pinned: true, confidence: 0.8 },
      signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(result).toMatchObject({ ok: true, value: { entry, supersededId: 'old-entry' } })
    expect(create).toHaveBeenCalledWith({
      projectId: 'p1',
      kind: 'testing',
      title: 'Tests need Postgres',
      body: 'start postgres first',
      tags: ['db'],
      pinned: true,
      confidence: 0.8,
    })
  })

  it('memoryCreate rejects invalid payloads and propagates service validation failures', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const memory = fakeMemoryService()
    const missingTitle = await handleDashboardRpc(
      runtime, 'memoryCreate', { projectId: 'p1', kind: 'testing', title: '  ', body: 'b' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(missingTitle).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('title') } })
    const badKind = await handleDashboardRpc(
      runtime, 'memoryCreate', { projectId: 'p1', kind: 'nope', title: 't', body: 'b' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(badKind).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('kind') } })
    const badConfidence = await handleDashboardRpc(
      runtime, 'memoryCreate', { projectId: 'p1', kind: 'testing', title: 't', body: 'b', confidence: 2 }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(badConfidence).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('confidence') } })
    expect(memory.create).not.toHaveBeenCalled()
    // a service-level validation failure rides the structured error path
    const failing = fakeMemoryService({
      create: vi.fn(async () => {
        throw new DashboardDomainError('memory.invalidCandidate', 'invalid', { reason: 'body-too-long' })
      }),
    })
    const invalid = await handleDashboardRpc(
      runtime, 'memoryCreate', { projectId: 'p1', kind: 'testing', title: 't', body: 'b' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, failing,
    )
    expect(invalid.ok).toBe(false)
    if (invalid.ok === false) {
      expect(decodeDashboardError(invalid.error.message)).toMatchObject({
        dashboardCode: 'memory.invalidCandidate',
        params: expect.objectContaining({ reason: 'body-too-long' }),
      })
    }
  })

  it('memoryUpdate requires the expected version and at least one patch field', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const update = vi.fn(async () => ({ id: MEMORY_ID, version: 2 }))
    const memory = fakeMemoryService({ update })
    const result = await handleDashboardRpc(
      runtime, 'memoryUpdate',
      { id: MEMORY_ID, expectedVersion: 1, body: 'new body', pinned: false },
      signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(result).toMatchObject({ ok: true, value: { id: MEMORY_ID, version: 2 } })
    expect(update).toHaveBeenCalledWith(MEMORY_ID, 1, { body: 'new body', pinned: false })
    const noVersion = await handleDashboardRpc(
      runtime, 'memoryUpdate', { id: MEMORY_ID, title: 't' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(noVersion).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('expectedVersion') } })
    const emptyPatch = await handleDashboardRpc(
      runtime, 'memoryUpdate', { id: MEMORY_ID, expectedVersion: 1 }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(emptyPatch).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('at least one patch field') } })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('memorySetStatus validates the target status and propagates CAS failures', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const setStatus = vi.fn(async () => ({ id: MEMORY_ID, status: 'archived' }))
    const memory = fakeMemoryService({ setStatus })
    const result = await handleDashboardRpc(
      runtime, 'memorySetStatus',
      { id: MEMORY_ID, expectedVersion: 1, status: 'archived' },
      signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(result).toMatchObject({ ok: true, value: { id: MEMORY_ID, status: 'archived' } })
    expect(setStatus).toHaveBeenCalledWith(MEMORY_ID, 1, 'archived')
    const badStatus = await handleDashboardRpc(
      runtime, 'memorySetStatus', { id: MEMORY_ID, expectedVersion: 1, status: 'deleted' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, memory,
    )
    expect(badStatus).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('status') } })
    const stale = fakeMemoryService({
      setStatus: vi.fn(async () => {
        throw new DashboardDomainError('memory.staleVersion', 'stale', { expectedVersion: 1, actualVersion: 3 })
      }),
    })
    const conflict = await handleDashboardRpc(
      runtime, 'memorySetStatus', { id: MEMORY_ID, expectedVersion: 1, status: 'archived' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, stale,
    )
    expect(conflict.ok).toBe(false)
    if (conflict.ok === false) {
      expect(decodeDashboardError(conflict.error.message)).toMatchObject({
        dashboardCode: 'memory.staleVersion',
        params: expect.objectContaining({ expectedVersion: 1, actualVersion: 3 }),
      })
    }
  })
})

function fakeApprovalService(overrides: Partial<Record<'listApprovals' | 'resolveApproval' | 'expireApproval' | 'pendingFor', unknown>> = {}) {
  return {
    listApprovals: vi.fn(() => []),
    resolveApproval: vi.fn(async () => ({ id: 'approval-1', status: 'approved' })),
    expireApproval: vi.fn(async () => ({ id: 'approval-1', status: 'expired' })),
    pendingFor: vi.fn(() => undefined),
    ...overrides,
  } as unknown as ApprovalService
}

describe('Dashboard RPC Approvals + budgets (Phase 7, spec §6.2)', () => {
  const signal = () => new AbortController().signal
  const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'
  const APPROVAL_ID = '9b1deb4d-3b7d-4bad-9bdd-2d06a2985a57'

  it('approvalList requires a runId or projectId and passes filters through', async () => {
    const listApprovals = vi.fn(() => [{ id: APPROVAL_ID, status: 'pending', type: 'merge' }])
    const approvals = fakeApprovalService({ listApprovals })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const none = await handleDashboardRpc(runtime, 'approvalList', {}, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals)
    expect(none).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(listApprovals).not.toHaveBeenCalled()

    const byRun = await handleDashboardRpc(runtime, 'approvalList', { runId: RUN_ID }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals)
    expect(byRun).toMatchObject({ ok: true, value: { approvals: [{ id: APPROVAL_ID }] } })
    expect(listApprovals).toHaveBeenLastCalledWith(RUN_ID, undefined)

    const byProject = await handleDashboardRpc(runtime, 'approvalList', { projectId: 'p1' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals)
    expect(byProject).toMatchObject({ ok: true })
    expect(listApprovals).toHaveBeenLastCalledWith(undefined, 'p1')
  })

  it('approvalList is unavailable without an Approval service', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const result = await handleDashboardRpc(runtime, 'approvalList', { runId: RUN_ID }, signal(), Promise.resolve())
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('not mounted') } })
  })

  it('approvalResolve dispatches a validated decision with optional CAS + resolver', async () => {
    const resolveApproval = vi.fn(async () => ({ id: APPROVAL_ID, status: 'approved' }))
    const approvals = fakeApprovalService({ resolveApproval })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime, 'approvalResolve', { id: APPROVAL_ID, decision: 'approved', expectedVersion: 2, resolvedBy: 'alice' },
      signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals,
    )
    expect(result).toMatchObject({ ok: true, value: { status: 'approved' } })
    expect(resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, 'approved', { expectedVersion: 2, resolvedBy: 'alice' })

    const noDecision = await handleDashboardRpc(runtime, 'approvalResolve', { id: APPROVAL_ID, decision: 'maybe' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals)
    expect(noDecision).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const noId = await handleDashboardRpc(runtime, 'approvalResolve', { decision: 'approved' }, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals)
    expect(noId).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('approvalExpire dispatches a validated id with optional CAS', async () => {
    const expireApproval = vi.fn(async () => ({ id: APPROVAL_ID, status: 'expired' }))
    const approvals = fakeApprovalService({ expireApproval })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime, 'approvalExpire', { id: APPROVAL_ID, expectedVersion: 1 },
      signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals,
    )
    expect(result).toMatchObject({ ok: true, value: { status: 'expired' } })
    expect(expireApproval).toHaveBeenCalledWith(APPROVAL_ID, { expectedVersion: 1 })

    const noId = await handleDashboardRpc(runtime, 'approvalExpire', {}, signal(), Promise.resolve(), undefined, undefined, undefined, undefined, undefined, approvals)
    expect(noId).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('runSetBudget dispatches a validated budget with optional CAS', async () => {
    const setRunBudget = vi.fn(async () => ({ id: RUN_ID, budget: { maxTotalTokens: 1000 } }))
    const runs = fakeRunService({ setRunBudget })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime, 'runSetBudget', { runId: RUN_ID, budget: { maxTotalTokens: 1000, maxRuntimeMinutes: 30 }, expectedVersion: 3 },
      signal(), Promise.resolve(), runs,
    )
    expect(result).toMatchObject({ ok: true, value: { budget: { maxTotalTokens: 1000 } } })
    expect(setRunBudget).toHaveBeenCalledWith(RUN_ID, { maxTotalTokens: 1000, maxRuntimeMinutes: 30 }, 3)

    const noBudget = await handleDashboardRpc(runtime, 'runSetBudget', { runId: RUN_ID }, signal(), Promise.resolve(), runs)
    expect(noBudget).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    // A non-object budget is rejected at the handler; per-key limits are
    // validated by the Run service (run.budgetInvalid).
    const notObject = await handleDashboardRpc(runtime, 'runSetBudget', { runId: RUN_ID, budget: 42 }, signal(), Promise.resolve(), runs)
    expect(notObject).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(setRunBudget).toHaveBeenCalledTimes(1)
  })

  it('runSetBudget is unavailable without a Run service', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const result = await handleDashboardRpc(runtime, 'runSetBudget', { runId: RUN_ID, budget: { maxTotalTokens: 1 } }, signal(), Promise.resolve())
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('not mounted') } })
  })

  it('runCreate carries approvalMode and budget through to the Run service', async () => {
    const createRun = vi.fn(async () => ({}))
    const runs = fakeRunService({ createRun })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(
      runtime,
      'runCreate',
      { goal: 'Ship it', approvalMode: 'guarded', budget: { maxTotalTokens: 5000, maxAgents: 2 } },
      signal(), Promise.resolve(), runs,
    )
    expect(result).toMatchObject({ ok: true })
    expect(createRun).toHaveBeenCalledWith(
      { goal: 'Ship it', approvalMode: 'guarded', budget: { maxTotalTokens: 5000, maxAgents: 2 } },
      { mode: 'project', projectId: 'p1' },
    )

    const badMode = await handleDashboardRpc(runtime, 'runCreate', { goal: 'x', approvalMode: 'yolo' }, signal(), Promise.resolve(), runs)
    expect(badMode).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(createRun).toHaveBeenCalledTimes(1)
  })

  it('runDetail attaches the run approvals when an Approval service is mounted', async () => {
    const runDetail = vi.fn(async () => ({ run: { id: RUN_ID }, events: [], truncated: false }))
    const listApprovals = vi.fn(() => [{ id: APPROVAL_ID, status: 'pending', type: 'plan' }])
    const runs = fakeRunService({ runDetail })
    const approvals = fakeApprovalService({ listApprovals })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const withApprovals = await handleDashboardRpc(
      runtime, 'runDetail', { runId: RUN_ID }, signal(), Promise.resolve(), runs, undefined, undefined, undefined, undefined, approvals,
    )
    expect(withApprovals).toMatchObject({ ok: true, value: { run: { id: RUN_ID }, approvals: [{ id: APPROVAL_ID, type: 'plan' }] } })
    expect(listApprovals).toHaveBeenCalledWith(RUN_ID)

    const bare = await handleDashboardRpc(runtime, 'runDetail', { runId: RUN_ID }, signal(), Promise.resolve(), runs)
    expect(bare).toMatchObject({ ok: true, value: { run: { id: RUN_ID } } })
    expect((bare as { value: Record<string, unknown> }).value.approvals).toBeUndefined()
  })
})

function fakeArtifactService(overrides: Partial<Record<'list' | 'create' | 'get' | 'generateFinalReport', unknown>> = {}) {
  return {
    list: vi.fn(() => []),
    create: vi.fn(async () => ({ id: 'artifact-1', kind: 'plan', title: 'Plan' })),
    get: vi.fn(() => undefined),
    generateFinalReport: vi.fn(async () => ({ id: 'artifact-final', kind: 'final-report', title: 'Final report' })),
    ...overrides,
  } as unknown as ProjectArtifactService
}

describe('Dashboard RPC Artifacts (Phase 8, spec §11.4)', () => {
  const signal = () => new AbortController().signal
  const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'
  const ARTIFACT_ID = '9b1deb4d-3b7d-4bad-9bdd-2d06a2985a57'
  const NO_SERVICES = [undefined, undefined, undefined, undefined, undefined, undefined] as const

  it('artifactList requires a runId or projectId and passes filters through', async () => {
    const list = vi.fn(() => [{ id: ARTIFACT_ID, kind: 'plan', title: 'Plan' }])
    const artifacts = fakeArtifactService({ list })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const none = await handleDashboardRpc(runtime, 'artifactList', {}, signal(), Promise.resolve(), ...NO_SERVICES, artifacts)
    expect(none).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(list).not.toHaveBeenCalled()

    const byRun = await handleDashboardRpc(runtime, 'artifactList', { runId: RUN_ID }, signal(), Promise.resolve(), ...NO_SERVICES, artifacts)
    expect(byRun).toMatchObject({ ok: true, value: { artifacts: [{ id: ARTIFACT_ID }] } })
    expect(list).toHaveBeenLastCalledWith({ runId: RUN_ID })

    const byProject = await handleDashboardRpc(runtime, 'artifactList', { projectId: 'p1', kind: 'plan' }, signal(), Promise.resolve(), ...NO_SERVICES, artifacts)
    expect(byProject).toMatchObject({ ok: true })
    expect(list).toHaveBeenLastCalledWith({ projectId: 'p1', kind: 'plan' })
  })

  it('artifactList is unavailable without an Artifact service', async () => {
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })
    const result = await handleDashboardRpc(runtime, 'artifactList', { runId: RUN_ID }, signal(), Promise.resolve())
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('not mounted') } })
  })

  it('artifactCreate dispatches a validated input', async () => {
    const create = vi.fn(async () => ({ id: ARTIFACT_ID, kind: 'plan', title: 'Plan' }))
    const artifacts = fakeArtifactService({ create })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const ok = await handleDashboardRpc(
      runtime, 'artifactCreate', { projectId: 'p1', kind: 'plan', title: 'Plan' }, signal(), Promise.resolve(), ...NO_SERVICES, artifacts,
    )
    expect(ok).toMatchObject({ ok: true, value: { id: ARTIFACT_ID } })
    expect(create).toHaveBeenCalledWith({ projectId: 'p1', kind: 'plan', title: 'Plan' })

    const missingTitle = await handleDashboardRpc(
      runtime, 'artifactCreate', { projectId: 'p1', kind: 'plan' }, signal(), Promise.resolve(), ...NO_SERVICES, artifacts,
    )
    expect(missingTitle).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('artifactGet returns the record or a structured unknown error', async () => {
    const get = vi.fn(() => ({ id: ARTIFACT_ID, kind: 'plan', title: 'Plan' }))
    const artifacts = fakeArtifactService({ get })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const found = await handleDashboardRpc(runtime, 'artifactGet', { id: ARTIFACT_ID }, signal(), Promise.resolve(), ...NO_SERVICES, artifacts)
    expect(found).toMatchObject({ ok: true, value: { id: ARTIFACT_ID } })
    expect(get).toHaveBeenCalledWith(ARTIFACT_ID)

    const missing = vi.fn(() => undefined)
    const missingService = fakeArtifactService({ get: missing })
    const notFound = await handleDashboardRpc(runtime, 'artifactGet', { id: ARTIFACT_ID }, signal(), Promise.resolve(), ...NO_SERVICES, missingService)
    expect(notFound).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('runGenerateReport dispatches in on-demand mode', async () => {
    const generateFinalReport = vi.fn(async () => ({ id: 'artifact-final', kind: 'final-report', title: 'Final report' }))
    const artifacts = fakeArtifactService({ generateFinalReport })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const result = await handleDashboardRpc(runtime, 'runGenerateReport', { runId: RUN_ID }, signal(), Promise.resolve(), ...NO_SERVICES, artifacts)
    expect(result).toMatchObject({ ok: true, value: { kind: 'final-report' } })
    expect(generateFinalReport).toHaveBeenCalledWith(RUN_ID, 'on-demand')

    const badRun = await handleDashboardRpc(runtime, 'runGenerateReport', { runId: 'nope' }, signal(), Promise.resolve(), ...NO_SERVICES, artifacts)
    expect(badRun).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('runDetail attaches the run artifacts + final report when the Artifact service is mounted', async () => {
    const finalReport = { id: 'artifact-final', kind: 'final-report', title: 'Final report', content: 'Goal\nx' }
    const list = vi.fn(() => [{ id: ARTIFACT_ID, kind: 'plan', title: 'Plan' }, finalReport])
    const runDetail = vi.fn(async () => ({ run: { id: RUN_ID }, events: [], truncated: false }))
    const runs = fakeRunService({ runDetail })
    const artifacts = fakeArtifactService({ list })
    const runtime = fakeRuntime({ mode: 'project', projectId: 'p1' })

    const withArtifacts = await handleDashboardRpc(
      runtime, 'runDetail', { runId: RUN_ID }, signal(), Promise.resolve(), runs, undefined, undefined, undefined, undefined, undefined, artifacts,
    )
    expect(withArtifacts).toMatchObject({
      ok: true,
      value: {
        run: { id: RUN_ID },
        artifacts: [{ id: ARTIFACT_ID }, finalReport],
        finalReport,
      },
    })
    expect(list).toHaveBeenCalledWith({ runId: RUN_ID })

    const bare = await handleDashboardRpc(runtime, 'runDetail', { runId: RUN_ID }, signal(), Promise.resolve(), runs)
    expect(bare).toMatchObject({ ok: true, value: { run: { id: RUN_ID } } })
    expect((bare as { value: Record<string, unknown> }).value.artifacts).toBeUndefined()
  })
})
