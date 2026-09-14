// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import type { CreatePlanInput, RunPlanRecord } from '../src/plans/types.ts'
import type { ProjectRunView, RunDetailView } from '../src/runs/types.ts'

afterEach(cleanup)

const executingRun = fixtureSnapshot.runs!.runs[0]!
const pausedRun = fixtureSnapshot.runs!.runs[1]!
const terminalRun = fixtureSnapshot.runs!.runs[2]!

const PLAN_V1_ID = 'aaaa1111-2222-4333-8444-555566667777'
const PLAN_V2_ID = '5e0d1c88-9a47-4f2e-b3c6-7d8a1f0e9b24'

const planV1: RunPlanRecord = {
  id: PLAN_V1_ID,
  runId: executingRun.id,
  projectId: executingRun.projectId,
  version: 1,
  pattern: 'direct',
  rationale: 'Initial plan: single task executed directly',
  assumptions: ['Task scope is small'],
  successCriteria: [{ id: 'c1', description: 'Health check endpoint is available' }],
  tasks: [
    { id: 't1', title: 'Implement health check endpoint', description: 'Add endpoint and tests', dependencies: [], acceptanceCriteria: ['Return 200 with status JSON'] },
  ],
  status: 'superseded',
  replanReason: 'Scope expanded: unit tests needed',
  createdAt: '2026-08-14T02:11:00.000Z',
  revision: 2,
}

const planV2: RunPlanRecord = {
  id: PLAN_V2_ID,
  runId: executingRun.id,
  projectId: executingRun.projectId,
  version: 2,
  pattern: 'supervisor',
  rationale: 'Coordinate two tasks in parallel',
  assumptions: [],
  successCriteria: [{ id: 'c1', description: 'Endpoint and tests all pass' }],
  tasks: [
    { id: 't1', title: 'Implement health check endpoint', description: 'Add /health endpoint', dependencies: [], acceptanceCriteria: ['Return 200'] },
    { id: 't2', title: 'Add unit tests', description: 'Cover endpoint and error paths', dependencies: ['t1'], acceptanceCriteria: [] },
  ],
  status: 'active',
  replanReason: 'Scope expanded: unit tests needed',
  supersedesPlanId: PLAN_V1_ID,
  createdAt: '2026-08-14T02:20:00.000Z',
  revision: 1,
}

const draftPlan: RunPlanRecord = {
  id: 'bbbb1111-2222-4333-8444-555566667777',
  runId: executingRun.id,
  projectId: executingRun.projectId,
  version: 1,
  pattern: 'supervisor',
  rationale: 'Draft awaiting approval',
  assumptions: [],
  successCriteria: [],
  tasks: [{ id: 't1', title: 'Draft task', description: 'Description', dependencies: [], acceptanceCriteria: [] }],
  status: 'draft',
  createdAt: '2026-08-14T02:25:00.000Z',
  revision: 1,
}

function plansFor(runId: string): RunPlanRecord[] {
  if (runId === executingRun.id) return [planV2, planV1]
  return []
}

async function openRunInspector(run: ProjectRunView): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
  const table = screen.getByRole('table', { name: 'Project Run list' })
  fireEvent.click(within(table).getByRole('row', { name: new RegExp(run.goal.slice(0, 12)) }))
  return screen.getByRole('complementary', { name: /Run details/u })
}

