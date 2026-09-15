# Intent — DSH Projects

**Gate:** Intent · **Status:** Phases 0–10 delivered (v0.16.0 released; Phase 10 shipped on `main` @ `e82a390`, pushed to `origin/main`) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

## 1. What we are doing

Evolve the existing `dsh-dashboard` Cordis plugin in this repository into **DSH Projects**: a project-level orchestration layer on top of DeepSeek Harness where a *project* owns a persistent, inspectable execution lifecycle (runs → plans → tasks → integration → memory → reports → automations).

The work proceeds as **vertical slices**: each phase delivers a thin, working, tested end-to-end capability (domain model → persistence → RPC → UI in the existing Dashboard) before the next one starts. No phase is started ahead of the previous one.

## 2. Why

Phases 1–10 built a durable, inspectable, *triggered* and *crash-safe* project runtime: persistent runs, versioned plans, a coordinator, a task DAG executed by native Harness agents, per-task Git worktrees, project memory, approvals + budgets, artifacts + final reports, seven trigger types that start runs automatically, and a startup reconciliation pass that makes the in-flight execution survive a process restart. The runtime is functionally complete and hardened.

What it does **not** yet do is present that runtime as a **finished, polished, English-only product surface**. The Dashboard already ships every major surface (Runs, RunInspector, Plans, Tasks, Memory, Artifacts, Automations, Configuration) — but several are working-but-rough, and a few spec-required surfaces are missing entirely:

- **No Project Overview surface.** The master spec's UX acceptance criteria require "Project Overview is useful." Today there is no dedicated overview — the `RuntimeRail` shows a few metrics, but there is no project-level summary (active runs, task health, recent activity, budget/usage at a glance).
- **No Agent detail surface.** The UX criteria require "Agent detail is useful." Today a task's agent is only reachable through an "open session" link that jumps to the native Harness session; there is no in-dashboard agent detail (identity, session, worktree/branch, tokens, duration, retry history).
- **No usage summary.** The observability criteria require "Token usage is visible where supplied" + "Runtime/duration is visible." Token cells exist per task, but there is no consolidated **usage summary** (per-run and per-project token/duration/cost rollups).
- **Automations is missing its deferred surface.** Phase 9 explicitly deferred two items to Phase 11: the **next-run** (`nextRunAt`) column and the **trigger detail view**. The `trigger.nextRun` locale key already exists; the column and detail view do not.
- **Run/Plan/Task detail is functional but not polished.** The `RunInspector` (the largest surface, ~800 lines) shows plans, tasks, approvals, and the event timeline, but the **Plan/DAG** is a flat list (no dependency visualization), the **approval UX** is a bare section (no clear pending/decided states, no audit trail), and the **error presentation** is not consistently "understandable" (the observability criterion).
- **The UI is bilingual (zh + en) and the standalone fallback is Chinese.** The user has directed that **the UI be English-only**: remove all Chinese from the UI. Today `locales.ts` carries a full `zh` dictionary (the source-of-truth key set + standalone fallback), `createDashboardTranslator('zh')` is the fallback, the dev harness renders in Chinese, and the Harness locale seat registers both `{ zh, en }`. This phase makes the Dashboard **English-only**.
- **Responsive behavior and localization parity are not verified as a whole.** The surfaces were built for a desktop overlay; there is no systematic pass over **responsive behavior** (narrow overlay widths) and **localization** (now: English-only consistency — every string routed through the translator, no hard-coded Chinese, no missing keys).

Phase 11 **finishes the UI**: it adds the missing surfaces (Project Overview, Agent detail, usage summary, the deferred Automations next-run column + trigger detail view), polishes the existing ones (Plan/DAG visualization, approval UX, understandable errors), and makes the whole Dashboard **English-only** (removing the Chinese locale) with verified **responsive** behavior. No new host-side capability, no new storage domain, no new RPC surface beyond what the existing data already supports — this is a **frontend polish + localization** phase.

## 3. Invariants (non-negotiable for every phase)

