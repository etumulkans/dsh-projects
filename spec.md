# Spec — Phase 9: Trigger generalization

**Gate:** Design · **Intent:** `intent.md` (Phase 9, commit `0a0b648`) · **Master spec:** `DSH_PROJECTS_SPEC.md` §27 (triggers / automations), §47 (automations page), §62 (existing tracker sources), §63 (project task vs tracker task), PHASE 9 · **Predecessor:** Phase 8 spec (Artifacts + final report, `87d2591`)

## 1. Goal and success

The dashboard can define **triggers** — durable, per-project automation rules that create Project Runs from events. The existing tracker polling is generalized into a `tracker` trigger adapter (the six existing `TaskSource`s — Linear, GitHub, Jira, Asana, GitLab, Local — are *wrapped*, not rewritten); a `schedule` trigger (interval/cron with a computed next-run) and a `webhook` trigger (where the Cordis HTTP surface allows it) are added; `manual` is the unchanged `runCreate` path. Triggers are inspectable and manageable in a new **Automations** UI section (trigger, status, last run, next run, goal template, approval policy; enable/disable), are **idempotent** (the same trigger + the same source event creates at most one run), and **never leak credentials into the browser**.

Success: the `project_triggers` table + `ProjectTriggerService` store and fire durable trigger rules; the `TriggerAdapter` seam has a working `tracker` adapter (over the existing `TaskSource` registry), a `schedule` adapter (deterministic under a fake clock), and a `webhook` adapter (where feasible); a fire renders the `goalTemplate`, creates a run via `ProjectRunService.createRun` (the trigger's `approvalMode` + `source`/`sourceRef`), and is idempotent across duplicate events and process restarts; the Dashboard shows the project's triggers (the Automations section) with enable/disable + Run now; `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green (modulo the documented pre-existing environment failures).

## 2. Invariants (from `intent.md` §3)

1. **No invented APIs.** Only native Harness/Cordis/Agent-Teams/subagent/storage primitives as installed. The adapters use only the existing `TaskSource` seam, the existing Git-workspace observation, and the Cordis HTTP surface as installed.
2. **No placeholder APIs, no fake UI data.** Every RPC, service method, and UI control is backed by real behavior; a fire creates a real run via `ProjectRunService.createRun` (no fabricated runs, no fake "last run").
3. **No premature phases.** No new run phases; no external webhook *provider* SDKs (master spec §27 — the `webhook` adapter is the internal abstraction only); no recovery of in-flight trigger state beyond the idempotency guarantee (Phase 10); no full Automations *page* polish (Phase 11).
4. **Preserve existing behavior.** The existing orchestrator poll/dispatch (the old dashboard agent-dispatch path), the Phase 5 completion pipeline, the Phase 6 memory distillation, the Phase 7 approval/budget flow, and the Phase 8 artifact/report pipeline keep working exactly as today — Phase 9 adds a trigger store + adapters + a fire path *beside* them, not a replacement. The existing `runCreate` (the `manual` trigger) is unchanged.
5. **Extend the native Dashboard UI** (one frontend, existing slots).
6. **State in code + persistent storage** (`dsh_projects` domain, format version stays 0).
7. **Repo stays buildable and testable** at every commit.

## 3. Storage (additive, domain stays v0)

### 3.1 `project_triggers` table (new)

Declared in `dshProjectsDomainSpec` (the domain version stays 0 — storage-domain initializes absent declared tables as empty, per the Phase 2/4/6/7/8 precedent):

```ts
export const TRIGGER_TYPES = [
  'manual', 'tracker', 'schedule', 'webhook', 'repository-event', 'pr-event', 'system',
] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]
export type TriggerId = string

