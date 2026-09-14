/** DSH Projects Phase 4 — task execution constants. */

/**
 * Default task concurrency per run. From Phase 5 every live task of a Git
 * project runs in its own worktree + branch (one writer per worktree), so
 * `maxConcurrentAgents > 1` is safe for Git projects; the default stays
 * serial (intent §7.2). Non-Git projects still share the working tree.
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

/**
 * Phase 10 (spec §4.3): policy-fallback staleness bound for a `running` task
 * when the session probe is not wired (or is inconclusive). A `running` task
 * whose `startedAt` is older than this is considered stale and is interrupted
 * on restart. Well above any single task turn (a turn is bounded by the
 * Harness session's own timeout), so a genuinely live task is never mistaken
 * for stale under the fallback.
 */
export const RECOVERY_STALE_MS = 30 * 60 * 1000

/** Timeout for one Git operation (worktree add/remove, commit, merge). */
export const GIT_OPERATION_TIMEOUT_MS = 30_000
