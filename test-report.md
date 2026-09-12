# Test Report — Phase 4: Task DAG + Team Execution

Test-stage artifact for the Phase 4 diff (build commit `009d9bc`, intent
`c7690b0`, spec `515422d`/correction `8773e22` — §12 test plan + §13
acceptance criteria). The merged branch is the verification target:
`etumulkans/dsh-projects` PR #2 merged 2026-09-12 (merge commit `13638b1`),
verified on local `main` @ `2c6b68b` (merge record + the two test-stage gap
tests, §3). Verified 2026-09-13.

## 1. Test inventory

| File | Cases | Scope (spec §12) |
| --- | --- | --- |
| `tests/task-state-machine.test.ts` (new) | 12 | full allowed-edge table + representative forbidden edges; idempotent re-entry rejection (a re-applied transition is a rejected no-op, never a silent re-run); terminal invariants (`succeeded`/`failed`/`canceled` accept nothing); `running→ready` budget edge; `failed→ready` only from `failed`; `version` bumps on every accepted transition (CAS); `completedAt`/`error`/`outputSummary` carry-over; `awaiting-review` unreachable in Phase 4 |
| `tests/task-scheduler.test.ts` (new) | 16 | `validateTaskGraph`: ok / cycle / unknown dependency / self-dependency (invalid graphs rejected, never persisted); `computeDependencyTransitions`: all-deps-succeeded → `ready`, any permanently failed dep → `blocked`, a retried dep that later succeeds → dependents re-readied, no-ops stay no-ops; `pickReadyTasks`: default concurrency 1 with `run.maxConcurrentAgents` override, retry backoff via injected `now` (generalized `failureRetryDelay`), deterministic pick order, empty when the limit is saturated |
| `tests/task-service.test.ts` (new) | 12 | in-memory domain + fake worker seam + injected clocks: materialization 1:1 from the active plan (deps resolved from plan positions, role/acceptance-criteria copied, `maxAttempts` default, `tasks.materialized` event); taskless plan is a no-op; `task.dagInvalid` persists zero rows; retirement on plan supersede (running tasks stopped) and on re-activation; first ready wave respects the concurrency limit; success path (summary + token usage persisted, `task.completed`); failure with retries (attempt bump, backoff elapses on the injected retry clock, re-ready, second attempt succeeds); exhausted attempts → `failed`, dead DAG → run `blocked` (guard: run must be `executing`); dependency recovery unblocks (`blocked → ready`); `taskRetry` happy + `task.retryNotAllowed` + `task.unknown`; run cancellation → all live tasks `canceled` + workers stopped, a stale worker result after cancel is a logged no-op; unavailable worker → tasks never leave `pending`/`ready`, `task.workerUnavailable` on actions, no fake identities; restart persistence (stop, new service on the same medium, state intact); `stop()` aborts the in-flight worker signal |
| `tests/task-adapters.test.ts` (new) | 18 | `LocalTaskWorker` against a fake `ctx.agents` (create/followup/whenIdle/flush/dispose mapping, report-tool result → `succeeded`, session-ended-without-report → `failed` result, usage accumulation only when the runtime reports it, abort → `failed`); `TeamTaskWorker` against a fake `TeamService` + fake agents (Lead spawn, per-task teammate spawn, assign/interrupt/dispose mapping); `UnavailableWorker` rejects every action with `task.workerUnavailable`; **import isolation** — a source-scan test asserting `agentTeams` appears only in `src/tasks/team-adapter.ts` and `subagents` in no file (invariant 1, enforced by test, not just review) |
| `tests/rpc-handler.test.ts` (task block) | 33 (file) | additive `taskRetry`: dispatch returns the task record; non-uuid / missing `taskId` → `bad-request` before dispatch; absent service → `bad-request`; `task.retryNotAllowed` and `task.unknown` (test stage, §3) mapped via `decodeDashboardError` with `{ taskId }`; `runDetail` includes `tasks` when the service is mounted and omits the property (absent, not empty) when it is not; snapshot runs summary carries `worker` kind + `taskCounts` |
| `tests/dashboard-tasks-interactions.test.tsx` (new, jsdom zh) | 5 | Tasks section renders mixed statuses from `runDetail`: zh status pills (已完成/运行中/失败/受阻/待调度), dependency labels (依赖：t1), the blocked row naming its failed dep (受阻于：t3), attempt counters (第 1/3 次), summary + error rows; `worker: 'local'` label (本地代理) + counts chip (任务 0/5 完成); retry button only on `failed`, calls `onTaskRetry(taskId)`, pending 重试中…, success notice + refresh; a rejected retry keeps the failed row with its error; empty task list renders the section's empty state; (test stage, §3) `worker: 'unavailable'` renders the zh banner 执行不可用：当前组合未挂载代理运行时; no fabricated data anywhere |
| `tests/run-storage-integration.test.ts` (task leg) | 4 (file) | coordinator leg extended on the real JSON backend: activating the plan materializes the task rows; a fake worker completes one task; after a real domain reopen the task statuses, task events, and run phase survive; the medium table set is exactly `['plans', 'run_events', 'runs', 'tasks']` with `dsh_projects` at format version 0; a second boot's `taskRetry` re-runs a failed task |

