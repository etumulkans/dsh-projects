# Spec — Phase 6: Project Memory

**Gate:** Design · **Intent:** `intent.md` §11 · **Master spec:** `DSH_PROJECTS_SPEC.md` §73 Phase 6, §20–§25 · **Architecture:** `docs/dsh-projects-architecture.md`

## 1. Goal and success

Phase 5 made a run's *work* durable in Git. Phase 6 makes a run's
*knowledge* durable in the project: a per-project, structured, persistent,
searchable memory store (master spec §20) that is filled only by validated
distillation of finished runs and by manual notes (§21), deduplicated and
superseded with an audit trail instead of deletion (§22), retrieved with a
deterministic local lexical strategy behind a swappable seam (§23), injected
into the next run's coordinator and task prompts under an explicit context
budget (§24), and managed on a new Memory page in the existing Dashboard
(§25).

**Success (master spec §73 Phase 6):** *Run #2 can automatically reuse
knowledge learned in Run #1* — end-to-end, persisted, restart-surviving,
with honest degradation (no agent runtime → manual-only memory, no fabricated
entries, no error spam) instead of fake memory data.

## 2. Invariants (from `intent.md` §3)

1. **No invented APIs.** The distillation driver reuses the exact
   `HarnessCoordinatorDriver` mechanics (`ctx.agents.create` + `setup`
   `defineTool` + one user message + `whenIdle` + `flush` + turn-end reason +
   `dispose`) — no new Harness surface.
2. **No placeholder APIs, no fake UI data.** Memory entries are real
   (distilled or manual); an empty project shows an explicit empty state; a
   run with no reusable knowledge produces zero entries; no packet is
   rendered when a project has no active memory.
3. **Additive only** — the `dsh_projects` domain stays at **format version
   0** (one new declared table, two new run event types); existing record
   shapes only gain optional fields; `DashboardSnapshot.version` stays 2.
4. **No chat history, no raw dumps** (master spec §20/§21) — only reusable
   knowledge persists; raw task output, usage stats, and session chatter are
   never stored as memory; candidates containing secrets are rejected.
5. **No blind deletion** (master spec §22) — supersession and archiving only;
   the system never deletes a memory entry; `superseded` entries are immutable
   (audit trail).
6. **Deterministic retrieval** — same inputs, same output: no randomness, no
   clock reads inside scoring, stable tie-breaks.
7. **Budgeted injection** — the context packet always respects its entry and
   character budgets (§24); injection is a bounded section of the existing
   prompts, never an unbounded history dump.
8. **Client isolation extends** — `src/client/**` never imports
   `src/memory/**`; the UI talks to memory only through the additive RPC
   surface (same rule as the `git-workspace.ts` isolation of Phases 4/5).
9. UI extends the existing `DashboardSurface` (one new top-level tab); zh/en
   parity compile-enforced.
10. State survives a process restart (real-JSON storage integration test).
11. Repo green: `pnpm run typecheck`, `pnpm run build`, `pnpm vitest run`
    (modulo the documented pre-existing environment failures).

## 3. Storage (additive, domain stays v0)

### 3.1 Memory record — `src/memory/types.ts` + `src/memory/spec.ts`

```ts
export const MEMORY_KINDS = [
  'architecture', 'decision', 'convention', 'dependency', 'environment',
  'testing', 'deployment', 'operations', 'research', 'finding',
  'known-problem', 'failure-pattern', 'procedure', 'repository-map',
  'user-preference',
] as const // 15 kinds, master spec §20 — the complete declared set
export const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]
export type MemoryId = string // uuid

export interface ProjectMemoryRecord {
  readonly id: MemoryId
  readonly projectId: string
  readonly kind: MemoryKind
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
  readonly sourceRunId?: string
  readonly sourceTaskId?: string
  readonly sourceSessionId?: string
  readonly confidence?: number
  readonly status: MemoryStatus
  readonly supersedes?: MemoryId
  readonly pinned?: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}
```

`projectMemoryRecordSchema` (strict zod, in `src/memory/spec.ts`, the same
conventions as `src/runs/spec.ts`): `id`/`projectId` uuid; `kind`
`z.enum(MEMORY_KINDS)`; `title` nonBlank `.max(200)`; `body` nonBlank
`.max(12_000)`; `tags` array of nonBlank `.max(40)` strings, `.max(20)`
items; `sourceRunId`/`sourceTaskId` uuid optional; `sourceSessionId` nonBlank
optional (prefixed session id, not a bare uuid — same convention as
`coordinatorSessionId`); `confidence` `z.number().min(0).max(1)` optional;
`status` `z.enum(MEMORY_STATUSES)`; `supersedes` uuid optional; `pinned`
boolean optional; `createdAt`/`updatedAt`/`supersedes`… timestamps;
`version` `z.number().int().min(1)`. `.strict()` as with every
`dsh_projects` table.

