// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import type { ProjectRunView, RunDetailView } from '../src/runs/types.ts'
import type { ProjectTaskView } from '../src/tasks/types.ts'

afterEach(cleanup)

const executingRun = fixtureSnapshot.runs!.runs[0]!

const TASK_SUCCEEDED = '11111111-2222-4333-8444-555566667701'
const TASK_RUNNING = '22222222-2222-4333-8444-555566667702'
const TASK_FAILED = '33333333-2222-4333-8444-555566667703'
const TASK_BLOCKED = '44444444-2222-4333-8444-555566667704'
const TASK_PENDING = '55555555-2222-4333-8444-555566667705'

const taskBase = {
  runId: executingRun.id,
  planId: '66666666-2222-4333-8444-555566667706',
  acceptanceCriteria: [],
  createdAt: '2026-08-14T02:20:00.000Z',
  updatedAt: '2026-08-14T02:29:00.000Z',
  version: 1,
} as const

const succeededTask: ProjectTaskView = {
  ...taskBase,
  id: TASK_SUCCEEDED,
  planTaskId: 't1',
  title: '实现健康检查端点',
  status: 'succeeded',
  dependencies: [],
  attempt: 1,
  maxAttempts: 3,
  outputSummary: '端点已上线，测试全部通过。',
  completedAt: '2026-08-14T02:25:00.000Z',
}

const runningTask: ProjectTaskView = {
  ...taskBase,
  id: TASK_RUNNING,
  planTaskId: 't2',
  title: '补齐单元测试',
  status: 'running',
  dependencies: [TASK_SUCCEEDED],
  attempt: 1,
  maxAttempts: 3,
  assignedAgentId: 'dsh-task-7a6c5e4d',
  startedAt: '2026-08-14T02:26:00.000Z',
}

const failedTask: ProjectTaskView = {
  ...taskBase,
  id: TASK_FAILED,
  planTaskId: 't3',
  title: '修复 CI 配置',
  status: 'failed',
  dependencies: [],
  attempt: 3,
  maxAttempts: 3,
  error: 'CI 在解析配置时失败',
}

const blockedTask: ProjectTaskView = {
  ...taskBase,
  id: TASK_BLOCKED,
  planTaskId: 't4',
  title: '补充端到端覆盖',
  status: 'blocked',
  dependencies: [TASK_FAILED],
  attempt: 0,
}

const pendingTask: ProjectTaskView = {
  ...taskBase,
  id: TASK_PENDING,
  planTaskId: 't5',
  title: '撰写发布说明',
  status: 'pending',
  dependencies: [TASK_BLOCKED],
  attempt: 0,
}

const detailView: RunDetailView = {
  run: executingRun,
  truncated: false,
  events: [],
  tasks: [succeededTask, runningTask, failedTask, blockedTask, pendingTask],
}

async function openRunInspector(run: ProjectRunView): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
  const table = screen.getByRole('table', { name: '项目运行列表' })
  fireEvent.click(within(table).getByRole('row', { name: new RegExp(run.goal.slice(0, 12)) }))
  return screen.getByRole('complementary', { name: /运行详情/u })
}

describe('Dashboard Task execution interactions', () => {
  it('renders the worker banner, the counts chip, and one row per status with deps and attempts', async () => {
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => detailView)
    const onTaskRetry = vi.fn(async (): Promise<void> => undefined)
    renderDashboard({ onLoadRunDetail, onTaskRetry })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))

    // section + worker kind from the snapshot + the counts chip from the run view
    expect(within(inspector).getByText('任务')).toBeTruthy()
    expect(within(inspector).getByText('本地代理')).toBeTruthy()
    expect(within(inspector).getByText('任务 0/5 完成')).toBeTruthy()

    // one row per status with its zh status pill
    expect(within(inspector).getByText('已完成')).toBeTruthy()
    expect(within(inspector).getByText('运行中')).toBeTruthy()
    expect(within(inspector).getByText('失败')).toBeTruthy()
    expect(within(inspector).getByText('受阻')).toBeTruthy()
    expect(within(inspector).getByText('待调度')).toBeTruthy()

    // dependency labels resolve the dependency's plan position; the blocked row
    // names its failed dependency explicitly
    expect(within(inspector).getAllByText('依赖：t1').length).toBeGreaterThanOrEqual(1)
    expect(within(inspector).getByText('受阻于：t3')).toBeTruthy()

    // attempt counters and the failure error text
    expect(within(inspector).getAllByText('第 1/3 次')).toHaveLength(2)
    expect(within(inspector).getByText('第 3/3 次')).toBeTruthy()
    expect(within(inspector).getByText('CI 在解析配置时失败')).toBeTruthy()
    expect(within(inspector).getByText('端点已上线，测试全部通过。')).toBeTruthy()

    // the retry action exists only on the failed row
    expect(within(inspector).getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('retries a failed task: pending state, then the success notice and a refresh', async () => {
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => detailView)
    let releaseRetry: (() => void) | undefined
    const onTaskRetry = vi.fn((): Promise<void> => new Promise(resolve => { releaseRetry = resolve }))
    const onRefresh = vi.fn(async (): Promise<void> => undefined)
    renderDashboard({ onLoadRunDetail, onTaskRetry, onRefresh })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))

    fireEvent.click(within(inspector).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(onTaskRetry).toHaveBeenCalledWith(TASK_FAILED))
    // while the RPC is in flight the row shows the pending label
    expect(within(inspector).getByText('重试中…')).toBeTruthy()

    releaseRetry?.()
    await waitFor(() => expect(within(inspector).getByText('任务已重新排队')).toBeTruthy())
    expect(within(inspector).queryByText('重试中…')).toBeNull()
    // the success path refreshes the snapshot
    expect(onRefresh).toHaveBeenCalled()
  })

  it('keeps the failed row and shows the error message when the retry is rejected', async () => {
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => detailView)
    const onTaskRetry = vi.fn(async (): Promise<void> => {
      throw new Error('task.retryNotAllowed')
    })
    renderDashboard({ onLoadRunDetail, onTaskRetry })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))

    fireEvent.click(within(inspector).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(onTaskRetry).toHaveBeenCalledWith(TASK_FAILED))

    await waitFor(() => expect(within(inspector).getByText('task.retryNotAllowed')).toBeTruthy())
    // the failed row stays with its retry action for the operator's next attempt
    expect(within(inspector).getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('shows the empty state when the Host has no tasks for the run', async () => {
    const emptyView: RunDetailView = { run: executingRun, truncated: false, events: [], tasks: [] }
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => emptyView)
    renderDashboard({ onLoadRunDetail })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))
    expect(within(inspector).getByText('暂无任务')).toBeTruthy()
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
