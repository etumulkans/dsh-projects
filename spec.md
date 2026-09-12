# Spec — Phase 4: Task DAG + team execution

**Gate:** Design · **Intent:** `intent.md` §7 · **Master spec:** `DSH_PROJECTS_SPEC.md` §73 Phase 4, §11–§15, §28–§29, §31 · **Architecture:** `docs/dsh-projects-architecture.md` §3.3–§3.6, §4

## 1. Goal and success

An **active** plan's `PlannedTask` list becomes a live **ProjectTask** DAG on the
`dsh_projects` domain: dependency-gated scheduling, execution by real Harness
agents behind a fakeable worker seam (a local `ctx.agents` worker by default,
Agent Teams when configured and mounted), with task/agent state, retries, and
lifecycle visible in the existing Dashboard (zh/en).

**Success (master spec §73):** *Coordinator can execute several
dependent/parallel tasks* — end-to-end, persisted, restart-surviving, with an
explicit "execution unavailable" state instead of fake agents when the
composition mounts no agent runtime.

## 2. Invariants (from `intent.md` §3)

1. No invented APIs — the worker adapters bind to the **installed** runtime
   surfaces (architecture doc §3.5/§3.6) resolved through the Cordis context;
   `ctx.agentTeams` (experimental) is touched by **exactly one file**; no new
   package dependency.
2. No placeholder APIs, no fake UI data — every control is backed by a real
   service on persistent storage; absence of a runtime is an explicit state.
3. Additive only — the `dsh_projects` domain stays at **format version 0**
   (storage-domain initializes absent declared tables as empty); existing
   record shapes only gain optional fields; `DashboardSnapshot.version` stays 2.
4. The run state machine stays the single authority for run phases; no new run
   phases. Task state has its own pure machine.
5. UI extends the existing `DashboardSurface` inspector; zh/en parity
   compile-enforced.
6. State survives a process restart (real-JSON storage integration test).
7. Repo green: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run`
   (modulo the documented pre-existing environment failures).

## 3. Storage

### 3.1 New table `tasks` (additive, domain stays v0)

`src/runs/spec.ts` gains (the domain spec is the single declaration site, as
with `plans`):

```ts
tasks: domainTable<TaskId, ProjectTaskRecord>(projectTaskRecordSchema),
```

New medium table set: `['plans', 'run_events', 'runs', 'tasks']`.

### 3.2 `ProjectTaskRecord` (zod, `src/tasks/spec.ts`)

```ts
export const TASK_STATUSES = [
  'pending', 'ready', 'running', 'blocked', 'awaiting-review',
  'succeeded', 'failed', 'canceled',
] as const satisfies readonly ProjectTaskStatus[]