1. **No invented APIs.** Only native Harness/Cordis/Agent-Teams/subagent/storage primitives as installed in the profile are used. The UI consumes only data the existing `DashboardDataPort` RPC surface already returns (or a documented additive read-only RPC if a surface genuinely needs a new projection — decided in Design, never invented).
2. **No placeholder APIs that are never implemented. No fake UI data.** Every UI control shipped must be backed by real behavior and real (or explicitly fixture-labeled local-mode) data. A surface that cannot be backed by existing data is either deferred (recorded) or backed by a real additive read-only RPC.
3. **No premature phases.** This slice ships only UI polish + English-only localization; Phase 12 (Remote Worker Provider) is not started.
4. **Preserve the existing Git worktree model** and all existing dashboard behavior; all changes are additive where the spec allows. Removing the Chinese locale is the one intentional *reduction* (a user directive), and it must not break the Harness locale seat contract.
5. **Extend the native Dashboard UI** (one frontend, existing extension slots). No new app, no second shell.
6. **Orchestration state lives in code + persistent storage** (`dsh_projects` storage domain), never in ephemeral process state. This phase is frontend-only; it changes no storage schema.
7. **The repo stays buildable and testable** at every commit: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green (modulo pre-existing environment failures documented at Phase 0).
8. **Single authority for state transitions.** The UI dispatches only through the existing typed `DashboardDataPort` RPCs; it never writes records directly.
9. **English-only UI (user directive).** After this phase, the Dashboard renders **English only**: the `zh` dictionary is removed, the standalone fallback is English, the dev harness renders English, the Harness locale seat registers English only, and **no Chinese string remains anywhere in the UI** (verified by a test). Every user-facing string is routed through the translator (no hard-coded literals).

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
| **11** | **UI polish — Project Overview, Run detail, Agent detail, Plan/DAG, Memory, Artifacts, Automations (next-run + trigger detail), approval UX, usage summaries, responsive behavior, English-only localization** | **this intent** |
| 12 | Optional Remote Worker Provider — `WorkerProvider` abstraction (+ optional K8s/OpenShift behind a flag) | planned (optional) |

## 5. Scope — Phase 11 (UI Polish)

Per master spec §73 (PHASE 11 — UI POLISH). This is a **frontend polish + localization** slice: it adds no new host-side capability, no new storage domain, and no new RPC surface beyond documented additive read-only projections. It makes the existing Dashboard a finished, **English-only**, responsive product surface.

### 5.1 English-only localization (the user directive — done first)

Remove all Chinese from the UI so the Dashboard renders **English only**:

- **`src/client/locales.ts`** — delete the `zh` dictionary; keep only `en` (now the sole dictionary). `meta.locale` becomes `'en'`.
- **`src/client/i18n.tsx`** — `DashboardLocale` becomes `'en'` (no more `'zh' | 'en'`); `createDashboardTranslator` always uses the `en` dictionary; the standalone `fallbackTranslate` is `createDashboardTranslator('en')`.
- **`src/client/index.tsx`** — the Harness locale seat registers English only: `ctx.locale.register(DASHBOARD_LOCALE_NS, { en })`.
- **`src/client/dev.tsx`** — the dev harness renders English (`createDashboardTranslator('en')`).
- **No Chinese string remains anywhere in the UI** — a new test asserts that the rendered Dashboard (and the `en` dictionary) contains no CJK characters, and that every user-facing string is routed through the translator (no hard-coded literals in `Dashboard.tsx`).
- The Harness locale seat contract is preserved (registering a single-locale dictionary is valid); if the seat requires a specific shape, the Design stage records the exact registration.

### 5.2 New surfaces (added)

- **Project Overview** — a dedicated overview surface (a new tab or the top of the existing surface) showing, at a glance: active runs (count + phase), task health (running/ready/blocked/failed), recent activity (latest run events), and budget/usage at a glance. Backed by the existing `DashboardSnapshot` (runs summary + runtime + attention) — no new RPC unless a projection is genuinely missing (decided in Design).
- **Agent detail** — an in-dashboard agent detail surface (replacing/augmenting the bare "open session" link) showing: agent identity (session id / member name), the owning task, worktree/branch, token usage, runtime/duration, attempt history, and the "open session" action. Backed by the existing per-task runtime data.
- **Usage summary** — a consolidated usage surface: per-run and per-project rollups of token usage (input/output), runtime/duration, and (where supplied) cost. Backed by the existing token totals already surfaced per task.
- **Automations — next-run column + trigger detail view** (deferred from Phase 9): the `nextRunAt` column on the trigger list (the `trigger.nextRun` locale key already exists) and a **trigger detail view** (full config, per-type fields, fire history from `trigger_fires`, last run).

