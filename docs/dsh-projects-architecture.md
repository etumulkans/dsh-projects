# DSH Projects — Architecture (existing `dsh-dashboard` → target DSH Projects)

This document is the Phase 0 audit and the implementation architecture for evolving
`dsh-dashboard` into DSH Projects as specified in `DSH_PROJECTS_SPEC.md`. It maps every
existing component to its role in the target system, inventories the **actual** installed
Harness/Cordis APIs (the installed version wins over any README), and defines the Phase 1
vertical slice: persistent Project Runs.

## 1. Phase 0 baseline

Environment: Node v22.22.0, pnpm 11.19.0, macOS (Apple Silicon), git present.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS (also runs `prepare` → full build) |
| `pnpm run typecheck` (`tsc -p tsconfig.json --noEmit`) | PASS, 0 errors |
| `pnpm test` (`vitest run`) | 110 passed, **3 pre-existing failures** |
| `pnpm run build` (clean + typecheck + tsc decls + tsdown) | PASS |

Pre-existing failures (recorded BEFORE any change; environment-related, not regressions):

* `tests/project-catalog.test.ts` — 3 tests fail on this macOS machine because
  `os.tmpdir()` returns `/var/folders/...` while `realpath()` canonicalizes to
  `/private/var/folders/...`. The catalog stores the realpath but the tests compare
  against the raw `tmpdir()` path. Fails identically on the clean checkout.

Everything else (orchestrator, scheduling, workspace, providers, workflow parser,
timeline, i18n, UI interaction suites) passes.

## 2. What `dsh-dashboard` is today (audited)

`dsh-dashboard` is a Cordis plugin (single package, `src/host` + `src/client` dual build)
that turns tracker tasks into isolated DeepSeek Harness Agent runs and exposes a native
Dashboard overlay.

### 2.1 Host side

| Module | Responsibility (verified in code) |
| --- | --- |
| `src/index.ts` | Plugin entry. Wires `ProjectCatalog`, `TaskSourceRegistry`, `HarnessAgentRunner`, `WorkspaceManager`, `DashboardOrchestrator` per project via `DashboardRuntimeCoordinator`; registers trusted-host RPC `/dsh-dashboard`; owns startup/disposal. |
| `src/catalog/` | **Project Catalog**: durable `storage-domain` `dsh_dashboard` (tables: `projects`, `repositories`, `discovery_roots`, `settings`). Projects reference repositories by id; discovery is bounded (depth 1–8, ≤10k dirs, ≤200 candidates, one-use 10-min tokens); git roots become `worktree` strategy, others `controlled-directory`. Mutations serialize on a promise tail. |
| `src/orchestrator/` | **DashboardOrchestrator**: poll → reconcile → dispatch → continue/retry loop over normalized `TaskIssue`s; per-issue in-process claims; concurrency caps (global + per-state); exponential retry `min(10s·2^(n-1), max_retry_backoff_ms)`; `RuntimeTimelineArchive` bounded in-memory event log. |
| `src/orchestrator/scheduling.ts` | Pure scheduling helpers: `compareCandidates`, `failureRetryDelay`, `stateLimit`. |
| `src/agent/harness-runner.ts` | **HarnessAgentRunner**: one `ctx.agents.create({sessionId, meta:{cwd}, agentOptions, setup})` per worker attempt; multi-turn `followup`/`whenIdle` up to `max_turns`; per-turn `session/event` projection to `IssueRuntimeView` (turns, tokens, recent events); task-source scoped tool installed in agent scope; permission preset applied via `ctx.permissionPresets.set(session, preset)`. |
| `src/workspace/` | **WorkspaceManager**: stable per-issue workspace leaf under `WORKFLOW.md` workspace root; `git worktree add --detach <path> HEAD` for git projects with common-dir verification; symlink/containment checks on create, enter, delete; Symphony-style hooks (`after_create`, `before_run`, `after_run`, `before_remove`) with bounded output and re-validated removal targets. |
| `src/workflow/` | **WorkflowStore**: strict v1 `WORKFLOW.md` (YAML frontmatter + prompt body), last-good reload, file watching; `parseOptions` = plugin global `policyDefaults` + agent profile; provider-specific fields accessed only through typed helpers (`providerString`, …). |
| `src/task-source/` | `TaskSourceRegistry` (scoped per project) + `TaskIssue` normalization contract. Providers: Linear (GraphQL), GitHub, Jira, Asana, GitLab (REST, path-bounded tools), **LocalTaskSource** (atomic JSON store, full create/update/delete capability). |
| `src/runtime/` | `DashboardRuntimeCoordinator` (per-project isolated runtime graphs; atomic selection; global read-only composite), `global.ts` (pure cross-project aggregation), `timeline.ts` (bounded archive + cursor pagination), `types.ts` (lossless-JSON `DashboardSnapshot` protocol v2 + `DashboardRpcMap`), `errors.ts` (`DashboardDomainError` with stable codes, encoded into RPC error messages for client-side localization). |
| `src/rpc/handler.ts` | Trusted-host RPC dispatch for the fixed endpoint list (`state`, `refresh`, `issue`, `timeline`, `pause`, `stop`, `createTask`, `updateTask`, `deleteTask`, `switchProject`, `switchGlobal`, `addDiscoveryRoot`, `removeDiscoveryRoot`, `scanProjects`, `registerProjectCandidate`, `registerProject`), with manual payload validation helpers. |

