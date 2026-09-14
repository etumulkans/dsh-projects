# Maintenance Log — DSH Projects

## Cycle 9 (post v0.16.0 deploy) — 2026-09-14

**Status: no incidents.** Phase 10 (Recovery + hardening) released as
v0.16.0 (release commit `8012563`, build `c16af2d`, test report `483c3d7`,
spec `d55eecd`, intent `7f5594a`). Shipped on local `main` and **pushed to
`origin/main`** this cycle via **PR #3** (`dsh-projects-phase-10` → `main`,
merge commit `e82a390`); `main` is in sync with `origin/main` (0/0). A release
marker branch `dsh-projects-phase-10` (at `483c3d7`) was created and pushed for
consistency with the Phase 3/4/5/6/7/8/9 markers.

### Post-deploy verification

- `pnpm run typecheck` — clean (exit 0)
- `pnpm run build` — clean (dual tsdown: client 491.86 kB / host 460.59 kB —
  the host grew ~4.6 kB from the reconciliation pass + the `SessionId` import)
- `pnpm exec vitest run` — 635 passed / 3 failed (638 total); the 3 failures
  are the pre-existing, documented environment failures — 3 macOS tmpdir cases
  in `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
  realpath mismatch, present since Phase 3) + up to 2 `integration-strategy`
  git-worktree flakes under full-suite load (they pass 7/7 in isolation;
  `project-catalog` is exactly 3/6 in isolation). All 22 new Phase 10 tests are
  green (see `test-report.md`): recovery (9), concurrency (5),
  run-storage-integration (9, +1), task-service (39, +7).
- Working tree clean; `dsh_projects` storage domain remains at format version
  0 (Phase 10 is additive — two run event types `task.interrupted` /
  `run.recovered`; no new table, no new record field, no migration needed for
  installed instances).
- Invariant checks: the reconciliation pass is driven through the
  single-authority transitions (`casTaskTransition` + the existing `tick()`
  re-dispatch) — no direct phase writes, so the scheduler stays the single
  authority (master spec §58); a stale `running` task is interrupted +
  re-queued within the attempt budget or failed when exhausted, a live session
  is left untouched (§54 "do not blindly restart"), and terminal Runs are never
  touched. The four §57-critical mutations (task-state / run-phase /
  plan-activation / approval-resolution) were already compare-and-set guarded;
  Phase 10 **verifies** them under stress (exactly-one-writer, plan-activation
  stale-reject, reconcile-vs-live race) — it does not add the guards.

### Test-stage findings (fixed during verification, recorded in test-report §3)

No production-code gaps were found — the Phase 10 build shipped the full
reconciliation surface and the spec's test plan was met as written. The fixes
were **test-side only**:

1. **`concurrency.test.ts` fresh-version reads** — the run-phase case initially
   passed a stale `expectedVersion` (the `createRun` record's version 1) to all
   8 callers, so all 8 were rejected; fixed to read the fresh version from
   `domain().table('runs').get(runId)`. The plan-activation case initially
   asserted a `plan.revisionConflict` after a `draft→active`, but that
   transition does not bump the revision (only `superseded`/`completed` do);
   fixed to activate first (revision stays 1) and then race two `superseded`
   transitions on `expectedRevision: 1`.
2. **`concurrency.test.ts` approval loser codes** — the 7 concurrent
   `resolveApproval` losers get `approval.invalidStatus` (the status check
   `!== 'pending'` fires **before** the version check), not
   `approval.staleVersion`; fixed the assertion and added a separate
   version-guard sub-check (a still-`pending` approval whose version moved →
   `approval.staleVersion`).
3. **`task-service.test.ts` re-queue observability** — three
   `reconcileStaleTask` re-queue cases asserted the task ends `ready`, but the
   default `heldWorker()` re-dispatches the re-queued task on the trailing
   `tick()` (to `running` attempt 2); fixed those three to use
   `UnavailableWorker()` so the re-queue is observable. The `isStaleTask`
   dead-session case had an **inverted probe** (`id => id !== 'dsh-task-live'`
   reported the dead session as alive); fixed to `id => id === 'dsh-task-live'`.
4. **`recovery.test.ts` record shapes** — the durable-surface seed used an
   invalid `MemoryKind` (`'fact'` → `'finding'`) and a `RunPlanRecord` missing
   `projectId`/`assumptions`/`successCriteria` (and carrying a non-existent
   `updatedAt`); fixed to the exact record shapes.
5. **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** — the new test
   files needed tightening for the §12.8 typecheck gate: the
   `concurrency.test.ts` fresh-version read narrowed with a `toBeDefined()`
   assertion + a non-null assertion (the `TransitionRunOptions.expectedVersion`
   is `number`, not `number | undefined`).

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 10 commit; not a regression.
2. **`integration-strategy.test.ts` flaky under full-suite load** — the
   git-worktree cases intermittently fail when the whole suite runs
   concurrently (temp-dir / worktree contention); they pass 7/7 in isolation
   and in the clean full-suite run that produced the §1 numbers. Not introduced
   by Phase 10 (the Phase 10 diff does not touch the merge strategy).
3. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080 still
   serves a pre-Phase-10 build; Phase 10 is host-side (no new UI surface — the
   Run detail / event timeline already renders the two new run events
   `task.interrupted` / `run.recovered`), so the only visible change after a
   plugin reinstall/restart against this checkout's v0.16.0 build is the
   recovery behavior on restart.

### Follow-ups (next intent cycle)

- Reinstall/restart the GUI plugin against the v0.16.0 build so the running
  dashboard runs the Phase 10 recovery path (host-side; no new UI surface).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Phase 11 scope (UI Polish, per the master spec Phases 0–12): to be drafted as
  the next `intent.md` when this maintain stage closes. Phase 12 (optional
  Remote Worker Provider) follows.

## Cycle 8 (post v0.15.0 deploy) — 2026-09-14

**Status: no incidents.** Phase 9 (Trigger generalization) released as
v0.15.0 (release commit `9f81336`, build `9d95463`, test report `f4a649c`,
spec `f9a1ee1`, intent `0a0b648`). Shipped on local `main` and **pushed to
`origin/main`** this cycle (`1da2ac0..9f81336` — the four Phase 9 commits:
intent → spec → Build → test, now all on origin; `main` is in sync with
`origin/main`, 0/0). A release marker branch `dsh-projects-phase-9` (at
`9f81336`) was created and pushed for consistency with the Phase 3/4/5/6/7/8
markers.

### Post-deploy verification

- `pnpm run typecheck` — clean (exit 0)
- `pnpm run build` — clean (dual tsdown: client 491.86 kB / host 455.99 kB)
- `pnpm exec vitest run` — 611 passed / 5 failed (616 total); the 5 are the
  pre-existing, documented environment/load failures — 3 macOS tmpdir cases in
  `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
  realpath mismatch, present since Phase 3) + up to 2 `integration-strategy`
  git-worktree flakes under full-suite load (they pass 7/7 in isolation;
  `project-catalog` is exactly 3/6 in isolation). All 57 new Phase 9 tests are
  green (see `test-report.md`): trigger-service (15), trigger-fire (9),
  trigger-adapters (14), client-triggers-isolation (1), dashboard-automations
  (12, +2), rpc-handler (72, +5), run-storage-integration (8, +1).
