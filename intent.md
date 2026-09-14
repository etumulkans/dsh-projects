# Intent — DSH Projects

**Gate:** Intent · **Status:** Phases 0–7 delivered (v0.13.0 released; Phase 7 shipped on `main` @ `7c6db58`, no fork PR this cycle) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

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
| 7 | Approvals + budgets — approval modes, `project_approvals` table, code-enforced run budgets | **done (v0.13.0)** |
| 8 | Artifacts + final report — `project_artifacts`, run report generation, Artifacts UI | **next** |
| 9 | Triggers — TaskSource events → `ProjectTrigger` adapters | planned |
| 10 | Recovery + hardening — startup reconciliation | planned |
| 11 | UI polish — overview/agent/plan/memory/artifacts/automations pages | planned |

## 5. Phase 7 acceptance (delivered, verified in `73dc5c7`)

- **Domain:** additive `project_approvals` table in `dsh_projects` (format version stays 0) + four run fields (`approvalMode`, `budget`, `budgetWarnings`) + four run event types (`run.approval.requested` / `.resolved`, `run.budget.warning` / `.exceeded`); strict zod schema (4 approval types, 3 statuses, CAS `version`, `resolvedBy`/`resolvedAt`).
- **Approval service:** `ApprovalService` — the pure four-mode policy table (`manual`/`plan`: plan + merge gated; `guarded`/`autonomous`: merge gated), request (one pending per `(run, type)`, idempotent re-request, terminal objects superseded never deleted), resolve (CAS `approval.staleVersion`, `resolvedBy` default `'dashboard'`), expire (the only path to `expired`; no TTL), the `onApprovalResolved` hook (the plan service's own `plan.approval.*` events unchanged); the merge gate in `ProjectTaskService.detectAllSucceeded` + the two additive state-machine edges (`awaiting_approval → integrating`, `executing → awaiting_approval`).
- **Budgets:** `RunBudget` (9 keys, all optional — unset = unlimited) enforced in code at the named sites: the 80% warning once per key (`run.budget.warning`), the limit → the per-key policy action (token/runtime → run `paused` + `resultSummary`; retry/replan → structured refusal + `blocked`), the scheduler cap (`maxAgents`/`maxConcurrentAgents`), `runSetBudget` (raise while paused, clears the raised key from `budgetWarnings`); `maxCost` declared but unenforceable (no cost metering).
- **RPC/UI:** additive `approvalList`/`approvalResolve`/`approvalExpire`/`runSetBudget` (11th handler param, structured not-mounted failure) + `runCreate` budget field; the Approvals section (Approve/Reject dispatch real RPCs, busy gating + structured error banner), the Budget panel (usage + 80% warning markers), the New Run dialog's approval-mode select + nine budget fields; zh/en parity compile-enforced; client isolation scan proves `src/client/**` never imports the node-side approval/budget modules.
- **Verification:** all 6 spec §10 acceptance criteria pass; `test-report.md` committed in the test stage (489/3 of 492 — the 3 pre-existing macOS catalog failures); storage integration proves the table set is exactly `['memory','plans','project_approvals','run_events','runs','tasks']` at domain v0.

## 6. Phase 8 intent — Artifacts + final report

**End state (master spec §26, §64):** *a run produces durable artifacts (test reports, research outputs, patches/diffs, PR references, …) and ends with a human-readable final report — the user should not have to inspect five Agent sessions to understand what happened. Every artifact persists, survives a restart, and is inspectable in the Dashboard.*

Today a finished run ends with a single `resultSummary` string (the Phase 5 completion pipeline) plus Phase 6's fire-and-forget memory distillation — but there is **no durable artifact store**, no structured final report, and no way to attach a run's outputs (a test report, a research note, a PR reference, a patch) to the run for later inspection. The completion pipeline already knows *what* happened (task results, the integration branch/head, usage, the `resultSummary`); Phase 8 makes those outputs durable and inspectable.

### 6.1 Artifact store (master spec §26)

Additive `project_artifacts` table in `dsh_projects` (domain stays v0). The `ProjectArtifact` record:

```ts
interface ProjectArtifact {
  id: string
  projectId: string
  runId?: string          // the producing run (most artifacts are run-scoped)
  taskId?: string         // the producing task (optional finer scope)
  kind: ArtifactKind      // 12 kinds, below
  title: string
  content?: string        // inline text (bounded — see 6.2)
  path?: string           // file reference (no large binaries in JSON storage)
  url?: string            // external reference (e.g. a PR URL)
  metadata?: Record<string, unknown>
  createdAt: string
}
```

The 12 kinds (master spec §26): `plan`, `research-report`, `architecture-note`, `patch`, `diff`, `test-report`, `validation-report`, `review-report`, `screenshot`, `log-reference`, `pull-request`, `external-link`, `final-report`.

- **Artifacts are append-only** (created, never mutated or deleted) — they are a durable record of what a run produced. The `final-report` is the one kind the run completion pipeline generates; the others are attached by the coordinator/task workers (a task that writes a test report attaches it) or created manually in the UI.
- **One `final-report` per run** (idempotent — regenerating it supersedes in place by `runId` + kind, not by a new row).

### 6.2 Content policy (master spec §26: "do not store huge binary blobs")

- **Inline `content` is bounded** (Design finalizes the limit — e.g. ≤ 64 KB) for text artifacts (reports, notes, diffs-as-text).
- **Large/binary outputs are references, not blobs** — a `path` (a file in the project workspace) or a `url` (an external link / PR). A `screenshot` kind stores a `path`/`url`, never the bytes.
- **`pull-request` / `external-link`** carry a `url` (+ `metadata` for the PR number, head/branch, etc.).
- **Secrets are scrubbed** from `content`/`metadata` at creation (the Phase 6 memory scrubbing pattern) — an artifact never becomes a secret leak.

### 6.3 The final report (master spec §64)

At the end of a run (the completion pipeline's terminal transition — `succeeded`, and also `failed`/`blocked` so a stopped run explains *why*), the run completion pipeline generates a `final-report` artifact (fire-and-forget after the transition, the Phase 6 `onRunSucceeded` hook pattern — never into the pipeline, a failure is a warn + no artifact, never a run failure). The report is **human-readable** and explains:

- **Goal** — the run's goal.
- **Outcome** — `succeeded` / `failed` / `blocked` / `canceled` + the `resultSummary` (Phase 7's budget-stop explanation is included verbatim when a budget stopped the run).
- **Changes** — the tasks that succeeded/failed + their summaries (the Phase 4 task DAG results).
- **Validation** — the integration step outcome (branch/head for Git projects, the Phase 5 `run.integration.*` events).
- **Git** — the integration branch + head commit (+ a PR reference when one exists as a `pull-request` artifact).
- **Agents + Usage** — the agent count + token/runtime usage (the Phase 7 budget usage already recorded on the run).
- **Project knowledge learned** — the Phase 6 memory entries distilled from this run (the `run.memory.distilled` event's entries).
- **Remaining risks** — the failed/blocked tasks + any budget warnings (the `run.budget.warning` events).

The report is generated **in code from the persisted run/task/memory/approval records** (no model call — deterministic, reproducible, byte-stable for the same inputs). It is an artifact like any other (inspectable, linkable), and it is the single place a user looks to understand a finished run.

### 6.4 UI (existing Dashboard, zh/en parity compile-enforced)

- **RunInspector:** an **Artifacts** section — the run's artifacts (kind, title, created time) with a detail view (inline `content`, or a `path`/`url` link); the `final-report` rendered as a readable document (the master spec §64 layout); a **Pull-report / Regenerate** affordance for the `final-report` (re-runs the deterministic generator).
- **Artifacts tab (项目产物 / Artifacts):** a project-level list of artifacts across runs (kind chips + counts, the Phase 6 Memory-tab pattern), filter by run/kind, the detail view; the `final-report` of each run surfaced.
- **zh/en parity** compile-enforced as in every phase (the `t` key union); new locale keys for the 12 kinds, the report section labels, the detail view.

### 6.5 RPC (additive, the established pattern)

- `artifactList` (per run or per project, filter by kind), `artifactCreate` (manual attach — kind, title, content/path/url, metadata; the secret-scrub + content-bound validation), `artifactGet` (the full record for the detail view).
- The `final-report` is **not** created via `artifactCreate` — it is generated by the completion pipeline (6.3); the UI's regenerate affordance dispatches a dedicated `runGenerateReport` RPC (additive) that re-runs the deterministic generator.
- Absent-service structured bad-requests like Phase 6/7's endpoints; new `artifact.*` dashboard error codes (client `errors.ts` mapping + `decodeDashboardError` envelopes, the `params` field).
- `runDetail` gains the run's `final-report` reference (additive field; the on-demand RPC pattern, not a snapshot projection).

### 6.6 Explicit non-goals (Phase 9+)

- No artifact **versioning/supersession** beyond the one `final-report`-per-run in-place regeneration (other artifacts are append-only; no edit/delete).
- No **file upload/download** endpoints (a `path` is a reference into the project workspace; the Dashboard links to it, it does not stream bytes).
- No **binary/blob storage** (master spec §26 — references only).
- No **artifact search** beyond kind/run filters (a full-text search over artifact content is a Phase 11 UI-polish concern).
- No **approval objects for artifact writes** (artifacts are append-only records; no gate).
- No **triggers/automations** (Phase 9), no **recovery of interrupted report generation** (Phase 10 — a failed generation is a warn + no artifact, retried by the regenerate affordance).
- No `DashboardSnapshot` version change; artifacts are on-demand RPC data (the `runDetail` pattern), not snapshot projections.

### 6.7 Acceptance (intent-level; the spec formalizes §-numbered criteria)

1. **Store** — `project_artifacts` is a declared table of `dsh_projects` (v0, no migration); records validate against the strict schema (12 kinds, bounded `content`, `path`/`url` references, no blobs); artifacts are append-only (no update/delete service methods); the table set grows by exactly one table.
2. **Content policy** — inline `content` is bounded; large/binary outputs are `path`/`url` references (never bytes); `pull-request`/`external-link` carry a `url`; secrets are scrubbed from `content`/`metadata` at creation.
3. **Final report** — the completion pipeline generates a `final-report` artifact at the terminal transition (succeeded + failed/blocked/canceled), in code from the persisted records (deterministic, no model call); it explains goal/outcome/changes/validation/git/agents/usage/knowledge/risks (master spec §64); one per run (idempotent regeneration); a generation failure is a warn + no artifact, never a run failure.
4. **UI** — the RunInspector Artifacts section + the project-level Artifacts tab render artifacts (kind chips, detail view, the readable `final-report`); the regenerate affordance dispatches the real RPC; zh/en parity compile-enforced.
5. **RPC** — `artifactList`/`artifactCreate`/`artifactGet`/`runGenerateReport` dispatch with validation (content bound, kind, secret scrub); absent-service structured failures; the new `artifact.*` error codes (with `params`).
6. **Repo green** — typecheck, build, full `pnpm vitest run` (modulo the documented pre-existing environment failures).

### 6.8 Test plan (intent-level; the spec details the cases)

- `tests/artifact-service.test.ts` (new): the store (create/list/get, 12 kinds, content bound, path/url references, secret scrub, append-only — no update/delete), the one-`final-report`-per-run idempotency, the `artifact.created` event projection.
- `tests/final-report.test.ts` (new): the deterministic generator (goal/outcome/changes/validation/git/agents/usage/knowledge/risks from the persisted records; byte-stable for the same inputs; the budget-stop `resultSummary` included verbatim; failed/blocked runs explain why; a generation failure → warn + no artifact, never a run failure).
- `tests/task-service.test.ts` (extended): the completion pipeline triggers the final-report generation at the terminal transition (succeeded + failed/blocked); the report references the run's tasks/integration/usage/memory.
- `tests/rpc-handler.test.ts` (extended): the four artifact endpoints + `runGenerateReport` + `runDetail` final-report field; absent-service failures; the new error codes (with `params`).
- `tests/dashboard-artifacts.test.tsx` (new, jsdom): the RunInspector Artifacts section + the project-level Artifacts tab render artifacts (kind chips, detail view, the readable `final-report`), the regenerate affordance dispatches the RPC with busy gating + error banners; zh + en.
- `tests/run-storage-integration.test.ts` (extended): the table set is exactly `['memory','plans','project_approvals','project_artifacts','run_events','runs','tasks']`; artifacts + the `final-report` survive a real JSON reopen; domain stays v0.
- Client isolation: the new scan pattern extends to the artifact types (client mirror types, no `src/artifacts/**` import).

## 7. Next gate

**Design (Phase 8 — Artifacts + final report):** formalize `spec.md` — the `project_artifacts` table schema + strict record spec (12 kinds, bounded `content`, `path`/`url` references, the append-only rule), the content policy (the inline bound, the reference-not-blob rule, the secret scrub), the `ProjectArtifactService` (create/list/get, the one-`final-report`-per-run idempotency, the `artifact.created` event), the final-report generator (the deterministic section builder from the persisted run/task/memory/approval records, the master spec §64 layout, the terminal-transition trigger + the fire-and-forget hook), the additive RPC surface (artifactList/artifactCreate/artifactGet/runGenerateReport + the runDetail final-report field), the error codes, the UI (the RunInspector Artifacts section, the project-level Artifacts tab, the readable `final-report`, the regenerate affordance, zh/en keys), and the full test plan, per §6.
