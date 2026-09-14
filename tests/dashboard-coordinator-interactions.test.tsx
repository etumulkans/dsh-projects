// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import type { ProjectRunView, RunDetailView } from '../src/runs/types.ts'

afterEach(cleanup)

const executingRun = fixtureSnapshot.runs!.runs[0]!
const terminalRun = fixtureSnapshot.runs!.runs[2]!

const PLANNING_RUN_ID = 'eeee1111-2222-4333-8444-555566667777'

// Omit `activePlanId` via destructure so the optional key is absent, not
// `undefined` (exactOptionalPropertyTypes).
const { activePlanId: _omitActivePlan, ...executingRunBase } = executingRun
const planningRun: ProjectRunView = {
  ...executingRunBase,
  id: PLANNING_RUN_ID,
  goal: 'Run that needs coordination',
  phase: 'planning',
  coordinatorSessionId: 'dsh-coordinator-12345678-1234-4123-8123-123456789abc',
  version: 3,
}

const planningSnapshot: NonNullable<typeof fixtureSnapshot> = {
  ...fixtureSnapshot,
  runs: {
    ...fixtureSnapshot.runs!,
    runs: [planningRun, executingRun, terminalRun],
  },
}

async function openRunInspector(run: ProjectRunView): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
  const table = screen.getByRole('table', { name: 'Project Run list' })
  fireEvent.click(within(table).getByRole('row', { name: new RegExp(run.goal.slice(0, 12)) }))
  return screen.getByRole('complementary', { name: /Run details/u })
}

describe('Dashboard Coordinator interactions (Phase 3, zh)', () => {
  it('shows the Coordinate action for a planning run', async () => {
    const onCoordinateRun = vi.fn(async () => undefined)
    renderDashboard({ snapshot: planningSnapshot, onCoordinateRun })

    const inspector = await openRunInspector(planningRun)
    expect(within(inspector).getByRole('button', { name: 'Coordinate' })).toBeTruthy()
  })

  it('hides the Coordinate action for executing and terminal runs', async () => {
    const onCoordinateRun = vi.fn(async () => undefined)
    renderDashboard({ snapshot: planningSnapshot, onCoordinateRun })

    const executingInspector = await openRunInspector(executingRun)
    expect(within(executingInspector).queryByRole('button', { name: 'Coordinate' })).toBeNull()
  })

  it('hides the Coordinate action for a terminal run', async () => {
    const onCoordinateRun = vi.fn(async () => undefined)
    renderDashboard({ snapshot: planningSnapshot, onCoordinateRun })

    const inspector = await openRunInspector(terminalRun)
    expect(within(inspector).queryByRole('button', { name: 'Coordinate' })).toBeNull()
  })

  it('calls onCoordinateRun and shows the pending state until it settles', async () => {
    let release: (() => void) | undefined
    const onCoordinateRun = vi.fn(
      () => new Promise<void>(resolve => { release = resolve }),
    )
    const onRefresh = vi.fn(async () => undefined)
    renderDashboard({ snapshot: planningSnapshot, onCoordinateRun, onRefresh })

    const inspector = await openRunInspector(planningRun)
    const button = within(inspector).getByRole('button', { name: 'Coordinate' }) as HTMLButtonElement
    fireEvent.click(button)
    await waitFor(() => expect(onCoordinateRun).toHaveBeenCalledWith(PLANNING_RUN_ID))

    const pending = within(inspector).getByRole('button', { name: 'Coordinating…' }) as HTMLButtonElement
    expect(pending.disabled).toBe(true)

    release?.()
    // The surface-level refresh prop is argumentless; the run id is consumed
    // by the inspector wrapper before it reaches the surface.
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    await waitFor(() => expect(within(inspector).getByRole('button', { name: 'Coordinate' })).toBeTruthy())
    expect(within(inspector).getByRole('status')).toBeTruthy()
  })

  it('shows an inline notice and re-enables the button when coordination fails', async () => {
    const onCoordinateRun = vi.fn(async () => {
      throw new Error('bad-request: coordinator.runPhaseInvalid: the run is not plannable')
    })
    renderDashboard({ snapshot: planningSnapshot, onCoordinateRun })

    const inspector = await openRunInspector(planningRun)
    const button = within(inspector).getByRole('button', { name: 'Coordinate' }) as HTMLButtonElement
    fireEvent.click(button)

    await waitFor(() => expect(onCoordinateRun).toHaveBeenCalledWith(PLANNING_RUN_ID))
    await waitFor(() => expect(within(inspector).getByRole('status')).toBeTruthy())
    expect((within(inspector).getByRole('button', { name: 'Coordinate' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders the Coordinator section with the completed summary and session tail', async () => {
    const onLoadRunDetail = vi.fn(async (runId: string): Promise<RunDetailView> => {
      if (runId !== PLANNING_RUN_ID) throw new Error('unexpected run')
      return {
        run: planningRun,
        truncated: false,
        events: [
          { id: 'ce2', type: 'run.coordinator.completed', title: 'Coordinator planning complete', detail: 'Adopted supervisor mode, with unified acceptance after two parallel tasks.', seq: 3, at: '2026-08-14T03:00:00.000Z' },
          { id: 'ce1', type: 'run.coordinator.started', title: 'Coordinator started', detail: 'dsh-coordinator-12345678-1234-4123-8123-123456789abc', seq: 2, at: '2026-08-14T02:58:00.000Z' },
          { id: 'e1', type: 'run.created', title: 'Run created', seq: 1, at: '2026-08-14T02:50:00.000Z' },
        ],
      }
    })
    renderDashboard({ snapshot: planningSnapshot, onLoadRunDetail })

    const inspector = await openRunInspector(planningRun)
    await waitFor(() => expect(within(inspector).getByText('complete')).toBeTruthy())
    expect(within(inspector).getByText('56789abc')).toBeTruthy()
    expect(within(inspector).getByText('Planning summary')).toBeTruthy()
    // The summary detail renders both in the timeline event and the section.
    expect(within(inspector).getAllByText('Adopted supervisor mode, with unified acceptance after two parallel tasks.').length).toBeGreaterThanOrEqual(1)
  })

  it('renders the Coordinator section as in progress while only the started event exists', async () => {
    const onLoadRunDetail = vi.fn(async (runId: string): Promise<RunDetailView> => {
      if (runId !== PLANNING_RUN_ID) throw new Error('unexpected run')
      return {
        run: planningRun,
        truncated: false,
        events: [
          { id: 'ce1', type: 'run.coordinator.started', title: 'Coordinator started', detail: 'dsh-coordinator-12345678-1234-4123-8123-123456789abc', seq: 2, at: '2026-08-14T02:58:00.000Z' },
          { id: 'e1', type: 'run.created', title: 'Run created', seq: 1, at: '2026-08-14T02:50:00.000Z' },
        ],
      }
    })
    renderDashboard({ snapshot: planningSnapshot, onLoadRunDetail })

    const inspector = await openRunInspector(planningRun)
    await waitFor(() => expect(within(inspector).getByText('in progress')).toBeTruthy())
    expect(within(inspector).queryByText('Planning summary')).toBeNull()
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
