# Spec — Phase 8: Artifacts + final report

**Gate:** Design · **Intent:** `intent.md` (Phase 8, commit `15a8653`) · **Master spec:** `DSH_PROJECTS_SPEC.md` §26 (artifact system), §64 (human-friendly final report), §28 (event model — `artifact.created`), PHASE 8 · **Predecessor:** Phase 7 spec (Approvals + budgets, `321821d`)

## 1. Goal and success

A run produces **durable artifacts** (test reports, research outputs, patches/diffs,
PR references, …) and ends with a **human-readable final report** — the user should
not have to inspect five Agent sessions to understand what happened. Every artifact
persists (surviving browser refresh and process restart) and is inspectable in the
Dashboard.

Success: the `project_artifacts` table + `ProjectArtifactService` store append-only
artifacts (12 kinds, reference-not-blob content policy, secrets scrubbed); the run
completion pipeline generates a deterministic `final-report` artifact at the run's
terminal transition (master spec §64 layout); the Dashboard shows the run's artifacts
(RunInspector section) and the project's artifacts (a project-level tab) with a
readable final report; `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run`
green (modulo the documented pre-existing environment failures).

## 2. Invariants (from `intent.md` §3)

1. **No invented APIs.** Only native Harness/Cordis/Agent-Teams/subagent/storage primitives as installed.
2. **No placeholder APIs, no fake UI data.** Every RPC, service method, and UI control is backed by real behavior; the final report is generated in code from the persisted records (deterministic, no model call, no fabricated data).
3. **No premature phases.** No new run phases; no triggers (Phase 9), no recovery of interrupted report generation (Phase 10), no artifact versioning beyond the one-`final-report`-per-run regeneration.
4. **Preserve existing behavior.** The Phase 5 completion pipeline, the Phase 6 memory distillation, and the Phase 7 approval/budget flow keep working exactly as today — Phase 8 adds an artifact store + a report behind them, not a replacement.
5. **Extend the native Dashboard UI** (one frontend, existing slots).
6. **State in code + persistent storage** (`dsh_projects` domain, format version stays 0).
7. **Repo stays buildable and testable** at every commit.

## 3. Storage (additive, domain stays v0)

### 3.1 `project_artifacts` table (new)

Declared in `dshProjectsDomainSpec` (the domain version stays 0 — storage-domain
initializes absent declared tables as empty, per the Phase 2/4/6/7 precedent):

```ts
export const ARTIFACT_KINDS = [
  'plan', 'research-report', 'architecture-note', 'patch', 'diff',
  'test-report', 'validation-report', 'review-report', 'screenshot',
  'log-reference', 'pull-request', 'external-link', 'final-report',
] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]
export type ArtifactId = string

export interface ProjectArtifactRecord {
  readonly id: ArtifactId            // uuid
  readonly projectId: ProjectId
  readonly runId?: RunId             // the producing run (most artifacts are run-scoped)
  readonly taskId?: TaskId           // the producing task (optional finer scope)
  readonly kind: ArtifactKind
  readonly title: string             // 1..200 chars
  readonly content?: string          // inline text, bounded (§4.1)
  readonly path?: string             // file reference (no large binaries in JSON storage)
  readonly url?: string              // external reference (e.g. a PR URL)
  readonly metadata?: Record<string, unknown>
  readonly createdAt: string         // ISO
}
```

Strict zod schema (`projectArtifactRecordSchema`) in `src/artifacts/spec.ts`;
`title` is `nonBlank` with a 200-char cap (`z.string().trim().min(1).max(200)`);
`content`/`path`/`url`/`metadata` are optional; `metadata` is
`z.record(z.unknown()).optional()` (the kind-specific shape is validated by the
trigger site, not the table — the same pattern as the approval `payload`).

**Append-only:** the record has **no `version` and no `updatedAt`** — an artifact
is never mutated or deleted (the durable record of what a run produced). The one
exception is the `final-report` regeneration (§6.4), which replaces the single
existing `final-report` row for a run in place (same `runId` + kind), not by
adding a second row.

### 3.2 Run event type (additive — one)

```
'artifact.created'   // an artifact was persisted (detail: `<kind>: <title>`)
```

