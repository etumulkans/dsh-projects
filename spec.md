# Spec — Phase 3: Coordinator

**Gate:** Design · **Intent:** `intent.md` §6 (Phase 3) · **Master spec:** `DSH_PROJECTS_SPEC.md` §7–§9, §49–§51, §64, §73 (Phase 3)
**End state:** *a manual goal can be planned by the Coordinator.*

## 1. Goal and success

One action in the Run inspector hands a run to a **Coordinator Lead session** — a native
Harness agent that inspects the real project state, decides *direct vs orchestrated*,
and creates an **explicit, validated, versioned Run Plan** through the existing
`RunPlanService`. The run's lifecycle phase follows the plan's approval state
(coupling handed over from the Phase 2 spec non-goals). The session's outcome and a
concise planning summary are persisted on the run and visible in the inspector.

Success = a `created`/`planning` run can be coordinated end-to-end; the plan and all
coupling state survive a process restart against the real JSON storage backend.

**No execution in this phase.** `PlannedTask` stays a plan object; task execution,
Agent Teams, and worktrees are Phase 4/5.

## 2. Invariants (from `intent.md` §3)

All seven invariants apply. Notes specific to this phase:

- Only native primitives: `ctx.agents.create`, `ctx.agentDefaultModel`,
  `ctx.permissionPresets`, `ctx.sessions.flush`, `ctx.on`/`ctx.emit`, `defineTool`
  (all already used by `HarnessAgentRunner` or the Phase 2 plan service). No
  `ctx.agentTeams`, no `ctx.subagents`.
- The coordinator uses the **existing `agentProfile` plugin config**
  (`permissionPreset` required, optional `agentPreset`, `workerHost`) — no new
  configuration surface.
- Additive storage only: one optional run-record field (architecture doc §5.2
  reserved `coordinatorSessionId`, owned by Phase 3). Domain version stays 0.

## 3. Storage

### 3.1 Run record (additive)

`ProjectRunRecord` gains:

```ts
/** Phase 3: session id of the most recent Coordinator Lead session for this run. */
readonly coordinatorSessionId?: string
```

- `coordinatorSessionId: z.string().trim().min(1).optional()` in
  `projectRunRecordSchema` (`.strict()` unchanged). It is a **plain non-blank string,
  not a uuid** — session ids are prefixed (`dsh-coordinator-<uuid>`, mirroring the
  existing `dsh-dashboard-<uuid>` convention).
- Flows into `ProjectRunView` via the existing `toView` record spread (no view
  changes needed).
- The pure run state machine (`src/runs/state-machine.ts`) carries
  `coordinatorSessionId` through every transition, exactly like `activePlanId`
  (conditional spread, absent stays absent).

No new tables. `dsh_projects` stays at format version 0 (additive field on a strict
schema validates against old records).

### 3.2 Run event stream (enum extension)

`RUN_EVENT_TYPES` (10 → 13), all additive:

| type | title | detail |
| --- | --- | --- |
| `run.coordinator.started` | `Coordinator started` | session id (≤ 200, trimmed) |
| `run.coordinator.completed` | `Coordinator planning complete` | the planning summary, **full length ≤ 1000 chars** (no 200-char truncation — user-facing content) |
| `run.coordinator.failed` | `Coordinator failed` | error, ≤ 200 (trimmed) |

## 4. Coordinator policy (pure module — `src/coordinator/policy.ts`)

Versioned, testable, no `Context` access.

```ts
export const COORDINATOR_POLICY_VERSION = 1
export function coordinatorGuidance(): string
export interface CoordinatorPromptInput {
  readonly goal: string
  readonly projectName: string
  readonly projectRoot: string
  readonly runPhase: ProjectRunPhase
  readonly existingPlans: readonly {
    readonly version: number
    readonly status: RunPlanStatus
    readonly pattern: RunPlanPattern
    readonly rationale: string
    readonly replanReason?: string
  }[]
}
export function coordinatorPrompt(input: CoordinatorPromptInput): string
```

