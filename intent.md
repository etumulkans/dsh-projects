# Intent — DSH Projects

**Gate:** Intent · **Status:** Phases 0–6 delivered (v0.12.0 released; Phase 6 shipped on `main` @ `ef5ed66`, no fork PR this cycle) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

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
| 5 | Git isolation + integration — per-task worktrees, `dsh/run-<id>/<task>` branches, run completion pipeline | **done (v0.11.0)** |
| 6 | Project Memory — `memory` store, retrieval, distillation, context budget, Memory UI | **done (v0.12.0)** |
| 7 | Approvals + budgets — approval modes, `project_approvals` table, code-enforced run budgets | **next** |
| 8 | Artifacts + final report — `project_artifacts`, report generation | planned |
| 9 | Triggers — TaskSource events → `ProjectTrigger` adapters | planned |
| 10 | Recovery + hardening — startup reconciliation | planned |
| 11 | UI polish — overview/agent/plan/memory/artifacts/automations pages | planned |

## 5. Phase 6 acceptance (delivered, verified in `c95774f`)

- **Domain:** additive `memory` table in `dsh_projects` (format version stays 0) + two run event types (`run.memory.distilled` / `run.memory.distillation.failed`); strict zod schema (15 kinds, 3 statuses, bounds, `supersedes`, provenance fields, CAS `version`).
- **Service:** `ProjectMemoryService` — list (active pool; archived opt-in; superseded never listed; kind counts over all active), create (bounds + secret scrubbing + dedup containment ≥ 0.6 → supersession, never delete), update (≥1 patch, CAS), setStatus (legal moves only; superseded immutable); fire-and-forget `distillRun` (driver seam + Harness `dsh-memory-<uuid>` sessions; zero candidates → zero entries and no event; failure → warn + failed event, never into the pipeline).
- **Retrieval:** pure lexical strategy behind a seam — `score = (3·|Q∩title| + 2·|Q∩tags| + 1·|Q∩body|) / (3·|Q|)`, pinned first, zero-score filter, deterministic ordering, `limit`; budgeted packet builder (coordinator/task budgets, header + pinned/kind sections, 300-char truncation, `undefined` when empty).
- **Injection:** coordinator first-turn prompt appends the packet (query = run.goal); local/team task adapters insert the memory section (query = title + description); byte-identical prompts when there is no active memory.
- **RPC/UI:** additive `memoryList`/`memoryCreate`/`memoryUpdate`/`memorySetStatus` (10th handler param, structured not-mounted failure); the Memory tab (项目记忆 / Project Memory) with search, kind chips + counts, show-archived, pin/edit/archive/restore/mark-obsolete, source-run link, add/edit dialogs, supersession notices; zh/en parity compile-enforced; client isolation scan proves `src/client/**` never imports `src/memory/**`.
- **Verification:** all 8 spec §13 acceptance criteria pass; `test-report.md` committed in the test stage (425/3 of 428 — the 3 pre-existing macOS catalog failures); storage integration proves the table set is exactly `['memory','plans','run_events','runs','tasks']` at domain v0.

## 6. Phase 7 intent — Approvals + budgets

**End state (master spec §18–19, §30):** *a run only does what its approval mode allows, and it stops when it runs out of budget — both enforced in code, both visible and inspectable in the Dashboard, both surviving a restart.*

Today the run state machine already has an `awaiting_approval` phase and the plan flow already emits `plan.approval.requested` / `plan.approved` / `plan.rejected` events (Phases 2–3) — but the approval itself is **ephemeral UI state**: there is no persisted approval object, no mode policy, and no budgets at all (a run can burn tokens/agents/time without limit). Phase 7 makes governance durable and code-enforced.

### 6.1 Approval modes (master spec §18)

A per-run (config-defaulted) `ApprovalMode` decides which stages need a human:

```ts
type ApprovalMode = 'manual' | 'plan' | 'guarded' | 'autonomous'
```

- **`manual`** — a human approval is required before the major execution stages (plan activation and the external-write stages below).
- **`plan`** — the human approves the Run Plan; after approval local execution proceeds automatically; external writes still obey Harness permissions.
- **`guarded`** — ordinary sandboxed work proceeds automatically; potentially dangerous/external actions require approval.
- **`autonomous`** — the coordinator proceeds without plan approval, within configured permissions and budgets. Even in autonomous mode: never bypass Harness permissions, never silently elevate permissions, never merge into protected production branches by default, never expose secrets.
- **The default is conservative** — the plugin config default is `plan` (Design finalizes `plan` vs `guarded` and where the mode is set: config default + per-run override at run/plan creation).

Modes map onto the **existing** phase edges — no new run phases: `awaiting_approval` is where a pending approval pauses the run; approve → the run resumes into the phase it was suspended from (the existing `suspendedFrom` machinery); reject → `blocked` (or `failed` for a rejected plan, per the existing plan-rejection edge — Design decides the exact mapping and keeps it consistent with the Phase 3 coupler).