Added to `RUN_EVENT_TYPES` (`src/runs/spec.ts`) and the `ProjectRunEventType`
union (`src/runs/types.ts`). The artifact service appends it on the run's per-run
`seq` (the existing `appendRunEvent` pattern) when the artifact has a `runId`
(project-scoped artifacts without a `runId` emit no run event — there is no run to
project onto). The master spec §28 names this event `artifact.created`; the
product's event stream is per-run, so it is emitted only for run-scoped artifacts.

## 4. Content policy (master spec §26: "do not store huge binary blobs")

### 4.1 The inline `content` bound

`content` is inline **text** (reports, notes, diffs-as-text). It is bounded to
**64 KB** (`MAX_ARTIFACT_CONTENT_LENGTH = 65_536` chars, exported from
`src/artifacts/spec.ts`). A `content` longer than the bound is rejected at
creation with `artifact.contentTooLarge` (`params: { maxLength }`) — the caller
must store a `path` reference instead (§4.2). The bound is enforced by the service
(`validateArtifact`, §5.2); the schema keeps the storage contract strict but does
not re-check the bound (the service is the single authority, the Phase 6 memory
pattern).

### 4.2 References, not blobs

- **Large/binary outputs are references, not blobs** — a `path` (a file in the
  project workspace) or a `url` (an external link / PR). A `screenshot` kind
  stores a `path`/`url`, **never the bytes** (master spec §26, explicit).
- **`pull-request` / `external-link`** carry a `url` (+ `metadata` for the PR
  number, head/branch, etc.).
- **`patch` / `diff`** may carry inline `content` (the diff text, when ≤ 64 KB)
  or a `path` (a patch file in the workspace) — the trigger site chooses.
- **No file upload/download endpoints** — a `path` is a reference into the
  project workspace; the Dashboard links to it, it does not stream bytes
  (§13).

### 4.3 Secrets are scrubbed

`content`/`path`/`url`/`metadata` are scanned for secrets at creation (the Phase 6
memory `SECRET_PATTERNS` — reused, exported from `src/memory/memory-service.ts`
or duplicated into `src/artifacts/spec.ts`; the Design keeps a single source). A
candidate containing what looks like a secret is rejected with
`artifact.containsSecrets` (`params: { reason: 'contains-secrets' }`) — an
artifact never becomes a secret leak. The scan is a hard rejection (the Phase 6
memory pattern), not a silent redaction: the caller must fix the input.

### 4.4 Kind-specific validation (the trigger site, not the table)

`validateArtifact` (§5.2) enforces the **hard** limits (title/content bounds,
secrets) for all kinds. Kind-specific rules are enforced at the trigger site:
- a `pull-request` / `external-link` **requires** a `url` (a
  `pull-request` with no `url` is a `artifact.missingUrl`);
- a `screenshot` **requires** a `path` or `url` (never inline bytes);
- a `final-report` is **never created via `artifactCreate`** — it is generated by
  the completion pipeline (§6.3); a manual `final-report` create is a
  `artifact.kindReserved` (the kind is reserved for the generator).

## 5. Artifact service — `src/artifacts/artifact-service.ts`

### 5.1 Service shape

`ProjectArtifactService` (host-only; the client never imports it — the Phase 6/7
isolation invariant extends: a new scan asserts no `src/client/**` file imports
`src/artifacts/**`):

```ts
constructor(ctx: Context, catalog: ProjectCatalog, runService: ProjectRunService, clock?: () => string)
start(): Promise<void>   // borrows the shared dsh_projects tables (requires runService started)
stop(): Promise<void>
```

Borrows the `project_artifacts` table from the shared domain (the same borrow
pattern as `ProjectMemoryService` — `start()` after `runService.start()`,
`stop()` before `runService.stop()` in `index.ts`). It also borrows `runs`,
`run_events`, `tasks`, and `memory` (the final-report generator reads them, §6).

### 5.2 Create / list / get (append-only)

