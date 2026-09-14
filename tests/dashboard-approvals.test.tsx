// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import type { DashboardSnapshot } from '../src/runtime/types.ts'
import { createDashboardTranslator, DashboardI18nProvider, type DashboardLocale } from '../src/client/i18n.tsx'
import type { ApprovalRequestView } from '../src/client/controller.ts'
import type { CreateRunInput } from '../src/runs/types.ts'

afterEach(cleanup)

const executingRun = fixtureSnapshot.runs!.runs[0]!
const PROJECT_ID = executingRun.projectId

function approvalFixture(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    projectId: PROJECT_ID,
    runId: executingRun.id,
    type: 'merge',
    summary: 'Merge 3 task branch(es) into dsh/integrate',
    payload: { integrationBranch: 'dsh/integrate', taskBranches: ['a', 'b', 'c'] },
    status: 'pending',
    requestedAt: '2026-08-14T02:30:00.000Z',
    createdAt: '2026-08-14T02:30:00.000Z',
    updatedAt: '2026-08-14T02:30:00.000Z',
    version: 1,
    ...overrides,
  }
}

/**
 * The Run inspector renders the mode chip + budget panel from the *snapshot*
 * run, and the approvals list from the *detail*. This snapshot stamps the
 * first run with an approval mode + budget so those panels render.
 */
function budgetSnapshot(): DashboardSnapshot {
  return {
    ...fixtureSnapshot,
    runs: {
      ...fixtureSnapshot.runs!,
      runs: fixtureSnapshot.runs!.runs!.map((run, index) => index === 0 ? {
        ...run,
        approvalMode: 'plan',
        budget: { maxTotalTokens: 200_000, maxRuntimeMinutes: 120 },
        budgetWarnings: ['maxTotalTokens'],
      } : run),
    },
  }
}

function renderDashboard(locale: DashboardLocale, overrides: Partial<ComponentProps<typeof DashboardSurface>> = {}): void {
  const t = createDashboardTranslator(locale)
  render(
    <DashboardI18nProvider t={t}>
      <DashboardSurface
        snapshot={overrides.snapshot ?? budgetSnapshot()}
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
      />
    </DashboardI18nProvider>,
  )
}

async function openRunInspector(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /Project Runs/u }))
  const table = screen.getByRole('table', { name: /Project Run list/u })
  fireEvent.click(within(table).getByRole('row', { name: /Implement health check endpoint for the local task source and add unit tests/u }))
  return screen.getByRole('complementary', { name: /Run details/u })
}

describe('Dashboard Approvals + budgets (Phase 7, spec §7)', () => {
  it('renders a pending approval with approve/reject actions and resolves it (zh)', async () => {
    const onResolveApproval = vi.fn(async () => {})
    renderDashboard('en', { onResolveApproval, onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [approvalFixture()] }) })

    const inspector = await openRunInspector()
    // The approval-mode chip (from the snapshot run) and the Approvals section.
    expect(within(inspector).getByText('Plan')).toBeTruthy()
    expect(within(inspector).getByText('Approvals')).toBeTruthy()
    // The pending merge approval object (detail loads async, so wait for it).
    expect(await within(inspector).findByText('Merge 3 task branch(es) into dsh/integrate')).toBeTruthy()
    expect(await within(inspector).findByText('Pending')).toBeTruthy()
    expect(await within(inspector).findByText('Merge')).toBeTruthy()

    // Approve dispatches the decision with the object's version guard.
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onResolveApproval).toHaveBeenCalledWith(
      'a1b2c3d4-0000-4000-8000-000000000001',
      'approved',
      1,
    ))
    expect(await within(inspector).findByText('Approval approved')).toBeTruthy()
  })

  it('rejects a pending approval (zh)', async () => {
    const onResolveApproval = vi.fn(async () => {})
    renderDashboard('en', { onResolveApproval, onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [approvalFixture()] }) })

    const inspector = await openRunInspector()
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(onResolveApproval).toHaveBeenCalledWith(
      'a1b2c3d4-0000-4000-8000-000000000001',
      'rejected',
      1,
    ))
    expect(await within(inspector).findByText('Approval rejected')).toBeTruthy()
  })

  it('shows the empty approvals state when the run has no approval objects (zh)', async () => {
    renderDashboard('en', { onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [] }) })

    const inspector = await openRunInspector()
    expect(await within(inspector).findByText('No approval objects for this run.')).toBeTruthy()
    expect(within(inspector).queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('renders the budget panel with limits, usage, and the 80% warning (zh)', async () => {
    renderDashboard('en', { onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [] }) })

    const inspector = await openRunInspector()
    // The budget section title and the two configured keys.
    expect(within(inspector).getByText('Budget')).toBeTruthy()
    expect(within(inspector).getByText('Max total tokens')).toBeTruthy()
    expect(within(inspector).getByText('Max runtime (min)')).toBeTruthy()
    // The 80% warning marker sits on the maxTotalTokens row.
    const budgetList = within(inspector).getAllByRole('list').find(list => list.textContent?.includes('Max total tokens'))!
    expect(budgetList.querySelector('.dshd-budget-warning')).not.toBeNull()
    // Token usage is rendered as "used / limit" (compact numbers).
    expect(budgetList.textContent).toContain('/ ')
  })

  it('hides the budget panel when the run has no budget (zh)', async () => {
    // The plain fixture snapshot has no budget on the run.
    renderDashboard('en', { snapshot: fixtureSnapshot, onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [] }) })

    const inspector = await openRunInspector()
    expect(within(inspector).queryByText('Budget')).toBeNull()
  })

  it('renders the Approvals + Budget sections in English (en)', async () => {
    const onResolveApproval = vi.fn(async () => {})
    renderDashboard('en', { onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [approvalFixture()] }), onResolveApproval })

    const inspector = await openRunInspector()
    expect(within(inspector).getByText('Approvals')).toBeTruthy()
    expect(within(inspector).getByText('Budget')).toBeTruthy()
    expect(await within(inspector).findByText('Pending')).toBeTruthy()
    expect(await within(inspector).findByText('Merge')).toBeTruthy()
    expect(within(inspector).getByText('Max total tokens')).toBeTruthy()
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onResolveApproval).toHaveBeenCalledWith(
      'a1b2c3d4-0000-4000-8000-000000000001',
      'approved',
      1,
    ))
    expect(await within(inspector).findByText('Approval approved')).toBeTruthy()
  })
})

