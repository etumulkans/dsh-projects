# Spec — Phase 2: Versioned Run Plans

**Gate:** Design · **Upstream:** `intent.md` (invariants, roadmap) · `DSH_PROJECTS_SPEC.md` §9–12, §18, §28, §42–43, §54, §56–58 · `docs/dsh-projects-architecture.md` §4, §5
**Builds on:** committed Phase 1 (`8e24ce6`) — `dsh_projects` domain v0, `ProjectRunService`, Runs tab.

## 1. Goal and success

Add explicit, versioned Run Plans to an existing Run (spec §10, §73 Phase 2). Plans are
immutable content versions with a small validated status lifecycle; a Run carries its
active plan; plan evolution (v1 → v2) is visible in the Dashboard.

**At the end (spec §73):** *Run can have Plan v1 → Plan v2 history* — created, approved,
superseded, and persisted across a process restart, visible in the Run inspector.

Non-goals for this phase: no coordinator, no plan/task execution, no `ApprovalRequest`
objects (Phase 7), no budgets, no DAG *scheduler* (Phase 4), no automatic plan completion
on run terminal transitions, no plan editing or deletion (replan = new version).

## 2. Invariants (from `intent.md` §3)

No invented APIs; no placeholder APIs; no fake UI data (local mode uses the labeled
fixture); additive only; extend the existing Dashboard surface; state in the
`dsh_projects` domain; repo stays typecheck/build/test green.

## 3. Storage

### 3.1 Domain

The `dsh_projects` domain **stays version 0**. Two additive changes:

1. New table `plans` (absent tables initialize empty — no migration).
2. `runs` record schema gains one optional field:
   ```ts
   activePlanId: z.uuid().optional()   // the plan currently active for the run
   ```
   Old records (without the field) still validate against the strict schema; the
   `run_events` `type` enum gains the new plan event types (§6.1) — stored records are
   unchanged, so no version bump (architecture doc §4 "Storage domains").

### 3.2 Schemas (zod, `.strict()`, in `src/plans/spec.ts` + composed in `src/runs/spec.ts`)

```ts
type RunPlanPattern =
  | 'direct' | 'prompt-chain' | 'parallel-workers'
  | 'supervisor' | 'router' | 'evaluation-loop'

type RunPlanStatus = 'draft' | 'awaiting-approval' | 'active' | 'superseded' | 'completed'

interface SuccessCriterion { id: string; description: string }   // id: 'c1'..'cN', assigned at create
interface PlannedTask {
  id: string                 // 't1'..'tN', list order, assigned at create
  title: string
  description: string
  dependencies: string[]     // ids of EARLIER tasks in this plan only
  acceptanceCriteria: string[]
}

interface RunPlanRecord {
  id: string                 // randomUUID (globally unique)
  runId: string              // uuid, references runs.id
  projectId: string          // uuid, denormalized (same convention as run_events)
  version: number            // per-run plan version, 1-based, IMMUTABLE after create
  pattern: RunPlanPattern
  rationale: string          // why this pattern/shape (spec §10)
  assumptions: string[]      // may be empty
  successCriteria: SuccessCriterion[]
  tasks: PlannedTask[]
  status: RunPlanStatus      // the ONLY mutable content field
  replanReason?: string      // required when this version supersedes a prior one (version > 1)
  supersedesPlanId?: string  // uuid of the plan this version replaces (version > 1 only)
  createdAt: string
  revision: number           // CAS counter for status transitions, starts at 1
}
```

**Content immutability:** everything except `status` (and its CAS `revision`) is frozen at
creation. "Editing" a plan means creating version N+1 (spec §10: *Do not mutate Plan v1
into Plan v2*).

### 3.3 Shared domain handle

`DomainFacility.open` allows exactly one open per domain name (Phase 1:
`ProjectRunService` owns `dsh_projects`). Phase 2 must not open a second handle:

* `ProjectRunService` gains a seam: `domain(): Domain<DshProjectsDomain>` — returns the
  opened domain, throws `run.notStarted` when stopped.
* `RunPlanService` borrows it: `new RunPlanService(ctx, runService, clock?)`; its
  `start()` takes `plans`, `runs`, and `run_events` table handles from
  `runService.domain()` and requires the run service to be started.
* `RunPlanService.stop()` disposes its table references only — it never closes the shared
  domain (the run service closes it; `Domain.close()` is idempotent regardless).

## 4. Plan state machine (pure, single authority)

`src/plans/state-machine.ts` — pure, no storage, mirrors `src/runs/state-machine.ts`.

```
draft             → awaiting-approval | active | superseded
awaiting-approval → active | draft | superseded
active            → completed | superseded
superseded        → (terminal)
completed         → (terminal)
```

Rules enforced by `transitionPlan(plan, to, { now?, replanReason? })`:

