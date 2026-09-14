// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot, globalFixtureSnapshot } from '../src/client/fixture.ts'
import type { RunDetailView } from '../src/runs/types.ts'

afterEach(cleanup)

const executingRun = fixtureSnapshot.runs!.runs[0]!
const pausedRun = fixtureSnapshot.runs!.runs[1]!

function runDetailFixture(runId: string): RunDetailView {
  const run = (fixtureSnapshot.runs!.runs ?? []).find(candidate => candidate.id === runId) ?? executingRun
  return {
    run,
    events: [
      {
        id: 'event-3',
        type: 'run.phase.changed',
        title: 'Run created → planning',
        detail: 'created → planning',
        seq: 2,
        at: '2026-08-14T02:11:00.000Z',
      },
      {
        id: 'event-1',
        type: 'run.created',
        title: 'Run created',
        detail: run.goal,
        seq: 1,
        at: run.createdAt,
      },
    ],
    truncated: false,
  }
}

describe('Dashboard Project Run interactions', () => {
  it('lists runs, opens the inspector, and loads the persisted event stream', async () => {
    const onLoadRunDetail = vi.fn(async (runId: string) => runDetailFixture(runId))
    renderDashboard({ onLoadRunDetail })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))

    const table = screen.getByRole('table', { name: 'Project Run list' })
    expect(table.textContent).toContain('Implement health check endpoint for the local task source and add unit tests')
    expect(table.textContent).toContain('Executing')
    expect(table.textContent).toContain('Succeeded')

    fireEvent.click(within(table).getByRole('row', { name: /Implement health check endpoint for the local task source and add unit tests/u }))

    const inspector = screen.getByRole('complementary', { name: /Run details/u })
    expect(inspector.textContent).toContain('Executing')
    expect(inspector.textContent).toContain('Manual')

    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))
    expect(await within(inspector).findByText('Run created → planning')).toBeTruthy()
    expect(within(inspector).getByText('Run created')).toBeTruthy()
    expect(within(inspector).queryByText('No events yet.')).toBeNull()
  })

  it('pauses a running Run with the current version guard', async () => {
    const onRunTransition = vi.fn(async () => {})
    renderDashboard({ onRunTransition, onLoadRunDetail: async runId => runDetailFixture(runId) })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    const table = screen.getByRole('table', { name: 'Project Run list' })
    fireEvent.click(within(table).getByRole('row', { name: /Implement health check endpoint for the local task source and add unit tests/u }))

    const inspector = screen.getByRole('complementary', { name: /Run details/u })
    fireEvent.click(within(inspector).getByRole('button', { name: 'Pause' }))

    await waitFor(() => expect(onRunTransition).toHaveBeenCalledWith({
      runId: executingRun.id,
      to: 'paused',
      expectedVersion: executingRun.version,
    }))
  })

  it('resumes a paused Run back to its suspended phase', async () => {
    const onRunTransition = vi.fn(async () => {})
    renderDashboard({ onRunTransition, onLoadRunDetail: async runId => runDetailFixture(runId) })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    const table = screen.getByRole('table', { name: 'Project Run list' })
    fireEvent.click(within(table).getByRole('row', { name: /Research Agent Teams experimental capabilities and produce an adapter layer plan/u }))

    const inspector = screen.getByRole('complementary', { name: /Run details/u })
    expect(within(inspector).getByText('Paused')).toBeTruthy()
    fireEvent.click(within(inspector).getByRole('button', { name: 'Resume' }))

    await waitFor(() => expect(onRunTransition).toHaveBeenCalledWith({
      runId: pausedRun.id,
      to: pausedRun.suspendedFrom,
      expectedVersion: pausedRun.version,
    }))
  })

  it('hides lifecycle actions for a terminal Run', async () => {
    const terminalRun = fixtureSnapshot.runs!.runs[2]!
    const onRunTransition = vi.fn(async () => {})
    renderDashboard({ onRunTransition, onLoadRunDetail: async runId => runDetailFixture(runId) })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    const table = screen.getByRole('table', { name: 'Project Run list' })
    fireEvent.click(within(table).getByRole('row', { name: /Fix global board cross-project state normalization/u }))

    const inspector = screen.getByRole('complementary', { name: /Run details/u })
    expect(within(inspector).getByText('Succeeded')).toBeTruthy()
    expect(within(inspector).queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(within(inspector).queryByRole('button', { name: 'Cancel Run' })).toBeNull()
    expect(within(inspector).getByText('Fixed and added regression tests.')).toBeTruthy()
    expect(onRunTransition).not.toHaveBeenCalled()
    expect(terminalRun.phase).toBe('succeeded')
  })

  it('creates a Run from the dialog and trims the goal', async () => {
    const onCreateRun = vi.fn(async () => {})
    renderDashboard({ onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Run' }))

    const dialog = screen.getByRole('dialog', { name: 'New Project Run' })
    fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: '  Implement run detail view  ' } })
    fireEvent.change(within(dialog).getByLabelText('Source reference (optional)'), { target: { value: 'JIRA-12' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Run' }))

    await waitFor(() => expect(onCreateRun).toHaveBeenCalledWith({ goal: 'Implement run detail view', sourceRef: 'JIRA-12' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Project Run' })).toBeNull())
  })

  it('keeps the dialog open when creation fails', async () => {
    const onCreateRun = vi.fn(async () => {
      throw new Error('run.goalEmpty')
    })
    renderDashboard({ onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Run' }))
    const dialog = screen.getByRole('dialog', { name: 'New Project Run' })
    fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'will fail' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Run' }))

    await waitFor(() => expect(onCreateRun).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog', { name: 'New Project Run' })).toBeTruthy()
  })

  it('renders the empty state when the snapshot has no runs section', async () => {
    const { runs: _runs, ...withoutRuns } = fixtureSnapshot
    renderDashboard({ snapshot: withoutRuns, onCreateRun: async () => {} })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    expect(screen.getByText('No project Runs yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New Run' })).toBeTruthy()
  })

  it('shows project names and hides manual creation in the global view', async () => {
    const globalRun = { ...executingRun, projectName: 'dsh-dashboard' }
    const snapshot = {
      ...globalFixtureSnapshot,
      runs: { total: 1, runs: [globalRun] },
    }
    renderDashboard({ snapshot })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    const table = screen.getByRole('table', { name: 'Project Run list' })
    expect(table.textContent).toContain('dsh-dashboard')
    expect(screen.queryByRole('button', { name: 'New Run' })).toBeNull()
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
