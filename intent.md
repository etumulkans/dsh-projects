# Intent — DSH Projects

**Gate:** Intent · **Status:** Phases 0–8 delivered (v0.14.0 released; Phase 8 shipped on `main` @ `758e223`, pushed to `origin/main`) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

## 1. What we are doing

Evolve the existing `dsh-dashboard` Cordis plugin in this repository into **DSH Projects**: a project-level orchestration layer on top of DeepSeek Harness where a *project* owns a persistent, inspectable execution lifecycle (runs → plans → tasks → integration → memory → reports → automations).

The work proceeds as **vertical slices**: each phase delivers a thin, working, tested end-to-end capability (domain model → persistence → RPC → UI in the existing Dashboard) before the next one starts. No phase is started ahead of the previous one.

## 2. Why

The dashboard today observes and schedules *tasks* (task sources, local store, Git worktree model) and can own a *project goal* over time (Phases 1–8: runs, plans, task DAG, Git integration, memory, approvals + budgets, artifacts + final reports). What it cannot yet do is **start runs automatically** from the world around it: a tracker issue moving to a ready state, a wall-clock schedule, or an external event. Phase 9 makes the harness a *triggered* project runtime: a durable, per-project **Trigger** rule watches a source (tracker / schedule / webhook / repository / system), and when the source fires it creates a Project Run from a goal template — inspectable and manageable in the GUI, idempotent, and credential-safe.

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
| 5 | Git isolation + integration — per-task worktrees, `dsh/run-<id>/<task>` branches, run completion pipeline | **done (v0.11.0)** |
| 6 | Project Memory — `memory` store, retrieval, distillation, context budget, Memory UI | **done (v0.12.0)** |
| 7 | Approvals + budgets — approval modes, `project_approvals` table, code-enforced run budgets | **done (v0.13.0)** |
| 8 | Artifacts + final report — `project_artifacts`, run report generation, Artifacts UI | **done (v0.14.0)** |
| 9 | Triggers — TaskSource events → `ProjectTrigger` adapters, schedule + webhook abstractions, Automations UI | **next** |
| 10 | Recovery + hardening — startup reconciliation | planned |
| 11 | UI polish — overview/agent/plan/memory/artifacts/automations pages | planned |

## 5. Phase 8 acceptance (delivered, verified)

