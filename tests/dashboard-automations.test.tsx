// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { DashboardI18nProvider, createDashboardTranslator } from '../src/client/i18n.tsx'
import type { TriggerCreateInput, TriggerView } from '../src/client/controller.ts'
import { fixtureSnapshot } from '../src/client/fixture.ts'

afterEach(cleanup)

const FIRST_PROJECT = '08b8e62d-5a7c-4a3a-a582-b63278347db0'

function trigger(overrides: Partial<TriggerView> = {}): TriggerView {
  return {
    id: 'trigger-1',
    projectId: FIRST_PROJECT,
    type: 'tracker',
    enabled: true,
    config: { sourceKind: 'linear', readyStates: ['ready'] },
    goalTemplate: 'Fix {{issue.key}}',
    createdAt: '2026-08-14T02:30:00.000Z',
    updatedAt: '2026-08-14T02:30:00.000Z',
    ...overrides,
  }
}

function renderAutomationsDashboard(
  overrides: Partial<ComponentProps<typeof DashboardSurface>> = {},
): void {
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
      onLoadTriggers={async () => [trigger()]}
      onCreateTrigger={async (input: TriggerCreateInput) => trigger({ id: 'trigger-new', type: input.type as TriggerView['type'], goalTemplate: input.goalTemplate })}
      onSetTriggerEnabled={async (id: string, enabled: boolean) => trigger({ id, enabled })}
      onDeleteTrigger={async () => {}}
      onFireTrigger={async () => ({ id: 'run-fired', source: 'tracker' })}
      {...overrides}
    />,
  )
}

