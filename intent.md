# Intent — DSH Projects

**Gate:** Intent · **Status:** Phase 0 + 1 + 2 delivered (released v0.8.0) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

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
| 3 | Coordinator — Lead session driving plan creation via structured output | **next** |
| 4 | Task DAG + team execution — `ProjectTaskService`, adapters over `ctx.agentTeams`/`ctx.subagents` | planned |
| 5 | Git isolation + integration — per-task worktrees, `dsh/run-<id>/<task>` branches | planned |
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

## 6. Phase 3 intent — Coordinator

**End state (master spec §73):** *a manual goal can be planned by the Coordinator.*

One action in the Run inspector hands a run to a **Coordinator Lead session**: a native Harness agent (same `ctx.agents.create` mechanism as the existing `HarnessAgentRunner`) that inspects real project state, decides *direct vs orchestrated*, and creates an **explicit, validated, versioned Run Plan** through the existing `RunPlanService`. No tasks execute in this phase — execution is Phase 4.

### 6.1 Capability slice (master spec §73 Phase 3)

1. **Coordinator policy** — a versioned guidance module (modular, versioned prompt sections per master spec §8 behavioral contract), not one hard-coded blob.
2. **Session association** — `coordinatorSessionId` on the run record (the reserved field the architecture doc §5.2 assigns to Phase 3; additive optional, domain stays v0). One Lead session per coordination attempt; created, flushed, and disposed like the existing runner.
3. **Project context assembly** — the prompt is assembled only from real state: project record, run (goal/phase/events), existing plan versions, repository metadata. No Project Memory yet (Phase 6).
4. **Direct-vs-orchestrated decision** — the coordinator selects one of the six orchestration patterns already in the Phase 2 plan model (direct, prompt-chain, parallel-workers, supervisor, router, evaluation-loop).
5. **Explicit plan creation** — the structured plan is captured via a host-registered tool in the session scope (the `defineTool` seam the plugin already uses for task sources), validated with the exact Phase 2 `createPlan` rules, and persisted via `RunPlanService.createPlan`. A run that already has plans yields the next version with a replan reason; plan content stays immutable.
6. **Result collection** — the session outcome (completed / blocked / error) and the coordinator's final summary are persisted on the run: a run event + `resultSummary`.
7. **Final report (Phase 3 part)** — a concise, human-readable planning summary (goal, decision, pattern, plan version, success criteria, risks) shown in the Run inspector. The full §64 report *artifact* is Phase 8.

### 6.2 Run-phase coupling (handed over from the Phase 2 spec non-goals)

All moves go through the existing run state machine (single authority); no new run phases:

- orchestrated plan, approval requested → run → `awaiting_approval`
- human approves the plan in the existing plan UI → plan active + run → `executing`
- human rejects → plan draft + run → `planning`
- direct plan, activated → run → `executing`
- failed or blocked coordinator session → run `blocked` (retryable: resume → `planning` → Coordinate again), error captured on the run

### 6.3 Non-goals (Phase 4+)

- No task execution, no `ProjectTask`, no task status — `PlannedTask` stays a plan object (Phase 4).
- No Agent Teams, no background subagents, no worker spawning (Phase 4, behind adapters).
- No per-task Git worktrees/branches (Phase 5). No Project Memory retrieval/injection (Phase 6).
- No `ApprovalRequest` objects, no budgets (Phase 7). No report artifacts (Phase 8).
- No interactive coordinator chat / user-correction loop (master spec §49) — Phase 3 coordination is one-shot per trigger; re-planning means triggering the coordinator again on a run that already has plans.
- No event-driven re-planning from task failures (requires execution — Phase 4).

### 6.4 Acceptance (intent level; each gate verifies its part)

1. The Coordinate action (zh `协调`) on a `created`/`planning` run starts a real Lead session; `coordinatorSessionId` is persisted on the run and survives restart.
2. The session's structured output produces a validated plan via `RunPlanService` — pattern persisted, ids assigned, replan reason required when versions exist; invalid or missing output never persists a plan.
3. The §6.2 run-phase coupling works end-to-end through the existing plan UI (no new UI flow for approvals).
4. The planning summary is visible in the inspector and persisted (event + `resultSummary`).
5. Session failure/blocked leaves the run retryable (`blocked` → resume → `planning`).
6. Storage integration: `coordinatorSessionId` + plans + run phase survive a real JSON domain reopen; medium table set unchanged (`['plans', 'run_events', 'runs']`).
7. Repo green: typecheck, build, `pnpm vitest run` (modulo the documented pre-existing environment failures).

### 6.5 Test plan (intent level; Design formalizes seams)

Coordinator policy (pure), structured-output parsing/validation, `CoordinatorService` against the real `RunPlanService` with the session mechanics isolated behind a narrow, fakeable seam, RPC endpoints (validation + absent-service), UI interactions (jsdom, zh labels), and the extended storage integration.

## 7. Next gate

**Design (Phase 3 — Coordinator):** formalize `spec.md` — the `coordinatorSessionId` field, `CoordinatorService` + policy module layout, the structured-output tool contract, the run-phase coupling mechanism, RPC endpoints, inspector UI (action + planning summary), and the full test plan, per the sequencing table above.
