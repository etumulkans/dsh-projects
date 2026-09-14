/**
 * DSH Projects Phase 9 — the tracker trigger adapter (spec §5.5).
 *
 * Wraps the existing `TaskSource` registry (no rewrite — the six existing
 * sources are consumed read-only). `poll` resolves the trigger's
 * `config.sourceKind`, calls `listIssuesByStates(config.readyStates)`, and
 * yields one `TriggerEvent` per issue in a ready state. It does NOT dispatch
 * agents (the old orchestrator path is unchanged) — it only yields events that
 * create runs.
 */

import type { TriggerAdapter, TriggerEvent } from '../types.ts'

export const trackerAdapter: TriggerAdapter = {
  type: 'tracker',
  async poll(trigger, ctx): Promise<readonly TriggerEvent[]> {
    const sourceKind = trigger.config.sourceKind
    const readyStates = trigger.config.readyStates
    if (typeof sourceKind !== 'string' || !Array.isArray(readyStates)) return []
    const source = ctx.sources.requireScoped(trigger.projectId, sourceKind)
    const issues = await source.listIssuesByStates(readyStates)
    return issues.map(issue => ({
      sourceEventKey: `${sourceKind}:${issue.nativeRef}:${issue.state.name}`,
      data: {
        'issue.key': issue.identifier,
        'issue.title': issue.title,
        'issue.state': issue.state.name,
        'issue.url': issue.url ?? '',
      },
    }))
  },
}
