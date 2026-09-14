# Test Report — Phase 10: Recovery + hardening

Test-stage artifact for the Phase 10 diff (build commit `c16af2d`,
intent `7f5594a`, spec `d55eecd` — §11 test plan + §12 acceptance
criteria). Verified on local `main` @ `c16af2d`, 2026-09-14.

## 1. Test inventory

| File | Cases | Scope (spec §11) |
| --- | --- | --- |
| `tests/recovery.test.ts` (new, node — no jsdom) | 9 | §11.1 the **restart→reconcile surface**. Boots the real storage stack (the `run-storage-integration.test.ts` pattern: genuine Cordis Context + JSON backend + DomainFacility) with a fake `ctx.agents` (`get` → `undefined` for a dead session id, an object for a live one) and a fake worker. (1) a stale `running` task (dead session, `attempt 1`/`maxAttempts 3`) under an `executing` Run is re-queued to `ready` after a close+reopen + `reconcileAfterRestart()`, with a `task.interrupted` event and a `run.recovered` event (`re-dispatched 1 interrupted task(s)`); (2) the same at `attempt 3`/`maxAttempts 3` fails the task with `error: 'interrupted: session lost on restart'`; (3) a task whose session is **live** is left untouched (no transition, no event); (4) a `running` task with **no** `assignedAgentId` (a torn write) is stale and re-queued; (5) the **policy fallback** (no `sessionAlive` hook) — a task older than `RECOVERY_STALE_MS` is re-queued, a recent one is left alone; (6) a `running` task under a **terminal** (`succeeded`) Run is never touched; (7) the **durable surface** (a pending approval + a trigger + a memory + an artifact + a plan) survives the restart intact (versions unchanged); (8) a **double** `reconcileAfterRestart()` is a no-op (no duplicate events, no double-transition, versions stable); (9) a **reconcile-vs-live race** — a stale task settled concurrently to `succeeded` by a live worker ends `succeeded` (the CAS makes the reconcile a no-op), no corruption. |
| `tests/concurrency.test.ts` (new, node) | 5 | §11.2 the **§57 stress surface** (fake ctx + fake worker, the `task-service.test.ts` pattern). (1) **task-state exactly-one-writer** — 8 concurrent `casTaskTransition` callers on one `ready` task: exactly one wins (`running`), the rest are no-ops, the version is consistent; (2) **run-phase exactly-one-writer** — 8 concurrent `transitionRun` callers with the same fresh `expectedVersion`: exactly one wins (`paused`), the 7 losers get `run.versionConflict`, the version advances by one; (3) **plan-activation stale-reject** — after a `draft→active` (revision stays 1), two concurrent `transitionPlan(..., 'superseded', {expectedRevision: 1})`: exactly one wins (revision → 2), the other gets `plan.revisionConflict` (proving the guard the intent assumed missing is present); (4) **approval-resolution exactly-one-writer** — 8 concurrent `resolveApproval` callers: exactly one wins, the 7 losers get `approval.invalidStatus` (the status check fires before the version check), plus a separate **version-guard** check (a still-`pending` approval whose version moved → `approval.staleVersion`); (5) **reconcile-vs-live race** (mirrors 11.1.9 at the concurrency layer) — a reconcile racing a live `beginExecution`/`settleResult` is safe. |
| `tests/run-storage-integration.test.ts` (extended) | 9 (8 + **1 new**) | §11.3 the **real storage stack**: a `running` task (attempt 1, a stale session id) under an `executing` Run survives a close+reopen **and** is reconciled — `reconcileAfterRestart()` re-queues it and the trailing `tick()` re-dispatches it to `running` attempt 2 (the recoverable path); a `task.interrupted` + a `run.recovered` event are present; a second reconcile is a no-op (the re-dispatched task has a new live session); the persisted task is `running` attempt 2. Ties the recovery surface to the genuine JSON storage stack. |
| `tests/task-service.test.ts` (extended) | 39 (32 + **7 new**) | §11.4 the **`reconcileAfterRestart` unit cases** (the existing fake ctx + fake worker fixture, no full storage stack). The `isStaleTask` matrix: (a) a `running` task with no `assignedAgentId` is stale (torn write); (b) the probe reports a **dead** session ⇒ stale (re-queued); (c) the probe reports a **live** session ⇒ left alone; (d) the **policy fallback** (no probe) — a task older than `RECOVERY_STALE_MS` is stale, a recent one is not. The `reconcileStaleTask` outcomes: (e) **re-queues** within the attempt budget (`running → ready`, `task.interrupted` appended); (f) **fails** at the attempt budget (`running → failed`, `error: 'interrupted: session lost on restart'`); (g) **leaves a live task alone** (no transition, no event). |

**Total: 638 tests — 635 passed / 3 failed** (the 3 are the documented
pre-existing environment failures, §4 — the 3 `project-catalog` macOS
`tmpdir()` symlink cases; in isolation `project-catalog` is exactly 3/6 and
`integration-strategy` is 7/7). **22 new Phase 10 tests** (9 in
`recovery.test.ts` + 5 in `concurrency.test.ts` + 1 added to
`run-storage-integration.test.ts` + 7 added to `task-service.test.ts`),
all green.

## 2. Acceptance criteria (spec §12) — verified

1. **Startup reconciliation exists and is wired** into the real boot path
   (after services open, before `runtime.start()`), driven through the
   single-authority transitions and CAS-guarded. → `recovery.test.ts` (the
   full storage-stack reconcile) + `run-storage-integration.test.ts` (the
   real JSON stack) + the `src/index.ts` wiring (the `sessionAlive` probe via
   `ctx.agents.get(SessionId(...))` + `await taskService.reconcileAfterRestart()`
   before `runtime.start()`, failure logged, never fatal).
