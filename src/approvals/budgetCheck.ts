/** Pure budget check (master spec §30, spec §5.2). No I/O, exported for tests. */

import type { RunBudget } from '../runs/types.ts'

export interface BudgetCheckResult {
  /** The budget key that crossed a threshold. */
  readonly key: string
  /** usage / limit. */
  readonly ratio: number
  /** ratio >= 0.8 (and the key has not warned yet — the caller dedups via `warned`). */
  readonly warning: boolean
  /** ratio >= 1. */
  readonly exceeded: boolean
  readonly usage: number
  readonly limit: number
}

/**
 * Check one budget key against current usage (spec §5.2).
 *
 * - **Unset = unlimited:** the key absent from `budget` (or `budget` itself
 *   absent) → `undefined` (no check, no event).
 * - **Warning:** `ratio >= 0.8` → `warning: true` (the caller appends the key
 *   to `run.budgetWarnings` and emits `run.budget.warning`, once per key per
 *   run — the `warned` array is the dedup).
 * - **Exceeded:** `ratio >= 1` → `exceeded: true` (the caller applies the
 *   per-key action, §5.3, and emits `run.budget.exceeded`).
 *
 * A key with `limit <= 0` is treated as unset (a zero/negative limit would
 * make every usage "exceeded"; the schema forbids it, but the helper is
 * defensive).
 */
export function checkBudget(
  budget: RunBudget | undefined,
  usage: number,
  key: string,
  warned: readonly string[],
): BudgetCheckResult | undefined {
  const limit = budget === undefined ? undefined : (budget as Record<string, number | undefined>)[key]
  if (limit === undefined || limit <= 0) return undefined
  const ratio = usage / limit
  if (ratio < 0.8) return undefined
  return {
    key,
    ratio,
    warning: ratio >= 0.8 && !warned.includes(key),
    exceeded: ratio >= 1,
    usage,
    limit,
  }
}