```ts
/** Persist a new artifact (append-only — no update/delete). Validates the hard
 *  limits + the secrets scan + the kind-specific rules (§4). Emits the
 *  `artifact.created` run event when the artifact has a runId. */
async create(input: ArtifactCreateInput): Promise<ProjectArtifactRecord>

/** List artifacts (newest first). At least one of runId/projectId required. */
list(input: { readonly runId?: RunId; readonly projectId?: string; readonly kind?: ArtifactKind }): ProjectArtifactRecord[]

/** The full record for the detail view. */
get(id: ArtifactId): ProjectArtifactRecord | undefined
```

`ArtifactCreateInput`:

```ts
export interface ArtifactCreateInput {
  readonly projectId: string
  readonly runId?: RunId
  readonly taskId?: TaskId
  readonly kind: string            // validated against ARTIFACT_KINDS
  readonly title: string           // 1..200
  readonly content?: string        // ≤ 64 KB
  readonly path?: string
  readonly url?: string
  readonly metadata?: Record<string, unknown>
}
```

- **Append-only:** there is **no `update` and no `delete`** method (the durable
  record; §13). The only mutation is the `final-report` regeneration (§6.4),
  which is a private in-place replace, not a public `update`.
- **Create** validates via the pure `validateArtifact` (§5.3), persists the record
  (a `put` — no CAS needed, append-only), and appends the `artifact.created` run
  event (when `runId` is present) + emits a Cordis event
  (`dsh-projects/artifact/created`).
- **List** is synchronous (Map-backed) and newest-first (`createdAt` descending,
  id tiebreak — the Phase 7 deterministic-ordering pattern). A `kind` filter is
  optional. At least one of `runId`/`projectId` is required (both absent →
  `artifact.badRequest`).
- **Get** returns the record or `undefined` (the RPC maps `undefined` →
  `artifact.unknown`).

### 5.3 Pure validation (exported for tests)

```ts
export type ArtifactInvalidReason =
  | 'unknown-kind' | 'empty-title' | 'title-too-long'
  | 'content-too-large' | 'missing-url' | 'kind-reserved' | 'contains-secrets'

export function validateArtifact(input: ArtifactCreateInput): ProjectArtifactRecord  // throws artifact.invalidCandidate
```

Enforces only the hard limits + the secrets scan + the kind-specific rules (§4) —
no semantic judgment. Returns the normalized record (trimmed title, the `id`
assigned by the caller). The `final-report` kind is rejected here
(`artifact.kindReserved`) — it is generator-only (§6.3).

## 6. The final report (master spec §64)

### 6.1 The trigger (the run's terminal transition)

The report is generated when a run reaches a **terminal** phase —
`succeeded` / `failed` / `canceled` (`TERMINAL_RUN_PHASES`, the existing
state-machine set). `blocked` and `paused` are **resumable, not terminal** — a
report at a resumable phase would be premature (the run may resume and reach a
different terminal phase); the report is generated once, at the terminal
transition.

The trigger is the **`dsh-projects/run/completed`** Cordis event (emitted by
`ProjectRunService.transitionRun` when `isTerminalRunPhase(next.phase)` — the
existing event, already listened to by the task-service). `ProjectArtifactService`
listens for it (the same `ctx.on` pattern as the task-service's
`onRunCanceled`):

```ts
// in ProjectArtifactService.start():
this.removeCompletedListener = this.ctx.on('dsh-projects/run/completed', event => {
  void this.generateFinalReport(event.runId)   // fire-and-forget
})
```

**Fire-and-forget** (the Phase 6 `distillRun` pattern): the generation is never
awaited by the transition; a failure is a warn log + a `run.report.failed` run
event (a new additive event, §6.5) + **no artifact** — never a run failure, never
thrown into the pipeline. The run reaches its terminal phase regardless of whether
the report succeeds.

### 6.2 The generator (deterministic, in code, no model call)

`buildFinalReport(run, tasks, memory, approvals, artifacts): string` — a **pure**
function (host-only, exported for tests) that renders the master spec §64 layout
from the **persisted records** (no model call, no fabricated data, byte-stable for
the same inputs):