- Working tree clean; `dsh_projects` storage domain remains at format version
  0 (Phase 9 is additive — two tables `project_triggers` + `trigger_fires`, one
  run event type `trigger.fired`, plus the `dsh-projects/trigger/fired` domain
  event; no migration needed for installed instances).
- Invariant checks: the new client-isolation scan
  (`tests/client-triggers-isolation.test.ts`) proves `src/client/**` never
  imports the node-side trigger modules — the client carries its own mirror
  types in `controller.ts` (the `approvalMode` mirror is now the
  `ClientApprovalMode` union, wire-validated against `CLIENT_APPROVAL_MODES`)
  and talks to the services only through the typed `DashboardDataPort`;
  `DashboardSnapshot.version` stays 2 (triggers are on-demand `triggerList`
  RPC data, not snapshot projections).

### Test-stage findings (fixed during verification, recorded in test-report §3)

1. **`rpc-handler` §10.4 gap** — the Phase 9 build covered the happy-path
   dispatch + shape validation but not the structured failure surface. Added 5
   cases: `triggerCreate` `invalidCandidate` + `containsSecrets`;
   `triggerUpdate` `unknown` + `invalidCandidate`; `triggerSetEnabled`
   `unknown`; `triggerDelete` `unknown`; `triggerFire` `unknown`/`disabled`/
   `goalEmpty` — each round-tripping its `dashboardCode` + `params` through
   `decodeDashboardError` (67 → 72 cases).