**Regression:** every existing suite re-ran green — Phase 3
(`coordinator-service` 16, `coordinator-policy` 5, `dashboard-coordinator-interactions` 7,
`runtime-coordinator` 1), Phase 2 (`plan-service` 14, `plan-state-machine` 10,
`dashboard-plans-interactions` 7), Phase 1 (`run-service` 11, `run-state-machine` 12),
and the shared suites (`orchestrator` 9, `scheduling` 3, `workflow-parser` 17, all
dashboard i18n/ux/render suites, `global-dashboard` 4, `workspace-manager` 3,
provider/source/timeline/path-safety suites). Unchanged files are untouched except
the additive edits listed in spec §11.

## 2. Acceptance criteria (spec §13)

1. **Materialization 1:1; taskless no-op; invalid DAG rejected with zero rows;
   supersede retires live tasks** — PASS. `task-service.test.ts` covers
   resolution from plan positions, the no-op, `task.dagInvalid` with zero rows
   persisted, and retirement (running task stopped) on supersede and
   re-activation; `task-scheduler.test.ts` covers the graph validation itself.
2. **DAG semantics hold end-to-end** — PASS. ready only when all dependencies
   succeeded; a permanently failed dependency blocks dependents; a retried
   dependency that later succeeds re-readies them; cycles/unknown refs rejected
   at validation; every transition idempotent (re-entry is a rejected no-op —
   `task-state-machine.test.ts` transition table).
3. **Execution behind the seam; state persists; retries bounded; run coupling**
   — PASS. `status`/`assignedAgentId`/`attempt` persist on the `tasks` table;
   retries respect `maxAttempts` with the generalized `failureRetryDelay`
   backoff (injected clock); exhaustion → terminal `failed`; a dead DAG blocks
   the run (retryable via the existing resume path — the run machine is
   unchanged); run cancellation cancels live tasks and stops their workers.
4. **Agent lifecycle inspectable; zh/en parity; no fabricated activity** —
   PASS. The inspector Tasks section renders per-task status/role/attempt/
   summary/error, the agent-identity tail, and token usage only when the
   runtime reports it; the snapshot carries `worker` kind + `taskCounts`;
   zh/en parity is compile-enforced through the locale table (the test-stage
   banner test asserts the zh string, §3).
5. **Honest degradation** — PASS. `UnavailableWorker` rejects every action with
   `task.workerUnavailable`; tasks never leave `pending`/`ready` and never
   carry fake agent identities; the UI shows the explicit banner instead of a
   fake execution state.
6. **Storage integration: tasks + events survive a real JSON reopen; medium
   table set; format v0** — PASS (`run-storage-integration.test.ts` task leg).
7. **Repo green** — PASS. `pnpm run typecheck` and `pnpm run build` clean;
   `pnpm vitest run --no-file-parallelism` green for every Phase 4 suite —
   full-suite result in §5.

## 3. Findings resolved in the test stage

- **`task.unknown` mapping case missing from the build diff** — spec §12
  requires `task.retryNotAllowed` *and* `task.unknown` mapped via
  `decodeDashboardError` with `{ taskId }`; the build asserted only
  `retryNotAllowed`. The test stage extended the `taskRetry` mapping test with
  the `task.unknown` leg (same structured mapping: `bad-request` +
  `dashboardCode: task.unknown` + `{ taskId }`). Committed in `2c6b68b`.
- **zh worker-unavailable banner case missing from the build diff** — spec §12
  requires the `worker: 'unavailable'` banner in zh; the build asserted only
  the `worker: 'local'` 本地代理 label. The test stage added a dedicated case
  rendering an unavailable composition and asserting the zh banner
  (执行不可用：当前组合未挂载代理运行时). Committed in `2c6b68b`.

Both gaps were coverage gaps in the test plan, not behavior changes: no source
file was modified, and both suites were already green at the build commit.

## 4. Deviations from the approved spec

None. (The Phase 2 `plan.contentInvalid` 14th-code deviation remains carried
and is unchanged.)

## 5. Verification commands

```
pnpm run typecheck   # clean
pnpm run build       # clean (dual tsdown, host + client)
pnpm vitest run --no-file-parallelism   # see note below
```

Full-suite note (sequential run, `--no-file-parallelism`): **295 passed /
3 failed of 298**. The 3 failures are exactly the documented pre-existing
macOS tmpdir environment failures in `tests/project-catalog.test.ts`
(`/var/folders` vs `/private/var/folders` realpath mismatch) — present before
Phase 4 and unrelated to it (maintain.md, known issues #1). Every Phase 4
suite is green: `task-state-machine` 12, `task-scheduler` 16,
`task-service` 12, `task-adapters` 18 (incl. the import-isolation source
scan), `rpc-handler` 33, `dashboard-tasks-interactions` 5,
`run-storage-integration` 4 (incl. the materialization leg).

Invariant check: `agentTeams` appears in exactly one source file
(`src/tasks/team-adapter.ts`) and `subagents` in none — enforced by the
`task-adapters` import-isolation test. `dsh_projects` stays format version 0;
the `tasks` table is created on domain open, so installed instances need no
migration.