```
Goal
<run.goal>

Outcome
<phase>. <resultSummary | error>

Changes
- <task.title>: <task.outputSummary | status>   (one line per task, plan order)

Validation
- <the integration step outcome: branch/head for Git projects, or "no Git isolation">
- <the run.integration.* events, when present>

Git
Branch: <run.integrationBranch>
Commit: <run.integrationHead>
PR: <the run's pull-request artifact url, when present>

Agents
<the agent count: the number of distinct task workers, or the run's maxConcurrentAgents>

Usage
Input: <run.tokenUsage.input>
Output: <run.tokenUsage.output>
Runtime: <completedAt - startedAt, humanized>

Project knowledge learned
- <the memory entries distilled from this run (sourceRunId === run.id), titles>

Remaining risks
- <the failed/blocked tasks, titles>
- <the budget warnings (run.budget.warning events), when present>
```

- **Every section is present**; an empty section renders its header + "None."
  (never an omitted section — the layout is stable).
- **The `resultSummary` is included verbatim** in the Outcome (the Phase 7
  budget-stop explanation — "Budget limit reached: <key> (…)").
- **The Git section** renders the branch/head when present (a Git project); a
  non-Git project renders "No Git isolation." The PR line renders the run's
  `pull-request` artifact's `url` (when one exists as an artifact) — otherwise
  omitted (no fabricated PR).
- **The knowledge section** lists the Phase 6 memory entries distilled from this
  run (`sourceRunId === run.id`), by title (the `run.memory.distilled` event's
  entries).