export interface ProjectTriggerRecord {
  readonly id: TriggerId             // uuid
  readonly projectId: ProjectId
  readonly type: TriggerType
  readonly enabled: boolean
  readonly config: Record<string, unknown>   // per-type payload (§3.3), credential-free
  readonly goalTemplate: string            // 1..500 chars, {{placeholder}} tokens
  readonly approvalMode?: ApprovalMode     // the per-trigger approval policy (Phase 7)
  readonly lastFiredAt?: string            // ISO; set by the fire path
  readonly lastRunId?: RunId               // the run the last fire created
  readonly createdAt: string               // ISO
  readonly updatedAt: string               // ISO
}
```

Strict zod schema (`projectTriggerRecordSchema`) in `src/triggers/spec.ts`;
`goalTemplate` is `nonBlank` with a 500-char cap (`z.string().trim().min(1).max(500)`);
`config` is `z.record(z.string(), z.unknown())` (the per-type shape is validated by the
service, not the table — the same pattern as the approval `payload` and the artifact
`metadata`); `approvalMode` is the Phase 7 `ApprovalMode` enum
(`z.enum(['manual','plan','guarded','autonomous']).optional()`);
`lastFiredAt`/`lastRunId`/`createdAt`/`updatedAt` are timestamps.

**Mutable (unlike artifacts):** a trigger is a *rule the user edits* — it has an
`updatedAt` and the service exposes `update`/`setEnabled`/`delete` (§5.2). The
`lastFiredAt`/`lastRunId` are set by the fire path (the service is the single
authority that writes them). The `manual` type is **never persisted** — it is the
implicit `runCreate` path (§3.2); a `manual` trigger create is rejected
(`trigger.manualReserved`).

### 3.2 The `ProjectRunSource` alignment

The run record already carries `source: ProjectRunSource` + `sourceRef?: string`
(`src/runs/types.ts`). The trigger `type` union (`TRIGGER_TYPES`) is a **superset**
of `ProjectRunSource` (it adds `pr-event`, split out per master spec §27). When a
trigger fires, the created run's `source` is the trigger's `type` mapped into
`ProjectRunSource` (`pr-event` → `repository-event`, the closest existing source;
the others map 1:1), and `sourceRef` is the **trigger id** (the provenance the Runs
UI already shows). No change to the `runs` table or the `ProjectRunSource` union —
the mapping lives in the fire path (§5.3).

### 3.3 Per-type `config` (validated by the service, not the table)

`config` is the trigger-type-specific payload, validated by the pure
`validateTrigger` (§5.4). It is **credential-free** (a secret is a *ref*, never a
value — §9.4):

- **`tracker`:** `{ sourceKind: 'linear'|'github'|'jira'|'asana'|'gitlab'|'local', readyStates: string[] }` — the `TaskSource` kind to wrap + the issue states that are "ready" to fire (the trigger fires when an issue enters one of `readyStates`). `readyStates` is non-empty.
- **`schedule`:** `{ everyMs?: number, cron?: string, timezone?: string }` — an interval (`everyMs`, ≥ 1000) **or** a cron expression (`cron`), not both; `timezone` is an optional IANA name (defaults to the host tz). Exactly one of `everyMs`/`cron` is set.
- **`webhook`:** `{ path: string, secretRef: string }` — the HTTP path to receive on (relative, non-empty) + a credential *ref* (never the secret value).
- **`repository-event` / `pr-event`:** `{ event: string }` — the Git-integration event name to react to (e.g. `pr.opened`); the minimal real path (§5.5).
- **`system`:** `{ event: string }` — the internal Cordis event name to react to (e.g. `dsh-projects/run/completed`).

### 3.4 Run event type (additive — one)

```
'trigger.fired'   // a trigger created a run (detail: `<type> trigger <id> → run <runId>`)
```

Added to `RUN_EVENT_TYPES` (`src/runs/spec.ts`) and the `ProjectRunEventType`
union (`src/runs/types.ts`). The fire path appends it to the **created run's**
per-run `seq` (the existing `appendRunEvent` pattern) so the run's event stream
records its provenance. It is emitted only for a run that was actually created
(a deduped fire — §5.3 — emits no event).

## 4. Idempotency (master spec PHASE 9: "Ensure idempotency")

The core guarantee: **the same `(triggerId, sourceEventKey)` creates at most one
run** — a duplicate event or a process restart does not double-create a run.

### 4.1 The dedupe key

Each `TriggerEvent` (§5.5) carries a stable `sourceEventKey`:
- **`tracker`:** `<sourceKind>:<nativeRef>:<state>` (the issue's native ref + the
  ready state it entered — the same issue re-entering the same state is the same
  event; a different state is a different event).
- **`schedule`:** the **fired slot** — for `everyMs`, the computed slot index
  (`floor(fireAt / everyMs)`); for `cron`, the scheduled slot timestamp. A
  restart recomputes the same slot, so it does not re-fire.
- **`webhook`:** the payload's stable id (the provider's event id, or a hash of the
  signed payload when absent).
- **`repository-event` / `pr-event` / `system`:** the event's stable id (the PR
  number / the Cordis event id).

### 4.2 The dedupe record (the `trigger_fires` table, additive — one)

A second new declared table `trigger_fires` (the 9th table; the set grows by
exactly two):

```ts
export interface TriggerFireRecord {
  readonly id: string               // = `${triggerId}:${sourceEventKey}` (deterministic)
  readonly triggerId: TriggerId
  readonly sourceEventKey: string
  readonly runId: RunId             // the run this fire created
  readonly firedAt: string          // ISO
}
```

Strict zod schema (`triggerFireRecordSchema`) in `src/triggers/spec.ts`. The fire
path (§5.3) does a **check-then-put** on the deterministic id
(`${triggerId}:${sourceEventKey}`): if a `TriggerFireRecord` already exists → the
fire is a no-op (returns the existing run, emits no event, changes no
`lastFiredAt`); otherwise it creates the run, persists the fire record, and
updates the trigger's `lastFiredAt`/`lastRunId`. The deterministic id makes the
dedupe **restart-safe** (the record survives a reopen; a restarted process sees the
existing record and no-ops).

### 4.3 `manual` is non-idempotent (by design)

The `manual` trigger (the `runCreate` path) is **explicitly non-idempotent** — each
call is a new run (the user's explicit intent). Idempotency applies only to the
*automated* adapters (the ones that can receive duplicate / re-delivered events).

## 5. Trigger service — `src/triggers/trigger-service.ts`

### 5.1 Service shape

`ProjectTriggerService` (host-only; the client never imports it — the Phase 6/7/8
isolation invariant extends: a new scan asserts no `src/client/**` file imports
`src/triggers/**`):

```ts
constructor(ctx: Context, catalog: ProjectCatalog, runService: ProjectRunService, sources: ScopedTaskSourceRegistry, clock?: () => string)
start(): Promise<void>   // borrows the shared dsh_projects tables (requires runService started)
stop(): Promise<void>
```

Borrows the `project_triggers` + `trigger_fires` tables from the shared domain
(the same borrow pattern as `ProjectArtifactService` — `start()` after
`runService.start()`, `stop()` before `runService.stop()` in `index.ts`). It also
borrows `runs`/`run_events` (the fire path reads the run it creates + appends the
`trigger.fired` event). It holds the `ScopedTaskSourceRegistry` (the tracker
adapter's read-side seam, §5.5) and a `clock` (the schedule adapter's deterministic
time source, defaulting to `() => new Date().toISOString()`).

### 5.2 Create / list / get / update / setEnabled / delete

```ts
/** Persist a new trigger. Validates type + per-type config + goalTemplate (§5.4).
 *  `manual` is rejected (trigger.manualReserved — it is the implicit runCreate path). */
