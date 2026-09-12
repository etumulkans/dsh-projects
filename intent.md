# Intent — DSH Projects

**Gate:** Intent · **Status:** Phases 0–4 delivered (v0.10.0 released; `etumulkans/dsh-projects` PR #2 merged) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

## 1. What we are doing

Evolve the existing `dsh-dashboard` Cordis plugin in this repository into **DSH Projects**: a project-level orchestration layer on top of DeepSeek Harness where a *project* owns a persistent, inspectable execution lifecycle (runs → plans → tasks → integration → memory → reports).

The work proceeds as **vertical slices**: each phase delivers a thin, working, tested end-to-end capability (domain model → persistence → RPC → UI in the existing Dashboard) before the next one starts. No phase is started ahead of the previous one.

## 2. Why

The dashboard today observes and schedules *tasks* (task sources, local store, Git worktree model) but cannot own a *project goal* over time. DSH Projects makes the harness a project runtime: a goal becomes a Run, a Run can carry a versioned Plan, a Plan decomposes into a Task DAG executed in isolated Git worktrees, and the whole lifecycle persists, survives restarts, and is inspectable in the GUI without a second frontend.

## 3. Invariants (non-negotiable for every phase)

1. **No invented APIs.** Only native Harness/Cordis/Agent-Teams/subagent/storage primitives as installed in the profile are used. Experimental APIs (`ctx.agentTeams`, `ctx.subagents`) are touched only behind adapter isolation (Phase 4) and never imported speculatively.
2. **No placeholder APIs that are never implemented. No fake UI data.** Every RPC endpoint, service method, and UI control shipped must be backed by real behavior and real (or explicitly fixture-labeled local-mode) data.
3. **No premature phases.** Each slice ships only its own capability; later-phase tables/fields appear only where the architecture doc explicitly says so (domain name, reserved record fields).
4. **Preserve the existing Git worktree model** and all existing dashboard behavior; all changes are additive where the spec allows.
5. **Extend the native Dashboard UI** (one frontend, existing extension slots). No new app, no second shell.
6. **Orchestration state lives in code + persistent storage** (`dsh_projects` storage domain), never in ephemeral process state. State must survive a process restart.
7. **The repo stays buildable and testable** at every commit: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green (modulo pre-existing environment failures documented at Phase 0).

## 4. Phase roadmap

| Phase | Deliverable | State |
| --- | --- | --- |
| 0 | Baseline + architecture audit (`docs/dsh-projects-architecture.md`) | **done** |
| 1 | Project Run foundation — persistent runs, lifecycle, Runs tab | **done** |
| 2 | Versioned RunPlans — `plans` table, `RunPlanService`, plan UI on RunInspector | **done (v0.8.0)** |
| 3 | Coordinator — Lead session driving plan creation via structured output | **done (v0.9.0)** |
| 4 | Task DAG + team execution — `ProjectTaskService`, adapters over `ctx.agentTeams`/`ctx.subagents` | **done (v0.10.0)** |
| 5 | Git isolation + integration — per-task worktrees, `dsh/run-<id>/<task>` branches, run completion pipeline | **next** |
| 6 | Project Memory — `project_memory`, retrieval, distillation | planned |
| 7 | Approvals + budgets — `project_approvals`, budget enforcement | planned |
| 8 | Artifacts + final report — `project_artifacts`, report generation | planned |
| 9 | Triggers — TaskSource events → `ProjectTrigger` adapters | planned |
| 10 | Recovery + hardening — startup reconciliation | planned |
| 11 | UI polish — overview/agent/plan/memory/artifacts/automations pages | planned |

## 5. Phase 2 acceptance (delivered, verified in `6118085` + `6cccc3c`)

- **Domain:** additive `plans` table in `dsh_projects` (format version stays 0) + optional `run.activePlanId`; strict zod schemas; single open domain shared with the run service.
- **Lifecycle:** pure plan state machine (`draft → awaiting-approval → active → superseded/completed`), immutable content, CAS `revision` bumping only on terminal moves; replan = new version with `replanReason` + `supersedesPlanId`.
- **Run coupling:** activation supersedes the prior active plan with the new plan's stored reason, moves `run.activePlanId`, appends `plan.*` + `run.replanned` events on the shared per-run event stream; 7 Cordis events fire.
- **RPC (additive):** `planCreate`/`planList`/`planDetail`/`planTransition` returning records; uuid/enum/revision validation; absent-service bad-requests; `plan.*` error codes (14, incl. the documented `plan.contentInvalid` deviation).
- **UI:** inspector Plans section (versions, status, expandable detail, per-status actions), New Plan dialog (pattern, tasks with earlier-only dependencies), Supersede dialog; zh/en parity compile-enforced.
- **Verification:** all 7 spec §11 acceptance criteria pass; `test-report.md` committed in the test stage; storage integration proves plans + `activePlanId` survive a real JSON domain reopen.

## 6. Phase 3 acceptance (delivered, verified in `ca790fc` + `6449cb1`)

- **Domain:** additive optional `coordinatorSessionId` (plain `dsh-coordinator-<uuid>` string) on the run record + 3 run event types (`run.coordinator.started/completed/failed`) + 3 Cordis events; **no new tables** — the domain stays format v0 with the same medium table set.
- **Coordinator:** `CoordinatorService` (single `coordinate()` entry, one session per attempt, in-flight guard) + pure policy module (versioned guidance/prompt with UNTRUSTED-DATA warning) + `HarnessCoordinatorDriver` mirroring `HarnessAgentRunner` (native `ctx.agents.create`, `dsh_projects_submit_plan` tool via `defineTool`, `whenIdle`/`flush`/turn-end/`dispose`) behind a fakeable `CoordinatorDriver` seam.
- **Plans:** submissions run through the full Phase 2 `createPlan` validation (rejections go back to the agent as tool errors; only valid output persists); one submission per session; replan requires a reason; summary non-blank ≤1000 chars, persisted as the `completed` event detail (not part of the plan record).
- **Run coupling:** awaited `onPlanStatus` hook on `RunPlanService` + `PlanRunCoupler` (guard-miss = logged no-op): direct → plan `active` + run `executing`; orchestrated → plan `awaiting-approval` + run `awaiting_approval` (existing plan UI completes approve/reject); completed-without-plan / driver failure → run `blocked` (retryable: resume → `planning` → Coordinate again).
- **RPC/UI:** additive `runCoordinate` (uuid validation, 4 structured `coordinator.*` error codes); inspector 协调/Coordinate action (created/planning only) + Coordinator section (status, session tail, planning summary); zh/en parity compile-enforced.
- **Verification:** all 7 spec §12 acceptance criteria pass; `test-report.md` committed in the test stage; storage integration proves session id + plans + phase + coordinator events survive a real JSON domain reopen.

## 7. Phase 4 intent — Task DAG + team execution

**End state (master spec §73):** *Coordinator can execute several dependent/parallel tasks.*

An **active** plan's `PlannedTask` list becomes a live **ProjectTask** DAG: dependency-gated scheduling, execution by real Harness agents behind adapters (Agent Teams when the composition mounts them, background subagents otherwise), with task/agent state, retries, and lifecycle visible in the Dashboard. No worktree isolation yet — that is Phase 5.

### 7.1 Capability slice (master spec §73 Phase 4)

1. **ProjectTask domain** — additive `tasks` table in `dsh_projects` (format version stays 0; storage-domain initializes absent declared tables empty). Spec §11 record: `runId`, `title`/`description`, `role?`, `dependencies` (task ids), status `pending|ready|running|blocked|awaiting-review|succeeded|failed|canceled`, `assignedAgentId?`, `workspaceId?` (**reserved** — filled by Phase 5), `acceptanceCriteria`, `attempt`, `maxAttempts?`, `outputSummary?`, `error?`, `tokenUsage?` (only when the runtime provides usage — spec §29, never invented), timestamps, `version` (CAS on the domain write chain, same pattern as runs/plans).
2. **Materialization** — when a plan becomes `active` (through the Phase 3 `onPlanStatus` hook), its tasks materialize 1:1 into `ProjectTask` rows, dependencies resolved from plan positions (`t1..tn`) to task ids. Superseding the active plan version retires its task set (never resurrected; the new version materializes fresh). An invalid DAG (cycle, unknown dependency) is rejected at materialization with a structured error — invalid task sets are never persisted.
3. **DAG scheduling** — a pure scheduler module: dependency validation, cycle detection, ready calculation, concurrency limits, retry backoff — **generalizing the existing `src/orchestrator/scheduling.ts` helpers** (`failureRetryDelay`, `stateLimit`) rather than building a parallel mechanism (spec §12). A pure task state machine is the single authority (unit-tested, CAS on `version`) — the same pattern as the run and plan machines. A task is **ready only when all required dependencies succeeded**; a permanently failed dependency → dependent tasks **blocked**. Transitions are idempotent (re-entry is a rejected no-op, not a silent re-run).
4. **Execution adapters (spec §13/§14/§31)** — a narrow worker seam (the Phase 3 `CoordinatorDriver` pattern, fakeable in tests):
   - `TeamRuntimeAdapter` — the **only file** that may touch the experimental `ctx.agentTeams` surface (architecture doc §4). Bound at startup when the host composition mounts it; structural typing inside the adapter file — **no new package dependency** (the plugin's dependency list is unchanged; the experimental package is host-mounted, not imported).
   - `BackgroundAgentAdapter` — thin adapter over the stable `ctx.subagents`: start / collect / list / stop / message / observe-completion (spec §14). No reimplemented process management.
   - The MVP worker provider is the local Harness worker (spec §31); the seam keeps Docker/remote/K8s providers possible later without touching orchestration.
   - **Honest degradation:** when neither runtime is available in the composition, task execution is *explicitly* unavailable — a structured RPC error + a UI state that says so. No fake agents, no silent no-ops (invariant 2).
5. **Agent roles (spec §15)** — roles are plan/coordinator-selected **labels + guidance**, not hard-coded limits; role → agent-profile/model mapping is an optional additive configuration through the existing preset mechanism (no hard-coded provider or model names).
6. **Task assignment + retries** — ready tasks are assigned to a live agent (`assignedAgentId`); `attempt` increments per execution; `maxAttempts` bounds retries with the generalized backoff; exhausted attempts → task `failed`; a concise `outputSummary` persists on success.
7. **Agent lifecycle UI** — Runs inspector **Tasks** section: per-task status in a DAG-aware list (dependencies shown), role, attempt, output summary, error, and agent activity (session identity + turn/token projections where the runtime exposes them — spec §14/§29; never fabricated). zh/en parity compile-enforced.
8. **RPC (additive)** — `runDetail` gains the run's tasks (additive optional field); the snapshot runs summary carries task counts; a `taskRetry` endpoint re-queues a failed task; run cancellation propagates to in-flight tasks/agents.
9. **Run coupling** — no new run phases. An unrecoverable task failure (one that blocks the DAG) → run `blocked` (retryable via the existing resume path). **Intent-level decision (Design confirms):** when all tasks of the active plan succeed, the run stays `executing` — the run completion pipeline (`integrating → validating → finalizing → succeeded`) arrives with Phase 5's integration; Phase 4 exposes task-level terminal state and run-level aggregation.

### 7.2 Concurrency safety (shared tree, pre-Phase 5)

Phase 4 tasks run in the project's existing working tree — no per-task worktrees until Phase 5. Therefore **the default concurrency limit is 1** (serial execution); the limit is configurable per run (spec §12) and the effective limit is visible in the UI. This bounds shared-tree risk until isolation lands.

### 7.3 Non-goals (Phase 5+)

- No per-task worktrees/branches, one-writer-per-worktree invariant, integration worktree/strategy, Git metadata in UI (Phase 5).
- No Project Memory (6). No `ApprovalRequest` objects, no budgets (7). No report artifacts (8). No triggers (9).
- No startup reconciliation of orphaned tasks/agents (Phase 10) — disposal on `stop()` is in scope; cross-restart agent reconciliation is not.
- No interactive re-planning loop from task failures (master spec §49) — a blocked run is retried or re-planned through the existing Phase 3 coordinate/replan paths.
- No monetary cost figures (spec §29: cost = unknown unless a reliable source exists); token accounting only from native session usage.

### 7.4 Acceptance (intent level; each gate verifies its part)

1. Tasks materialize 1:1 from the active plan version with resolved dependencies; invalid DAGs are rejected at materialization (never persisted); a replan retires the prior task set.
2. DAG semantics hold: ready only when all dependencies succeeded; a permanently failed dependency blocks dependents; cycle detection rejects cycles; transitions are idempotent.
3. Ready tasks execute on real agents behind adapters (fakeable in tests); task status, `assignedAgentId`, `attempt` persist; retries respect `maxAttempts` with backoff generalized from `orchestrator/scheduling.ts`.
4. The agent lifecycle is inspectable in the inspector (task status/role/attempt/summary/error; agent activity from real runtime data); zh/en parity.
5. Honest degradation: composition without an agent runtime → explicit "execution unavailable" state in RPC + UI; no fake agents.
6. Storage integration: tasks + task events survive a real JSON domain reopen; medium table set `['plans','run_events','runs','tasks']`; domain stays format v0.
7. Repo green: typecheck, build, `pnpm vitest run` (modulo the documented pre-existing environment failures).

### 7.5 Test plan (intent level; Design formalizes seams)

Pure scheduler/DAG module (validation, cycles, ready calculation, blocking, idempotency); task state machine transition table; `ProjectTaskService` against the in-memory domain harness with the fake worker seam (materialization, scheduling, retry, cancel, restart persistence); adapter contract tests against fakes of the runtime surfaces (plus import isolation: only the adapter file touches the experimental surface); additive RPC endpoints (validation + absent-service); jsdom UI interactions (zh labels); extended storage integration (tasks survive a real JSON reopen; medium table set).

## 8. Next gate

**Design (Phase 4 — Task DAG + team execution):** formalize `spec.md` — the `tasks` table schema, the task state machine, materialization/retirement rules, the scheduler module (reuse/generalize `orchestrator/scheduling.ts`), the worker seam + `TeamRuntimeAdapter`/`BackgroundAgentAdapter` contracts and runtime availability detection, the role configuration, the additive RPC surface, the inspector Tasks section, the run-coupling decision (§7.1 item 9), and the full test plan, per the sequencing table above.

## 9. Phase 5 intent — Git isolation + integration

**End state (master spec §73):** *parallel coding Agents safely produce an
integrated branch.*

Phase 4 executes tasks in the project's existing working tree (default
concurrency 1, §7.1 item 9). Phase 5 gives every live task its own Git
worktree + branch (one writer per worktree), commits the task's work onto
its branch, integrates the task branches in a dedicated integration
worktree, and drives the run through the already-declared
`integrating → validating → finalizing → succeeded` phases (Phase 1 state
machine — no new run phases). Git metadata becomes inspectable in the
Dashboard. Master spec anchors: §16 (Git workspace model), §17 (integration
strategy), §73 Phase 5.

### 9.1 Capability slices (master spec §73 Phase 5)

1. **Worktree provisioning** — when a task enters `running`, a worktree is
   provisioned from the project repository: directory
   `<projectRoot>/worktree/run-<shortRunId>/<taskLeaf>`, branch
   `dsh/run-<shortRunId>/<taskLeaf>` (spec §16 naming), created from the
   run's base commit (Design: recorded at materialization). `taskLeaf` is
   derived from the plan position (`t1…tn`) through the existing
   `path-safety` leaf normalization — never from task text (spec §16:
   "Never trust task text directly as a filesystem path"). The existing
   `WorkspaceManager` + `path-safety` (containment, symlink protection) is
   reused, not reinvented (invariant 4). The reserved `workspaceId` field
   is filled with the real worktree identity (path + branch).
2. **One writer per worktree** — a worktree is allocated exclusively to one
   live task; the allocation is persisted (part of the task record) and the
   scheduler enforces exclusivity: a task is never scheduled onto an
   already-allocated worktree, and reallocation happens only after the
   previous task is terminal and cleaned up. Enforced by construction +
   tested, not by convention (spec §16 default rule).
3. **Task commits** — a task's work is committed onto its branch before the
   task may reach `succeeded`: the worker adapter commits on completion —
   agent-made commits stay as-is; a dirty tree at task end is committed by
   the adapter with a deterministic message (`dsh task <shortTaskId>:
   <title>`) so no work is silently discarded; an empty tree (no changes)
   is a legitimate success with no commit. The task record gains additive
   optional Git metadata: `branch`, `baseCommit`, `headCommit?` — real
   `git` results only, never fabricated (invariant 2).
4. **Non-Git projects degrade honestly** — a project root that is not a Git
   repository cannot be isolated: its tasks run in the shared working tree
   (Phase 4 behavior), the UI states "no Git isolation" explicitly, and no
   worktree/branch metadata is shown. No fake Git data (invariant 2).
5. **Integration** — when all coding tasks of the active plan succeed, the
   run moves `executing → integrating` (existing edge) and a dedicated
   integration step (not a user-planned task; Design decides its
   representation) runs in a dedicated worktree
   `<projectRoot>/worktree/run-<shortRunId>/integration` (branch
   `dsh/run-<shortRunId>/integration`, spec §16/§17): task branches are
   applied in plan order (the MVP strategy is deterministic
   merge-in-order; spec §17's "configurable strategy" is honored by
   keeping the strategy behind a seam, but only the deterministic path is
   shipped), conflicts are a structured failure with the conflicting paths
   persisted in the event detail — never force-resolved — then validation
   runs (spec §17). **The repository's default/protected branch is never
   touched** (spec §17); the only output is the integrated branch.
6. **Run completion pipeline** — the existing Phase 1 phases are wired
   end-to-end: all tasks succeeded → `integrating`; integration succeeded →
   `validating`; validation passed → `finalizing` (cleanup + final state
   persisted) → `succeeded`. Integration/validation failure → run
   `blocked` (retryable via the existing resume path — resume re-runs the
   integration from the immutable task branches; Design sets the
   blocked-vs-failed boundary). A dead task DAG keeps Phase 4's `blocked`.
7. **Cleanup** — a terminal run removes its task worktrees + branches and
   keeps the integrated branch (spec §17 output); a failed run keeps
   worktrees + branches for inspection (retention is persisted, not
   guessed). `stop()` removes what the process owns; cross-restart
   reconciliation of orphaned worktrees is Phase 10 (provisioning is
   idempotent — a same-identity worktree/branch is verified and reused —
   so a restart can resume without corruption).
8. **Git metadata in the UI** — task rows show branch + head-commit short
   (only when real); the run inspector shows the integration state
   (running/succeeded/failed + conflicting paths on failure), the
   integrated branch name, and the cleanup state. zh/en parity
   compile-enforced. No fabricated Git data (invariant 2).
9. **RPC (additive)** — `runDetail` tasks carry the Git metadata (additive
   optional fields); integration progress comes from additive run event
   types (`run.integration.started/completed/failed` + Cordis events, the
   Phase 3 coordinator-event pattern); no new endpoint beyond what Design
   requires (integration re-run rides the existing run resume path).

### 9.2 Concurrency (real parallelism, now safe)

Worktrees are what make per-task parallelism safe (spec §16 premise): the
per-run concurrency limit (Phase 4; default 1, `run.maxConcurrentAgents`)
now governs true parallel coding agents. The default stays 1 (conservative
on shared machines); the tests prove parallel execution at limit > 1
(disjoint + conflicting file sets). One writer per worktree is enforced by
allocation, not by convention.

### 9.3 Non-goals (Phase 6+)

- No automatic push/PR of the integrated branch — spec §17's "optional
  push → optional pull request → human review" stays optional: the branch
  is produced and shown; a human pushes/reviews from it. (Carried to a
  later phase; no `gh`/remote coupling in this slice.)
- No interactive conflict-resolution UI — a conflict is a structured
  failure with persisted conflicting paths; resolution happens via the
  resume path or a human's manual Git work on the branch.
- No Project Memory (6). No `ApprovalRequest` objects, no budgets (7). No
  report artifacts (8). No triggers (9).
- No startup reconciliation of orphaned worktrees/branches (10) — `stop()`
  removes what it owns; provisioning idempotency makes a restart safe.
- No monetary cost figures; token accounting only from native session
  usage (unchanged from Phase 4).

### 9.4 Acceptance (intent level; each gate verifies its part)

1. Every live task in a Git project runs in its own worktree + branch
   (spec §16 naming); the one-writer-per-worktree invariant holds
   (allocation exclusivity, tested); non-Git projects run in the shared
   tree with an explicit UI notice and no Git metadata.
2. Task work is committed onto the task branch before `succeeded` (no
   silently discarded work; empty tree = no-commit success); Git metadata
   (branch, base/head commits) is real or absent, never fabricated.
3. All tasks succeeded → run `integrating` → the integrated branch is
   produced by the deterministic merge-in-order strategy in the
   integration worktree; a conflict is a structured failure (conflicting
   paths persisted), never force-resolved; the default/protected branch is
   never touched.
4. The completion pipeline is wired end-to-end on the existing state
   machine (no new phases): `integrating → validating → finalizing →
   succeeded`; a failed integration leaves the run `blocked` and a resume
   re-runs the integration from the immutable task branches.
5. Cleanup: a terminal run removes task worktrees + branches and keeps the
   integrated branch; a failed run keeps them for inspection; `stop()`
   removes what it owns.
6. UI: per-task branch + head-commit, integration state + conflicting
   paths, integrated branch name — zh/en parity compile-enforced, no
   fabricated Git data.
7. Storage: Git metadata + integration events survive a real JSON domain
   reopen; `dsh_projects` stays format version 0.
8. Repo green: typecheck, build, `pnpm vitest run` (modulo the documented
   pre-existing environment failures); parallel execution at concurrency
   > 1 proven by tests.

### 9.5 Test plan (intent level; Design formalizes seams)

A pure Git-workspace module (branch/worktree naming normalization, leaf
safety, allocation exclusivity) against fixture Git repositories (real
`git` CLI in a temp repo — the existing `workspace-manager` test pattern);
`task-service` tests extended for the worktree lifecycle (provision on
`running`, commit on success, empty-tree success, cleanup on terminal,
non-Git degradation); an integration-strategy module (merge-in-order over
disjoint + overlapping changes, the conflict case with persisted paths);
the run pipeline coupling (all-succeeded → `integrating` →
`succeeded`; conflict → `blocked` → resume → re-integration from the
unchanged task branches); additive RPC (validation + absent-service); jsdom
UI interactions (zh labels for branch/integration rows, the non-Git
notice); extended storage integration (Git metadata + integration events
survive a real JSON reopen; medium table set unchanged).

## 10. Next gate

**Design (Phase 5 — Git isolation + integration):** formalize `spec.md` —
the worktree provisioning module (naming, base commit, idempotent
reuse), the one-writer allocation registry, the task-commit contract, the
integration strategy module (merge-in-order, conflict detection), the
run-completion pipeline coupling, cleanup/retention rules, the additive
storage fields + run event types, the RPC surface, the inspector Git
metadata section, the non-Git degradation path, and the full test plan,
per the sequencing table above.
