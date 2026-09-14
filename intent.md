# Intent — DSH Projects

**Gate:** Intent · **Status:** Phases 0–9 delivered (v0.15.0 released; Phase 9 shipped on `main` @ `9f81336`, pushed to `origin/main`) · **Spec:** `DSH_PROJECTS_SPEC.md` · **Architecture:** `docs/dsh-projects-architecture.md`

## 1. What we are doing

Evolve the existing `dsh-dashboard` Cordis plugin in this repository into **DSH Projects**: a project-level orchestration layer on top of DeepSeek Harness where a *project* owns a persistent, inspectable execution lifecycle (runs → plans → tasks → integration → memory → reports → automations).

The work proceeds as **vertical slices**: each phase delivers a thin, working, tested end-to-end capability (domain model → persistence → RPC → UI in the existing Dashboard) before the next one starts. No phase is started ahead of the previous one.

## 2. Why

Phases 1–9 built a durable, inspectable, *triggered* project runtime: persistent runs, versioned plans, a coordinator, a task DAG executed by native Harness agents, per-task Git worktrees, project memory, approvals + budgets, artifacts + final reports, and seven trigger types that start runs automatically. What that runtime does **not** yet do is **survive a process restart cleanly**. Today the durable state (runs, plans, tasks, approvals, memory, artifacts, triggers) all persist — but the *in-flight* execution state does not reconcile with reality on boot:

- A **Task** that claims `running` (with an `assignedAgentId` = a native Harness session id) and whose session is gone after a restart stays `running` **forever** — orphaned. Nothing re-queues it, nothing marks it interrupted, and its dependents stay `pending` behind it. The master spec is explicit (§54): *"stale running Agent states should be reconciled … Do not blindly restart everything. Implement reconciliation."*
- A **Run** stuck in a non-terminal phase (`executing`/`integrating`/`validating`/`finalizing`) whose execution context is gone is never re-driven: no task is dispatched, no phase advances, the run is wedged until a human cancels it.
- **Plan activation** is the one orchestration mutation that is *not* compare-and-set guarded (master spec §57 lists "Plan activation" among the states to protect); a concurrent activate can last-write-win.
- There are **no recovery tests** (restart → reconcile) and **no concurrency stress tests**, and the security surface (credentials, secret projection, untrusted external content) has not been reviewed as a whole.

Phase 10 makes the runtime **crash-safe and hardened**: on startup it **reconciles** the durable state with the live Harness world (stale runs, stale tasks, interrupted agents) using the existing single-authority state machines and compare-and-set guards, and it closes the remaining hardening gaps (plan-activation CAS, a security review, recovery + concurrency stress tests). No new capability is added — the existing lifecycle is made *durable across restarts* and *robust under concurrency*.

## 3. Invariants (non-negotiable for every phase)

1. **No invented APIs.** Only native Harness/Cordis/Agent-Teams/subagent/storage primitives as installed in the profile are used. The session-existence probe used by reconciliation must be a real, installed API (discovered in the Design stage, never invented); if no such API exists, reconciliation degrades to a *policy-based* timeout (a `running` task older than a bound with no live result is interrupted), and that decision is recorded.
2. **No placeholder APIs that are never implemented. No fake UI data.** Every RPC endpoint, service method, and UI control shipped must be backed by real behavior and real (or explicitly fixture-labeled local-mode) data.
3. **No premature phases.** Each slice ships only its own capability; later-phase tables/fields appear only where the architecture doc explicitly says so (domain name, reserved record fields).
4. **Preserve the existing Git worktree model** and all existing dashboard behavior; all changes are additive where the spec allows.
5. **Extend the native Dashboard UI** (one frontend, existing extension slots). No new app, no second shell.
6. **Orchestration state lives in code + persistent storage** (`dsh_projects` storage domain), never in ephemeral process state. State must survive a process restart — this phase is the one that *enforces* that for in-flight execution, not just durable records.
7. **The repo stays buildable and testable** at every commit: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green (modulo pre-existing environment failures documented at Phase 0).
8. **Single authority for state transitions.** Reconciliation must drive state through the existing `ProjectRunService.transition` / `ProjectTaskService` guarded transitions — never by writing records directly. This keeps the invariants testable (master spec §58).
9. **Reconciliation is idempotent and safe to re-run.** Booting twice (or a reconcile racing a live transition) must not double-interrupt, double-requeue, or corrupt a record that moved concurrently. Every reconcile write is compare-and-set guarded.

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
| 8 | Artifacts + final report — `project_artifacts` table, final-report generation, Artifacts UI | **done (v0.14.0)** |
| 9 | Trigger generalization — `project_triggers` + `trigger_fires`, 7 trigger types, idempotent fire, Automations UI | **done (v0.15.0)** |
| **10** | **Recovery + hardening — startup reconciliation for runs/tasks/agents, plan-activation CAS, recovery + concurrency stress tests, security review** | **this intent** |
| 11 | UI polish — overview/agent/plan/memory/artifacts/automations pages | planned |
| 12 | Optional Remote Worker Provider — `WorkerProvider` abstraction (+ optional K8s/OpenShift behind a flag) | planned (optional) |