- **The risks section** lists the failed/blocked tasks (titles) + the budget
  warnings (the `run.budget.warning` events' details).
- **Deterministic:** for the same persisted records, the output is byte-identical
  (no timestamps in the body beyond the run's own `startedAt`/`completedAt`; no
  random ordering — tasks in plan order, memory in list order).

### 6.3 Persisting the report

`generateFinalReport(runId)` (the fire-and-forget handler):

1. Read the run (the fresh post-transition record); if absent or not terminal →
   no-op.
2. Read the run's tasks, memory (sourceRunId), approvals, and existing artifacts
   (for the PR reference).
3. `buildFinalReport(...)` → the report text.
4. **One `final-report` per run** (idempotent): if a `final-report` artifact
   already exists for the run → replace its `content`/`title`/`metadata` in place
   (the single allowed mutation, §3.1); otherwise create a new row. The record:
   `kind: 'final-report'`, `title: 'Final report'`, `content: <the report>`,
   `runId`, `projectId`, `metadata: { phase, generatedBy: 'pipeline' }`.
5. Append the `artifact.created` run event (detail `final-report: Final report`)
   + emit the Cordis event.
6. On any failure: a warn log + the `run.report.failed` run event (detail = the
   error message) + no artifact. Never throw.

### 6.4 The regenerate affordance

A `runGenerateReport` RPC (§7) re-runs `generateFinalReport(runId)` **on demand**
(the UI's "Regenerate" button). It is allowed in **any** phase (a human may want
to regenerate after adding a `pull-request` artifact, or to re-render after a
budget raise). It returns the (re)generated `final-report` record. The same
idempotent in-place replace applies (§6.3 step 4). A run with no tasks and no
integration still produces a report (the empty sections render "None.") — the
report is always generatable from the persisted records.

### 6.5 The failure event (additive — one)

```
'run.report.failed'   // final-report generation failed (detail: the error message)
```

Added to `RUN_EVENT_TYPES` + the `ProjectRunEventType` union (the same additive
pattern as §3.2). It is the observable signal that a terminal run has **no**
final report (the UI renders a "report unavailable" marker + the regenerate
affordance when the run is terminal but has no `final-report` artifact).

## 7. RPC (additive, the established pattern)

`handleDashboardRpc` gains a 12th param `artifacts?` (the
`ProjectArtifactService`, the same pattern as the 11th `approvals?`):

- **`artifactList`** — `{ runId?, projectId?, kind? }` → `{ artifacts: ProjectArtifactRecord[] }` (newest first; at least one of `runId`/`projectId` required — both absent → bad-request).
- **`artifactCreate`** — `{ projectId, runId?, taskId?, kind, title, content?, path?, url?, metadata? }` → the created record. Structured errors: `artifact.invalidCandidate` (the §5.3 reasons, `params: { reason, … }`), `artifact.contentTooLarge`, `artifact.missingUrl`, `artifact.kindReserved` (a manual `final-report`), `artifact.containsSecrets`.
- **`artifactGet`** — `{ id }` → the record. `artifact.unknown` (no such id).
- **`runGenerateReport`** — `{ runId }` → the (re)generated `final-report` record. `artifact.runUnknown` (no such run), `artifact.reportFailed` (the generation failed — the `run.report.failed` event was emitted).
- **`runDetail`** (extended) — when the artifacts service is mounted, the detail
  gains `artifacts: ProjectArtifactRecord[]` for the run (the on-demand pattern —
  not a snapshot projection; `DashboardSnapshot.version` stays 2) + a
  `finalReport?: ProjectArtifactRecord` (the run's `final-report`, when present).

Absent-service failures follow the Phase 6/7 pattern: `badRequest('<endpoint> is
unavailable: the Artifact service is not mounted')`.

## 8. Error codes (new)

`src/runtime/errors.ts` (host) + `src/client/errors.ts` (mapping, the `params`
envelope field — not `args`):

```
artifact.notStarted          // the service is not started
artifact.unknown             // no such artifact id
artifact.runUnknown          // the runId is not a known run
artifact.badRequest          // artifactList with neither runId nor projectId
artifact.invalidCandidate    // the §5.3 validation failure (params: reason, …)
artifact.contentTooLarge     // content > 64 KB (params: maxLength)
artifact.missingUrl          // a pull-request/external-link with no url
artifact.kindReserved        // a manual final-report create (generator-only)
artifact.containsSecrets     // the secrets scan matched (params: reason)
artifact.reportFailed        // runGenerateReport: the generation failed
```

## 9. UI (existing Dashboard, zh/en parity compile-enforced)

### 9.1 RunInspector — Artifacts section

A new **Artifacts** section in the RunInspector (below the Approvals section),
rendered from `runDetail.artifacts` (the extended `runDetail` payload, §7):

- Each artifact: the kind label (zh/en), the title, the created time.
- The **`final-report`** rendered as a **readable document** (the master spec §64
  layout — the `content` split into its sections; not a raw code block).
- A **detail view** for non-final-report artifacts: the inline `content` (when
  present, ≤ 64 KB) or a `path`/`url` link (a `path` renders as a workspace
  reference; a `url` as a clickable link).
- A **Regenerate** affordance on the `final-report` (dispatches
  `runGenerateReport`; busy gating + the inline error banner per the existing
  conventions). When the run is terminal but has **no** `final-report` (the
  `run.report.failed` case), the section renders a "report unavailable" marker +
  the Regenerate affordance.

### 9.2 Artifacts tab (项目产物 / Artifacts)

A new **project-level** tab in the Dashboard (the Phase 6 Memory-tab pattern):

- The project's artifacts across runs (kind chips + counts, the Memory-tab
  pattern), filter by run/kind, newest first.
- The detail view (the §9.1 detail view, shared).
- The `final-report` of each run surfaced (a "Final report" chip per run).
- An **Add artifact** dialog (kind select, title, content/path/url, metadata) —
  dispatches `artifactCreate` (the manual attach; the `final-report` kind is
  disabled in the dialog — generator-only, §4.4).

### 9.3 Locale keys (zh/en parity compile-enforced)

New keys under the `dsh-dashboard` namespace (the `t` key union — the
`en satisfies Record<DashboardLocaleKey, string>` parity check):
`artifacts` (产物 / Artifacts), `artifact.kind.plan` (计划 / Plan),
`artifact.kind.research-report` (研究报告 / Research report),
`artifact.kind.architecture-note` (架构说明 / Architecture note),
`artifact.kind.patch` (补丁 / Patch), `artifact.kind.diff` (差异 / Diff),
`artifact.kind.test-report` (测试报告 / Test report),
`artifact.kind.validation-report` (验证报告 / Validation report),
`artifact.kind.review-report` (评审报告 / Review report),
`artifact.kind.screenshot` (截图 / Screenshot),
`artifact.kind.log-reference` (日志引用 / Log reference),
`artifact.kind.pull-request` (拉取请求 / Pull request),
`artifact.kind.external-link` (外部链接 / External link),
`artifact.kind.final-report` (最终报告 / Final report),
`artifact.title` (标题 / Title), `artifact.createdAt` (创建时间 / Created),
`artifact.content` (内容 / Content), `artifact.path` (路径 / Path),
`artifact.url` (链接 / URL), `artifact.regenerate` (重新生成 / Regenerate),
`artifact.reportUnavailable` (报告不可用 / Report unavailable),
`artifact.add` (添加产物 / Add artifact),
`report.goal` (目标 / Goal), `report.outcome` (结果 / Outcome),
`report.changes` (变更 / Changes), `report.validation` (验证 / Validation),
`report.git` (Git), `report.agents` (代理 / Agents), `report.usage` (用量 / Usage),
`report.knowledge` (学到的项目知识 / Project knowledge learned),
`report.risks` (剩余风险 / Remaining risks), `report.none` (无 / None).

## 10. Module layout & wiring

```
src/artifacts/
  types.ts            # ArtifactKind, ArtifactId, ProjectArtifactRecord, ArtifactCreateInput
  spec.ts             # projectArtifactRecordSchema (strict zod), MAX_ARTIFACT_CONTENT_LENGTH
  artifact-service.ts # ProjectArtifactService (create/list/get + the run/completed listener)
  final-report.ts     # buildFinalReport (the pure §6.2 generator) + generateFinalReport
src/runs/
  spec.ts             # + the project_artifacts table, + the artifact.created + run.report.failed events
  types.ts            # + the two run event types, + RunDetailView.artifacts/finalReport
src/rpc/
  handler.ts          # + the artifacts param; artifactList/artifactCreate/artifactGet/runGenerateReport; runDetail artifacts
src/runtime/
  errors.ts           # + the artifact.* codes
src/client/
  controller.ts       # + the client mirror types (ClientArtifactKind etc. — the client never imports src/artifacts/**)
  errors.ts           # + the client error mappings
  Dashboard.tsx       # + the RunInspector Artifacts section, the project-level Artifacts tab, the Add artifact dialog
  locales.ts          # + the zh/en keys (§9.3)
src/index.ts          # + the ProjectArtifactService wiring (start/stop, the run/completed listener, the RPC param)
tests/
  artifact-service.test.ts    # new — the store, the content policy, the append-only rule, the event projection
  final-report.test.ts        # new — the deterministic generator, the terminal trigger, the idempotency, the failure
  task-service.test.ts        # extended — the run/completed trigger fires the report generation
  rpc-handler.test.ts         # extended — the four endpoints + runDetail artifacts
  dashboard-artifacts.test.tsx# new — the RunInspector section + the project tab + the Add dialog (zh + en)
  run-storage-integration.test.ts # extended — the table set + the artifacts survive a reopen
  client-artifacts-isolation.test.ts # new — no src/client/** imports src/artifacts/**
```

**Wiring in `index.ts`** (the order matters — the artifact service borrows the
shared domain, so it starts after `runService.start()` and stops before
`runService.stop()`, like the memory/approval services):

```ts
const artifactService = new ProjectArtifactService(ctx, catalog, runService)
// … after runService.start():
await artifactService.start()   // registers the run/completed listener
// … handleDashboardRpc(…, memoryService, approvalService, artifactService)
// … before runService.stop():
await artifactService.stop()
```

## 11. Test plan

### 11.1 `tests/artifact-service.test.ts` (new)

- **Store:** create persists (the table, the `artifact.created` event when
  run-scoped, the Cordis event); the 12 kinds validate; the title bounds (1..200);
  the `content` bound (≤ 64 KB); `path`/`url` references stored as-is;
  `metadata` stored as-is; project-scoped (no `runId`) → no run event.
- **Content policy:** a `content` > 64 KB → `artifact.contentTooLarge`
  (`params: { maxLength }`); a `pull-request`/`external-link` with no `url` →
  `artifact.missingUrl`; a `screenshot` with no `path`/`url` → rejected; secrets
  in `content`/`metadata` → `artifact.containsSecrets` (the Phase 6 patterns).
- **Append-only:** no `update`/`delete` method exists (the test asserts the
  service surface); a re-create is a new row (not a mutation).
- **One `final-report` per run:** a manual `final-report` create →
  `artifact.kindReserved`; the generator's in-place replace (no second row).
- **List:** newest-first (the deterministic ordering); the `kind` filter; at
  least one of `runId`/`projectId` (both absent → `artifact.badRequest`).
- **Get:** a known id → the record; an unknown id → `undefined`.

### 11.2 `tests/final-report.test.ts` (new)

- **The generator:** `buildFinalReport` renders all 9 sections (Goal/Outcome/
  Changes/Validation/Git/Agents/Usage/knowledge/risks); an empty section renders
  its header + "None."; the `resultSummary` is included verbatim (the budget-stop
  explanation); the Git section renders branch/head (a Git project) or "No Git
  isolation" (non-Git); the PR line renders the `pull-request` artifact's `url`
  (when present) / omitted (when absent); the knowledge section lists the
  run's distilled memory titles; the risks section lists the failed tasks +
  budget warnings.
- **Determinism:** the same persisted records → byte-identical output (two calls,
  deep-equal); no fabricated data (a run with no tasks/integration/memory → the
  empty sections, no invented content).
- **The terminal trigger:** the `run/completed` event fires `generateFinalReport`
  (succeeded/failed/canceled); a `blocked`/`paused` transition does **not** fire
  it (resumable, not terminal); the generation is fire-and-forget (the transition
  completes regardless).
- **Idempotency:** a second terminal transition (or a regenerate) replaces the
  single `final-report` row in place (no second row).
- **The failure:** a generation failure (e.g. the run vanished mid-flight) → a
  warn log + the `run.report.failed` event + no artifact; never thrown into the
  pipeline; the run reaches its terminal phase regardless.

### 11.3 `tests/task-service.test.ts` (extended)

- The `run/completed` trigger: a run reaching `succeeded`/`failed`/`canceled`
  fires the report generation (the artifact service's listener); the report
  references the run's tasks/integration/usage/memory.

### 11.4 `tests/rpc-handler.test.ts` (extended)

- `artifactList` (per run, per project, the `kind` filter, both absent →
  bad-request).
- `artifactCreate` (valid; the §5.3 reasons → `artifact.invalidCandidate` with
  `params`; `contentTooLarge`; `missingUrl`; `kindReserved` for a manual
  `final-report`; `containsSecrets`).
- `artifactGet` (valid; unknown → `artifact.unknown`).
- `runGenerateReport` (valid → the `final-report` record; unknown run →
  `artifact.runUnknown`; a generation failure → `artifact.reportFailed`).
- `runDetail` (the `artifacts` array + the `finalReport` when the service is
  mounted; absent when not).
- Absent-service failures (the four endpoints → the structured not-mounted
  bad-requests).

### 11.5 `tests/dashboard-artifacts.test.tsx` (new, jsdom)

- The RunInspector Artifacts section renders the run's artifacts (kind label,
  title, created time); the `final-report` renders as a readable document (the
  §64 sections); the detail view renders the inline `content` or a `path`/`url`
  link; the Regenerate affordance dispatches `runGenerateReport` with busy
  gating + the inline error banner (a structured `artifact.reportFailed`); a
  terminal run with no `final-report` renders the "report unavailable" marker +
  Regenerate; zh + en.
- The project-level Artifacts tab renders the project's artifacts (kind chips +
  counts, the run/kind filters, newest first); the Add artifact dialog dispatches
  `artifactCreate` (the `final-report` kind disabled); zh + en.