async create(input: TriggerCreateInput): Promise<ProjectTriggerRecord>

/** List triggers (newest first). */
list(projectId: string): ProjectTriggerRecord[]

/** The full record for the detail view. */
get(id: TriggerId): ProjectTriggerRecord | undefined

/** Update the goal template / config / approval mode (not the enabled flag — use setEnabled). */
async update(id: TriggerId, patch: TriggerUpdateInput): Promise<ProjectTriggerRecord>

/** The only state toggle the UI drives. */
async setEnabled(id: TriggerId, enabled: boolean): Promise<ProjectTriggerRecord>

/** Delete a trigger (its fire records are kept — the provenance of created runs). */
async delete(id: TriggerId): Promise<void>
```

- **Create** validates via the pure `validateTrigger` (§5.4), persists the record
  (a `put`), and emits a Cordis event (`dsh-projects/trigger/created`).
- **List** is synchronous (Map-backed) and newest-first (`createdAt` descending, id
  tiebreak — the Phase 7 deterministic-ordering pattern).
- **Get** returns the record or `undefined` (the RPC maps `undefined` →
  `trigger.unknown`).
- **Update** re-validates the patched `config`/`goalTemplate`/`approvalMode` (a
  patch that would make the config invalid is rejected); bumps `updatedAt`.
- **setEnabled** flips `enabled`; bumps `updatedAt`. A disabled trigger's adapters
  do not fire (§5.5).
- **Delete** removes the trigger row (the `trigger_fires` rows are **kept** — they
  are the provenance of the runs already created; deleting them would orphan the
  run's `sourceRef`).

### 5.3 Fire (the idempotent run-creation path)

```ts
/** Fire one trigger for one event. Idempotent (§4): the same
 *  (triggerId, sourceEventKey) creates at most one run. Returns the created (or
 *  already-created) run. A disabled trigger is a no-op (returns undefined). */
async fire(triggerId: TriggerId, event: TriggerEvent): Promise<ProjectRunRecord | undefined>
```

1. Read the trigger; if absent → `trigger.unknown`; if **disabled** → no-op
   (return `undefined`, no event).
2. Compute the dedupe id `${triggerId}:${event.sourceEventKey}`; if a
   `TriggerFireRecord` exists → return the existing run (no-op, no event).
3. **Render the goal:** `renderGoalTemplate(trigger.goalTemplate, event.data)` —
   replace each `{{placeholder}}` with the event's data value (an absent
   placeholder renders as the empty string; the rendered goal must be non-empty
   after trimming — an all-placeholder template with no data is
   `trigger.goalEmpty`). The goal is bounded to the existing `MAX_GOAL_LENGTH`
   (a longer render is `trigger.goalTooLong`).
4. **Create the run** via `runService.createRun({ goal: <rendered>, projectId:
   trigger.projectId, source: <mapped type>, sourceRef: trigger.id,
   approvalMode: trigger.approvalMode }, selection)`.
5. Persist the `TriggerFireRecord` (the deterministic id).
6. Update the trigger's `lastFiredAt`/`lastRunId` (bump `updatedAt`).
7. Append the `trigger.fired` run event to the created run + emit the Cordis event
   (`dsh-projects/trigger/fired`).
8. On any failure (the run create threw, e.g. an unknown project): a warn log + no
   fire record + no run (the trigger is left unchanged; the event may be retried).

### 5.4 Pure validation (exported for tests)

```ts
export type TriggerInvalidReason =
  | 'unknown-type' | 'manual-reserved' | 'empty-goal-template' | 'goal-template-too-long'
  | 'invalid-config' | 'contains-secrets'

