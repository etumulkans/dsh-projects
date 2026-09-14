/**
 * DSH Projects Phase 9 — the repository-event / pr-event trigger adapters
 * (spec §5.5).
 *
 * The minimal real path: `onEvent` reacts to the Git-integration event (the
 * existing `run.integration.*` / PR observation) and yields a `TriggerEvent`
 * (`sourceEventKey` = the PR number, `data` = the PR's number/title). No
 * external provider SDKs.
 */

import type { TriggerAdapter, TriggerEvent } from '../types.ts'

export const repositoryEventAdapter: TriggerAdapter = {
  type: 'repository-event',
  onEvent(_trigger, event): void {
    if (event.sourceEventKey === '') {
      throw new Error('a repository-event trigger event requires a non-empty sourceEventKey')
    }
  },
}

export const prEventAdapter: TriggerAdapter = {
  type: 'pr-event',
  onEvent(_trigger, event): void {
    // The PR number is the stable dedupe key.
    if (event.sourceEventKey === '') {
      throw new Error('a pr-event trigger event requires a non-empty sourceEventKey (the PR number)')
    }
    if (event.data['pr.number'] === undefined) {
      throw new Error('a pr-event trigger event requires the pr.number data field')
    }
  },
}
