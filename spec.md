# Spec — Phase 7: Approvals + budgets

**Gate:** Design · **Intent:** `intent.md` (Phase 7, commit `d30a7da`) · **Master spec:** `DSH_PROJECTS_SPEC.md` §18 (approval modes), §19 (approval objects), §30 (budgets) · **Predecessor:** Phase 6 spec (Project Memory, `3a03aab`)

## 1. Goal and success

A run only does what its **approval mode** allows, and it stops when it runs
out of **budget** — both enforced in code (not model instructions), both
persisted (surviving browser refresh and process restart), both visible and
inspectable in the Dashboard.

Success: the `project_approvals` table + approval-mode policy gate the plan
and merge stages; every declared `RunBudget` key is checked at a named code
site with an 80% warning and a limit action; the Dashboard shows pending
approvals (Approve/Reject), the run's mode, and budget usage; the existing
plan-approval flow keeps working unchanged (it now resolves a persisted
object); `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green
(modulo the documented pre-existing environment failures).

## 2. Invariants (from `intent.md` §3)

1. **No invented APIs.** Only native Harness/Cordis/Agent-Teams/subagent/storage primitives as installed.
2. **No placeholder APIs, no fake UI data.** Every RPC, service method, and UI control is backed by real behavior; declared-but-untriggered approval types are generic (the endpoint works for any declared type) but have no fake trigger sites.
3. **No premature phases.** No new run phases; no triggers (Phase 9), no artifacts (Phase 8), no TTL timers.
4. **Preserve existing behavior.** The Phase 2 plan-approval flow (plan `awaiting-approval` ↔ run `awaiting_approval`, the `plan.approval.*` events, the plan UI buttons) keeps working exactly as today — Phase 7 adds a persisted object behind it, not a replacement.
5. **Extend the native Dashboard UI** (one frontend, existing slots).
6. **State in code + persistent storage** (`dsh_projects` domain, format version stays 0).
7. **Repo stays buildable and testable** at every commit.

## 3. Storage (additive, domain stays v0)

### 3.1 `project_approvals` table (new)

Declared in `dshProjectsDomainSpec` (the domain version stays 0 — storage-domain
initializes absent declared tables as empty, per the Phase 2/4/6 precedent):

```ts
export type ApprovalType =
  | 'plan' | 'external-write' | 'git-push' | 'pull-request' | 'merge' | 'dangerous-action'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface ApprovalRequestRecord {
  readonly id: ApprovalId            // uuid
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly type: ApprovalType
  readonly summary: string           // 1..500 chars
  readonly payload?: unknown         // structured context for the type (e.g. branch names for merge)
  readonly status: ApprovalStatus
  readonly requestedAt: string       // ISO
  readonly resolvedAt?: string       // ISO; set on any terminal status
  readonly resolvedBy?: string       // 1..200; who resolved
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number           // CAS, min 1
}
```

Strict zod schema (`projectApprovalRecordSchema`) in `src/approvals/spec.ts`;
`payload` is `z.unknown().optional()` (the type-specific shape is validated by
the trigger site, not the table). `summary` is `nonBlank` with a 500-char cap
(`z.string().trim().min(1).max(500)`).

### 3.2 Run record — three additive optional fields

```ts
/** Additive (Phase 7): the approval mode governing this run (config default when absent). */
readonly approvalMode?: 'manual' | 'plan' | 'guarded' | 'autonomous'
/** Additive (Phase 7): the run's budget limits. Absent or key-absent = unlimited for that key. */
readonly budget?: RunBudget
/** Additive (Phase 7): budget keys that already emitted their 80% warning (one warning per key per run). */
readonly budgetWarnings?: readonly string[]
```

`RunBudget` (in `src/runs/types.ts`):

```ts
export interface RunBudget {
  readonly maxRuntimeMinutes?: number   // int, 1..100_000
  readonly maxTotalTokens?: number      // int, >= 1
  readonly maxInputTokens?: number      // int, >= 1
  readonly maxOutputTokens?: number     // int, >= 1
  readonly maxAgents?: number           // int, 1..50 (caps the concurrency knob, §5.3)
  readonly maxConcurrentAgents?: number // int, 1..50
  readonly maxReplans?: number          // int, >= 1
  readonly maxRetriesPerTask?: number   // int, >= 1
  readonly maxCost?: number             // number, >= 0 — declared; unenforceable until a cost source exists (§5.5)
}
```

All keys optional; the schema is `z.object({ … }).strict().optional()` with
per-key `z.number().int().min(…)` bounds as above. `maxCost` is a plain
`z.number().min(0)` (not int — costs are fractional).

### 3.3 Run event types (additive — two)

```
'run.approval.requested'   // an ApprovalRequest went pending (any type)
'run.approval.resolved'    // an ApprovalRequest went terminal (detail: `<type> <status> by <resolvedBy>`)
'run.budget.warning'       // a budget key crossed 80% (detail: `<key> at <pct>% of <limit>`)
'run.budget.exceeded'      // a budget key hit its limit (detail: the per-key action, §5.4)
```

The existing `plan.approval.requested` / `plan.approved` / `plan.rejected`
events are **unchanged** — they stay the plan-status projection (the plan
service emits them on plan transitions, exactly as today). The new
`run.approval.*` events are the **approval-object** projection (the approval
service emits them on object transitions). For `type: 'plan'` objects both
streams fire (plan event from the plan service, run.approval event from the
approval service) — the event stream is an append-only log; the object is the
single authority for "is this approved?" (§4.4).

## 4. Approval service — `src/approvals/approval-service.ts`

### 4.1 Service shape

`ApprovalService` (host-only; the client never imports it — the Phase 6
isolation invariant extends: a new scan asserts no `src/client/**` file
imports `src/approvals/**`):

```ts
constructor(ctx: Context, catalog: ProjectCatalog, runService: ProjectRunService)
start(): Promise<void>   // borrows the shared dsh_projects tables (requires runService started)
stop(): Promise<void>
```

Borrows the `project_approvals` table from the shared domain (the same
borrow pattern as `ProjectMemoryService` — `start()` after `runService.start()`,
`stop()` before `runService.stop()` in `index.ts`).

### 4.2 The mode policy table (master spec §18)

The mode is read from the run record (`run.approvalMode`, falling back to the
config default — §6.2). The policy table, `approvalPolicy.ts` (pure, exported
for tests):

| Stage | `manual` | `plan` | `guarded` | `autonomous` |
| --- | --- | --- | --- | --- |
| **plan** (activating a plan) | approval required | approval required | **not required** | **not required** |
| **merge** (the run's integration merge) | approval required | approval required | approval required | approval required |

- **`manual`** — approval before the major execution stages: the plan gate
  and the merge gate.
- **`plan`** — the human approves the Run Plan; after approval local
  execution proceeds automatically (the merge gate still applies — the
  integration merge is an external/dangerous stage, not "local execution").
- **`guarded`** — ordinary sandboxed work (planning, task execution) proceeds
  automatically; the plan gate is lifted (the plan is activated directly),
  the merge gate applies.
- **`autonomous`** — the coordinator proceeds without plan approval, within
  permissions and budgets; the merge gate applies. Even in autonomous mode:
  never bypass Harness permissions, never silently elevate permissions, never
  merge into protected production branches by default, never expose secrets
  (master spec §18) — these are honored by the gate itself (the merge always
  requires approval in every mode; there is no per-run override that lifts it
  in Phase 7) and by the existing Harness permission preset (the agent
  profile's `permissionPreset` is untouched).
- **The default is conservative:** the config default is **`plan`** (§6.2).

`requiresApproval(mode, stage): boolean` is the pure function; the two
`ApprovalStage` values are `'plan' | 'merge'` (the other declared
`ApprovalType`s have no trigger site in Phase 7 — §7).

### 4.3 Request / resolve

```ts
/** Create a pending approval (idempotent per (run, type): an existing pending object for the same
 *  (runId, type) is returned, not duplicated). A *terminal* object for the same
 *  (runId, type) never blocks a new request — the new pending object supersedes it
 *  (the old object is retained for the audit trail, never deleted). */
