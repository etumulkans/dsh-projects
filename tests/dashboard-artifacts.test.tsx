// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { DashboardI18nProvider, createDashboardTranslator } from '../src/client/i18n.tsx'
import type {
  ArtifactCreateInput,
  ArtifactView,
  ClientArtifactKind,
} from '../src/client/controller.ts'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import type { RunDetailView } from '../src/runs/types.ts'

afterEach(cleanup)

const FIRST_PROJECT = '08b8e62d-5a7c-4a3a-a582-b63278347db0'
const EXECUTING_RUN = fixtureSnapshot.runs!.runs[0]!
const SUCCEEDED_RUN = fixtureSnapshot.runs!.runs[2]!

function artifact(overrides: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id: 'artifact-1',
    projectId: FIRST_PROJECT,
    runId: EXECUTING_RUN.id,
    kind: 'plan',
    title: 'The plan',
    content: 'step one\nstep two',
    createdAt: '2026-08-14T02:30:00.000Z',
    ...overrides,
  }
}

const FINAL_REPORT_CONTENT = [
  'Goal',
  'Implement the health-check endpoint.',
  '',
  'Outcome',
  'Succeeded.',
  '',
  'Changes',
  '- Added the endpoint (succeeded)',
  '',
  'Validation',
  'None.',
  '',
  'Git',
  'None.',
  '',
  'Agents',
  'None.',
  '',
  'Usage',
  'None.',
  '',
  'Project knowledge learned',
  'None.',
  '',
  'Remaining risks',
  'None.',
].join('\n')

function finalReportArtifact(): ArtifactView {
  return artifact({
    id: 'artifact-final',
    runId: SUCCEEDED_RUN.id,
    kind: 'final-report',
    title: 'Final report',
    content: FINAL_REPORT_CONTENT,
  })
}

function renderArtifactsDashboard(
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
      onLoadArtifacts={async (input: { readonly runId?: string; readonly projectId?: string; readonly kind?: ClientArtifactKind }) => {
        void input
        return [artifact()]
      }}
      onCreateArtifact={async (input: ArtifactCreateInput): Promise<ArtifactView> => {
        return artifact({ id: 'artifact-new', kind: input.kind, title: input.title, ...(input.content === undefined ? {} : { content: input.content }) })
      }}
      {...overrides}
    />,
  )
}

describe('Dashboard Project Artifacts tab (spec §10)', () => {
  it('renders the artifacts tab between memory and configuration in zh', () => {
    renderArtifactsDashboard()
    const tab = screen.getByRole('button', { name: '项目产物' })
    expect(tab).toBeTruthy()
    const tabs = Array.from(document.querySelectorAll('button')).map(button => button.textContent)
    expect(tabs.indexOf('项目产物')).toBeGreaterThan(tabs.indexOf('项目记忆'))
    expect(tabs.indexOf('项目产物')).toBeLessThan(tabs.indexOf('配置'))
  })

  it('renders the artifacts tab label in English under the en locale', () => {
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
    expect(screen.getByRole('button', { name: 'Project Artifacts' })).toBeTruthy()
  })

  it('fetches the first project on demand when the tab opens', async () => {
    const onLoadArtifacts = vi.fn(async () => [artifact()])
    renderArtifactsDashboard({ onLoadArtifacts })

    fireEvent.click(screen.getByRole('button', { name: '项目产物' }))
    await waitFor(() => expect(onLoadArtifacts).toHaveBeenCalledTimes(1))
    expect(onLoadArtifacts).toHaveBeenCalledWith({ projectId: FIRST_PROJECT })
  })

  it('lists the project artifacts with kind, title, and an open-run action', async () => {
    renderArtifactsDashboard()
    fireEvent.click(screen.getByRole('button', { name: '项目产物' }))

    const list = await screen.findByRole('table', { name: '产物列表' })
    expect(list.textContent).toContain('The plan')
    expect(list.textContent).toContain('计划')
    // The run-scoped artifact exposes the open-run action.
    expect(within(list).getByRole('button', { name: '打开运行' })).toBeTruthy()
  })

  it('opens the add dialog and submits a new artifact', async () => {
    const onCreateArtifact = vi.fn(async (input: ArtifactCreateInput): Promise<ArtifactView> => {
      return artifact({ id: 'artifact-new', kind: input.kind, title: input.title, ...(input.content === undefined ? {} : { content: input.content }) })
    })
    renderArtifactsDashboard({ onCreateArtifact })
    fireEvent.click(screen.getByRole('button', { name: '项目产物' }))
    await screen.findByRole('table', { name: '产物列表' })

    fireEvent.click(screen.getByRole('button', { name: '添加产物' }))
    const dialog = await screen.findByRole('dialog', { name: '添加产物' })
    // Type a title.
    const title = within(dialog).getByRole('textbox', { name: /标题/u })
    fireEvent.change(title, { target: { value: 'A new note' } })
    // Submit.
    fireEvent.click(within(dialog).getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onCreateArtifact).toHaveBeenCalledTimes(1))
    expect(onCreateArtifact).toHaveBeenCalledWith(expect.objectContaining({
      projectId: FIRST_PROJECT,
      kind: 'plan',
      title: 'A new note',
    }))
  })
})

