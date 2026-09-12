# Maintenance Log — DSH Projects

## Cycle 2 (post v0.9.0 deploy) — 2026-09-12

**Status: no incidents.** Phase 3 (Coordinator Lead) released as v0.9.0
(commit `0e98e5e`); the deploy gate was advanced with the review branch pushed.
The PR was opened 2026-09-12 after `gh` re-auth — **`Uddoo/dsh-dashboard` PR #1**
(review pending, see Known issues).

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
2. **PR open, review pending** — `Uddoo/dsh-dashboard` PR #1
   (`etumulkans:dsh-projects-phase-3` → `main`, Phases 0–3 / v0.9.0) was
   opened 2026-09-12 after `gh` re-auth. `dsh-projects-phase-3` is its head
   (do not delete); the now-redundant `dsh-projects-phase-0-2` branch (its
   prefix, v0.8.0) can be deleted once PR #1 lands.
3. **Running GUI lags the repo** — the dashboard at http://127.0.0.1:3080 still
   serves a pre-Phase-1 build; the Phase 1/2/3 UI (Runs tab, Run Plans,
   Coordinator 协调 action + section) is only visible after the plugin is
   reinstalled/restarted against this checkout's v0.9.0 build output.

### Follow-ups (next intent cycle)

- ~~Re-authenticate `gh` and open the PRs~~ — done 2026-09-12: `gh`
  re-authenticated and **`Uddoo/dsh-dashboard` PR #1** opened from
  `dsh-projects-phase-3` (Phases 0–3 / v0.9.0). Remaining: drive PR #1 to
  review/merge, then delete the redundant `dsh-projects-phase-0-2` branch.
- Decide whether to fix the `project-catalog.test.ts` tmpdir expectations
  (normalize `realpath` in the assertions) or keep them documented.
- Phase 4 scope (per `spec.md` §13 explicit non-goals): task *execution*
  (PlannedTask → ProjectTask), Agent Teams / background subagents behind
  adapters, per-task worktrees — to be drafted as the next `intent.md` when
  this maintain loop hands back to intent.

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