requestApproval(input: {
  readonly runId: RunId
  readonly type: ApprovalType
  readonly summary: string            // 1..500
  readonly payload?: unknown
}): Promise<ApprovalRequestRecord>

resolveApproval(id: ApprovalId, decision: 'approved' | 'rejected', input: {
  readonly expectedVersion?: number   // CAS
  readonly resolvedBy?: string        // 1..200, default 'dashboard'
}): Promise<ApprovalRequestRecord>

/** Explicit expiry (no TTL — §7): mark a pending object `expired` (e.g. its run was canceled). */
expireApproval(id: ApprovalId, input: { readonly expectedVersion?: number }): Promise<ApprovalRequestRecord>

listApprovals(runId?: RunId, projectId?: RunId): ApprovalRequestRecord[]  // newest first
```

- **One pending per (run, type):** `requestApproval` first looks up a pending
  object for the same `(runId, type)` and returns it (idempotent re-request).
  A *terminal* object for the same `(runId, type)` is superseded by a new
  pending one (a rejected plan can be re-requested; a rejected merge can be
  re-requested after the run is resumed) — the old object is never deleted
  (audit trail).
- **Resolve** is CAS on `version` (`approval.staleVersion` on mismatch,
  `expectedVersion`/`actualVersion` params like `memory.staleVersion`);
  resolving a terminal object → `approval.invalidStatus`; `resolvedBy`
  defaults to `'dashboard'`; `resolvedAt` is set.
- **Expiry** is the only path to `expired` (no background timer — §7);
  resolving an already-terminal object → `approval.invalidStatus`.
- Every accepted mutation bumps `version`, sets `updatedAt`, persists first,
  then appends the run event (§3.3) and emits a Cordis event:
  - `requestApproval` → `run.approval.requested` (title `Approval requested: <type>`, detail = summary) + `dsh-projects/approval/requested`
  - `resolveApproval` → `run.approval.resolved` (title `Approval <status>: <type>`, detail `<type> <status> by <resolvedBy>`) + `dsh-projects/approval/resolved`
  - `expireApproval` → `run.approval.resolved` (detail `<type> expired by <resolvedBy>`) + `dsh-projects/approval/resolved`

### 4.4 The plan trigger site (the existing flow, now persisted)

The plan approval flow today: the coordinator submits the plan → the plan
service moves it to `awaiting-approval` → the `PlanRunCoupler` moves the run
`planning → awaiting_approval` → the user approves/rejects in the plan UI
(`planTransition` RPC) → the plan moves `active`/`draft` → the coupler moves
the run `executing`/`planning`.

Phase 7 inserts the approval object **at the plan transition**, inside the
plan service's existing `onPlanStatus`-adjacent flow — specifically a new
optional hook on `RunPlanService` (the same hook pattern as `onPlanStatus`):

```ts
hooks: {
  onPlanStatus?: …  // existing
  onPlanApproval?: (event: PlanApprovalEvent) => Promise<void>  // NEW (Phase 7)
}
```

`PlanApprovalEvent` = `{ runId, planId, version, action: 'requested' | 'approved' | 'rejected', summary }`,
fired from the plan service at the three existing transition points
(`awaiting-approval` → `requested`; `active` → `approved`; `draft` (from
`awaiting-approval`) → `rejected`). A plan that goes `draft → active`
directly (the `direct` pattern, or a `guarded`/`autonomous` orchestrated
plan, §4.4) fires `approved` with **no pending object to resolve** — the
wiring's `pendingFor` lookup returns `undefined` and the hook is a no-op
(the object exists only when the plan actually went through
`awaiting-approval`). The wiring in `index.ts`:

```ts
planService = new RunPlanService(ctx, runService, undefined, {
  onPlanStatus: async event => { await coupler.handle(event); await taskService.handlePlanStatus(event) },
  onPlanApproval: async event => {
    if (event.action === 'requested') {
      await approvalService.requestApproval({ runId: event.runId, type: 'plan', summary: `Plan v${event.version} approval requested` })
    } else {
      const pending = approvalService.pendingFor(event.runId, 'plan')
      if (pending !== undefined) await approvalService.resolveApproval(pending.id, event.action, { resolvedBy: 'plan-ui' })
    }
  },
})
```

- The `plan.approval.*` run events and the plan UI buttons are **unchanged**
  (invariant 4) — the hook only adds the persisted object + the
  `run.approval.*` events behind them.
- **Mode gating for the plan:** the coordinator's `settle` (Phase 3) today
  always moves an orchestrated plan to `awaiting-approval`. Phase 7 changes
  `settle` to consult the policy: `requiresApproval(mode, 'plan')` true →
  `awaiting-approval` (today's behavior); false → `active` directly (the
  `direct`-pattern path). The mode is read from the run record (config
  default when absent). The `direct` pattern is unaffected (it was always
  auto-activated).

### 4.5 The merge trigger site (the Phase 5 integration step)

The integration step today: all coding tasks succeed → the run moves
`executing → integrating` → `driveCompletionPipeline` runs the integration
strategy (merge the task branches into the integration branch) → `validating`.

Phase 7 inserts the merge gate **at the `executing → integrating` edge**, in
`ProjectTaskService.detectAllSucceeded` (the single site that moves the run
to `integrating`):

```
if (requiresApproval(run.approvalMode, 'merge')) {
  await approvalService.requestApproval({
    runId, type: 'merge',
    summary: `Merge ${taskBranches.length} task branch(es) into ${integrationBranch}`,
    payload: { integrationBranch, taskBranches },
  })
  await runService.transitionRun(runId, 'awaiting_approval')   // the run pauses at the gate
  return  // the pipeline does not run yet
}
// no approval required: today's behavior (the run moves integrating → pipeline runs)
```

- The run is in `awaiting_approval` with `suspendedFrom: 'executing'` (the
  existing `suspendedFrom` machinery — no new phase).
- **Resume:** when the `merge` approval is resolved `approved`, the approval
  service (via the `onApprovalResolved` hook, §4.6) moves the run
  `awaiting_approval → integrating` directly. (Resuming to `executing`
  instead would re-trigger `detectAllSucceeded` and re-request the approval
  — an infinite loop.) This spec adds `integrating` to
  `ALLOWED_TRANSITIONS['awaiting_approval']` — a one-edge addition to the
  state machine, validated by `transitionRun`. The next scheduler tick sees
  `run.phase === 'integrating'` and runs `driveCompletionPipeline` (the
  existing crash-safety leg handles the event/phase ordering).
- **Reject:** the approval resolution moves the run `awaiting_approval →
  blocked` (the existing edge; resumable — a human can re-request the merge
  approval or cancel the run).
- **The pipeline itself is unchanged** — the gate is at the edge, not inside
  the merge. The integration strategy, the `run.integration.*` events, and
  the verification leg all work exactly as today.

### 4.6 The approval → run coupling hook

`ApprovalService` takes an optional hook (the same pattern as
`ProjectTaskService.hooks.onRunSucceeded`):

```ts
hooks?: {
  onApprovalResolved?: (record: ApprovalRequestRecord) => Promise<void>
}
```

Wired in `index.ts` to move the run (§4.5): `approved` + `type: 'merge'` →
`runService.transitionRun(runId, 'integrating')`; `rejected` + `type:
'merge'` → `runService.transitionRun(runId, 'blocked')` (with the
`run.approval.resolved` event already appended); `type: 'plan'` → no run move
(the plan coupler already moved it — the object is the audit record). A
guard miss (the run moved concurrently) is a logged no-op, exactly like the
`PlanRunCoupler` (invariant: the approval resolution stands; the run phase
simply does not follow).

## 5. Budgets (master spec §30)

### 5.1 Where the checks live

| Key | Site | Usage source |
| --- | --- | --- |
| `maxTotalTokens` / `maxInputTokens` / `maxOutputTokens` | `ProjectTaskService` — after each task's `tokenUsage` is accumulated onto the run (the existing `tokenUsage` accumulation at task completion) | `run.tokenUsage` (already persisted per task completion) |
| `maxRuntimeMinutes` | `ProjectTaskService.tick` — once per tick per non-terminal run (cheap: `now - run.startedAt`) | `run.startedAt` |
| `maxAgents` | `ProjectTaskService` — the scheduler's `limit` (the existing `run.maxConcurrentAgents ?? DEFAULT_TASK_CONCURRENCY` line) is capped: `limit = min(limit, budget.maxAgents)` | the scheduler's ready-task pick |
| `maxConcurrentAgents` | same line (the budget view unifies the existing per-run knob: `limit = min(run.maxConcurrentAgents ?? DEFAULT, budget.maxConcurrentAgents ?? ∞)`) | the scheduler's ready-task pick |
| `maxRetriesPerTask` | `ProjectTaskService.taskRetry` — before re-queueing, `task.attempt >= budget.maxRetriesPerTask` → refuse | `task.attempt` (already persisted, 0-based) |
| `maxReplans` | `RunPlanService` — at `createPlan` with `supersedesPlanId` (a replan), count the run's plan chain (plans with the same `runId`); `count >= budget.maxReplans` → refuse | the `plans` table (existing) |
| `maxCost` | **no site** — no cost metering exists (§5.5); the key is validated at creation but never checked | — |

### 5.2 The 80% warning (once per key per run)

A pure helper `budgetCheck.ts` (host-only, exported for tests):

```ts
export interface BudgetCheckResult {
  readonly key: string            // the budget key that crossed
  readonly ratio: number          // usage / limit
  readonly warning: boolean       // ratio >= 0.8 && ratio < 1 (or == 1 on the first check)
  readonly exceeded: boolean      // ratio >= 1
  readonly usage: number
  readonly limit: number
}
export function checkBudget(budget: RunBudget | undefined, usage: number, key: string, warned: readonly string[]): BudgetCheckResult | undefined
```

- **Warning:** `ratio >= 0.8` and the key is not in `run.budgetWarnings` →
  append the key to `run.budgetWarnings` (a run-record update, CAS), append
  the `run.budget.warning` event (detail `<key> at <pct>% of <limit>`), and
  return. **Once per key per run** — the `budgetWarnings` array is the
  dedup (no background timer, no per-tick spam).
- **Exceeded:** `ratio >= 1` → the per-key action (§5.3) + the
  `run.budget.exceeded` event. An exceeded key is also added to
  `budgetWarnings`. Raising a limit via `runSetBudget` clears that key from
  `budgetWarnings`, so the 80% of the *new* limit can fire once more (if
  usage is still ≥ 80% of the new limit on the next check).
- **Unset = unlimited:** a key absent from `budget` (or `budget` itself
  absent) → `checkBudget` returns `undefined` (no check, no event).

### 5.3 The per-key limit action (stop or pause according to policy)

| Key | Action at the limit |
| --- | --- |
| `maxTotalTokens` / `maxInputTokens` / `maxOutputTokens` | the run moves `→ paused` (with `suspendedFrom`), `resultSummary` = `Budget limit reached: <key> (<usage> of <limit>)`; a human can raise the budget (`runSetBudget`) and resume. No new task starts (the scheduler tick skips a `paused` run — the existing `run.phase !== 'executing' continue` guard). |
| `maxRuntimeMinutes` | same: `→ paused`, `resultSummary` = `Budget limit reached: maxRuntimeMinutes (<elapsed> of <limit>)`. |
| `maxAgents` / `maxConcurrentAgents` | **no pause** — the cap silently limits the scheduler's ready-task pick (the run continues with fewer concurrent agents; this is a concurrency bound, not a stop condition). No event (the cap is visible in the UI's budget panel as "capped at N"). |
| `maxRetriesPerTask` | the specific `taskRetry` call is refused with `task.retryBudgetExceeded` (a new error code, `params: { attempt, max }`); the task stays `failed`; the run is unaffected (a human can raise the budget and retry). No run pause. |
| `maxReplans` | the specific `createPlan` (replan) call is refused with `plan.replanBudgetExceeded` (a new error code, `params: { count, max }`); the run is unaffected. |
| `maxCost` | no action (no site, §5.5). |

The `resultSummary` on a token/runtime pause is the "final report explains
why execution stopped" (master spec §30). The state machine today accepts
`resultSummary` only on `succeeded` transitions; this spec extends that to
`paused` as well (`to === 'succeeded' || to === 'paused'` — additive; the
`succeeded` behavior is unchanged, and a `resultSummary` on any other
transition is still ignored).

### 5.4 Setting and raising budgets

- **At creation:** `CreateRunInput` gains an optional `budget?: RunBudget`
  (validated by the run record schema — an invalid budget is a
  `run.budgetInvalid` bad-request, `params: { key, reason }`). The RPC
  `runCreate` passes it through (the existing `readCreateRun` gains the
  field).
- **Raising:** a new additive RPC `runSetBudget` (patch the budget of a run
  in `paused` or `blocked` — the only phases where a raise makes sense;
  `params: { runId, budget: RunBudget, expectedVersion? }`). The patch
  **replaces the existing one wholesale** (a full `RunBudget` object — no
  partial merge, which `exactOptionalPropertyTypes` would make ambiguous);
  the UI sends the current budget with the raised key changed. Every key
  that was in the old budget but is absent from the new one is cleared from
  `run.budgetWarnings` (a removed limit can never warn again); a key
  present in both is cleared only if its limit changed (§5.2). A
  non-`paused`/`blocked` run → `run.budgetPhaseInvalid`.

### 5.5 No cost metering

`maxCost` is declared and validated (invariant 2: the field exists and is
checked at creation), but there is no price feed in the product — the check
is a no-op until a source exists. The budget panel renders the `maxCost`
limit with "no cost data" (not a fabricated zero).

## 6. Config + RPC

### 6.1 Config — the conservative default

`src/config.ts` `policyDefaults` gains:

```ts
approvalMode: z.enum(['manual', 'plan', 'guarded', 'autonomous']).default('plan')
```

The default is **`plan`** (master spec §18: "The default should be
conservative. I recommend `plan` or `guarded`" — `plan` is the more
conservative of the two: it gates the plan, which `guarded` does not).
`createRun` stamps `run.approvalMode = config.policyDefaults.approvalMode`
when the input does not override it (the input can set a per-run mode —
`CreateRunInput` gains an optional `approvalMode`).

### 6.2 RPC (additive — four new endpoints + two extended)

`handleDashboardRpc` gains an 11th param `approvals?` (the `ApprovalService`,
the same pattern as the 10th `memory?`):

- **`approvalList`** — `{ runId? , projectId? }` → `{ approvals: ApprovalRequestRecord[] }` (newest first; at least one of `runId`/`projectId` required — both absent → bad-request).
- **`approvalResolve`** — `{ id, decision: 'approved' | 'rejected', expectedVersion?, resolvedBy? }` → the resolved record. Structured errors: `approval.unknown` (no such id), `approval.staleVersion` (CAS mismatch, `params: { expectedVersion, actualVersion }`), `approval.invalidStatus` (already terminal).
- **`approvalExpire`** — `{ id, expectedVersion? }` → the expired record (same error set).
- **`runSetBudget`** — `{ runId, budget: RunBudget, expectedVersion? }` → the updated run record. Errors: `run.budgetPhaseInvalid` (the run is not `paused`/`blocked`), `run.budgetInvalid` (schema violation), `run.versionConflict` (CAS).
- **`runCreate`** (extended) — the payload gains optional `budget` + `approvalMode` (validated; the existing callers are unchanged — the fields are optional).
- **`runDetail`** (extended) — when the approvals service is mounted, the
  detail gains `approvals: ApprovalRequestRecord[]` for the run (the
  on-demand pattern — not a snapshot projection; `DashboardSnapshot.version`
  stays 2).

Absent-service failures follow the Phase 6 pattern: `badRequest('<endpoint>
is unavailable: the Approval service is not mounted')`.

### 6.3 Error codes (new)

`src/runtime/errors.ts` (host) + `src/client/errors.ts` (mapping, the
`params` envelope field — not `args`):

```
approval.notStarted          // the service is not started
approval.unknown             // no such approval id
approval.staleVersion        // CAS mismatch (params: expectedVersion, actualVersion)
approval.invalidStatus       // the object is already terminal
approval.runUnknown          // the runId is not a known run
run.budgetInvalid            // the budget object violates the schema (params: key, reason)
run.budgetPhaseInvalid       // runSetBudget on a run that is not paused/blocked
task.retryBudgetExceeded     // task.attempt >= maxRetriesPerTask (params: attempt, max)
plan.replanBudgetExceeded    // the plan chain is >= maxReplans (params: count, max)
```

## 7. UI (existing Dashboard, zh/en parity compile-enforced)

### 7.1 RunInspector — Approvals section

A new **Approvals** section in the RunInspector (below the Tasks section),
rendered from `runDetail.approvals` (the extended `runDetail` payload, §6.2):

- Each pending approval: the type label (zh/en), the summary, the requested
  time, and **Approve / Reject** buttons (dispatch `approvalResolve` with
  `decision` + `expectedVersion`; busy gating + the inline error banner per
  the existing conventions).
- Resolved approvals: the status label (approved/rejected/expired), the
  resolved time, the `resolvedBy`.
- The run's `approvalMode` displayed in the inspector header area (a chip:
  审批模式: 计划 / Approval mode: plan).
