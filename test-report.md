# Test Report — Phase 8: Artifacts + final report

Test-stage artifact for the Phase 8 diff (build commit `504a2fb`,
intent `15a8653`, spec `87d2591` — §11 test plan + §12 acceptance
criteria). Verified on local `main` @ `504a2fb`, 2026-09-14.

## 1. Test inventory

| File | Cases | Scope (spec §11) |
| --- | --- | --- |
| `tests/artifact-service.test.ts` (new, in-memory domain + real `ProjectArtifactService`) | 20 | §11.1 the service: the **12 kinds** (each accepted; `final-report` is generator-only — a manual create → `artifact.kindReserved` `{ reason: 'kind-reserved' }`); **validation** (unknown kind / empty title / title > 200 → `artifact.invalidCandidate` with `reason`; inline `content` > 64 KB → `artifact.contentTooLarge` `{ maxLength }`; `pull-request`/`external-link` without a `url` → `artifact.missingUrl` `{ reason: 'missing-url' }`; `screenshot` with inline bytes (not a `path`/`url` reference) → rejected; a secret in `content` **or** `metadata` → `artifact.containsSecrets` `{ reason: 'contains-secrets' }`); **append-only** (the service surface exposes only `list`/`create`/`get`/`generateFinalReport` — no update/delete); `list` with project/run/task filters + newest-first; `get` by id (unknown → `artifact.unknown`). |
| `tests/final-report.test.ts` (new, in-memory domain + real services + fixed clock) | 16 | §11.2 the **terminal trigger**: the `run/completed` event fires `generateFinalReport` for `succeeded`/`failed`/`canceled`; a `blocked`/`paused` transition does **not** (resumable, not terminal); the generation is fire-and-forget (the transition resolves before the report lands, the run is terminal regardless); idempotency (one `final-report` row per run — a second generation replaces in place, no second row); the **failure** (a generation failure → a warn log + the `run.report.failed` event + **no** artifact, never thrown into the pipeline, the run still reaches its terminal phase). §11.3 the **report content** (deterministic — the same persisted records → the same markdown; the master-spec §64 sections — goal/outcome/changes/validation/git/agents/usage/knowledge/risks — each present; **no fabricated data** — a run with no `resultSummary`/no tasks renders the absent sections as "none" rather than inventing content). |
| `tests/task-service.test.ts` (extended) | 32 (31 + **1 new**) | §11.2 the **completion pipeline** end-to-end: the `run/completed` listener dispatches `generateFinalReport` on the real task-service transition path (a terminal run produced by the scheduler gets its `final-report` artifact without a direct service call). |
| `tests/rpc-handler.test.ts` (extended) | 58 (48 + **10 new**) | §11.4 the RPC surface: `artifactList`/`artifactCreate`/`artifactGet`/`runGenerateReport` dispatch with validation (missing `projectId` → `bad-request`); the **§5.3 service rejections** surface as structured `bad-request`s — `invalidCandidate`/`contentTooLarge`/`missingUrl`/`kindReserved`/`containsSecrets` each round-trip their `dashboardCode` + `params` through `decodeDashboardError`; **absent-service** structured failures (`artifactCreate`/`artifactGet`/`runGenerateReport` unavailable without an Artifact service); `runGenerateReport` surfaces the on-demand `artifact.runUnknown`/`artifact.reportFailed` with `{ runId }`. |
| `tests/dashboard-artifacts.test.tsx` (new, jsdom) | 9 | §11.5 the UI (zh/en parity): the **project Artifacts tab** (between memory and configuration in zh; the English label under the en locale) fetches the first project on demand, lists artifacts (kind chip, title, open-run action) and opens the **Add artifact** dialog (title + submit → `artifactCreate` with `{ projectId, kind, title }`); the **RunInspector Artifacts section** renders the run artifacts + the readable `final-report` with the localized §64 headers (zh + en), the **Regenerate** affordance dispatches `runGenerateReport(runId)`, a terminal run without a report renders the "report unavailable" marker + Regenerate, and the empty state. |
| `tests/run-storage-integration.test.ts` (extended) | 7 (6 + **1 new**) | §11.6 the **store**: `project_artifacts` is a declared `dsh_projects` table (the set grows by exactly one, v0, no migration); records validate against the strict schema; an artifact + its `artifact.created` run events survive a real JSON domain reopen (browser refresh / process restart do not lose an artifact or its events). |
| `tests/client-artifacts-isolation.test.ts` (new) | 1 | §11.7 the client never imports the node-side artifact modules — no `src/client/**` file imports `src/artifacts/**` (the client carries mirror types in `controller.ts`; the §8 isolation invariant). |

**Total: 550 tests — 547 passed / 3 failed** (the 3 are the documented
pre-existing `project-catalog` macOS failures, §4). **58 new Phase 8 tests**
(46 in the four new files + 12 added to the three extended suites), all green.

## 2. Acceptance criteria (spec §12) — all verified

1. **Store** — `project_artifacts` is a declared `dsh_projects` table (v0, no
   migration); records validate against the strict schema (12 kinds, bounded
   `content`, `path`/`url` references); artifacts are append-only (no
   update/delete service methods); the table set grows by exactly one table. →
   `run-storage-integration.test.ts` (table set, v0, reopen) +
   `artifact-service.test.ts` (12 kinds, content bounds, append-only surface).
