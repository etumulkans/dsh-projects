# Test Report — Phase 7: Approvals + budgets

Test-stage artifact for the Phase 7 diff (build commit `7c6db58`,
intent `d30a7da`, spec `321821d` — §9 test plan + §10 acceptance
criteria). Verified on local `main` @ `7c6db58`, 2026-09-14.

## 1. Test inventory

| File | Cases | Scope (spec §9) |
| --- | --- | --- |
| `tests/approval-service.test.ts` (new, in-memory domain + real `ApprovalService`) | 21 | §9.1 the service: the **policy table** (all 4 modes × the 2 stages — `manual`/`plan`: plan+merge gated; `guarded`/`autonomous`: merge only); **request** (a pending object persists with the `run.approval.requested` event + Cordis event; idempotent re-request returns the existing pending — one per `(run, type)`; a terminal object is superseded by a new pending, the old retained — never deleted; `summary` bounds 1..500; `payload` stored as-is); **resolve** (CAS `approval.staleVersion` on mismatch with `expectedVersion`/`actualVersion`; `resolvedBy` default `'dashboard'`; `resolvedAt` set; `run.approval.resolved` event; resolving a terminal object → `approval.invalidStatus`); **expire** (pending → `expired`, the only path; terminal → `approval.invalidStatus`; no TTL — the object stays `pending` across a clock advance); the **plan hook** (`onApprovalResolved` fires on resolve + expire, the plan service's own `plan.approval.*` events unchanged); `listApprovals` newest-first + run/project filters; `pendingFor` lookup. |
| `tests/budget-enforcement.test.ts` (new, in-memory domain + real services + fake clock) | 15 | §9.2 budgets: the **80% warning** (a token usage crossing 80% → `run.budget.warning` with `<key> at <pct>% of <limit>` + the key added to `run.budgetWarnings`; a second crossing → no second event, once per key; a different key → its own warning); the **limit** (usage ≥ 100% → the run moves `paused` with `suspendedFrom` + `resultSummary` `Budget limit reached: <key> (…)`, the `run.budget.exceeded` event, the scheduler tick skips the paused run); **runtime** (`maxRuntimeMinutes` crossing → the same pause at the tick check); the **scheduler cap** (`maxAgents`/`maxConcurrentAgents` cap the ready-task pick — no pause, no event); the **retry budget** (`taskRetry` at `attempt >= maxRetriesPerTask` → `task.retryBudgetExceeded`, the task stays `failed`; below → the retry proceeds); the **replan budget** (`createPlan` with `supersedesPlanId` when the chain ≥ `maxReplans` → `plan.replanBudgetExceeded`); **unset = unlimited** (an absent key → no check, no event); the **budget patch** (`runSetBudget` on a `paused` run replaces the budget + clears the raised key from `budgetWarnings`; a non-`paused`/`blocked` run → `run.budgetPhaseInvalid`; an invalid budget → `run.budgetInvalid` with `{ key, reason }`); `maxCost` validated at creation with no check site. |
| `tests/task-service.test.ts` (extended) | 31 (24 + **7 new**) | §9.3 the **merge gate** end-to-end: `detectAllSucceeded` with `requiresApproval(mode, 'merge')` true → the approval is requested + the run moves `executing → awaiting_approval` (the pipeline does not run); `false` → today's behavior (`integrating`, the pipeline runs); the **resume** path (approval `approved` → `awaiting_approval → integrating` → the next tick runs the pipeline); the **reject** path (`awaiting_approval → blocked`); the budget pause + `runSetBudget` resume round-trip through the real task scheduler. |
| `tests/plan-service.test.ts` (extended) | 16 (14 + **2 new**) | §9.4 the **plan trigger site**: the plan service's `onApproval` fires at the three transition points (requested/approved/rejected) creating + resolving the run approval object; the `plan.approval.*` events are unchanged; the replan-budget rejection surfaces through the plan service. |
| `tests/rpc-handler.test.ts` (extended) | 48 (40 + **8 new**) | §9.5 the RPC surface: `approvalRequest` / `approvalResolve` / `approvalExpire` / `approvalList` dispatch with validation (missing `id` → `bad-request`); `runSetBudget` dispatches a validated budget with optional CAS (`expectedVersion`); the extended `createRun` carries `approvalMode` + `budget`; the extended `runDetail` projection carries `approvals` + `budget` + `budgetWarnings`. |
| `tests/dashboard-approvals.test.tsx` (new, jsdom) | 9 | §9.6 the UI (zh/en parity): the **Approvals section** renders a pending merge approval (status/type/summary) and **Approve**/**Reject** dispatch `onResolveApproval(id, decision, version)` with the success notice; the empty state; the **Budget panel** renders limits + `used / limit` usage + the 80% `⚠` marker, hidden when the run has no budget; the **New Run dialog** carries the approval-mode select + the nine budget fields and submits `{ goal, approvalMode, budget }` (omitting them when empty); the same sections render in English. |
| `tests/run-storage-integration.test.ts` (extended) | 6 (5 + **1 new**) | §9.7 the **store**: `project_approvals` is a declared table (the set grows by exactly one); records validate against the strict schema; `version` bumps on every accepted mutation; a pending approval + the run's `approvalMode`/`budget`/`budgetWarnings` fields survive a real JSON domain reopen (browser refresh / process restart do not lose a pending approval). |
| `tests/client-approvals-isolation.test.ts` (new) | 1 | §9.8 the client never imports the node-side approval/budget modules — the client bundle resolves without them (the §8 isolation invariant). |
| `tests/run-state-machine.test.ts` (updated) | 12 | §9.1 the **state machine**: the full transition table now asserts the two additive Phase 7 edges — `awaiting_approval → integrating` (an approved merge resumes directly into the integration step) and `executing → awaiting_approval` (the merge gate); all pre-existing edges + the `succeeded` `resultSummary` behavior unchanged. |

**Total: 492 tests — 489 passed / 3 failed** (the 3 are the documented
pre-existing `project-catalog` macOS failures, §4). **64 new Phase 7 tests**
(46 in the four new files + 18 added to the five extended suites), all green.

## 2. Acceptance criteria (spec §10) — all verified

1. **Store** — `project_approvals` is a declared `dsh_projects` table (v0, no
   migration); strict-schema validation; `version` bumps on every accepted
   mutation; approvals + the run's budget/approval fields survive a real JSON
   domain reopen; the table set grows by exactly one. →
   `run-storage-integration.test.ts` + `approval-service.test.ts`.
2. **Policy** — the four modes behave per §4.2 (the pure `requiresApproval`
   table); the conservative default is `plan` (the config default); the mode
   is stored per run and visible in the UI (the mode chip); the coordinator's
   `settle` consults the policy (the plan gate lifted for
   guarded/autonomous). → `approval-service.test.ts` (policy table) +
   `dashboard-approvals.test.tsx` (mode chip).
3. **Objects** — request/resolve/expire persist + project onto the run event
   stream (`run.approval.*`); the `plan.approval.*` events are unchanged; one
   pending per `(run, type)` (idempotent re-request); terminal objects are
   retained (never deleted); resolution resumes/blocks the run through the
   state machine (the merge gate); browser refresh + process restart do not
   lose a pending approval. → `approval-service.test.ts` +
   `task-service.test.ts` (merge gate) + `run-storage-integration.test.ts`.
4. **Budgets** — every declared key (except `maxCost`, which has no site) is
   enforced in code at the named §5.1 site: the 80% warning once per key, the
   limit → the per-key policy action (§5.3), the `resultSummary` explains why;
   unset keys are unlimited; budgets are set at creation and raised explicitly
   (`runSetBudget`); no key is enforced by prompt text alone. →
   `budget-enforcement.test.ts`.
5. **UI** — the Approvals section + Approve/Reject dispatch real RPCs with
   surfaced errors; the Budget panel renders usage + warning markers; the New
   Run dialog carries the budget + mode fields; the existing plan
   approve/reject buttons are unchanged; zh/en parity compile-enforced. →
   `dashboard-approvals.test.tsx` (jsdom, zh+en) +
   `client-approvals-isolation.test.ts`.
6. **Repo green** — `pnpm run typecheck` (exit 0), `pnpm run build` (exit 0 —
   client 427.93 kB / host 407.55 kB), full `pnpm vitest run` (489/3 of 492,
   the 3 modulo the documented pre-existing environment failures, §4).

## 3. Test-stage fixes (made while verifying)

- **`tests/run-state-machine.test.ts`** — the hardcoded full transition table
  predated the two additive Phase 7 edges; updated `awaiting_approval` to
  include `integrating` and `executing` to include `awaiting_approval`
  (spec §9.1 "the one-edge addition" + the §4.5 merge gate).
- **`src/approvals/approval-service.ts` `listApprovals`** — the sort
  tiebroke same-millisecond `requestedAt` on the random `id`, making
  "newest first" non-deterministic for back-to-back requests (a full-suite
  flake in `approval-service.test.ts`). Now reverses the insertion-ordered
  rows before the stable sort, so same-tick records list in true creation
  order (latest created first) independent of the id.
- **Type errors under `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`**
  (all in Phase 7 test files, fixed for the §10.6 typecheck gate):
  `approval-service.test.ts` (`pendingFor(…)?.id`, `onResolved[1]?.status`),
  `rpc-handler.test.ts` (`fakeRunService` gains the `setRunBudget` seam),
  `task-service.test.ts` (capture `overrides.budget` in a local const so the
  `update` closure keeps the narrowed `RunBudget`).

## 4. Known pre-existing failures (carried, documented)

`tests/project-catalog.test.ts` — 3 of 6 cases fail on this host because
`tmpdir()` yields `/var/folders/…` while the catalog canonicalizes paths to
`/private/var/folders/…` (macOS symlink). Present since Phase 3 (baseline then
295/3 of 298; Phase 5 336/3 of 339; Phase 6 425/3 of 428); the fix-vs-document
decision is open in `maintain.md`. Unchanged by Phase 7 (489/3 of 492 — all
64 new Phase 7 tests pass).

`tests/integration-strategy.test.ts` — the git-worktree cases are flaky
**under full-suite load** (temp-dir / worktree contention); they pass 7/7 in
isolation and in the clean full-suite run that produced the §1 numbers. Not
introduced by Phase 7 (the Phase 7 diff does not touch the merge strategy).