export function validateTrigger(input: TriggerCreateInput): {
  readonly type: TriggerType
  readonly config: Record<string, unknown>
  readonly goalTemplate: string
  readonly approvalMode?: ApprovalMode
}  // throws trigger.* errors
```

Enforces: the `type` is a known `TRIGGER_TYPES` member (not `manual`); the
`goalTemplate` is non-empty (1..500); the per-type `config` is valid (§3.3 — the
right keys, the right shapes, the exactly-one-of for schedule); the
`approvalMode` (when present) is a known `ApprovalMode`; and a secrets scan (the
Phase 6 `SECRET_PATTERNS` — a `config`/`goalTemplate` containing what looks like a
secret is `trigger.containsSecrets`; a webhook `secretRef` is a *ref* and is
allowed, but a raw secret value is not). No semantic judgment beyond the hard
limits.

### 5.5 The `TriggerAdapter` seam + the adapters

```ts
export interface TriggerEvent {
  readonly sourceEventKey: string   // the stable dedupe key (§4.1)
  readonly data: Record<string, string>  // the {{placeholder}} values
}

export interface TriggerAdapter {
  readonly type: TriggerType
  /** Poll the source for new events (the tracker/schedule adapters). */
  poll?(trigger: ProjectTriggerRecord, ctx: TriggerAdapterContext): Promise<readonly TriggerEvent[]>
  /** React to a pushed event (the webhook/repository/pr/system adapters). */
  onEvent?(trigger: ProjectTriggerRecord, event: TriggerEvent): void
}
```

`TriggerAdapterContext` gives the adapter the `ScopedTaskSourceRegistry`, the
`clock`, the `fire` callback, and the `ctx` (for `ctx.on`/`ctx.emit`). One adapter
per type:

- **`tracker`** — wraps the existing `TaskSource` registry (no rewrite). `poll`
  resolves the trigger's `config.sourceKind` via `sources.requireScoped(projectId,
  sourceKind)`, calls `listIssuesByStates(config.readyStates)`, and yields one
  `TriggerEvent` per issue in a ready state (`sourceEventKey:
  <sourceKind>:<nativeRef>:<state>`, `data: { 'issue.key': identifier,
  'issue.title': title, 'issue.state': state, 'issue.url': url ?? '' }`). The
  **existing polling cadence is preserved** — the adapter is driven by the same
  poll loop the orchestrator uses (the service exposes a `pollDueTriggers()` the
  poll loop calls; no new poller). It does **not** dispatch agents (the old
  orchestrator path is unchanged) — it only yields events that create runs.
- **`schedule`** — the schedule abstraction. `poll` computes the current slot from
  `config` + `trigger.lastFiredAt` + the `clock`: for `everyMs`, the next slot is
  `lastFiredAt + everyMs` (or `createdAt + everyMs` if never fired); for `cron`,
  the next scheduled slot. If `now >= nextSlot`, it yields one `TriggerEvent`
  (`sourceEventKey: <slot index or timestamp>`, `data: { 'schedule.at': <slot ISO> }`).
  **Deterministic under a fake clock** (the tests drive the `clock`).
- **`webhook`** — where feasible: the Cordis plugin's existing HTTP surface
  (not a new server) maps a signed payload on `config.path` to a `TriggerEvent`
  (`sourceEventKey: <payload id or hash>`, `data: { 'webhook.id': id, 'webhook.type':
  type }`). The `secretRef` is resolved host-side (never returned to the browser).
  If the Cordis HTTP surface does not expose a receive hook in the installed
  profile, the adapter is the **internal abstraction only** (the `onEvent` path is
  real and testable via a direct call; the HTTP receive is wired where available)
  — master spec §27: "Do not build all external webhook providers before the
  internal abstraction is correct."
- **`repository-event` / `pr-event`** — the minimal real path: `onEvent` reacts to
  the Git-integration event (the existing `run.integration.*` / PR observation) and
  yields a `TriggerEvent` (`sourceEventKey: <pr number>`, `data: { 'pr.number': n,
  'pr.title': title }`). No external provider SDKs.
- **`system`** — `onEvent` reacts to an internal Cordis event (`config.event`, e.g.
  `dsh-projects/run/completed`) via `ctx.on`; yields a `TriggerEvent`
  (`sourceEventKey: <event id>`, `data: { 'system.event': name }`).

**No invented APIs:** the adapters use only the existing `TaskSource` seam, the
existing Git-workspace observation, the Cordis `ctx.on`/HTTP surface, and the
`clock` — nothing speculatively imported.

### 5.6 The poll loop integration

The service exposes `pollDueTriggers(): Promise<void>` — it iterates the
project's **enabled** `tracker` + `schedule` triggers, calls each adapter's
`poll`, and fires the yielded events (via `fire`, §5.3). The existing orchestrator
poll loop (or a new lightweight tick in `index.ts`) calls it on the existing
cadence. The `webhook`/`repository-event`/`pr-event`/`system` adapters are
push-based (`onEvent`) and are wired to their sources in `start()` (the `ctx.on`
listeners); they do not participate in the poll loop. A **disabled** trigger is
skipped by `pollDueTriggers` (and its `onEvent` listeners no-op).

## 6. RPC (additive, the established pattern)

`handleDashboardRpc` gains a 13th param `triggers?` (the
`ProjectTriggerService`, the same pattern as the 12th `artifacts?`):

- **`triggerList`** — `{ projectId }` → `{ triggers: ProjectTriggerRecord[] }` (newest first; the credential-free `config` projection, §9.4).
- **`triggerCreate`** — `{ projectId, type, config, goalTemplate, approvalMode? }` → the created record. Structured errors: `trigger.invalidCandidate` (the §5.4 reasons, `params: { reason, … }`), `trigger.manualReserved` (a `manual` type), `trigger.containsSecrets`.
- **`triggerGet`** — `{ id }` → the record (credential-free `config`). `trigger.unknown` (no such id).
- **`triggerUpdate`** — `{ id, goalTemplate?, config?, approvalMode? }` → the updated record. `trigger.unknown`, `trigger.invalidCandidate`.
- **`triggerSetEnabled`** — `{ id, enabled }` → the updated record. `trigger.unknown`.
- **`triggerDelete`** — `{ id }` → `{ ok: true }`. `trigger.unknown`.
- **`triggerFire`** — `{ id, event? }` → the created run (or the existing run on a dedupe). `trigger.unknown`, `trigger.disabled` (a disabled trigger), `trigger.goalEmpty`, `trigger.goalTooLong`. (The `event` is optional — a `triggerFire` without an event fires a synthetic "manual fire" event for the UI's "Run now" affordance, `sourceEventKey: 'manual:<uuid>'` — so "Run now" is **not** idempotent, matching the explicit-intent semantics.)
- **`runDetail`** (extended) — when the triggers service is mounted, the detail gains `trigger?: ProjectTriggerRecord` (the run's originating trigger, resolved from `sourceRef`, when the `source` is an automated type) — the on-demand pattern (not a snapshot projection; `DashboardSnapshot.version` stays 2).

Absent-service failures follow the Phase 6/7/8 pattern: `badRequest('<endpoint> is
unavailable: the Trigger service is not mounted')`.

## 7. Error codes (new)

`src/runtime/errors.ts` (host) + `src/client/errors.ts` (mapping, the `params`
envelope field — not `args`):

```
trigger.notStarted          // the service is not started
trigger.unknown             // no such trigger id
trigger.badRequest          // triggerList with no projectId
trigger.invalidCandidate    // the §5.4 validation failure (params: reason, …)
trigger.manualReserved      // a manual trigger create (the implicit runCreate path)
trigger.containsSecrets     // the secrets scan matched (params: reason)
trigger.disabled            // triggerFire on a disabled trigger
trigger.goalEmpty           // the rendered goal is empty (params: template)
trigger.goalTooLong         // the rendered goal exceeds MAX_GOAL_LENGTH (params: maxLength)
```

## 8. UI (existing Dashboard, zh/en parity compile-enforced)

### 8.1 Automations section (a new project-level tab)

A new **Automations** tab in the Dashboard (the Phase 6 Memory-tab / Phase 8
Artifacts-tab pattern; `Tab` gains `'automations'`):

- The project's triggers (newest first), each row: **Trigger** (the type label + a
  short config summary, e.g. "tracker · linear · ready: In Progress"), **Status**
  (enabled/paused — the `enabled` flag), **Last run** (`lastFiredAt` + the linked
  run id, clickable to the run), **Next run** (the schedule's `nextRunAt`, when the
  type is `schedule`; "—" otherwise), **Goal template**, **Approval policy**
  (the `approvalMode` label).
