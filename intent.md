# Intent — DSH Projects

**Gate:** Plan · **Status:** Phase 0 + Phase 1 delivered (this commit) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

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
| 1 | Project Run foundation — persistent runs, lifecycle, Runs tab | **done (this commit)** |
| 2 | Versioned RunPlans — `project_plans` table, `RunPlanService`, plan UI on RunInspector | next |
| 3 | Coordinator — Lead session driving plan creation via structured output | planned |
| 4 | Task DAG + team execution — `ProjectTaskService`, adapters over `ctx.agentTeams`/`ctx.subagents` | planned |
| 5 | Git isolation + integration — per-task worktrees, `dsh/run-<id>/<task>` branches | planned |
| 6 | Project Memory — `project_memory`, retrieval, distillation | planned |
| 7 | Approvals + budgets — `project_approvals`, budget enforcement | planned |
| 8 | Artifacts + final report — `project_artifacts`, report generation | planned |
| 9 | Triggers — TaskSource events → `ProjectTrigger` adapters | planned |
| 10 | Recovery + hardening — startup reconciliation | planned |
| 11 | UI polish — overview/agent/plan/memory/artifacts/automations pages | planned |

## 5. Phase 1 acceptance (verified in this commit)

- **Domain:** `dsh_projects` v0 with `runs` + `run_events` tables, strict zod schemas (UUID ids, `projectId` scoped to registered catalog projects).
- **Lifecycle:** pure 12-phase state machine (`src/runs/state-machine.ts`) as single transition authority; terminals `succeeded/failed/canceled`; suspended `paused/blocked` with `suspendedFrom`; side effects (version bump, `startedAt` once, `completedAt` on terminal, error/result capture) live in the state machine.
- **Service:** `ProjectRunService` — create (goal validation, project scoping), bounded newest-first snapshot projection, bounded event detail with `truncated`, compare-and-set transitions (`run.versionConflict`), per-run event append, Cordis events (`dsh-projects/run/created|phase-changed|completed`).
- **RPC (additive, trusted-host):** `runCreate`, `runDetail`, `runTransition`; `state`/`refresh` gain an optional `runs` section; snapshot version stays 2.
- **UI:** Runs tab (project 5-col / global 6-col table), lazy-loaded Run inspector with event history, phase-aware actions (pause/resume/cancel), New Run dialog; zh/en locale parity enforced at compile time; local-mode fixture.
- **Persistence survives restart — proven at two levels:** in-memory domain restart test (`tests/run-service.test.ts`) **and** a real-storage integration test (`tests/run-storage-integration.test.ts`) against a genuine Cordis Context + JSON file backend + `DomainFacility` (records + event history survive a domain close/reopen; tampered medium version is rejected loud).
- **Verification:** `pnpm run typecheck` PASS · `pnpm run build` PASS · `pnpm vitest run` 154 passed (only pre-existing macOS tmpdir realpath failures in `tests/project-catalog.test.ts`, documented at Phase 0) · live second `dsh web` instance verified booting on an alternate port with the auth fence intact.

### Phase 1 deliberately out of scope
No plans, no coordinator, no task DAG, no team/subagent spawning, no memory, no artifacts, no triggers, no budgets, no approval objects. Only forward-looking elements: the domain name and reserved record fields.

## 6. Next gate

**Design (Phase 2 — Versioned RunPlans):** formalize `spec.md`/`plan.md` for the `project_plans` table, `RunPlanService`, plan lifecycle, and the plan section of the Run inspector, per the sequencing table above.
