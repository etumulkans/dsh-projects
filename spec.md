# Spec — Phase 11: UI Polish (remaining surfaces, steps 2–5)

**Gate:** Design · **Intent:** `intent.md` (Phase 11, remaining surfaces) · **Master spec:** `DSH_PROJECTS_SPEC.md` §73 (PHASE 11 — UI POLISH), §74 (Observability + UX acceptance) · **Architecture:** `docs/dsh-projects-architecture.md` §2.2 (browser side), §3.7 (UI extension slots)

> **Status:** the English-only localization slice (this spec's former §4, build
> §10 step 1) is **done and merged** (PR #4, squash `015757c`, on `origin/main`).
> This spec now formalizes the **remaining Phase 11 work** — build §10 steps 2–5:
> the `nextRunAt` / `recentFires` projection, the new surfaces, the polished
> surfaces, and the responsive pass.

## 1. Goal and success

Finish the Dashboard as a **polished, English-only, responsive** product surface. The English-only localization (the user directive *"remove all chinese from any of ui"*) is **already shipped** — the `zh` dictionary is an English mirror of `en` and the UI renders English under either locale id. This slice **adds the missing spec-required surfaces** (Project Overview, Agent detail, usage summary, the Phase 9-deferred Automations next-run column + trigger detail view), **polishes the existing ones** (Run detail, Plan/DAG visualization, approval UX, Memory, Artifacts, understandable errors), and **verifies responsive behavior**. No new host-side capability, no new storage domain, no new table/field, no migration, no new RPC endpoint — `dsh_projects` stays at format version 0 (the only host-side change is the additive `nextRunAt` / `recentFires` projection on the existing trigger output).

Success (measured at the Test gate):

- The Dashboard remains **English only** (the `dashboard-english-only` guard still passes; new surfaces route every string through the translator, the `zh` mirror kept byte-identical).
- A **Project Overview** surface shows active runs, task health, recent activity, and usage at a glance, backed by real snapshot data.
- An **Agent detail** surface shows identity, session, worktree/branch, tokens, duration, and attempt history, with the "open session" action preserved.
- **Usage summaries** (per-run + per-project token/duration rollups) are shown.
- **Automations** shows the `nextRunAt` column and a trigger detail view (config + fire history) — the Phase 9 deferral is closed.
- The **Plan** renders as a dependency **DAG** (nodes + edges, status-colored), not a flat list.
- The **approval** section shows clear pending/decided states, mode, requester, decision + timestamp (audit), and the resolve action.
- **Errors** render as human-readable messages (not raw codes).
- The surfaces are usable at **narrow overlay widths** (no overflow, sensible collapse).
- `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` stay green (modulo the pre-existing, documented environment failures). All 14 existing UI suites pass, updated for English-only.

## 2. Invariants (from `intent.md` §3)

1. **No invented APIs.** The UI consumes only data the existing `DashboardDataPort` RPC surface already returns, **plus two documented additive read-only projections** (`nextRunAt` + `recentFires` on the trigger view, §5.4). No speculative API.
2. **No placeholder APIs. No fake UI data.** Every control is backed by real behavior and real (or explicitly fixture-labeled local-mode) data.
3. **No premature phases.** No Phase 12 (Remote Worker Provider).
4. **Preserve the existing Git worktree model** and all existing dashboard behavior; changes are additive except the intentional English-only reduction (§4).
5. **Extend the native Dashboard UI** (one frontend, existing extension slots). No new app, no second shell.
6. **Orchestration state lives in code + persistent storage.** This phase is frontend-only; it changes no storage schema.
7. **The repo stays buildable and testable** at every commit.
8. **Single authority for state transitions.** The UI dispatches only through the existing typed `DashboardDataPort` RPCs; it never writes records directly.
9. **English-only UI (user directive).** After this phase the Dashboard renders English only; **no Chinese string remains anywhere in the UI** (verified by a test). Every user-facing string is routed through the translator.

## 3. Storage

`dsh_projects` stays at **format version 0**. Phase 11 adds **no tables, no record fields, no migrations, no new run event types**. The only host-side change is **two additive read-only projection** fields on the trigger view (`nextRunAt` + `recentFires`, §5.4) — computed values, not stored ones.

## 4. English-only localization (the user directive) — **DONE (PR #4)**

> **Shipped.** This section is retained for the record. The English-only
> localization (build §10 step 1) is **done and merged** (PR #4, squash
> `015757c`). One correction to the original plan: the Harness locale seat
> (`@deepseek-ai/dsh-client-locale`) has `LOCALE_IDS: readonly ["zh", "en"]` and
> its `register(ns, dicts)` requires a dictionary for **both** locale ids — an
> `{ en }`-only registration is a type error. So instead of deleting `zh`, the
> `zh` dictionary was kept as an **English mirror** of `en` (byte-identical
> values, 747 keys each, 0 CJK); `en` is the source of truth. The UI renders
> English under *either* locale id. The `dashboard-english-only` guard (5
> tests) locks in: no CJK in the `en` dictionary, the `zh` mirror byte-identical
> to `en`, no CJK in a rendered `DashboardSurface`, no CJK in the standalone
> translator output, and no CJK in the client source files.

Remove all Chinese so the Dashboard renders **English only**. The `en` dictionary is already a complete mirror of the `zh` key set (both 757 keys, `meta.locale` `en-US`), so this is a **deletion + rewiring**, not a translation.

### 4.1 `src/client/locales.ts`

- **Delete the `zh` dictionary** (lines 4–758). Keep only `en` (now the sole dictionary). `en['meta.locale']` stays `'en-US'`.
- `DASHBOARD_LOCALE_NS` (`'dsh-dashboard'`) is unchanged.

### 4.2 `src/client/i18n.tsx`

- `export type DashboardLocale = 'en'` (no more `'zh' | 'en'`).
- `createDashboardTranslator(locale: DashboardLocale)` always uses the `en` dictionary (the `locale === 'zh' ? zh : en` branch collapses to `en`).
- `const fallbackTranslate = createDashboardTranslator('en')` (standalone fallback is English).
- `useDashboardTranslation()` and `DashboardI18nProvider` are unchanged in shape.

### 4.3 `src/client/index.tsx`

- The Harness locale seat registers English only: `ctx.effect(() => ctx.locale.register(DASHBOARD_LOCALE_NS, { en }), 'dsh-dashboard: dictionaries')`.
- The `zh` import is removed; the `en` import stays.
- `export type { DashboardLocale, DashboardTranslate }` stays (the type is now `'en'`).

### 4.4 `src/client/dev.tsx`

- The dev harness renders English: `<DashboardI18nProvider t={createDashboardTranslator('en')}>`.

### 4.5 `src/client/errors.ts`

- `DashboardLocaleKey` (the `satisfies Record<DashboardErrorCode, DashboardLocaleKey>` map) is unchanged in shape — it references locale *keys*, which are language-neutral. No change needed unless a key was zh-only (none is — the key set is identical).

### 4.6 Tests

- **`tests/dashboard-i18n-regressions.test.tsx`** — the Chinese-string assertions (`'当前任务源'`, `'项目上下文切换'`, `'Tracker 由目标项目的 WORKFLOW.md 决定。'`, `'1 个 Agent 运行中'`, etc.) are rewritten to the **English** equivalents from the `en` dictionary (`'Current task source'`, `'Project context switcher'`, `"The target project's WORKFLOW.md determines its Tracker."`, `'1 Agent running'`, …). The test logic (search, switch, close-on-success) is preserved.
- **All 14 UI suites** — any Chinese-string `getByRole`/`getByText`/`getByLabelText` selectors are updated to English. The `fixture.ts` (deterministic UI fixtures) is audited for any Chinese display strings and made English.
- **New test: `tests/dashboard-english-only.test.tsx`** (jsdom) — asserts the English-only invariant:
  - The `en` dictionary contains **no CJK characters** (a regex `/\p{Script=Han}/u` over every value).
  - A rendered `DashboardSurface` (fixture snapshot) contains **no CJK characters** in its text content.
  - Every user-facing string in `Dashboard.tsx` is routed through `t(...)` (no hard-coded non-ASCII literals) — verified by a source scan of `Dashboard.tsx` for non-ASCII characters outside comments/imports.

The Harness locale seat contract is preserved (registering a single-locale dictionary is valid). If the seat requires a specific shape, the Build stage records the exact registration and the `dashboard-render` suite proves it.

## 5. Surfaces

### 5.1 Project Overview (new)

A dedicated **Overview** surface — a **new tab** (added to the `Tab` union, placed first in the tab strip; the **board remains the default** landing view to avoid a UX regression and to keep the existing `dashboard-render` suite's default-view assertions intact). It is a pure projection of the existing `DashboardSnapshot` (no new RPC):

- **Active runs** — count + phase breakdown from `snapshot.runs.runs` (`ProjectRunView.phase`), with the most recent non-terminal run highlighted (link to the Run detail).
- **Task health** — running / ready / blocked / failed counts from `snapshot.runs.runs[].taskCounts` (`TaskCountsView`) aggregated, plus `snapshot.runtime` (`running`/`retrying`/`blocked`/`capacity`).
- **Recent activity** — the latest run events across the selected project's runs (from `snapshot.runs.runs` + the existing `runDetail` RPC on demand), newest first, bounded.
- **Usage at a glance** — total tokens from `snapshot.runtime.tokens` (`TokenTotals`) + the selected run's `tokenUsage`.
- **Attention** — the existing `buildAttentionSummary(snapshot)` alerts (configuration / runtime / stale) at the top.

Backed entirely by `DashboardSnapshot` + `buildAttentionSummary` — **no new RPC**.

### 5.2 Agent detail (new)

An in-dashboard **Agent detail** surface, reached from a task row (replacing/augmenting the bare "open session" link). It is a pure projection of the existing `RunDetailView.tasks` (`ProjectTaskView`) — **no new RPC**:

- **Identity** — `assignedAgentId` (session id / member name), the owning task (`title`, `planTaskId`), the role label (`role`).
- **Worktree / branch** — `branch`, `baseCommit`, `headCommit` (Phase 5 Git isolation data; "—" when absent for non-Git projects).
- **Usage** — `tokenUsage` (`TokenTotals`), `turnCount`.
- **Runtime / duration** — `startedAt` → `completedAt` (computed duration), `status`.
- **Attempt history** — `attempt` / `maxAttempts`, `error` (when present).
- **Action** — the existing "open session" action (`onOpenSession(sessionId)`) is preserved as the primary CTA.

### 5.3 Usage summary (new)

A consolidated **usage** surface (a section on the Overview + a per-run block on the Run detail). It is a pure projection of existing `TokenTotals` — **no new RPC**:

- **Per-run** — `ProjectRunView.tokenUsage` (input / output / cacheRead / cacheWrite / reasoning / total), the run's `startedAt` → `completedAt` duration.
- **Per-project** — the sum of `tokenUsage` across the project's runs (computed client-side from `snapshot.runs.runs`), plus `snapshot.runtime.tokens` as the live aggregate.
- **Per-task** — the existing `TokenCell` (already present) is reused; the summary rolls it up.

### 5.4 Automations — next-run column + trigger detail view (deferred from Phase 9)

- **Next-run column.** The trigger list gains a **Next run** column (the `trigger.nextRun` locale key already exists). `nextRunAt` is **not stored** — it is a **documented additive read-only projection** computed on the host side in the `loadTriggers` / `loadTrigger` output path, reusing the existing schedule slot logic (`src/triggers/adapters/schedule.ts`):
  - For a `schedule` trigger with `config.everyMs`: `nextRunAt = createdAt + (floor((now - createdAt) / everyMs) + 1) * everyMs`.
  - For a `schedule` trigger with `config.cron`: `nextRunAt = nextCronSlot(cron, createdAt, now)` (the existing pure slot function).
  - For **non-schedule** triggers (`manual`/`tracker`/`webhook`/`repository-event`/`pr-event`/`system`): `nextRunAt` is **absent** (the column shows "—").
  - The computed `nextRunAt?: string` **and** `recentFires?: readonly { readonly firedAt: string; readonly runId: string; readonly sourceEventKey: string }[]` are added to the client `TriggerView` (`src/client/controller.ts`) as **additive optional fields** — the two new projections in this phase (invariant 1). No new RPC *endpoint*; both are fields on the existing `triggerList`/`triggerGet` output.
- **Trigger detail view.** Selecting a trigger opens a detail view (a dialog or inspector) showing: the full config (per-type fields, credential-free), `goalTemplate`, `approvalMode`, `enabled`, `lastFiredAt`, `lastRunId` (link to the run), `nextRunAt`, and the **fire history**. The fire history is an **additive computed field** on the trigger view (not a new RPC endpoint): `recentFires?: readonly { readonly firedAt: string; readonly runId: string; readonly sourceEventKey: string }[]`, computed on the host side in the `triggerGet` output path from the existing `trigger_fires` table (bounded to the most recent N, newest first). The existing `onFireTrigger` / `onSetTriggerEnabled` / `onDeleteTrigger` actions are preserved.

  > **No invented API.** There is no `triggerFires` RPC endpoint today (only `triggerList` / `triggerGet` / `triggerCreate` / `triggerFire`, where `triggerFire` *fires* a trigger). The fire history is therefore exposed as an **additive computed field** on the existing `triggerGet` output — consistent with the `nextRunAt` projection — not a new endpoint.

### 5.5 Run detail (polished)

The `RunInspector` (the largest surface) is refined so a user "can understand current progress without reading raw session logs" (master spec §74 UX):

- **Clear phase/state** — the run phase + `suspendedFrom` + version, with the phase-change timeline.
- **Task progress** — the task list with status, progress (succeeded/total), and the current task highlighted.
- **Agent detail** — the §5.2 surface, reached from each task row.
- **Usage** — the §5.3 per-run block.
- **Understandable event timeline** — the existing event timeline, with `task.interrupted` / `run.recovered` (Phase 10) and all other event types rendered as human-readable rows (title + detail + timestamp), not raw codes.

### 5.6 Plan / DAG (polished)

The plan is rendered as a **dependency DAG** rather than a flat list:

- **Nodes** — each `PlannedTask` (from `RunPlanRecord.tasks`) as a node, labeled with its `id` (`t1`..`tN`) + `title`, status-colored (pending / ready / running / blocked / succeeded / failed) from the matching `ProjectTaskView` (matched by `planTaskId === PlannedTask.id`).
- **Edges** — each `PlannedTask.dependencies` (task ids) as a directed edge (dependency → dependent).
- **Layout** — a deterministic left-to-right layered layout (topological order by dependency depth; ties broken by `planTaskId`), rendered with CSS (no external graph library — the Dashboard has no graph dependency and the DAG is small: a plan's tasks). The current task (the one `running`) is highlighted.
- **Fallback** — when a plan has no dependencies (a linear plan), the DAG degenerates to a vertical list (identical to today) — no visual regression.

Backed by the existing `RunPlanRecord` (`planList` / `planDetail` RPC) + `RunDetailView.tasks` — **no new RPC**.

### 5.7 Approval UX (polished)

The approval section on the Run detail is refined:

- **Pending/decided states** — each `ApprovalRequestView` shows its `status` (`pending` / `approved` / `rejected` / `expired`) with a clear visual state (a pending badge vs. a decided check/cross).
- **Mode** — the run's `approvalMode` (`manual` / `plan` / `guarded` / `autonomous`).
- **Requester + type** — the `type` (`plan` / `external-write` / `git-push` / `pull-request` / `merge` / `dangerous-action`) + `summary`.
- **Audit trail** — `requestedAt`, `resolvedAt`, `resolvedBy` (when decided).
- **Resolve action** — the existing `onResolveApproval` action, enabled only for `pending` approvals.

Backed by the existing `RunDetailView.approvals` (`ApprovalRequestView`) — **no new RPC**.

### 5.8 Memory (polished)

The Memory page is refined for consistency and completeness:

- **Search** — the existing query input is wired to `MemoryListInput.query`.
- **Kind / status filters** — the `counts` (per-kind) + `status` (`active` / `archived`) filters are shown and applied.
- **Entry detail** — the entry body, `tags`, `sourceRunId` / `sourceTaskId` / `sourceSessionId` (provenance links), `confidence`, `pinned`, `supersedes`.
- **Create / edit flows** — the existing `MemoryCreateDialog` / `MemoryEditDialog` are consistent (kind picker, tags, pinned, confidence) and complete.

Backed by the existing `memoryList` / `memoryCreate` / `memoryUpdate` / `memorySetStatus` RPCs — **no new RPC**.

### 5.9 Artifacts (polished)

The Artifacts page is refined for consistency and completeness:

- **Provenance** — each `ArtifactView` shows `runId` / `taskId` (links to the run/task), `kind`, `title`.
- **Final report** — the `final-report` artifact is highlighted; the existing `FinalReportDocument` renderer is preserved.
- **Artifact detail** — the existing `ArtifactDetail` (content / path / url / metadata) is consistent and complete.
- **Create flow** — the existing `AddArtifactDialog` is consistent (kind picker, title, content / path / url).

Backed by the existing `artifactList` / `artifactCreate` RPCs — **no new RPC**.

### 5.10 Understandable errors (polished)

The observability criterion "errors are understandable" (master spec §74):

- Domain errors are presented with a **human-readable message**: the existing `dashboardErrorMessage` (`src/client/errors.ts`) maps `DashboardDomainError.dashboardCode` + `params` to a localized message. The UI renders that message (not the raw code) in every error surface (the `DashboardErrorNotice`, the action toasts, the inspector error rows).
- The `params` (e.g. the field name in a validation error) are interpolated into the message.

Backed by the existing `dashboardErrorMessage` — **no new RPC**.

### 5.11 Responsive behavior

A systematic pass over **responsive behavior**:

- The surfaces must be usable at the **narrow overlay widths** the native Harness shell provides (no horizontal overflow, sensible column collapse, dialogs that fit).
- The board / run list / trigger list collapse to a single column below a breakpoint; the DAG wraps; the Overview metrics stack.
- Verified by the jsdom UI suites at a **narrow viewport** (the `dashboard-render` suite asserts no element overflows the container width at a narrow width).

## 6. Module layout & wiring

All changes are in `src/client/**` (the browser side) + two host-side projection fields:

- `src/client/locales.ts` — **done (PR #4):** `zh` kept as an English mirror of `en` (the locale seat requires both `LOCALE_IDS`); `en` is the source of truth. New-surface keys (`overview.*`, `agent.*`, `usage.*`, `trigger.detail.*`, `plan.dag.*`, `approval.*`) are added to `en` with the `zh` mirror kept byte-identical.
- `src/client/i18n.tsx` — **done (PR #4):** `DashboardLocale = 'en'`; fallback + translator English.
- `src/client/index.tsx` — **done (PR #4):** locale seat registers `{ zh, en }` (both English).
- `src/client/dev.tsx` — **done (PR #4):** dev harness English.
- `src/client/controller.ts` — `TriggerView` gains `nextRunAt?: string` + `recentFires?: readonly { readonly firedAt: string; readonly runId: string; readonly sourceEventKey: string }[]` (§5.4); the `loadTriggers` / `loadTrigger` path maps the host projection.
- `src/triggers/trigger-service.ts` (host) — the `triggerList` / `triggerGet` output computes `nextRunAt` via the existing schedule slot logic + `recentFires` from the existing `trigger_fires` table (bounded, newest first) (§5.4). **The one host-side change.**
- `src/client/Dashboard.tsx` — the new surfaces (Overview, Agent detail, usage summary, trigger detail, Plan/DAG, approval UX) + the polished surfaces (Run detail, Memory, Artifacts, errors) + the responsive pass. New components: `OverviewView`, `AgentDetailPanel`, `UsageSummary`, `TriggerDetailView`, `PlanDag`, `ApprovalSection` (refactored). Existing components are refined in place.
- `src/client/locales.ts` (`en`) — new keys for the new surfaces (`overview.*`, `agent.*`, `usage.*`, `trigger.detail.*`, `plan.dag.*`, `approval.*`).
- `src/client/styles.ts` — new styles for the new surfaces + the responsive breakpoints.
- `src/client/fixture.ts` — the deterministic UI fixtures are audited for Chinese and made English; new fixture data for the new surfaces (a DAG plan, an agent detail, a usage summary, a trigger with `nextRunAt`).

No new storage domain, no new table, no new RPC endpoint (only the additive `nextRunAt` + `recentFires` fields on the existing trigger output).

## 7. Test plan

### 7.1 `tests/dashboard-english-only.test.tsx` (new, jsdom)

The English-only invariant (§4.6):

- The `en` dictionary contains **no CJK characters** (regex `/\p{Script=Han}/u` over every value).
- A rendered `DashboardSurface` (fixture snapshot) contains **no CJK characters** in its text content.
- `Dashboard.tsx` has **no hard-coded non-ASCII user-facing literals** (source scan).

### 7.2 `tests/dashboard-i18n-regressions.test.tsx` (updated)

The Chinese-string assertions are rewritten to English (§4.6); the test logic is preserved.

### 7.3 `tests/dashboard-overview.test.tsx` (new, jsdom)

The Project Overview (§5.1): active runs + phase breakdown, task health counts, recent activity, usage at a glance, attention alerts — all from the fixture snapshot.

### 7.4 `tests/dashboard-agent-detail.test.tsx` (new, jsdom)

The Agent detail (§5.2): identity, worktree/branch, usage, duration, attempt history, the "open session" action — from a fixture `RunDetailView.tasks`.

### 7.5 `tests/dashboard-usage.test.tsx` (new, jsdom)

The usage summary (§5.3): per-run + per-project token/duration rollups — from fixture `TokenTotals`.

### 7.6 `tests/dashboard-automations.test.tsx` (extended)

The next-run column + trigger detail view (§5.4): the `nextRunAt` column (schedule trigger shows a value, non-schedule shows "—"), the trigger detail view (config + `recentFires` fire history + `lastFiredAt`/`lastRunId`), the existing create/enable/delete/fire actions.

### 7.7 `tests/dashboard-plans-interactions.test.tsx` (extended)

The Plan/DAG (§5.6): the DAG renders nodes + edges, status-colored, the current task highlighted; a linear plan degenerates to a list (no regression).

### 7.8 `tests/dashboard-approvals.test.tsx` (extended)

The approval UX (§5.7): pending/decided states, mode, requester + type, audit trail (requestedAt / resolvedAt / resolvedBy), the resolve action (enabled only for pending).

### 7.9 `tests/dashboard-render.test.tsx` (extended)

The responsive pass (§5.11): no element overflows the container width at a narrow viewport; the board / run list / trigger list collapse to a single column.

### 7.10 Existing suites (updated for English-only)

All 14 existing UI suites (`dashboard-render`, `dashboard-inspector`, `dashboard-runs-interactions`, `dashboard-tasks-interactions`, `dashboard-memory`, `dashboard-artifacts`, `dashboard-projects-interactions`, `dashboard-coordinator-interactions`, `dashboard-local-interactions`, `dashboard-ux-p0`, …) pass, with any Chinese-string selectors updated to English.

### 7.11 Host-side (node)

The `nextRunAt` + `recentFires` projections (§5.4) are covered by an extension to `tests/trigger-service.test.ts` (a schedule trigger's `triggerGet` output carries a computed `nextRunAt` + bounded `recentFires`; a non-schedule trigger's `nextRunAt` is absent; `recentFires` is newest-first and bounded).

## 8. Acceptance criteria (maps to `intent.md` §6)

1. **English-only UI.** The `zh` dictionary is removed; the Dashboard renders English only (fallback, dev harness, locale seat). A test asserts no CJK characters in the rendered Dashboard or the `en` dictionary, and that user-facing strings are routed through the translator. The Harness locale seat contract is preserved.
2. **Project Overview is useful.** A dedicated overview surface shows active runs, task health, recent activity, and usage at a glance, backed by real snapshot data.
3. **Agent detail is useful.** An in-dashboard agent detail surface shows identity, session, worktree/branch, tokens, duration, and attempt history, with the "open session" action preserved.
4. **Usage summaries are visible.** Per-run and per-project token/duration rollups are shown.
5. **Automations is finished.** The `nextRunAt` column and the trigger detail view (config + fire history) are present (the Phase 9 deferral is closed).
6. **Plan/DAG is visualized.** The plan renders as a dependency DAG (nodes + edges, status-colored), not a flat list.
7. **Approval UX is clear.** Pending/decided states, mode, requester, decision + timestamp (audit), and the resolve action are presented clearly.
8. **Errors are understandable.** Domain errors render as human-readable messages (not raw codes).
9. **Responsive behavior.** The surfaces are usable at narrow overlay widths (no overflow, sensible collapse) — verified by the jsdom suites.
10. **The repo stays green.** `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` pass (modulo the pre-existing, documented environment failures). The existing UI suites all pass, updated for English-only.

## 9. Explicit non-goals (Phase 12+)

- **No new host-side capability, no new storage domain, no new table/field, no migration** — `dsh_projects` stays at format version 0 (the `nextRunAt` projection is computed, not stored).
- **No new RPC endpoint** — only the additive `nextRunAt` + `recentFires` fields on the existing trigger output.
- **No Phase 12** (Remote Worker Provider) — that is the optional next phase.
- **No re-implementation of the native session view** — the "open session" action still jumps to the native Harness session; the Agent detail surface is an in-dashboard summary, not a replacement.
- **No new backend reconciliation or concurrency work** — Phase 10 is done; this phase is frontend-only.
- **No external graph/DAG library** — the Plan/DAG is rendered with CSS (the plan's task count is small).

## 10. Sequencing (build order)

1. **English-only localization** (§4) — **DONE (PR #4, squash `015757c`)**: `zh` kept as an English mirror of `en`, `i18n.tsx` / `index.tsx` / `dev.tsx` rewired to English, all UI test selectors updated to English, the `dashboard-english-only` guard added.
2. **The `nextRunAt` + `recentFires` projection** (§5.4) — the host-side computed fields + the client `TriggerView` fields + the `trigger-service` test.
3. **New surfaces** (§5.1–5.3, §5.4) — Overview, Agent detail, usage summary, trigger detail view + their tests.
4. **Polished surfaces** (§5.5–5.10) — Run detail, Plan/DAG, approval UX, Memory, Artifacts, understandable errors + their tests.
5. **Responsive pass** (§5.11) — the narrow-viewport assertions + the responsive styles.
6. **Green gate** — `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` all pass.
