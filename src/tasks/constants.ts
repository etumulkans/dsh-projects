/** DSH Projects Phase 4 — task execution constants. */

/**
 * Default task concurrency per run. Phase 4 tasks share the project's working
 * tree (per-task worktrees arrive in Phase 5), so the safe default is serial
 * execution (intent §7.2). A run may override via `maxConcurrentAgents`.
 */
export const DEFAULT_TASK_CONCURRENCY = 1

/** Upper bound for the per-run concurrency override. */
export const MAX_TASK_CONCURRENCY = 50

/** Retry budget assigned at materialization (spec §3.2). */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Cap for `failureRetryDelay` (10 s doubling: 10/20/40/80/160/300 s). */
export const MAX_RETRY_DELAY_MS = 300_000

/** Maximum length of a worker-reported task summary (persisted on success). */
export const MAX_SUMMARY_LENGTH = 1_000

/** Per-run event detail truncation (same as runs/plans services). */
export const EVENT_DETAIL_LIMIT = 200

/** Scheduler tick interval (retry backoff elapsing + belt-and-braces). */
export const TICK_INTERVAL_MS = 5_000

/** Upper bound of tasks materialized from one plan version. */
export const MAX_TASKS_PER_PLAN = 50