### 2.2 Browser side

| Module | Responsibility (verified in code) |
| --- | --- |
| `src/client/index.tsx` | Browser plugin entry: registers `sidebar.footer.action` trigger + `shell.overlay` surface into native Harness UI slots; one `DashboardDataController` (RPC projection) + one `DashboardUiController` (visibility store); locale dictionaries registered under namespace `dsh-dashboard`. |
| `src/client/Dashboard.tsx` | `DashboardSurface`: tabs **Board / Runtime / Projects / Configuration**; `ProjectContextSwitcher`; `RuntimeRail` attention filter; `BoardView`/`BoardListView`; `IssueInspector` (detail side panel with timeline, stop, edit); `ProjectsView` + catalog dialogs; `ConfigurationView`; toasts; view preferences per scope. |
| `src/client/controller.ts` | `DashboardDataController`: 5 s polling of `state`, `refresh` on mount, manual mutations; `parseSnapshot` validates protocol `version === 2`. |
| `src/client/i18n.tsx`, `locales.ts` | Bilingual zh/en dictionaries (zh is the source-of-truth key set); `useDashboardTranslation`. |
| `src/client/styles.ts` | Injected CSS (`dshd-*` classes), dark/light via Harness theme tokens. |
| `src/client/dev.tsx`, `fixture.ts` | Local Vite dev harness + deterministic fixtures for UI tests only. |

### 2.3 Build & test system

* pnpm single package (`type: module`), TypeScript strict + `exactOptionalPropertyTypes` +
  `noUncheckedIndexedAccess` + `verbatimModuleSyntax`; `tsdown` dual build: host ESM
  (`lib/index.js`, `lib/task-source.js`) + client CJS bundle (`lib/client.js`);
  `tsconfig.build.json` emits declaration files to `lib/types` (excludes `dev.tsx`, `fixture.ts`).
* Vitest (node + jsdom for UI tests), `@testing-library/react`; host-side unit tests use
  in-memory fake `KvTable`/`Domain`/`Context` objects (see `tests/runtime-coordinator.test.ts`).
* `cordis.patch.yml` declares the browser bundle patch; `dsh.client.inject` lists the client
  runtime packages the web shell must load.

## 3. Installed Harness / Cordis API inventory (ground truth)

The plugin's **declared** dependencies (peer/dev) are the packages it may import:
`@deepseek-ai/cordis@4.0.1`, `dsh-agent`, `dsh-agent-default-model`, `dsh-agent-presets`,
`dsh-client-{connection,locale,runtime,ui-layout,ui-sidebar,ui-slots}`, `dsh-credentials`,
`dsh-llm`, `dsh-permission-presets`, `dsh-session`, `dsh-storage`, `dsh-storage-domain`,
`dsh-tools`, `schemastery`, `react`, `react-dom`, plus `js-yaml`, `liquidjs`, `zod`.
The full DSH runtime is available in the host checkout
(`/Users/esne/repo/deepseek-harness`) for reference; the plugin must not import packages
outside its dependency list.

