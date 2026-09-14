# Spec — Phase 10: Recovery + hardening

**Gate:** Design · **Intent:** `intent.md` (Phase 10) · **Master spec:** `DSH_PROJECTS_SPEC.md` §73 (PHASE 10), §54 (crash/restart recovery), §57 (optimistic concurrency), §58 (single authority) · **Architecture:** `docs/dsh-projects-architecture.md` §6 (Phase 10: "startup reconciliation for runs/tasks/agents")

## 1. Goal and success

Make the DSH Projects runtime **crash-safe and hardened**: on startup it **reconciles** the durable state (`dsh_projects` domain) with the live Harness world, repairing the in-flight execution a process restart orphaned — without blindly restarting everything (master spec §54) — and it **verifies** the existing optimistic-concurrency guards under stress.

Success (measured at the Test gate):

- A `running` task whose Harness session is gone after a restart is **interrupted and made recoverable** (re-queued within its attempt budget, or failed when the budget is exhausted); its dependents unblock; a still-alive task is **left untouched**.
- A non-terminal Run whose execution context is gone is **re-driven** (its reconciled tasks re-dispatch, or it reaches a terminal phase with an event); a terminal Run is **never touched**.
- Pending approvals **survive** (or are expired when the owning Run goes terminal); the durable surface (catalog / plans / memory / artifacts / triggers) is **proven restart-safe** by tests.
- The four §57-critical mutations (task assignment, task state, Run phase, plan activation, approval resolution) are **verified** to hold exactly-one-writer semantics under concurrent interleaving (they are already CAS-guarded — this phase proves it, it does not add the guards).
- A **security review** (credentials / untrusted content / filesystem+Git safety / storage) is recorded, with any found gap fixed.
- `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` stay green (modulo the pre-existing, documented environment failures).

## 2. Invariants (from `intent.md` §3)

1. **No invented APIs.** The session-existence probe is the real, installed `ctx.agents.get(sessionId): Agent | undefined` (verified present in `@deepseek-ai/dsh-agent` `AgentRegistry`). No speculative API.
2. **No placeholder APIs. No fake UI data.** Reconciliation is real behavior; the only new surface is run *events* (inspectable in the existing Run detail / event timeline) — no new page, tab, or RPC.
3. **No premature phases.** No Phase 11 UI polish, no Phase 12 worker provider.
4. **Preserve the existing Git worktree model** and all existing dashboard behavior; all changes are additive.
5. **Extend the native Dashboard UI** (one frontend) — reconciliation is host-side; the UI only observes the new events.
6. **Orchestration state lives in code + persistent storage**, never in ephemeral process state — this phase enforces that for in-flight execution.
7. **The repo stays buildable and testable** at every commit.
8. **Single authority for state transitions.** Reconciliation drives state through the existing `ProjectRunService.transitionRun` / `ProjectTaskService` guarded transitions — never by writing records directly (master spec §58).
9. **Reconciliation is idempotent and safe to re-run.** Booting twice (or a reconcile racing a live transition) must not double-interrupt, double-requeue, or corrupt a record that moved concurrently. Every reconcile write is compare-and-set guarded.

## 3. Storage (additive, domain stays v0)

`dsh_projects` stays at **format version 0**. Phase 10 adds **no tables** and **no record fields**; it adds **two run event types** (additive to the `ProjectRunEventType` union in `src/runs/types.ts`):

### 3.1 New run event types (additive — two)

| Event type | Emitted when | `title` / `detail` |
| --- | --- | --- |
| `task.interrupted` | A stale `running` task is interrupted during reconciliation (its session is gone). | `title: 'Task interrupted'`, `detail: '<task title> (session lost on restart; attempt <n>/<max>)'` |
| `run.recovered` | A non-terminal Run is re-driven during reconciliation (its reconciled tasks re-dispatch, or it is moved to a terminal phase). | `title: 'Run recovered'`, `detail: '<reason: re-dispatched <k> interrupted task(s) \| moved to <phase>>'` |

