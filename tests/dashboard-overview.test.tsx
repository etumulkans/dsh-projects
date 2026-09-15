import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OverviewView, TriggerDetailView, UsageSummary } from '../src/client/Dashboard.tsx'
import { buildAttentionSummary } from '../src/client/attention.ts'
import { createDashboardTranslator } from '../src/client/i18n.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import type { TriggerView } from '../src/client/controller.ts'

const t = createDashboardTranslator('en')

describe('Phase 11 — Overview surface (spec §5.3)', () => {
  it('renders task health, active runs, usage, and recent activity from the snapshot', () => {
    const attention = buildAttentionSummary(fixtureSnapshot)
    const markup = renderToStaticMarkup(
      <OverviewView snapshot={fixtureSnapshot} attention={attention} onOpenRun={() => {}} t={t} />,
    )

    // Task health metrics.
    expect(markup).toContain('Task Health')
    expect(markup).toContain('>3<') // running
    expect(markup).toContain('>1<') // retrying / blocked

    // Active runs: the fixture has executing + paused (active) and succeeded (terminal).
    expect(markup).toContain('Active Runs')
    expect(markup).toContain('Implement health check endpoint for the local task source and add unit tests')
    expect(markup).toContain('Research Agent Teams experimental capabilities and produce an adapter layer plan')

    // Usage summary (runs carrying tokenUsage, including the succeeded one).
    expect(markup).toContain('Usage')
    expect(markup).toContain('Tokens')

    // Recent activity from runtime issues.
    expect(markup).toContain('Recent Activity')
  })

  it('shows the empty state when there are no active runs', () => {
    const baseRuns = fixtureSnapshot.runs!
    const snapshot = {
      ...fixtureSnapshot,
      runs: {
        ...(baseRuns.projectId !== undefined ? { projectId: baseRuns.projectId } : {}),
        runs: [],
        total: 0,
        ...(baseRuns.worker !== undefined ? { worker: baseRuns.worker } : {}),
      },
      runtime: { ...fixtureSnapshot.runtime, issues: [] },
    }
    const attention = buildAttentionSummary(snapshot)
    const markup = renderToStaticMarkup(
      <OverviewView snapshot={snapshot} attention={attention} onOpenRun={() => {}} t={t} />,
    )

    expect(markup).toContain('Active Runs')
    expect(markup).toContain('No active Runs.')
    expect(markup).toContain('Recent Activity')
    expect(markup).toContain('No recent activity.')
  })
})

describe('Phase 11 — Usage summary (spec §5.3)', () => {
  it('aggregates per-run token totals and lists each contributing run', () => {
    const markup = renderToStaticMarkup(<UsageSummary runs={fixtureSnapshot.runs!.runs} t={t} />)

    expect(markup).toContain('Tokens')
    // The executing run contributes its tokenUsage.total; the paused run has none.
    expect(markup).toContain('Implement health check endpoint for the local task source and add unit tests')
    // The paused run has no tokenUsage, so it is not listed.
    expect(markup).not.toContain('Research Agent Teams experimental capabilities and produce an adapter layer plan')
  })

  it('shows the empty state when no run carries token usage', () => {
    const markup = renderToStaticMarkup(<UsageSummary runs={[]} t={t} />)
    expect(markup).toContain('No usage recorded.')
  })
})

describe('Phase 11 — Trigger detail view (spec §5.3)', () => {
  const trigger: TriggerView = {
    id: 'trg-1',
    projectId: 'proj-1',
    type: 'schedule',
    enabled: true,
    config: { cron: '*/5 * * * *' },
    goalTemplate: 'Nightly reconciliation',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    nextRunAt: '2026-08-14T03:05:00.000Z',
    recentFires: [
      { firedAt: '2026-08-14T03:00:00.000Z', runId: 'run-2', sourceEventKey: 'evt-2' },
      { firedAt: '2026-08-14T02:55:00.000Z', runId: 'run-1', sourceEventKey: 'evt-1' },
    ],
  }

  it('shows the config, next run slot, and fire history', () => {
    const markup = renderToStaticMarkup(<TriggerDetailView trigger={trigger} t={t} />)

    expect(markup).toContain('Trigger detail')
    expect(markup).toContain('Next run')
    expect(markup).toContain('2026-08-14T03:05:00.000Z')
    expect(markup).toContain('Config')
    expect(markup).toContain('cron')
    expect(markup).toContain('*/5 * * * *')
    expect(markup).toContain('Recent fires')
    expect(markup).toContain('run-2')
    expect(markup).toContain('run-1')
  })

  it('shows the not-scheduled and no-fires states when the projections are absent', () => {
    const bare: TriggerView = {
      id: 'trg-2',
      projectId: 'proj-1',
      type: 'webhook',
      enabled: true,
      config: { path: '/hooks/test', secretRef: 'env:HOOK' },
      goalTemplate: 'Webhook run',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }
    const markup = renderToStaticMarkup(<TriggerDetailView trigger={bare} t={t} />)

    expect(markup).toContain('Not scheduled')
    expect(markup).toContain('No fires recorded.')
  })
})