### 3.1 Cordis `Context`

* `ctx.on(type, listener)` / `ctx.emit(type, payload)` — event bus mixed onto the context
  (used today by the runner for `session/event`, by `storage-domain` for `domain/changed`).
* `ctx.effect(cleanup, label)` — lifecycle effect with disposer (plugin startup/disposal).
* `ctx.logger` — structured logger (`info`/`warn`/`debug`).
* `ctx.get(name)` — typed service lookup for capabilities not statically injected
  (used for `agentPresets`, `tools`).

### 3.2 `@deepseek-ai/dsh-storage-domain` (the persistence mechanism)

* `defineDomain({ name, version, tables, global? })` + `domainTable<K,V>(zodSchema)`.
* `ctx.storageDomain.open(spec) → Domain<S>`; `domain.table(name) → KvTable<K,V>` with
  `get` / `entries` / `keys` / `size` / `put` / `delete` / **`update`** — where
  `update(key, fn)` is an **atomic read-modify-write serialized on the domain's single
  write chain** (durability first, then memory, then `domain/changed` event). This is the
  compare-and-set primitive for Run/Task state.
* Records are validated against the zod schema at the durable boundary
  (`invalid-record` on violation); a medium stamped with a different `version` rejects at
  open; **absent declared tables initialize empty**, so adding tables to an existing
  domain version is additive.
* `Domain.close()` is consumer-owned and idempotent.
* The `dsh_dashboard` catalog domain (version 0) already uses exactly this pattern — the
  new `dsh_projects` domain follows it 1:1.

### 3.3 `@deepseek-ai/dsh-agent` (worker execution)

* `ctx.agents.create({ sessionId, meta: { cwd, agentPreset?, origin?, delegationDepth? },
  agentOptions: { provider, model }, signal, setup }) → AgentHandle` (`agent`, `dispose`,
  `session`, `inbox`, `status`); `agent.followup(userMessage)`, `agent.whenIdle()`,
  `agent.cancel({ kind, reason })`.
* `installModelSelection(agentCtx, ref)` + `ctx.agentDefaultModel.currentSelection()` for
  model/profile selection; `ctx.get('agentPresets')?.resolve(id)` / `presets.mount(agentCtx, id)`.
* `ctx.sessions.flush(session)` for durable session checkpoints.
* This is already what `HarnessAgentRunner` uses — reused unchanged as the Phase 4+
  worker foundation.

### 3.4 `@deepseek-ai/dsh-session`

* `SessionId`, `SessionEvent` (`turn/start`, `assistant/message` with `usage`, `tool/call`,
  `tool/result`, `turn/end`), `ctx.sessions` (flush), `ctx.on('session/event')`.
* Used today for per-turn token accounting and runtime projection.

### 3.5 Native Agent Teams (experimental — adapter target, Phase 4)

`@deepseek-ai/dsh-experimental-agent-team` (harness checkout,
`packages/experimental/agent-team`) registers **`ctx.agentTeams: TeamService`** when the
composition mounts the plugin (it is not a dependency of this package — it is mounted by
the host composition, and requires durable session storage):

* `membership(agent)` / `tryMembership(agent)` — every live runtime root is the implicit
  Lead of a team whose `TeamId` equals its `SessionId`.
* `spawnTeammate(callerAgent, { name, description, prompt, … })` — Lead-only; creates a
  named, continuable direct child.
* `sendMessage(callerAgent, { target, content, mode: 'quiet' | 'follow-up' })` — durable
  peer mailbox, never lost, never duplicated.
* `createTask / getTask / listTasks / updateTask(callerAgent, { id, expectedRevision,
  action, … })` — shared task board with **compare-and-set revisions**, dependencies
  (claimable only when all dependencies complete), ownership, tombstoned history.