export const projectTaskRecordSchema = z.object({
  id,                                  // uuid
  runId: id,
  planId: id,                          // plan version that materialized this task
  planTaskId: z.string().regex(/^t[1-9][0-9]*$/),  // position id in the plan
  title: nonBlank,                     // ≤300 (validated at plan creation)
  description: nonBlank,               // ≤4000
  role: nonBlank.optional(),           // role label from the plan (spec §15)
  dependencies: z.array(id).default([]),  // task UUIDs, resolved at materialization
  status: z.enum(TASK_STATUSES),
  assignedAgentId: nonBlank.optional(),    // native agent identity (session id / member name)
  workspaceId: nonBlank.optional(),        // RESERVED — filled by Phase 5, never by Phase 4
  acceptanceCriteria: z.array(nonBlank).default([]),
  attempt: z.number().int().min(0),       // executions already STARTED (initial 0)
  maxAttempts: z.number().int().min(1).optional(),
  outputSummary: nonBlank.optional(),     // ≤1000, from the worker result
  error: nonBlank.optional(),
  tokenUsage: tokenUsageSchema.optional(),// only when the runtime provides usage
  startedAt: timestamp.optional(),        // last execution start
  completedAt: timestamp.optional(),      // terminal transition time
  createdAt: timestamp,
  updatedAt: timestamp,
  version: z.number().int().min(1),       // CAS, bumps on every accepted transition
}).strict() as z.ZodType<ProjectTaskRecord>
```

`awaiting-review` is declared for schema completeness (master spec §11) but is
**unreachable in Phase 4** — no edge enters or leaves it (Phase 7 approval
modes own it). Phase 4 never writes `workspaceId`.

### 3.3 Additive optional fields on existing records

- `ProjectRunRecord` / `ProjectRunView`: `maxConcurrentAgents?: number`
  (`int ≥ 1`, ≤ 50) — per-run task concurrency override; default
  `DEFAULT_TASK_CONCURRENCY = 1` (intent §7.2, shared-tree safety pre-Phase 5).
- `ProjectRunView`: `taskCounts?: TaskCountsView` —
  `{ total, pending, ready, running, blocked, failed, succeeded }` (counts of
  the run's tasks by status; absent when the Host has no task service).
- `RunDetailView`: `tasks?: readonly ProjectTaskView[]` — the run's tasks in
  plan (topological) order; absent when the Host has no task service.
- `ProjectRunSummary` (snapshot `runs` section): `worker?: 'local' | 'agent-team' | 'unavailable'` —
  the worker kind the Host can currently execute tasks with (host-level,
  additive optional).

### 3.4 Run event stream (additive types)

`RUN_EVENT_TYPES` grows by 5 (13 → 18). Master spec §28 names per-task
`task.created`; materialization of up to 50 tasks would flood the per-run audit
stream, so the stream carries **one aggregate + per-task state changes**
(spec-level decision, documented here):

| Type | When | Detail (≤200, truncated) |
| --- | --- | --- |
| `tasks.materialized` | a plan's tasks materialize | `plan v{N}: {M} tasks` |
| `task.ready` | task becomes ready | task title |
| `task.started` | an execution starts | `agent {assignedAgentId tail}, attempt {k}/{max}` |
| `task.completed` | task succeeds | output summary |
| `task.failed` | a task reaches terminal `failed` | `{error}; attempt {k}/{max}` (or `retries exhausted`) |

Cordis events (payloads persist-first, same pattern as Phase 2/3):
`dsh-projects/tasks/materialized`, `dsh-projects/task/ready`,
`dsh-projects/task/started`, `dsh-projects/task/completed`,
`dsh-projects/task/failed` — `{ runId, projectId, taskId?, planId, at }`
(`taskId` omitted on `tasks.materialized`).

## 4. Task state machine (pure — `src/tasks/state-machine.ts`)

Single authority for task status invariants; the same shape as
`runs/state-machine.ts` + `plans/state-machine.ts` (pure table + `transitionTask`
producing the next record; persistence/coupling/events are the service's job).

```
pending         → ready | blocked | canceled
ready           → running | canceled
running         → succeeded | failed | ready | canceled
blocked         → ready | canceled
awaiting-review → (none — unreachable in Phase 4)
succeeded / failed / canceled → (terminal)
failed          → ready        // operator retry (taskRetry RPC), the one edge into a "live" state from terminal
```

Rules:

- Transition to the current status is a **rejected no-op** (idempotency comes
  from CAS on `version`, not silent re-entry) — `TaskTransitionError`.
- `running → ready` is the internal retry edge: the service may only take it
  while `attempt < maxAttempts` (the service enforces the budget; the machine
  enforces the edge).
- `failed → ready` (operator retry) is allowed only from `failed`; it does not
  change `attempt` (the next `ready → running` bumps it).
- `blocked → ready` re-readies a task whose failed dependency was retried and
  later succeeded (dependency recovery, computed by the scheduler).
- Terminal entry sets `completedAt`; `failed` carries `error`; `succeeded`
  carries `outputSummary`.
- Every accepted transition bumps `version` and refreshes `updatedAt`.
- `transitionTask(task, to, context)` validates the edge and returns the next
  record; `context` carries `error?`/`outputSummary?` (required by target,
  enforced) — explicit-optional discipline applies (no `undefined` props).

## 5. DAG scheduler (pure — `src/tasks/scheduler.ts`)

Pure functions over the run's task list; **generalizes the existing
`src/orchestrator/scheduling.ts` helpers** (intent §7.1.3, master spec §12:
do not build a parallel mechanism):

- `failureRetryDelay(attempt, maximumMs)` — **reused as-is** from
  `orchestrator/scheduling.ts` (10 s, doubling, capped). Constant
  `MAX_RETRY_DELAY_MS = 300_000` (5 min) in `src/tasks/constants.ts`.
- `compareTasks(left, right)` — new sibling of `compareCandidates`: earliest
  `createdAt`, then `id` (`localeCompare`) — deterministic pick order.
- `stateLimit`-style counting — the concurrency check counts `running` tasks
  against the effective limit (`run.maxConcurrentAgents ?? 1`); the helper
  itself is a 3-line local count (the orchestrator's `stateLimit` reads a
  config map keyed by state, which has no task analogue — documented
  deviation: reuse where the shape fits, generalize where it doesn't).

```ts
/** Throws TaskGraphError (code task.dagInvalid) on unknown dep, self-dep, or cycle. */
export function validateTaskGraph(tasks: readonly ProjectTaskRecord[]): void

