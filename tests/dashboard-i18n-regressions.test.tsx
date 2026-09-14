// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { DashboardDataController } from '../src/client/controller.ts'
import { dashboardErrorMessage } from '../src/client/errors.ts'
import { fixtureSnapshot, globalFixtureSnapshot } from '../src/client/fixture.ts'
import { DashboardI18nProvider, createDashboardTranslator } from '../src/client/i18n.tsx'
import { DashboardDomainError, encodeDashboardError } from '../src/runtime/errors.ts'

afterEach(cleanup)

describe('Dashboard i18n regressions', () => {
  it('opens a searchable project context menu with current and background activity state', () => {
    renderDashboard()

    fireEvent.click(screen.getByRole('button', { name: 'Current task source' }))
    const switcher = screen.getByRole('dialog', { name: 'Project context switcher' })

    expect(within(switcher).getByText("The target project's WORKFLOW.md determines its Tracker.")).toBeTruthy()
    expect(within(switcher).getByRole('option', { name: /dsh-dashboard.*Current/u }).getAttribute('aria-selected')).toBe('true')
    expect(within(switcher).getByRole('option', { name: /dsh-dashboard-test/u }).textContent).toContain('1 Agents running')

    fireEvent.change(within(switcher).getByLabelText('Search switchable projects'), { target: { value: 'Global task demo' } })
    expect(within(switcher).queryByRole('option', { name: /dsh-dashboard.*Current/u })).toBeNull()
    expect(within(switcher).getByRole('option', { name: /dsh-dashboard-test/u })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Project context switcher' })).toBeNull()
  })

  it('switches to a validated project and closes the context menu only after success', async () => {
    const onSwitchProject = vi.fn(async () => {})
    renderDashboard({ onSwitchProject })

    fireEvent.click(screen.getByRole('button', { name: 'Current task source' }))
    fireEvent.click(screen.getByRole('option', { name: /dsh-dashboard-test/u }))

    await waitFor(() => expect(onSwitchProject).toHaveBeenCalledWith('4bceae56-7cc1-4419-a912-a6ea110448fb'))
    expect(screen.queryByRole('dialog', { name: 'Project context switcher' })).toBeNull()
  })

  it('switches to the global composite view from the project context menu', async () => {
    const onSwitchGlobal = vi.fn(async () => {})
    renderDashboard({ onSwitchGlobal })

    fireEvent.click(screen.getByRole('button', { name: 'Current task source' }))
    fireEvent.click(screen.getByRole('option', { name: /All projects/u }))

    await waitFor(() => expect(onSwitchGlobal).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog', { name: 'Project context switcher' })).toBeNull()
  })

  it('filters the global board by Provider and enters a task owning project', async () => {
    const onSwitchProject = vi.fn(async () => {})
    renderDashboard({ snapshot: globalFixtureSnapshot, onSwitchProject })

    expect(screen.getByRole('button', { name: 'Current task source' }).textContent).toContain('Global·All projects')
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    const sourceFilter = screen.getByLabelText('Filter global task sources')
    fireEvent.change(sourceFilter, { target: { value: 'provider:local' } })

    expect(screen.getByText('LOCAL-18')).toBeTruthy()
    expect(screen.queryByText('ENG-238')).toBeNull()
    fireEvent.click(screen.getByText('LOCAL-18'))
    const inspector = document.querySelector<HTMLElement>('.dshd-inspector')!
    expect(within(inspector).getByText('Task source')).toBeTruthy()
    expect(within(inspector).getByText('dsh-dashboard-test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enter project' }))

    await waitFor(() => expect(onSwitchProject).toHaveBeenCalledWith('4bceae56-7cc1-4419-a912-a6ea110448fb'))
  })

  it('keeps the context menu open when Host validation rejects a project switch', async () => {
    const onSwitchProject = vi.fn(async () => { throw new Error('Invalid WORKFLOW.md') })
    renderDashboard({ onSwitchProject })

    fireEvent.click(screen.getByRole('button', { name: 'Current task source' }))
    fireEvent.click(screen.getByRole('option', { name: /dsh-dashboard-test/u }))

    await waitFor(() => expect(onSwitchProject).toHaveBeenCalledOnce())
    expect(screen.getByRole('dialog', { name: 'Project context switcher' })).toBeTruthy()
  })

  it('omits inactive column overflow placeholders while keeping Local create controls', () => {
    renderDashboard({
      snapshot: {
        ...fixtureSnapshot,
        context: { kind: 'local', providerLabel: 'Local', projectLabel: 'Personal', projectRef: 'personal' },
        taskMutations: { canCreate: true, canUpdate: true, canDelete: true, states: ['Backlog', 'Todo', 'In Progress', 'Done'] },
        configuration: { ...fixtureSnapshot.configuration, trackerKind: 'local', projectRef: 'personal', credentials: [] },
      },
    })

    expect(document.querySelector('.dshd-column-more')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Add task to .+$/u })).toHaveLength(4)
  })

  it('collapses and expands the hidden-column summary while preserving its contents', () => {
    renderDashboard()

    const hiddenColumns = document.querySelector<HTMLElement>('.dshd-hidden-columns')
    const collapseButton = screen.getByRole('button', { name: 'Collapse hidden columns' })
    const listId = collapseButton.getAttribute('aria-controls')
    const hiddenColumnList = listId === null ? null : document.getElementById(listId)

    expect(hiddenColumns?.hasAttribute('data-collapsed')).toBe(false)
    expect(collapseButton.getAttribute('aria-expanded')).toBe('true')
    expect(hiddenColumnList?.hidden).toBe(false)

    fireEvent.click(collapseButton)

    const expandButton = screen.getByRole('button', { name: 'Expand hidden columns' })
    expect(hiddenColumns?.hasAttribute('data-collapsed')).toBe(true)
    expect(expandButton.getAttribute('aria-expanded')).toBe('false')
    expect(hiddenColumnList?.hidden).toBe(true)

    fireEvent.click(expandButton)

    expect(screen.getByRole('button', { name: 'Collapse hidden columns' }).getAttribute('aria-expanded')).toBe('true')
    expect(hiddenColumns?.hasAttribute('data-collapsed')).toBe(false)
    expect(hiddenColumnList?.hidden).toBe(false)
  })

  it('filters board issues by runtime phase and composes with the text filter', () => {
    renderDashboard()

    const runtimeFilters = screen.getByRole('toolbar', { name: 'Issue runtime filters' })
    const runningFilter = within(runtimeFilters).getByRole('button', { name: 'Show only Running issues' })
    fireEvent.click(runningFilter)

    expect(runningFilter.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('ENG-238')).toBeTruthy()
    expect(screen.queryByText('ENG-236')).toBeNull()
    expect(screen.queryByText('ENG-241')).toBeNull()
    expect(screen.queryByText('ENG-240')).toBeNull()

    fireEvent.click(within(runtimeFilters).getByRole('button', { name: 'Show only Retrying issues' }))
    expect(screen.getByText('ENG-236')).toBeTruthy()
    expect(screen.queryByText('ENG-238')).toBeNull()

    fireEvent.click(within(runtimeFilters).getByRole('button', { name: 'Clear Retrying filter' }))
    expect(screen.getByText('ENG-240')).toBeTruthy()

    fireEvent.click(within(runtimeFilters).getByRole('button', { name: 'Show only Blocked issues' }))
    expect(screen.getByText('ENG-241')).toBeTruthy()
    expect(screen.queryByText('ENG-240')).toBeNull()
    fireEvent.click(within(runtimeFilters).getByRole('button', { name: 'Clear Blocked filter' }))

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    fireEvent.change(screen.getByLabelText('Filter issues'), { target: { value: 'ENG-233' } })
    fireEvent.click(within(runtimeFilters).getByRole('button', { name: 'Show only Running issues' }))

    expect(screen.getByText('ENG-233')).toBeTruthy()
    expect(screen.queryByText('ENG-238')).toBeNull()
  })

  it('keeps the approved Linear header fallback without inventing a configuration Provider', () => {
    renderDashboard({ snapshot: undefined })

    expect(screen.getByText('Linear')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    const providerRow = screen.getByText('Provider').parentElement
    expect(providerRow?.textContent).toBe('Provider—')
  })

  it('presents configuration as a contextual, semantic last-good inspector', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderDashboard()

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Display' })).toBeNull()
    expect(screen.queryByRole('toolbar', { name: 'Issue runtime filters' })).toBeNull()
    expect(screen.getByText('Using the last valid configuration')).toBeTruthy()
    expect(screen.getByText(/Last loaded successfully at/u)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Workflow and effective scope' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Task source (Tracker)' })).toBeTruthy()
    expect(document.querySelectorAll('.dshd-config-section dl')).toHaveLength(3)
    expect(screen.getByRole('list', { name: 'Active states' }).children).toHaveLength(fixtureSnapshot.configuration.activeStates.length)

    fireEvent.click(screen.getByRole('button', { name: 'Copy WORKFLOW.md path' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(fixtureSnapshot.configuration.workflowPath))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('keeps the active Dashboard tab visible after the viewport changes', () => {
    renderDashboard()
    const configurationTab = screen.getByRole('button', { name: 'Configuration' })
    fireEvent.click(configurationTab)
    const tabs = configurationTab.parentElement
    expect(tabs).toBeTruthy()
    Object.defineProperties(configurationTab, {
      offsetLeft: { configurable: true, value: 360 },
      offsetWidth: { configurable: true, value: 55 },
    })
    Object.defineProperty(tabs, 'clientWidth', { configurable: true, value: 320 })

    fireEvent.resize(window)

    expect(tabs?.scrollLeft).toBe(111)
  })

  it('surfaces a rejected workflow reload as a last-good warning', () => {
    renderDashboard({
      snapshot: {
        ...fixtureSnapshot,
        configuration: {
          ...fixtureSnapshot.configuration,
          workflowError: 'tracker.provider.project_id: expected a non-empty string',
        },
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Using the last valid configuration')
    expect(status.textContent).toContain('tracker.provider.project_id: expected a non-empty string')
    expect(screen.getByText('Reload failed')).toBeTruthy()
  })

  it('renders English singular counts for one discovery root and one candidate', async () => {
    const candidate = {
      token: 'only-candidate',
      name: 'one-project',
      path: 'F:\\Dev\\Code\\one-project',
    }
    renderDashboard({
      onScanProjects: async () => ({
        root: fixtureSnapshot.catalog.discoveryRoots[0]!,
        candidates: [candidate],
        truncated: false,
      }),
    }, 'en')

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    expect(screen.getByText('1 discovery root')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Scan roots' }))

    const dialog = await screen.findByRole('dialog', { name: 'Scan discovery roots' })
    expect(within(dialog).getByText('1 new candidate')).toBeTruthy()
  })

  it('translates known credential sources and preserves unknown source ids', () => {
    const snapshot = {
      ...fixtureSnapshot,
      configuration: {
        ...fixtureSnapshot.configuration,
        credentials: [
          ...fixtureSnapshot.configuration.credentials,
          { ref: 'custom/key', label: 'Custom key', configured: true, source: 'vault-plugin', writable: false },
        ],
      },
    }
    renderDashboard({ snapshot })
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    expect(screen.getByText(/configured \(credential store\)/u)).toBeTruthy()
    expect(screen.getByText(/configured \(vault-plugin\)/u)).toBeTruthy()
    expect(screen.queryByText(/credential-store/u)).toBeNull()
  })

  it('localizes a structured Host error in the catalog dialog', async () => {
    const message = encodeDashboardError(new DashboardDomainError(
      'catalog.pathAbsolute',
      'path must be absolute (or start with `~`)',
    ))!
    const rpc = {
      call: vi.fn(async () => ({
        ok: false,
        error: { code: 'bad-request', message, details: { issues: [] } },
      })),
    }
    const data = new DashboardDataController(rpc as never)
    renderDashboard({ onAddDiscoveryRoot: input => data.addDiscoveryRoot(input) })

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage roots' }))
    fireEvent.change(screen.getByLabelText('Absolute directory path'), { target: { value: 'relative-project' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add root' }))

    expect((await screen.findByRole('alert')).textContent).toBe('The path must be absolute or start with ~.')
    expect(rpc.call).toHaveBeenCalledWith('/dsh-dashboard', 'addDiscoveryRoot', {
      path: 'relative-project', maxDepth: 4,
    })
  })

  it('keeps unknown Provider errors verbatim', () => {
    expect(dashboardErrorMessage(
      new Error('GitHub API rate limit exceeded'),
      createDashboardTranslator('en'),
    )).toBe('GitHub API rate limit exceeded')
  })
})

function renderDashboard(
  overrides: Partial<ComponentProps<typeof DashboardSurface>> = {},
  locale: 'en' = 'en',
): void {
  render(withLocale(
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
    locale,
  ))
}

function withLocale(children: ReactNode, locale: 'en'): ReactNode {
  return <DashboardI18nProvider t={createDashboardTranslator(locale)}>{children}</DashboardI18nProvider>
}