2. **Content policy** — inline `content` is bounded (64 KB); large/binary
   outputs are `path`/`url` references (never bytes); `pull-request`/
   `external-link` carry a `url`; secrets are scrubbed (rejected) from
   `content`/`metadata` at creation. → `artifact-service.test.ts` (content
   bound, `missingUrl` ×2, screenshot rejection, secrets in content + metadata).
3. **Final report** — the completion pipeline generates a `final-report`
   artifact at the run's terminal transition (succeeded/failed/canceled), in
   code from the persisted records (deterministic, no model call); it explains
   goal/outcome/changes/validation/git/agents/usage/knowledge/risks (master
   spec §64); one per run (idempotent regeneration); a generation failure is a
   warn + the `run.report.failed` event + no artifact, never a run failure. →
   `final-report.test.ts` (determinism, terminal trigger, idempotency,
   failure, §64 sections, no fabricated data) + `task-service.test.ts`
   (the `run/completed` pipeline trigger).
4. **UI** — the RunInspector Artifacts section + the project-level Artifacts
   tab render artifacts (kind chips, detail view, the readable `final-report`);
   the regenerate affordance dispatches the real RPC; the Add artifact dialog
   dispatches `artifactCreate`; zh/en parity compile-enforced. →
   `dashboard-artifacts.test.tsx` (tab + inspector, zh+en) +
   `client-artifacts-isolation.test.ts`.
5. **RPC** — `artifactList`/`artifactCreate`/`artifactGet`/`runGenerateReport`
   dispatch with validation (content bound, kind, secret scrub); absent-service
   structured failures; the new `artifact.*` error codes (with `params`). →
   `rpc-handler.test.ts` (dispatch, validation, not-mounted ×3, the five §5.3
   rejections, `runUnknown`/`reportFailed`).
6. **Repo green** — `pnpm run typecheck` (exit 0), `pnpm run build` (exit 0 —
   client 462.25 kB / host 428.55 kB), full `pnpm vitest run` (547/3 of 550,
   the 3 modulo the documented pre-existing environment failures, §4).

## 3. Test-stage fixes (made while verifying)

- **`tests/rpc-handler.test.ts`** — filled the §11.4 gap: the Phase 8 build
  covered the happy-path dispatch + shape validation but not the structured
  failure surface. Added 4 cases: the five §5.3 service rejections
  (`invalidCandidate`/`contentTooLarge`/`missingUrl`/`kindReserved`/
  `containsSecrets`) round-tripping their `dashboardCode` + `params` through
  `decodeDashboardError`; the three not-mounted absent-service failures
  (`artifactCreate`/`artifactGet`/`runGenerateReport`); and the on-demand
  `runGenerateReport` `artifact.runUnknown`/`artifact.reportFailed` with
  `{ runId }`. (48 → 58 cases.)
- **`tests/run-storage-integration.test.ts`** — filled the §11.6 gap: the
  Phase 8 build asserted the artifact row survives reopen but not the
  `artifact.created` run events. Extended the reopen case to assert the two
  `artifact.created` events also survive (the event stream is part of the
  durable record). (6 → 7 cases.)
- **`tests/final-report.test.ts`** — filled the §11.2 gap: the Phase 8 build
  covered the success path (terminal trigger, determinism, idempotency) but not
  the failure contract. Added the failure case — a generation failure (the
  artifacts table `put` throws) → a warn log + the `run.report.failed` event +
  no artifact, never thrown, the run still terminal. (15 → 16 cases.)
- **`tests/dashboard-artifacts.test.tsx`** — filled the §11.5 "zh + en" gap:
  the Phase 8 build covered the inspector in zh only. Added the en-locale
  inspector case (the `final-report` renders with the English §64 headers +
  the Regenerate affordance under `DashboardI18nProvider`/en). (8 → 9 cases.)
- **Type errors under `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`**
  (all in Phase 8 test files, fixed for the §12.6 typecheck gate):
  `artifact-service.test.ts` + `final-report.test.ts` (`.entries()` yields
  `unknown` — cast to the record type on push; `MemoryKvTable` row access),
  `final-report.test.ts` (`makeTask` gains `version: 1`; the "no fabricated
  data" case builds a `ProjectRunRecord` without `resultSummary` inline rather
  than a `delete` cast).

## 4. Known pre-existing failures (carried, documented)

`tests/project-catalog.test.ts` — 3 of 6 cases fail on this host because
`tmpdir()` yields `/var/folders/…` while the catalog canonicalizes paths to
`/private/var/folders/…` (macOS symlink). Present since Phase 3 (baseline then
295/3 of 298; Phase 5 336/3 of 339; Phase 6 425/3 of 428; Phase 7 489/3 of
492); the fix-vs-document decision is open in `maintain.md`. Unchanged by
Phase 8 (547/3 of 550 — all 58 new Phase 8 tests pass).

`tests/integration-strategy.test.ts` — the git-worktree cases are flaky
**under full-suite load** (temp-dir / worktree contention); they pass 7/7 in
isolation and in the clean full-suite run that produced the §1 numbers. Not
introduced by Phase 8 (the Phase 8 diff does not touch the merge strategy).
