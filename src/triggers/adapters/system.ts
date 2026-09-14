/**
 * DSH Projects Phase 9 — the system trigger adapter (spec §5.5).
 *
 * `onEvent` reacts to an internal Cordis event (`config.event`, e.g.
 * `dsh-projects/run/completed`) and yields a `TriggerEvent`
 * (`sourceEventKey` = the event id, `data` = the event name).
 */

import type { TriggerAdapter, TriggerEvent } from '../types.ts'

export const systemAdapter: TriggerAdapter = {
  type: 'system',
  onEvent(_trigger, event): void {
    if (event.sourceEventKey === '') {
      throw new Error('a system trigger event requires a non-empty sourceEventKey (the event id)')
    }
    if (event.data['system.event'] === undefined) {
      throw new Error('a system trigger event requires the system.event data field')
    }
  },
}