### 11.6 `tests/run-storage-integration.test.ts` (extended)

- The table set is exactly `['memory', 'plans', 'project_approvals',
  'project_artifacts', 'run_events', 'runs', 'tasks']` (the new table).
- The `project_artifacts` records (a run-scoped artifact + the `final-report`)
  survive a real JSON domain reopen (zod-validated).
- The `artifact.created` + `run.report.failed` run events survive the reopen.
- The domain stays v0.

### 11.7 `tests/client-artifacts-isolation.test.ts` (new)

- No file under `src/client/**` imports `src/artifacts/**` (the client carries
  its own mirror types in `controller.ts`).

## 12. Acceptance criteria (maps to `intent.md` §6.7)

1. **Store** — `project_artifacts` is a declared table of `dsh_projects` (v0, no
   migration); records validate against the strict schema (12 kinds, bounded
   `content`, `path`/`url` references); artifacts are append-only (no
   update/delete service methods); the table set grows by exactly one table.
2. **Content policy** — inline `content` is bounded (64 KB); large/binary outputs
   are `path`/`url` references (never bytes); `pull-request`/`external-link`
   carry a `url`; secrets are scrubbed (rejected) from `content`/`metadata` at
   creation.
3. **Final report** — the completion pipeline generates a `final-report`
   artifact at the run's terminal transition (succeeded/failed/canceled), in code
   from the persisted records (deterministic, no model call); it explains
   goal/outcome/changes/validation/git/agents/usage/knowledge/risks (master spec
   §64); one per run (idempotent regeneration); a generation failure is a warn +
   the `run.report.failed` event + no artifact, never a run failure.