describe('Dashboard Run Plan interactions', () => {
  it('loads plans into the inspector, shows the active chip, and expands a version', async () => {
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))

    expect(within(inspector).getByText('Run Plans')).toBeTruthy()
    expect(within(inspector).getByText('Plan v2 · active')).toBeTruthy()
    expect(within(inspector).getByText('v2')).toBeTruthy()
    expect(within(inspector).getByText('v1')).toBeTruthy()
    expect(within(inspector).getByText('Supervisor')).toBeTruthy()
    expect(within(inspector).getByText('Superseded')).toBeTruthy()

    fireEvent.click(within(inspector).getByRole('button', { name: /v2/u }))
    expect(within(inspector).getByText('Coordinate two tasks in parallel')).toBeTruthy()
    expect(within(inspector).getByText('t2 · Add unit tests')).toBeTruthy()
    expect(within(inspector).getByText('depends on t1')).toBeTruthy()
    expect(within(inspector).getByText('Scope expanded: unit tests needed')).toBeTruthy()

    fireEvent.click(within(inspector).getByRole('button', { name: /v1/u }))
    expect(within(inspector).getByText('Initial plan: single task executed directly')).toBeTruthy()
    expect(within(inspector).getByText('Health check endpoint is available')).toBeTruthy()
  })

  it('shows plan events interleaved on the run timeline', async () => {
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    const onLoadRunDetail = vi.fn(async (runId: string): Promise<RunDetailView> => {
      if (runId !== executingRun.id) throw new Error('unexpected run')
      return {
        run: executingRun,
        truncated: false,
        events: [
          { id: 'e4', type: 'run.replanned', title: 'Run replanned', detail: 'Plan v1 → v2', seq: 4, at: '2026-08-14T02:22:00.000Z' },
          { id: 'e3', type: 'plan.approved', title: 'Plan v2 approved', seq: 3, at: '2026-08-14T02:21:00.000Z' },
          { id: 'e2', type: 'plan.created', title: 'Plan v2 created', seq: 2, at: '2026-08-14T02:20:00.000Z' },
          { id: 'e1', type: 'run.created', title: 'Run created', seq: 1, at: '2026-08-14T02:11:00.000Z' },
        ],
      }
    })
    renderDashboard({ onLoadPlans, onLoadRunDetail })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))
    expect(within(inspector).getByText('Run replanned')).toBeTruthy()
    expect(within(inspector).getByText('Plan v2 approved')).toBeTruthy()
    expect(within(inspector).getByText('Plan v2 created')).toBeTruthy()
    expect(within(inspector).getByText('Run created')).toBeTruthy()
    expect(within(inspector).getByText('Plan v1 → v2')).toBeTruthy()
  })

  it('transitions a draft plan from the version actions with the CAS revision', async () => {
    const onPlanTransition = vi.fn(async () => ({ ...draftPlan, status: 'active' as const }))
    const onLoadPlans = vi.fn(async () => [draftPlan])
    renderDashboard({ onLoadPlans, onPlanTransition })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))
    fireEvent.click(within(inspector).getByRole('button', { name: /v1/u }))

    expect(within(inspector).getByRole('button', { name: 'Request approval' })).toBeTruthy()
    expect(within(inspector).getByRole('button', { name: 'Activate' })).toBeTruthy()

    fireEvent.click(within(inspector).getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(onPlanTransition).toHaveBeenCalledWith({
      planId: draftPlan.id,
      status: 'active',
      expectedRevision: 1,
    }))
  })

  it('supersedes the active plan through the reason dialog and keeps it open on failure', async () => {
    const onPlanTransition = vi.fn(async () => {
      throw new Error('plan.revisionConflict')
    })
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans, onPlanTransition })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))
    fireEvent.click(within(inspector).getByRole('button', { name: /v2/u }))

    fireEvent.click(within(inspector).getByRole('button', { name: 'Supersede' }))
    const dialog = screen.getByRole('dialog', { name: 'Supersede plan v2' })
    const confirm = within(dialog).getByRole('button', { name: 'Supersede' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Replan reason (required)'), { target: { value: ' Direction change ' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => expect(onPlanTransition).toHaveBeenCalledWith({
      planId: PLAN_V2_ID,
      status: 'superseded',
      expectedRevision: planV2.revision,
      replanReason: 'Direction change',
    }))
    // The failed transition keeps the dialog open with its error.
    expect(screen.getByRole('dialog', { name: 'Supersede plan v2' })).toBeTruthy()
    expect(within(dialog).getByRole('alert')).toBeTruthy()
  })

  it('creates a plan from the dialog, requiring the replan reason once versions exist', async () => {
    const onPlanCreate = vi.fn(async (input: CreatePlanInput): Promise<RunPlanRecord> => ({
      ...input,
      id: 'cccc1111-2222-4333-8444-555566667777',
      projectId: executingRun.projectId,
      version: 3,
      assumptions: input.assumptions ?? [],
      successCriteria: (input.successCriteria ?? []).map((description, index) => ({ id: `c${index + 1}`, description })),
      tasks: (input.tasks ?? []).map((task, index) => ({ ...task, id: `t${index + 1}`, dependencies: task.dependencies ?? [], acceptanceCriteria: task.acceptanceCriteria ?? [] })),
      status: 'draft',
      createdAt: '2026-08-14T02:30:00.000Z',
      revision: 1,
    }))
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans, onPlanCreate })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))
    fireEvent.click(within(inspector).getByRole('button', { name: 'New Plan' }))

    const dialog = screen.getByRole('dialog', { name: 'New Run Plan' })
    const create = within(dialog).getByRole('button', { name: 'Create plan' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Rationale'), { target: { value: '  Coordinate two tasks  ' } })
    // Versions exist (v2), so the replan reason is required before enabling.
    expect(create.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Replan reason *'), { target: { value: 'Replan' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add task' }))
    fireEvent.change(within(dialog).getAllByPlaceholderText('Task title')[0]!, { target: { value: 'First task' } })
    fireEvent.change(within(dialog).getAllByPlaceholderText('Task description')[0]!, { target: { value: 'Do something' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add task' }))
    fireEvent.change(within(dialog).getAllByPlaceholderText('Task title')[1]!, { target: { value: 'Second task' } })
    fireEvent.change(within(dialog).getAllByPlaceholderText('Task description')[1]!, { target: { value: 'Do something more' } })
    fireEvent.click(within(dialog).getByLabelText('t1'))

    expect(create.disabled).toBe(false)
    fireEvent.click(create)

    await waitFor(() => expect(onPlanCreate).toHaveBeenCalledWith({
      runId: executingRun.id,
      pattern: 'direct',
      rationale: 'Coordinate two tasks',
      tasks: [
        { title: 'First task', description: 'Do something' },
        { title: 'Second task', description: 'Do something more', dependencies: ['t1'] },
      ],
      replanReason: 'Replan',
    }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Run Plan' })).toBeNull())
  })

  it('shows the empty state with the New Plan action for a run without plans', async () => {
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    const onPlanCreate = vi.fn(async (input: CreatePlanInput): Promise<RunPlanRecord> => ({
      ...input,
      id: 'dddd1111-2222-4333-8444-555566667777',
      projectId: pausedRun.projectId,
      version: 1,
      assumptions: input.assumptions ?? [],
      successCriteria: (input.successCriteria ?? []).map((description, index) => ({ id: `c${index + 1}`, description })),
      tasks: (input.tasks ?? []).map((task, index) => ({ ...task, id: `t${index + 1}`, dependencies: task.dependencies ?? [], acceptanceCriteria: task.acceptanceCriteria ?? [] })),
      status: 'draft',
      createdAt: '2026-08-14T02:30:00.000Z',
      revision: 1,
    }))
    renderDashboard({ onLoadPlans, onPlanCreate })

    const inspector = await openRunInspector(pausedRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(pausedRun.id))
    expect(within(inspector).getByText('No plans for this Run yet.')).toBeTruthy()
    expect(within(inspector).getByRole('button', { name: 'New Plan' })).toBeTruthy()
  })

  it('hides New Plan for a terminal run', async () => {
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans })

    const inspector = await openRunInspector(terminalRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(terminalRun.id))
    expect(within(inspector).queryByRole('button', { name: 'New Plan' })).toBeNull()
  })
})

function renderDashboard(overrides: Partial<ComponentProps<typeof DashboardSurface>> = {}): void {
  render(
    <DashboardSurface
      snapshot={fixtureSnapshot}
      onRefresh={async () => {}}
      onPause={async () => {}}
      onStop={async () => {}}
      onCreateTask={async () => {}}
      onUpdateTask={async () => {}}
      onDeleteTask={async () => {}}
      onSwitchProject={async () => {}}
      onAddDiscoveryRoot={async () => {}}
      onRemoveDiscoveryRoot={async () => {}}
      onScanProjects={async () => ({ root: fixtureSnapshot.catalog.discoveryRoots[0]!, candidates: [], truncated: false })}
      onRegisterProjectCandidate={async () => {}}
      onRegisterProject={async () => {}}
      onOpenSession={() => {}}
      {...overrides}
    />,
  )
}