Phase 8 (Artifacts + final report) is shipped and verified (test report `e454d7f`, release `758e223`, v0.14.0): the `project_artifacts` table (dsh_projects v0, additive, append-only), the 12 artifact kinds with the content policy (64 KB inline bound, `path`/`url` references, secret scrub), the deterministic final report (master spec §64, generated in code at the run's terminal transition, one per run, idempotent), the `artifact.created`/`run.report.failed` run events, the Artifacts tab + RunInspector section (zh/en), and the `artifactList`/`artifactCreate`/`artifactGet`/`runGenerateReport` RPC endpoints. Full suite 547/3 of 550 (the 3 pre-existing macOS catalog failures).

## 6. Phase 9 intent — Trigger generalization

**End state:** the dashboard can define **triggers** — durable, per-project automation rules that create Project Runs from events. The existing tracker polling is generalized into a `tracker` trigger adapter (the six existing sources — Linear, GitHub, Jira, Asana, GitLab, Local — are *wrapped*, not rewritten); a `schedule` trigger (interval/cron with a computed next-run) and a `webhook` trigger (where feasible) are added; `manual` is the existing `runCreate` path. Triggers are inspectable and manageable in a new **Automations** UI section (trigger, status, last run, next run, goal template, approval policy; enable/disable), are **idempotent** (the same trigger + the same source event creates at most one run), and **never leak credentials into the browser**.

### 6.1 The `project_triggers` table (additive, dsh_projects v0)

- One new declared table `project_triggers` in the `dsh_projects` domain (the 8th table; the set grows by exactly one, no migration — storage-domain initializes absent declared tables as empty).
- The `ProjectTriggerRecord`: `{ id, projectId, type, enabled, config, goalTemplate, approvalMode?, lastFiredAt?, lastRunId?, createdAt, updatedAt }` where `type: 'manual' | 'tracker' | 'schedule' | 'webhook' | 'repository-event' | 'pr-event' | 'system'` (matching the existing `ProjectRunSource`, plus `pr-event` split out per master spec §27).
- `config: unknown` is the trigger-type-specific payload (tracker: source kind + filter states; schedule: interval/cron + timezone; webhook: endpoint + secret ref), validated per-type by the service (strict schema, no invented fields).
- `goalTemplate: string` carries `{{placeholder}}` tokens (e.g. `{{issue.key}}`, `{{issue.title}}`, `{{pr.number}}`) filled from the firing event; `approvalMode?` is the per-trigger approval policy applied to the runs it creates (Phase 7 `ApprovalMode`).
- `lastFiredAt` + `lastRunId` are the "Last run" the Automations UI shows; they are set by the fire path (the run's `source`/`sourceRef` already record the provenance — `source: 'tracker' | 'schedule' | …`, `sourceRef: <trigger id>`).

### 6.2 The `ProjectTriggerService`

- **CRUD:** `create` (validate `type` + per-type `config` + non-empty `goalTemplate`; `manual` triggers are not persisted — they are the implicit `runCreate` path), `list` (per project, newest-first), `get` (by id), `update` (goal template, config, approval mode, enabled), `setEnabled` (enable/disable — the only state toggle the UI drives), `delete`.
- **Fire:** `fire(triggerId, event)` — render the `goalTemplate` with the event, create a Project Run via the existing `ProjectRunService.createRun` (with the trigger's `approvalMode` + `source`/`sourceRef`), and record `lastFiredAt`/`lastRunId`. Fire is **idempotent**: a `(triggerId, sourceEventKey)` that already produced a run does not create a second one (the dedupe key is persisted, e.g. on the run's `sourceRef` or a small `trigger_fires` record).
- **Adapters:** a `TriggerAdapter` seam — `{ type, poll?(ctx): Promise<TriggerEvent[]>, onEvent?(ctx, event): void }` — with one adapter per type:
  - `tracker` — wraps the existing `TaskSource` registry: a tracker issue entering an active/ready state yields a `TriggerEvent` (keyed by the issue id + state transition); the existing polling cadence is preserved (no new poller).
  - `schedule` — the schedule abstraction: an interval or cron expression, a computed `nextRunAt`, and a tick that fires when `now >= nextRunAt` (then advances `nextRunAt`); deterministic under a fake clock.
  - `webhook` — where feasible: an HTTP-receivable event (the Cordis plugin's existing HTTP surface, not a new server) that maps a signed payload to a `TriggerEvent`; the endpoint + secret are config, never returned to the browser.
  - `repository-event` / `pr-event` / `system` — the types are declared and the adapters are the *minimal* real path (repository/PR events surfaced by the existing Git integration where it already observes them; `system` for internal events); no external provider SDKs are added in this phase (master spec §27: "Do not build all external webhook providers before the internal abstraction is correct").
- **No invented APIs:** the adapters use only the existing `TaskSource` seam, the existing Git-workspace observation, and the Cordis HTTP surface as installed.

### 6.3 Idempotency

- A trigger fire is idempotent: the same `(triggerId, sourceEventKey)` creates at most one run. The dedupe key is persisted (a `trigger_fires` record or the run's `sourceRef`), so a process restart or a duplicate event does not double-create a run.
- The `schedule` adapter is idempotent across restarts: `nextRunAt` is derived from the persisted `config` + `lastFiredAt`, so a restart does not re-fire a schedule that already fired.
- `manual` (the `runCreate` path) is unchanged and remains explicitly non-idempotent (each call is a new run) — idempotency applies to the *automated* adapters.

### 6.4 The RPC surface (additive)

- `triggerList` (per project), `triggerCreate`, `triggerGet`, `triggerUpdate`, `triggerSetEnabled`, `triggerDelete`, `triggerFire` (an explicit fire for testing / the UI's "Run now").
- The existing `runCreate` is unchanged (it is the `manual` trigger); a run created by an automated trigger carries `source: <trigger type>` + `sourceRef: <trigger id>` (already supported by `CreateRunInput`).
- Absent-service structured failures + the new `trigger.*` error codes (with `params`), following the Phase 7/8 RPC error convention (`decodeDashboardError`).

### 6.5 The UI (Automations section, zh/en)

- A new **Automations** section (a project-level tab or a RunInspector-adjacent section, per the existing extension slots) showing, per trigger: **Trigger** (type + label), **Status** (enabled/paused), **Last run** (`lastFiredAt` + the linked run), **Next run** (the schedule's `nextRunAt`), **Goal template**, **Approval policy**.
- Enable/disable drives `triggerSetEnabled`; a "Run now" affordance drives `triggerFire`; the Add-trigger dialog dispatches `triggerCreate` (type select + per-type config + goal template + approval mode).
- **No credentials in the browser:** the trigger `config` returned to the client is the credential-free projection (the webhook secret is a ref, never a value); the client carries mirror types in `controller.ts` (the §8 isolation invariant — no `src/client/**` imports `src/triggers/**`).
- zh/en parity compile-enforced (`en satisfies Record<DashboardLocaleKey, string>`).

### 6.6 Storage + events

- `dsh_projects` stays at **format version 0** (additive — one `project_triggers` table, optionally one `trigger_fires` dedupe table; no migration).
- New additive run event types where the fire path is observable: `trigger.fired` (a trigger created a run) — appended to the run's event stream (the existing `run_events` table).

### 6.7 Out of scope (later phases)

- External webhook *provider* SDKs (GitHub/GitLab/Lark webhooks) — the `webhook` adapter is the internal abstraction only (master spec §27).
- The full Automations *page* polish (Phase 11) — this phase ships the working section, not the finished page.
- Recovery of in-flight trigger state across a crash beyond the idempotency guarantee (Phase 10).

### 6.8 Acceptance criteria (maps to master spec §27, §47, §62, §63)

1. **Store** — `project_triggers` is a declared `dsh_projects` table (v0, no migration); records validate against the strict schema (7 types, per-type `config`, non-empty `goalTemplate`); the table set grows by exactly one (or two with the dedupe table).
2. **Adapters** — the `tracker` adapter wraps the six existing `TaskSource`s (no rewrite) and yields a `TriggerEvent` on a ready-state transition; the `schedule` adapter computes `nextRunAt` and fires on the tick (deterministic under a fake clock); the `webhook` adapter maps a signed payload to a `TriggerEvent` (where the Cordis HTTP surface allows it); `manual` is the unchanged `runCreate` path.
3. **Idempotency** — the same `(triggerId, sourceEventKey)` creates at most one run (verified across a duplicate event and a process restart); the `schedule` adapter does not re-fire after a restart.
4. **Fire** — `fire` renders the `goalTemplate` with the event, creates a run via `ProjectRunService.createRun` (the trigger's `approvalMode` + `source`/`sourceRef`), and records `lastFiredAt`/`lastRunId`; the run is inspectable in the existing Runs UI.
5. **UI** — the Automations section renders trigger/status/last-run/next-run/goal-template/approval-policy (zh/en); enable/disable + Run now dispatch the real RPCs; the Add-trigger dialog dispatches `triggerCreate`; no credential value is ever returned to the browser.
6. **RPC** — `triggerList`/`triggerCreate`/`triggerGet`/`triggerUpdate`/`triggerSetEnabled`/`triggerDelete`/`triggerFire` dispatch with validation; absent-service structured failures; the new `trigger.*` error codes (with `params`).
7. **Repo green** — `pnpm run typecheck`, `pnpm run build`, full `pnpm vitest run` (modulo the documented pre-existing environment failures).

## 7. Next gate

**Design (Phase 9 — Trigger generalization):** formalize `spec.md` — the `project_triggers` table schema + strict record spec (7 types, per-type `config`, the `goalTemplate` + `{{placeholder}}` contract, the `approvalMode`), the `ProjectTriggerService` (CRUD + `setEnabled` + `fire`, the idempotency/dedupe key, the per-type `config` validation), the `TriggerAdapter` seam + the four adapters (tracker over the existing `TaskSource` registry, schedule with the `nextRunAt` computation, webhook over the Cordis HTTP surface, the minimal repository/pr/system path), the additive RPC surface (triggerList/triggerCreate/triggerGet/triggerUpdate/triggerSetEnabled/triggerDelete/triggerFire + the `trigger.*` error codes), the `trigger.fired` run event, the UI (the Automations section, the Add-trigger dialog, the enable/disable + Run now affordances, the credential-free `config` projection, zh/en keys), and the full test plan, per §6.