| Target | Preconditions | Side effects (record) |
| --- | --- | --- |
| `awaiting-approval` | from `draft` | — |
| `active` | from `draft` or `awaiting-approval` | — (run coupling in §5) |
| `draft` | from `awaiting-approval` (rejection) | — |
| `superseded` | from `draft` / `awaiting-approval` / `active`; **`replanReason` required** | `revision + 1` |
| `completed` | from `active` only | `revision + 1` |

Any other edge throws `PlanTransitionError` (pure, like `RunTransitionError`). The
service maps it to `plan.transitionInvalid` with `{ runId, from, to }` params.

## 5. `RunPlanService` (host)

Constructor `(ctx, runService, clock?)`; `start()`/`stop()` idempotent, double-start
throws, `stop` after `stop` is a no-op — same contract as `ProjectRunService`.

### 5.1 `createPlan(input: CreatePlanInput): Promise<RunPlanRecord>`

```ts
interface CreatePlanInput {
  runId: RunId
  pattern: RunPlanPattern
  rationale: string
  assumptions?: string[]
  successCriteria?: string[]          // plain strings; ids c1..cN assigned by the service
  tasks?: PlannedTaskInput[]          // { title, description, dependencies?, acceptanceCriteria? }
  replanReason?: string               // required when a prior version already exists for the run
}
```

Validation order (each failure = a `DashboardDomainError`):

1. `plan.notStarted` — service not started.
2. `plan.runUnknown` — run not found.
3. `plan.runTerminal` — run phase is a terminal (`succeeded|failed|canceled`).
4. `plan.rationaleEmpty` / `plan.rationaleTooLong` (trim, ≤ 2000 chars).
5. `plan.patternRequiresTasks` — `pattern !== 'direct'` and no tasks (`direct` =
   coordinator executes without decomposition, so it may carry zero tasks).
6. `plan.tasksTooMany` — more than 50 tasks. Per-task: `plan.taskTitleEmpty` (trim,
   ≤ 300), description non-blank ≤ 4000, ≤ 20 acceptance criteria each non-blank ≤ 500.
7. `plan.taskDependencyInvalid` — a dependency must reference an **earlier** task id in
   the same list (by construction: no self-deps, no unknown refs, no cycles).
8. `plan.supersedeReasonMissing` — a prior version exists for this run and
   `replanReason` is blank.

On success (single writer per process, same assumption Phase 1 makes for event seq):

* `version` = max(existing plan versions for the run) + 1; `id` = `randomUUID()`;
  task ids `t1..tN`, criterion ids `c1..cN`; `status: 'draft'`; `revision: 1`.
* version > 1: set `supersedesPlanId` (the highest-version existing plan) +
  `replanReason`.
* append run event `plan.created` (title `Plan v{version} created`, detail
  `pattern={pattern}, tasks={n}`); emit Cordis `dsh-projects/plan/created`.
* return the record.

### 5.2 `planList(runId): Promise<RunPlanView[]>`

Newest `version` first, bounded to 50 plans; unknown run returns `[]` (no error — the
list is a projection); run-scoped (a plan always belongs to exactly one run).

### 5.3 `planDetail(planId): Promise<RunPlanRecord>`

Unknown plan → `plan.unknown` (params `{ planId }`).

### 5.4 `transitionPlan(planId, to, options?: { expectedRevision?, replanReason? })`

1. `plan.notStarted`; unknown plan → `plan.unknown`.
2. Pure state machine (§4) → `plan.transitionInvalid` (`{ runId, from, to }`).
3. CAS inside the domain's atomic write chain: `expectedRevision` mismatch →
   `plan.revisionConflict` (`{ expectedRevision, actualRevision }`), same shape as
   `run.versionConflict`.
4. Run-coupling, in the same write chain where practical:
   * to `active`: run must be non-terminal (`plan.runTerminal`); if a *different* plan
     is the run's `activePlanId`, that plan is set to `superseded` (revision + 1,
     `replanReason` = this plan's `replanReason` or `Plan v{n} activated`) and a
     `plan.superseded` event is appended for it; then `runs.update(runId)` sets
     `activePlanId = planId` (run `version + 1`, `updatedAt`); append `run.replanned`
     event (title `Run replanned`, detail `Plan v{old} → v{new}`) when a prior active
     plan existed.
   * to `superseded`: `replanReason` required (`plan.supersedeReasonMissing`); if this
     was the active plan, `runs.update` clears `activePlanId` (run `version + 1`).
   * to `completed`: no run coupling (the run's own lifecycle is the run service's).
5. Append the matching run event + emit the matching Cordis event (§6).

### 5.5 Error codes (extend `DashboardErrorCodes` + client `errors.ts` mapping + locales)