Validation bounds (enforced by the service, §4.2): title ≤ 200 chars,
body ≤ 12 000 chars, ≤ 20 tags of ≤ 40 chars each.

### 3.2 Declared tables — `src/runs/spec.ts`

`dshProjectsDomainSpec.tables` gains exactly one additive entry (imported
from `src/memory/spec.ts`, the same one-way import edge as
`projectTaskRecordSchema`):

```ts
// Additive (Phase 6): durable per-project knowledge (spec §3.1).
memory: domainTable<MemoryId, ProjectMemoryRecord>(projectMemoryRecordSchema),
```

The domain stays **version 0**; storage-domain initializes the absent table
as empty on open (no migration). The medium table set asserted by the
storage integration tests grows to `['memory', 'plans', 'run_events',
'runs', 'tasks']`.

### 3.3 Run event types — additive to `RUN_EVENT_TYPES`

```ts
// Additive (Phase 6): memory distillation of a finished run (spec §3.3/§6).
'run.memory.distilled', 'run.memory.distillation.failed',
```

- `run.memory.distilled` — title `Memory distilled`; detail
  `${persisted} entries persisted (${superseded} superseded)`; emitted only
  when `persisted + superseded > 0` (a zero-entry distillation emits
  nothing — no noise).
- `run.memory.distillation.failed` — title `Memory distillation failed`;
  detail = truncated error message (≤ 200, the existing `EVENT_DETAIL_LIMIT`
  convention).

## 4. Memory service — `src/memory/memory-service.ts`

`ProjectMemoryService` follows the sibling-service pattern exactly
(`RunPlanService`/`ProjectTaskService`): constructor
`(ctx: Context, catalog: ProjectCatalog, runService: ProjectRunService,
driver?: MemoryDistillationDriver)`; `start()` borrows the shared domain via
`runService.domain()` and takes `domain.table('memory')`,
`domain.table('runs')`, `domain.table('run_events')`; `stop()` clears the
borrow; `requireStarted()` throws `DashboardDomainError('memory.notStarted', …)`.
The catalog validates `projectId` existence on create/list
(`memory.projectNotFound`).

### 4.1 Store, CAS, and status transitions

- `list(input: { projectId, query?, kinds?, tags?, limit?, includeArchived? }):
  { entries: ProjectMemoryRecord[]; counts: Record<MemoryKind, number> }` —
  `searchMemory` (§5.1) over `active` (+ `archived` when
  `includeArchived`); `counts` = per-kind counts over **all active** entries
  of the project (unfiltered, zero-filled for every kind) for the UI kind
  chips.
- `search(input)` — the §5.1 retrieval interface (synchronous; the in-process
  domain tables are Map-backed — reads are sync, as in `run-service.ts`).
- `create(input: { projectId, kind, title, body, tags?, pinned?, confidence? })
  → { entry, supersededId? }` — manual notes (§25) **and** the persistence
  half of distillation (§4.2/§4.3); dedup/supersession always applied.
- `update(id, expectedVersion, patch: { title?, body?, tags?, pinned? }) →
  record` — at least one patch field required; allowed on `active` and
  `archived`; `superseded` → `memory.immutable` (audit trail is immutable).
- `setStatus(id, expectedVersion, status: 'active' | 'archived' |
  'superseded') → record` — legal moves: `active ↔ archived`,
  `active → superseded` (user "mark obsolete"); anything from `superseded` →
  `memory.immutable`; same-status no-op rejected as `memory.invalidStatus`.
