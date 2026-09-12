import { describe, expect, it, vi } from 'vitest'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import { handleDashboardRpc } from '../src/rpc/handler.ts'
import { DashboardDomainError, decodeDashboardError } from '../src/runtime/errors.ts'
import type { DashboardRuntimeCoordinator } from '../src/runtime/coordinator.ts'
import type { RunPlanService } from '../src/plans/plan-service.ts'
import type { ProjectRunService } from '../src/runs/run-service.ts'
import type { ProjectTaskService } from '../src/tasks/task-service.ts'
import type { ProjectCatalogSelection } from '../src/catalog/types.ts'

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

function fakeRunService(overrides: Partial<Record<'createRun' | 'listForSnapshot' | 'runDetail' | 'transitionRun', unknown>> = {}) {
  return {
    createRun: vi.fn(async () => ({})),
    listForSnapshot: vi.fn(async () => ({ runs: [], total: 0 })),
    runDetail: vi.fn(async () => ({ run: {}, events: [], truncated: false })),
    transitionRun: vi.fn(async () => ({})),
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
