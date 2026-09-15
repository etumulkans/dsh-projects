// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAttentionSummary } from '../src/client/attention.ts'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { DashboardDataController } from '../src/client/controller.ts'
import { fixtureSnapshot, globalFixtureSnapshot } from '../src/client/fixture.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('Dashboard P0 operator UX', () => {
  it('shows the active project configuration failure once without leaking failures from other projects', () => {
    const now = Date.parse('2026-08-14T02:30:05.000Z')
    const snapshot = {
      ...fixtureSnapshot,
      configuration: {
        ...fixtureSnapshot.configuration,
        workflowError: 'Tracker credential is missing',
      },
      catalog: {
        ...fixtureSnapshot.catalog,
        projects: fixtureSnapshot.catalog.projects.map((project, index) => ({
          ...project,
          configurationState: 'invalid' as const,
          configurationError: index === 0 ? 'Tracker credential is missing' : 'Unrelated project failure',
        })),
      },
    }

    const summary = buildAttentionSummary(snapshot, now)

    expect([...summary.issueKeys]).toEqual(['linear:ENG:issue-236', 'linear:ENG:issue-241'])
    expect(summary.alerts).toEqual([
      expect.objectContaining({ id: `configuration:${fixtureSnapshot.catalog.projects[0]!.id}`, kind: 'configuration', projectName: 'dsh-dashboard', detail: 'Tracker credential is missing' }),
    ])
    expect(summary.count).toBe(3)
  })

  it('aggregates every invalid project configuration in the global view', () => {
    const snapshot = {
      ...globalFixtureSnapshot,
      catalog: {
        ...globalFixtureSnapshot.catalog,
        projects: globalFixtureSnapshot.catalog.projects.map((project, index) => ({
          ...project,
          configurationState: 'invalid' as const,
          configurationError: `Project failure ${index + 1}`,
        })),
      },
    }

    const summary = buildAttentionSummary(snapshot, Date.parse(globalFixtureSnapshot.generatedAt))

    expect(summary.alerts.map(alert => alert.detail)).toEqual(['Project failure 1', 'Project failure 2'])
  })

  it('filters the board to tasks that need attention and explains the blocked reason', () => {
    renderDashboard({ snapshot: { ...fixtureSnapshot, runtime: { ...fixtureSnapshot.runtime, lastRefreshAt: new Date().toISOString() } } })

    fireEvent.click(screen.getByRole('button', { name: 'Show only issues that need attention' }))

    expect(screen.getByText('ENG-236')).toBeTruthy()
    expect(screen.getByText('ENG-241')).toBeTruthy()
    expect(screen.getByText('Blocked by ENG-212 (In Progress)')).toBeTruthy()
    expect(screen.queryByText('ENG-238')).toBeNull()
    expect(screen.getByRole('button', { name: 'Clear needs-attention filter' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('provides a persistent Display panel with real layout, density, group, and card settings', () => {
    const first = renderDashboard()
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))
    const display = screen.getByRole('dialog', { name: 'View settings' })

    expect(within(display).getByLabelText('Agent status on cards')).toBeTruthy()
    fireEvent.click(within(display).getByRole('button', { name: 'List' }))
    fireEvent.click(within(display).getByLabelText('Task source'))
    fireEvent.click(within(display).getByLabelText('Show empty groups'))

    expect(document.querySelector('.dshd-board-list')).toBeTruthy()
    expect(document.querySelector('.dshd-board-list-origin')).toBeNull()
    expect(document.querySelectorAll('.dshd-board-list-group')).toHaveLength(8)

    first.unmount()
    renderDashboard()

    expect(document.querySelector('.dshd-board-list')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Display' }).hasAttribute('data-active')).toBe(true)
  })

  it('removes misleading menu affordances until real menus exist', () => {
    renderDashboard()

    expect(screen.queryByRole('button', { name: 'Agent capacity' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Agent capacity' })).toBeTruthy()
    expect(document.querySelector('.dshd-card-more')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    expect(document.querySelector('.dshd-project-more')).toBeNull()
  })

  it('keeps mutation progress local to its control and announces success', async () => {
    let resolvePause: (() => void) | undefined
    const onPause = vi.fn(() => new Promise<void>((resolve) => { resolvePause = resolve }))
    renderDashboard({ onPause })
    const pause = screen.getByRole('button', { name: 'Pause' })

    fireEvent.click(pause)

    expect(pause.getAttribute('aria-busy')).toBe('true')
    expect((pause as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy()
    resolvePause?.()

    expect((await screen.findByRole('status')).textContent).toContain('Task scheduling paused')
    await waitFor(() => expect((pause as HTMLButtonElement).disabled).toBe(false))
  })

  it('disables only the discovery root being removed until the request settles', async () => {
    let resolveRemoval: (() => void) | undefined
    const onRemoveDiscoveryRoot = vi.fn(() => new Promise<void>((resolve) => { resolveRemoval = resolve }))
    renderDashboard({ onRemoveDiscoveryRoot })
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    const root = fixtureSnapshot.catalog.discoveryRoots[0]!
    const remove = screen.getByRole('button', { name: `Remove ${root.path}` })

    fireEvent.click(remove)

    expect(remove.getAttribute('aria-busy')).toBe('true')
    expect((remove as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(remove)
    expect(onRemoveDiscoveryRoot).toHaveBeenCalledOnce()

    resolveRemoval?.()
    await waitFor(() => expect((remove as HTMLButtonElement).disabled).toBe(false))
  })

  it('prevents duplicate project switches from the global issue inspector', async () => {
    let resolveSwitch: (() => void) | undefined
    const onSwitchProject = vi.fn(() => new Promise<void>((resolve) => { resolveSwitch = resolve }))
    renderDashboard({ snapshot: globalFixtureSnapshot, onSwitchProject })
    fireEvent.click(screen.getByText('LOCAL-18'))
    const enterProject = screen.getByRole('button', { name: 'Enter project' })

    fireEvent.click(enterProject)

    expect(enterProject.getAttribute('aria-busy')).toBe('true')
    expect((enterProject as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(enterProject)
    expect(onSwitchProject).toHaveBeenCalledOnce()

    resolveSwitch?.()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Enter project' })).toBeNull())
  })

  it('announces an action failure without replacing the current snapshot', async () => {
    renderDashboard({ onRefresh: async () => { throw new Error('Provider temporarily unavailable') } })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Dashboard' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Provider temporarily unavailable')
    expect(screen.getByText('ENG-238')).toBeTruthy()
  })

  it('does not promote a caller-owned mutation to global Dashboard loading', async () => {
    let resolvePause: ((value: unknown) => void) | undefined
    const rpc = {
      call: vi.fn(async (_namespace: string, endpoint: string) => {
        if (endpoint === 'pause') return await new Promise(resolve => { resolvePause = resolve })
        return { ok: true, value: fixtureSnapshot }
      }),
    }
    const controller = new DashboardDataController(rpc as never)
    await controller.refresh()

    const pause = controller.setPaused(true)

    expect(controller.getSnapshot().loading).toBe(false)
    resolvePause?.({ ok: true, value: fixtureSnapshot })
    await pause
    expect(controller.getSnapshot().loading).toBe(false)
  })
})

function renderDashboard(overrides: Partial<ComponentProps<typeof DashboardSurface>> = {}) {
  return render(
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