- `coordinatorGuidance()` assembles modular sections (role; pre-decision checklist
  from master spec §8; direct-vs-orchestrated decision rules from §9; the **plan
  contract** naming the exact tool `dsh_projects_submit_plan` and its field
  semantics — pattern enum, `t1..tN` ids, earlier-only dependencies, limits,
  `replanReason` required when versions exist, exactly one submission; the
  untrusted-content warning). Sections are individual constants; the function
  concatenates them. Behavior: stable output for a given policy version.
- `coordinatorPrompt()` renders the first-turn prompt: goal, project name/root,
  run phase, existing plan versions (so a replan sees v1…), and the instruction to
  inspect the repository as needed and then call the submission tool exactly once.
- Both are pure string functions; the test plan asserts on their content, not on a
  model.

## 5. `CoordinatorService` (host — `src/coordinator/coordinator-service.ts`)

### 5.1 Construction and lifecycle

```ts
new CoordinatorService(
  ctx: Context,
  catalog: ProjectCatalog,
  runService: ProjectRunService,
  planService: RunPlanService,
  agentProfile: AgentProfileConfig,
  clock?: () => string,
  driver?: CoordinatorDriver,          // seam; default = native Harness driver
)
start()   // sync: borrow the shared domain (runService.domain()) for run/event
          // writes; register nothing else (the coupling hook is wired in §6)
stop()    // sync, idempotent: abort in-flight sessions (per-run AbortController)
          // and clear the in-flight map
```

- Borrows the `dsh_projects` domain exactly like `RunPlanService` (one open per
  domain name; never closes it).
- `inFlight: Map<RunId, { controller: AbortController; promise: Promise<void> }>` —
  host-side concurrency guard only; authoritative state is always in storage.
  A process restart drops the map: a stale `planning` run is re-coordinatable
  (the coordinator sees the existing plans and replans).

### 5.2 `coordinate(runId: RunId): Promise<ProjectRunRecord>`

Steps (all awaited; errors are `DashboardDomainError`s, §7.3):

1. `coordinator.notStarted` if not started.
2. Load the run via `runService.runDetail(runId)` → `run.unknown` if absent.
3. Phase guard: phase must be `created` or `planning` → otherwise
   `coordinator.runPhaseInvalid { runId, phase }`. (A run that already has an
   active plan is `executing` — re-planning an executing run is a Phase 4+
   concern, §12.)
4. In-flight guard: `inFlight.has(runId)` → `coordinator.inProgress { runId }`.
5. Resolve the project: `catalog.project(run.projectId)` → `undefined` →
   `coordinator.projectUnknown { runId, projectId }`.
6. If phase is `created` → `await runService.transitionRun(runId, 'planning')`.
7. `sessionId = SessionId(`dsh-coordinator-${randomUUID()}`)`; persist it on the
   run via the shared domain (`runs.update`: field + `updatedAt` + version + 1 —
   same direct-table pattern as the Phase 2 `activePlanId` write).
8. Append `run.coordinator.started` (per-run max-seq scan on the shared
   `run_events` table, same pattern as `RunPlanService.appendRunEvent`); emit
   `dsh-projects/run/coordinator-started`.
9. Assemble the prompt (§4) from real state: run goal, project name/root, run
   phase, existing plans from `planService.planList(runId)` (newest first).
10. Launch the driver (§5.3) with `cwd = project.root`, the configured
    `permissionPreset`/`agentPreset`, the prompt, a fresh `AbortSignal`, and the
    `onPlanSubmit` closure (§5.4). Track the run in `inFlight`; `coordinate()`
    returns the run record **immediately after step 8's writes settle** — the
    session continues in the background (the UI observes progress via the event
    stream + the existing refresh control; no polling mechanism is added).
11. When the driver settles (the tracked promise, not `coordinate()`):
    - `kind === 'completed'` **and** a plan was submitted:
      - pattern `direct` → `await planService.transitionPlan(planId, 'active')`.
      - otherwise → `await planService.transitionPlan(planId, 'awaiting-approval')`.
      - The run-phase move happens through the §6 coupling hook (awaited inside
        `transitionPlan`); the service performs **no** run transitions of its own.
      - Append `run.coordinator.completed` (detail = submitted summary); emit
        `dsh-projects/run/coordinator-completed { runId, projectId, planId, version, at }`.
    - `kind === 'completed'` **and** no plan submitted, or `kind` is
      `failed`/`blocked` → the run is left retryable:
      `await runService.transitionRun(runId, 'blocked')` (errors swallowed +
      logged — the run may have been paused/canceled meanwhile); append
      `run.coordinator.failed` (detail = error or `session completed without
      submitting a plan`); emit `dsh-projects/run/coordinator-failed`.
    - Remove the run from `inFlight`.