* `waitForChange(callerAgent, timeoutMs, signal)`, `interrupt(callerAgent, targetName)`,
  `listMembers(agent)`, `remoteView(agent)`.
* Team events (`team/member`, `team/task`, `team/message/*`) are appended to the Lead
  session log; derived state replays from it.

Because it is explicitly experimental, all DSH Projects usage must go through a local
`TeamRuntimeAdapter` (Phase 4) that imports nothing outside one file, so an API change
localizes there.

### 3.6 Background subagents (native — adapter target, Phase 4)

`@deepseek-ai/dsh-subagent` registers **`ctx.subagents: SubagentRuntime`**:

* `start` (one-shot owned run), `startContinuable` (durable continuable child),
  `sendMessage` (steer a live/idle child), interrupt, child/descendant listing
  (`listChildren`/`listDescendants` read the live session store), timing/identity
  projections. Continuable children are held by the continuation manager, not the
  provider — start, collect, list, stop, message, observe-completion are all available
  without reimplementing process management.

### 3.7 UI extension slots (native)

`ctx.slots.inject('sidebar.footer.action', …)` and `ctx.slots.inject('shell.overlay', …)`
(dsh-client-ui-slots) are how the dashboard embeds in the Harness GUI today. New DSH
Projects UI must stay inside the same `shell.overlay` surface — no second app.

## 4. Existing → target mapping

| DSH Projects target (spec §) | Reuse unchanged | Generalize / extend | New |
| --- | --- | --- | --- |
| Project model (§4–5) | `ProjectRecord`/`RepositoryRecord` already separate project identity from repository identity (`repositoryIds`), with `workspaceStrategy` | Additive optional fields on `ProjectRecord` only when a phase needs them (e.g. `instructions`, `coordinatorProfile`, `approvalMode`) — never breaking changes | `ProjectMemory`, `ProjectTrigger`, `ApprovalRequest` domains (later phases) |
| **Project Run (§6)** | — | — | **Phase 1**: `ProjectRunRecord` + state machine + `dsh_projects` storage domain + `ProjectRunService` + RPC + Runs tab |
| Coordinator (§7–8) | `HarnessAgentRunner` (agent creation, model selection, permission preset, session flush) | Coordinator = a long-lived Lead agent per project run; guidance as versioned prompt section | `CoordinatorService` + policy module (Phase 3) |
| Orchestration patterns (§9) | `DashboardOrchestrator` dispatch/retry/backoff primitives (`scheduling.ts`) | Pattern choice persisted on RunPlan | `RunPlanService` (Phase 2) |
| Plans (§10) | — | — | `project_plans` table (Phase 2) |
| Tasks + DAG (§11–12) | `DashboardOrchestrator` ready/capacity/retry logic; team task board (CAS revisions, dependencies) | Generalize `scheduling.ts` into shared DAG helpers | `ProjectTaskService` (Phase 4) |
| Agent execution (§13–14) | `ctx.agents` runner; `ctx.subagents`; experimental `ctx.agentTeams` | — | `TeamRuntimeAdapter`, `BackgroundAgentAdapter` (Phase 4, adapter isolation per §79) |
| Git workspaces (§16–17) | **WorkspaceManager entirely** (worktree add/detach, containment, hooks, re-validated removal) | Branch naming `dsh/run-<shortRunId>/<task>` reuses leaf-normalization utilities | Integration worktree strategy (Phase 5) |
| Approvals (§18–19) | — | — | `project_approvals` (Phase 7) |
| Memory (§20–25) | — | — | `project_memory` (Phase 6) |
| Artifacts (§26) | — | — | `project_artifacts` (Phase 8) |
| Triggers (§27) | Tracker TaskSources + LocalTaskSource | Wrap source events into `ProjectTrigger` adapters | `TriggerService` (Phase 9) |
| Events (§28) | `ctx.emit` bus; `domain/changed`; `RuntimeTimelineArchive` + cursor pagination | — | High-level run event table + `dsh-projects/*` Cordis events (Phase 1 seeds it) |
| Observability (§29) | Token accounting in `HarnessAgentRunner.projectEvent`, `TokenTotals`, `RuntimeView` | Run-level aggregation | — |
| Budgets (§30) | Retry/capacity enforcement patterns | — | Budget enforcement in code (Phase 7) |
| UI (§39–48) | Entire existing Dashboard surface, i18n, styles, controller polling | Add **Runs** tab + `run*` RPC endpoints | Run list/detail views (Phase 1) |