- **CAS** — every mutation compares `expectedVersion` to the stored
  `version` (the domain's atomic `update` chain, the Phase 2/4 pattern);
  a miss throws `memory.staleVersion`; a hit bumps `version` + 1 and
  `updatedAt`.

### 4.2 Write policy and candidate validation (master spec §21)

`validateMemoryCandidate(candidate)` (pure, exported) returns the record
fields or `DashboardDomainError('memory.invalidCandidate', reason)` with
reasons: `unknown-kind`, `empty-title`, `title-too-long`, `empty-body`,
`body-too-long`, `too-many-tags`, `invalid-tag`, `invalid-confidence`,
`contains-secrets`.

- Hard bounds: §3.1 (kind in `MEMORY_KINDS`; title/body non-blank + max
  length; tags trimmed, non-blank, ≤ 40 chars, ≤ 20, de-duplicated
  case-insensitively; confidence in `[0, 1]`).
- **Secrets scan** (the §21 "Does it contain secrets?" question): reject
  when the body or title matches any of:
  `(api[_-]?key|apikey|token|secret|password)\s*[:=]\s*\S{8,}` (case-
  insensitive), `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  `Bearer\s+[A-Za-z0-9._-]{20,}`. Rejection is per-candidate (other
  candidates in the same submission still persist).
- The §21 questions "useful in another run? / project-specific? / still
  true?" are answered by the **distillation prompt** (§6.2 — the agent is
  told the §21 good/bad examples and "submit zero entries if nothing is
  reusable"); "already stored?" by dedup (§4.3). Validation enforces only
  hard limits + the secrets scan — no semantic judgment in code.
- Invalid candidates are skipped with a `ctx.logger.warn` (including the
  reason and the run id) — never an exception out of the distillation,
  never persisted.

### 4.3 Deduplication and supersession (master spec §22)

Pure, deterministic, exported from `src/memory/retrieval.ts`
(`normalizeTerms`, `termOverlap`):

- **Normalization** — lowercase; keep unicode word characters; split into
  word tokens of ≥ 3 chars; drop a fixed minimal stopword list
  (`the a an is are was were in on for to of and or this that it with from
  by at as`).
- **Overlap** — `overlap = |T_c ∩ T_e| / min(|T_c|, |T_e|)` (containment —
  robust to different entry lengths).
- **Rule** — a candidate supersedes an existing **active** entry of the
  **same kind** when `overlap ≥ 0.6`; with several matches, the highest
  overlap wins (ties → lexicographically smallest `id` — deterministic).
  No match → plain new `active` entry, no `supersedes`.
- **Effect** — the old entry flips to `superseded` (`version`+1,
  `updatedAt`); the new entry is `active` with `supersedes` = the old id.
  The old entry is never deleted (§2 invariant 5).
- Idempotent-ish: re-submitting an entry identical to an active one
  supersedes it (the audit trail grows); that is the documented behavior —
  history, not data loss.

## 5. Retrieval and context budget — `src/memory/retrieval.ts`

### 5.1 Lexical search (master spec §23)

`searchMemory(entries: readonly ProjectMemoryRecord[], input: { projectId,
query?, kinds?, tags?, limit? }) → ProjectMemoryRecord[]` — pure; the
service passes the project's pool (`status === 'active'`; `superseded` and
`archived` are history, never retrieval results):

- **Filters** — `kinds?` subset; `tags?` = the entry must contain **all**
  listed tags (case-insensitive); `query?` = scored below.
- **Scoring** — query terms via the §4.3 normalizer; per entry
  `score = (3·|Q ∩ title| + 2·|Q ∩ tags| + 1·|Q ∩ body|) / (3·|Q|)` ∈
  `[0, 1]` (title hits weigh 3×, tags 2×, body 1×). No query / no matching
  terms → `score = 0` for all (recency order below).
- **Order** — `pinned` first, then `score` desc, then `updatedAt` desc,
  then `id` asc (fully deterministic). `limit` applied after sorting
  (default 50 for `list`; retrieval callers pass the budget's
  `maxEntries`).
- **Seam** — the service calls `searchMemory` through one private
  `strategy` field (default: the lexical implementation) so a future
  semantic/vector strategy replaces it without touching callers
  (master spec §23: "Design it so semantic/vector retrieval can be added
  later").

### 5.2 Budgets and context packet (master spec §24)

```ts
export interface MemoryBudgets {
  readonly maxEntries: number
  readonly maxChars: number
  readonly pinnedMaxChars: number
  readonly retrievedMaxChars: number
} // invariant: pinnedMaxChars + retrievedMaxChars ≤ maxChars

export const COORDINATOR_MEMORY_BUDGET: MemoryBudgets =
  { maxEntries: 10, maxChars: 4000, pinnedMaxChars: 1500, retrievedMaxChars: 2500 }
export const TASK_MEMORY_BUDGET: MemoryBudgets =
  { maxEntries: 6, maxChars: 2000, pinnedMaxChars: 800, retrievedMaxChars: 1200 }
```

`buildMemoryPacket(entries, budgets)` (pure) → `string | undefined`:

- Pinned entries first (rendered within `pinnedMaxChars`), then the
  non-pinned retrieved entries (within `retrievedMaxChars`); entries stop
  being added when a section's character budget is exhausted (each line's
  length counts; no partial lines).
- Sections in fixed order: `PINNED` (when present), then one section per
  present kind in `MEMORY_KINDS` order, header = the kind upper-cased
  (the master spec §24 "Relevant architecture / decisions / testing /
  known pitfalls" shape).
- Entry line: `- title: body` with `body` truncated at 300 chars (`…`).
- Packet header:
  `PROJECT MEMORY (knowledge persisted from earlier runs — verify before
  relying on it):`.
- `undefined` when there is nothing to render (no active entries) —
  callers append nothing (no placeholder text, §2 invariant 2).

`ProjectMemoryService.packetFor({ projectId, query, budgets }) →
string | undefined` — `buildMemoryPacket(searchMemory(pool, { query,
limit: budgets.maxEntries }), budgets)`; synchronous.

## 6. Distillation — `src/memory/distillation.ts`

### 6.1 Driver seam (master spec §73 Phase 6 "Run memory distillation")

```ts
export interface MemoryDistillationSubmission {
  readonly entries: readonly {
    readonly kind: string
    readonly title: string
    readonly body: string
    readonly tags?: readonly string[]
    readonly confidence?: number
    readonly sourceTaskId?: string
  }[]
}
export interface MemoryDistillationDriverInput {
  readonly sessionId: string // `dsh-memory-<uuid>`, generated by the service
  readonly cwd: string
  readonly permissionPreset: string
  readonly agentPreset?: string
  readonly prompt: string
  readonly signal: AbortSignal
  readonly onMemorySubmit: (input: MemoryDistillationSubmission) =>
    Promise<{ readonly persisted: number; readonly superseded: number }>
}
export interface MemoryDistillationDriver {
  start(input: MemoryDistillationDriverInput):
    Promise<{ readonly kind: 'completed' | 'failed' | 'blocked'; readonly error?: string }>
}
```

`HarnessMemoryDistillationDriver` is the native implementation and mirrors
`HarnessCoordinatorDriver` line-for-line in mechanics:
`ctx.agents.create({ sessionId, meta: { cwd }, agentOptions (current model
selection), signal, setup })`; in `setup` — presets mount (when configured),
`installModelSelection`, and `installSubmitMemoryTool` registering
`dsh_projects_submit_memory` via `defineTool` (parameters: `entries` array —
`kind` string **enum of the 15 kinds**, `title`/`body` required strings,
`tags` string array, `confidence` number, `sourceTaskId` string — plus
optional `note`; `execute` calls `onMemorySubmit` and returns
`{ persisted, superseded }` as the tool output; "Call exactly once with all
entries — an empty array is a valid answer when nothing is reusable"); then
one `createUserMessage` prompt, `whenIdle`, `flush`, turn-end reason mapping
(`error`/`blocked`/`completed`), `dispose` in `finally` — identical error
handling to the Phase 3 driver. No new Harness API is touched.

### 6.2 Distillation prompt (pure `buildDistillationPrompt`)

Sections, in order: (1) identity — "You are distilling durable project
memory from a completed run"; (2) the run goal; (3) per-task lines
`t<n> [succeeded|failed] <title> — <outputSummary truncated 400>` (real
persisted task data only); (4) **already-stored titles** (active entries of
the project, ≤ 25, truncated 120 chars) — "do not resubmit duplicates";
(5) the write policy — the master spec §21 good/bad memory examples, the
five §21 questions, "persist only reusable project knowledge; submit zero
entries if nothing is reusable; never submit secrets, credentials, or
transcript dumps". No invented capabilities; the agent reads nothing else.

### 6.3 `distillRun(run)` — trigger, persistence, events

Preconditions: `run.phase === 'succeeded'`; a driver is configured (no
driver → **silent no-op**, no event — unmounted runtime, §2 invariant 2);
the run has a `projectId`.

1. Build the prompt (§6.2) from persisted tasks + existing memory titles;
   `sessionId = dsh-memory-<uuid>`.
2. `onMemorySubmit` → `persistCandidates`: each candidate validated
   (§4.2 — invalid ones skipped + warned), dedup/supersede (§4.3), persisted
   with `sourceRunId = run.id`, `sourceTaskId` when the candidate carries
   one, `sourceSessionId = sessionId`; returns `{ persisted, superseded }`.
3. Events on the run's per-run `seq` (the existing `appendRunEvent` pattern,
   §3.3): `persisted + superseded > 0` → `run.memory.distilled`; driver
   `failed`/`blocked` → `run.memory.distillation.failed` (truncated error);
   zero entries → nothing.
4. Never throws into the caller — all failures become the failed-event or
   a warn log.

**Trigger wiring (additive):** `ProjectTaskService`'s constructor gains
`memory?: ProjectMemoryService` and `hooks?: { readonly onRunSucceeded?:
(run: ProjectRunRecord) => void }`. In `finalizeRun`, **after**
`safeTransitionRun(run.id, 'succeeded', …)` succeeds, the service calls
`Promise.resolve(this.hooks?.onRunSucceeded?.(run)).catch(err → warn)` —
fire-and-forget: the pipeline tick never awaits the distillation session,
so `succeeded` is never delayed or blocked by it. `src/index.ts` wires
`onRunSucceeded: run => { void memoryService.distillRun(run) }`.

**Documented limitation:** a process restart between the `succeeded`
transition and the distillation completion loses that run's auto-distillation
(the run itself is already terminal and persisted; no re-trigger on
already-succeeded runs). Restart recovery of side effects is Phase 10
(non-goal §14).

## 7. Injection points (master spec §24)

### 7.1 Coordinator prompt

`CoordinatorService`'s constructor gains an optional trailing
`memory?: ProjectMemoryService`. `buildPrompt(run, project)` appends, when
`memory` is defined and `memory.packetFor({ projectId: run.projectId,
query: run.goal, budgets: COORDINATOR_MEMORY_BUDGET })` returns a packet:
`\n\n` + packet, after the existing `coordinatorPrompt(…)` section. No
packet → the prompt is byte-identical to today (no placeholder text).

### 7.2 Task prompts (worker seam, additive)

- `TaskWorkerInput` (`src/tasks/worker.ts`) gains
  `readonly memoryContext?: string` — a pre-rendered packet, not an entry
  list (the adapters stay presentation-only).
- `ProjectTaskService` (with `memory` configured) fills it at worker start:
  `packetFor({ projectId: run.projectId, query: \`${task.title}
  ${task.description}\`, budgets: TASK_MEMORY_BUDGET })`; absent packet →
  field stays absent.
- `renderTaskPrompt` (local-adapter) and `renderTeamTaskPrompt`
  (team-adapter) insert, when present, a section before the report
  contract: `Project memory (durable knowledge from earlier runs — verify
  before relying on it):\n<packet>\n`. Absent → prompts are byte-identical
  to today.

## 8. Events and errors

- Run events: the two additive types of §3.3 (no other event changes).
- New `DashboardDomainError.dashboardCode`s (surfaced through the existing
  `encodeDashboardError` path): `memory.notStarted`, `memory.projectNotFound`,
  `memory.unknown` (id not found), `memory.staleVersion` (CAS miss),
  `memory.invalidCandidate` (detail = the §4.2 reason), `memory.immutable`
  (superseded entries), `memory.invalidStatus` (illegal transition / no-op).
- Distillation failures never fail a run: they are events + warn logs (§6.3).

## 9. RPC (additive — four new endpoints)

`handleDashboardRpc` gains a 10th optional parameter
`memory?: ProjectMemoryService`; the four new cases follow the existing
payload-validation conventions (`readStringField`, `badRequest`, structured
failures for an absent service):

| Endpoint | Payload | Result |
| --- | --- | --- |
| `memoryList` | `{ projectId (required), query?, kinds?, tags?, limit?, includeArchived? }` | `{ entries: ProjectMemoryRecord[]; counts: Record<MemoryKind, number> }` (counts zero-filled, §4.1) |
| `memoryCreate` | `{ projectId, kind, title, body, tags?, pinned?, confidence? }` | `{ entry, supersededId? }` (validation → `memory.invalidCandidate` failure; dedup applied) |
| `memoryUpdate` | `{ id, expectedVersion, title?, body?, tags?, pinned? }` (≥ 1 patch field) | `{ entry }` |
| `memorySetStatus` | `{ id, expectedVersion, status: 'active'\|'archived'\|'superseded' }` | `{ entry }` |

No snapshot projection is added (entries are unbounded; the Memory tab
fetches on demand like `runDetail`). `DashboardSnapshot.version` stays 2.

## 10. UI (new Memory tab, zh/en parity compile-enforced)

`type Tab = 'board' | 'runtime' | 'runs' | 'projects' | 'memory' |
'configuration'` — the new tab sits between `projects` and
`configuration`. `t('tab.memory')`: zh `项目记忆` / en `Project Memory`.

`MemoryView` (Dashboard.tsx, the existing component/style conventions —
`role="table"` rows, `aria-label` from `t(…)`, `busy` gating, error
banner):

- **Project selector** — the catalog's projects; default = first project;
  no projects → `memory.noProjects` empty state. Selecting a project or
  changing the query dispatches `memoryList` (the on-demand pattern of
  `runDetail`).
- **Search** — input (`memory.searchAria`: zh `搜索项目记忆` / en `Search
  project memory`); the query goes server-side into `memoryList`.
- **Kind chips** — one per present kind with its `counts` value
  (`memory.countsAria`); clicking toggles the `kinds` filter (re-dispatch).
- **Entry list** — per entry: kind label (`memory.kind.<kind>` × 15 — zh:
  架构/决策/约定/依赖/环境/测试/部署/运维/研究/发现/已知问题/失败模式/流程/仓库地图/用户偏好;
  en: Architecture/Decision/Convention/Dependency/Environment/Testing/
  Deployment/Operations/Research/Finding/Known Problem/Failure Pattern/
  Procedure/Repository Map/User Preference), title, body clamped to 3 lines,
  tags, status marker (`memory.status.active|superseded|archived`), pin
  indicator, the supersession relationship when present
  (`memory.supersededBy` on superseded entries; `memory.supersedes` when the
  entry carries `supersedes`), and a source-run link
  (`memory.sourceRun`) opening the existing run inspector when
  `sourceRunId` is set.
- **Per-entry actions** — pin/unpin (`memory.pin`/`memory.unpin` →
  `memoryUpdate` with `pinned`), edit (`memory.edit` → dialog with
  title/body/tags/pinned → `memoryUpdate` + `expectedVersion`),
  archive/restore (`memory.archive`/`memory.restore` → `memorySetStatus`),
  mark obsolete (`memory.markObsolete`, active entries only →
  `memorySetStatus 'superseded'`).
- **Manual note** — `memory.addNote` button → dialog (kind select
  `memory.kindSelectAria`, title `memory.titlePlaceholder`, body
  `memory.bodyPlaceholder`, tags `memory.tagsPlaceholder` comma-separated →
  `memoryCreate`); a `supersededId` in the result shows
  `memory.supersededNotice` (zh `已取代既有记忆：{id}` / en `Superseded
  existing memory: {id}`).
- **States** — empty project → `memory.empty`; memory service unavailable →
  `memory.unavailable` (the structured RPC failure, never a swallowed
  promise). Every control dispatches a real RPC (invariant 2).

`DashboardController` gains `memoryList/memoryCreate/memoryUpdate/
memorySetStatus` (the direct `rpc.call('/dsh-dashboard', …)` pattern of
`runDetail`). `src/client/locales.ts` gains the keys above in zh and en
(the parity compile-enforcement already in place catches drift).

## 11. Module layout & wiring

New files:

| File | Contents |
| --- | --- |
| `src/memory/types.ts` | `MEMORY_KINDS`/`MEMORY_STATUSES`, `MemoryKind`/`MemoryStatus`/`MemoryId`, `ProjectMemoryRecord` |
| `src/memory/spec.ts` | `projectMemoryRecordSchema` (strict zod) |
| `src/memory/retrieval.ts` | `normalizeTerms`, `termOverlap`, `searchMemory`, `MemoryBudgets` + the two budgets, `buildMemoryPacket` (all pure) |
| `src/memory/memory-service.ts` | `ProjectMemoryService` (store/CAS/status, `validateMemoryCandidate`, dedup wiring, `packetFor`, `distillRun`, events) |
| `src/memory/distillation.ts` | `MemoryDistillationSubmission/DriverInput/Driver`, `HarnessMemoryDistillationDriver`, `buildDistillationPrompt` |

Edits (all additive): `src/runs/spec.ts` (table + 2 event types);
`src/tasks/worker.ts` (`memoryContext?`); `src/tasks/local-adapter.ts` +
`src/tasks/team-adapter.ts` (prompt section); `src/tasks/task-service.ts`
(`memory?` + `hooks?` ctor params, packet at worker start, `onRunSucceeded`
after `succeeded`); `src/coordinator/coordinator-service.ts` (`memory?` ctor
param, packet in `buildPrompt`); `src/rpc/handler.ts` (4 cases + param);
`src/client/controller.ts` (4 methods); `src/client/Dashboard.tsx` (tab +
`MemoryView` + dialogs); `src/client/locales.ts` (zh/en keys); `src/index.ts`
(`new ProjectMemoryService(ctx, catalog, runService, new
HarnessMemoryDistillationDriver(ctx))` + wiring into task/coordinator).
`tsconfig.json` needs no change (src is glob-included; test files are
glob-included).

Wiring in `src/index.ts` (order matters — after `runService`):

```ts
const memoryService = new ProjectMemoryService(ctx, catalog, runService, new HarnessMemoryDistillationDriver(ctx))
// taskService/coordinator gain memoryService as their new optional params
```

`memoryService.start()` inside the existing run-service-started region
(borrowed domain — same as plan/task services); `stop()` in the existing
shutdown sequence. Client isolation (§2 invariant 8) is asserted by the
import-scan test (extend the existing scan: `src/client/**` must not import
`src/memory/**`).

## 12. Test plan

1. **`tests/memory-retrieval.test.ts`** (new, pure) — `normalizeTerms`
   (unicode, stopwords, ≥ 3 chars); `termOverlap` (containment, empty sets);
   `searchMemory` (filters, scoring weights, pinned-first order, tie-breaks,
   `limit`, empty pool, no-query recency order, determinism — same input →
   same output, two runs compared); `buildMemoryPacket` (sections + kind
   order, per-section budget truncation, no partial lines, 300-char body
   truncation, `undefined` when empty, the exact header line).
2. **`tests/memory-service.test.ts`** (new, in-memory domain harness) —
   record validation through the real zod schema; CAS (stale version →
   `memory.staleVersion`; hit bumps `version`/`updatedAt`); status
   transitions (legal matrix, `memory.immutable`, `memory.invalidStatus`);
   `validateMemoryCandidate` (every §4.2 reason, each secret pattern);
   dedup/supersession (near-duplicate flip + link, distinct facts both
   active, tie → smallest id, idempotent re-submit grows history, counts
   zero-filled, archived excluded from `counts`).
3. **`tests/memory-distillation.test.ts`** (new, fake driver seam) —
   `buildDistillationPrompt` (goal, real task lines with truncated
   summaries, already-stored titles, the §21 policy text); submission →
   validate + dedup + persist (sourceRunId/sourceSessionId set,
   sourceTaskId passthrough, invalid candidates skipped without aborting
   siblings); zero entries → **no event**; driver failure →
   `run.memory.distillation.failed` (truncated detail); no driver → silent
   no-op; aborted signal.
4. **`tests/task-service.test.ts`** (extended) — packet injection: fake
   memory service → `TaskWorkerInput.memoryContext` present with the task
   budget (query = title + description); absent packet → field absent;
   **Run #1 → Run #2 end-to-end** (the phase's end state): a real
   (fake-driver) distillation persists an entry for run 1 → run 2's task
   worker input carries it; `onRunSucceeded` fire-and-forget — the run
   reaches `succeeded` without awaiting the (slow) fake driver.
5. **`tests/coordinator-service.test.ts`** (extended) — `buildPrompt`
   includes the packet (goal as query) when the memory service returns one;
   byte-identical prompt when it returns `undefined`.
6. **`tests/rpc-handler.test.ts`** (extended) — the four endpoints:
   success shapes (zero-filled counts, `supersededId` pass-through),
   validation failures (missing `projectId`, unknown kind, missing patch
   field, stale version, illegal status), absent-service structured failure.
7. **`tests/dashboard-memory.test.tsx`** (new, jsdom) — tab renders (zh);
   project selector + `memoryList` dispatch; kind chips with counts + filter
   toggle; entry row (kind label, tags, status marker); pin/edit/archive/
   mark-obsolete dispatch the right RPCs with `expectedVersion`; manual-note
   dialog (zh + en) → `memoryCreate` + `memory.supersededNotice`;
   supersession display; source-run link opens the run inspector; empty +
   unavailable states.
8. **`tests/run-storage-integration.test.ts`** (extended) — memory entries
   (active + superseded with `supersedes`) survive a real JSON domain
   reopen; table set `['memory', 'plans', 'run_events', 'runs', 'tasks']`;
   domain still format v0.
9. Import-isolation scan extended: `src/client/**` must not import
   `src/memory/**`.

Timeouts follow the Phase 5 conventions (real pipeline tests
`45_000–90_000`; the distillation e2e uses the fast fake driver — no real
agent sessions in unit tests).

## 13. Acceptance criteria (maps to `intent.md` §11.3)

1. **Store** — `memory` is a declared table of `dsh_projects` (v0, no
   migration; §3.2); records validate against the strict §3.1 schema;
   `version` bumps on every accepted mutation (CAS, §4.1);
   `superseded`/`archived` entries are retained, never deleted (§4.1/§4.3).
2. **Write policy** — only distillation (real validated candidates, §4.2/§6)
   and manual notes (§4.1 `create`) produce entries; raw output never
   persists; a run with no reusable knowledge → zero entries, no event
   (§6.3); no driver → no auto entries, no error spam (§6.3).
3. **Dedup/supersession** — near-duplicate same-kind candidate flips the old
   entry to `superseded` and links it (§4.3); distinct facts both stay
   active; archive hides from retrieval (§5.1); the audit trail survives
   reopen (§12.8).
4. **Retrieval** — deterministic lexical search: pinned first, filters
   respected, relevance ordered, `limit` honored (§5.1); empty project →
   empty result; the strategy seam accepts a fake implementation (§5.1/§12.1).
5. **Budget + injection** — the packet respects `maxEntries` + the section
   character budgets (§5.2); injected into the coordinator prompt (§7.1) and
   task prompts (§7.2); no packet with no active memory; **Run #1 → Run #2**
   end-to-end (§12.4).
6. **UI** — the Memory tab renders search/kind counts/tags/status/
   supersession view/source-run link/pin/edit/archive/mark-obsolete/manual
   create (§10); zh/en parity compile-enforced; every action dispatches a
   real RPC with surfaced errors (§10).
7. **Storage** — memory entries + statuses + `supersedes` survive a real
   JSON reopen; table set grows by exactly one table; domain stays v0
   (§3.2, §12.8).
8. **Repo green** — typecheck, build, `pnpm vitest run` (modulo the
   documented pre-existing environment failures).

## 14. Explicit non-goals (Phase 7+)

- No semantic/vector retrieval, embeddings, or mandatory external vector
  database — the §5.1 seam only (master spec §23 defers it).
- No cross-project memory sharing (memory is per-project by model, §3.1).
- No automatic expiry/TTL or background garbage collection — supersession +
  manual archiving only (audit trail preserved).
- No recovery of an interrupted distillation on restart (§6.3 documented
  limitation; Phase 10 recovery).
- No approval objects for memory writes (Phase 7 approvals apply to
  runs/plans; memory writes are service-internal + manual).
- No spend/budget enforcement (Phase 7) — `MemoryBudgets` is a retrieval
  bound, not a cost limit.
- No artifact system (Phase 8) — memory entries are knowledge, not
  documents.
- No provenance graph beyond `supersedes` + the three source fields; no edit
  history table.
- No new run phases, no snapshot projection, no `DashboardSnapshot`
  version change.

## 15. Sequencing (build order)

| Step | Deliverable | Gate evidence |
| --- | --- | --- |
| 1 | `src/memory/types.ts` + `src/memory/spec.ts` + the additive table/event types in `src/runs/spec.ts` | typecheck; storage integration table set |
| 2 | `src/memory/retrieval.ts` (pure) + `tests/memory-retrieval.test.ts` | §12.1 green |
| 3 | `src/memory/memory-service.ts` + `tests/memory-service.test.ts` | §12.2 green |
| 4 | `src/memory/distillation.ts` + `tests/memory-distillation.test.ts` | §12.3 green |
| 5 | Injection: `worker.ts`, both adapters, `task-service.ts`, `coordinator-service.ts` + extended tests | §12.4/§12.5 green (incl. Run #1 → Run #2) |
| 6 | RPC: `handler.ts` (4 endpoints) + `tests/rpc-handler.test.ts` | §12.6 green |
| 7 | UI: `locales.ts`, `controller.ts`, `Dashboard.tsx` + `tests/dashboard-memory.test.tsx` | §12.7 green; parity compile |
| 8 | `src/index.ts` wiring + storage-integration extension + import-scan | §12.8/§12.9 green |
| 9 | Full suite (`pnpm run typecheck` + `pnpm run build` + `pnpm vitest run`) | §13.8 |
