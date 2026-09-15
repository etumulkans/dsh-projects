/**
 * DSH Projects Phase 9 — the schedule trigger adapter (spec §5.5).
 *
 * The schedule abstraction. `poll` computes the current slot from `config` +
 * `trigger.createdAt` (the stable anchor) + the `clock`: for `everyMs`, the
 * slot index is `floor((now - anchor) / everyMs)`; for `cron`, the scheduled
 * slot timestamp. If `now >= nextSlot`, it yields one `TriggerEvent`
 * (`sourceEventKey` = the slot index or timestamp). The slot index is computed
 * from the stable anchor (`createdAt`), so a restart recomputes the same slot —
 * the idempotency dedupe (spec §4) then no-ops the already-fired slot.
 */

import type { TriggerAdapter, TriggerEvent } from '../types.ts'

/**
 * The pure slot computation (exported for tests). Returns the slot index (for
 * `everyMs`) or the slot timestamp (for `cron`) that is due, or `undefined`
 * when nothing is due. Deterministic under a fake clock.
 */
export function computeScheduleSlot(
  config: Record<string, unknown>,
  anchorIso: string,
  nowIso: string,
): number | undefined {
  const anchor = Date.parse(anchorIso)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(anchor) || !Number.isFinite(now)) return undefined
  const everyMs = config.everyMs
  if (typeof everyMs === 'number' && Number.isFinite(everyMs) && everyMs >= 1000) {
    // The slot index due: floor((now - anchor) / everyMs). A slot is due when
    // now >= anchor + n * everyMs (n >= 0). The dedupe key is the slot index.
    const elapsed = now - anchor
    if (elapsed < everyMs) return undefined
    return Math.floor(elapsed / everyMs)
  }
  const cron = config.cron
  if (typeof cron === 'string' && cron.trim() !== '') {
    // The cron slot: the next scheduled timestamp at or before `now`. The dedupe
    // key is the slot timestamp (a restart recomputes the same slot).
    const slot = nextCronSlot(cron, anchor, now)
    if (slot === undefined || slot > now) return undefined
    return slot
  }
  return undefined
}

/**
 * The minimal cron slot computation (spec §5.5). Supports the common
 * "star-slash-N" (every N minutes) and "M" (minute M of every hour) forms;
 * other forms fall back to the next minute boundary. The `timezone` config is
 * accepted but the slot is computed in the host's local time (the internal
 * abstraction only — no external cron provider).
 */
function nextCronSlot(cron: string, anchor: number, now: number): number | undefined {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const minuteField = fields[0]
  if (minuteField === undefined) return undefined
  // "star-slash-N" — every N minutes.
  const everyMatch = minuteField.match(/^\*\/(\d+)$/)
  if (everyMatch !== null) {
    const step = Number(everyMatch[1])
    if (Number.isFinite(step) && step >= 1) {
      const slotMs = step * 60_000
      const elapsed = now - anchor
      if (elapsed < slotMs) return undefined
      return anchor + Math.floor(elapsed / slotMs) * slotMs
    }
  }
  // `M` — minute M of every hour.
  const minuteMatch = minuteField.match(/^(\d+)$/)
  if (minuteMatch !== null) {
    const minute = Number(minuteMatch[1])
    if (Number.isFinite(minute) && minute >= 0 && minute <= 59) {
      const d = new Date(now)
      const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), minute, 0, 0).getTime()
      if (slot <= now && slot >= anchor) return slot
      // The slot for the previous hour (if it is the one due).
      const prev = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() - 1, minute, 0, 0).getTime()
      if (prev <= now && prev >= anchor) return prev
      return undefined
    }
  }
  return undefined
}

/**
 * The pure **next-run** projection (Phase 11 spec §5.4). Returns the ISO
 * timestamp of the *next* scheduled slot strictly after `now`, or `undefined`
 * when the config has no schedule (non-schedule triggers show "—"). This is a
 * read-only projection of `config` + the stable `createdAt` anchor + the clock
 * (it is **not** stored). Deterministic under a fake clock.
 *
 * - `everyMs`: `anchor + (floor((now - anchor) / everyMs) + 1) * everyMs`.
 * - `cron`: the next slot after `now` (the "star-slash-N" and "M" forms the
 *   poller supports).
 */
export function computeNextRunAt(
  config: Record<string, unknown>,
  anchorIso: string,
  nowIso: string,
): string | undefined {
  const anchor = Date.parse(anchorIso)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(anchor) || !Number.isFinite(now)) return undefined
  const everyMs = config.everyMs
  if (typeof everyMs === 'number' && Number.isFinite(everyMs) && everyMs >= 1000) {
    const nextIndex = Math.floor((now - anchor) / everyMs) + 1
    return new Date(anchor + nextIndex * everyMs).toISOString()
  }
  const cron = config.cron
  if (typeof cron === 'string' && cron.trim() !== '') {
    const slot = nextCronSlotAfter(cron, anchor, now)
    if (slot === undefined) return undefined
    return new Date(slot).toISOString()
  }
  return undefined
}

/**
 * The next cron slot **strictly after** `now` (the mirror of `nextCronSlot`,
 * which returns the slot at-or-before `now`). Supports the same two forms the
 * poller supports ("star-slash-N" and "M"); other forms return `undefined`.
 */
function nextCronSlotAfter(cron: string, anchor: number, now: number): number | undefined {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const minuteField = fields[0]
  if (minuteField === undefined) return undefined
  // "star-slash-N" — every N minutes.
  const everyMatch = minuteField.match(/^\*\/(\d+)$/)
  if (everyMatch !== null) {
    const step = Number(everyMatch[1])
    if (Number.isFinite(step) && step >= 1) {
      const slotMs = step * 60_000
      const next = anchor + (Math.floor((now - anchor) / slotMs) + 1) * slotMs
      return next > now ? next : undefined
    }
  }
  // `M` — minute M of every hour.
  const minuteMatch = minuteField.match(/^(\d+)$/)
  if (minuteMatch !== null) {
    const minute = Number(minuteMatch[1])
    if (Number.isFinite(minute) && minute >= 0 && minute <= 59) {
      const d = new Date(now)
      const currentHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), minute, 0, 0).getTime()
      if (currentHour > now) return currentHour
      const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, minute, 0, 0).getTime()
      return nextHour > now ? nextHour : undefined
    }
  }
  return undefined
}

export const scheduleAdapter: TriggerAdapter = {
  type: 'schedule',
  async poll(trigger, ctx): Promise<readonly TriggerEvent[]> {
    const nowIso = ctx.clock()
    const slot = computeScheduleSlot(trigger.config, trigger.createdAt, nowIso)
    if (slot === undefined) return []
    const slotIso = typeof slot === 'number' && slot > 1e12 ? new Date(slot).toISOString() : String(slot)
    return [{
      sourceEventKey: String(slot),
      data: { 'schedule.at': slotIso },
    }]
  },
}
