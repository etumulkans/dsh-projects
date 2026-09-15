// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { DashboardI18nProvider, createDashboardTranslator } from '../src/client/i18n.tsx'
import { DashboardRequestError } from '../src/client/errors.ts'
import type {
  MemoryCreateInput,
  MemoryCreatePayload,
  MemoryEntryView,
  MemoryListInput,
  MemoryListPayload,
  MemorySetStatusInput,
  MemoryUpdateInput,
} from '../src/client/controller.ts'
import { fixtureSnapshot } from '../src/client/fixture.ts'

afterEach(cleanup)

const FIRST_PROJECT = '08b8e62d-5a7c-4a3a-a582-b63278347db0'
const RUN_ID = '9f1c2a50-4d3e-4b8a-9c21-7e5b0a6d1c22'

function entry(overrides: Partial<MemoryEntryView> = {}): MemoryEntryView {
  return {
    id: 'mem-1',
    projectId: FIRST_PROJECT,
    kind: 'architecture',
    title: 'Client and runtime isolation',
    body: 'The client directory must not import service implementations from src/memory or src/tasks.',
    tags: ['isolation', 'client'],
    status: 'active',
    createdAt: '2026-08-14T02:00:00.000Z',
    updatedAt: '2026-08-14T02:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

function emptyPayload(): MemoryListPayload {
  return {
    entries: [],
    counts: {
      architecture: 0, decision: 0, convention: 0, dependency: 0, environment: 0,
      testing: 0, deployment: 0, operations: 0, research: 0, finding: 0,
      'known-problem': 0, 'failure-pattern': 0, procedure: 0, 'repository-map': 0, 'user-preference': 0,
    },
  }
}

function renderMemoryDashboard(overrides: Partial<ComponentProps<typeof DashboardSurface>> = {}): void {
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
      onLoadMemory={async (input: MemoryListInput) => {
        void input
        return emptyPayload()
      }}
      onCreateMemory={async (input: MemoryCreateInput): Promise<MemoryCreatePayload> => {
        return { entry: entry({ id: 'mem-new', kind: input.kind, title: input.title, body: input.body, tags: input.tags ?? [] }) }
      }}
      onUpdateMemory={async (input: MemoryUpdateInput): Promise<MemoryEntryView> => {
        return entry({ id: input.id, version: 2, ...(input.pinned === undefined ? {} : { pinned: input.pinned }) })
      }}
      onSetMemoryStatus={async (input: MemorySetStatusInput): Promise<MemoryEntryView> => {
        return entry({ id: input.id, version: 2, status: input.status })
      }}
      {...overrides}
    />,
  )
}

describe('Dashboard Project Memory tab (spec §10)', () => {
  it('renders the memory tab between projects and configuration in zh and en', () => {
    renderMemoryDashboard()
    const tab = screen.getByRole('button', { name: 'Project Memory' })
    expect(tab).toBeTruthy()
    const tabs = Array.from(document.querySelectorAll('button')).map(button => button.textContent)
    expect(tabs.indexOf('Project Memory')).toBeGreaterThan(tabs.indexOf('Projects'))
    expect(tabs.indexOf('Project Memory')).toBeLessThan(tabs.indexOf('Configuration'))
  })

  it('renders the memory tab label in English under the en locale', () => {
    render(
      <DashboardI18nProvider t={createDashboardTranslator('en')}>
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
        />
      </DashboardI18nProvider>,
    )
    expect(screen.getByRole('button', { name: 'Project Memory' })).toBeTruthy()
  })

  it('fetches the first project on demand when the tab opens', async () => {
    const onLoadMemory = vi.fn(async (input: MemoryListInput) => {
      void input
      return emptyPayload()
    })
    renderMemoryDashboard({ onLoadMemory })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    await waitFor(() => expect(onLoadMemory).toHaveBeenCalledTimes(1))
    expect(onLoadMemory).toHaveBeenCalledWith({ projectId: FIRST_PROJECT })
    expect(await screen.findByText('This project has no project memory yet.')).toBeTruthy()
  })

  it('shows the no-projects state without dispatching when the catalog is empty', async () => {
    const snapshot = {
      ...fixtureSnapshot,
      catalog: { ...fixtureSnapshot.catalog, projects: [] },
    }
    const onLoadMemory = vi.fn(async (input: MemoryListInput) => {
      void input
      return emptyPayload()
    })
    renderMemoryDashboard({ snapshot, onLoadMemory })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    expect(await screen.findByText('No registered projects. Register a project in the Projects tab first.')).toBeTruthy()
    expect(onLoadMemory).not.toHaveBeenCalled()
  })

  it('renders the unavailable banner for the structured not-mounted failure', async () => {
    const onLoadMemory = vi.fn(async () => {
      throw new DashboardRequestError('bad-request: memoryList is unavailable: the Project Memory service is not mounted', {
        rpcCode: 'bad-request',
      })
    })
    renderMemoryDashboard({ onLoadMemory })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The Project Memory service is unavailable.')
  })

  it('renders entries with kind, tags, status, pin, supersession and the source-run link', async () => {
    const onLoadMemory = vi.fn(async (input: MemoryListInput) => {
      void input
      return {
        entries: [
          entry({
            pinned: true,
            supersedes: 'mem-0',
            sourceRunId: RUN_ID,
          }),
        ],
        counts: {
          ...emptyPayload().counts,
          architecture: 1,
        },
      }
    })
    renderMemoryDashboard({ onLoadMemory })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    const table = await screen.findByRole('table', { name: 'Project memory list' })
    expect(table.textContent).toContain('Architecture')
    expect(table.textContent).toContain('Client and runtime isolation')
    expect(table.textContent).toContain('isolation')
    expect(table.textContent).toContain('Active')
    expect(table.textContent).toContain('Supersedes mem-0')
    expect(screen.getByRole('button', { name: 'Architecture · 1' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Source run' }))
    await waitFor(() => expect(screen.getAllByText('Implement health check endpoint for the local task source and add unit tests').length).toBeGreaterThan(0))
  })

  it('pins an entry through memoryUpdate with the expected version', async () => {
    const onUpdateMemory = vi.fn(async (input: MemoryUpdateInput) => entry({ id: input.id, version: 2, ...(input.pinned === undefined ? {} : { pinned: input.pinned }) }))
    const onLoadMemory = vi.fn(async (input: MemoryListInput) => {
      void input
      return { entries: [entry({ pinned: false })], counts: { ...emptyPayload().counts, architecture: 1 } }
    })
    renderMemoryDashboard({ onLoadMemory, onUpdateMemory })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    await screen.findByRole('table', { name: 'Project memory list' })
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    await waitFor(() => expect(onUpdateMemory).toHaveBeenCalledWith({ id: 'mem-1', expectedVersion: 1, pinned: true }))
  })

  it('archives an active entry through memorySetStatus', async () => {
    const onSetMemoryStatus = vi.fn(async (input: MemorySetStatusInput) => entry({ id: input.id, version: 2, status: input.status }))
    const onLoadMemory = vi.fn(async (input: MemoryListInput) => {
      void input
      return { entries: [entry()], counts: { ...emptyPayload().counts, architecture: 1 } }
    })
    renderMemoryDashboard({ onLoadMemory, onSetMemoryStatus })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    await screen.findByRole('table', { name: 'Project memory list' })
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(onSetMemoryStatus).toHaveBeenCalledWith({ id: 'mem-1', expectedVersion: 1, status: 'archived' }))
  })

  it('marks an active entry obsolete (superseded) and hides actions for superseded entries', async () => {
    const onSetMemoryStatus = vi.fn(async (input: MemorySetStatusInput) => entry({ id: input.id, version: 2, status: input.status }))
    const onLoadMemory = vi.fn(async (input: MemoryListInput) => {
      void input
      return {
        entries: [
          entry(),
          entry({ id: 'mem-2', status: 'superseded', title: 'Old convention' }),
        ],
        counts: { ...emptyPayload().counts, architecture: 2 },
      }
    })
    renderMemoryDashboard({ onLoadMemory, onSetMemoryStatus })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    await screen.findByRole('table', { name: 'Project memory list' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark obsolete' }))
    await waitFor(() => expect(onSetMemoryStatus).toHaveBeenCalledWith({ id: 'mem-1', expectedVersion: 1, status: 'superseded' }))

    const supersededRow = screen.getByText('Old convention').closest('.dshd-memory-entry')
    expect(supersededRow).toBeTruthy()
    expect(supersededRow!.textContent).toContain('Superseded')
    expect(supersededRow!.querySelector('button')).toBeNull()
  })

  it('creates a note through memoryCreate with parsed tags and shows the supersession notice', async () => {
    const onCreateMemory = vi.fn(async (input: MemoryCreateInput): Promise<MemoryCreatePayload> => ({
      entry: entry({ id: 'mem-new', kind: input.kind, title: input.title, body: input.body, tags: input.tags ?? [] }),
      supersededId: 'mem-1',
    }))
    renderMemoryDashboard({ onCreateMemory })

    fireEvent.click(screen.getByRole('button', { name: 'Project Memory' }))
    await screen.findByText('This project has no project memory yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }))

    const dialog = await screen.findByRole('dialog', { name: 'Add memory' })
    fireEvent.change(within(dialog).getByLabelText('Memory kind'), { target: { value: 'convention' } })
    fireEvent.change(within(dialog).getByLabelText('Memory title'), { target: { value: 'Use Chinese in commit messages' } })
    fireEvent.change(within(dialog).getByLabelText('Memory body'), { target: { value: 'Describe commits in Chinese.' } })
    fireEvent.change(within(dialog).getByLabelText('Tags (comma separated)'), { target: { value: 'git, commit' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add memory' }))

    await waitFor(() => expect(onCreateMemory).toHaveBeenCalledWith({
      projectId: FIRST_PROJECT,
      kind: 'convention',
      title: 'Use Chinese in commit messages',
      body: 'Describe commits in Chinese.',
      tags: ['git', 'commit'],
    }))
    expect(await screen.findByText('Superseded existing memory: mem-1')).toBeTruthy()
  })
})