## 5. Scope — Phase 10 (Recovery + Hardening)

Per master spec §73 (PHASE 10), §54 (crash/restart recovery), §57 (optimistic concurrency), §58 (single authority). This is a **hardening slice**: it adds no new user-facing capability and no new storage domain; it makes the existing lifecycle survive restarts and hold under concurrency.

### 5.1 Startup reconciliation (the core of this phase)

On service startup (after the Run/Task/Plan/Approval services are open, before `runtime.start()`), run a **reconciliation pass** that walks the durable state and repairs in-flight execution that a restart orphaned. It is driven entirely through the existing single-authority transitions (invariant 8) and is compare-and-set guarded (invariant 9).

- **Stale Task reconciliation (§54 example).** A task in `status: 'running'` carries an `assignedAgentId` (the native Harness session id, or member name). After a restart the in-memory `inFlight` map is empty, so a `running` task with no live worker is *stale*. Reconcile it:
  - **Probe, then decide.** If a real installed API can answer "does session `<assignedAgentId>` still exist / is it still producing turns?", use it (invariant 1). If the session is dead, the task is **interrupted**. If the session is still alive, leave the task alone (do not blindly restart — §54).
  - **Policy-based fallback.** If no session-existence API is installed, fall back to a deterministic policy: a `running` task whose `startedAt` is older than a recovery bound **and** has no live worker is interrupted. The bound and the probe-vs-policy decision are decided in the Design stage and recorded there.
  - **Interrupted → recoverable.** An interrupted task is not simply dropped: it is moved to a **recoverable** state that the existing scheduler can re-dispatch (respecting `attempt`/`maxAttempts` and dependency readiness). The exact target state (a new `interrupted` status vs. re-queueing to `ready`/`blocked` with an `interrupted` event) is decided in the Design stage; either way the task must not stay wedged in `running` and its dependents must be unblocked.
- **Stale Run reconciliation.** A run in a non-terminal phase (`executing`/`integrating`/`validating`/`finalizing`) whose execution context is gone is re-driven: after its tasks are reconciled, the run's phase is advanced (or its tasks re-dispatched) through `ProjectRunService.transition` so the run continues rather than wedging. Terminal runs (`succeeded`/`failed`/`canceled`) are never touched.
- **Pending approvals remain pending (§54).** Approvals are already durable; reconciliation confirms they survive and, where the owning run was reconciled to a terminal phase, expires the now-irrelevant pending approvals through the existing `approvalService` (no new state).
- **Triggers / memory / artifacts / plans / catalog remain (§54).** These are already durable and additive; reconciliation *asserts* they survive (a recovery test, not new code) — the phase's job is to prove the whole durable surface is restart-safe, not to re-implement it.
- **Reconciliation is observable.** Each reconcile action emits a run event (e.g. `task.interrupted`, `run.recovered`) and a log line, so a restart is inspectable in the Run detail / event timeline (reusing the existing event surface, no new UI in this phase).

### 5.2 Stale Run / Task / interrupted Agent handling

The concrete repair rules from §5.1, expressed as testable service behavior:

- **Stale Run handling** — a non-terminal run with no live execution is re-driven to progress (or, if its active plan has no recoverable work, transitioned to a terminal phase with a `run.recovered`/`run.failed` event). Never a blind restart of everything (§54).
- **Stale Task handling** — an orphaned `running` task is interrupted and made recoverable (re-queued within its `maxAttempts`, or failed with an `error` when the budget is exhausted).
- **Interrupted Agent handling** — the agent identity (`assignedAgentId`) of an interrupted task is cleared/retired so a re-dispatch gets a fresh session; a dead agent never blocks a re-run.

### 5.3 Concurrency hardening (master spec §57)

- **Plan activation compare-and-set.** Close the one §57 gap: plan activation (the `RunPlanService` activate/replan mutation) is guarded by `version`/`expectedVersion` compare-and-set with a `plan.versionConflict` failure, matching the existing run/task/approval guards. Task assignment, task state, run phase, and approval resolution are already CAS-guarded (verified in the current code); this phase *verifies* them with stress tests and adds the missing plan-activation guard.
- **No last-write-wins corruption** on the five §57-critical mutations (task assignment, task state, run phase, plan activation, approval resolution).

### 5.4 Recovery tests (master spec §73)

A dedicated recovery test surface (new `tests/recovery-*.test.ts`, jsdom-free node tests) that:

- **Restart → reconcile:** seed durable state (a `running` task + a non-terminal run + a pending approval + triggers + memory + artifacts), "restart" the services (close + reopen the domain, as the real boot does), run reconciliation, and assert: the stale task is interrupted/recoverable, the run is re-driven (not wedged), the approval survives (or is expired if the run went terminal), and the durable surface (catalog/plans/memory/artifacts/triggers) is intact.
- **Idempotent reconcile:** running the reconciliation pass twice (or racing it against a live transition) does not double-interrupt, double-requeue, or corrupt a concurrently-moved record.
- **Do-not-blindly-restart:** a `running` task whose session is still alive (or, under the policy fallback, within the recovery bound) is left untouched.
- **Terminal runs untouched:** reconciliation never moves a `succeeded`/`failed`/`canceled` run.

### 5.5 Concurrency stress tests (master spec §73)

A dedicated concurrency test surface (new `tests/concurrency-*.test.ts`) that drives the five §57-critical mutations from many interleaved async callers and asserts:

- Exactly-one-writer semantics hold: concurrent task-assignment / task-state / run-phase / plan-activation / approval-resolution calls either serialize cleanly or fail with the typed `*.versionConflict` error — never a lost update.
- The new plan-activation CAS rejects a stale activate.
- Reconciliation racing a live transition is safe (ties the recovery and concurrency surfaces together).

### 5.6 Security review (master spec §73)

A documented security review (recorded in the spec/test-report, not new code unless a gap is found) covering the master spec's security model (§33–§37):

- **Credentials** — no secret/credential is ever projected to the browser; the trigger `config` projection (Phase 9) and the run/task views carry no credentials.
- **Untrusted external content** — tracker/webhook payloads and agent output are treated as untrusted; no path where external content becomes an instruction or a filesystem write.
- **Filesystem / external-write / Git safety** — the per-task worktree + one-writer-per-worktree invariant and the default Git safety rules hold under the new reconciliation (reconciliation never writes outside the project worktree, never force-pushes, never touches the base branch).
- **Storage** — the `dsh_projects` domain stays at format version 0 (reconciliation is additive: it may add run *event types* and at most one recoverable task *status*, both additive; no migration).

If the review finds a real gap, the fix is in scope for this phase; otherwise the review is a recorded pass.

### 5.7 Explicit non-goals for this phase

- **No new user-facing capability** — no new page, tab, or RPC surface beyond what reconciliation needs to be inspectable (run events). The Automations/overview/agent/plan/memory/artifacts page polish is Phase 11.
- **No new storage domain** and **no schema migration** — `dsh_projects` stays at format version 0 (additive event types / at most one recoverable task status only).
- **No Remote Worker Provider** — that is the optional Phase 12.
- **No blind auto-restart of agents** — reconciliation repairs state; it does not silently re-launch dead agents beyond the recoverable re-queue the existing scheduler already performs.
- **No re-implementation of durable persistence** — catalog/plans/memory/artifacts/triggers already persist; this phase *proves* it with recovery tests.

## 6. Definition of done (acceptance for this phase)

1. **Startup reconciliation exists and is wired** into the real boot path (after services open, before `runtime.start()`), driven through the single-authority transitions and CAS-guarded.
2. **Stale tasks are recovered** — an orphaned `running` task is interrupted and made recoverable (re-queued within budget or failed); its dependents unblock; a still-alive task is left untouched (§54 "do not blindly restart").
3. **Stale runs are re-driven** — a non-terminal run whose execution context is gone continues (or reaches a terminal phase with an event); terminal runs are never touched.
4. **Pending approvals survive** (or are expired when the owning run goes terminal); the durable surface (catalog/plans/memory/artifacts/triggers) is proven restart-safe by tests.
5. **Plan activation is CAS-guarded** (`plan.versionConflict`), closing the last §57 gap.
6. **Recovery tests** (restart → reconcile, idempotent reconcile, do-not-blindly-restart, terminal-untouched) and **concurrency stress tests** (the five §57 mutations, exactly-one-writer, plan-activation stale-reject, reconcile-vs-live race) are green.
7. **Security review** is recorded (credentials / untrusted content / filesystem+Git safety / storage), with any found gap fixed.
8. **The repo stays green:** `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` pass (modulo the pre-existing, documented environment failures).

## 7. Next gate

**Design (Phase 10 — Recovery + hardening):** formalize `spec.md` — the reconciliation pass (where it runs in the boot sequence, the probe-vs-policy decision for stale-task detection and the recovery bound, the exact interrupted→recoverable state model and its event types, the stale-run re-drive rules through `ProjectRunService.transition`, the approval-expiry-on-terminal-run rule), the plan-activation compare-and-set guard + `plan.versionConflict`, the recovery test surface (the restart→reconcile harness that closes + reopens the domain) and the concurrency stress harness, the security-review checklist + recorded findings, and the full test plan per §6.