2. **Approval-policy UI gap (spec §8.1/§10.5/§11.5)** — the Phase 9 build
   shipped the Automations tab without the spec-required **approval policy**:
   the `approvalMode` data existed in the record but the UI never rendered or
   set it. Added the **approval-mode select** to the Add trigger dialog
   (dispatched in `triggerCreate`) + the **Approval policy** label to each
   trigger row (the mode label, or the "use default" marker); tightened the
   client `approvalMode` mirror to `ClientApprovalMode` so the dynamic
   `t(`mode.${…}`)` label typechecks. **Deferred to Phase 11** (spec §12 "no
   full Automations page polish"): the `next-run` (`nextRunAt`) column and the
   trigger **detail view** — the working tab ships without them.
3. **`dashboard-automations` §10.5 gap** — added 2 cases for the new
   approval-policy surface: the row renders the approval policy (mode label vs
   the "use default" marker) and the Add dialog dispatches `triggerCreate` with
   a chosen approval mode (10 → 12 cases).
4. **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** — Phase 9 code
   needed tightening for the §11.7 typecheck gate: the dialog `approvalMode`
   state is `ClientApprovalMode | ''` (matching the Phase 7 run pattern) with
   the submit value cast to `ClientApprovalMode`; the wire validator casts the
   `unknown` to `string` before `includes`; the test `trigger()` helper spreads
   a conditional `approvalMode` (no `undefined` under
   `exactOptionalPropertyTypes`).

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 9 commit; not a regression.
2. **`integration-strategy.test.ts` flaky under full-suite load** — the
   git-worktree cases intermittently fail when the whole suite runs
   concurrently (temp-dir / worktree contention); they pass 7/7 in isolation
   and in the clean full-suite run that produced the §1 numbers. Not
   introduced by Phase 9 (the Phase 9 diff does not touch the merge strategy).
3. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080
   still serves a pre-Phase-9 build; the Phase 9 UI (the Automations tab with
   the trigger list + approval policy, enable/disable + Run now, the Add trigger
   dialog with the approval-mode select) is only visible after the plugin is
   reinstalled/restarted against this checkout's v0.15.0 build output.

### Follow-ups (next intent cycle)

- Reinstall/restart the GUI plugin against the v0.15.0 build so the running
  dashboard serves the Phase 9 UI (the Automations tab, the approval-policy
  surface, the Add trigger dialog).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Phase 10 scope (Recovery + Hardening, per the master spec Phases 0–12): to be
  drafted as the next `intent.md` when this maintain stage closes.

## Cycle 7 (post v0.14.0 deploy) — 2026-09-14

**Status: no incidents.** Phase 8 (Artifacts + final report) released as
v0.14.0 (release commit `758e223`, build `504a2fb`, test report `e454d7f`,
spec `87d2591`, intent `15a8653`). Shipped on local `main` and **pushed to
`origin/main`** this cycle (unlike Cycle 6's local-only work — `main` is now
in sync with `origin/main`, 0/0). A release marker branch
`dsh-projects-phase-8` (at `758e223`) was created and pushed for consistency
with the Phase 3/4/5/6/7 markers.

### Post-deploy verification

- `pnpm run typecheck` — clean (exit 0)
- `pnpm run build` — clean (dual tsdown: client 462.25 kB / host 428.55 kB)
- `pnpm exec vitest run` — 547 passed / 3 failed (550 total); the 3 failures
  are the pre-existing, documented macOS tmpdir environment failures in
  `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
  realpath mismatch), present since Phase 3 and unrelated to Phase 8. All 58
  new Phase 8 tests are green (see `test-report.md`): artifact-service (20),
  final-report (16), client-artifacts-isolation (1), dashboard-artifacts (9),
  rpc-handler (58, +10), run-storage-integration (7, +1), task-service (32,
  +1).
- Working tree clean; `dsh_projects` storage domain remains at format version
  0 (Phase 8 is additive — one `project_artifacts` table, two run event types
  `artifact.created`/`run.report.failed`; no migration needed for installed
  instances).
- Invariant checks: the new client-isolation scan
  (`tests/client-artifacts-isolation.test.ts`) proves `src/client/**` never
  imports the node-side artifact modules — the client carries its own mirror
  types in `controller.ts` and talks to the services only through the typed
  `DashboardDataPort`; `DashboardSnapshot.version` stays 2 (artifacts are
  on-demand `runDetail`/`artifactList` RPC data, not snapshot projections).

### Test-stage findings (fixed during verification, recorded in test-report §3)

1. **`rpc-handler` §11.4 gap** — the Phase 8 build covered the happy-path
   dispatch + shape validation but not the structured failure surface. Added
   the five §5.3 service rejections (`invalidCandidate`/`contentTooLarge`/
   `missingUrl`/`kindReserved`/`containsSecrets`) round-tripping their
   `dashboardCode` + `params` through `decodeDashboardError`, the three
   not-mounted absent-service failures, and the on-demand
   `runUnknown`/`reportFailed` (48 → 58 cases).
2. **`run-storage-integration` §11.6 gap** — the build asserted the artifact
   row survives reopen but not the `artifact.created` run events; extended the
   reopen case to assert the two events also survive (6 → 7 cases).
3. **`final-report` §11.2 gap** — the build covered the success path but not
   the failure contract; added the failure case (a generation failure → a warn
   log + the `run.report.failed` event + no artifact, never thrown, the run
   still terminal) (15 → 16 cases).
4. **`dashboard-artifacts` §11.5 "zh + en" gap** — the build covered the
   inspector in zh only; added the en-locale inspector case (the final-report
   renders with the English §64 headers + Regenerate) (8 → 9 cases).
5. **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** — Phase 8 test
   files needed tightening for the §12.6 typecheck gate: `artifact-service` +
   `final-report` (`.entries()` yields `unknown` — cast on push),
   `final-report` (`makeTask` gains `version: 1`; the "no fabricated data" case
   builds a `ProjectRunRecord` without `resultSummary` inline rather than a
   `delete` cast).

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 8 commit; not a regression.
2. **`integration-strategy.test.ts` flaky under full-suite load** — the
   git-worktree cases intermittently fail when the whole suite runs
   concurrently (temp-dir / worktree contention); they pass 7/7 in isolation
   and in the clean full-suite run that produced the §1 numbers. Not
   introduced by Phase 8 (the Phase 8 diff does not touch the merge strategy).
3. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080
   still serves a pre-Phase-8 build; the Phase 8 UI (the project Artifacts tab,
   the RunInspector Artifacts section with the readable final-report + Regenerate,
   the Add artifact dialog) is only visible after the plugin is
   reinstalled/restarted against this checkout's v0.14.0 build output.

### Follow-ups (next intent cycle)

- Reinstall/restart the GUI plugin against the v0.14.0 build so the running
  dashboard serves the Phase 8 UI (the Artifacts tab, the RunInspector
  Artifacts section, the Add artifact dialog).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Phase 9 scope: to be drafted as the next `intent.md` when this maintain
  stage closes.

## Cycle 6 (post v0.13.0 deploy) — 2026-09-14

**Status: no incidents.** Phase 7 (Approvals + budgets) released as v0.13.0
(release commit `00188da`, build `7c6db58`, test report `73dc5c7`, spec
`321821d`, intent `d30a7da`). Shipped directly on local `main` with no fork
PR (the user drove the loop gate-by-gate in-session; `main` is now 23
commits ahead of `origin/main`). A release marker branch
`dsh-projects-phase-7` (at `00188da`) is created for consistency with the
Phase 3/4/5/6 markers.

### Post-deploy verification

- `pnpm run typecheck` — clean (exit 0)
- `pnpm run build` — clean (dual tsdown: client 427.93 kB / host 407.55 kB)
- `pnpm exec vitest run` — 489 passed / 3 failed (492 total); the 3 failures
  are the pre-existing, documented macOS tmpdir environment failures in
  `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
  realpath mismatch), present since Phase 3 and unrelated to Phase 7. All 64
  new Phase 7 tests are green (see `test-report.md`): approval-service (21),
  budget-enforcement (15), client-approvals-isolation (1),
  dashboard-approvals (9), task-service (31, +7 merge-gate cases),
  plan-service (16, +2), rpc-handler (48, +8), run-storage-integration (6,
  +1), run-state-machine (12, the two additive edges).
- Working tree clean; `dsh_projects` storage domain remains at format version
  0 (Phase 7 is additive — one `project_approvals` table, four run fields
  `approvalMode`/`budget`/`budgetWarnings` + the merge-gate state, three run
  event types `run.approval.requested`/`.resolved`/`.expired`, plus the
  `run.budget.warning`/`.exceeded` events; no migration needed for installed
  instances).
- Invariant checks: the new client-isolation scan
  (`tests/client-approvals-isolation.test.ts`) proves `src/client/**` never
  imports the node-side approval/budget modules — the client carries its own
  mirror types and talks to the services only through the typed
  `DashboardDataPort`; the task-adapters import-isolation scan still passes;
  the existing plan approve/reject buttons are unchanged (the Phase 7
  Approvals section is additive, a separate section in the RunInspector).

### Test-stage findings (fixed during verification, recorded in test-report §3)

1. **`run-state-machine` transition table** — the hardcoded full-table test
   predated the two additive Phase 7 edges; updated `awaiting_approval` to
   include `integrating` (an approved merge resumes directly into the
   integration step) and `executing` to include `awaiting_approval` (the
   merge gate).
2. **`approval-service.listApprovals` determinism** — the sort tiebroke
   same-millisecond `requestedAt` on the random `id`, making "newest first"
   non-deterministic for back-to-back requests (a full-suite flake). Now
   reverses the insertion-ordered rows before the stable sort, so same-tick
   records list in true creation order (latest created first) independent of
   the id.
3. **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** — three test
   files needed tightening for the §10.6 typecheck gate: `approval-service`
   (`pendingFor(…)?.id`, `onResolved[1]?.status`), `rpc-handler`
   (`fakeRunService` gains the `setRunBudget` seam), `task-service` (capture
   `overrides.budget` in a local const so the `update` closure keeps the
   narrowed `RunBudget`).

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 7 commit; not a regression.
2. **`integration-strategy.test.ts` flaky under full-suite load** — the
   git-worktree cases intermittently fail when the whole suite runs
   concurrently (temp-dir / worktree contention); they pass 7/7 in isolation
   and in the clean full-suite run that produced the §1 numbers. Not
   introduced by Phase 7 (the Phase 7 diff does not touch the merge
   strategy).
3. **Phase 7 work is local-only** — `main` is 23 commits ahead of
   `origin/main`; no fork PR was opened this cycle. `dsh-projects-phase-7`
   (at `00188da`) is the release marker.
4. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080
   still serves a pre-Phase-7 build; the Phase 7 UI (the Approvals section,
   the Budget panel, the New Run dialog's mode + budget fields) is only
   visible after the plugin is reinstalled/restarted against this checkout's
   v0.13.0 build output.

### Follow-ups (next intent cycle)

- Reinstall/restart the GUI plugin against the v0.13.0 build so the running
  dashboard serves the Phase 7 UI (the Approvals section with Approve/Reject,
  the Budget panel with usage + warning markers, the New Run dialog's
  approval-mode select + nine budget fields).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Optionally push `main` / open a fork PR for the Phase 5+6+7 work (23
  commits ahead of `origin/main`) so it lands via review; the in-session gate
  approval substituted for it this cycle.
- Phase 8 scope: to be drafted as the next `intent.md` when this maintain
  loop hands back to intent (Phase 7 spec §14 non-goals: no approval
  notifications/webhooks, no `maxCost` enforcement site, no per-task budget
  overrides, no approval audit trail export).

## Cycle 5 (post v0.12.0 deploy) — 2026-09-14

**Status: no incidents.** Phase 6 (Project Memory) released as v0.12.0
(release commit `fccfaba`, build `ef5ed66`, test report `c95774f`, spec
`3a03aab`, intent `a282a66`). Shipped directly on local `main` with no fork
PR (the user drove the loop gate-by-gate in-session; `main` is now 16
commits ahead of `origin/main`). A release marker branch
`dsh-projects-phase-6` (at `fccfaba`) is created for consistency with the
Phase 3/4/5 markers.

**Session-interruption note (non-incident):** the session driving the Build
stage was interrupted mid-step-7 (UI) and resumed later. On resume the
uncommitted UI work (locales, controller port, Memory tab, styles) was
re-verified: one import fix (`CLIENT_MEMORY_KINDS` is a value, not a type),
then `tsc` clean, the new `dashboard-memory` suite green (10/10), step 8
wiring, and the full suite. No work was lost.

### Post-deploy verification

- `pnpm run typecheck` — clean
- `pnpm run build` — clean (dual tsdown: client 404.97 kB / host 378.10 kB)
- `pnpm exec vitest run` — 425 passed / 3 failed (428 total); the 3 failures
  are the pre-existing, documented macOS tmpdir environment failures in
  `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
  realpath mismatch), present since Phase 3 and unrelated to Phase 6. All 89
  new Phase 6 tests are green (see `test-report.md`): memory-retrieval (23),
  memory-service (39), task-adapters (22, +4), coordinator-service (18, +2),
  task-service (24, +4, incl. the Run #1 → Run #2 end-to-end), rpc-handler
  (40, +6), dashboard-memory (10), client-memory-isolation (1),
  run-storage-integration (5, table set now `['memory', 'plans',
  'run_events', 'runs', 'tasks']`).
- Working tree clean; `dsh_projects` storage domain remains at format version
  0 (Phase 6 is additive — one `memory` table, two run event types
  `run.memory.distilled` / `run.memory.distillation.failed`, no migration
  needed for installed instances).
- Invariant checks: the new client-isolation scan
  (`tests/client-memory-isolation.test.ts`) proves `src/client/**` never
  imports `src/memory/**` — the client carries its own mirror types
  (`CLIENT_MEMORY_KINDS` & friends in `controller.ts`) and talks to the
  service only through the typed `DashboardDataPort`; the task-adapters
  import-isolation scan still passes; distillation stays fire-and-forget
  (never thrown into the pipeline — `task-service` hook-throw case).

### Test-stage findings (fixed during the build, recorded in test-report §3)

1. **`decodeDashboardError` envelope field is `params`, not `args`.** The
   first RPC assertions read `args` from the decoded envelope;
   `src/runtime/errors.ts` decodes to `{ dashboardCode, fallbackMessage,
   params }`. Fixed to `params: expect.objectContaining(…)` (matching the
   existing `run.versionConflict` precedent).
2. **Client load-callback identity.** The Memory tab's on-demand fetch
   re-dispatched on every surface render (fresh inline-arrow identity); the
   load effect now tracks the callback in a ref and re-fetches only on real
   input changes.
3. **`getByText` multiplicity in the inspector.** The source-run link opens
   the RunInspector, which renders the goal in three places — the assertion
   uses `getAllByText(…).length > 0`.
4. **`exactOptionalPropertyTypes` in test fixtures.** `Partial<MemoryEntryView>`
   overrides must not assign `undefined` to optional fields — fixtures use
   conditional spreads.

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 6 commit; not a regression.
2. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080
   still serves a pre-Phase-1 build; the Phase 6 UI (Memory 项目记忆 tab) is
   only visible after the plugin is reinstalled/restarted against this
   checkout's v0.12.0 build output.
3. **Phase 6 work is local-only** — `main` is 16 commits ahead of
   `origin/main`; no fork PR was opened this cycle. `dsh-projects-phase-6`
   (at `fccfaba`) is the release marker.

### Follow-ups (next intent cycle)

- Reinstall/restart the GUI plugin against the v0.12.0 build so the running
  dashboard serves the Phase 6 UI (the Memory tab: search, kind chips,
  pin/edit/archive/mark-obsolete, manual create, supersession notices).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Optionally push `main` / open a fork PR for the Phase 5+6 work (16 commits
  ahead of `origin/main`) so it lands via review; the in-session gate
  approval substituted for it this cycle.
- Phase 7 scope (per `DSH_PROJECTS_SPEC.md` and Phase 6 spec §14 non-goals):
  to be drafted as the next `intent.md` when this maintain loop hands back to
  intent.

## Cycle 4 (post v0.11.0 deploy) — 2026-09-13

**Status: no incidents.** Phase 5 (Git isolation + integration + run
completion pipeline) released as v0.11.0 (commit `e2ca05f`, build `c44e054`,
test report `51416f6`). This cycle shipped **directly on local `main` with no
fork PR** (the user drove the loop gate-by-gate in-session; `main` is 9
commits ahead of `origin/main`). A release marker branch
`dsh-projects-phase-5` (at `c44e054`) was created for consistency with the
Phase 3/4 markers.

### Post-deploy verification

- `pnpm run typecheck` — clean
- `pnpm run build` — clean (dual tsdown, host + client)
- `pnpm run test` — 336 passed / 3 failed (339 total); the 3 failures are the
  pre-existing, documented macOS tmpdir environment failures in
  `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
  realpath mismatch), present before Phase 5 and unrelated to it. Every Phase 5
  suite is green (see `test-report.md`): git-workspace (21),
  integration-strategy (7), task-service (20, incl. the 8 pipeline cases),
  run-storage-integration (5, incl. the real-Git reopen leg), rpc-handler (34),
  dashboard-tasks-interactions (8, incl. the 3 Phase 5 UI cases).
- Working tree clean; `dsh_projects` storage domain remains at format version 0
  (Phase 5 is additive — 4 task fields, 2 run fields, 3 run event types, no new
  tables; the `tasks` table dates from Phase 4 — no migration needed for
  installed instances).
- Invariant checks: the client still never imports `git-workspace.ts`
  (`Dashboard.tsx` renders the projected `runDetail` only); the Phase 4
  import-isolation scan still passes (`agentTeams` in exactly one file,
  `subagents` in none); the new Git modules are host-only.

### Test-stage findings (fixed during the build, recorded in test-report §3)

1. **Full-suite disk contention.** The default vitest pool (one fork per core
   — 8 on this host) ran every real-Git suite simultaneously and their
   timeouts fired. Fixed with `vitest.config.ts` (`maxWorkers: 4`) and explicit
   budgets on every real-Git test; the suite is now stable across repeated full
   runs.
2. **`blocked` runs carry no `error` by design.** The state machine persists
   `error` only on `failed` transitions; the integration-conflict detail lives
   on the `run.integration.failed` event. The pipeline tests now assert on the
   event detail (the authoritative contract), not on the run record.

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 5 commit; not a regression.
2. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080 still
   serves a pre-Phase-1 build; the Phase 5 UI (集成 integration panel, per-task
   branch chips, the no-Git notice) is only visible after the plugin is
   reinstalled/restarted against this checkout's v0.11.0 build output.
3. **Phase 5 work is local-only** — `main` is 9 commits ahead of `origin/main`
   (Phase 5 intent/spec/build/test + release); no fork PR was opened this
   cycle. `dsh-projects-phase-5` (at `c44e054`) is the release marker.

### Follow-ups (next intent cycle)

- Reinstall/restart the GUI plugin against the v0.11.0 build so the running
  dashboard serves the Phase 5 UI (integration panel, branch chips, no-Git
  notice).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Optionally push `main` / open a fork PR for the Phase 5 work (9 commits
  ahead of `origin/main`) so it lands via review; the in-session gate
  approval substituted for it this cycle.
- Phase 6 scope (per `DSH_PROJECTS_SPEC.md` and Phase 5 spec §14 non-goals):
  Project Memory (per-project durable knowledge surfaced to plans and tasks) —
  to be drafted as the next `intent.md` when this maintain loop hands back to
  intent.

## Cycle 3 (post v0.10.0 deploy) — 2026-09-13

**Status: no incidents.** Phase 4 (Task DAG + team execution) released as
v0.10.0 (commit `fe16b3b`). The work was merged before the deploy gate:
`etumulkans/dsh-projects` PR #2 (merge commit `13638b1`); the Test stage
verified the merged branch (`test-report.md @ d744232`) and closed two
spec-§12 coverage gaps with `2c6b68b` (the `task.unknown` RPC mapping case
and the zh unavailable-worker banner case — test-only, no source changes).

**Session-interruption note (non-incident):** the session driving the Test
stage was aborted by a PC restart before the gap-test commit. On resume the
two uncommitted test files were found in the working tree, re-verified green
(38/38 across the two suites, typecheck clean), and committed as `2c6b68b`.
No work was lost.

### Post-deploy verification

- `pnpm run typecheck` — clean
- `pnpm run build` — clean (dual tsdown, host + client)
- `pnpm vitest run --no-file-parallelism` — 295 passed / 3 failed (298
  total); the 3 failures are the pre-existing, documented macOS tmpdir
  environment failures in `tests/project-catalog.test.ts`
  (`/var/folders` vs `/private/var/folders` realpath mismatch), present
  before Phase 4 and unrelated to it. Every Phase 4 suite is green (see
  `test-report.md`).
- Working tree clean; `dsh_projects` storage domain remains at format version 0
  (Phase 4 adds the `tasks` table to the declared set — every declared table
  is created on domain open; no migration needed for installed instances).
- Invariant check: `agentTeams` appears in exactly one source file
  (`src/tasks/team-adapter.ts`); `subagents` appears in none — enforced by
  the `task-adapters` import-isolation test.

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 4 commit; not a regression.
2. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080
   still serves a pre-Phase-1 build; the Phase 4 UI (Tasks 任务 section,
   retry 重试, worker banner) is only visible after the plugin is
   reinstalled/restarted against this checkout's v0.10.0 build output.
3. **Release markers** — `dsh-projects-phase-3` (v0.9.0) and
   `dsh-projects-phase-4` (Phase 4 build) are kept as release markers; the
   redundant `dsh-projects-phase-0-2` branch (Cycle 2 follow-up) is deleted.

### Follow-ups (next intent cycle)

- Reinstall/restart the GUI plugin against the v0.10.0 build so the running
  dashboard serves the Phase 4 UI (Tasks 任务 section, retry, worker banner).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Phase 5 scope (per `spec.md` §14 explicit non-goals): per-task
  worktree/branch isolation (one-writer-per-worktree invariant), the run
  completion pipeline (`integrating → validating → finalizing → succeeded`),
  Git metadata in the UI — to be drafted as the next `intent.md` when this
  maintain loop hands back to intent.

## Phase 4 build (Task DAG + team execution) — 2026-09-12

**Status: no incidents.** Phase 4 build committed as `009d9bc`
(intent `c7690b0`, spec `515422d`/correction `8773e22`); the build gate was
advanced to Test. **`etumulkans/dsh-projects` PR #2**
(`dsh-projects-phase-4` → `main`) opened 2026-09-12 and **merged 2026-09-12**
(merge commit `13638b1`).

### Verification

- `pnpm run typecheck` — clean
- `pnpm run build` — clean (dual tsdown, host + client)
- `pnpm vitest run --no-file-parallelism` — 294 passed / 3 failed (297
  total); the 3 failures are the pre-existing, documented macOS tmpdir
  environment failures in `tests/project-catalog.test.ts`
  (`/var/folders` vs `/private/var/folders` realpath mismatch), unrelated to
  Phase 4. Every Phase 4 suite is green: task-service (12),
  task-state-machine (12), task-scheduler (16), task-adapters (18, incl. the
  import-isolation source scan), dashboard-tasks-interactions (4), rpc-handler
  (33), run-storage-integration (4, incl. the materialization leg).
- Working tree clean; `dsh_projects` storage domain remains at format version 0
  (Phase 4 adds the `tasks` table to the spec's declared set — every declared
  table is created on domain open; no migration needed for installed instances).
- Invariant check: `agentTeams` appears in exactly one source file
  (`src/tasks/team-adapter.ts`); `subagents` appears in none — enforced by a
  test, not just by review.

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 4 commit; not a regression.
2. **PR merged** — `etumulkans/dsh-projects` PR #2
   (`dsh-projects-phase-4` → `main`, Phase 4 Task DAG + team execution)
   opened and **merged 2026-09-12** (merge commit `13638b1`).
   `dsh-projects-phase-4` is its head (kept as the release marker).
3. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080 still
   serves a pre-Phase-1 build; the Phase 4 UI (Tasks 任务 section, retry 重试,
   worker banner) is only visible after the plugin is reinstalled/restarted
   against this checkout's Phase 4 build output.
4. **Redundant branch** — `dsh-projects-phase-0-2` (v0.8.0 prefix of the
   merged PR #1) can be deleted.

### Follow-ups (next intent cycle)

- ~~Merge PR #2 when reviewed~~ — done 2026-09-12 (merge commit `13638b1`);
  the Test stage records the verification outcome for the merged branch.
- ~~Delete the redundant `dsh-projects-phase-0-2` branch.~~ — done 2026-09-13
  (branch removed before the v0.10.0 deploy).
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.

## Cycle 2 (post v0.9.0 deploy) — 2026-09-12

**Status: no incidents.** Phase 3 (Coordinator Lead) released as v0.9.0
(commit `0e98e5e`); the deploy gate was advanced with the review branch pushed.
The PR was opened 2026-09-12 after `gh` re-auth — **`etumulkans/dsh-projects`
PR #1** (review pending, see Known issues). An upstream PR
(`Uddoo/dsh-dashboard#1`) was opened in the wrong repository by mistake and
closed the same day with an explanatory comment; all PRs are done in the fork.

### Post-deploy verification

- `pnpm run typecheck` — clean
- `pnpm run build` — clean (dual tsdown, host + client)
- `pnpm vitest run` (sequential, load-flakiness removed) — 225 passed / 4
  failed (229 total); the 4 failures are the pre-existing, documented macOS
  tmpdir environment failures in `tests/project-catalog.test.ts`
  (`/var/folders` vs `/private/var/folders` realpath mismatch), present before
  Phase 3 and unrelated to it. Every suite this phase touches is green
  (101/101 across the 9 affected files; see `test-report.md`).
- Working tree clean; `dsh_projects` storage domain remains at format version 0
  (Phase 3 is additive — `coordinatorSessionId` + 3 run event types, no new
  tables, no migration needed for installed instances).

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 4** — macOS sandbox realpath mismatch
   (`/var/folders` vs `/private/var/folders`). Fails identically before and
   after every Phase 3 commit; not a regression. (Count varies 3–4 by run.)
2. **PR merged** — `etumulkans/dsh-projects` PR #1
   (`dsh-projects-phase-3` → `main`, Phases 0–3 / v0.9.0) opened 2026-09-12
   after `gh` re-auth and **merged 2026-09-12** (merge commit `bcbac5e`).
   `dsh-projects-phase-3` is its head (kept as the v0.9.0 release marker); the
   now-redundant `dsh-projects-phase-0-2` branch (its prefix, v0.8.0) can be
   deleted. (An upstream PR `Uddoo/dsh-dashboard#1` was opened by mistake and
   closed the same day — all PRs are done in the fork.)
3. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080 still
   serves a pre-Phase-1 build; the Phase 1/2/3 UI (Runs tab, Run Plans,
   Coordinator 协调 action + section) is only visible after the plugin is
   reinstalled/restarted against this checkout's v0.9.0 build output.

### Follow-ups (next intent cycle)

- ~~Re-authenticate `gh` and open the PRs~~ — done 2026-09-12: `gh`
  re-authenticated and **`etumulkans/dsh-projects` PR #1** opened from
  `dsh-projects-phase-3` (Phases 0–3 / v0.9.0), **merged the same day**
  (merge commit `bcbac5e`). Remaining: delete the redundant
  `dsh-projects-phase-0-2` branch.
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.

## Cycle 1 (post v0.8.0 deploy) — 2026-09-11

**Status: no incidents.** Loop closed on the v0.8.0 release (commit `2a38466`);
the deploy gate was advanced without a GitHub PR (see Follow-ups).

### Post-deploy verification

- `pnpm run typecheck` — clean
- `pnpm vitest run` — 193 passed / 3 failed (196 total); the 3 failures are the
  pre-existing, documented macOS tmpdir environment failures in
  `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
  realpath mismatch), unrelated to the deployed code
- Working tree clean; `dsh_projects` storage domain remains at format version 0
  (additive tables only — no migration needed for installed instances)

### Known issues (tracked, non-blocking)

1. **`project-catalog.test.ts` × 3** — macOS sandbox realpath mismatch. Fails
   identically before and after every Phase 2 commit; not a regression.
2. **Review branch without PR** — `dsh-projects-phase-0-2` is pushed to origin
   (5 commits: Phase 0/1/2 + release) but the PR was not opened: `gh` auth is
   broken (stale keyring token, HTTP 401). Title and body are prepared in the
   test stage (see `test-report.md` for the verification summary).
3. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080 still
   serves a pre-Phase-1 build; the Phase 1/2 UI (Runs tab, Run Plans) is only
   visible after the plugin is reinstalled/restarted against this checkout's
   build output.

### Follow-ups (next intent cycle)

- Re-authenticate `gh` (or open the PR from the branch) so the v0.8.0 work
  lands via review; then consider deleting the pushed branch.
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Phase 3 scope (per `DSH_PROJECTS_SPEC.md`, explicit Phase 2 non-goals):
  coordinator session + plan *execution* (PlannedTask → ProjectTask),
  approval-request run-phase coupling, budgets — to be drafted as the next
  `intent.md` when the maintain loop hands back to intent.
