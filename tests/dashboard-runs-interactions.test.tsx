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

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))

    const table = screen.getByRole('table', { name: '项目运行列表' })
    expect(table.textContent).toContain('为本地任务源实现健康检查端点并补齐单元测试')
    expect(table.textContent).toContain('执行中')
    expect(table.textContent).toContain('已成功')

    fireEvent.click(within(table).getByRole('row', { name: /为本地任务源实现健康检查端点并补齐单元测试/u }))

    const inspector = screen.getByRole('complementary', { name: /运行详情/u })
    expect(inspector.textContent).toContain('执行中')
    expect(inspector.textContent).toContain('手动')

    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))
    expect(await within(inspector).findByText('Run created → planning')).toBeTruthy()
    expect(within(inspector).getByText('Run created')).toBeTruthy()
    expect(within(inspector).queryByText('暂无事件。')).toBeNull()
  })

  it('pauses a running Run with the current version guard', async () => {
    const onRunTransition = vi.fn(async () => {})
    renderDashboard({ onRunTransition, onLoadRunDetail: async runId => runDetailFixture(runId) })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    const table = screen.getByRole('table', { name: '项目运行列表' })
    fireEvent.click(within(table).getByRole('row', { name: /为本地任务源实现健康检查端点并补齐单元测试/u }))

    const inspector = screen.getByRole('complementary', { name: /运行详情/u })
    fireEvent.click(within(inspector).getByRole('button', { name: '暂停' }))

    await waitFor(() => expect(onRunTransition).toHaveBeenCalledWith({
      runId: executingRun.id,
      to: 'paused',
      expectedVersion: executingRun.version,
    }))
  })

  it('resumes a paused Run back to its suspended phase', async () => {
    const onRunTransition = vi.fn(async () => {})
    renderDashboard({ onRunTransition, onLoadRunDetail: async runId => runDetailFixture(runId) })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    const table = screen.getByRole('table', { name: '项目运行列表' })
    fireEvent.click(within(table).getByRole('row', { name: /调研 Agent Teams 实验能力并输出适配层方案/u }))

    const inspector = screen.getByRole('complementary', { name: /运行详情/u })
    expect(within(inspector).getByText('已暂停')).toBeTruthy()
    fireEvent.click(within(inspector).getByRole('button', { name: '继续' }))

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

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    const table = screen.getByRole('table', { name: '项目运行列表' })
    fireEvent.click(within(table).getByRole('row', { name: /修复全局看板跨项目状态归一化/u }))

    const inspector = screen.getByRole('complementary', { name: /运行详情/u })
    expect(within(inspector).getByText('已成功')).toBeTruthy()
    expect(within(inspector).queryByRole('button', { name: '暂停' })).toBeNull()
    expect(within(inspector).queryByRole('button', { name: '取消运行' })).toBeNull()
    expect(within(inspector).getByText('已修复并补充回归测试。')).toBeTruthy()
    expect(onRunTransition).not.toHaveBeenCalled()
    expect(terminalRun.phase).toBe('succeeded')
  })

  it('creates a Run from the dialog and trims the goal', async () => {
    const onCreateRun = vi.fn(async () => {})
    renderDashboard({ onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    fireEvent.click(screen.getByRole('button', { name: '新建运行' }))

    const dialog = screen.getByRole('dialog', { name: '新建项目运行' })
    fireEvent.change(within(dialog).getByLabelText('目标'), { target: { value: '  实现运行详情视图  ' } })
    fireEvent.change(within(dialog).getByLabelText('来源引用（可选）'), { target: { value: 'JIRA-12' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建运行' }))

    await waitFor(() => expect(onCreateRun).toHaveBeenCalledWith({ goal: '实现运行详情视图', sourceRef: 'JIRA-12' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目运行' })).toBeNull())
  })

  it('keeps the dialog open when creation fails', async () => {
    const onCreateRun = vi.fn(async () => {
      throw new Error('run.goalEmpty')
    })
    renderDashboard({ onCreateRun })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    fireEvent.click(screen.getByRole('button', { name: '新建运行' }))
    const dialog = screen.getByRole('dialog', { name: '新建项目运行' })
    fireEvent.change(within(dialog).getByLabelText('目标'), { target: { value: 'will fail' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建运行' }))

    await waitFor(() => expect(onCreateRun).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog', { name: '新建项目运行' })).toBeTruthy()
  })

  it('renders the empty state when the snapshot has no runs section', async () => {
    const { runs: _runs, ...withoutRuns } = fixtureSnapshot
    renderDashboard({ snapshot: withoutRuns, onCreateRun: async () => {} })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    expect(screen.getByText('尚无项目运行。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建运行' })).toBeTruthy()
  })

  it('shows project names and hides manual creation in the global view', async () => {
    const globalRun = { ...executingRun, projectName: 'dsh-dashboard' }
    const snapshot = {
      ...globalFixtureSnapshot,
      runs: { total: 1, runs: [globalRun] },
    }
    renderDashboard({ snapshot })

    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    const table = screen.getByRole('table', { name: '项目运行列表' })
    expect(table.textContent).toContain('dsh-dashboard')
    expect(screen.queryByRole('button', { name: '新建运行' })).toBeNull()
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
