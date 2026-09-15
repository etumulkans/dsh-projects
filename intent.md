# Intent — DSH Projects

**Gate:** Intent · **Status:** Phases 0–10 delivered (v0.16.0); Phase 11 (UI polish) **in progress** — the English-only localization slice (spec §10 step 1) is **done and merged** (PR #4, squash `015757c`, on `origin/main`) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

## 1. What we are doing

Evolve the existing `dsh-dashboard` Cordis plugin in this repository into **DSH Projects**: a project-level orchestration layer on top of DeepSeek Harness where a *project* owns a persistent, inspectable execution lifecycle (runs → plans → tasks → integration → memory → reports → automations).

The work proceeds as **vertical slices**: each phase delivers a thin, working, tested end-to-end capability (domain model → persistence → RPC → UI in the existing Dashboard) before the next one starts. No phase is started ahead of the previous one.

**This intent** covers the **remaining Phase 11 (UI polish) work** — spec §10 steps 2–5. The English-only localization slice (step 1, the user directive *"remove all chinese from any of ui"*) is already shipped: the `zh` dictionary is an English mirror of `en`, the UI renders English under either locale id, and the `dashboard-english-only` guard locks it in. What remains is to **add the missing surfaces, polish the existing ones, and verify responsive behavior** — all frontend, all backed by data the existing RPC surface already returns.

## 2. Why

Phases 1–10 built a durable, inspectable, *triggered* and *crash-safe* project runtime; Phase 11 step 1 made the Dashboard **English-only**. The runtime is functionally complete and the UI is now English-only, but several spec-required surfaces are still missing or rough:

- **No Project Overview surface.** The master spec's UX acceptance criteria require "Project Overview is useful." Today there is no dedicated overview — the `RuntimeRail` shows a few metrics, but there is no project-level summary (active runs, task health, recent activity, usage at a glance).
- **No Agent detail surface.** The UX criteria require "Agent detail is useful." Today a task's agent is only reachable through an "open session" link that jumps to the native Harness session; there is no in-dashboard agent detail (identity, session, worktree/branch, tokens, duration, retry history).
- **No usage summary.** The observability criteria require "Token usage is visible where supplied" + "Runtime/duration is visible." Token cells exist per task, but there is no consolidated **usage summary** (per-run and per-project token/duration rollups).
- **Automations is missing its deferred surface.** Phase 9 explicitly deferred two items to Phase 11: the **next-run** (`nextRunAt`) column and the **trigger detail view**. The `trigger.nextRun` locale key already exists; the column and detail view do not. `nextRunAt` is **not stored** — it is a documented additive read-only projection computed on the host side from the existing schedule slot logic; the fire history is an additive computed field (`recentFires`) on the existing `triggerGet` output (no new RPC endpoint).
- **Run/Plan/Task detail is functional but not polished.** The `RunInspector` (the largest surface) shows plans, tasks, approvals, and the event timeline, but the **Plan/DAG** is a flat list (no dependency visualization), the **approval UX** is a bare section (no clear pending/decided states, no audit trail), and the **error presentation** is not consistently "understandable" (the observability criterion).
- **Responsive behavior is not verified as a whole.** The surfaces were built for a desktop overlay; there is no systematic pass over **responsive behavior** (narrow overlay widths).

This slice **finishes the UI**: it adds the missing surfaces (Project Overview, Agent detail, usage summary, the deferred Automations next-run column + trigger detail view), polishes the existing ones (Run detail, Plan/DAG visualization, approval UX, Memory, Artifacts, understandable errors), and verifies **responsive** behavior. No new host-side capability, no new storage domain, no new RPC endpoint — this is a **frontend polish** phase (the only host-side change is the additive `nextRunAt` / `recentFires` projection on the existing trigger output).

## 3. Invariants (non-negotiable for every phase)

1. **No invented APIs.** Only native Harness/Cordis/Agent-Teams/subagent/storage primitives as installed in the profile are used. The UI consumes only data the existing `DashboardDataPort` RPC surface already returns (or a documented additive read-only projection if a surface genuinely needs one — decided in Design, never invented).
2. **No placeholder APIs that are never implemented. No fake UI data.** Every UI control shipped must be backed by real behavior and real (or explicitly fixture-labeled local-mode) data. A surface that cannot be backed by existing data is either deferred (recorded) or backed by a real additive read-only projection.
3. **No premature phases.** This slice ships only UI polish; Phase 12 (Remote Worker Provider) is not started.
4. **Preserve the existing Git worktree model** and all existing dashboard behavior; all changes are additive where the spec allows.
5. **Extend the native Dashboard UI** (one frontend, existing extension slots). No new app, no second shell.
6. **Orchestration state lives in code + persistent storage** (`dsh_projects` storage domain), never in ephemeral process state. This phase is frontend-only; it changes no storage schema (`dsh_projects` stays at format version 0 — the `nextRunAt` / `recentFires` projections are computed, not stored).
7. **The repo stays buildable and testable** at every commit: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green (modulo pre-existing environment failures documented at Phase 0).
8. **Single authority for state transitions.** The UI dispatches only through the existing typed `DashboardDataPort` RPCs; it never writes records directly.
9. **English-only UI (user directive — already shipped).** The Dashboard renders **English only**; every user-facing string is routed through the translator (no hard-coded literals, no CJK). New surfaces in this slice must follow the same rule (new keys in the `en` dictionary, the `zh` mirror kept byte-identical).

## 4. Phase roadmap

| Phase | Deliverable | State |
| --- | --- | --- |
| 0 | Baseline + architecture audit (`docs/dsh-projects-architecture.md`) | **done** |
| 1 | Project Run foundation — persistent runs, lifecycle, Runs tab | **done** |
| 2 | Versioned RunPlans — `plans` table, `RunPlanService`, plan UI on RunInspector | **done (v0.8.0)** |
| 3 | Coordinator — Lead session driving plan creation via structured output | **done (v0.9.0)** |
| 4 | Task DAG + team execution — `ProjectTaskService`, adapters over `ctx.agentTeams`/`ctx.subagents` | **done (v0.10.0)** |
| 5 | Git isolation + integration — per-task worktrees, `dsh/run-<id>/<task>` branches, run completion pipeline | **done (v0.11.0)** |
| 6 | Project Memory — `memory` store, retrieval, distillation, context budget, Memory UI | **done (v0.12.0)** |
| 7 | Approvals + budgets — approval modes, `project_approvals` table, code-enforced run budgets | **done (v0.13.0)** |
| 8 | Artifacts + final report — `project_artifacts` table, final-report generation, Artifacts UI | **done (v0.14.0)** |
| 9 | Trigger generalization — `project_triggers` + `trigger_fires`, 7 trigger types, idempotent fire, Automations UI | **done (v0.15.0)** |
| 10 | Recovery + hardening — startup reconciliation for runs/tasks/agents, plan-activation CAS, recovery + concurrency stress tests, security review | **done (v0.16.0)** |
| **11** | **UI polish** — English-only localization (**done, PR #4**) + Project Overview, Agent detail, usage summary, Automations (next-run + trigger detail), Run detail, Plan/DAG, approval UX, Memory, Artifacts, understandable errors, responsive behavior | **this intent (steps 2–5)** |
| 12 | Optional Remote Worker Provider — `WorkerProvider` abstraction (+ optional K8s/OpenShift behind a flag) | planned (optional) |

## 5. Scope — Phase 11 (UI Polish), remaining work (steps 2–5)

Per master spec §73 (PHASE 11 — UI POLISH). This is a **frontend polish** slice: it adds no new host-side capability, no new storage domain, and no new RPC endpoint. The only host-side change is the additive `nextRunAt` / `recentFires` projection on the existing trigger output. It is sequenced per spec §10:

### 5.1 Step 2 — the `nextRunAt` + `recentFires` projection (spec §5.4)

- **Host side** (`src/triggers/trigger-service.ts`, the one host-side change): the `triggerList` / `triggerGet` output computes:
  - `nextRunAt?: string` — for a `schedule` trigger with `config.everyMs`: `createdAt + (floor((now - createdAt) / everyMs) + 1) * everyMs`; with `config.cron`: the existing pure slot function; **absent** for non-schedule triggers (`manual`/`tracker`/`webhook`/`repository-event`/`pr-event`/`system`).
  - `recentFires?: readonly { readonly firedAt: string; readonly runId: string; readonly sourceEventKey: string }[]` — from the existing `trigger_fires` table, bounded to the most recent N, newest first.
- **Client side** (`src/client/controller.ts`): `TriggerView` gains the two additive optional fields; the `loadTriggers` / `loadTrigger` path maps the host projection.
- **No new RPC endpoint** — both are fields on the existing `triggerList` / `triggerGet` output (there is no `triggerFires` endpoint today; `triggerFire` *fires* a trigger).
- **Test** — extend `tests/trigger-service.test.ts`: a schedule trigger's `triggerGet` output carries a computed `nextRunAt` + bounded `recentFires`; a non-schedule trigger's `nextRunAt` is absent; `recentFires` is newest-first and bounded.

### 5.2 Step 3 — new surfaces (spec §5.1–5.3, §5.4)

- **Project Overview** (new tab, board remains the default) — a pure projection of the existing `DashboardSnapshot` (no new RPC): active runs (count + phase breakdown, most recent non-terminal highlighted), task health (running/ready/blocked/failed from `taskCounts` + `runtime`), recent activity (latest run events, bounded), usage at a glance (`runtime.tokens` + the selected run's `tokenUsage`), and the existing `buildAttentionSummary` alerts at the top.
- **Agent detail** (reached from a task row) — a pure projection of the existing `RunDetailView.tasks` (`ProjectTaskView`, no new RPC): identity (`assignedAgentId`, owning task, role), worktree/branch (`branch`/`baseCommit`/`headCommit`, "—" when absent), usage (`tokenUsage`/`turnCount`), runtime/duration (`startedAt`→`completedAt`, `status`), attempt history (`attempt`/`maxAttempts`, `error`), and the preserved "open session" CTA (`onOpenSession(sessionId)`).
- **Usage summary** (a section on the Overview + a per-run block on the Run detail) — a pure projection of existing `TokenTotals` (no new RPC): per-run (`tokenUsage` + duration), per-project (sum across the project's runs + `runtime.tokens`), per-task (the existing `TokenCell` reused).
- **Trigger detail view** (selecting a trigger opens a dialog/inspector) — the full config (per-type fields, credential-free), `goalTemplate`, `approvalMode`, `enabled`, `lastFiredAt`, `lastRunId` (link to the run), `nextRunAt`, and the `recentFires` fire history. The existing `onFireTrigger` / `onSetTriggerEnabled` / `onDeleteTrigger` actions are preserved.
- **New components** — `OverviewView`, `AgentDetailPanel`, `UsageSummary`, `TriggerDetailView`. **New `en` keys** — `overview.*`, `agent.*`, `usage.*`, `trigger.detail.*` (the `zh` mirror kept byte-identical). **New tests** — `dashboard-overview`, `dashboard-agent-detail`, `dashboard-usage`; extend `dashboard-automations` (the next-run column + trigger detail view).

### 5.3 Step 4 — polished surfaces (spec §5.5–5.10)

- **Run detail** — the `RunInspector` is refined so a user "can understand current progress without reading raw session logs": clear phase/state (`phase` + `suspendedFrom` + version + the phase-change timeline), task progress (status + succeeded/total + the current task highlighted), the §5.2 Agent detail per task row, the §5.3 per-run usage block, and an understandable event timeline (every event type — including Phase 10's `task.interrupted` / `run.recovered` — rendered as a human-readable row, not a raw code).
- **Plan/DAG** — the plan is rendered as a **dependency DAG** (not a flat list): each `PlannedTask` as a node (labeled `id` `t1`..`tN` + `title`, status-colored from the matching `ProjectTaskView` by `planTaskId === PlannedTask.id`), each `PlannedTask.dependencies` as a directed edge, a deterministic left-to-right layered layout (topological order by dependency depth, ties by `planTaskId`), rendered with **CSS** (no external graph library), the current task highlighted; a linear plan (no dependencies) degenerates to a vertical list (no visual regression).
- **Approval UX** — the approval section is refined: each `ApprovalRequestView` shows its `status` (`pending`/`approved`/`rejected`/`expired`) with a clear visual state, the run's `approvalMode`, the `type` + `summary`, the audit trail (`requestedAt`/`resolvedAt`/`resolvedBy`), and the `onResolveApproval` action enabled only for `pending`.
- **Memory** — the Memory page is refined: the query input wired to `MemoryListInput.query`, the kind/status filters shown and applied, the entry detail (body, `tags`, provenance links, `confidence`, `pinned`, `supersedes`), and consistent create/edit flows.
- **Artifacts** — the Artifacts page is refined: provenance (`runId`/`taskId` links, `kind`, `title`), the highlighted `final-report` (the existing `FinalReportDocument` preserved), a consistent `ArtifactDetail`, and a consistent `AddArtifactDialog`.
- **Understandable errors** — domain errors render as human-readable messages: the existing `dashboardErrorMessage` (`src/client/errors.ts`) maps `DashboardDomainError.dashboardCode` + `params` to a localized message; the UI renders that message (not the raw code) in every error surface, with `params` interpolated.
- **New/refactored components** — `PlanDag`, `ApprovalSection` (refactored); existing components refined in place. **New `en` keys** — `plan.dag.*`, `approval.*` (the `zh` mirror kept byte-identical). **Extended tests** — `dashboard-plans-interactions` (the DAG), `dashboard-approvals` (the approval UX), `dashboard-render` (the run detail).

### 5.4 Step 5 — responsive pass (spec §5.11)

A systematic pass over **responsive behavior**: the surfaces must be usable at the narrow overlay widths the native Harness shell provides (no horizontal overflow, sensible column collapse, dialogs that fit). The board / run list / trigger list collapse to a single column below a breakpoint; the DAG wraps; the Overview metrics stack. Verified by the jsdom UI suites at a narrow viewport (the `dashboard-render` suite asserts no element overflows the container width at a narrow width).

### 5.5 Step 6 — green gate

`pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` all pass (modulo the pre-existing, documented environment failures).

### 5.6 Explicit non-goals for this slice

- **No new host-side capability, no new storage domain, no new table/field, no migration** — `dsh_projects` stays at format version 0 (the `nextRunAt` / `recentFires` projections are computed, not stored).
- **No new RPC endpoint** — only the additive `nextRunAt` + `recentFires` fields on the existing trigger output.
- **No Phase 12** (Remote Worker Provider) — that is the optional next phase.
- **No re-implementation of the native session view** — the "open session" action still jumps to the native Harness session; the Agent detail surface is an in-dashboard summary, not a replacement.
- **No new backend reconciliation or concurrency work** — Phase 10 is done; this phase is frontend-only.
- **No external graph/DAG library** — the Plan/DAG is rendered with CSS (the plan's task count is small).

## 6. Acceptance criteria (this slice)

1. **Automations is finished.** The `nextRunAt` column (schedule trigger shows a value, non-schedule shows "—") and the trigger detail view (config + `recentFires` fire history + `lastFiredAt`/`lastRunId`) are present (the Phase 9 deferral is closed); the host-side projection is covered by the `trigger-service` test.
2. **Project Overview is useful.** A dedicated overview surface shows active runs, task health, recent activity, and usage at a glance, backed by real snapshot data.
3. **Agent detail is useful.** An in-dashboard agent detail surface shows identity, session, worktree/branch, tokens, duration, and attempt history, with the "open session" action preserved.
4. **Usage summaries are visible.** Per-run and per-project token/duration rollups are shown.
5. **Plan/DAG is visualized.** The plan renders as a dependency DAG (nodes + edges, status-colored), not a flat list; a linear plan degenerates to a list (no regression).
6. **Approval UX is clear.** Pending/decided states, mode, requester, decision + timestamp (audit), and the resolve action are presented clearly.
7. **Errors are understandable.** Domain errors render as human-readable messages (not raw codes).
8. **Responsive behavior.** The surfaces are usable at narrow overlay widths (no overflow, sensible collapse) — verified by the jsdom suites.
9. **English-only is preserved.** New surfaces route every string through the translator (new `en` keys, the `zh` mirror byte-identical); the `dashboard-english-only` guard still passes.
10. **The repo stays green:** `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` pass (modulo the pre-existing, documented environment failures). The existing UI suites all pass.

## 7. Next gate

**Design (Phase 11 — UI polish, steps 2–5):** formalize `spec.md` for the remaining work — the exact host-side `nextRunAt` / `recentFires` projection (the schedule slot reuse + the `trigger_fires` read, bounded/newest-first) and the client `TriggerView` additive fields; the exact data backing for each new surface (Overview / Agent detail / usage summary / trigger detail — all from the existing `DashboardSnapshot` / `RunDetailView` / `TokenTotals` / `TriggerView`, no new RPC); the Plan/DAG CSS layout approach (layered, topological, deterministic); the approval UX states; the understandable-error presentation; the responsive breakpoints; and the full test plan (the new-surface suites, the extended automations/plans/approvals/render suites, and the `trigger-service` projection test).
