# Spec — Phase 5: Git isolation + integration

**Gate:** Design · **Intent:** `intent.md` §9 · **Master spec:** `DSH_PROJECTS_SPEC.md` §73 Phase 5, §16, §17 · **Architecture:** `docs/dsh-projects-architecture.md`

## 1. Goal and success

Phase 4 executes every live task in the project's existing working tree
(default concurrency 1). Phase 5 gives each live task its own Git worktree +
branch (one writer per worktree), commits the task's work onto its branch
before the task may reach `succeeded`, integrates the task branches in a
dedicated integration worktree with a deterministic merge-in-order strategy,
and drives the run through the already-declared
`integrating → validating → finalizing → succeeded` phases (Phase 1 state
machine — no new run phases). Git metadata becomes inspectable in the
existing Dashboard (zh/en).

**Success (master spec §73 Phase 5):** *parallel coding Agents safely
produce an integrated branch* — end-to-end, persisted, restart-surviving,
with an explicit "no Git isolation" degradation (shared tree, real notice)
instead of fake worktree data when the project is not a Git repository.

## 2. Invariants (from `intent.md` §3)

1. **Preserve the existing safe workspace strategy** — reuse
   `src/workspace/path-safety.ts` (leaf normalization, containment, symlink
   protection) and the existing `WorkspaceManager` Git discipline; no new
   package dependency; Git only via `node:child_process` `execFile`.
2. **No placeholder APIs, no fake UI data** — worktree/branch/commit fields
   are real `git` results or absent; a non-Git project shows an explicit
   notice; a foreign worktree occupying an expected path is refused, never
   adopted and never deleted.
3. **Additive only** — the `dsh_projects` domain stays at **format version
   0**; existing record shapes only gain optional fields;
   `DashboardSnapshot.version` stays 2.
4. **One writer per worktree** (master spec §16 default rule) — exclusive by
   construction (unique per-task naming) + persisted identity + the
   conflict guard of §4.3.
5. **Never touch the repository's default/protected branch** (master spec
   §17) — only `dsh/run-*` branches are created and deleted; the integration
   output is the integrated branch, nothing more.
6. The run state machine stays the single authority for run phases; the
   completion pipeline reuses existing phases; no new phases.
7. UI extends the existing `DashboardSurface` inspector; zh/en parity
   compile-enforced.
8. State survives a process restart (real-JSON storage integration test);
   provisioning is idempotent so a restart can resume without corruption.
