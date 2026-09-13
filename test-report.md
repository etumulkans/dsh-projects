# Test Report — Phase 6: Project Memory

Test-stage artifact for the Phase 6 diff (build commit `ef5ed66`,
intent `a282a66`, spec `3a03aab` — §12 test plan + §13 acceptance
criteria). Verified on local `main` @ `ef5ed66`, 2026-09-14.

## 1. Test inventory

| File | Cases | Scope (spec §12) |
| --- | --- | --- |
| `tests/memory-retrieval.test.ts` (new, pure strategy over in-memory records) | 23 | §12.1 retrieval: the exact score `(3·\|Q∩title\| + 2·\|Q∩tags\| + 1·\|Q∩body\|) / (3·\|Q\|)` with hand-computed expectations; pinned entries always first (pinned order stable, never demoted); zero-score entries filtered out when a query is present (spec §5) and returned unfiltered without one; kind filter, `includeArchived` (superseded excluded even with the flag — spec §5), `limit` (default 50, explicit, larger than the pool); the deterministic full ordering pinned → score desc → updatedAt desc → id asc (ties broken on every level); empty pool / empty query edge cases; the strategy seam accepts a fake implementation. |
| `tests/memory-service.test.ts` (new, in-memory domain + fake driver + fake clock) | 39 | §12.2–§12.3 service: `list` pool semantics (active; +archived only with the flag; superseded never listed; `counts` = kind counts over all active entries, zero-filled for every kind); `create` bounds (title ≤ 200, body ≤ 12 000, tags ≤ 20 × 40, confidence ∈ [0,1] — each violation → `memory.invalidCandidate` with the exact `reason` param; unknown kind/status rejected); secret scrubbing (api-key/token/password/secret `:=` patterns, `AKIA…`, PEM private keys, `Bearer …` — scrubbed from title/body/tags, candidate dropped when nothing survives); dedup containment ≥ 0.6 (old → `superseded` + `supersedes` link, new → active, smallest id wins ties, distinct facts both stay active, never deleted); `update` (≥ 1 patch field required, CAS `expectedVersion` mismatch → `memory.staleVersion` with `expectedVersion`/`actualVersion` params, `superseded` → `memory.immutable`, archived updatable); `setStatus` (legal moves active ↔ archived, active → superseded; anything from superseded → `memory.immutable`; same-status no-op → `memory.invalidStatus`); `distillRun` (driver candidates persisted with run/task/session provenance, zero candidates → zero entries **and no event**, `run.memory.distilled` only when > 0 with the `${persisted} entries persisted (${superseded} superseded)` detail, driver failure → `run.memory.distillation.failed` + warn, **never thrown into the pipeline**; no driver → no auto entries, no error); `start()` borrows the four shared tables (double start throws; missing key on update → `memory.unknown`). |
| `tests/task-adapters.test.ts` (extended) | 22 (18 + **4 new**) | §12.4 injection: the local and team adapters inject the budgeted packet section `Project memory (durable knowledge from earlier runs — verify before relying on it):\n<packet>` before the report contract when `memoryContext` is present; **byte-identical prompts** when the packet is `undefined` (the no-active-memory case); the packet is the exact `buildMemoryPacket` output (header + `PINNED:` + per-kind upper-cased sections + `- title: body` lines with 300-char `…` truncation). |
| `tests/coordinator-service.test.ts` (extended) | 18 (16 + **2 new**) | §12.4 coordinator injection: the first-turn prompt appends `\n\n` + the packet (query = `run.goal`) when active memory exists; byte-identical prompt when the memory service is absent or the pool is empty. |
| `tests/task-service.test.ts` (extended) | 24 (20 + **4 new**) | §12.5 lifecycle + end-to-end: (1) `onRunSucceeded` fires **once** with the fresh post-transition run record; (2) the fire-and-forget `distillRun` hook never blocks or fails the pipeline (hook throws → run still succeeds, no event leak into the run stream); (3) **Run #1 → Run #2**: run 1's distillation persists an entry, run 2's worker inputs carry the packet built from run 1's memory (query = task title + description), while run 2's own distillation is isolated; (4) the task query is exactly `${task.title} ${task.description}`. |
| `tests/rpc-handler.test.ts` (extended) | 40 (34 + **6 new**) | §12.6 RPC: `memoryList` (default pool, query/kinds/includeArchived pass-through, structured not-mounted failure when the service param is absent — `bad-request` + "the Project Memory service is not mounted"), `memoryCreate` (valid → entry, invalid candidate → `memory.invalidCandidate` with `params: { reason: 'body-too-long' }` decoded through `decodeDashboardError`), `memoryUpdate` (CAS mismatch → `memory.staleVersion` with `params: { expectedVersion: 1, actualVersion: 3 }`; immutable → `memory.immutable`), `memorySetStatus` (legal move, illegal move → `memory.invalidStatus`). |
| `tests/dashboard-memory.test.tsx` (new, jsdom, `renderDashboard` harness pattern) | 10 | §12.7 UI: the tab renders between 项目 and 配置 (zh) and as **Project Memory** (en, `DashboardI18nProvider`); opening the tab dispatches `memoryList` for the first project exactly once (`{ projectId }` only — no invented params); the no-projects state renders without dispatching; the structured not-mounted failure renders the 项目记忆服务不可用。 banner (never a swallowed promise); the empty state; entry rows render kind label (架构), title, tags, status (生效), the `取代 {id}` relation, the `aria-pressed` kind chip with its count, and the 来源运行 link which opens the existing RunInspector (the run's goal appears); pin → `memoryUpdate { id, expectedVersion, pinned: true }`; archive → `memorySetStatus { …, status: 'archived' }`; mark-obsolete → `status: 'superseded'` and superseded rows carry **no** action buttons; manual create → `memoryCreate` with the parsed comma-separated tags and the `已取代既有记忆：{id}` supersession notice from the payload's `supersededId`. |
| `tests/client-memory-isolation.test.ts` (new, source scan) | 1 | spec §4 invariant: no file under `src/client/**` imports `src/memory/**` (the client carries its own mirror types in `controller.ts` and talks to the service only through the typed port). |
| `tests/run-storage-integration.test.ts` (extended; real JSON domain) | 5 (unchanged count, assertions extended) | §12.8 storage: every medium assertion now expects the table set exactly `['memory', 'plans', 'run_events', 'runs', 'tasks']` — the `memory` table is created empty on domain open; unit `dsh_projects` stays at format version **0** (additive, no migration); runs/plans/tasks/events reopen assertions unchanged and green. |

**Regression:** every existing suite re-ran in the full run — Phase 5
(`git-workspace` 21, `integration-strategy` 7, `workspace-manager` 3,
`dashboard-tasks-interactions` 8), Phase 4 (`task-state-machine` 12,
`task-scheduler` 16, `plan-service` 14, `plan-state-machine` 10,
`dashboard-plans-interactions` 7), Phase 3 (`coordinator-policy` 4,
`runtime-coordinator` 1), Phase 2/1 (`run-service` 11, `run-state-machine`
12), and the shared suites (`orchestrator` 9, `scheduling` 3,
`workflow-parser` 17, all dashboard i18n/ux/render suites,
`global-dashboard` 4, provider/source/timeline/path-safety suites). The
client still imports only type/contract modules
(`catalog/types`, `plans/types`, `runs/types`, `tasks/types`,
`runtime/*`, `task-source`) — the new scan proves `src/memory/**` is
never imported by the Web bundle.

## 2. Acceptance criteria (spec §13)

1. **Store** — PASS. `memory` is a declared table of `dsh_projects`
   (v0, no migration): `run-storage-integration` asserts the table set
   grows by exactly one table at format version 0; `memory-service`
   covers the strict schema bounds, CAS `version` bumps
   (`memory.staleVersion` on mismatch), and retention (superseded/archived
   retained, never deleted — dedup and status tests).
2. **Write policy** — PASS. `memory-service` distillation cases: only
   driver-validated candidates persist (secret scrubbing drops tainted
   candidates; zero candidates → zero entries **and no event**; no driver
   → no auto entries, no error spam); manual `create` is the only other
   write path (RPC + UI suites).
3. **Dedup/supersession** — PASS. `memory-service` dedup (containment
   ≥ 0.6 → old `superseded` + `supersedes` link, smallest-id tie-break,
   distinct facts both active); archive hides from retrieval
   (`memory-retrieval` includeArchived cases); the audit trail survives
   reopen (`run-storage-integration` table + record assertions).
4. **Retrieval** — PASS. `memory-retrieval` (23 cases): pinned first,
   filters respected, exact score ordering, `limit` honored, empty pool →
   empty result, fake strategy through the seam.
5. **Budget + injection** — PASS. `memory-service` packet builder cases
   (maxEntries + section char budgets, `undefined` when empty);
   `task-adapters` (+4) and `coordinator-service` (+2) prove the injected
   prompts and byte-identity without memory; `task-service` case 3 is the
   **Run #1 → Run #2** end-to-end (run 2's worker inputs carry run 1's
   distilled memory).
