// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'

const callbacks = {
  onRefresh: async () => {},
  onPause: async () => {},
  onStop: async () => {},
  onCreateTask: async () => {},
  onUpdateTask: async () => {},
  onDeleteTask: async () => {},
  onSwitchProject: async () => {},
  onAddDiscoveryRoot: async () => {},
  onRemoveDiscoveryRoot: async () => {},
  onScanProjects: async () => ({ root: fixtureSnapshot.catalog.discoveryRoots[0]!, candidates: [], truncated: false }),
  onRegisterProjectCandidate: async () => {},
  onRegisterProject: async () => {},
  onOpenSession: () => {},
}

afterEach(cleanup)

describe('task detail inspector', () => {
  it('loads the timeline lazily and filters the returned event categories', async () => {
    const onLoadTimeline = vi.fn(async () => ({
      coverage: 'runtime-session' as const,
      truncated: false,
      events: [
        { id: 'agent', type: 'assistant/message', category: 'agent' as const, title: 'Assistant message', at: '2026-08-14T10:04:00.000Z' },
        { id: 'task', type: 'task.updated', category: 'task' as const, title: 'Task updated', at: '2026-08-14T10:00:00.000Z' },
      ],
    }))
    render(<DashboardSurface {...callbacks} snapshot={fixtureSnapshot} initialSelectedKey="linear:ENG:issue-238" onLoadTimeline={onLoadTimeline} />)

    expect(onLoadTimeline).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
    await waitFor(() => expect(onLoadTimeline).toHaveBeenCalledWith('linear:ENG:issue-238', undefined))
    expect(screen.getByText('Current run')).toBeTruthy()
    expect(screen.getByText('Agent update')).toBeTruthy()
    expect(screen.getByText('Task updated')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    expect(screen.getByText('Agent update')).toBeTruthy()
    expect(screen.queryByText('Task updated')).toBeNull()
  })

  it('keeps the contextual primary action and puts destructive actions in a real menu', () => {
    render(<DashboardSurface {...callbacks} snapshot={fixtureSnapshot} initialSelectedKey="linear:ENG:issue-238" />)

    expect(screen.getAllByRole('button', { name: 'Open session' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Stop agent' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Stop agent' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Copy issue identifier' })).toBeTruthy()
  })
})