- **Enable/disable** drives `triggerSetEnabled` (a toggle per row; busy gating +
  the inline error banner per the existing conventions).
- A **Run now** affordance per row drives `triggerFire` (the explicit-intent fire;
  a confirmation is not required — it is a single run).
- An **Add trigger** dialog (type select + per-type config fields + goal template +
  approval mode select) dispatches `triggerCreate`.
- A **detail view** for a trigger: the full `config` (credential-free), the
  `goalTemplate`, the `lastFiredAt`/`lastRunId`, and the trigger's created runs
  (the runs whose `sourceRef === trigger.id`).

### 8.2 The credential-free `config` projection

The `config` returned to the client is the **credential-free** projection: a
`webhook` `secretRef` is returned as a ref (e.g. `"secret:webhook-<id>"`), never a
value; a `tracker` `config` returns the `sourceKind` + `readyStates` (no
credentials — the credentials live in the Host's `ctx.credentials`, never in the
trigger record). The client never sees a secret value (§9.4).

### 8.3 Locale keys (zh/en parity compile-enforced)

New keys under the `dsh-dashboard` namespace (the `t` key union — the
`en satisfies Record<DashboardLocaleKey, string>` parity check):
`automations` (自动化 / Automations), `trigger.type.manual` (手动 / Manual),
`trigger.type.tracker` (跟踪源 / Tracker), `trigger.type.schedule` (计划 / Schedule),
`trigger.type.webhook` (Webhook), `trigger.type.repository-event` (仓库事件 / Repository event),
`trigger.type.pr-event` (PR 事件 / PR event), `trigger.type.system` (系统事件 / System event),
`trigger.status.enabled` (已启用 / Enabled), `trigger.status.paused` (已暂停 / Paused),
`trigger.lastRun` (上次运行 / Last run), `trigger.nextRun` (下次运行 / Next run),
`trigger.goalTemplate` (目标模板 / Goal template), `trigger.approvalPolicy` (审批策略 / Approval policy),
`trigger.add` (添加触发器 / Add trigger), `trigger.runNow` (立即运行 / Run now),
`trigger.enable` (启用 / Enable), `trigger.disable` (暂停 / Pause),
`trigger.delete` (删除 / Delete), `trigger.config` (配置 / Config),
`trigger.empty` (暂无触发器 / No triggers), `trigger.never` (从未 / Never).