/**
 * The minimal transition set that brings the statuses in line with the
 * dependency facts (pure, idempotent — returns [] when nothing changes):
 * - pending, all deps succeeded        → ready
 * - pending, any dep terminal failed   → blocked
 * - blocked, all deps succeeded again  → ready   (dependency recovery)
 */
export function computeDependencyTransitions(
  tasks: readonly ProjectTaskRecord[],
): readonly { readonly taskId: string; readonly to: 'ready' | 'blocked' }[]

/**
 * The ready tasks eligible for an execution slot NOW: status ready,
 * concurrency slot free (running < limit), and retry backoff elapsed
 * (no backoff for first attempts; `updatedAt + failureRetryDelay(attempt,
 * MAX_RETRY_DELAY_MS) ≤ now` for re-ready retries). Deterministic order via
 * compareTasks; returns at most `freeSlots` ids.
 */
export function pickReadyTasks(
  tasks: readonly ProjectTaskRecord[],
  limit: number,
  now: number,
): readonly string[]
```

Cycle detection is Kahn's algorithm over the task `dependencies` map. Because
plan creation already constrains dependencies to earlier tasks (Phase 2,
`plan.taskDependencyInvalid`), cycles and unknown refs are impossible by
construction — `validateTaskGraph` is the defensive second line at
materialization (intent §7.1.2: invalid DAGs are rejected, never persisted).

## 6. Worker seam and adapters (master spec §13/§14/§31)

### 6.1 The seam (fakeable — `src/tasks/worker.ts`)

The same pattern as the Phase 3 `CoordinatorDriver`: the service talks to a
narrow interface; tests inject a fake; production adapters bind to the
installed runtime.

```ts
export interface TaskWorkerInput {
  readonly taskId: string
  readonly runId: string
  readonly projectId: string
  /** Plugin-generated session id (`dsh-task-<uuid>`), as in Phase 3. */
  readonly sessionId: string
  readonly cwd: string            // the project root (Phase 4: shared tree, Phase 5 isolates)
  readonly title: string
  readonly description: string
  readonly role?: string
  readonly acceptanceCriteria: readonly string[]
  readonly attempt: number
  readonly signal: AbortSignal
}

export interface TaskWorkerResult {
  readonly kind: 'succeeded' | 'failed'
  /** Concise human-readable summary; required on success (≤1000). */
  readonly summary?: string
  /** Required on failure. */
  readonly error?: string
  /** The native agent identity actually used (session id / member name). */
  readonly agentId?: string
  readonly tokenUsage?: TokenTotals   // only when the runtime reports usage
  readonly turnCount?: number
}

export type TaskWorkerKind = 'local' | 'agent-team' | 'unavailable'

export interface TaskWorker {
  readonly kind: TaskWorkerKind
  start(input: TaskWorkerInput): Promise<TaskWorkerResult>
  /** Best-effort stop of one live agent; resolves even when unknown. */
  stop(agentId: string): Promise<void>
}
```

Semantics: `start` resolves exactly once (success, failure, or — when
`signal` aborts — a failure with `error: 'task execution aborted'`). The
service never interprets worker internals; summaries/errors are truncated and
persisted by the service. A success result without a usable summary (blank /
>1000) is treated by the service as a failure (`error: 'worker returned no
usable summary'`) — a task without a summary cannot be `succeeded`.