2. **Stale tasks are recovered** — an orphaned `running` task is interrupted +
   re-queued (within budget) or failed (budget exhausted); a still-alive task is
   left untouched; a no-session task is stale. → `recovery.test.ts` (1–4) +
   `task-service.test.ts` (the `isStaleTask` matrix + the `reconcileStaleTask`
   re-queue/fail/leave-alone outcomes).
3. **Stale Runs are re-driven** — a non-terminal Run continues (re-queued tasks
   re-dispatch, or the dead-DAG block applies); terminal Runs are never touched.
   → `recovery.test.ts` (1, 6) + `run-storage-integration.test.ts` (the
   re-dispatch to `running` attempt 2).
4. **Pending approvals survive** (or are expired when the owning Run goes
   terminal); the durable surface (catalog/plans/memory/artifacts/triggers) is
   proven restart-safe. → `recovery.test.ts` (7) + `run-storage-integration.test.ts`.
5. **The §57 guards are verified** — task-state / run-phase / plan-activation /
   approval-resolution hold exactly-one-writer under stress; the plan-activation
   stale-reject is proven. → `concurrency.test.ts` (1–4).
6. **Reconciliation is idempotent and race-safe** — a double reconcile is a
   no-op; a reconcile racing a live transition is safe. → `recovery.test.ts`
   (8–9) + `concurrency.test.ts` (5).
7. **Security review recorded** (credentials / untrusted content /
   filesystem+Git safety / storage), `dsh_projects` stays at format version 0
   (two additive event types only). → spec §9 (recorded in the spec); the diff
   adds exactly two run event types (`task.interrupted`, `run.recovered`) — no
   new table, no new record field, no migration.
8. **The repo stays green:** `pnpm run typecheck` (exit 0), `pnpm run build`
   (exit 0 — client 491.86 kB / host 460.59 kB), full `pnpm vitest run`
   (635/3 of 638, the 3 modulo the documented pre-existing environment
   failures, §4).

## 3. Test-stage fixes (made while verifying)

No production-code gaps were found — the Phase 10 build shipped the full
reconciliation surface and the spec's test plan was met as written. The fixes
below were **test-side** (making the new suites pass under the strict compiler
flags and the real transition semantics):

- **`tests/concurrency.test.ts`** — the `run-phase` case initially passed a
  stale `expectedVersion` (the `createRun` record's version 1) to all 8
  callers, so all 8 were rejected. Fixed to read the **fresh** version from
  `domain().table('runs').get(runId)` (createRun → planning → executing had
  bumped it to 3). The `plan-activation` case initially asserted a
  `plan.revisionConflict` after a `draft→active`, but that transition does not
  bump the revision (only `superseded`/`completed` do); fixed to activate
  first (revision stays 1) and then race two `superseded` transitions on
  `expectedRevision: 1`. The `approval` case initially expected the 7 losers to
  get `approval.staleVersion`, but `resolveApproval` checks the status
  (`!== 'pending'` → `approval.invalidStatus`) **before** the version check;
  fixed to assert `approval.invalidStatus` for the losers and added a separate
  version-guard sub-check (a still-`pending` approval whose version moved →
  `approval.staleVersion`).
- **`tests/recovery.test.ts`** — the durable-surface seed used an invalid
  `MemoryKind` (`'fact'` → `'finding'`) and a `RunPlanRecord` missing
  `projectId`/`assumptions`/`successCriteria` (and carrying a non-existent
  `updatedAt`); fixed to the exact record shapes.
- **`tests/task-service.test.ts`** — three `reconcileStaleTask` re-queue cases
  asserted the task ends `ready`, but the default `heldWorker()` re-dispatches
  the re-queued task on the trailing `tick()` (to `running` attempt 2); fixed
  those three to use `UnavailableWorker()` so the re-queue is observable. The
  `isStaleTask` dead-session case had an **inverted probe** (`id => id !==
  'dsh-task-live'` reported the dead session as alive); fixed to
  `id => id === 'dsh-task-live'`.
- **Type errors under `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`**
  (all in the new test files, fixed for the §12.8 typecheck gate): the
  `concurrency.test.ts` fresh-version read narrowed with a `toBeDefined()`
  assertion + a non-null assertion (the `TransitionRunOptions.expectedVersion`
  is `number`, not `number | undefined`).

## 4. Known pre-existing failures (carried, documented)

`tests/project-catalog.test.ts` — 3 of 6 cases fail on this host because
`tmpdir()` yields `/var/folders/…` while the catalog canonicalizes paths to
`/private/var/folders/…` (macOS symlink). Present since Phase 3 (baseline then
295/3 of 298; Phase 5 336/3 of 339; Phase 6 425/3 of 428; Phase 7 489/3 of
492; Phase 8 547/3 of 550; Phase 9 611/5 of 616 — the 3 tmpdir cases plus
under-load flakes). The fix-vs-document decision is open in `maintain.md`.
Unchanged by Phase 10 (all 22 new Phase 10 tests pass; `project-catalog` is
exactly 3/6 in isolation).

`tests/integration-strategy.test.ts` — the git-worktree cases are flaky
**under full-suite load** (temp-dir / worktree contention); they pass 7/7 in
isolation. Not introduced by Phase 10 (the Phase 10 diff does not touch the
merge strategy).