4. **UI** — the RunInspector Artifacts section + the project-level Artifacts tab
   render artifacts (kind chips, detail view, the readable `final-report`); the
   regenerate affordance dispatches the real RPC; the Add artifact dialog
   dispatches `artifactCreate`; zh/en parity compile-enforced.
5. **RPC** — `artifactList`/`artifactCreate`/`artifactGet`/`runGenerateReport`
   dispatch with validation (content bound, kind, secret scrub); absent-service
   structured failures; the new `artifact.*` error codes (with `params`).
6. **Repo green** — `pnpm run typecheck`, `pnpm run build`, full
   `pnpm vitest run` (modulo the documented pre-existing environment failures).

## 13. Explicit non-goals (Phase 9+)

- No artifact **versioning/supersession** beyond the one `final-report`-per-run
  in-place regeneration (other artifacts are append-only; no edit/delete).
- No **file upload/download** endpoints (a `path` is a reference into the project
  workspace; the Dashboard links to it, it does not stream bytes).
- No **binary/blob storage** (master spec §26 — references only).
- No **artifact search** beyond kind/run filters (a full-text search over
  artifact content is a Phase 11 UI-polish concern).
- No **approval objects for artifact writes** (artifacts are append-only records;
  no gate).
- No **triggers/automations** (Phase 9), no **recovery of interrupted report
  generation** (Phase 10 — a failed generation is a warn + the
  `run.report.failed` event + no artifact, retried by the regenerate affordance).
