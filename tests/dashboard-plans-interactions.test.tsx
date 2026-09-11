// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import type { CreatePlanInput, RunPlanRecord } from '../src/plans/types.ts'
import type { ProjectRunView } from '../src/runs/types.ts'

afterEach(cleanup)

const executingRun = fixtureSnapshot.runs!.runs[0]!
const pausedRun = fixtureSnapshot.runs!.runs[1]!
const terminalRun = fixtureSnapshot.runs!.runs[2]!

const PLAN_V1_ID = 'aaaa1111-2222-4333-8444-555566667777'
const PLAN_V2_ID = '5e0d1c88-9a47-4f2e-b3c6-7d8a1f0e9b24'

const planV1: RunPlanRecord = {
  id: PLAN_V1_ID,
  runId: executingRun.id,
  projectId: executingRun.projectId,
  version: 1,
  pattern: 'direct',
  rationale: '初始计划：单任务直接执行',
  assumptions: ['任务规模较小'],
  successCriteria: [{ id: 'c1', description: '健康检查端点可用' }],
  tasks: [
    { id: 't1', title: '实现健康检查端点', description: '添加端点与测试', dependencies: [], acceptanceCriteria: ['返回 200 与状态 JSON'] },
  ],
  status: 'superseded',
  replanReason: '范围扩大：需要补齐单元测试',
  createdAt: '2026-08-14T02:11:00.000Z',
  revision: 2,
}

const planV2: RunPlanRecord = {
  id: PLAN_V2_ID,
  runId: executingRun.id,
  projectId: executingRun.projectId,
  version: 2,
  pattern: 'supervisor',
  rationale: '协调两个任务并行推进',
  assumptions: [],
  successCriteria: [{ id: 'c1', description: '端点与测试全部通过' }],
  tasks: [
    { id: 't1', title: '实现健康检查端点', description: '添加 /health 端点', dependencies: [], acceptanceCriteria: ['返回 200'] },
    { id: 't2', title: '补齐单元测试', description: '覆盖端点与错误路径', dependencies: ['t1'], acceptanceCriteria: [] },
  ],
  status: 'active',
  replanReason: '范围扩大：需要补齐单元测试',
  supersedesPlanId: PLAN_V1_ID,
  createdAt: '2026-08-14T02:20:00.000Z',
  revision: 1,
}

const draftPlan: RunPlanRecord = {
  id: 'bbbb1111-2222-4333-8444-555566667777',
  runId: executingRun.id,
  projectId: executingRun.projectId,
  version: 1,
  pattern: 'supervisor',
  rationale: '待批准的草稿',
  assumptions: [],
  successCriteria: [],
  tasks: [{ id: 't1', title: '草稿任务', description: '描述', dependencies: [], acceptanceCriteria: [] }],
  status: 'draft',
  createdAt: '2026-08-14T02:25:00.000Z',
  revision: 1,
}

function plansFor(runId: string): RunPlanRecord[] {
  if (runId === executingRun.id) return [planV2, planV1]
  return []
}

async function openRunInspector(run: ProjectRunView): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
  const table = screen.getByRole('table', { name: '项目运行列表' })
  fireEvent.click(within(table).getByRole('row', { name: new RegExp(run.goal.slice(0, 12)) }))
  return screen.getByRole('complementary', { name: /运行详情/u })
}