### Storage domains

* `dsh_dashboard` (version 0) — unchanged: catalog projects/repositories/roots/settings.
* **`dsh_projects` (new, version 0)** — DSH Projects orchestration state. Phase 1 tables:
  `runs`, `run_events`. Later phases add `plans`, `tasks`, `memory`, `artifacts`,
  `triggers`, `approvals` (each additive; absent tables initialize empty, so version can
  stay 0 while tables are added; a format change that alters existing records bumps the
  version with a migration).

### Harness APIs used by this plugin (final list)

| API | Phase | Notes |
| --- | --- | --- |
| `ctx.storageDomain.open(spec)` + `KvTable` (incl. atomic `update`) | 1+ | Persistence for all DSH Projects state |
| `ctx.emit` / `ctx.on` | 1+ | High-level run events; `domain/changed` |
| `ctx.agents.create` / `ctx.sessions` / `ctx.agentDefaultModel` / `agentPresets` / `permissionPresets` | 3+ | Coordinator + workers (runner already built) |
| `ctx.subagents` (SubagentRuntime) | 4 | Background research/worker subagents (adapter) |
| `ctx.agentTeams` (TeamService, **experimental**) | 4 | Durable teams + task board (**adapter isolation mandatory**) |
| `ctx.slots` (sidebar footer + shell overlay) | 1+ | All UI stays in the native overlay |
| `ctx.connection.rpc.handle('/dsh-dashboard')` | 1+ | Single trusted-host RPC surface |

### Experimental APIs requiring adapter isolation

* `ctx.agentTeams` → `src/agents/team-runtime-adapter.ts` (Phase 4). Only that file may
  import the experimental surface; the rest of the codebase sees the spec's `TeamRuntime`
  conceptual interface bound to it.
* `ctx.subagents` is stable but still new → thin `BackgroundAgentAdapter` (Phase 4).

### Migration / backward compatibility

* `WORKFLOW.md` v1 parsing is untouched; new config (if any) is additive optional.
* RPC protocol: `DashboardSnapshot.version` stays `2`; the new `runs` section is an
  **optional additive field** — older clients ignore it, new clients tolerate its absence.
  New endpoints (`runCreate`, `runDetail`, `runTransition`) are additive; existing
  endpoints keep their exact behavior.
* Storage: new `dsh_projects` domain, new name — zero interaction with `dsh_dashboard`
  media. No existing record shape changes.

## 5. Phase 1 design — persistent Project Runs

### 5.1 Module layout (follows existing conventions)

```
src/
  runs/
    types.ts           # ProjectRunRecord, ProjectRunEventRecord, views, phase types
    spec.ts            # dsh_projects storage-domain declaration (zod schemas)
    state-machine.ts   # pure transition table + validated transition()
    run-service.ts     # ProjectRunService: storage + events + transitions (single authority)
  rpc/handler.ts       # + runCreate / runDetail / runTransition endpoints
  runtime/types.ts     # DashboardSnapshot.runs (optional additive), RunView types re-exported
  runtime/coordinator.ts# unchanged (runs are sibling to the orchestrator graph)
  client/Dashboard.tsx # + 'runs' tab: RunListView + RunInspector + NewRunDialog
  client/controller.ts # + runCreate / runDetail / runTransition RPC calls
  client/locales.ts    # + runs.* keys (zh + en)
  client/styles.ts     # + run badge/table CSS
  index.ts             # wire ProjectRunService next to ProjectCatalog
tests/
  run-state-machine.test.ts
  run-service.test.ts
  dashboard-runs-interactions.test.tsx
  rpc-handler.test.ts  (extended)
```

### 5.2 Domain model