describe('Dashboard New Run dialog (Phase 7, spec §7.3)', () => {
  it('submits a goal with an approval mode and budget fields (zh)', async () => {
    const onCreateRun = vi.fn(async () => {})
    renderDashboard('en', { snapshot: fixtureSnapshot, onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Run' }))

    const dialog = screen.getByRole('dialog', { name: 'New Project Run' })
    // The approval-mode select is present with the four modes.
    const modeSelect = within(dialog).getByLabelText('Approval mode')
    expect(modeSelect).toBeTruthy()
    expect(within(dialog).getByText('Use default')).toBeTruthy()
    // The nine budget fields are present.
    expect(within(dialog).getByLabelText('Max total tokens')).toBeTruthy()
    expect(within(dialog).getByLabelText('Max runtime (min)')).toBeTruthy()
    expect(within(dialog).getByLabelText('Max cost')).toBeTruthy()

    // Fill the goal, pick a mode, and set two budget limits.
    fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'Ship the feature' } })
    fireEvent.change(modeSelect, { target: { value: 'guarded' } })
    fireEvent.change(within(dialog).getByLabelText('Max total tokens'), { target: { value: '5000' } })
    fireEvent.change(within(dialog).getByLabelText('Max runtime (min)'), { target: { value: '30' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Run' }))
    await waitFor(() => expect(onCreateRun).toHaveBeenCalledWith({
      goal: 'Ship the feature',
      approvalMode: 'guarded',
      budget: { maxTotalTokens: 5000, maxRuntimeMinutes: 30 },
    } satisfies CreateRunInput))
  })

  it('omits approval mode and budget when left empty (zh)', async () => {
    const onCreateRun = vi.fn(async () => {})
    renderDashboard('en', { snapshot: fixtureSnapshot, onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Run' }))

    const dialog = screen.getByRole('dialog', { name: 'New Project Run' })
    fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'Just a goal' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Run' }))
    await waitFor(() => expect(onCreateRun).toHaveBeenCalledWith({ goal: 'Just a goal' }))
  })

  it('opens the New Run dialog with the approval-mode field in English (en)', async () => {
    const onCreateRun = vi.fn(async () => {})
    renderDashboard('en', { snapshot: fixtureSnapshot, onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Run' }))

    const dialog = screen.getByRole('dialog', { name: 'New Project Run' })
    expect(within(dialog).getByLabelText('Approval mode')).toBeTruthy()
    expect(within(dialog).getByLabelText('Max total tokens')).toBeTruthy()
    expect(within(dialog).getByLabelText('Max cost')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'English goal' } })
    fireEvent.change(within(dialog).getByLabelText('Approval mode'), { target: { value: 'autonomous' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Run' }))
    await waitFor(() => expect(onCreateRun).toHaveBeenCalledWith({
      goal: 'English goal',
      approvalMode: 'autonomous',
    } satisfies CreateRunInput))
  })
})