`plan.notStarted`, `plan.unknown`, `plan.runUnknown`, `plan.runTerminal`,
`plan.rationaleEmpty`, `plan.rationaleTooLong`, `plan.patternRequiresTasks`,
`plan.tasksTooMany`, `plan.taskTitleEmpty`, `plan.taskDependencyInvalid`,
`plan.transitionInvalid`, `plan.revisionConflict`, `plan.supersedeReasonMissing`.

## 6. Events

### 6.1 `run_events` table — new `type` values (append-only stream, shared seq)

`plan.created`, `plan.approval.requested`, `plan.approved`, `plan.rejected`,
`plan.superseded`, `plan.completed`, `run.replanned`

Titles/details follow Phase 1 conventions (`from → to` details; `detail` bounded to
~200 chars). Events carry the run's `seq` (per-run counter) exactly like run events, so
the existing Run inspector timeline shows run + plan events interleaved, newest first.

### 6.2 Cordis events (host → bus)

`dsh-projects/plan/created`, `dsh-projects/plan/approval-requested`,
`dsh-projects/plan/approved`, `dsh-projects/plan/rejected`,
`dsh-projects/plan/superseded`, `dsh-projects/plan/completed`,
`dsh-projects/run/replanned` — payloads carry `runId`, `projectId`, `planId`,
`version`, `status`, `at` (plus `from`/`to` where meaningful).

## 7. RPC (additive, trusted-host)

`src/rpc/handler.ts` gains four endpoints (same envelope/validation style as Phase 1):

| Endpoint | Payload | Result |
| --- | --- | --- |
| `planCreate` | `{ runId: uuid, pattern: enum, rationale: string, assumptions?: string[], successCriteria?: string[], tasks?: { title, description, dependencies?, acceptanceCriteria? }[], replanReason? }` | created `RunPlanRecord` |
| `planList` | `{ runId: uuid }` | `RunPlanView[]` |
| `planDetail` | `{ planId: uuid }` | `RunPlanRecord` |
| `planTransition` | `{ planId: uuid, status: enum, expectedRevision?: int ≥ 1, replanReason? }` | updated `RunPlanRecord` |

Payload validation is explicit (bad enum / non-uuid / negative revision →
`bad-request`), mirroring `runCreate`/`runTransition`. When the plan service is absent
(not wired), all four answer `bad-request` — same convention as the run endpoints.
`DashboardSnapshot` is unchanged beyond `ProjectRunView` gaining the optional
`activePlanId` (it flows from the run record spread).

## 8. UI (existing Dashboard surface, zh/en parity)

Optional surface props (existing renderers keep compiling — Phase 1 pattern):
`onPlanCreate?`, `onPlanTransition?`.

* **Run table/inspector:** when `run.activePlanId` is set, show a plan chip
  (`Plan v{n} · active`) — data comes from the run record itself.
* **Run inspector → Plans section** (lazy-loaded on run selection, like events):
  `planList` renders versions newest first: `v2 active`, `v1 superseded`, … each row
  expandable → rationale, assumptions list, success-criteria list, and the task list as
  a **readable dependency list** (spec §43 minimum): each task shows its id, title, and
  `← t1, t3` dependency references. No DAG renderer in this phase.
* **Plan actions** (inspector footer, conditional on `onPlanTransition` and status):
  draft → *Request approval* / *Activate*; awaiting-approval → *Approve* / *Reject* /
  *Supersede*; active → *Complete* / *Supersede*. Supersede prompts for the reason
  (dialog, stays open on error — NewRunDialog convention). Transitions send
  `expectedRevision` = the plan's current `revision`.
* **New Plan dialog** (inspector, when run is non-terminal and `onPlanCreate` present):
  pattern select (6 patterns), rationale textarea, assumptions one-per-line,
  success criteria one-per-line, and a bounded **task editor**: add/remove rows; each
  row = title + description + dependency checkboxes restricted to **earlier** rows
  (cycle-free by construction) + acceptance criteria one-per-line. Trimmed and
  validated client-side before the RPC call.
* **Locales:** `plans.*` key set (title, empty state, version/status labels, 6 pattern
  labels, section labels, action labels, dialog labels, 13 `error.plan*` messages) in
  both `zh` and `en` — compile-time parity via the existing `DashboardLocaleKey`
  mechanism.
* **Fixture (local mode):** `fixtureSnapshot` — the executing run carries
  `activePlanId` = plan v2 (`active`, `supervisor`, 3 tasks with one dependency pair);
  plan v1 for the same run is `superseded` with a replan reason. `localFixtureSnapshot`
  keeps total 0 plans. No plans in the global fixture section.
* **Styles:** plan status badges, expandable plan row, task list + dependency markers,
  dialog rows — appended to `src/client/styles.ts`.

## 9. Module layout & wiring