```ts
type ProjectRunPhase =
  | 'created' | 'planning' | 'awaiting_approval' | 'executing' | 'integrating'
  | 'validating' | 'finalizing' | 'succeeded' | 'failed' | 'canceled'
  | 'paused' | 'blocked'

interface ProjectRunRecord {
  id: string              // randomUUID
  projectId: string       // references catalog ProjectRecord.id
  goal: string
  source: 'manual' | 'tracker' | 'schedule' | 'webhook' | 'repository-event' | 'system'
  sourceRef?: string
  phase: ProjectRunPhase
  /** Phase recorded when the run entered paused/blocked; target of resume/unblock. */
  suspendedFrom?: ProjectRunPhase
  startedAt?: string      // set on first entry into executing (later phases drive this)
  completedAt?: string    // set on terminal entry
  tokenUsage?: TokenTotals
  resultSummary?: string
  error?: string
  createdAt: string
  updatedAt: string
  phaseChangedAt: string
  version: number
}
```

`activePlanId`, `coordinatorSessionId`, `budget` are deliberately **not** in the Phase 1
record: they are owned by Phases 2–3 and adding them then is additive (optional fields on
a strict schema validate against old records). No placeholder fields, no placeholder APIs.

### 5.3 State machine (single authority: `ProjectRunService.transition`)

```
created          → planning | canceled
planning         → awaiting_approval | executing | paused | blocked | failed | canceled
awaiting_approval→ executing | planning | paused | blocked | failed | canceled
executing        → integrating | validating | finalizing | paused | blocked | failed | canceled
integrating      → validating | finalizing | paused | blocked | failed | canceled
validating       → finalizing | executing | paused | blocked | failed | canceled
finalizing       → succeeded | failed | canceled
paused           → suspendedFrom | failed | canceled
blocked          → suspendedFrom | failed | canceled
succeeded / failed / canceled → (terminal)
```

Rules (all in `state-machine.ts`, pure, unit-tested):

* Transition to the current phase is a no-op rejection (idempotency is achieved by
  compare-and-set on `version`, not by silent re-entry).
* Entering `paused`/`blocked` stores `suspendedFrom` (the phase being left); leaving it
  only returns to `suspendedFrom` (or to a terminal state).
* Terminal entry sets `completedAt`; `failed` carries `error`; `succeeded` may carry
  `resultSummary`. Leaving a terminal state is always invalid.
* Every accepted transition bumps `version` and refreshes `updatedAt`/`phaseChangedAt`.

### 5.4 Persistence

* `dsh_projects` domain, version 0, tables `runs` + `run_events`, zod-validated, opened
  once by `ProjectRunService` on startup and closed on disposal.
* Transitions use `KvTable.update(runId, fn)` — the domain's atomic write chain — and
  re-validate `version === expectedVersion` inside the RMW, so concurrent transitions
  cannot corrupt state (spec §57).
* Events are append-only records `{ id, runId, projectId, type, title, detail?, seq, at }`;
  `seq` is per-run monotonic, derived from existing event count at append time (Phase 1
  emits only lifecycle events, so scans stay bounded).

### 5.5 Events

Emit **and** persist (high-level operational/audit stream, spec §28 — no raw session
events):

* `run.created`
* `run.phase.changed` (detail: `planning → executing`)
* `run.completed` (detail: final phase + summary/error)

Cordis emissions: `ctx.emit('dsh-projects/run/created' | 'dsh-projects/run/phase-changed'
| 'dsh-projects/run/completed', { runId, projectId, … })` so other plugins/observers can
react without polling.

### 5.6 RPC surface (additive, trusted-host)

| Endpoint | Input | Output | Notes |
| --- | --- | --- | --- |
| `state` / `refresh` (existing) | — | `DashboardSnapshot` + **optional `runs`** | Project mode: runs of the selected project (newest 50). Global: all runs with project identity (newest 100). |
| `runCreate` | `{ projectId?, goal, sourceRef? }` | snapshot | `projectId` defaults to the selected project (manual runs are project-scoped); rejects unknown projects and empty goals; global mode rejects (runs need a project). |
| `runDetail` | `{ runId }` | `{ run, events (newest 100), truncated }` | — |
| `runTransition` | `{ runId, to, expectedVersion?, detail? }` | snapshot | Validated transition; `failed`/`succeeded` accept optional `resultSummary`/`error`. |