## 9. Module layout & wiring

```
src/triggers/
  types.ts            # TRIGGER_TYPES, TriggerType, TriggerId, ProjectTriggerRecord, TriggerFireRecord,
                      #   TriggerCreateInput, TriggerUpdateInput, TriggerEvent, TriggerAdapter, TriggerAdapterContext
  spec.ts             # projectTriggerRecordSchema + triggerFireRecordSchema (strict zod), MAX_GOAL_TEMPLATE_LENGTH
  trigger-service.ts  # ProjectTriggerService (CRUD + setEnabled + delete + fire + pollDueTriggers + validateTrigger)
  adapters/
    index.ts          # the adapter registry (type → adapter)
    tracker.ts        # the tracker adapter (over the ScopedTaskSourceRegistry)
    schedule.ts       # the schedule adapter (the nextRunAt computation, deterministic under a fake clock)
    webhook.ts        # the webhook adapter (the Cordis HTTP surface, where feasible)
    git-event.ts      # the repository-event / pr-event adapter (the minimal Git-integration path)
    system.ts         # the system adapter (the ctx.on path)
  goal-template.ts    # renderGoalTemplate (the pure {{placeholder}} renderer)
src/runs/
  spec.ts             # + the project_triggers + trigger_fires tables, + the trigger.fired event
  types.ts            # + the trigger.fired run event type, + RunDetailView.trigger
src/rpc/
  handler.ts          # + the triggers param; triggerList/triggerCreate/triggerGet/triggerUpdate/triggerSetEnabled/triggerDelete/triggerFire; runDetail trigger
src/runtime/
  errors.ts           # + the trigger.* codes
src/client/
  controller.ts       # + the client mirror types (ClientTriggerType, TriggerView, etc. — the client never imports src/triggers/**)
  errors.ts           # + the client error mappings
  Dashboard.tsx       # + the Automations tab, the Add trigger dialog, the enable/disable + Run now affordances
  locales.ts          # + the zh/en keys (§8.3)
src/index.ts          # + the ProjectTriggerService wiring (start/stop, the adapter onEvent listeners, the pollDueTriggers tick, the RPC param)
tests/
  trigger-service.test.ts    # new — the store, the CRUD, the per-type config validation, the secrets scan
  trigger-fire.test.ts       # new — the idempotent fire (the dedupe, the duplicate event, the restart), the goal render, the run creation
  trigger-adapters.test.ts   # new — the tracker adapter (over a fake TaskSource), the schedule adapter (fake clock), the webhook/system onEvent
  rpc-handler.test.ts        # extended — the seven endpoints + runDetail trigger
  dashboard-automations.test.tsx # new — the Automations tab + the Add dialog + enable/disable + Run now (zh + en)
  run-storage-integration.test.ts # extended — the table set (+2) + the triggers/fires survive a reopen
  client-triggers-isolation.test.ts # new — no src/client/** imports src/triggers/**
```

**Wiring in `index.ts`** (the order matters — the trigger service borrows the
shared domain, so it starts after `runService.start()` and stops before
`runService.stop()`, like the memory/approval/artifact services):

```ts
const triggerService = new ProjectTriggerService(ctx, catalog, runService, scopedSources)
// … after runService.start():
await triggerService.start()   // registers the onEvent listeners (webhook/system/git)
// … the existing poll loop (or a new tick) calls triggerService.pollDueTriggers()
// … handleDashboardRpc(…, artifactService, triggerService)
// … before runService.stop():
await triggerService.stop()
```

## 10. Test plan

### 10.1 `tests/trigger-service.test.ts` (new)

- **Store:** create persists (the table, the Cordis event); the 7 types validate
  (not `manual`); the `goalTemplate` bounds (1..500); the per-type `config`
  validates (the right keys/shapes; the exactly-one-of for schedule); the
  `approvalMode` validates; project-scoped.
- **CRUD:** list (newest-first, the deterministic ordering); get (known → the
  record; unknown → `undefined`); update (re-validates the patched config; bumps
  `updatedAt`); setEnabled (flips `enabled`; bumps `updatedAt`); delete (removes
  the trigger row; keeps the `trigger_fires` rows).
- **`manual` reserved:** a `manual` create → `trigger.manualReserved`.
- **Secrets:** a `config`/`goalTemplate` containing what looks like a secret →
  `trigger.containsSecrets` (the Phase 6 patterns); a webhook `secretRef` (a ref)
  is allowed.
- **Absent-service:** the service-not-started path → `trigger.notStarted`.