### 6.2 Approval objects (master spec §19)

A new additive `project_approvals` table in `dsh_projects` (format version stays 0):

```ts
interface ApprovalRequest {
  id: string
  projectId: string
  runId: string
  type: 'plan' | 'external-write' | 'git-push' | 'pull-request' | 'merge' | 'dangerous-action'
  summary: string
  payload?: unknown
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  requestedAt: string
  resolvedAt?: string
  resolvedBy?: string
}
```

- **Persistence is the point** — approval state must survive browser refresh and process restart (real `dsh_projects` storage, zod-validated, CAS `version` like the other tables). The existing `plan.approval.*` events become the event-stream projection of the persisted object (request/approve/reject all append events; the object is the single authority for "is this approved?").
- **One pending approval per (run, type)** — a second request for the same type while one is pending is rejected (idempotent re-request, not a duplicate).
- **Resolution is a service method** (`approve` / `reject`, CAS on `version`, `resolvedBy` recorded) that (a) persists the status, (b) appends the run event, (c) resumes or blocks the run through the existing state machine — the same code path the plan UI already drives, now backed by the object.
- **Which types ship in Phase 7:** `plan` (the existing plan approval, now persisted) and `merge` (the Phase 5 integration step's final merge into the project branch — the one external/dangerous stage that exists today). `git-push` / `pull-request` / `external-write` / `dangerous-action` are declared in the schema and the policy table but have **no trigger site yet** (those stages do not exist in the product yet) — the RPC and UI support them generically (invariant 2: the endpoint works for any declared type; no fake trigger sites).
- **Expiry:** no TTL (Phase 6 non-goal, carried) — `expired` is a declared status reached only by an explicit service call (Design decides the trigger: e.g. run cancellation while pending), not by a background timer.

### 6.3 Budgets (master spec §30)

Additive `RunBudget` on the run record (all fields optional; unset = unlimited):

```ts
interface RunBudget {
  maxRuntimeMinutes?: number
  maxTotalTokens?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxAgents?: number
  maxConcurrentAgents?: number   // already exists per-run; budget view unifies it
  maxReplans?: number
  maxRetriesPerTask?: number
  maxCost?: number               // declared; no cost metering exists yet — enforced as "no value ⇒ unlimited", never fabricated
}
```

- **Enforcement is in code, not model instructions** (master spec §30, explicit):
  - **~80% of a budget → warning** — a run event (`run.budget.warning`, with the budget key + current/limit in the detail) emitted once per budget per run (no spam on every tick).
  - **At the limit → stop or pause according to policy** — the Design picks the per-key action (e.g. token/runtime limits → run `paused` with `suspendedFrom`, so a human can raise the budget and resume; retry/replan limits → the specific action is refused with a structured error and the run settles `blocked`); the final report/resultSummary explains **why execution stopped** (the budget key + limit in the detail).
  - **Where the checks live:** token/runtime checks at the points where usage is already recorded (task completion → `tokenUsage` accumulation; the scheduler tick for runtime); `maxAgents`/`maxConcurrentAgents` in the task scheduler (the concurrency knob already exists — the budget view caps it); `maxRetriesPerTask` in the retry path (the Phase 4 retry logic already counts); `maxReplans` in the plan service (replan attempts already counted via `supersedesPlanId` chains).
- **Budgets are set at run creation** (RPC `runCreate` gains the optional budget object, validated) and **raised by an explicit transition** while paused (Design: a `runUpdate`-style budget patch endpoint or a dedicated `runSetBudget` — additive RPC either way). No silent auto-raise.
- **No cost metering** — `maxCost` is declared and validated but there is no price feed in the product; the check is a no-op until a source exists (invariant 2: never fabricate a cost).

### 6.4 UI (existing Dashboard, zh/en parity compile-enforced)

- **RunInspector:** an **Approvals** section — pending approval objects for the selected run (type, summary, requested time) with **Approve / Reject** buttons (dispatch the new RPCs; busy gating + structured error banner per the existing conventions); the run's `approvalMode` displayed; the existing plan approve/reject buttons now resolve the persisted `plan` approval object (same visual, durable backing).
- **Budgets:** the run's budget + current usage (tokens, runtime, agents, retries) rendered in the inspector with a warning marker when a `run.budget.warning` fired; budget fields in the New Run dialog (optional, all empty = unlimited) — the dialog already carries the run-creation form.
- **Runs list:** a pending-approval indicator on runs in `awaiting_approval` (the phase is already shown; the indicator names the pending type).
- **zh/en parity** compile-enforced as in every phase (the `t` key union); new locale keys for modes, approval types/statuses, budget labels, warnings.

### 6.5 RPC (additive, the established pattern)

- `approvalList` (per run or per project), `approvalApprove` / `approvalReject` (CAS `expectedVersion`, `resolvedBy`), `runSetBudget` (patch the budget of a run in a phase where raising is legal).
- Absent-service structured bad-requests like Phase 6's memory endpoints; new `approval.*` + `budget.*` dashboard error codes (client `errors.ts` mapping + `decodeDashboardError` envelopes, the `params` field — not `args`).
- `runCreate` gains the optional `budget` object (additive field; existing callers unchanged).

### 6.6 Explicit non-goals (Phase 8+)

- No new run phases (the existing `awaiting_approval` + `suspendedFrom` machinery is reused).
- No TTL/background expiry timers — `expired` only via explicit service calls.
- No cost metering/price feeds (`maxCost` declared, unenforceable until a source exists).
- No approval objects for memory writes (Phase 6 non-goal, carried — memory writes stay service-internal + manual).
- No protected-branch policy engine — autonomous mode's "never merge into protected production branches by default" is honored by the merge approval gate (the merge always requires approval in every mode except an explicit per-run override, which the Design defines), not by branch-name parsing.
- No triggers/automations (Phase 9), no artifact system (Phase 8), no recovery of interrupted distillation (Phase 10).
- No `DashboardSnapshot` version change; approvals/budgets are on-demand RPC data (the runDetail pattern), not snapshot projections.

### 6.7 Acceptance (intent-level; the spec formalizes §-numbered criteria)

1. **Store** — `project_approvals` is a declared table of `dsh_projects` (v0, no migration); records validate against the strict schema; `version` bumps on every accepted mutation; approvals survive a real JSON domain reopen; the table set grows by exactly one table.
2. **Policy** — each of the four modes behaves per §6.1 (manual: plan + merge gated; plan: plan gated, merge gated, local execution free after approval; guarded/autonomous: plan ungated, merge gated; autonomous never bypasses Harness permissions); the conservative default is the config default; the mode is stored per run and visible in the UI.
3. **Objects** — request/approve/reject persist + project onto the run event stream (the existing `plan.approval.*` events remain the plan projection); one pending per (run, type); resolution resumes/blocks the run through the existing state machine; browser refresh and process restart do not lose a pending approval.
4. **Budgets** — every declared budget key is enforced in code at the named site (80% warning once per key, limit → the per-key policy action, resultSummary explains why); unset keys are unlimited; budgets are set at creation and raised explicitly; no key is enforced by prompt text alone.
5. **UI** — the Approvals section + Approve/Reject dispatch real RPCs with surfaced errors; the budget/usage panel renders; the New Run dialog carries the optional budget fields; zh/en parity compile-enforced.
6. **Repo green** — typecheck, build, full `pnpm vitest run` (modulo the documented pre-existing environment failures).

### 6.8 Test plan (intent-level; the spec details the cases)

- `tests/approval-service.test.ts` (new): the mode policy table (all 4 modes × the gated stages), request/approve/reject CAS + one-pending-per-(run,type), event projection (plan events unchanged), resume/block through the real state machine, reopen persistence.
- `tests/budget-enforcement.test.ts` (new): per-key 80% warning (once, not per tick), limit actions (pause vs refuse), the resultSummary explanation, unset = unlimited, budget patch legality.
- `tests/task-service.test.ts` (extended): `maxAgents` / `maxConcurrentAgents` / `maxRetriesPerTask` enforcement at the scheduler/retry sites; token accumulation triggering the warning + pause.
- `tests/plan-service.test.ts` (extended): `maxReplans` refusal.
- `tests/rpc-handler.test.ts` (extended): the three approval endpoints + `runSetBudget` + `runCreate` budget validation; absent-service failures; the new error codes (with `params`).
- `tests/dashboard-approvals.test.tsx` (new, jsdom): the Approvals section renders pending objects, Approve/Reject dispatch the RPCs with busy gating + error banners, the budget panel renders usage + warning markers, the New Run dialog budget fields dispatch into `runCreate`; zh + en.
- `tests/run-storage-integration.test.ts` (extended): the table set is exactly `['memory','plans','project_approvals','run_events','runs','tasks']` (Design finalizes the table name); approvals + budget fields survive a real JSON reopen; domain stays v0.
- Client isolation: the new scan pattern extends to the approval types (client mirror types, no `src/approvals/**` import).

## 7. Next gate

**Design (Phase 7 — Approvals + budgets):** formalize `spec.md` — the `project_approvals` table schema + strict record spec, the approval mode policy table (mode × gated stage → required/not, with the exact phase-edge mapping onto the existing state machine), the approval state machine (status transitions, CAS, one-pending rule, expiry path), the budget schema + per-key enforcement sites + the 80%/limit policy table (warning event shape, per-key limit action), the additive RPC surface (approvalList/approvalApprove/approvalReject/runSetBudget + runCreate budget field), the error codes, the UI (Approvals section, budget panel, New Run dialog fields, zh/en keys), and the full test plan, per §6.