9. Repo green: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run`
   (modulo the documented pre-existing environment failures).

## 3. Storage (additive, domain stays v0)

### 3.1 Task record — `src/tasks/types.ts` + `src/tasks/spec.ts`

| Field | Type | Notes |
| --- | --- | --- |
| `workspaceId` | `string?` | RESERVED in Phase 4, populated in Phase 5: the canonical worktree path. Absent for non-Git projects and shared-tree runs. |
| `branch` | `string?` | Task branch name (`dsh/run-<short>/<leaf>`); set together with `workspaceId`. |
| `baseCommit` | `string?` | Full SHA of the repository `HEAD` at provisioning (creation only). |
| `headCommit` | `string?` | Full SHA of the task branch after the task's commit; equal to `baseCommit` when the task produced no changes. Set on `succeeded`. |

`ProjectTaskView` gains the same four optional fields (lossless projection).

### 3.2 Run record — `src/runs/types.ts` + `src/runs/spec.ts`

| Field | Type | Notes |
| --- | --- | --- |
| `integrationBranch` | `string?` | Set when integration completes (direct CAS update on the borrowed `runs` table — the Phase 3 `coordinatorSessionId` pattern). Survives to `succeeded`. |
| `integrationHead` | `string?` | Full SHA of the integrated branch tip at integration completion. |

The run view spreads the record, so both flow automatically into
`runDetail` and the snapshot run summary.

### 3.3 Run event types — additive to `RUN_EVENT_TYPES`

`run.integration.started` (detail: the integration branch),
`run.integration.completed` (detail: integrated branch + merged task
positions), `run.integration.failed` (detail: conflicting paths or the
error, truncated to `EVENT_DETAIL_LIMIT`).

Extending the enum is additive (stored records unchanged) → the domain
version stays 0. The medium table set is unchanged:
`['plans', 'run_events', 'runs', 'tasks']`.

## 4. Git workspace model — `src/tasks/git-workspace.ts` + `src/workspace/git.ts`

### 4.1 Shared Git helper (extraction, behavior unchanged)

`runGit(cwd, args, timeoutMs, signal?)` — the exact helper
`WorkspaceManager` uses today (`execFile('git', ['-C', cwd, …])`, bounded
output buffer, abort-aware, stderr-tailed error message) — is extracted from
`src/workspace/manager.ts` into `src/workspace/git.ts`. The existing
`WorkspaceManager` and the new task worktree module both import it.
`tests/workspace-manager.test.ts` staying green is the regression proof.

New constant: `GIT_OPERATION_TIMEOUT_MS = 30_000` (`src/tasks/constants.ts`).

### 4.2 Naming (pure, deterministic)

| Function | Result |
| --- | --- |
| `shortRunId(runId)` | First 8 characters of the run UUID (hex — ref-safe). |
| `taskLeaf(planTaskId)` | `workspaceLeaf(planTaskId)` from `path-safety.ts` — always normalized; the function never trusts its input even though the schema already enforces `^t[1-9][0-9]*$`. |
| `taskBranchName(runId, planTaskId)` | `dsh/run-<shortRunId>/<leaf>` (master spec §16). |
| `integrationBranchName(runId)` | `dsh/run-<shortRunId>/integration`. |
| `taskWorktreePath(projectRoot, runId, planTaskId)` | `<projectRoot>/worktree/run-<shortRunId>/<leaf>` (master spec §16 example layout). |
| `integrationWorktreePath(projectRoot, runId)` | `<projectRoot>/worktree/run-<shortRunId>/integration`. |

Every name is derived from `(projectRoot, runId, planTaskId)` — **never from
task title/description text** (master spec §16: “Never trust task text
directly as a filesystem path”). An 8-character short id can in principle
collide across runs; the conflict guard of §4.3 is the backstop (a foreign
identity at that location is refused, never adopted). The `worktree/`
directory is untracked in the main checkout — by design (master spec §16
layout); the harness never writes the project's `.gitignore`.

### 4.3 `TaskWorktreeManager` (host module)

`provisionTaskWorktree({ repositoryRoot, projectRoot, runId, planTaskId }) → { path, branch, baseCommit?, createdNow }`:

1. Compute path/branch; `assertContained(projectRoot, path)`; create the
   `worktree/run-<short>/` parent with the existing manager's discipline
   (real directory, not a symlink, `realpath` revalidation).
2. **Idempotent reuse (restart safety):** when the path already exists it is
   adopted only if it is a real directory, a worktree of `repositoryRoot`
   (common-directory equality — the `WorkspaceManager.assertGitWorktree`
   check), and its checked-out branch equals the expected task branch. All
   three → reuse (`createdNow: false`, no `baseCommit` returned — the
   persisted record keeps the original base). Any mismatch →
   `task.workspaceConflict` (one-writer invariant; the foreign tree is
   neither adopted nor deleted).
3. **Create:** `git -C <repositoryRoot> worktree add -b <branch> <path>
   HEAD`, then `baseCommit = git rev-parse HEAD` (repository root), then
   revalidate (common-directory check). Any Git failure →
   `task.worktreeFailed` (message carries the stderr tail).

`commitTaskWork({ path, planTaskId, title }) → { headCommit, committed }`:

- `git -C <path> status --porcelain`; when changes exist: `git add -A` +
  `git commit -m "dsh task <planTaskId>: <title ≤ 120 chars>"`. The commit
  uses the repository's configured identity — **no invented identity**; a
  missing identity is `task.commitFailed` with an actionable message.
  Clean tree → `committed: false`.
- `headCommit = git rev-parse HEAD` (equals `baseCommit` when nothing was
  committed).

`removeTaskWorktree({ repositoryRoot, projectRoot, path }) → boolean`:

- `git -C <repositoryRoot> worktree remove --force <path>`; when git reports
  no registered worktree (a crashed mid-creation), fall back to a
  revalidated plain removal (real directory, `assertContained`, not a
  symlink) and `rm`. Returns whether anything was removed.

`removeBranch({ repositoryRoot, branch }) → boolean`: `git branch -D
<branch>`; “not found” → `false`.

All operations are idempotent and safe to re-run (restart, resume, cleanup
retries).

## 5. Integration strategy — `src/tasks/integration.ts`

Master spec §17: “The exact strategy should be configurable. Support at
minimum a clean, deterministic integration path.” The strategy is a seam
with one shipped implementation:

```ts
interface IntegrationStrategy {
  readonly name: string
  run(input: IntegrationInput): Promise<IntegrationOutcome>
}
```

`MergeInOrderStrategy` (the only MVP strategy):

1. Provision the integration worktree (§4.3; branch
   `dsh/run-<short>/integration`, from the repository `HEAD` at integration
   time). On a re-run (resume after a failed attempt) the previous attempt's
   integration worktree + branch are removed first (best-effort) and a fresh
   one is provisioned — deterministic re-run.
2. For every non-empty task — `headCommit !== baseCommit` — in numeric
   `planTaskId` order (plan order): `git -C <integrationPath> merge --no-ff
   <taskBranch> -m "dsh merge <planTaskId>"`.
3. **Conflict:** capture `git diff --name-only --diff-filter=U`, then
   `git merge --abort` → outcome `conflict` with `conflictingPaths`; the
   integration worktree + branch are kept for inspection; no force
   resolution, no silent skip.
4. Outcome: `{ status: 'integrated' | 'conflict', integratedBranch,
   integratedHead, merged: string[], skipped: string[], conflictingPaths? }`
   (`skipped` = tasks that produced no commits).

`verifyIntegration({ repositoryRoot, integrationPath, integrationBranch,
taskBranches }) → { ok, missing? }` (the validating-phase check): the
branch resolves (`rev-parse --verify`), the worktree is sound
(common-directory check), and every merged task branch is an ancestor of the
integrated branch (`git merge-base --is-ancestor`).

## 6. `ProjectTaskService` extension (host — `src/tasks/task-service.ts`)

Constructor gains two optional parameters (after `worker`):
`worktreeManager?: TaskWorktreeManager` and
`integrationStrategy?: IntegrationStrategy` (default `MergeInOrderStrategy`).
`worktreeManager === undefined` ⇒ no isolation at all (Phase 4 behavior;
test seam). Production wiring always passes the real manager + strategy.

- **`beginExecution` (task → running):** after the CAS to `running`, before
  dispatch: `source = catalog.projectWorkspaceSource(run.projectId)` (the
  existing per-project decision — `worktree` when the project has a Git
  repository, `controlled-directory` otherwise).
  - `worktree` strategy + manager: `provisionTaskWorktree`; on success a
    second CAS adds `workspaceId` (path), `branch`, and `baseCommit`
    (creation only). On failure the attempt settles through the **existing
    settlement path** as a synthetic failed worker result
    (`kind: 'failed', error: 'worktree provisioning failed: …'`) — the
    attempt budget, backoff, and events all apply unchanged; the next
    attempt re-provisions idempotently.
  - `controlled-directory` (or no manager): no fields; the worker's
    `cwd` stays `project.root` (exactly Phase 4).
- **`executeTask`:** `cwd = started.workspaceId ?? project.root`; the worker
  input gains the optional `branch` (§6.1 below).
- **`settleResult` success path (worktree tasks only):** before the CAS to
  `succeeded`, `commitTaskWork` — a commit failure settles the attempt as a
  failed result (`task.commitFailed`, retryable); on success the CAS adds
  `headCommit`. **After** the transition, `removeTaskWorktree` (best-effort:
  a failure is a warn log — the task is already `succeeded`; the run's
  finalization is the authoritative cleanup). A task can never reach
  `succeeded` with uncommitted work (intent §9.1.3).
- **Failure / cancel / retirement:** no commit; the worktree is kept for
  inspection (cleanup only at run finalization, §7).
- **Retry (new attempt):** provisioning is idempotent → the same worktree is
  reused **as-is** — the previous attempt's uncommitted work is visible to
  the agent; no `git reset`, no silent discard.
- **`stop()`:** unchanged (abort in-flight workers; no filesystem cleanup;
  cross-restart reconciliation is Phase 10).

### 6.1 Worker seam (additive)

`TaskWorkerInput.branch?: string` — `LocalTaskWorker` uses it for one line
of prompt guidance (“You are working in a dedicated Git worktree on branch
<b>; your changes will be committed to this branch.”); `TeamTaskWorker` and
fakes ignore it. `worker.ts` is otherwise unchanged; import isolation
(`agentTeams` in exactly one file) is untouched.

## 7. Run completion pipeline (driven by the existing tick)

A new section 4 of `tickOnce`, handling non-terminal runs; the existing
execution sections are untouched. Every step re-reads persisted state and
every run transition goes through `ProjectRunService.transitionRun`
(guard miss = logged no-op, the PlanRunCoupler pattern). The tick
coalescing serializes pipeline steps per process.

1. **All-succeeded detection (run `executing`):** the run has ≥ 1 task and
   **every** task is `succeeded` → Git project: `transitionRun(run,
   'integrating')`; non-Git project: `transitionRun(run, 'finalizing')`
   (the state machine allows `executing → finalizing` directly; no
   integration branch exists for non-Git runs).
2. **`integrating`:**
   - Crash-safety leg: a `run.integration.completed` event exists and
     `verifyIntegration` passes (crash between the event and the phase move)
     → `transitionRun(run, 'validating')` without re-merging.
   - Otherwise: persist `run.integration.started`; remove a previous failed
     attempt's integration worktree + branch (best-effort); run the
     strategy:
     - `integrated` → CAS the run record adding `integrationBranch` +
       `integrationHead` (coordinator pattern); persist
       `run.integration.completed`; `transitionRun(run, 'validating')`.
     - `conflict` / error → persist `run.integration.failed` (detail:
       conflicting paths or the error, truncated); `transitionRun(run,
       'blocked', { error })`. Retryable: task branches are immutable, so a
       resume re-runs the integration deterministically.
3. **`validating`:** `verifyIntegration` → ok: `transitionRun(run,
   'finalizing')`; not ok (e.g. the branch was deleted outside the harness):
   `run.integration.failed` + `blocked` (a human repairs the git state and
   resumes). MVP validation is **structural** (branch resolvable, worktree
   sound, merged task branches are ancestors of the integrated branch);
   running project test/build commands is a non-goal (§14).
4. **`finalizing`:** remove all task branches and the integration worktree
   (the integration branch is kept); then `transitionRun(run, 'succeeded',
   { resultSummary: 'integrated branch <name> @ <short head>' })` (non-Git:
   `all tasks succeeded (no Git isolation)`). Cleanup operations are
   idempotent; a persistently failing cleanup keeps the run in `finalizing`
   (warn log, retried on the next tick; a human may cancel —
   `finalizing → canceled` is a legal edge) — never a fabricated `succeeded`
   with incomplete cleanup.
5. **Blocked runs:** the pipeline does not touch them — the existing
   `runTransition` RPC resumes them (`blocked → integrating` is dynamically
   allowed via `suspendedFrom`) and the next tick re-enters step 2.

## 8. Events and errors

- Persisted event types: the three additive types of §3.3.
- Cordis: **no new Cordis event types** — the run's
  `integrating/validating/finalizing` moves already fire
  `dsh-projects/run/phase-changed` (Phase 1), which the GUI's existing
  run-refresh path handles.
- New `DashboardDomainError` codes (all settle through the generic
  execution-failure path — attempt budget + backoff apply;
  `task.workspaceConflict` is persistent by nature, so retries exhaust to a
  terminal `failed`):

| Code | When |
| --- | --- |
| `task.worktreeFailed` | Worktree provisioning/validation infrastructure error (message carries the stderr tail). |
| `task.workspaceConflict` | A foreign worktree occupies the expected path (wrong branch, or not a worktree of this repository). |
| `task.commitFailed` | The final commit could not be created (e.g. the repository has no git identity). |

The client maps all three to zh/en strings (`src/client/errors.ts`,
`src/client/locales.ts`).

## 9. RPC (additive — no new endpoints)

- `runDetail`: tasks flow through `taskList` (additive optional fields of
  §3.1); the run view spreads the record (`integrationBranch` /
  `integrationHead` automatic); integration events flow through the event
  list.
- `snapshot`: run summary rows carry the run view (automatic).
- `taskRetry`, `runTransition`, and every other endpoint are unchanged
  (resume of a blocked integration = `runTransition` back to
  `suspendedFrom`).

## 10. UI (existing Dashboard surface, zh/en parity)

- **Task rows** (inspector Tasks section): when `branch` is present, a mono
  chip with the branch name + the 7-char `headCommit` short; non-Git tasks
  render nothing extra.
- **Integration panel** (new inspector subsection, visible when the run has
  tasks and its phase is one of `integrating` / `validating` / `finalizing`,
  or it is `succeeded` with an `integrationBranch`):
  - `integrating` → “Integrating…” + the planned integration branch (mono).
  - `validating` → “Validating integration…”
  - `finalizing` → “Finalizing (cleanup)…”.
  - `succeeded` + `integrationBranch` → the integrated branch + short head
    (mono).
  - `blocked` + the latest `run.integration.failed` event → the error, the
    conflicting-paths list, and a hint that resuming re-runs the integration
    from the task branches.
- **Non-Git notice** (run level; when the project's workspace source is
  `controlled-directory` and the run has tasks): “This project has no Git
  repository — tasks run in the shared working tree without isolation.”
- zh/en parity: new locale keys in `src/client/locales.ts` (both maps),
  compile-enforced by the existing i18n regression suite.
- No new controls (no push/PR buttons — §14).

## 11. Module layout & wiring

| File | Change |
| --- | --- |
| `src/workspace/git.ts` | **New** — shared `runGit` helper (extracted, behavior unchanged). |
| `src/workspace/manager.ts` | Imports `runGit` from `git.ts` (private helper removed); behavior unchanged. |
| `src/tasks/git-workspace.ts` | **New** — naming functions (§4.2) + `TaskWorktreeManager` (§4.3). |
| `src/tasks/integration.ts` | **New** — `IntegrationStrategy` seam + `MergeInOrderStrategy` + `verifyIntegration` (§5). |
| `src/tasks/task-service.ts` | Worktree provisioning in `beginExecution`, commit + worktree removal in `settleResult`, pipeline section 4 in `tickOnce`, new constructor parameters (§6, §7). |
| `src/tasks/worker.ts` | `TaskWorkerInput.branch?` (additive, optional; §6.1). |
| `src/tasks/local-adapter.ts` | One worktree prompt line when `input.branch` is present. |
| `src/tasks/types.ts`, `src/tasks/spec.ts` | Task record/view fields (§3.1). |
| `src/runs/types.ts`, `src/runs/spec.ts` | Run record fields + event types (§3.2, §3.3); `maxConcurrentAgents` comment updated (worktrees make > 1 safe; the default stays 1). |
| `src/tasks/constants.ts` | `GIT_OPERATION_TIMEOUT_MS`; `DEFAULT_TASK_CONCURRENCY` comment updated. |
| `src/index.ts` | Construct the `TaskWorktreeManager` + default strategy; pass both to `ProjectTaskService`. |
| `src/client/locales.ts`, `src/client/Dashboard.tsx` | §10. |
| `src/tasks/team-adapter.ts`, `src/tasks/scheduler.ts`, `src/tasks/state-machine.ts`, `src/runs/state-machine.ts` | **Unchanged** (import isolation + pure modules untouched; the run machine already has every phase/edge needed). |

## 12. Test plan

| File | Cases (spec-level) |
| --- | --- |
| `tests/git-workspace.test.ts` (new; real Git fixture repos — the `workspace-manager.test.ts` pattern: `git init` + `-c user.name/user.email` commits in a temp dir) | naming: deterministic branch/worktree names; leaf normalization (never trusts input); ref-safety. provision: creates worktree + branch from `HEAD` with `baseCommit`; idempotent reuse (same identity → `createdNow: false`, no re-creation); foreign branch at the path → `task.workspaceConflict`; path that is not a worktree of the repo → `task.workspaceConflict`; containment (a crafted leaf cannot escape the project root). commitTaskWork: dirty tree → exactly one commit on the task branch (`committed: true`, `headCommit` advances); clean tree → `committed: false` with `headCommit === baseCommit`; missing identity → `task.commitFailed`. removal: worktree remove + branch `-D`; double removal is a no-op; fallback removal of an unregistered tree (revalidated). |
| `tests/integration-strategy.test.ts` (new; real Git fixtures) | two task branches with disjoint changes → integrated branch contains both, plan-ordered merge commits, `merged`/`skipped` correct, `integratedHead` = tip; overlapping changes → `conflict` + exact `conflictingPaths` + worktree aborted back to base (no partial merge state), task branches untouched; empty task (`headCommit === baseCommit`) skipped; `verifyIntegration`: ok / missing branch → not ok / tampered worktree → not ok; the strategy seam accepts a fake implementation. |
| `tests/task-service.test.ts` (extended; in-memory domain + fake worker + **fake worktree-manager seam** + fake strategy) | worktree provisioning on running (the fake worker receives `cwd` = worktree path and `branch`); the task record gains `workspaceId`/`branch`/`baseCommit`; commit before `succeeded` (fake manager called with the task identity; commit failure → failed attempt with `task.commitFailed`, retryable); a succeeded task's worktree is removed, its branch kept; a failed task's worktree is kept; retry reuses the worktree (idempotent provision, no reset); non-Git project (`controlled-directory` source) → `cwd = project.root`, no worktree fields, manager never called; `worktreeManager === undefined` → Phase 4 behavior. Pipeline: all-succeeded + Git → run `integrating` (+ `run.integration.started`); fake strategy `integrated` → run record gains `integrationBranch`/`integrationHead`, `run.integration.completed`, run `validating` → `finalizing` → `succeeded` (resultSummary names the branch), task branches + integration worktree removed, integration branch kept; conflict → `run.integration.failed` (paths in detail) + run `blocked`, task branches intact; resume (`transitionRun` back to `integrating`) → previous integration worktree cleaned + strategy re-runs → `succeeded`; non-Git all-succeeded → run `finalizing` → `succeeded` (no integration branch); crash-safety leg: completed event + run still `integrating` → verify passes → `validating` without re-merging. |
| `tests/run-storage-integration.test.ts` (extended; real JSON domain + real Git fixture repo) | full pipeline on the real medium: two tasks whose fake workers write real files into real worktrees → all succeeded → integrating → the **real** `MergeInOrderStrategy` merges → succeeded; after a domain reopen the task `headCommit`s, the run's `integrationBranch`/`integrationHead`, and the integration events survive; the medium table set is unchanged. |
| `tests/workspace-manager.test.ts` (regression) | green after the `runGit` extraction (behavior unchanged). |
| `tests/rpc-handler.test.ts` (extended) | `runDetail.tasks[]` carries the additive Git fields when present (absent property when not); the run view carries `integrationBranch` when set; integration events appear in `runDetail.events`; no new endpoints. |
| `tests/dashboard-tasks-interactions.test.tsx` (extended, jsdom zh) | a task row renders the branch chip + commit short when present and nothing when not; the integration panel renders its zh state per phase (integrating/validating/finalizing/succeeded); a blocked integration shows the conflicting paths + the resume hint; the non-Git notice renders only for `controlled-directory` projects. |
| `tests/dashboard-i18n-regressions.test.tsx` | the new locale keys exist in both zh and en (existing parity mechanism). |
| regression | every existing suite green; the Phase 4 import-isolation source scan still passes (the Git modules add no runtime surface); parallel execution at `maxConcurrentAgents > 1` proven with disjoint **and** conflicting file sets (worktrees make it safe — the Phase 4 concurrency rationale is retired). |

## 13. Acceptance criteria (maps to `intent.md` §9.4)

1. (§9.4.1) Every live task of a Git project runs in its own worktree +
   branch with the §16 naming; the one-writer-per-worktree invariant holds
   (unique naming + identity check + `task.workspaceConflict` guard,
   tested); non-Git projects run in the shared tree with the explicit UI
   notice and no Git metadata.
2. (§9.4.2) Task work is committed onto the task branch before `succeeded`
   (dirty tree committed by the service; empty tree = no-commit success; no
   silently discarded work); `workspaceId`/`branch`/`baseCommit`/
   `headCommit` are real git results or absent, never fabricated.
3. (§9.4.3) All tasks succeeded → run `integrating` → the integrated branch
   is produced by the deterministic merge-in-order strategy in the
   integration worktree; a conflict is a structured failure (conflicting
   paths persisted in the event), never force-resolved; the
   default/protected branch is never touched (only `dsh/run-*` branches are
   created or deleted).
4. (§9.4.4) The completion pipeline is wired end-to-end on the existing
   state machine (no new phases): `integrating → validating → finalizing →
   succeeded`; a failed integration leaves the run `blocked` and a resume
   re-runs the integration deterministically from the immutable task
   branches.
5. (§9.4.5) Cleanup: a succeeded task's worktree is removed after its
   commit (branch kept); a terminal-succeeded run removes the task branches
   + the integration worktree and keeps the integration branch; failed /
   canceled runs keep worktrees for inspection; `stop()` removes nothing.
6. (§9.4.6) UI: per-task branch + head-commit chip, the integration panel
   (all phases + conflict detail), the integrated branch on success, the
   non-Git notice — zh/en parity compile-enforced, no fabricated Git data.
7. (§9.4.7) Storage: the new task/run fields + integration events survive a
   real JSON domain reopen; `dsh_projects` stays format version 0; the
   medium table set is unchanged.
8. (§9.4.8) Repo green: typecheck, build, `pnpm vitest run` (modulo the
   documented pre-existing environment failures); parallel execution at
   concurrency > 1 proven by tests.

## 14. Explicit non-goals (Phase 6+)

- No automatic push/PR of the integrated branch (master spec §17's
  “optional push → optional pull request → human review” stays optional:
  the branch is produced and shown; a human pushes/reviews from it).
- No interactive conflict-resolution UI — a conflict is a structured
  failure with persisted conflicting paths; resolution happens via resume
  (once the branches change) or a human's manual Git work in the
  integration worktree (kept on failure).
- No configurable validation command in the `validating` phase — MVP
  validation is structural (branch resolvable, worktree sound, task
  branches are ancestors of the integrated branch).
- No integration strategies beyond `MergeInOrderStrategy` (the seam exists;
  one implementation ships).
- No Project Memory (6). No `ApprovalRequest` objects, no budgets (7). No
  report artifacts (8). No triggers (9).
- No startup reconciliation of orphaned worktrees/branches (10) —
  `stop()` removes nothing; provisioning idempotency + the conflict guard
  make a restart safe; orphan pruning belongs to Phase 10.
- No monetary cost figures; token accounting only from native session
  usage (unchanged from Phase 4).
- `awaiting-review` remains unreachable (Phase 7 approval modes).