### 10.2 `tests/trigger-fire.test.ts` (new)

- **The fire:** a `tracker` event fires a run (the `goalTemplate` rendered with the
  event data; the run's `source`/`sourceRef` = the trigger's mapped type/id; the
  trigger's `approvalMode` applied); the `trigger.fired` run event appended to the
  created run; the `lastFiredAt`/`lastRunId` set.
- **Idempotency (the core guarantee):** the same `(triggerId, sourceEventKey)`
  fires **once** — a duplicate event is a no-op (returns the existing run, no
  second run, no second `trigger.fired` event, `lastFiredAt` unchanged); a process
  restart (the `trigger_fires` record survives a reopen) does not re-fire.
- **Disabled:** a disabled trigger's fire is a no-op (returns `undefined`, no run,
  no event).
- **Goal render:** an absent `{{placeholder}}` renders as the empty string; an
  all-placeholder template with no data → `trigger.goalEmpty`; a render longer than
  `MAX_GOAL_LENGTH` → `trigger.goalTooLong`.
- **The failure:** a fire where the run create throws (e.g. an unknown project) →
  a warn log + no fire record + no run (the trigger unchanged; the event may be
  retried).
- **`manual` (Run now):** a `triggerFire` without an event creates a new run each
  call (non-idempotent — the explicit-intent semantics).

### 10.3 `tests/trigger-adapters.test.ts` (new)

- **The tracker adapter:** over a fake `TaskSource` (a `listIssuesByStates` that
  returns issues in ready states), `poll` yields one `TriggerEvent` per ready issue
  (the `sourceEventKey` = `<sourceKind>:<nativeRef>:<state>`; the `data` = the
  issue's key/title/state/url); an issue not in a ready state yields no event; the
  existing `TaskSource` is **not** rewritten (the adapter only reads it).
- **The schedule adapter:** under a fake clock, `everyMs` fires on the next slot
  (deterministic — the same clock + config + `lastFiredAt` → the same slot); a
  restart does not re-fire (the slot is recomputed from the persisted
  `lastFiredAt`); `cron` fires on the scheduled slot; a not-yet-due schedule yields
  no event.
- **The webhook adapter:** the `onEvent` path maps a signed payload to a
  `TriggerEvent` (the `sourceEventKey` = the payload id/hash; the `secretRef` is
  resolved host-side, never exposed).
- **The system adapter:** the `onEvent` path (a `ctx.on` listener) reacts to the
  internal event and yields a `TriggerEvent`.
- **The git-event adapter:** the `onEvent` path reacts to the Git-integration event
  and yields a `TriggerEvent` (the `sourceEventKey` = the PR number).

### 10.4 `tests/rpc-handler.test.ts` (extended)

- `triggerList` (per project; the credential-free `config` projection; absent
  `projectId` → bad-request).
- `triggerCreate` (valid; the §5.4 reasons → `trigger.invalidCandidate` with
  `params`; `manualReserved`; `containsSecrets`).
- `triggerGet` (valid; unknown → `trigger.unknown`).
- `triggerUpdate` (valid; unknown → `trigger.unknown`; an invalid patch →
  `trigger.invalidCandidate`).
- `triggerSetEnabled` (valid; unknown → `trigger.unknown`).
- `triggerDelete` (valid; unknown → `trigger.unknown`).
- `triggerFire` (valid → the created run; a dedupe → the existing run; unknown →
  `trigger.unknown`; disabled → `trigger.disabled`; an empty render →
  `trigger.goalEmpty`).
- `runDetail` (the `trigger` when the service is mounted + the run's `sourceRef`
  resolves to a trigger; absent when not).
- Absent-service failures (the seven endpoints → the structured not-mounted
  bad-requests).

### 10.5 `tests/dashboard-automations.test.tsx` (new, jsdom)

- The Automations tab renders the project's triggers (the type label + config
  summary, the status, the last run, the next run, the goal template, the approval
  policy); an empty project renders the "no triggers" marker; zh + en.
- The enable/disable toggle dispatches `triggerSetEnabled` with busy gating + the
  inline error banner; the Run now affordance dispatches `triggerFire`; the Add
  trigger dialog dispatches `triggerCreate` (the type select + the per-type config
  fields + the goal template + the approval mode); the detail view renders the
  credential-free `config` + the trigger's created runs; zh + en.

### 10.6 `tests/run-storage-integration.test.ts` (extended)

- The table set is exactly `['memory', 'plans', 'project_approvals',
  'project_artifacts', 'project_triggers', 'run_events', 'runs', 'tasks',
  'trigger_fires']` (the two new tables).
- The `project_triggers` + `trigger_fires` records survive a real JSON domain
  reopen (zod-validated).
- The `trigger.fired` run event survives the reopen.
- The domain stays v0.

### 10.7 `tests/client-triggers-isolation.test.ts` (new)

- No file under `src/client/**` imports `src/triggers/**` (the client carries its
  own mirror types in `controller.ts`).

## 11. Acceptance criteria (maps to `intent.md` §6.8)