6. **UI** — PASS. `dashboard-memory` (10 cases): search/kind counts/tags/
   status/supersession view/source-run link/pin/edit/archive/
   mark-obsolete/manual create, every action dispatching a real RPC with
   surfaced errors (the structured unavailable banner, the supersession
   notice); zh/en parity compile-enforced (both locale maps are the same
   record type — `tsc` green).
7. **Storage** — PASS. `run-storage-integration`: entries + statuses +
   `supersedes` persist through a real JSON reopen (zod-validated), table
   set grows by exactly one, domain stays v0.
8. **Repo green** — PASS. `pnpm run typecheck` ✅, `pnpm run build` ✅
   (client 404.97 kB / host 378.10 kB), `pnpm exec vitest run`:
   **425 passed / 3 failed of 428** — the 3 failures are the documented
   pre-existing `project-catalog.test.ts` environment failures (macOS
   `/var/folders/…` vs realpath'd `/private/var/folders/…`, present since
   Phase 3; fix-vs-document parked in `maintain.md`), unrelated to
   Phase 6.

## 3. Test-stage findings (fixed before this report)

- **`decodeDashboardError` envelope field is `params`, not `args`.** The
  first RPC assertions read `args` from the decoded envelope;
  `src/runtime/errors.ts` decodes to `{ dashboardCode, fallbackMessage,
  params }`. Fixed both memory assertions to `params:
  expect.objectContaining(…)` (matching the existing `run.versionConflict`
  precedent).
- **Client load-callback identity.** The Memory tab's on-demand fetch
  initially re-dispatched on every surface render because the inline
  arrow prop gets a fresh identity; the load effect now tracks the
  callback in a ref and re-fetches only on real input changes
  (`projectId`, deferred query, kinds, showArchived, reload key).
- **`getByText` multiplicity in the inspector.** The source-run link
  opens the RunInspector, which renders the goal in three places (header
  span, description, aria-label) — the assertion uses
  `getAllByText(…).length > 0`.
- **`exactOptionalPropertyTypes` in test fixtures.** `Partial<MemoryEntryView>`
  overrides must not assign `undefined` to optional fields — fixtures use
  conditional spreads (`...(x === undefined ? {} : { x })`).

## 4. Known pre-existing failures (carried, documented)

`tests/project-catalog.test.ts` — 3 of 6 cases fail on this host because
`tmpdir()` yields `/var/folders/…` while the catalog canonicalizes paths
to `/private/var/folders/…` (macOS symlink). Present since Phase 3
(baseline then 295/3 of 298; Phase 5 baseline 336/3 of 339); the
fix-vs-document decision is open in `maintain.md`. Unchanged by Phase 6
(425/3 of 428 — all 89 new Phase 6 tests pass).
