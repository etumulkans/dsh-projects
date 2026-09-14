/**
 * DSH Projects Phase 9 — the trigger adapter registry (spec §5.5).
 *
 * One adapter per trigger type. The `tracker` + `schedule` adapters are
 * pull-based (`poll`); the `webhook`/`repository-event`/`pr-event`/`system`
 * adapters are push-based (`onEvent`).
 */

import { trackerAdapter } from './tracker.ts'
import { scheduleAdapter } from './schedule.ts'
import { webhookAdapter } from './webhook.ts'
import { prEventAdapter, repositoryEventAdapter } from './git-event.ts'
import { systemAdapter } from './system.ts'
import type { TriggerAdapter, TriggerType } from '../types.ts'

/** All the trigger adapters, keyed by type. */
export const TRIGGER_ADAPTERS: Record<TriggerType, TriggerAdapter> = {
  // `manual` has no adapter — it is the implicit runCreate path (never persisted).
  manual: { type: 'manual' },
  tracker: trackerAdapter,
  schedule: scheduleAdapter,
  webhook: webhookAdapter,
  'repository-event': repositoryEventAdapter,
  'pr-event': prEventAdapter,
  system: systemAdapter,
}

/** The pull-based adapters (the ones `pollDueTriggers` drives). */
export const PULL_ADAPTERS: readonly TriggerAdapter[] = [trackerAdapter, scheduleAdapter]

/** The push-based adapters (the ones `registerAdapter` wires to `ctx.on`). */
export const PUSH_ADAPTERS: readonly TriggerAdapter[] = [
  webhookAdapter,
  repositoryEventAdapter,
  prEventAdapter,
  systemAdapter,
]