1. **Store** — `project_triggers` (+ `trigger_fires`) are declared tables of
   `dsh_projects` (v0, no migration); records validate against the strict schema
   (7 types, per-type `config`, bounded `goalTemplate`); the table set grows by
   exactly two tables.
2. **Adapters** — the `tracker` adapter wraps the six existing `TaskSource`s (no
   rewrite) and yields a `TriggerEvent` on a ready-state issue; the `schedule`
   adapter computes the next slot and fires on it (deterministic under a fake
   clock); the `webhook` adapter maps a signed payload to a `TriggerEvent` (where
   the Cordis HTTP surface allows it); the `system`/`repository-event`/`pr-event`
   adapters are the minimal real `onEvent` path; `manual` is the unchanged
   `runCreate` path.
3. **Idempotency** — the same `(triggerId, sourceEventKey)` creates at most one
   run (verified across a duplicate event and a process restart); a disabled
   trigger does not fire; the `schedule` adapter does not re-fire after a restart.
4. **Fire** — `fire` renders the `goalTemplate` with the event, creates a run via
   `ProjectRunService.createRun` (the trigger's `approvalMode` + `source`/
   `sourceRef`), persists the `trigger_fires` dedupe record, records
   `lastFiredAt`/`lastRunId`, and appends the `trigger.fired` run event; the run is
   inspectable in the existing Runs UI.
5. **UI** — the Automations tab renders trigger/status/last-run/next-run/
   goal-template/approval-policy (zh/en); enable/disable + Run now dispatch the
   real RPCs; the Add trigger dialog dispatches `triggerCreate`; the detail view
   renders the credential-free `config`; no credential value is ever returned to
   the browser.
6. **RPC** — `triggerList`/`triggerCreate`/`triggerGet`/`triggerUpdate`/
   `triggerSetEnabled`/`triggerDelete`/`triggerFire` dispatch with validation;
   absent-service structured failures; the new `trigger.*` error codes (with
   `params`).
7. **Repo green** — `pnpm run typecheck`, `pnpm run build`, full `pnpm vitest run`
   (modulo the documented pre-existing environment failures).

## 12. Explicit non-goals (Phase 10+)

- No external webhook **provider** SDKs (GitHub/GitLab/Lark webhooks) — the
  `webhook` adapter is the internal abstraction only (master spec §27).
- No full Automations **page** polish (Phase 11) — this phase ships the working
  tab, not the finished page.
- No **recovery of in-flight trigger state** across a crash beyond the idempotency
  guarantee (Phase 10) — a fire is atomic (check-then-put); a crash mid-fire is
  resolved by the dedupe on restart (no double-create), not by a recovery pass.
- No **trigger versioning** (a trigger is a mutable rule — `update`/`setEnabled`/
  `delete`; no version history).
- No **trigger search** beyond the project list (a full-text search over trigger
  configs is a Phase 11 UI-polish concern).
- No **approval objects for trigger writes** (triggers are user-managed rules; the
  per-trigger `approvalMode` gates the *runs* they create, not the trigger edits).
- No `DashboardSnapshot` version change; triggers are on-demand RPC data (the
  `runDetail` pattern), not snapshot projections.
- No change to the **existing orchestrator poll/dispatch** (the old dashboard
  agent-dispatch path is unchanged — the `tracker` adapter is a new consumer of
  the `TaskSource` read-side that creates runs, not a replacement for the
  dispatch).

## 13. Sequencing (build order)

1. **Storage:** the `project_triggers` + `trigger_fires` tables + schemas
   (`src/triggers/spec.ts`, `types.ts`); the `trigger.fired` run event type in
   `src/runs/spec.ts` + `types.ts`; the `RunDetailView.trigger` extension.
2. **Validation + goal render:** `MAX_GOAL_TEMPLATE_LENGTH` + the pure
   `validateTrigger` (§5.4) + the secrets scan (reused from the Phase 6 memory
   patterns) + the pure `renderGoalTemplate` (§5.3).
3. **Service:** `trigger-service.ts` (CRUD + `setEnabled` + `delete` + `fire` +
   `pollDueTriggers` + the `trigger.fired` event projection).
4. **Adapters:** `adapters/` (the tracker over the `ScopedTaskSourceRegistry`, the
   schedule with the next-slot computation, the webhook over the Cordis HTTP
   surface, the git-event + system `onEvent` paths) + the adapter registry.
5. **RPC:** the `triggers` param on `handleDashboardRpc`;
   `triggerList` / `triggerCreate` / `triggerGet` / `triggerUpdate` /
   `triggerSetEnabled` / `triggerDelete` / `triggerFire`; the `runDetail`
   extension; the error codes (host + client).
6. **UI:** the Automations tab + the Add trigger dialog + the enable/disable + Run
   now affordances; the locale keys (zh/en); the client mirror types
   (`controller.ts`).
7. **Wiring:** `index.ts` (the `ProjectTriggerService` start/stop, the adapter
   `onEvent` listeners, the `pollDueTriggers` tick, the RPC param).
8. **Tests:** every suite in §10 (the new + the extended); the storage
   integration (the table set + the reopen); the client isolation scan.