Both are appended through the existing `appendRunEvent` path (persisted first, then emitted as a Cordis event), exactly like `task.ready`/`task.failed`. No new table, no new record field, no migration.

### 3.2 The interrupted→recoverable state model (no new task status)

The task state machine (`src/tasks/state-machine.ts`) already has the `running → ready` **internal-retry edge** and the `running → failed` edge, and `settleResult` already encodes the attempt-budget rule (`running → ready` if `attempt < maxAttempts`, else `running → failed`). Phase 10 **reuses that exact rule** for a stale task — it does **not** add a new `interrupted` status:

- A stale `running` task transitions `running → ready` (re-queued; the scheduler's existing tick loop re-dispatches it) when `attempt < maxAttempts`, or `running → failed` (with `error: 'interrupted: session lost on restart'`) when `attempt >= maxAttempts`.
- The `task.interrupted` event distinguishes a restart-interruption from an ordinary failure in the event timeline.
- `assignedAgentId` is left as-is on the `→ ready` edge (the next `beginExecution` overwrites it with a fresh session id); on the `→ failed` edge it is the dead session id (kept for traceability).

This keeps the state machine, the client `ProjectTaskStatus` mirror, and the locale keys unchanged — the recovery is fully expressed in existing edges + two new events.

## 4. The reconciliation pass (the core of this phase)

### 4.1 Where it runs

A new `reconcileAfterRestart()` method on `ProjectTaskService` (it owns the task tables, the run tables it borrows, the worker, and the single-authority transitions — the same owner that does the tick loop). It is invoked from `src/index.ts` **after** `taskService.start()` and **before** `runtime.start()`, inside the existing `startup` promise chain:

```ts
await runService.start()
memoryService.start(); approvalService.start(); artifactService.start()
triggerService.start(); /* push adapters */ planService.start(); coordinator.start()
taskService.start()
await taskService.reconcileAfterRestart()   // Phase 10 — repair in-flight state a restart orphaned
await runtime.start()
```

It is **awaited** (reconciliation must complete before the runtime drives new work, so a re-queued task is not double-dispatched) and a failure is **logged, not fatal** (a reconcile error must not prevent the plugin from booting — the next restart retries).

### 4.2 The pass (per non-terminal Run)

For each Run in a non-terminal phase (`executing`/`integrating`/`validating`/`finalizing`/`planning`/`awaiting_approval` — never `succeeded`/`failed`/`canceled`):

1. **Collect stale tasks.** For each task in `status: 'running'`, probe the session: `this.worker.sessionAlive?.(task.assignedAgentId)`. A task is **stale** when its `assignedAgentId` is set **and** the probe reports the session is gone (§4.3). A `running` task with **no** `assignedAgentId` is also stale (it was never dispatched — a torn write).
2. **Interrupt each stale task** through the single authority (§5): emit `task.interrupted`, then transition `running → ready` (re-queue) or `running → failed` (budget exhausted). Each write is CAS-guarded (`casTaskTransition` checks `current.status !== task.status`), so a task that moved concurrently (a live worker settled it) is a logged no-op.
3. **Re-drive the Run (§6).** After its tasks are reconciled, if the Run is `executing` and has at least one re-queued `ready` task, emit `run.recovered` (detail: `re-dispatched <k> interrupted task(s)`) and let the existing tick loop re-dispatch — **no direct phase transition** (the Run stays `executing`; the scheduler picks up the `ready` tasks). If the Run is `executing` and **no** task is recoverable (all interrupted tasks hit their budget → `failed`, and the DAG is dead), the existing `deadDagCheck` will block it on the next tick — reconciliation does not force a terminal phase itself. If the Run is in `integrating`/`validating`/`finalizing`, the existing `driveCompletionPipeline` re-runs on the next tick — reconciliation only ensures the interrupted tasks (if any) are settled first.
4. **Expire orphaned approvals (§7).** For each pending approval whose owning Run was moved to a terminal phase by this pass (only possible via the dead-DAG block path), expire it through `approvalService.expireApproval`.

### 4.3 The session probe (probe-primary, policy-fallback)

The probe answers "does the Harness session this task's `assignedAgentId` refers to still exist?"

- **Probe-primary.** `ProjectTaskService` gains an optional `sessionAlive?: (sessionId: string) => boolean` hook (injected at construction, defaulting to `undefined`). In `src/index.ts` it is wired to the real installed API: `(id) => ctx.agents.get(id) !== undefined`. `ctx.agents.get` returns the registered `Agent` for a live session and `undefined` for a gone one — a real, installed primitive (invariant 1).
- **Policy-fallback.** When `sessionAlive` is `undefined` (the hook is not wired — e.g. a test that does not exercise the probe), a `running` task is stale when `now - startedAt > RECOVERY_STALE_MS` (a service constant, default `30 * 60 * 1000` — well above any single task turn) **or** it has no `assignedAgentId`. This keeps reconciliation total (it always makes progress) and testable without a live `ctx.agents`.
- **Do not blindly restart (§54).** A task whose probe reports the session is **alive** (or, under the policy fallback, is within the stale bound and has a session) is **left untouched** — reconciliation never interrupts a live execution.

### 4.4 Idempotency and safety (invariant 9)

- The pass is **read-mostly**: it only writes a task that is `running` and stale, and only through a CAS transition. Running it twice is a no-op the second time (the first run already moved the stale tasks out of `running`).
- A reconcile racing a live worker is safe: if the worker settles the task (`running → succeeded`/`failed`) before the reconcile's CAS, the CAS throws `TaskTransitionError` and the reconcile logs a no-op.
- Reconciliation never touches a terminal Run or a terminal task.

## 5. Stale Task handling (the §54 example)

The concrete repair for the master spec's example (*"Task claims RUNNING but referenced Harness session no longer exists → mark as interrupted/recoverable"*):

```
reconcileStaleTask(task, run, now):
  stale = isStale(task)                       // §4.3 probe/fallback
  if (!stale) return 'left-alone'
  emit run event `task.interrupted`
  max = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (task.attempt < max):
    casTaskTransition(task, 'ready', { now }) // re-queued; the tick loop re-dispatches
    return 'requeued'
  casTaskTransition(task, 'failed', { now, error: 'interrupted: session lost on restart' })
  return 'failed'
```

- **Re-queued** tasks are picked up by the existing `tickOnce` → `pickReadyTasks` → `beginExecution` path (a fresh session id, `attempt + 1`). No new dispatch code.
- **Failed** tasks (budget exhausted) settle the attempt through the existing `task.failed` path; their dependents stay `blocked` (the existing dependency coupling) and the Run's `deadDagCheck` blocks the Run if the DAG is dead.
- **Interrupted Agent handling:** the dead `assignedAgentId` is retired implicitly — the next `beginExecution` overwrites it with a fresh `dsh-task-<uuid>` session. A dead agent never blocks a re-run.

## 6. Stale Run handling

- **`executing` with recoverable work** → stays `executing`; the re-queued `ready` tasks re-dispatch on the next tick. `run.recovered` is emitted (detail names the count). No phase transition.
- **`executing` with no recoverable work** (all interrupted tasks failed, DAG dead) → the existing `deadDagCheck` blocks the Run (`executing → blocked`) on the next tick. Reconciliation does not force this itself (it stays a single authority — the tick loop owns the block).
- **`integrating`/`validating`/`finalizing`** → the existing `driveCompletionPipeline` re-runs on the next tick; reconciliation only settles any interrupted tasks first (those phases have no `running` tasks in the normal flow, so this is a no-op in practice — kept for safety).
- **`planning`/`awaiting_approval`** → no `running` tasks exist in these phases; reconciliation is a no-op (the Run is waiting on the coordinator / an approval, both of which are durable).
- **Terminal Runs** (`succeeded`/`failed`/`canceled`) → **never touched** (invariant 9).

## 7. Pending approvals + the durable surface

- **Pending approvals survive** (§54): they are already durable (`project_approvals` table). Reconciliation confirms this (a recovery test asserts a pending approval is intact after a restart).
- **Expiry on terminal Run:** if a reconcile moved an owning Run to a terminal phase (only via the dead-DAG block → a later terminal move), the now-irrelevant pending approvals are expired through the existing `approvalService.expireApproval` (the "only path to `expired`"). In practice the block path leaves the Run `blocked` (non-terminal), so this is a safety net, not the common case.
- **Triggers / memory / artifacts / plans / catalog survive** (§54): already durable and additive. Reconciliation **asserts** (recovery test) that they are intact after a restart — the phase proves the whole durable surface is restart-safe, it does not re-implement persistence.

## 8. Concurrency hardening (master spec §57) — verification, not new guards

**Correction to `intent.md` §5.3:** all four §57-critical mutations are **already** compare-and-set guarded in the current code — there is no plan-activation gap to close:

| §57-critical mutation | Existing guard (verified) | Conflict code |
| --- | --- | --- |
| Run phase | `ProjectRunService.transitionRun` — `version` + `expectedVersion` CAS | `run.versionConflict` |
| Task state | `ProjectTaskService.casTaskTransition` — `current.status !== task.status` CAS (status-based) | `TaskTransitionError` (service-internal) |
| Task assignment / worktree identity | `provisionTaskWorktree` second CAS — `current.version !== started.version` | `TaskTransitionError` |
| Plan activation | `RunPlanService.transitionPlan` — `revision` + `expectedRevision` CAS | `plan.revisionConflict` |
| Approval resolution | `ApprovalService.resolveApproval` / `expireApproval` — `version` + `expectedVersion` CAS | `approval.versionConflict` |

Phase 10 therefore **verifies** these guards under stress (it does not add them):

- **Exactly-one-writer** on each of the five mutations under many interleaved async callers: concurrent calls either serialize cleanly or fail with the typed conflict error — never a lost update.
- **Reconcile-vs-live race:** a reconciliation pass racing a live `settleResult` (or a live `beginExecution`) is safe — the CAS makes the loser a no-op (§4.4).
- **Plan-activation stale-reject:** a `transitionPlan` with a stale `expectedRevision` is rejected with `plan.revisionConflict` (proving the guard the intent assumed was missing is in fact present).

No production code change is required for §8 unless a stress test exposes a real race; if one does, the fix is in scope for this phase.

## 9. Security review (master spec §73)

A documented review (recorded in the test-report, not new code unless a gap is found) covering master spec §33–§37, scoped to what reconciliation touches:

- **Credentials (§33):** reconciliation reads no credentials; it only probes `ctx.agents.get` (a session identity) and transitions task/run records. No secret is projected to the browser; the trigger `config` projection (Phase 9) and the run/task views carry no credentials. **Pass.**
- **Untrusted external content (§34):** reconciliation consumes no external content (no tracker/webhook payload, no agent output) — it only inspects durable records and session identity. **Pass.**
- **Filesystem / external-write / Git safety (§35–§37):** reconciliation writes **only** `dsh_projects` domain records (task/run status + events). It never touches the filesystem, never creates/commits/pushes a worktree, never force-pushes, never touches the base branch. The per-task worktree + one-writer-per-worktree invariant is unaffected (reconciliation re-queues to `ready`; the next `beginExecution` re-provisions idempotently). **Pass.**
- **Storage (§56):** `dsh_projects` stays at format version 0 (additive: two run event types only; no table, no field, no migration). **Pass.**

If the review finds a real gap, the fix is in scope for this phase; otherwise the review is a recorded pass.

## 10. Module layout & wiring

- **`src/tasks/task-service.ts`** — add `reconcileAfterRestart()`, `reconcileStaleTask()`, `isStaleTask()`, and the optional `sessionAlive?` constructor hook + the `RECOVERY_STALE_MS` constant. Reuses the existing `casTaskTransition`, `appendRunEvent`, `emitTaskEvent`, `tasksForRun`, and the `DEFAULT_MAX_ATTEMPTS` constant. No new dependency.
- **`src/runs/types.ts`** — add `task.interrupted` + `run.recovered` to the `ProjectRunEventType` union (additive).
- **`src/index.ts`** — wire `sessionAlive: (id) => ctx.agents.get(id) !== undefined` into the `ProjectTaskService` constructor; call `await taskService.reconcileAfterRestart()` after `taskService.start()`, before `runtime.start()`.
- **No new module.** The reconciliation lives in the task service (the owner of the task tables + the single-authority transitions + the tick loop), not a new file.

## 11. Test plan

### 11.1 `tests/recovery.test.ts` (new, node — no jsdom)

The restart→reconcile surface. Boots the real storage stack (the `run-storage-integration.test.ts` pattern: genuine Cordis Context + JSON backend + DomainFacility) with a fake `ctx.agents` (a `get` that returns `undefined` for a dead session id and an object for a live one) and a fake worker. Cases:

1. **Stale task re-queued** — seed a `running` task (`attempt 1`, `maxAttempts 3`, `assignedAgentId` = a dead session) under an `executing` Run; "restart" (close + reopen the domain); run `reconcileAfterRestart()`; assert the task is `ready` (re-queued), a `task.interrupted` event is appended, and a `run.recovered` event (detail `re-dispatched 1 interrupted task(s)`) is appended.
2. **Stale task failed at budget** — same but `attempt 3`, `maxAttempts 3`; assert the task is `failed` with `error: 'interrupted: session lost on restart'` and a `task.interrupted` event.
3. **Live task left alone** — seed a `running` task whose `assignedAgentId` is a **live** session (the fake `ctx.agents.get` returns an object); assert the task is **unchanged** (still `running`, same version) and no `task.interrupted` event.
4. **No-session task stale** — seed a `running` task with **no** `assignedAgentId`; assert it is re-queued (stale by the §4.3 rule).
5. **Policy fallback** — construct the service with **no** `sessionAlive` hook; seed a `running` task with `startedAt` older than `RECOVERY_STALE_MS`; assert it is re-queued; and a `running` task with a recent `startedAt` + a session is left alone.
6. **Terminal Run untouched** — seed a `running` task under a `succeeded` Run; assert the task and the Run are **unchanged**.
7. **Durable surface survives** — seed a pending approval + a trigger + a memory record + an artifact + a plan under a Run; restart; assert all are intact after `reconcileAfterRestart()`.
8. **Idempotent reconcile** — run `reconcileAfterRestart()` **twice**; assert the second run is a no-op (no duplicate events, no double-transition, versions stable).
9. **Reconcile-vs-live race** — seed a stale `running` task; concurrently settle it (a live `settleResult` to `succeeded`) and run the reconcile; assert exactly one outcome wins (the task is `succeeded`, not `ready`/`failed`), no corruption.

### 11.2 `tests/concurrency.test.ts` (new, node)

The §57 stress surface (fake ctx + fake worker, the `task-service.test.ts` pattern). Cases:

1. **Task-state exactly-one-writer** — N concurrent `casTaskTransition` callers on one `ready` task; assert exactly one wins (`running`), the rest are no-ops/errors, the version is consistent.
2. **Run-phase exactly-one-writer** — N concurrent `transitionRun` callers with distinct `expectedVersion`; assert exactly one wins, the rest get `run.versionConflict`.
3. **Plan-activation stale-reject** — a `transitionPlan` with a stale `expectedRevision` is rejected with `plan.revisionConflict` (proving the guard the intent assumed missing is present).
4. **Approval-resolution exactly-one-writer** — N concurrent `resolveApproval` callers; assert exactly one wins, the rest get `approval.versionConflict`.
5. **Reconcile-vs-live race** — (mirrors 11.1.9 at the concurrency layer) a reconcile racing a live `beginExecution`/`settleResult` is safe.

### 11.3 `tests/run-storage-integration.test.ts` (extended)

Add one case: the full durable surface (a `running` task + a non-terminal Run + a pending approval + a trigger + a memory + an artifact) survives a close+reopen **and** is reconciled (the stale task is re-queued) — tying the recovery surface to the real storage stack.

### 11.4 `tests/task-service.test.ts` (extended)

Add the `reconcileAfterRestart` unit cases that do not need the full storage stack (the `isStaleTask` probe/fallback matrix, the `reconcileStaleTask` re-queue/fail/leave-alone outcomes) using the existing fake ctx + fake worker fixture.

## 12. Acceptance criteria (maps to `intent.md` §6)

1. **Startup reconciliation exists and is wired** into the real boot path (after services open, before `runtime.start()`), driven through the single-authority transitions and CAS-guarded. *(11.1.1, 11.3)*
2. **Stale tasks are recovered** — an orphaned `running` task is interrupted + re-queued (within budget) or failed (budget exhausted); a still-alive task is left untouched; a no-session task is stale. *(11.1.1–4, 11.4)*
3. **Stale Runs are re-driven** — a non-terminal Run continues (re-queued tasks re-dispatch, or the dead-DAG block applies); terminal Runs are never touched. *(11.1.1, 11.1.6, 11.3)*
4. **Pending approvals survive** (or are expired when the owning Run goes terminal); the durable surface (catalog/plans/memory/artifacts/triggers) is proven restart-safe. *(11.1.7, 11.3)*
5. **The §57 guards are verified** — task-state / run-phase / plan-activation / approval-resolution hold exactly-one-writer under stress; the plan-activation stale-reject is proven. *(11.2.1–4)*
6. **Reconciliation is idempotent and race-safe** — a double reconcile is a no-op; a reconcile racing a live transition is safe. *(11.1.8–9, 11.2.5)*
7. **Security review recorded** (credentials / untrusted content / filesystem+Git safety / storage), `dsh_projects` stays at format version 0 (two additive event types only). *(§9)*
8. **The repo stays green:** `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` pass (modulo the pre-existing, documented environment failures).

## 13. Explicit non-goals (Phase 11+)

- **No new user-facing capability** — no new page, tab, or RPC surface. Reconciliation is host-side; the UI only observes the two new run events (the Run detail / event timeline already renders arbitrary run events). The Automations/overview/agent/plan/memory/artifacts page polish is Phase 11.
- **No new storage domain, no new table, no new record field, no migration** — `dsh_projects` stays at format version 0 (two additive run event types only).
- **No new task status** — the interrupted→recoverable model reuses the existing `running → ready`/`running → failed` edges (no `interrupted` status).
- **No new concurrency guards** — the four §57 mutations are already CAS-guarded; this phase verifies them, it does not add them (a guard is added only if a stress test exposes a real race).
- **No Remote Worker Provider** — that is the optional Phase 12.
- **No blind auto-restart of agents** — reconciliation repairs state; it does not silently re-launch dead agents beyond the recoverable re-queue the existing scheduler already performs.
- **No re-implementation of durable persistence** — catalog/plans/memory/artifacts/triggers already persist; this phase proves it with recovery tests.

## 14. Sequencing (build order)

1. **Events first** — add `task.interrupted` + `run.recovered` to the `ProjectRunEventType` union (`src/runs/types.ts`).
2. **Reconciliation core** — `reconcileAfterRestart` / `reconcileStaleTask` / `isStaleTask` + the `sessionAlive` hook + `RECOVERY_STALE_MS` in `src/tasks/task-service.ts`.
3. **Wire the boot** — `src/index.ts`: inject `sessionAlive` (real `ctx.agents.get`) + call `await taskService.reconcileAfterRestart()` before `runtime.start()`.
4. **Recovery tests** — `tests/recovery.test.ts` (11.1) + extend `tests/task-service.test.ts` (11.4) + extend `tests/run-storage-integration.test.ts` (11.3).
5. **Concurrency tests** — `tests/concurrency.test.ts` (11.2).
6. **Security review** — record in the test-report (§9).
7. **Green gate** — `pnpm run typecheck` + `pnpm run build` + `pnpm vitest run`.
