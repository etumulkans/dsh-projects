import { describe, expect, it, vi } from 'vitest'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import { handleDashboardRpc } from '../src/rpc/handler.ts'
import { DashboardDomainError, decodeDashboardError } from '../src/runtime/errors.ts'
import type { DashboardRuntimeCoordinator } from '../src/runtime/coordinator.ts'
import type { ProjectRunService } from '../src/runs/run-service.ts'
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