### 5.3 Polished surfaces (existing, refined)

- **Run detail** — the `RunInspector` is refined so a user "can understand current progress without reading raw session logs": clear phase/state, task progress, agent detail (5.2), usage (5.3), and an understandable event timeline.
- **Plan/DAG** — the plan is rendered as a **DAG** (dependency visualization) rather than a flat list: tasks as nodes, dependencies as edges, status-colored, with the current task highlighted. Backed by the existing `PlannedTask.dependencies`.
- **Approval UX** — the approval section is refined: clear **pending/decided** states, the approval mode, the requester, the decision + timestamp (audit trail), and the resolve action. Backed by the existing `project_approvals` data.
- **Memory** — the Memory page is refined: search, kind/status filters, the entry detail, and create/edit flows are consistent and complete.
- **Artifacts** — the Artifacts page is refined: provenance (Run/Task), the final report, and the artifact detail are consistent and complete.
- **Understandable errors** — the observability criterion "errors are understandable": domain errors are presented with a human-readable message (the `dashboardCode` + `params` are already encoded; the UI renders them clearly, not as raw codes).

### 5.4 Responsive behavior

A systematic pass over **responsive behavior**: the surfaces must be usable at the narrow overlay widths the native Harness shell provides (no horizontal overflow, sensible column collapse, dialogs that fit). Verified by the jsdom UI suites at a narrow viewport.

### 5.5 Explicit non-goals for this phase

- **No new host-side capability, no new storage domain, no new table/field, no migration** — `dsh_projects` stays at format version 0.
- **No new RPC surface** beyond a documented additive read-only projection if a surface genuinely needs one (decided in Design; the default is to reuse the existing `DashboardSnapshot`).
- **No Phase 12** (Remote Worker Provider) — that is the optional next phase.
- **No re-implementation of the native session view** — the "open session" action still jumps to the native Harness session; the Agent detail surface is an in-dashboard summary, not a replacement.
- **No new backend reconciliation or concurrency work** — Phase 10 is done; this phase is frontend-only.

## 6. Acceptance criteria (this phase)

1. **English-only UI (user directive).** The `zh` dictionary is removed; the Dashboard renders **English only** (standalone fallback English, dev harness English, Harness locale seat English-only). A test asserts **no CJK characters** appear in the rendered Dashboard or the `en` dictionary, and that user-facing strings are routed through the translator. The Harness locale seat contract is preserved.
2. **Project Overview is useful.** A dedicated overview surface shows active runs, task health, recent activity, and usage at a glance, backed by real snapshot data.
3. **Agent detail is useful.** An in-dashboard agent detail surface shows identity, session, worktree/branch, tokens, duration, and attempt history, with the "open session" action preserved.
4. **Usage summaries are visible.** Per-run and per-project token/duration (and cost, where supplied) rollups are shown.
5. **Automations is finished.** The `nextRunAt` column and the trigger detail view (config + fire history) are present (the Phase 9 deferral is closed).
6. **Plan/DAG is visualized.** The plan renders as a dependency DAG (nodes + edges, status-colored), not a flat list.
7. **Approval UX is clear.** Pending/decided states, mode, requester, decision + timestamp (audit), and the resolve action are presented clearly.
8. **Errors are understandable.** Domain errors render as human-readable messages (not raw codes).
9. **Responsive behavior.** The surfaces are usable at narrow overlay widths (no overflow, sensible collapse) — verified by the jsdom suites.
10. **The repo stays green:** `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` pass (modulo the pre-existing, documented environment failures). The existing UI test suites (board, runs, plans, memory, artifacts, automations, configuration) all pass, updated for English-only.

## 7. Next gate

**Design (Phase 11 — UI Polish):** formalize `spec.md` — the English-only localization change (the exact `locales.ts`/`i18n.tsx`/`index.tsx`/`dev.tsx` edits + the no-CJK test), the new surfaces (Project Overview, Agent detail, usage summary, Automations next-run + trigger detail) and their exact data backing (existing `DashboardSnapshot` vs. a documented additive read-only RPC), the Plan/DAG visualization approach, the approval UX states, the understandable-error presentation, the responsive pass, and the full test plan per §6 (the updated UI suites + the new no-CJK test + the new-surface suites).
