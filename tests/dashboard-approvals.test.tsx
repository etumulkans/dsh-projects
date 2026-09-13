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
  fireEvent.click(screen.getByRole('button', { name: /项目运行|Project Runs/u }))
  const table = screen.getByRole('table', { name: /项目运行列表|Project Run list/u })
  fireEvent.click(within(table).getByRole('row', { name: /为本地任务源实现健康检查端点并补齐单元测试/u }))
  return screen.getByRole('complementary', { name: /运行详情|Run details/u })
}

describe('Dashboard Approvals + budgets (Phase 7, spec §7)', () => {
  it('renders a pending approval with approve/reject actions and resolves it (zh)', async () => {
    const onResolveApproval = vi.fn(async () => {})
    renderDashboard('zh', { onResolveApproval, onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [approvalFixture()] }) })

    const inspector = await openRunInspector()
    // The approval-mode chip (from the snapshot run) and the Approvals section.
    expect(within(inspector).getByText('计划')).toBeTruthy()
    expect(within(inspector).getByText('审批')).toBeTruthy()
    // The pending merge approval object (detail loads async, so wait for it).
    expect(await within(inspector).findByText('Merge 3 task branch(es) into dsh/integrate')).toBeTruthy()
    expect(await within(inspector).findByText('待处理')).toBeTruthy()
    expect(await within(inspector).findByText('合并')).toBeTruthy()

    // Approve dispatches the decision with the object's version guard.
    fireEvent.click(await within(inspector).findByRole('button', { name: '批准' }))
    await waitFor(() => expect(onResolveApproval).toHaveBeenCalledWith(
      'a1b2c3d4-0000-4000-8000-000000000001',
      'approved',
      1,
    ))
    expect(await within(inspector).findByText('审批已批准')).toBeTruthy()
  })

  it('rejects a pending approval (zh)', async () => {
    const onResolveApproval = vi.fn(async () => {})
    renderDashboard('zh', { onResolveApproval, onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [approvalFixture()] }) })

    const inspector = await openRunInspector()
    fireEvent.click(await within(inspector).findByRole('button', { name: '拒绝' }))
    await waitFor(() => expect(onResolveApproval).toHaveBeenCalledWith(
      'a1b2c3d4-0000-4000-8000-000000000001',
      'rejected',
      1,
    ))
    expect(await within(inspector).findByText('审批已拒绝')).toBeTruthy()
  })

  it('shows the empty approvals state when the run has no approval objects (zh)', async () => {
    renderDashboard('zh', { onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [] }) })

    const inspector = await openRunInspector()
    expect(await within(inspector).findByText('此运行没有审批对象。')).toBeTruthy()
    expect(within(inspector).queryByRole('button', { name: '批准' })).toBeNull()
  })

  it('renders the budget panel with limits, usage, and the 80% warning (zh)', async () => {
    renderDashboard('zh', { onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [] }) })

    const inspector = await openRunInspector()
    // The budget section title and the two configured keys.
    expect(within(inspector).getByText('预算')).toBeTruthy()
    expect(within(inspector).getByText('最大总 token')).toBeTruthy()
    expect(within(inspector).getByText('最大运行时长（分钟）')).toBeTruthy()
    // The 80% warning marker sits on the maxTotalTokens row.
    const budgetList = within(inspector).getAllByRole('list').find(list => list.textContent?.includes('最大总 token'))!
    expect(budgetList.querySelector('.dshd-budget-warning')).not.toBeNull()
    // Token usage is rendered as "used / limit" (compact numbers).
    expect(budgetList.textContent).toContain('/ ')
  })

  it('hides the budget panel when the run has no budget (zh)', async () => {
    // The plain fixture snapshot has no budget on the run.
    renderDashboard('zh', { snapshot: fixtureSnapshot, onLoadRunDetail: async () => ({ run: executingRun, events: [], truncated: false, approvals: [] }) })

    const inspector = await openRunInspector()
    expect(within(inspector).queryByText('预算')).toBeNull()
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
    renderDashboard('zh', { snapshot: fixtureSnapshot, onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    fireEvent.click(screen.getByRole('button', { name: '新建运行' }))

    const dialog = screen.getByRole('dialog', { name: '新建项目运行' })
    // The approval-mode select is present with the four modes.
    const modeSelect = within(dialog).getByLabelText('审批模式')
    expect(modeSelect).toBeTruthy()
    expect(within(dialog).getByText('使用默认')).toBeTruthy()
    // The nine budget fields are present.
    expect(within(dialog).getByLabelText('最大总 token')).toBeTruthy()
    expect(within(dialog).getByLabelText('最大运行时长（分钟）')).toBeTruthy()
    expect(within(dialog).getByLabelText('最大成本')).toBeTruthy()

    // Fill the goal, pick a mode, and set two budget limits.
    fireEvent.change(within(dialog).getByLabelText('目标'), { target: { value: 'Ship the feature' } })
    fireEvent.change(modeSelect, { target: { value: 'guarded' } })
    fireEvent.change(within(dialog).getByLabelText('最大总 token'), { target: { value: '5000' } })
    fireEvent.change(within(dialog).getByLabelText('最大运行时长（分钟）'), { target: { value: '30' } })

    fireEvent.click(within(dialog).getByRole('button', { name: '创建运行' }))
    await waitFor(() => expect(onCreateRun).toHaveBeenCalledWith({
      goal: 'Ship the feature',
      approvalMode: 'guarded',
      budget: { maxTotalTokens: 5000, maxRuntimeMinutes: 30 },
    } satisfies CreateRunInput))
  })

  it('omits approval mode and budget when left empty (zh)', async () => {
    const onCreateRun = vi.fn(async () => {})
    renderDashboard('zh', { snapshot: fixtureSnapshot, onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    fireEvent.click(screen.getByRole('button', { name: '新建运行' }))

    const dialog = screen.getByRole('dialog', { name: '新建项目运行' })
    fireEvent.change(within(dialog).getByLabelText('目标'), { target: { value: 'Just a goal' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建运行' }))
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