### 5.3 Session driver (seam + native default)

```ts
export interface CoordinatorPlanSubmission {
  readonly pattern: RunPlanPattern
  readonly rationale: string
  readonly assumptions?: readonly string[]
  readonly successCriteria?: readonly string[]
  readonly tasks?: readonly PlannedTaskInput[]
  readonly replanReason?: string
  readonly summary: string            // concise human-facing planning summary
}
export interface CoordinatorDriverInput {
  readonly sessionId: string
  readonly cwd: string
  readonly permissionPreset: string
  readonly agentPreset?: string
  readonly prompt: string
  readonly signal: AbortSignal
  readonly onPlanSubmit: (input: CoordinatorPlanSubmission) => Promise<{
    readonly planId: string
    readonly version: number
    readonly pattern: RunPlanPattern
  }>
}
export interface CoordinatorDriverResult {
  readonly kind: 'completed' | 'failed' | 'blocked'
  readonly error?: string
}
export interface CoordinatorDriver {
  start(input: CoordinatorDriverInput): Promise<CoordinatorDriverResult>
}
```

The default driver (`HarnessCoordinatorDriver`, `src/coordinator/session-driver.ts`)
mirrors `HarnessAgentRunner` mechanics:

- `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model } }
  from `ctx.agentDefaultModel.currentSelection()``, signal, setup })` — in `setup`,
  register the submission tool via `agentCtx.get('tools')` + `defineTool` (the
  seam the task-source tools already use).
- `ctx.permissionPresets.set(session, permissionPreset)`; optional `agentPreset`
  resolution exactly as the runner does.
- One user message (`createUserMessage` from `@deepseek-ai/dsh-llm`) with
  `coordinatorGuidance() + coordinatorPrompt(...)` — the prompt passed by the
  service already contains both; `await handle.agent.whenIdle()`;
  `ctx.sessions.flush(session)`; read the turn end via the
  `lastTurnEnd`-style scan of `session.events`:
  `completed` → `{kind:'completed'}`; `blocked` → `{kind:'blocked', error}`;
  `error` → `{kind:'failed', error: '<code>: <message>'}`.
- `finally`: remove the session listener, flush, `handle.dispose()`; an aborted
  signal surfaces as `{kind:'failed', error:'coordinator session aborted'}`.
- **Single turn**: the model uses native inspection tools (read/grep/shell per the
  preset) and the submission tool within one turn; no `max_turns` loop.

### 5.4 The submission tool (`dsh_projects_submit_plan`)

Registered in the session scope with `defineTool`:

- Parameters: `pattern` (enum, the six `RUN_PLAN_PATTERNS`), `rationale`
  (string), `assumptions?` (string[]), `successCriteria?` (string[]), `tasks?`
  (array of `{ title, description, dependencies?: string[], acceptanceCriteria?:
  string[] }`), `replanReason?` (string), `summary` (string, required).
- `execute`:
  1. Validate `summary`: non-blank, ≤ 1000 chars → otherwise throw a plain
     `Error` (tool error back to the agent; no dashboard error code — it never
     reaches the client).
  2. **Once per session**: if a plan was already submitted, throw
     `a plan has already been submitted for this run; do not submit again`.
  3. Map to `CreatePlanInput` (dropping `summary`) and `await
     planService.createPlan(input)` — the full Phase 2 validation applies
     (run unknown/terminal, rationale, pattern tasks, per-task limits,
     dependency order, replan reason for v2+). A `DashboardDomainError` is
     rethrown as a tool error carrying the message, so the agent can correct and
     re-submit.
  4. Store `submittedPlan` (id, version, pattern) on the service for the
     post-session flow; return the plan reference to the agent.
- Output rendered as JSON text (same `render` style as the task-source tools).

## 6. Run–plan phase coupling (Phase 2 handover)

**Mechanism:** `RunPlanService` gains one **optional** constructor argument
(additive; existing construction sites and all Phase 2 tests keep their behavior):

```ts
new RunPlanService(ctx, runService, clock?, hooks?: {
  readonly onPlanStatus?: (event: PlanStatusChangedEvent) => Promise<void>
})
```

`transitionPlan` awaits `hooks.onPlanStatus?.(event)` **after** the plan update,
the existing run coupling, and the Cordis emit succeed. No hook → no coupling
(Phase 2 behavior, preserved).

**Coupler** (`PlanRunCoupler` in `src/coordinator/coupling.ts`, constructed with the
run service) implements the guarded transitions — the run state machine remains
the single authority; a guard miss is a no-op (logged, never an error):

| plan event (`to`) | run phase required | run transition |
| --- | --- | --- |
| `awaiting-approval` | `planning` | → `awaiting_approval` |
| `active` | `planning` or `awaiting_approval` | → `executing` |
| `draft` (rejected) | `awaiting_approval` | → `planning` |

Every other run phase is untouched (a plan approved on an `executing`/`created`
run does not move the run — Phase 2 manual flows stay intact). Wired in
`src/index.ts`:

```ts
const coupler = new PlanRunCoupler(runService)
const planService = new RunPlanService(ctx, runService, undefined, {
  onPlanStatus: event => coupler.handle(event),
})
```

`coupler.handle` catches and logs (`ctx.logger.warn`) every transition failure
(stale guard, concurrent move, terminal run).

## 7. Events and errors

### 7.1 Cordis events (module augmentation in `coordinator-service.ts`)

| event | payload |
| --- | --- |
| `dsh-projects/run/coordinator-started` | `{ runId, projectId, sessionId, at }` |
| `dsh-projects/run/coordinator-completed` | `{ runId, projectId, planId, version, at }` |
| `dsh-projects/run/coordinator-failed` | `{ runId, projectId, error, at }` |

Persist-first convention as everywhere: the `run_events` row is written before the
emit.

### 7.2 Run event rows

§3.2. The three types interleave on the shared per-run `seq` and render in the
existing inspector timeline. `runEventTone`: `run.coordinator.started` → gray,
`run.coordinator.completed` → green, `run.coordinator.failed` → red.

### 7.3 Error codes (extend `DashboardErrorCode` + client mapping + zh/en locales)

1. `coordinator.notStarted` — service not started.
2. `coordinator.runPhaseInvalid` — run phase is not `created`/`planning` (params
   `{ runId, phase }`).
3. `coordinator.inProgress` — a coordination for this run is already running
   (params `{ runId }`).
4. `coordinator.projectUnknown` — the run's project is no longer registered
   (params `{ runId, projectId }`).

Client: `ERROR_TRANSLATION_KEYS += { 'coordinator.notStarted': 'error.coordinatorNotStarted', … }`
(`as satisfies` parity), locales zh/en for all four.

## 8. RPC (additive, trusted-host)

`src/runtime/types.ts` `DashboardRpcMap` gains:

| endpoint | payload | result |
| --- | --- | --- |
| `runCoordinate` | `{ runId: uuid }` | the `ProjectRunRecord` after the `planning` move + `coordinatorSessionId` write |

`src/rpc/handler.ts` gains a 9th optional parameter `coordinator?:
CoordinatorService`. Validation mirrors the Phase 1/2 pattern: non-uuid `runId`
→ `bad-request` (reuse `readUuidField`); absent service → `bad-request`
(`runCoordinate is unavailable: the Coordinator service is not mounted`); service
`DashboardDomainError`s (the four `coordinator.*` codes + `run.unknown`) →
structured bad-requests via the existing error-encoding path. The handler awaits
`coordinator.coordinate(runId)` and returns the record.

## 9. UI (existing Dashboard surface, zh/en parity)

- **Controller** (`src/client/controller.ts`): port +=
  `coordinateRun(runId: string): Promise<void>`; implementation calls
  `rpc.call('/dsh-dashboard', 'runCoordinate', { runId })` with the existing
  active-request accounting + `normalizeDashboardError` error handling (result is
  a run record; only success/failure matters to the UI).
- **Surface prop**: `onCoordinateRun?: (runId: string) => Promise<void>` (optional,
  wired from `data.coordinateRun` in `Dashboard.tsx`); `dev.tsx` stays minimal
  (tests supply the callback), consistent with the Phase 1/2 pattern.
- **Run inspector footer** — a `协调` / `Coordinate` button rendered when the run
  phase is `created` or `planning`, the run is not suspended, and
  `onCoordinateRun` is provided. Click: pending state (button disabled, label
  `协调中…` / `Coordinating…`); success → refresh (existing `onRefresh`); error →
  inline notice via `dashboardErrorMessage` (button re-enabled).
- **Coordinator section** (`InspectorSection`, between details and Plans) — shown
  when the run has `coordinatorSessionId` **or** the loaded detail contains
  coordinator events:
  - status line derived from the newest coordinator event: no `started` → nothing;
    `started` without a later `completed`/`failed` → `进行中` / `in progress`;
    `completed` → `已完成` / `complete`; `failed` → `失败` / `failed`;
  - session: last 8 chars of `coordinatorSessionId`;
  - summary: the `completed` event's detail (when present);
  - failure: the `failed` event's detail (when present).
- **Locales** (zh + en, compile-enforced parity): `runs.coordinate`,
  `runs.coordinatePending`, `runs.coordinator`, `runs.coordinator.progress`,
  `runs.coordinator.complete`, `runs.coordinator.failed`,
  `runs.coordinator.session`, `runs.coordinator.summary`, plus the four
  `error.coordinator*` keys.

## 10. Module layout & wiring

```text
src/coordinator/policy.ts            NEW  pure guidance + prompt assembly
src/coordinator/coupling.ts          NEW  PlanRunCoupler (guarded run transitions)
src/coordinator/coordinator-service.ts NEW CoordinatorService + Events augmentation
src/coordinator/session-driver.ts    NEW  CoordinatorDriver seam types + HarnessCoordinatorDriver
src/plans/plan-service.ts            MOD  optional hooks.onPlanStatus (awaited in transitionPlan)
src/runs/state-machine.ts            MOD  coordinatorSessionId carry-over
src/runs/spec.ts                     MOD  coordinatorSessionId field + 3 event types
src/runs/types.ts                    MOD  ProjectRunRecord/View field, event type union
src/runtime/errors.ts                MOD  4 coordinator.* codes
src/runtime/types.ts                 MOD  runCoordinate RPC map entry
src/rpc/handler.ts                   MOD  9th param + runCoordinate case
src/index.ts                         MOD  coupler + planService hook + CoordinatorService
                                       construction, start chain (after planService.start(),
                                       before runtime.start()), disposer (coordinator.stop()
                                       before planService.stop()), RPC wiring