```
src/
  plans/
    types.ts           # RunPlanRecord, PlannedTask, SuccessCriterion, views, CreatePlanInput
    spec.ts            # plan zod schema (+ plannedTask/successCriterion schemas)
    state-machine.ts   # PLAN_STATUS_TRANSITIONS, transitionPlan() (pure), PlanTransitionError
    plan-service.ts    # RunPlanService
  runs/spec.ts         # dshProjectsDomainSpec += plans table; run schema += activePlanId?
  runs/run-service.ts  # + domain() seam; run events enum unchanged (plan events live in plans)
  runtime/types.ts     # + plan RPC map entries; ProjectRunView.activePlanId?
  runtime/errors.ts    # + 13 plan.* codes
  rpc/handler.ts       # + planCreate/planList/planDetail/planTransition
  index.ts             # wire RunPlanService after ProjectRunService start; stop in reverse
  client/
    controller.ts      # + createPlan/planList/planDetail/planTransition calls + parsers
    Dashboard.tsx      # + Plans section, plan actions, NewPlanDialog (+task editor)
    errors.ts          # + plan.* → locale keys
    fixture.ts         # + fixture plans
    locales.ts         # + plans.* (zh + en)
    styles.ts          # + plan CSS
tests/
  plan-state-machine.test.ts
  plan-service.test.ts
  dashboard-plans-interactions.test.tsx
  rpc-handler.test.ts  (extended: plan endpoints)
  run-storage-integration.test.ts (extended: plans table on disk after reopen)
```

`src/runs/` is not renamed; `src/plans/` is a sibling directory (spec §59: adapt, don't
reorganize).

## 10. Test plan

* `plan-state-machine.test.ts` — full status table; every allowed edge; forbidden edges
  (incl. self, terminal→anything, `completed` from non-active); `superseded`/`completed`
  require the right preconditions; `replanReason` requirement; revision bump on the
  mutating edges only.
* `plan-service.test.ts` — notStarted/double-start/stop idempotency; create validation
  (each code in §5.1, incl. `direct` with zero tasks, dependency-order violations,
  missing replan reason on v2); version numbering v1→v2→v3 across creates; activation
  sets `activePlanId` + supersedes the prior active plan + `run.replanned` event;
  supersede of the active plan clears `activePlanId`; `expectedRevision` conflict;
  per-run event scoping (plan events interleaved on the run seq); restart persistence
  (stop both services, new services on the same memory domain: plans + run coupling
  intact, transition continues); terminal-run rejection.
* `rpc-handler.test.ts` — plan endpoint dispatch, payload validation (bad pattern,
  non-uuid, negative revision), absent-service bad-requests, error mapping via
  `decodeDashboardError` (incl. `plan.revisionConflict` params).
* `dashboard-plans-interactions.test.tsx` (jsdom, zh labels) — inspector shows plan
  versions + status; expand shows rationale/tasks/dependency markers; approve flow calls
  `onPlanTransition({ planId, status: 'active', expectedRevision })`; supersede dialog
  requires a reason and stays open on failure; New Plan dialog trims, enforces earlier-only
  dependencies, closes on success; empty state (no plans) with New Plan present for a
  non-terminal run; terminal run hides New Plan.
* `run-storage-integration.test.ts` — extend the real-JSON-storage test: create a plan +
  activate it before the reopen; after reopen the `plans` table is on disk, the run's
  `activePlanId` survives, and a transition continues; the medium's table set is now
  `['plans', 'run_events', 'runs']`.

## 11. Acceptance criteria

1. A run can hold a Plan v1 → v2 history; v1 is marked `superseded` with a stored
   replan reason; both versions remain readable (spec §10, §54).
2. Plan content is immutable after creation; only `status` moves, via the validated
   state machine with CAS (spec §10, §57, §58).
3. `activePlanId` on the run is set/cleared consistently with plan activation/supersede,
   including the atomic supersede-of-prior-active on activation.
4. Plan events are interleaved on the run's event stream and visible in the inspector;
   the 7 Cordis events fire.
5. State survives a process restart — proven against the real JSON storage backend
   (domain reopen), not only the in-memory fake.
6. Runs tab + existing behavior unchanged; snapshot version stays 2; RPC additive.
7. `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green (modulo the 3
   documented pre-existing environment failures).

## 12. Explicit non-goals (Phase 3+)

No coordinator session, no plan *execution* or task status (PlannedTask stays a plan
object; `ProjectTask` execution arrives Phase 4), no `ApprovalRequest` objects (Phase 7 —
plan approval here is a plan status, not an approval object), no budgets, no automatic
run-phase coupling (requesting plan approval does not move the run to
`awaiting_approval` — the coordinator wires that in Phase 3), no plan deletion/editing,
no DAG rendering beyond the dependency list, no multi-run plan sharing.
