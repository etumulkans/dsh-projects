// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import { createDashboardTranslator, DashboardI18nProvider } from '../src/client/i18n.tsx'
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

async function openRunInspector(run: ProjectRunView, locale: 'zh' | 'en' = 'zh'): Promise<HTMLElement> {
  const names = locale === 'en'
    ? { tab: 'Project Runs', table: 'Project Run list', inspector: /Run details/u }
    : { tab: '项目运行', table: '项目运行列表', inspector: /运行详情/u }
  fireEvent.click(screen.getByRole('button', { name: names.tab }))
  const table = screen.getByRole('table', { name: names.table })
  fireEvent.click(within(table).getByRole('row', { name: new RegExp(run.goal.slice(0, 12)) }))
  return screen.getByRole('complementary', { name: names.inspector })
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

  it('renders the zh unavailable-worker banner when the composition has no runtime', async () => {
    const emptyView: RunDetailView = { run: executingRun, truncated: false, events: [] }
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => emptyView)
    const summary = fixtureSnapshot.runs!
    const snapshot = { ...fixtureSnapshot, runs: { ...summary, worker: 'unavailable' as const } }
    render(
      <DashboardSurface
        snapshot={snapshot}
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
        onLoadRunDetail={onLoadRunDetail}
      />,
    )

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(executingRun.id))
    expect(within(inspector).getByText('执行不可用：当前组合未挂载代理运行时')).toBeTruthy()
  })
})