**Design correction (grounded in the installed Harness source, supersedes the
intent's "BackgroundAgentAdapter over `ctx.subagents`"):** the `ctx.subagents`
surface (`packages/subagent` in the Harness checkout) is an **agent-to-agent
delegation API** — `startContinuable`'s request requires
`parent: Agent` ("The spawning agent. In-process providers derive workspace,
lineage, and delegation depth from its durable session state"), and
`sendMessage`/`interrupt` require a live sender/authority Agent. A
service-initiated task worker has no parent Agent, so that surface is **not
usable for Phase 4 service-initiated tasks** and is not implemented (invariant
1 + 2: no invented APIs, no placeholder adapters). It remains the foundation
for coordinator *delegation* (master spec §49 territory, later phase). The
MVP worker is the **local Harness worker** per master spec §31 — the
`ctx.agents.create` mechanism that architecture doc §3.3 designates as the
"Phase 4+ worker foundation" and that `HarnessAgentRunner` /
`HarnessCoordinatorDriver` already use.

### 6.2 `LocalTaskWorker` (default, always available — `src/tasks/local-adapter.ts`)

`ctx.agents` is a hard dependency of this plugin (it is in the `inject`
list), so the local worker is available in every composition of the plugin.
It mirrors the `HarnessAgentRunner`/`HarnessCoordinatorDriver` mechanism:

- `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model },
  signal, setup })` — model via `ctx.agentDefaultModel.currentSelection()` +
  `installModelSelection`; permission preset via
  `ctx.permissionPresets.set(session, …)`.
- `setup` registers the result-reporting tool **`dsh_projects_report_task_result`**
  (the `defineTool` seam, same schema-subset discipline as Phase 3's
  `dsh_projects_submit_plan`): input `{ kind: 'succeeded' | 'failed',
  summary?: string, error?: string }`, **reportable exactly once** per session
  (a second call is a tool error).
- One `followup(createUserMessage(…))` carrying the task prompt (title,
  description, role guidance, acceptance criteria, cwd note, the report
  contract); `whenIdle()`; `ctx.sessions.flush(session)`;
  `lastTurnEnd` scan (the `harness-runner.ts` helper shape:
  `completed` / `error` / `blocked`).
- Result: the tool report when it was made (summary/error pass through; the
  service enforces the summary rule); when the session ends **without** a
  report → `{ kind: 'failed', error: 'session ended without reporting a task
  result' }` (an `error`/`blocked` turn-end carries the native reason).
- `tokenUsage`/`turnCount`: accumulated from the session's
  `session/event` stream (`assistant/message` usage, `addUsage` pattern from
  `harness-runner.ts`); omitted when the stream reports none.
- `stop(agentId)`: resolves the tracked session's AbortController (the
  service tracks `agentId → AbortController`); the adapter's `finally`
  flushes + disposes the handle.

### 6.3 `TeamTaskWorker` (opt-in — `src/tasks/team-adapter.ts`)

**The only file in the codebase that may reference the experimental
`ctx.agentTeams` surface** (architecture doc §4; invariant 1). The installed
`TeamService` is caller-scoped — every method takes `caller: Agent` — so the
adapter establishes **one Lead session per run** (`ctx.agents.create`, the
every-live-root-is-an-implicit-Lead rule, architecture doc §3.5) and, per
task, `spawnTeammate(leadAgent, …)`; task work is posted through the native
task board (`createTask`/`assignTask`), results arrive via the team task
board / mailbox (`updateTask` completion carrying the summary), interruption
via `interrupt(leadAgent, targetName)` on cancellation/retirement. Teammates
are disposed when their work settles. Because the surface is explicitly
experimental, this adapter is expected to be the only file that needs
significant modification if the API changes (master spec §13).

### 6.4 Availability and selection (honest degradation)

- The experimental surface is **resolved through the Cordis context at
  startup** (structural typing in the adapter files; no package imports — the
  plugin's dependency list is unchanged; the experimental package is
  host-mounted, architecture doc §3.5). `ctx.subagents` is not referenced by
  any file (enforced by the source-scan test, §12).
- Additive optional plugin config (`src/config.ts`):
  `projects?: { taskWorker?: 'local' | 'agent-teams' }`, default `'local'`.
- Resolution at `ProjectTaskService.start()`:
  - `'local'` (default) → `LocalTaskWorker` (always constructible —
    `ctx.agents` is injected).
  - `'agent-teams'`: `ctx.agentTeams` present → `TeamTaskWorker`; absent →
    `UnavailableWorker` — **no silent fallback** to the local worker (the
    operator asked for teams; silently getting local execution is a lie).
    The structured error surfaces instead (intent §7.1.4, invariant 2).
- `UnavailableWorker.start` rejects with `DashboardDomainError('task.workerUnavailable', …)`.
  The service never starts a task with it: scheduling simply finds no eligible
  worker, the run-level state and UI show *execution unavailable* (a
  `task.workerUnavailable` error on any explicit action), and no task leaves
  `pending`/`ready` with a fake identity.

## 7. `ProjectTaskService` (host — `src/tasks/task-service.ts`)

Owns task state inside the shared `dsh_projects` domain (borrowed from
`ProjectRunService.domain()`, one open per domain). Mirrors
`CoordinatorService`'s structure (tables on start, `stop()` aborts in-flight
worker signals and drops references, background work tracked per task).

```ts
constructor(
  ctx, catalog, runService,
  clock: () => string = () => new Date().toISOString(),
  worker: TaskWorker,                 // resolved in src/index.ts (§6.4)
  retryClock?: () => number,          // injectable now() for backoff (tests)
)
start(): void                          // borrow tables { tasks, runs, run_events, plans }; subscribe run-phase events; start tick interval
stop(): void                           // abort in-flight signals, clear interval, unsubscribe, drop refs — idempotent
workerKind(): TaskWorkerKind           // for the snapshot projection
```