### 5.7 UI

New **Runs** tab (label zh `运行`, en `Runs`) in the existing `DashboardSurface`:

* `RunListView`: compact table — goal (truncated), phase badge, source, started/updated
  (relative time), tokens. Newest first. Bounded to what the snapshot carries.
* `New Run` button (project mode only) → dialog with goal (+ optional source reference).
* Row click → `RunInspector` (same side-panel pattern as `IssueInspector`): goal, phase,
  source, timestamps, token usage, result/error, event timeline, and actions
  Pause/Resume (when applicable) + Cancel (non-terminal).
* Empty state + loading state + error states, consistent with existing views.
* No fake data: everything renders from the real snapshot; fixtures in `fixture.ts` are
  extended with a deterministic runs section for UI tests.

### 5.8 Lifecycle wiring in `src/index.ts`

```ts
const runService = new ProjectRunService(ctx, catalog)
const startup = catalog.start().then(async () => {
  if (disposed) return
  await runService.start()
  await runtime.start()
})
```

Runs are catalog-scoped but **not** orchestrator-scoped: they exist for a project even
when that project's `WORKFLOW.md` is invalid, and they survive restarts because the
domain reloads them at `start()`.

### 5.9 Test plan (Phase 1)

* `run-state-machine.test.ts` — full transition table (every allowed + a representative
  set of forbidden edges), terminal invariants, pause/block round-trips, version bumps,
  `completedAt`/`suspendedFrom` handling.
* `run-service.test.ts` — with the in-memory domain harness: create/list/detail;
  transition happy paths + invalid transition + stale version conflict; project-unknown
  rejection; event append order + seq; **restart persistence** (stop service, new
  service on the same medium, state intact); disposal idempotency.
* `rpc-handler.test.ts` — runCreate validation (empty goal, unknown project, global
  mode), runTransition payload validation, runDetail unknown-run 404-equivalent.
* `dashboard-runs-interactions.test.tsx` — tab renders real runs from the snapshot; new
  run dialog calls `onRunCreate`; inspector shows timeline; cancel/pause call
  `onRunTransition` with the right payload; empty state renders.
* Existing suites must stay green (no regressions).

### 5.10 What Phase 1 explicitly does NOT do

No plans, no coordinator agent, no task DAG, no team/subagent spawning, no memory,
no artifacts, no triggers, no budgets, no approval objects. Those are Phases 2–9 and
each arrives with its own vertical slice. The only forward-looking elements are the
storage domain name (`dsh_projects`) and the record fields that later phases will fill.

## 6. Sequencing (from spec §73, mapped to this codebase)

| Phase | Deliverable | Slice in this repo |
| --- | --- | --- |
| 0 | Baseline + architecture audit | this document |
| **1** | **Project Run foundation** | **`src/runs/*`, RPC + Runs tab (this work)** |
| 2 | Versioned RunPlans | `project_plans` table + `RunPlanService` + plan UI on RunInspector |
| 3 | Coordinator | `CoordinatorService` driving `HarnessAgentRunner`-style Lead sessions, plan creation via structured output |
| 4 | Task DAG + team execution | `ProjectTaskService` (DAG helpers generalized from `scheduling.ts`), `TeamRuntimeAdapter` over `ctx.agentTeams`, `BackgroundAgentAdapter` over `ctx.subagents` |
| 5 | Git isolation + integration | per-task worktrees via `WorkspaceManager`, `dsh/run-<id>/<task>` branches, integration worktree |
| 6 | Project Memory | `project_memory` + retrieval + distillation |
| 7 | Approvals + budgets | `project_approvals` + budget enforcement |
| 8 | Artifacts + final report | `project_artifacts` + report generation |
| 9 | Triggers | TaskSource events → `ProjectTrigger` adapters |
| 10 | Recovery + hardening | startup reconciliation for runs/tasks/agents |
| 11 | UI polish | overview/agent/plan/memory/artifacts/automations pages |
