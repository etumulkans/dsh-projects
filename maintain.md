# Maintenance Log — DSH Projects

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