describe('Dashboard Run Inspector Artifacts section (spec §11)', () => {
  function runDetailWithArtifacts(runId: string, artifacts: readonly ArtifactView[], finalReport?: ArtifactView): RunDetailView {
    const run = (fixtureSnapshot.runs!.runs ?? []).find(candidate => candidate.id === runId) ?? EXECUTING_RUN
    return {
      run,
      events: [
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
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(finalReport === undefined ? {} : { finalReport }),
    }
  }

  function renderInspectorDashboard(overrides: Partial<ComponentProps<typeof DashboardSurface>> = {}): void {
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

  async function openRunInspector(runId: string): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole('button', { name: '项目运行' }))
    const table = screen.getByRole('table', { name: '项目运行列表' })
    const run = (fixtureSnapshot.runs!.runs ?? []).find(candidate => candidate.id === runId)!
    const row = within(table).getByRole('row', { name: new RegExp(run.goal) })
    fireEvent.click(row)
    return screen.getByRole('complementary', { name: /运行详情/u })
  }

  /** The RunInspector's Artifacts section, located by its heading. */
  function artifactsSection(inspector: HTMLElement): HTMLElement {
    const heading = within(inspector).getByRole('heading', { name: '产物' })
    const section = heading.closest('section')
    if (section === null) throw new Error('artifacts section not found')
    return section
  }

  it('renders the run artifacts and the final report with localized section headers', async () => {
    const report = finalReportArtifact()
    const onLoadRunDetail = vi.fn(async (runId: string) =>
      runDetailWithArtifacts(runId, [artifact({ runId: SUCCEEDED_RUN.id }), report], report))
    const onGenerateReport = vi.fn(async () => ({}))
    renderInspectorDashboard({ onLoadRunDetail, onGenerateReport })

    const inspector = await openRunInspector(SUCCEEDED_RUN.id)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(SUCCEEDED_RUN.id))

    const section = artifactsSection(inspector)
    // The plan artifact shows its kind + title.
    expect(section.textContent).toContain('The plan')
    expect(section.textContent).toContain('计划')
    // The final report renders the localized section headers.
    expect(section.textContent).toContain('目标')
    expect(section.textContent).toContain('结果')
    expect(section.textContent).toContain('变更')
    expect(section.textContent).toContain('剩余风险')
    // The report body is present.
    expect(section.textContent).toContain('Implement the health-check endpoint.')
    // The Regenerate action is available for the final report.
    expect(within(section).getByRole('button', { name: '重新生成' })).toBeTruthy()
  })

  it('surfaces the report-unavailable marker with Regenerate for a terminal run without a report', async () => {
    // A terminal (succeeded) run whose detail has artifacts but no final report.
    const onLoadRunDetail = vi.fn(async (runId: string) =>
      runDetailWithArtifacts(runId, [artifact({ runId: SUCCEEDED_RUN.id })]))
    const onGenerateReport = vi.fn(async () => ({}))
    renderInspectorDashboard({ onLoadRunDetail, onGenerateReport })

    const inspector = await openRunInspector(SUCCEEDED_RUN.id)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(SUCCEEDED_RUN.id))

    const section = artifactsSection(inspector)
    expect(section.textContent).toContain('报告不可用')
    const regenerate = within(section).getByRole('button', { name: '重新生成' })
    fireEvent.click(regenerate)
    await waitFor(() => expect(onGenerateReport).toHaveBeenCalledTimes(1))
    expect(onGenerateReport).toHaveBeenCalledWith(SUCCEEDED_RUN.id)
  })

  it('renders the empty state for a run with no artifacts', async () => {
    const onLoadRunDetail = vi.fn(async (runId: string) => runDetailWithArtifacts(runId, []))
    renderInspectorDashboard({ onLoadRunDetail })

    const inspector = await openRunInspector(EXECUTING_RUN.id)
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(EXECUTING_RUN.id))

    const section = artifactsSection(inspector)
    expect(section.textContent).toContain('此运行没有产物。')
  })

  it('renders the final report with English section headers under the en locale', async () => {
    const report = finalReportArtifact()
    const onLoadRunDetail = vi.fn(async (runId: string) =>
      runDetailWithArtifacts(runId, [artifact({ runId: SUCCEEDED_RUN.id }), report], report))
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
          onLoadRunDetail={onLoadRunDetail}
          onGenerateReport={async () => ({})}
        />
      </DashboardI18nProvider>,
    )

    // Navigate to the run inspector (en labels).
    fireEvent.click(screen.getByRole('button', { name: 'Project Runs' }))
    const table = screen.getByRole('table', { name: 'Project Run list' })
    const run = (fixtureSnapshot.runs!.runs ?? []).find(candidate => candidate.id === SUCCEEDED_RUN.id)!
    const row = within(table).getByRole('row', { name: new RegExp(run.goal) })
    fireEvent.click(row)
    const inspector = await screen.findByRole('complementary', { name: /Run details/i })
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith(SUCCEEDED_RUN.id))

    // The Artifacts section heading + the localized §64 headers (en).
    const heading = within(inspector).getByRole('heading', { name: 'Artifacts' })
    const section = heading.closest('section')
    if (section === null) throw new Error('artifacts section not found')
    expect(section.textContent).toContain('Goal')
    expect(section.textContent).toContain('Outcome')
    expect(section.textContent).toContain('Changes')
    expect(section.textContent).toContain('Remaining risks')
    expect(section.textContent).toContain('Implement the health-check endpoint.')
    expect(within(section).getByRole('button', { name: 'Regenerate' })).toBeTruthy()
  })
})