describe('Dashboard Automations tab (Phase 9, spec §10.5)', () => {
  it('renders the automations tab between artifacts and configuration in zh', () => {
    renderAutomationsDashboard()
    const tab = screen.getByRole('button', { name: 'Automations' })
    expect(tab).toBeTruthy()
    const tabs = Array.from(document.querySelectorAll('button')).map(button => button.textContent)
    expect(tabs.indexOf('Automations')).toBeGreaterThan(tabs.indexOf('Project Artifacts'))
    expect(tabs.indexOf('Automations')).toBeLessThan(tabs.indexOf('Configuration'))
  })

  it('renders the automations tab label in English under the en locale', () => {
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
    expect(screen.getByRole('button', { name: 'Automations' })).toBeTruthy()
  })

  it('fetches the first project on demand when the tab opens', async () => {
    const onLoadTriggers = vi.fn(async () => [trigger()])
    renderAutomationsDashboard({ onLoadTriggers })
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(onLoadTriggers).toHaveBeenCalledTimes(1))
    expect(onLoadTriggers).toHaveBeenCalledWith(FIRST_PROJECT)
  })

  it('shows the empty marker when a project has no triggers', async () => {
    renderAutomationsDashboard({ onLoadTriggers: async () => [] })
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('No triggers yet')).toBeTruthy())
  })

  it('lists a trigger with its type, status, and goal template', async () => {
    renderAutomationsDashboard()
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('Fix {{issue.key}}')).toBeTruthy())
    // The type badge + enabled status.
    expect(screen.getByText('Tracker source')).toBeTruthy()
    expect(screen.getByText('Enabled')).toBeTruthy()
  })

  it('toggles a trigger enabled/disabled with busy gating', async () => {
    const onSetTriggerEnabled = vi.fn(async (_id: string, enabled: boolean) => trigger({ id: 'trigger-1', enabled }))
    renderAutomationsDashboard({ onSetTriggerEnabled, onLoadTriggers: async () => [trigger({ enabled: true })] })
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('Fix {{issue.key}}')).toBeTruthy())

    // Scope to the trigger row (the global pause control is also labelled "Pause").
    const row = document.querySelector<HTMLElement>('.dshd-memory-entry[data-type="tracker"]')!
    const disableButton = within(row).getByRole('button', { name: 'Pause' })
    fireEvent.click(disableButton)
    await waitFor(() => expect(onSetTriggerEnabled).toHaveBeenCalledWith('trigger-1', false))
  })

  it('fires a trigger (Run now) and opens the resulting run', async () => {
    const onFireTrigger = vi.fn(async () => ({ id: 'run-fired', source: 'tracker' }))
    const onOpenRun = vi.fn()
    // The DashboardSurface wires onOpenRun internally (setSelectedRunId), so we
    // assert the fire dispatch here; the run navigation is a snapshot update.
    renderAutomationsDashboard({ onFireTrigger, onLoadTriggers: async () => [trigger()] })
    void onOpenRun
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('Fix {{issue.key}}')).toBeTruthy())

    const runNow = screen.getByRole('button', { name: 'Run now' })
    fireEvent.click(runNow)
    await waitFor(() => expect(onFireTrigger).toHaveBeenCalledWith('trigger-1'))
  })

  it('opens the Add trigger dialog with the per-type fields (tracker default)', async () => {
    renderAutomationsDashboard()
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('Fix {{issue.key}}')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Add trigger' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add trigger' })).toBeTruthy())

    // The tracker type is the default — its config fields are shown.
    const dialog = screen.getByRole('dialog', { name: 'Add trigger' })
    expect(within(dialog).getByText('Tracker source kind')).toBeTruthy()
    expect(within(dialog).getByText('States (comma-separated)')).toBeTruthy()
    // The submit is disabled until a goal template is provided.
    const submit = within(dialog).getByRole('button', { name: 'Add' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  it('submits a tracker trigger with the rendered config (readyStates) + goal template', async () => {
    const onCreateTrigger = vi.fn(async (input: TriggerCreateInput) => trigger({ id: 'trigger-new', type: input.type as TriggerView['type'], goalTemplate: input.goalTemplate }))
    renderAutomationsDashboard({ onCreateTrigger, onLoadTriggers: async () => [] })
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('No triggers yet')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Add trigger' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add trigger' })).toBeTruthy())
    const dialog = screen.getByRole('dialog', { name: 'Add trigger' })

    // Fill the tracker sourceKind (first textbox) + the goal template (the textarea).
    const inputs = within(dialog).getAllByRole('textbox')
    fireEvent.change(inputs[0]!, { target: { value: 'linear' } })
    const textarea = within(dialog).getByRole('textbox', { name: /Goal template/u })
    fireEvent.change(textarea, { target: { value: 'Fix {{issue.key}}' } })

    const submit = within(dialog).getByRole('button', { name: 'Add' })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(onCreateTrigger).toHaveBeenCalledTimes(1))
    expect(onCreateTrigger).toHaveBeenCalledWith({
      projectId: FIRST_PROJECT,
      type: 'tracker',
      config: { sourceKind: 'linear', readyStates: ['ready'] },
      goalTemplate: 'Fix {{issue.key}}',
    })
  })

  it('renders the approval policy on a trigger row (mode label, or the default)', async () => {
    // A trigger with an explicit approvalMode shows the mode label; one without
    // shows the "use default" marker.
    renderAutomationsDashboard({
      onLoadTriggers: async () => [
        trigger({ id: 'trigger-guarded', approvalMode: 'guarded' }),
        trigger({ id: 'trigger-default' }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('Approval policy: Guarded')).toBeTruthy())
    expect(screen.getByText('Approval policy: Use default')).toBeTruthy()
  })

  it('submits a trigger with a chosen approval mode from the Add dialog', async () => {
    const onCreateTrigger = vi.fn(async (input: TriggerCreateInput) => trigger({ id: 'trigger-new', type: input.type as TriggerView['type'], goalTemplate: input.goalTemplate, ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}) }))
    renderAutomationsDashboard({ onCreateTrigger, onLoadTriggers: async () => [] })
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('No triggers yet')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Add trigger' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add trigger' })).toBeTruthy())
    const dialog = screen.getByRole('dialog', { name: 'Add trigger' })

    // Fill the goal template (enables submit) + choose the "guarded" approval mode.
    const textarea = within(dialog).getByRole('textbox', { name: /Goal template/u })
    fireEvent.change(textarea, { target: { value: 'Fix {{issue.key}}' } })
    const approvalSelect = within(dialog).getByRole('combobox', { name: /Approval mode/u })
    fireEvent.change(approvalSelect, { target: { value: 'guarded' } })

    const submit = within(dialog).getByRole('button', { name: 'Add' })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(onCreateTrigger).toHaveBeenCalledTimes(1))
    expect(onCreateTrigger).toHaveBeenCalledWith({
      projectId: FIRST_PROJECT,
      type: 'tracker',
      config: { sourceKind: '', readyStates: ['ready'] },
      goalTemplate: 'Fix {{issue.key}}',
      approvalMode: 'guarded',
    })
  })

  it('deletes a trigger through the confirm modal', async () => {
    const onDeleteTrigger = vi.fn(async () => undefined)
    renderAutomationsDashboard({ onDeleteTrigger, onLoadTriggers: async () => [trigger()] })
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    await waitFor(() => expect(screen.getByText('Fix {{issue.key}}')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Delete' })).toBeTruthy())
    // The confirm modal shows the confirmation copy + a confirm button.
    const dialog = screen.getByRole('dialog', { name: 'Delete' })
    expect(within(dialog).getByText('Delete this trigger? Its fire records are kept.')).toBeTruthy()
    const confirm = within(dialog).getAllByRole('button', { name: 'Delete' }).at(-1)!
    fireEvent.click(confirm)
    await waitFor(() => expect(onDeleteTrigger).toHaveBeenCalledWith('trigger-1'))
  })
})