### 7.1 Materialization (from the plan hook)

`handlePlanStatus(event: PlanStatusChangedEvent)` — the Phase 4 half of the
`RunPlanService.onPlanStatus` hook (wired next to `PlanRunCoupler` in
`src/index.ts`, awaited sequentially; a hook failure never undoes the plan
transition):

| plan `to` | action |
| --- | --- |
| `active` | retire the run's live tasks, then materialize the plan's tasks (below) |
| `superseded` / `completed` | if the event's plan is the run's `activePlanId`: retire the run's live tasks (the new active plan materializes on its own `active` event) |
| `draft` (rejected) / `awaiting-approval` | no-op (tasks only exist once a plan is active) |

**Retire:** every non-terminal task of the run → `canceled` (CAS; running
tasks also `worker.stop(assignedAgentId)`), so a superseded plan's work never
keeps running.

**Materialize** (plan with `tasks.length === 0` → no-op with a log line — a
taskless `direct` plan means the run has nothing to execute):

1. `validateTaskGraph` over the plan tasks (mapped to would-be records) —
   `task.dagInvalid` aborts with zero rows written.
2. Persist all rows: `status: 'pending'`, `attempt: 0`,
   `dependencies` resolved from plan positions (`tN` → that task's new uuid),
   `role`/`acceptanceCriteria` copied, `maxAttempts: DEFAULT_MAX_ATTEMPTS (3)`.
3. One `tasks.materialized` run event + Cordis emit.
4. `tick()` — the first ready wave is computed and started immediately.

### 7.2 The tick (scheduler application)

`tick()` is the single application point for scheduling decisions; guarded by
an in-tick flag (re-entrant calls coalesce into one trailing run). Triggered
by: materialization, every worker result, `taskRetry`, run-phase events, and a
5-second interval (retry backoff elapsing; belt-and-braces after crashes of
the event flow — Phase 10 owns full reconciliation).

Per tick (each step through the CAS path, events per §3.4):

1. `computeDependencyTransitions` → apply `pending→ready`, `pending→blocked`,
   `blocked→ready` (idempotent: nothing to do when statuses already agree).
2. Dead-DAG check (intent §7.1.9): if the run is `executing`, the task set is
   non-empty, and **no** task is `pending`/`ready`/`running`/`blocked-recoverable`
   (i.e. every remaining non-terminal task is `blocked` on a terminal `failed`
   dependency) with at least one `failed` → `runService.transitionRun(runId,
   'blocked')` guarded to `from executing` (guard miss = logged no-op, the
   `PlanRunCoupler` pattern). The run stays `blocked` (retryable: resume →
   `executing` → `tick()`; a retried dependency can unblock dependents via
   `blocked → ready`).
3. `pickReadyTasks` (limit = `run.maxConcurrentAgents ?? 1`,
   `now = retryClock()`) → for each id, `startExecution(task)`.
4. All-succeeded check: nothing to do to the run (intent §7.1.9 decision —
   the run stays `executing` until Phase 5 integration); the tick simply
   stops finding work.

### 7.3 Execution lifecycle

`startExecution(task)`:

1. CAS `ready → running` (sets `attempt + 1`, `startedAt`,
   `assignedAgentId` = the generated `dsh-task-<uuid>` sessionId — a
   placeholder until the runtime confirms its own identity), `task.started`
   event.
2. `worker.start(input)` as a tracked background promise (per-task map, like
   the coordinator's `inFlight`); on the result, if `agentId` is present it
   overwrites the placeholder inside the same CAS as the status move.
   - **succeeded** → CAS `running → succeeded` (summary, `tokenUsage`,
     `completedAt`), `task.completed` event, `tick()`.
   - **failed**, `attempt < maxAttempts` → CAS `running → ready`
     (retry; backoff computed from `updatedAt`/`attempt` on the next tick),
     `tick()`.
   - **failed**, `attempt >= maxAttempts` → CAS `running → failed` (error,
     `completedAt`), `task.failed` event, `tick()` (dead-DAG check may block
     the run).
   - **abort** (stop/cancel/retirement) → the CAS is skipped when the task is
     already `canceled` (stale-result no-op, logged).
   - every path `worker`-side cleanup happens inside the adapter; the service
     only persists.

`taskRetry(taskId)` (operator RPC, §9): CAS `failed → ready` (only from
`failed`; otherwise `task.retryNotAllowed` / `task.unknown` /
`task.notStarted`), `tick()`.

**Run cancellation propagation:** the service subscribes
`ctx.on('dsh-projects/run/phase-changed', …)` in `start()` (unsubscribed in
`stop()`): on `to === 'canceled'` for a run with live tasks → retire (§7.1) —
no RPC-side wiring needed.

## 8. Events and errors

- Run event types: +5 (`§3.4`); `RUN_EVENT_TYPES` is 18 entries.
- New `DashboardErrorCode`s (5, `task.*` namespace) — every code has a real
  generation path; internal CAS conflicts on expected concurrent moves are
  logged no-ops (the stale-result discipline), not client errors:

| Code | When |
| --- | --- |
| `task.notStarted` | service not started |
| `task.unknown` | unknown task id (operator retry on a missing task) |
| `task.retryNotAllowed` | `taskRetry` on a non-`failed` task |
| `task.workerUnavailable` | selected worker runtime absent from the composition |
| `task.dagInvalid` | materialization graph validation failure (defensive) |

Client `ERROR_TRANSLATION_KEYS` + zh/en `locales.ts` entries for all 7 (the
`satisfies Record<DashboardErrorCode, DashboardLocaleKey>` map keeps parity
compile-enforced).

## 9. RPC (additive, trusted-host)

| Endpoint | Input | Output | Notes |
| --- | --- | --- | --- |
| `runDetail` (existing) | `{ runId }` | `RunDetailView` **+ additive optional `tasks`** | tasks in plan order; absent when the Host has no task service (older hosts unaffected) |
| `state` / `refresh` (existing) | — | `DashboardSnapshot` | `runs` section gains `worker` + per-view `taskCounts` (both additive optional) |
| `taskRetry` (new) | `{ taskId: string }` | `ProjectTaskRecord` | uuid validation; structured errors per §8; absent task service → bad-request |

`handleDashboardRpc` gains a 9th optional parameter `taskService?`
(`ProjectTaskService | undefined`) — the same additive-parameter pattern as
`coordinator` (8th) in Phase 3.

## 10. UI (existing Dashboard surface, zh/en parity)

New **Tasks** inspector section (`inspector.tasks` — zh `任务`, en `Tasks`) in
`RunInspector`, ordered after the Coordinator section:

- **Worker banner** (from `ProjectRunSummary.worker`):
  - `unavailable` → notice `执行不可用：当前组合未挂载代理运行时` /
    “Execution unavailable: no agent runtime is mounted in this composition”
    (no task rows are fake; real pending/ready tasks still render).
  - `local` / `agent-team` → small kind label (zh `本地代理` / `代理团队`).
- **Per-task row** (DAG/plan order): status pill (8 statuses, zh labels:
  待调度/就绪/运行中/受阻/待审/已完成/失败/已取消), title, role, dependency
  titles (or `tN`), `attempt/maxAttempts` (e.g. `2/3`), agent tail (last 8 of
  `assignedAgentId`, when set) + started-relative time, tokens when present,
  output-summary or error row (truncated like the Coordinator section).
  Blocked rows name the failed dependency.
- **Retry action** on `failed` rows only: calls the new `onTaskRetry(taskId)`
  port (controller: `taskRetry` → RPC `taskRetry`), pending state
  `重试中…` / `Retrying…`, success feedback `任务已重新排队` /
  “Task re-queued”, error notice via `dashboardErrorMessage` + re-enable.
- `RunInspector`/surface gain `onTaskRetry?` + `tasks` from `runDetail`;
  `fixture.ts` gains a deterministic tasks section on the executing fixture
  run (mixed statuses incl. one blocked-on-failed-dep, one failed with
  `attempt: 3`, `worker: 'local'`) — fixture-labeled local-mode data only,
  as in the existing runs fixture.
- `styles.ts`: `.dshd-tasks*` classes following the Coordinator section's
  visual language.

No new tab, no second shell (invariant 5). The run list's row keeps its
current shape; `taskCounts` is surfaced in the inspector header line
(`任务 3/7 完成` style, zh/en).

## 11. Module layout & wiring

```
src/tasks/
  types.ts          TaskId, ProjectTaskStatus, ProjectTaskRecord, ProjectTaskView,
                    TaskCountsView, TaskGraphError payload types
  spec.ts           TASK_STATUSES, projectTaskRecordSchema (zod, §3.2)
  constants.ts      DEFAULT_TASK_CONCURRENCY, DEFAULT_MAX_ATTEMPTS, MAX_RETRY_DELAY_MS,
                    MAX_SUMMARY_LENGTH (1000), EVENT_DETAIL_LIMIT (200), TICK_INTERVAL_MS (5000)
  state-machine.ts  ALLOWED_TASK_TRANSITIONS, transitionTask, TaskTransitionError (pure)
  scheduler.ts      validateTaskGraph, computeDependencyTransitions, pickReadyTasks,
                    compareTasks (pure; reuses orchestrator/scheduling.ts failureRetryDelay)
  worker.ts         TaskWorker seam, TaskWorkerInput/Result/Kind, UnavailableWorker
  local-adapter.ts   LocalTaskWorker (ctx.agents mechanism, §6.2; report tool `dsh_projects_report_task_result`)
  team-adapter.ts     TeamTaskWorker (only file touching ctx.agentTeams — experimental)
  task-service.ts   ProjectTaskService (§7), task.* Cordis event declarations
src/runs/spec.ts    + tasks table, RUN_EVENT_TYPES +5, run schema +maxConcurrentAgents
src/runs/types.ts   +5 event types, ProjectTaskView, TaskCountsView,
                    ProjectRunView +taskCounts?, RunDetailView +tasks?
src/config.ts       + optional projects.taskWorker ('local' | 'agent-teams')
src/rpc/handler.ts  9th param taskService?; taskRetry case; runDetail + tasks;
                    snapshot runs + worker/taskCounts
src/index.ts        worker resolution (§6.4) → ProjectTaskService; hook chain
                    onPlanStatus: coupler → taskService; start/stop chain;
                    snapshot projection wiring
src/client/         controller.ts +taskRetry port; errors.ts +5 keys;
                    locales.ts + zh/en; Dashboard.tsx Tasks section;
                    fixture.ts tasks; styles.ts .dshd-tasks*
```

Wiring (`src/index.ts`, following the Phase 3 chain):

```ts
const worker = resolveTaskWorker(ctx, config.projects?.taskWorker ?? 'local')
const taskService = new ProjectTaskService(ctx, catalog, runService, undefined, worker)
const planService = new RunPlanService(ctx, runService, undefined, {
  onPlanStatus: async event => {
    await coupler.handle(event)
    await taskService.handlePlanStatus(event)
  },
})
// startup:  runService.start() → planService.start() → coordinator.start() → taskService.start() → runtime.start()
// disposal: runtime.stop() → taskService.stop() → coordinator.stop() → planService.stop() → runService.stop()
```

`taskService.start()` throws `task.workerUnavailable`-free: it always starts
(the worker kind may be `unavailable` — that is a state, not a startup
failure), so the Dashboard boots in every composition.

## 12. Test plan

| File | Cases (spec-level) |
| --- | --- |
| `tests/task-state-machine.test.ts` (new) | full allowed-edge table + representative forbidden edges; idempotent re-entry rejection; terminal invariants; `running→ready` budget edge; `failed→ready` only from failed; version bumps; `completedAt`/`error`/`outputSummary` carry-over; `awaiting-review` unreachable |
| `tests/task-scheduler.test.ts` (new) | `validateTaskGraph`: ok / cycle / unknown dep / self-dep; `computeDependencyTransitions`: all-deps-succeeded → ready, any-failed → blocked, recovery → ready, idempotent no-op; `pickReadyTasks`: concurrency cap, retry backoff (injected `now`), deterministic order, empty when saturated |
| `tests/task-service.test.ts` (new) | in-memory domain + fake worker + injected clocks: materialization 1:1 (deps resolved, role/criteria copied, `maxAttempts` default) + `tasks.materialized` event; taskless plan no-op; zero rows on `task.dagInvalid`; retirement on `superseded` (running task stopped) and on re-activation; first ready wave respects default concurrency 1 + `run.maxConcurrentAgents` override; success path (summary/tokens persisted, `task.completed`); failure with retries (attempt bump, backoff elapses via injected `retryClock`, re-ready, second attempt succeeds); exhausted → `failed` + dead-DAG → run `blocked` (guard: run must be `executing`); dependency recovery unblocks (`blocked → ready`); `taskRetry` happy + `task.retryNotAllowed` + `task.unknown`; run-canceled event → all live tasks `canceled` + worker stopped; stale worker result after cancel is a logged no-op; unavailable worker → tasks never leave pending/ready, `task.workerUnavailable` on action, no fake identities; restart persistence (stop, new service on same medium, state intact); `stop()` aborts in-flight worker signal |
| `tests/task-adapters.test.ts` (new) | `LocalTaskWorker` against a fake `ctx.agents` (create/followup/whenIdle/flush/dispose mapping, report-tool result, session-ended-without-report → failed result, usage accumulation, abort → failed result); `TeamTaskWorker` against a fake `TeamService` + fake agents (Lead spawn, per-task teammate spawn, assign/interrupt/dispose mapping); `UnavailableWorker` rejects with `task.workerUnavailable`; **import isolation**: a source-scan test asserting `agentTeams` appears only in `src/tasks/team-adapter.ts` and `ctx.subagents`/`subagents` appears in no file — the invariant-1 check |
| `tests/rpc-handler.test.ts` (extended) | `taskRetry` dispatch returns the record; non-uuid → bad-request; absent service → bad-request; `task.retryNotAllowed`/`task.unknown` mapped via `decodeDashboardError` with `{ taskId }`; `runDetail` includes `tasks` when the service is present and omits them (absent property) when not |
| `tests/dashboard-tasks-interactions.test.tsx` (new, jsdom zh) | Tasks section renders mixed statuses from `runDetail` (pills, deps, attempt `2/3`, agent tail, summary/error rows, blocked names the failed dep); retry button appears only on `failed`, calls `onTaskRetry(taskId)`, pending `重试中…`, then refresh; worker-unavailable banner renders the zh notice; `worker: 'local'` label; no fake data — empty task list renders the section's empty state |
| `tests/run-storage-integration.test.ts` (extended) | coordinator leg extended: activated plan materializes tasks on the real JSON backend; a fake worker completes one task; after a domain reopen the task statuses, events, and run phase survive; medium table set `['plans', 'run_events', 'runs', 'tasks']`; a second boot's `taskRetry` re-runs a failed task |
| regression | every existing suite green, unchanged files untouched except the additive edits listed in §11 |

Settlement in the service tests follows the Phase 3 `settle` pattern (poll the
persisted outcome on the shared medium; generous slow-yield budget — the
real-JSON lesson from Phase 3 applies to the integration leg).

## 13. Acceptance criteria (maps to `intent.md` §7.4)

1. Tasks materialize 1:1 from the active plan version with dependencies
   resolved (plan positions → task uuids); a taskless plan is a no-op; an
   invalid DAG is rejected at materialization with zero rows persisted;
   superseding the active plan retires its live tasks (running ones stopped).
2. DAG semantics hold end-to-end: a task is ready only when all dependencies
   succeeded; a permanently failed dependency blocks dependents; a retried
   dependency that later succeeds re-readies them; `validateTaskGraph` rejects
   cycles/unknown refs; transitions are idempotent rejections.
3. Ready tasks execute on real agents behind the seam (fake in tests):
   `status`/`assignedAgentId`/`attempt` persist on the `tasks` table; retries
   respect `maxAttempts` with the generalized `failureRetryDelay` backoff;
   exhausted attempts → terminal `failed`; a dead DAG blocks the run (retryable
   via the existing resume path); run cancellation cancels live tasks and
   stops their workers.
4. The agent lifecycle is inspectable in the inspector: per-task status/role/
   attempt/summary/error, agent identity tail, start time, tokens when the
   runtime provides them; the snapshot carries `worker` kind + `taskCounts`;
   zh/en parity compile-enforced; no fabricated activity.
5. Honest degradation: a composition without the selected runtime exposes
   `worker: 'unavailable'`, the zh/en banner, `task.workerUnavailable` on
   actions, and tasks never carry fake identities or leave scheduling states.
6. Storage integration: task records + task events survive a real JSON domain
   reopen; medium table set `['plans', 'run_events', 'runs', 'tasks']`;
   `dsh_projects` stays format v0.
7. Repo green: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run`
   (modulo the documented pre-existing environment failures).

## 14. Explicit non-goals (Phase 5+)

- No per-task worktrees/branches, one-writer-per-worktree invariant,
  integration worktree/strategy, Git metadata in the UI (Phase 5). Phase 4
  tasks run in the project's existing working tree; default concurrency 1
  (intent §7.2) bounds the risk.
- No run completion pipeline: all tasks succeeded → the run stays `executing`
  (intent §7.1.9); `integrating → validating → finalizing → succeeded`
  arrives with Phase 5.
- No Project Memory (6). No `ApprovalRequest` objects, no budgets —
  `maxAttempts` is the only Phase 4 limit (7). No report artifacts (8). No
  triggers (9).
- No startup reconciliation of orphaned tasks/agents (Phase 10) — `stop()`
  aborts and drops references without mutating state; a restart finds
  `running` tasks persisted and the tick leaves them (recovery is Phase 10's
  design).
- No interactive re-planning loop from task failures (master spec §49) —
  blocked runs are retried/replanned through the existing Phase 3 paths.
- No monetary cost (master spec §29: unknown unless a reliable source exists);
  tokens only from native session usage.
- `awaiting-review` remains unreachable; `workspaceId` remains unset.
