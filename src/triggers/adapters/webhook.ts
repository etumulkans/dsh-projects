/**
 * DSH Projects Phase 9 — the webhook trigger adapter (spec §5.5).
 *
 * Where feasible: the Cordis plugin's existing HTTP surface (not a new server)
 * maps a signed payload on `config.path` to a `TriggerEvent`. The `secretRef` is
 * resolved host-side (never returned to the browser). The `onEvent` validates
 * the payload structure (the internal abstraction only — no external webhook
 * provider SDKs, master spec §27). The HTTP receive is wired where the Cordis
 * surface exposes a receive hook; the `onEvent` path is real and testable via a
 * direct call.
 */

import type { TriggerAdapter, TriggerEvent } from '../types.ts'

export const webhookAdapter: TriggerAdapter = {
  type: 'webhook',
  onEvent(trigger, event): void {
    // The internal abstraction: validate the payload structure. The `secretRef`
    // is a ref (never a value) — the signature check is done host-side by the
    // HTTP receive hook (where available). The `sourceEventKey` is the payload's
    // stable id (or a hash of the signed payload when absent).
    if (event.sourceEventKey === '') {
      throw new Error('a webhook trigger event requires a non-empty sourceEventKey (the payload id)')
    }
    // The `data` must carry the webhook id (the {{webhook.id}} placeholder).
    if (event.data['webhook.id'] === undefined) {
      throw new Error('a webhook trigger event requires the webhook.id data field')
    }
  },
}