- The existing plan approve/reject buttons are **unchanged** (they resolve
  the plan object through the hook, §4.4).

### 7.2 RunInspector — Budget panel

A **Budget** section (below Approvals) rendering the run's `budget` +
current usage:

- Per key (only keys present in the budget): the limit, the current usage
  (tokens from `run.tokenUsage`; runtime from `startedAt`; agents from the
  scheduler's effective cap; retries from the max `task.attempt`), and a
  warning marker (⚠) when the key is in `run.budgetWarnings`.
- `maxCost`: the limit + "no cost data" (no fabricated value, §5.5).
- No budget → the section is absent (not an empty panel).

### 7.3 New Run dialog — budget + mode fields

The New Run dialog (the existing run-creation form) gains:

- An optional **Approval mode** select (default = the config default; the
  four modes, zh/en labels).
- Optional **Budget** fields (all empty = unlimited): max runtime (min),
  max total tokens, max input tokens, max output tokens, max agents, max
  concurrent agents, max replans, max retries per task, max cost. The
  dialog sends them into `runCreate` (absent fields are omitted — not sent
  as `undefined`).

### 7.4 Runs list — pending-approval indicator

The Runs list row for a run in `awaiting_approval` keeps the existing phase
chip (待审批 / Awaiting approval). The pending *type* (e.g. "合并 / merge")
is named in the inspector's Approvals section (§7.1), which is where the
on-demand `runDetail.approvals` data lives — the list does not fetch
approvals per row (no snapshot projection, §11).

### 7.5 Locale keys (zh/en parity compile-enforced)

New keys under the `dsh-dashboard` namespace (the `t` key union — the
`en satisfies Record<DashboardLocaleKey, string>` parity check):
`run.approvals` (审批 / Approvals), `run.approvalMode` (审批模式 / Approval mode),
`run.budget` (预算 / Budget), `run.budgetNoData` (无成本数据 / No cost data),
`approval.type.plan` (计划 / Plan), `approval.type.merge` (合并 / Merge),
`approval.type.external-write` (外部写入 / External write), `approval.type.git-push` (Git 推送 / Git push),
`approval.type.pull-request` (拉取请求 / Pull request), `approval.type.dangerous-action` (危险操作 / Dangerous action),
`approval.status.pending` (待处理 / Pending), `approval.status.approved` (已批准 / Approved),
`approval.status.rejected` (已拒绝 / Rejected), `approval.status.expired` (已过期 / Expired),
`approval.approve` (批准 / Approve), `approval.reject` (拒绝 / Reject),
`approval.requestedAt` (请求时间 / Requested), `approval.resolvedAt` (处理时间 / Resolved),
`approval.resolvedBy` (处理人 / Resolved by),
`budget.maxRuntimeMinutes` (最大运行时长（分钟）/ Max runtime (min)),
`budget.maxTotalTokens` (最大总 token / Max total tokens),
`budget.maxInputTokens` (最大输入 token / Max input tokens),
`budget.maxOutputTokens` (最大输出 token / Max output tokens),
`budget.maxAgents` (最大代理数 / Max agents),
`budget.maxConcurrentAgents` (最大并发代理数 / Max concurrent agents),
`budget.maxReplans` (最大重规划次数 / Max replans),
`budget.maxRetriesPerTask` (每任务最大重试 / Max retries per task),
`budget.maxCost` (最大成本 / Max cost),
`budget.warning` (预算警告 / Budget warning),
`mode.manual` (手动 / Manual), `mode.plan` (计划 / Plan), `mode.guarded` (受保护 / Guarded), `mode.autonomous` (自主 / Autonomous).

## 8. Module layout & wiring

```
src/approvals/
  types.ts            # ApprovalType, ApprovalStatus, ApprovalRequestRecord, ApprovalId, PlanApprovalEvent
  spec.ts             # projectApprovalRecordSchema (strict zod)
  approval-service.ts # ApprovalService (request/resolve/expire/list + hooks)
  approval-policy.ts  # requiresApproval(mode, stage) — the pure policy table
src/runs/
  types.ts            # + RunBudget, + approvalMode/budget/budgetWarnings on ProjectRunRecord, + CreateRunInput.budget/approvalMode
  spec.ts             # + the three run fields, + the four run event types, + the project_approvals table
  run-service.ts      # createRun stamps approvalMode + budget; runSetBudget
src/plans/
  plan-service.ts     # + onPlanApproval hook; maxReplans check at replan
src/tasks/
  task-service.ts     # + the merge gate at detectAllSucceeded; the token/runtime budget checks; the scheduler cap; the retry budget check
src/rpc/
  handler.ts          # + the approvals param; approvalList/approvalResolve/approvalExpire/runSetBudget; runCreate budget/mode; runDetail approvals
src/runtime/
  errors.ts           # + the approval.* + run.budget* + task.retryBudgetExceeded + plan.replanBudgetExceeded codes
src/client/
  controller.ts       # + the client mirror types (ClientApprovalType etc. — the client never imports src/approvals/**)
  errors.ts           # + the client error mappings
  Dashboard.tsx       # + the Approvals section, the Budget panel, the New Run dialog fields
  locales.ts          # + the zh/en keys (§7.5)
src/index.ts          # + the ApprovalService wiring (start/stop, the hooks, the RPC param)
tests/
  approval-service.test.ts    # new — the policy table, request/resolve/expire, the plan hook, the merge gate
  budget-enforcement.test.ts  # new — the 80% warning, the limit actions, unset=unlimited, the budget patch
  task-service.test.ts        # extended — the scheduler cap, the token/runtime checks, the retry budget
  plan-service.test.ts        # extended — the maxReplans refusal
  rpc-handler.test.ts         # extended — the four endpoints + runCreate/runDetail extensions
  dashboard-approvals.test.tsx# new — the Approvals section, the Budget panel, the New Run dialog (zh + en)
  run-storage-integration.test.ts # extended — the table set + the budget/approval fields survive a reopen
  client-approvals-isolation.test.ts # new — no src/client/** imports src/approvals/**
```

**Wiring in `index.ts`** (the order matters — the approval service borrows
the shared domain, so it starts after `runService.start()` and stops before
`runService.stop()`, like the memory service):

```ts
const approvalService = new ApprovalService(ctx, catalog, runService, {
  onApprovalResolved: async record => { /* §4.6: the merge run move */ },
})
// … after runService.start():
await approvalService.start()
// … the planService gains the onPlanApproval hook (§4.4)
// … handleDashboardRpc(…, memoryService, approvalService)
```

## 9. Test plan

### 9.1 `tests/approval-service.test.ts` (new)

- **Policy table:** all 4 modes × the 2 stages (`requiresApproval` — the
  pure function; `manual`: plan+merge; `plan`: plan+merge; `guarded`: merge
  only; `autonomous`: merge only).
- **Request:** a pending object persists (the table, the `run.approval.requested`
  event, the Cordis event); the idempotent re-request returns the existing
  pending (no duplicate); a terminal object is superseded (a new pending is
  created; the old is retained — never deleted); the `summary` bounds
  (1..500); the `payload` is stored as-is.
- **Resolve:** CAS (`approval.staleVersion` on mismatch, `params:
  { expectedVersion, actualVersion }`); `resolvedBy` default `'dashboard'`;
  `resolvedAt` set; the `run.approval.resolved` event; resolving a terminal
  object → `approval.invalidStatus`.
- **Expire:** a pending → `expired` (the only path); a terminal →
  `approval.invalidStatus`; no TTL (no timer — the test asserts the object
  stays `pending` across a clock advance).
- **The plan hook:** the plan service's `onPlanApproval` fires at the three
  transition points (requested/approved/rejected); the object is created +
  resolved; the `plan.approval.*` events are unchanged (the plan service
  still emits them); the run phase follows through the existing coupler
  (unchanged).
- **The merge gate:** `detectAllSucceeded` with `requiresApproval(mode,
  'merge')` true → the approval is requested + the run moves to
  `awaiting_approval` (the pipeline does not run); `false` → today's
  behavior (the run moves `integrating`, the pipeline runs); the resume
  path (the approval `approved` → the run moves `awaiting_approval →
  integrating` → the next tick runs the pipeline); the reject path (the run
  moves `awaiting_approval → blocked`).
- **The state machine:** `awaiting_approval → integrating` is allowed (the
  one-edge addition); `resultSummary` is accepted on `paused` transitions
  (the §5.3 extension); all existing edges and the `succeeded`
  `resultSummary` behavior are unchanged.

### 9.2 `tests/budget-enforcement.test.ts` (new)

- **80% warning:** a token usage crossing 80% → the `run.budget.warning`
  event (detail `<key> at <pct>% of <limit>`) + the key added to
  `run.budgetWarnings`; a second crossing (90%) → no second event (once per
  key); a different key → its own warning.
- **Limit:** a token usage ≥ 100% → the run moves `paused` (with
  `suspendedFrom`), `resultSummary` = `Budget limit reached: <key> (…)`, the
  `run.budget.exceeded` event; the scheduler tick skips the paused run (no
  new task starts).
- **Runtime:** `maxRuntimeMinutes` crossing → the same pause (the tick
  check).
- **Scheduler cap:** `maxAgents` / `maxConcurrentAgents` → the scheduler's
  `limit` is capped (the ready-task pick respects the cap); no pause, no
  event.
- **Retry budget:** `taskRetry` with `task.attempt >= maxRetriesPerTask` →
  `task.retryBudgetExceeded` (`params: { attempt, max }`); the task stays
  `failed`; below the limit → the retry proceeds (today's behavior).
- **Replan budget:** `createPlan` with `supersedesPlanId` when the plan
  chain is ≥ `maxReplans` → `plan.replanBudgetExceeded` (`params:
  { count, max }`); below → the replan proceeds.
- **Unset = unlimited:** a key absent from the budget (or `budget` absent)
  → no check, no event (the run runs past any usage).
- **Budget patch:** `runSetBudget` on a `paused` run → the budget is
  replaced; the raised key is cleared from `budgetWarnings`; a non-
  `paused`/`blocked` run → `run.budgetPhaseInvalid`; an invalid budget →
  `run.budgetInvalid` (`params: { key, reason }`).
- **`maxCost`:** validated at creation; no check site (the test asserts the
  key is stored but never triggers an event).

### 9.3 `tests/task-service.test.ts` (extended)

- The merge gate (the `detectAllSucceeded` cases — the approval requested,
  the run paused, the pipeline not run; the resume; the reject).
- The token accumulation triggering the warning + the pause (the real
  `tokenUsage` accumulation at task completion).
- The scheduler cap (`maxAgents` / `maxConcurrentAgents` limiting the
  ready-task pick).
- The retry budget (the `taskRetry` refusal).

### 9.4 `tests/plan-service.test.ts` (extended)

- The `maxReplans` refusal (the replan budget).
- The `onPlanApproval` hook (the plan approval object created + resolved at
  the three transition points).

### 9.5 `tests/rpc-handler.test.ts` (extended)

- `approvalList` (per run, per project, both absent → bad-request).
- `approvalResolve` (valid, CAS mismatch → `approval.staleVersion` with
  `params`, terminal → `approval.invalidStatus`, unknown id →
  `approval.unknown`).
- `approvalExpire` (valid, terminal → `approval.invalidStatus`).
- `runSetBudget` (valid on `paused`, non-`paused` → `run.budgetPhaseInvalid`,
  invalid → `run.budgetInvalid`, CAS → `run.versionConflict`).
- `runCreate` (the `budget` + `approvalMode` fields validated + passed
  through; the existing callers unchanged — the fields are optional).
- `runDetail` (the `approvals` array when the service is mounted; absent
  when not).
- Absent-service failures (the four endpoints → the structured not-mounted
  bad-requests).

### 9.6 `tests/dashboard-approvals.test.tsx` (new, jsdom)

- The Approvals section renders the pending objects (type label, summary,
  requested time) + the Approve/Reject buttons; Approve dispatches
  `approvalResolve` with `decision: 'approved'` + `expectedVersion`; Reject
  with `decision: 'rejected'`; the busy gating + the inline error banner
  (a structured `approval.staleVersion` error).
- The resolved objects render the status + resolved time + `resolvedBy`.
- The `approvalMode` chip renders (zh + en).
- The Budget panel renders the per-key limit + usage + the warning marker;
  `maxCost` renders "no cost data"; no budget → the section is absent.
- The New Run dialog: the approval-mode select + the budget fields dispatch
  into `runCreate` (absent fields omitted); zh + en.
- The existing plan approve/reject buttons still work (the plan flow is
  unchanged — the object is resolved behind them).

### 9.7 `tests/run-storage-integration.test.ts` (extended)

- The table set is exactly `['memory', 'plans', 'project_approvals',
  'run_events', 'runs', 'tasks']` (the new table).
- The `approvalMode` + `budget` + `budgetWarnings` run fields survive a real
  JSON domain reopen (zod-validated).
- The `project_approvals` records survive the reopen (the pending + the
  resolved).
- The domain stays v0.

### 9.8 `tests/client-approvals-isolation.test.ts` (new)

- No file under `src/client/**` imports `src/approvals/**` (the client
  carries its own mirror types in `controller.ts`).

## 10. Acceptance criteria (maps to `intent.md` §6.7)

1. **Store** — `project_approvals` is a declared table of `dsh_projects`
   (v0, no migration); records validate against the strict schema; `version`
   bumps on every accepted mutation; approvals + the run's budget/approval
   fields survive a real JSON domain reopen; the table set grows by exactly
   one table.
2. **Policy** — each of the four modes behaves per §4.2 (manual: plan+merge
   gated; plan: plan+merge gated; guarded: merge gated; autonomous: merge
   gated); the conservative default is `plan` (the config default); the mode
   is stored per run and visible in the UI; the coordinator's `settle`
   consults the policy (the plan gate lifted for guarded/autonomous).
3. **Objects** — request/resolve/expire persist + project onto the run event
   stream (`run.approval.*`); the existing `plan.approval.*` events are
   unchanged; one pending per (run, type) (idempotent re-request); the
   terminal objects are retained (never deleted); resolution resumes/blocks
   the run through the existing state machine (the merge gate); browser
   refresh and process restart do not lose a pending approval (the storage
   integration).
4. **Budgets** — every declared budget key (except `maxCost`, which has no
   site) is enforced in code at the named site (§5.1): the 80% warning once
   per key, the limit → the per-key policy action (§5.3), the
   `resultSummary` explains why; unset keys are unlimited; budgets are set
   at creation and raised explicitly (`runSetBudget`); no key is enforced by
   prompt text alone.
5. **UI** — the Approvals section + Approve/Reject dispatch real RPCs with
   surfaced errors; the Budget panel renders usage + warning markers; the
   New Run dialog carries the budget + mode fields; the existing plan
   approve/reject buttons are unchanged; zh/en parity compile-enforced.
6. **Repo green** — `pnpm run typecheck`, `pnpm run build`, full
   `pnpm vitest run` (modulo the documented pre-existing environment
   failures).

## 11. Explicit non-goals (Phase 8+)

- No new run phases (the existing `awaiting_approval` + `suspendedFrom`
  machinery is reused; the one-edge addition `awaiting_approval →
  integrating` is a state-machine edge, not a phase).
- No TTL/background expiry timers — `expired` only via explicit
  `approvalExpire` (§4.3).
- No cost metering/price feeds (`maxCost` declared, unenforceable until a
  source exists — §5.5).
- No approval objects for memory writes (Phase 6 non-goal, carried).
- No protected-branch policy engine — the merge gate (approval required in
  every mode) is the protection; no branch-name parsing.
- No trigger sites for `git-push` / `pull-request` / `external-write` /
  `dangerous-action` (those stages do not exist in the product yet — the
  schema + RPC + UI support them generically; no fake trigger sites,
  invariant 2).
- No per-run override that lifts the merge gate (the merge always requires
  approval in Phase 7; a future phase may add the override).
- No triggers/automations (Phase 9), no artifact system (Phase 8), no
  recovery of interrupted distillation (Phase 10).
- No `DashboardSnapshot` version change; approvals/budgets are on-demand RPC
  data (the `runDetail` pattern), not snapshot projections.

## 12. Sequencing (build order)

1. **Storage:** the `project_approvals` table + schema (`src/approvals/spec.ts`,
   `types.ts`); the run record fields (`RunBudget`, `approvalMode`,
   `budget`, `budgetWarnings`) + the four run event types (`src/runs/spec.ts`,
   `types.ts`).
2. **Policy + service:** `approval-policy.ts` (the pure table);
   `approval-service.ts` (request/resolve/expire/list + the
   `onApprovalResolved` hook).
3. **The plan trigger site:** the `onPlanApproval` hook on `RunPlanService`
   + the wiring in `index.ts`; the coordinator's `settle` consults the
   policy.
4. **The merge trigger site:** the gate in `ProjectTaskService.detectAllSucceeded`
   + the `awaiting_approval → integrating` state-machine edge + the
   `resultSummary`-on-`paused` state-machine extension (§5.3) + the
   `onApprovalResolved` run move.
5. **Budgets:** `budgetCheck.ts` (the pure helper); the token/runtime checks
   in `ProjectTaskService`; the scheduler cap; the retry budget in
   `taskRetry`; the replan budget in `RunPlanService`; `runSetBudget` in
   `ProjectRunService` + the `CreateRunInput` extension.
6. **RPC:** the `approvals` param on `handleDashboardRpc`;
   `approvalList` / `approvalResolve` / `approvalExpire` / `runSetBudget`;
   the `runCreate` + `runDetail` extensions; the error codes (host + client).
7. **UI:** the Approvals section + the Budget panel in the RunInspector; the
   New Run dialog fields; the locale keys (zh/en); the client mirror types
   (`controller.ts`).
8. **Wiring:** `index.ts` (the `ApprovalService` start/stop, the hooks, the
   RPC param).
9. **Tests:** every suite in §9 (the new + the extended); the storage
   integration (the table set + the reopen); the client isolation scan.
