# Test Report — Phase 5: Git isolation + integration

Test-stage artifact for the Phase 5 diff (build commit `c44e054`,
intent `4049144`, spec `48aa3cb` — §12 test plan + §13 acceptance
criteria). Verified on local `main` @ `c44e054`, 2026-09-13.

## 1. Test inventory

| File | Cases | Scope (spec §12) |
| --- | --- | --- |
| `tests/git-workspace.test.ts` (new, real Git fixture repos — `git init` + `-c user.name/user.email` commits in a temp dir, the `workspace-manager` pattern) | 21 | naming: deterministic `dsh/run-<short>/<leaf>` branch + worktree names; leaf normalization (unsafe ids → distinct stable leaves; ref-safety). provision: worktree + branch from repository `HEAD` with `baseCommit`; idempotent reuse (same identity → `createdNow: false`, uncommitted work kept, no reset); a crashed attempt leaving only the branch behind re-provisions cleanly; foreign branch at the path → `task.workspaceConflict` (never adopted, never deleted); a worktree of a different repository → `task.workspaceConflict`; a plain file at the path → `task.workspaceConflict`; a non-directory worktree parent → `task.worktreeFailed`; containment (a crafted leaf cannot escape the project root). integration worktree: provisioned from `HEAD` with the §4.3 identity. commitTaskWork: dirty tree → exactly one commit on the task branch (`committed: true`, `headCommit` advances, subject `dsh task <leaf>: <title>`); clean tree → `committed: false`, `headCommit === baseCommit`; long titles truncated to 120 chars; no usable identity → `task.commitFailed`. removal: registered worktree removed (force, even dirty) with the branch kept; double removal + missing path → `false` (idempotent); an unregistered directory (crashed mid-creation) falls back to a validated plain removal; a symlink at the path is never removed; a real directory outside the project root is never removed. branch removal: a checked-out branch is refused while its worktree is attached; after the worktree is gone the branch is force-deleted, idempotently for a missing one. |
| `tests/integration-strategy.test.ts` (new, real Git fixtures) | 7 | `MergeInOrderStrategy`: two task branches with disjoint changes → integrated branch contains both files, plan-ordered merge commits, `merged`/`skipped` correct, `integratedHead` = branch tip; overlapping changes → `conflict` + exact `conflictingPaths`, worktree aborted back to base (no partial merge state), task branches untouched; an empty task (`headCommit === baseCommit`) is skipped, not merged. `verifyIntegration`: ok (branch resolvable, worktree sound, task branches are ancestors); missing branch → not ok; a tampered worktree (tip moved) → not ok. The strategy seam accepts a fake implementation. |
| `tests/task-service.test.ts` (extended; in-memory domain + fake worker + fake worktree-manager seam + fake strategy) | 20 (12 Phase 4 + **8 new**) | Phase 5 pipeline: (1) provisioning a worktree per task (the worker receives `cwd` = worktree path + `branch`), commit before `succeeded` (`headCommit ≠ baseCommit`), the completion pipeline `integrating → validating → finalizing → succeeded` with `integrationBranch`/`integrationHead` on the run, `run.integration.started`/`completed` events, resultSummary naming the branch, finalization cleanup (task branch + both worktrees gone, integration branch kept); (2) an integration conflict → `run.integration.failed` with the conflicting paths in the detail + run `blocked` (`suspendedFrom: 'integrating'`; the record carries no `error` by design — only `failed` transitions persist one), task branches intact, resume via `transitionRun` re-runs the merge → `succeeded` (exactly two `started`, one `completed`); (3) crash safety — a persisted `run.integration.completed` with the `validating` transition rejected advances on the next tick **without re-merging** (verify-only leg, one strategy call); (4) a provisioning failure settles as a retryable failure (`task.ready` with the `retry after failure` detail) and attempt 2 re-provisions and completes the pipeline; (5) a commit failure keeps the worktree and reuses it without reset on retry (both attempts' files reach the integrated branch — no silently discarded work); (6) a non-Git project with a manager mounted keeps Phase 4 behavior exactly (`cwd = project.root`, no worktree fields, manager never called, `resultSummary` = the no-isolation summary); (7) disjoint parallel tasks at `maxConcurrentAgents: 2` really run in parallel (second start before first finish, two distinct worktrees, both branches merged into one integration branch); (8) parallel tasks with conflicting edits succeed in their worktrees and block at integration (the Phase 4 concurrency rationale retired — worktrees make it safe). |
| `tests/run-storage-integration.test.ts` (extended; real JSON domain + real Git fixture repo) | 5 (4 + **1 new**) | the full pipeline on the **real medium**: two tasks whose fake workers write real files into real worktrees → all succeeded → integrating → the **real** `MergeInOrderStrategy` merges → `succeeded`; after a full service stop + domain **reopen** (fresh services, same medium) the run's phase/`integrationBranch`/`integrationHead`/`resultSummary` survive, the `run.integration.*` events survive, the task views keep `branch` + `headCommit ≠ baseCommit`; on disk the task branches are gone and the integration branch exists; the medium keeps unit `dsh_projects` at format version 0 with table set exactly `['plans', 'run_events', 'runs', 'tasks']` and the persisted task records carry the real 40-hex commits + `dsh/run-*/tN` branch names. |
| `tests/rpc-handler.test.ts` (extended) | 34 (33 + **1 new**) | `runDetail` passes the additive Phase 5 fields through exactly: the run carries `integrationBranch`/`integrationHead`/`resultSummary`, `tasks[]` carries `branch`/`baseCommit`/`headCommit`, `events` include `run.integration.started` (detail = branch) + `run.integration.completed` (merged/skipped detail); the `state` projection's run views carry the integration branch; a `blocked` run (suspended from `integrating`) with a `run.integration.failed` event (conflicting paths in the detail) passes through untouched. No new endpoints. |
| `tests/dashboard-tasks-interactions.test.tsx` (extended, jsdom) | 8 (5 + **3 new**) | (zh) a succeeded Git run renders the integration panel (集成 title, the branch name, the 7-char integrated head, the 已成功 phase label) + the per-task branch chip (full head in the `title` attribute) + both integration events with their real detail formats; (en) a blocked run renders the same panel with the conflict detail `integration conflict: src/clash.ts` in the failure line — proving zh/en parity of the panel; (zh) a `controlled-directory` project renders the no-Git notice (该项目不是 Git 仓库：…) and **no** integration panel and **no** branch chip. No fabricated Git data anywhere. |
| `tests/workspace-manager.test.ts` (regression) | 3 | green after the `runGit` extraction (behavior unchanged); the real-detached-worktree case gained an explicit 30 s budget (it timed out under full-suite disk contention, §3 below). |
| `tests/dashboard-i18n-regressions.test.tsx` (regression) | 16 | the existing parity mechanism still green; the new keys `runs.integration.title` / `runs.integration.noGit` exist in both `zh` (locales.ts:151–152) and `en` (locales.ts:693–694) — parity is compile-enforced (both maps are the same record type). |

**Regression:** every existing suite re-ran — Phase 4
(`task-state-machine` 12, `task-scheduler` 16, `task-adapters` 18,
`plan-service` 14, `plan-state-machine` 10, `dashboard-plans-interactions` 7),
Phase 3 (`coordinator-*` 22, `runtime-coordinator` 1), Phase 2
(`dashboard-plans-interactions` 7), Phase 1 (`run-service` 11,
`run-state-machine` 12), and the shared suites (`orchestrator` 9,
`scheduling` 3, `workflow-parser` 17, all dashboard i18n/ux/render suites,
`global-dashboard` 4, provider/source/timeline/path-safety suites). The Phase 4
import-isolation source scan still passes: the new Git modules
(`src/tasks/git-workspace.ts`, `src/tasks/integration.ts`,
`src/workspace/git.ts`) are host-only and add no runtime/agent surface; the
client still does not import `git-workspace.ts` (invariant, `Dashboard.tsx`
consumes the projected `runDetail` only).

## 2. Acceptance criteria (spec §13)

1. **Per-task worktree + branch, naming, one-writer guard; non-Git shared tree with notice** — PASS. `git-workspace.test.ts` (naming ×2, provisioning guards ×5, containment, foreign-branch/foreign-repo/file-at-path refusals); `task-service.test.ts` case 6 (non-Git: `cwd = project.root`, no Git metadata, manager never called); `dashboard-tasks-interactions` case 3 (the explicit zh no-Git notice).
2. **Work committed onto the task branch before `succeeded`; fields real or absent** — PASS. `git-workspace.test.ts` commitTaskWork (dirty → one commit, `headCommit` advances; clean → no commit, `headCommit === baseCommit`; no identity → `task.commitFailed`); `task-service.test.ts` cases 1/4/5 (`headCommit ≠ baseCommit` asserted from the real git repo; commit failure is a retryable failed attempt; the reused worktree keeps attempt 1's uncommitted work — no silently discarded work).
3. **Deterministic merge-in-order integration; structured conflict; only `dsh/run-*` branches** — PASS. `integration-strategy.test.ts` (disjoint → both files + plan-ordered commits + correct `merged`/`skipped`; overlap → `conflict` + exact `conflictingPaths` + abort back to base, never force-resolved; empty task skipped); `task-service.test.ts` case 2 (conflict → `run.integration.failed` with paths, run `blocked`, task branches intact for the resumed re-merge); `git-workspace.test.ts` branch-removal tests (only task-branch names are ever deleted; a checked-out branch is refused while attached).
4. **Completion pipeline end-to-end on the existing state machine; blocked → deterministic resume** — PASS. `task-service.test.ts` cases 1–3 (the exact `integrating → validating → finalizing → succeeded` sequence on the existing phases; crash-safety verify-only leg; resume re-runs the strategy exactly once more, from the immutable task branches); `run-storage-integration.test.ts` proves the same sequence survives a process/domain boundary.
5. **Cleanup semantics** — PASS. `task-service.test.ts` case 1 (succeeded task: worktree removed after its commit, branch kept; terminal succeeded run: task branches + integration worktree removed, integration branch kept — asserted on disk via `rev-parse`); case 2 (a blocked run keeps the task branches for a resumed re-merge); `git-workspace.test.ts` removal suite (force-even-dirty, idempotent, fallback validated, symlink/outside-root never touched); `stop()` removes nothing (all `stop()`-then-inspect legs).
6. **UI: branch chip, integration panel, integrated branch on success, no-Git notice — zh/en parity** — PASS. `dashboard-tasks-interactions.test.tsx` cases 1–3 (zh succeeded panel + chip + event details; en blocked panel + conflict detail; zh no-Git notice with the panel provably absent); locale keys present in both maps (compile-enforced parity).
7. **Storage: fields + events survive a real reopen; v0; table set unchanged** — PASS. `run-storage-integration.test.ts` new case (reopen assertions above; unit `dsh_projects` version 0; table set exactly `['plans', 'run_events', 'runs', 'tasks']`; persisted records carry real 40-hex commits + `dsh/run-*/tN` branches).
8. **Repo green (modulo documented pre-existing environment failures); parallelism > 1 proven** — PASS. `pnpm run typecheck` ✅, `pnpm run build` ✅, `pnpm run test`: **336 passed / 3 failed of 339** — the 3 failures are the documented pre-existing `project-catalog.test.ts` environment failures (macOS `/var/folders/…` vs realpath'd `/private/var/folders/…` path mismatch, present since Phase 3; the fix-vs-document decision is parked in `maintain.md`), and they are unrelated to Phase 5. Parallel execution at `maxConcurrentAgents: 2` proven with disjoint **and** conflicting file sets (`task-service.test.ts` cases 7–8).

## 3. Test-stage findings (fixed before this report)

- **Full-suite disk contention.** The first full runs timed out in the real-
  Git suites (`git-workspace` branch-removal defaults of 5 s, the 30 s
  pipeline budgets, the 40 s reopen poll) because vitest's default pool
  (one fork per core — 8 on this host) ran all disk-bound suites
  simultaneously. Fixed by `vitest.config.ts` (`maxWorkers: 4`) and explicit
  budgets on every real-Git test (30 s per-suite defaults, 45–90 s pipeline
  budgets, 40–55 s wait-for-succeeded budgets). The suite is now stable
  across repeated full runs.
- **`ProjectRunEventView` is a projection.** The UI test fixtures initially
  carried a `runId` field; the view (per `run-service.runDetail`) deliberately
  omits it — fixed the fixtures to the exact view shape, which is the
  client-facing contract the UI renders.
- **`role="status"` panels have no accessible name from content.** The
  integration panel is queried by its unique `status` role inside the
  inspector (the no-Git notice and the task retry notice are the only other
  `status` elements, and they are mutually exclusive with the panel's
  conditions) — a sharper contract than matching on translated text.

## 4. Known pre-existing failures (carried, documented)

`tests/project-catalog.test.ts` — 3 of 6 cases fail on this host because
`tmpdir()` yields `/var/folders/…` while the catalog canonicalizes paths to
`/private/var/folders/…` (macOS symlink). Present since Phase 3 (baseline
295 passed / 3 failed of 298); the fix-vs-document decision is open in
`maintain.md`. Unchanged by Phase 5.