describe('Dashboard Phase 5 Git isolation UI', () => {
  const runId = executingRun.id
  const integrationBranch = `dsh/run-${runId.slice(0, 8)}/integration`
  const integrationHead = '9e8d7c6b5a493827160514233241506978879605'
  const taskBranch = `dsh/run-${runId.slice(0, 8)}/t1`
  const taskHead = '2222222222222222222222222222222222222222'

  const gitTask: ProjectTaskView = {
    ...taskBase,
    id: TASK_SUCCEEDED,
    planTaskId: 't1',
    title: '实现健康检查端点',
    status: 'succeeded',
    dependencies: [],
    attempt: 1,
    maxAttempts: 3,
    outputSummary: '端点已上线。',
    branch: taskBranch,
    baseCommit: '1111111111111111111111111111111111111111',
    headCommit: taskHead,
    completedAt: '2026-08-14T02:25:00.000Z',
  }

  it('shows the integration panel, the per-task branch chip, and the integration events for a succeeded Git run (zh)', async () => {
    const run: ProjectRunView = {
      ...executingRun,
      phase: 'succeeded',
      completedAt: '2026-08-14T02:35:00.000Z',
      resultSummary: `integrated branch ${integrationBranch} @ ${integrationHead.slice(0, 8)}`,
      integrationBranch,
      integrationHead,
      taskCounts: { total: 5, pending: 0, ready: 0, running: 0, blocked: 0, failed: 0, succeeded: 5 },
    }
    const snapshot = {
      ...fixtureSnapshot,
      runs: { ...fixtureSnapshot.runs!, runs: [run, ...fixtureSnapshot.runs!.runs.slice(1)] },
    }
    const detail: RunDetailView = {
      run,
      truncated: false,
      events: [
        {
          id: 'evt-int-done', type: 'run.integration.completed', title: 'Integration completed',
          detail: `${integrationBranch} — merged: t1, t2; skipped: none`, seq: 10, at: '2026-08-14T02:34:00.000Z',
        },
        {
          id: 'evt-int-start', type: 'run.integration.started', title: 'Integration started',
          detail: integrationBranch, seq: 9, at: '2026-08-14T02:33:00.000Z',
        },
      ],
      tasks: [gitTask],
    }
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => detail)
    renderDashboard({ onLoadRunDetail, snapshot })

    const inspector = await openRunInspector(run)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(run.id))

    // the integration panel: title, branch, short head, and the run phase label
    const panel = within(inspector).getByRole('status')
    expect(within(panel).getByText(integrationBranch)).toBeTruthy()
    expect(within(panel).getByText(integrationHead.slice(0, 7))).toBeTruthy()
    expect(within(panel).getByText('已成功')).toBeTruthy()

    // the task row carries its branch chip with the full head in the title
    expect(screen.getByTitle(`${taskBranch} @ ${taskHead}`)).toBeTruthy()

    // the integration events ride the event stream with their details
    // (the branch name appears on the panel and on the started event detail)
    expect(within(inspector).getByText('Integration started')).toBeTruthy()
    expect(within(inspector).getAllByText(integrationBranch).length).toBeGreaterThanOrEqual(2)
    expect(within(inspector).getByText(`${integrationBranch} — merged: t1, t2; skipped: none`)).toBeTruthy()
  })

  it('shows the conflict detail in the integration panel for a blocked run (en)', async () => {
    const run: ProjectRunView = {
      ...executingRun,
      phase: 'blocked',
      suspendedFrom: 'integrating',
      integrationBranch,
      taskCounts: { total: 2, pending: 0, ready: 0, running: 0, blocked: 0, failed: 0, succeeded: 2 },
    }
    const detail: RunDetailView = {
      run,
      truncated: false,
      events: [
        {
          id: 'evt-int-fail', type: 'run.integration.failed', title: 'Integration conflict',
          detail: 'integration conflict: src/clash.ts', seq: 9, at: '2026-08-14T02:34:00.000Z',
        },
      ],
      tasks: [gitTask],
    }
    const snapshot = {
      ...fixtureSnapshot,
      runs: { ...fixtureSnapshot.runs!, runs: [run, ...fixtureSnapshot.runs!.runs.slice(1)] },
    }
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => detail)
    render(
      <DashboardI18nProvider t={createDashboardTranslator('en')}>
        <DashboardSurface
          snapshot={snapshot}
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
          onLoadRunDetail={onLoadRunDetail}
        />
      </DashboardI18nProvider>,
    )

    const inspector = await openRunInspector(run, 'en')
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(run.id))

    const panel = within(inspector).getByRole('status')
    expect(within(panel).getByText(integrationBranch)).toBeTruthy()
    expect(within(panel).getByText('Blocked')).toBeTruthy()
    expect(within(panel).getByText('integration conflict: src/clash.ts')).toBeTruthy()
  })

  it('shows the no-Git notice instead of the integration panel for controlled-directory projects', async () => {
    const run: ProjectRunView = {
      ...executingRun,
      phase: 'succeeded',
      completedAt: '2026-08-14T02:35:00.000Z',
      resultSummary: 'all tasks succeeded (no Git isolation)',
      taskCounts: { total: 3, pending: 0, ready: 0, running: 0, blocked: 0, failed: 0, succeeded: 3 },
    }
    const snapshot = {
      ...fixtureSnapshot,
      catalog: {
        ...fixtureSnapshot.catalog,
        projects: fixtureSnapshot.catalog.projects.map(project =>
          project.id === executingRun.projectId
            ? { ...project, workspaceStrategy: 'controlled-directory' as const }
            : project),
      },
      runs: { ...fixtureSnapshot.runs!, runs: [run, ...fixtureSnapshot.runs!.runs.slice(1)] },
    }
    const detail: RunDetailView = {
      run,
      truncated: false,
      events: [],
      tasks: [
        {
          ...taskBase,
          id: TASK_SUCCEEDED,
          planTaskId: 't1',
          title: '实现健康检查端点',
          status: 'succeeded',
          dependencies: [],
          attempt: 1,
        },
      ],
    }
    const onLoadRunDetail = vi.fn(async (): Promise<RunDetailView> => detail)
    renderDashboard({ onLoadRunDetail, snapshot })

    const inspector = await openRunInspector(run)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(run.id))

    expect(within(inspector).getByText('该项目不是 Git 仓库：任务在共享目录中执行，未做工作树隔离。')).toBeTruthy()
    // no integration panel and no branch chip for non-Git tasks
    expect(within(inspector).queryByText('集成')).toBeNull()
    expect(screen.queryByTitle(new RegExp(`^${taskBranch}`))).toBeNull()
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