- No `DashboardSnapshot` version change; artifacts are on-demand RPC data (the
  `runDetail` pattern), not snapshot projections.
- No report at a **resumable** phase (`blocked`/`paused`) — the report is
  generated once, at the terminal transition (§6.1).

## 14. Sequencing (build order)

1. **Storage:** the `project_artifacts` table + schema (`src/artifacts/spec.ts`,
   `types.ts`); the two run event types (`artifact.created`, `run.report.failed`)
   in `src/runs/spec.ts` + `types.ts`; the `RunDetailView.artifacts/finalReport`
   extension.
2. **Content policy + validation:** `MAX_ARTIFACT_CONTENT_LENGTH` + the pure
   `validateArtifact` (§5.3) + the secrets scan (reused from the Phase 6 memory
   patterns).
3. **Service:** `artifact-service.ts` (create/list/get + the `run/completed`
   listener + the `artifact.created` event projection).
4. **Final report:** `final-report.ts` (the pure `buildFinalReport` §6.2 + the
   `generateFinalReport` fire-and-forget handler §6.3 + the idempotent in-place
   replace).
5. **RPC:** the `artifacts` param on `handleDashboardRpc`;
   `artifactList` / `artifactCreate` / `artifactGet` / `runGenerateReport`; the
   `runDetail` extension; the error codes (host + client).
6. **UI:** the RunInspector Artifacts section + the project-level Artifacts tab +
   the Add artifact dialog; the locale keys (zh/en); the client mirror types
   (`controller.ts`).
7. **Wiring:** `index.ts` (the `ProjectArtifactService` start/stop, the
   `run/completed` listener, the RPC param).
8. **Tests:** every suite in §11 (the new + the extended); the storage
   integration (the table set + the reopen); the client isolation scan.