src/client/{controller,errors,locales,Dashboard,styles,fixture}.ts(x)  MOD  §9
tests/coordinator-policy.test.ts     NEW
tests/coordinator-service.test.ts    NEW
tests/rpc-handler.test.ts            MOD  runCoordinate block
tests/dashboard-coordinator-interactions.test.tsx  NEW (jsdom, zh)
tests/run-storage-integration.test.ts  MOD  coordinator leg
```

Start chain: `await runService.start()` → `planService.start()` →
`coordinator.start()` → `await runtime.start()`. Disposer: `await runtime.stop()`
→ `coordinator.stop()` (aborts sessions; the failure handlers still reach the run
service) → `planService.stop()` → `await runService.stop()` → `await catalog.stop()`.

## 11. Test plan

- **`coordinator-policy.test.ts`** — guidance contains the role, decision rules,
  the `dsh_projects_submit_plan` contract (tool name, pattern enum, one
  submission, replan-reason rule), and the untrusted-content warning; prompt
  contains goal/project/phase and each existing plan version;
  `COORDINATOR_POLICY_VERSION` is a stable constant; outputs are pure (same input
  → same string).
- **`coordinator-service.test.ts`** (fake `CoordinatorDriver`; real run + plan
  services on the shared memory domain, Phase 2 harness pattern):
  notStarted before start; terminal-run and `inProgress` guards; `created` →
  `planning` move + `started` event + `coordinatorSessionId` persisted; direct
  flow (tool input mapped, plan created draft → active, run → `executing` via the
  hook coupling); orchestrated flow (plan → `awaiting-approval`, run →
  `awaiting_approval`, then manual approve → run `executing`, reject → run
  `planning`); completed-without-plan and driver-failed → run `blocked` +
  `failed` event + Cordis emit; replan (v1 exists: first submission without
  `replanReason` rejected as a tool error, second with reason creates v2);
  double-submission rejected; `stop()` aborts the in-flight driver (signal
  observed); coupling guards (approve a plan while the run is `executing` → run
  unchanged); summary length validation (1001 chars rejected as a tool error).
- **`rpc-handler.test.ts`** — `runCoordinate` dispatch returns the record;
  non-uuid `runId` → bad-request; absent service → bad-request;
  `coordinator.runPhaseInvalid` mapped via `decodeDashboardError` with
  `{ runId, phase }` params.
- **`dashboard-coordinator-interactions.test.tsx`** (jsdom, zh labels) — button
  visible for `created`/`planning`, hidden for `executing`/terminal runs; click
  calls `onCoordinateRun(runId)` and shows the pending state; error → notice +
  button re-enabled; Coordinator section renders status (`进行中`/`已完成`),
  session tail, and the completed summary from the detail events.
- **`run-storage-integration.test.ts`** — boot 1: coordinate a run with a fake
  driver that submits an orchestrated plan; run ends `awaiting_approval` with
  `coordinatorSessionId` set. Reopen: `coordinatorSessionId`, plan, run phase, and
  the coordinator events all survive; the medium table set is still
  `['plans', 'run_events', 'runs']`; a subsequent manual approval completes the
  flow on the second boot.
- **Regression:** every existing suite (incl. all Phase 2 plan suites, which use
  the hook-less `RunPlanService` construction) stays green.

## 12. Acceptance criteria (maps to `intent.md` §6.4)

1. Coordinate (zh `协调`) on a `created`/`planning` run starts a real Lead session
   (native `ctx.agents.create` path); `coordinatorSessionId` is persisted on the
   run and survives restart.
2. The session's structured output yields a validated plan via
   `RunPlanService` — pattern persisted, ids assigned, replan reason required
   when versions exist; invalid/missing output never persists a plan (tool errors
   go back to the agent; a plan-less or failed session leaves no plan).
3. The §6 coupling works end-to-end through the existing plan UI: approval
   requested → run `awaiting_approval`; approve → plan active + run `executing`;
   reject → plan draft + run `planning`; direct plan → run `executing`; guard
   misses are no-ops.
4. The planning summary is visible in the inspector's Coordinator section and
   persisted as the `run.coordinator.completed` event detail; `resultSummary`
   keeps its Phase 1 terminal-only meaning (refined from the intent wording).
5. Failed/blocked sessions leave the run retryable (`blocked` → resume →
   `planning` → Coordinate again).
6. Storage integration: `coordinatorSessionId` + plans + run phase + coordinator
   events survive a real JSON domain reopen; medium table set unchanged.
7. Repo green: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run`
   (modulo the documented pre-existing environment failures).

## 13. Explicit non-goals (Phase 4+)

- No task execution, no `ProjectTask`, no task status — `PlannedTask` stays a plan
  object (Phase 4). No Agent Teams, no background subagents, no worker spawning
  (Phase 4, behind adapters). No per-task worktrees (Phase 5).
- No Project Memory retrieval/injection — context assembly is
  project/run/plans/repo only (Phase 6).
- No `ApprovalRequest` objects, no budgets (Phase 7). No report *artifacts* — the
  §64 report is Phase 8; Phase 3 ships only the concise planning summary.
- No interactive coordinator chat / user-correction loop (master spec §49);
  coordination is one-shot per trigger. Re-planning = coordinate again on a run
  with plans (next version + reason). No event-driven re-planning from task
  failures (needs execution — Phase 4).
- No re-coordination of `executing` runs (an active plan means the run left
  `planning`); supersede-then-coordinate is the Phase 3 path.
- No polling/refresh mechanism — progress is observed through the event stream
  and the existing refresh control; in-flight reconciliation after a crash is
  Phase 10.
- No new plugin configuration (the `agentProfile` surface is reused); no new
  storage tables; no `resultSummary` reuse.