describe('Dashboard Run Plan interactions', () => {
  it('loads plans into the inspector, shows the active chip, and expands a version', async () => {
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))

    expect(within(inspector).getByText('运行计划')).toBeTruthy()
    expect(within(inspector).getByText('计划 v2 · 激活')).toBeTruthy()
    expect(within(inspector).getByText('v2')).toBeTruthy()
    expect(within(inspector).getByText('v1')).toBeTruthy()
    expect(within(inspector).getByText('监督者')).toBeTruthy()
    expect(within(inspector).getByText('已取代')).toBeTruthy()

    fireEvent.click(within(inspector).getByRole('button', { name: /v2/u }))
    expect(within(inspector).getByText('协调两个任务并行推进')).toBeTruthy()
    expect(within(inspector).getByText('t2 · 补齐单元测试')).toBeTruthy()
    expect(within(inspector).getByText('依赖 t1')).toBeTruthy()
    expect(within(inspector).getByText('范围扩大：需要补齐单元测试')).toBeTruthy()

    fireEvent.click(within(inspector).getByRole('button', { name: /v1/u }))
    expect(within(inspector).getByText('初始计划：单任务直接执行')).toBeTruthy()
    expect(within(inspector).getByText('健康检查端点可用')).toBeTruthy()
  })

  it('transitions a draft plan from the version actions with the CAS revision', async () => {
    const onPlanTransition = vi.fn(async () => ({ ...draftPlan, status: 'active' as const }))
    const onLoadPlans = vi.fn(async () => [draftPlan])
    renderDashboard({ onLoadPlans, onPlanTransition })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))
    fireEvent.click(within(inspector).getByRole('button', { name: /v1/u }))

    expect(within(inspector).getByRole('button', { name: '请求批准' })).toBeTruthy()
    expect(within(inspector).getByRole('button', { name: '直接激活' })).toBeTruthy()

    fireEvent.click(within(inspector).getByRole('button', { name: '直接激活' }))
    await waitFor(() => expect(onPlanTransition).toHaveBeenCalledWith({
      planId: draftPlan.id,
      status: 'active',
      expectedRevision: 1,
    }))
  })

  it('supersedes the active plan through the reason dialog and keeps it open on failure', async () => {
    const onPlanTransition = vi.fn(async () => {
      throw new Error('plan.revisionConflict')
    })
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans, onPlanTransition })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))
    fireEvent.click(within(inspector).getByRole('button', { name: /v2/u }))

    fireEvent.click(within(inspector).getByRole('button', { name: '取代' }))
    const dialog = screen.getByRole('dialog', { name: '取代计划 v2' })
    const confirm = within(dialog).getByRole('button', { name: '取代' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('重规划原因（必填）'), { target: { value: ' 方向调整 ' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => expect(onPlanTransition).toHaveBeenCalledWith({
      planId: PLAN_V2_ID,
      status: 'superseded',
      expectedRevision: planV2.revision,
      replanReason: '方向调整',
    }))
    // The failed transition keeps the dialog open with its error.
    expect(screen.getByRole('dialog', { name: '取代计划 v2' })).toBeTruthy()
    expect(within(dialog).getByRole('alert')).toBeTruthy()
  })

  it('creates a plan from the dialog, requiring the replan reason once versions exist', async () => {
    const onPlanCreate = vi.fn(async (input: CreatePlanInput): Promise<RunPlanRecord> => ({
      ...input,
      id: 'cccc1111-2222-4333-8444-555566667777',
      projectId: executingRun.projectId,
      version: 3,
      assumptions: input.assumptions ?? [],
      successCriteria: (input.successCriteria ?? []).map((description, index) => ({ id: `c${index + 1}`, description })),
      tasks: (input.tasks ?? []).map((task, index) => ({ ...task, id: `t${index + 1}`, dependencies: task.dependencies ?? [], acceptanceCriteria: task.acceptanceCriteria ?? [] })),
      status: 'draft',
      createdAt: '2026-08-14T02:30:00.000Z',
      revision: 1,
    }))
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans, onPlanCreate })

    const inspector = await openRunInspector(executingRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(executingRun.id))
    fireEvent.click(within(inspector).getByRole('button', { name: '新建计划' }))

    const dialog = screen.getByRole('dialog', { name: '新建运行计划' })
    const create = within(dialog).getByRole('button', { name: '创建计划' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('依据'), { target: { value: '  协调两个任务  ' } })
    // Versions exist (v2), so the replan reason is required before enabling.
    expect(create.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('重规划原因 *'), { target: { value: '重新规划' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '添加任务' }))
    fireEvent.change(within(dialog).getAllByPlaceholderText('任务标题')[0]!, { target: { value: '第一个任务' } })
    fireEvent.change(within(dialog).getAllByPlaceholderText('任务描述')[0]!, { target: { value: '做点什么' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '添加任务' }))
    fireEvent.change(within(dialog).getAllByPlaceholderText('任务标题')[1]!, { target: { value: '第二个任务' } })
    fireEvent.change(within(dialog).getAllByPlaceholderText('任务描述')[1]!, { target: { value: '再做点什么' } })
    fireEvent.click(within(dialog).getByLabelText('t1'))

    expect(create.disabled).toBe(false)
    fireEvent.click(create)

    await waitFor(() => expect(onPlanCreate).toHaveBeenCalledWith({
      runId: executingRun.id,
      pattern: 'direct',
      rationale: '协调两个任务',
      tasks: [
        { title: '第一个任务', description: '做点什么' },
        { title: '第二个任务', description: '再做点什么', dependencies: ['t1'] },
      ],
      replanReason: '重新规划',
    }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建运行计划' })).toBeNull())
  })

  it('shows the empty state with the New Plan action for a run without plans', async () => {
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    const onPlanCreate = vi.fn(async (input: CreatePlanInput): Promise<RunPlanRecord> => ({
      ...input,
      id: 'dddd1111-2222-4333-8444-555566667777',
      projectId: pausedRun.projectId,
      version: 1,
      assumptions: input.assumptions ?? [],
      successCriteria: (input.successCriteria ?? []).map((description, index) => ({ id: `c${index + 1}`, description })),
      tasks: (input.tasks ?? []).map((task, index) => ({ ...task, id: `t${index + 1}`, dependencies: task.dependencies ?? [], acceptanceCriteria: task.acceptanceCriteria ?? [] })),
      status: 'draft',
      createdAt: '2026-08-14T02:30:00.000Z',
      revision: 1,
    }))
    renderDashboard({ onLoadPlans, onPlanCreate })

    const inspector = await openRunInspector(pausedRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(pausedRun.id))
    expect(within(inspector).getByText('此运行尚无计划。')).toBeTruthy()
    expect(within(inspector).getByRole('button', { name: '新建计划' })).toBeTruthy()
  })

  it('hides New Plan for a terminal run', async () => {
    const onLoadPlans = vi.fn(async (runId: string) => plansFor(runId))
    renderDashboard({ onLoadPlans })

    const inspector = await openRunInspector(terminalRun)
    await waitFor(() => expect(onLoadPlans).toHaveBeenCalledWith(terminalRun.id))
    expect(within(inspector).queryByRole('button', { name: '新建计划' })).toBeNull()
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
