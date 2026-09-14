# Test Report — Phase 9: Trigger generalization

Test-stage artifact for the Phase 9 diff (build commit `9d95463`,
intent `0a0b648`, spec `f9a1ee1` — §10 test plan + §11 acceptance
criteria). Verified on local `main` @ `9d95463`, 2026-09-14.

## 1. Test inventory

| File | Cases | Scope (spec §11) |
| --- | --- | --- |
| `tests/trigger-service.test.ts` (new, in-memory domain + real `ProjectTriggerService`, fixed clock) | 15 | §11.1 the **store/service**: the two declared tables (`project_triggers` + `trigger_fires`, v0, no migration); the strict schema (7 types, per-type `config`, bounded `goalTemplate` 1..500); **CRUD** (`create`/`get`/`list`/`update`/`setEnabled`/`delete`); `manual` is **never persisted** (a `manual` create → `trigger.manualReserved`); a secret in `goalTemplate`/`config` → `trigger.containsSecrets`; `list` is newest-first with a deterministic insertion-order tiebreak under a fixed clock; `trigger.notStarted` before the service starts; the exported pure `validateTrigger` (per-type `config` shape, `goalTemplate` bounds). |
| `tests/trigger-fire.test.ts` (new, in-memory domain + real `ProjectTriggerService` + real `ProjectRunService`, fixed clock) | 9 | §11.3 **idempotency** + §11.4 **fire**: `fire` renders the `goalTemplate` with the event and creates a run via `createRun` (the trigger's `approvalMode` + `source`/`sourceRef`); the **dedupe** — the same `(triggerId, sourceEventKey)` creates at most one run (a duplicate event is a no-op; a process **restart** does not re-fire — the `trigger_fires` record is the authority); a **disabled** trigger does not fire; `goalEmpty`/`goalTooLong` rejections; the **failure** contract (a `createRun` throw → **no** fire record persisted, the trigger is unchanged and retryable); the `trigger.fired` run event + `lastFiredAt`/`lastRunId` are recorded; a `manual` fire is non-idempotent (a synthetic `manual:<uuid>` key). |
| `tests/trigger-adapters.test.ts` (new, fake clock + fake task sources) | 14 | §11.2 the **adapters**: the registry exposes exactly the 7 types; the **pull** set (`schedule`, `tracker`) vs the **push** set (`pr-event`, `repository-event`, `system`, `webhook`); the `tracker` adapter wraps the existing `TaskSource`s (no rewrite) and yields a `TriggerEvent` on a ready-state issue; the `schedule` adapter computes the next slot and fires on it (deterministic under a fake clock, no re-fire after a restart); the `webhook` adapter maps a signed payload to a `TriggerEvent`; the `system`/`repository-event`/`pr-event` adapters are the minimal real `onEvent` path (`pr-event` maps to the `repository-event` run source). |
| `tests/rpc-handler.test.ts` (extended) | 72 (67 + **5 new**) | §11.6 the **RPC surface**: `triggerList`/`triggerCreate`/`triggerGet`/`triggerUpdate`/`triggerSetEnabled`/`triggerDelete`/`triggerFire` dispatch with validation (missing/invalid `projectId`/`id` → `bad-request`); the **service rejections** surface as structured `bad-request`s — `trigger.invalidCandidate`/`trigger.containsSecrets`/`trigger.unknown`/`trigger.disabled`/`trigger.goalEmpty` each round-trip their `dashboardCode` + `params` through `decodeDashboardError`; **absent-service** structured failures (the trigger endpoints are unavailable without a Trigger service). |
| `tests/dashboard-automations.test.tsx` (new, jsdom) | 12 (10 + **2 new**) | §11.5 the **UI** (zh/en parity): the **Automations tab** (between artifacts and configuration in zh; the English label under the en locale) fetches the first project on demand, lists triggers (type badge, enabled/paused status, goal template, **approval policy** — the mode label or the "use default" marker) and the empty marker; **enable/disable** dispatches `triggerSetEnabled` with busy gating; **Run now** dispatches `triggerFire`; the **Add trigger** dialog (type select + per-type config fields + goal template + **approval-mode select**) dispatches `triggerCreate` (submit disabled until a goal template; a chosen approval mode is included); the **delete** confirm modal dispatches `triggerDelete`. |
| `tests/run-storage-integration.test.ts` (extended) | 8 (7 + **1 new**) | §11.1 the **store**: `project_triggers` + `trigger_fires` are declared `dsh_projects` tables (the set grows by exactly two, v0, no migration); a **fired trigger + its fire record** survive a real JSON domain reopen (a restart does not lose the trigger or its `trigger_fires` dedupe row, and a re-fire after the reopen is idempotent — the same run). |
| `tests/client-triggers-isolation.test.ts` (new) | 1 | §11.7 the client never imports the node-side trigger modules — no `src/client/**` file imports `src/triggers/**` (the client carries mirror types in `controller.ts`; the §8 isolation invariant). |

**Total: 616 tests — 611 passed / 5 failed** (the 5 are the documented
pre-existing environment/load failures, §4 — 3 `project-catalog` macOS
`tmpdir()` cases + up to 2 `integration-strategy` under-load flakes; in
isolation `project-catalog` is exactly 3/6 and `integration-strategy` is 7/7).
**57 new Phase 9 tests** (51 in the five new files + 6 added to the two
extended suites), all green.

## 2. Acceptance criteria (spec §11) — verified

1. **Store** — `project_triggers` (+ `trigger_fires`) are declared `dsh_projects`
   tables (v0, no migration); records validate against the strict schema (7
   types, per-type `config`, bounded `goalTemplate`); the table set grows by
   exactly two tables. → `trigger-service.test.ts` (schema, CRUD, `manual`
   reserved, secrets) + `run-storage-integration.test.ts` (table set, v0,
   reopen).
2. **Adapters** — the `tracker` adapter wraps the six existing `TaskSource`s (no
   rewrite) and yields a `TriggerEvent` on a ready-state issue; the `schedule`
   adapter computes the next slot and fires on it (deterministic under a fake
   clock); the `webhook` adapter maps a signed payload to a `TriggerEvent`; the
   `system`/`repository-event`/`pr-event` adapters are the minimal real `onEvent`
   path; `manual` is the unchanged `runCreate` path. →
   `trigger-adapters.test.ts` (registry, pull/push sets, all six adapters).
3. **Idempotency** — the same `(triggerId, sourceEventKey)` creates at most one
   run (verified across a duplicate event and a process restart); a disabled
   trigger does not fire; the `schedule` adapter does not re-fire after a
   restart. → `trigger-fire.test.ts` (duplicate no-op, restart no re-fire,
   disabled no-fire) + `trigger-adapters.test.ts` (schedule no re-fire) +
   `run-storage-integration.test.ts` (reopen idempotent re-fire).
4. **Fire** — `fire` renders the `goalTemplate` with the event, creates a run via
   `createRun` (the trigger's `approvalMode` + `source`/`sourceRef`), persists the
   `trigger_fires` dedupe record, records `lastFiredAt`/`lastRunId`, and appends
   the `trigger.fired` run event; the run is inspectable in the existing Runs UI.
   → `trigger-fire.test.ts` (render, `createRun` args, dedupe record,
   `lastFiredAt`/`lastRunId`, `trigger.fired` event, failure contract).
5. **UI** — the Automations tab renders trigger/status/last-run/
   **goal-template/approval-policy** (zh/en); enable/disable + Run now dispatch
   the real RPCs; the Add trigger dialog dispatches `triggerCreate` (type select +
   per-type config + goal template + **approval-mode select**); the config is
   credential-free (no credential value is ever returned to the browser). →
   `dashboard-automations.test.tsx` (tab zh+en, list + approval policy,
   enable/disable, Run now, Add dialog + approval mode, delete) +
   `client-triggers-isolation.test.ts`. **Deferred to Phase 11** (spec §12 "no
   full Automations page polish"): the `next-run` (`nextRunAt`) column and the
   trigger **detail view** — the working tab ships without them (see §3).
6. **RPC** — `triggerList`/`triggerCreate`/`triggerGet`/`triggerUpdate`/
   `triggerSetEnabled`/`triggerDelete`/`triggerFire` dispatch with validation;
   absent-service structured failures; the new `trigger.*` error codes (with
   `params`). → `rpc-handler.test.ts` (7 endpoints, validation, not-mounted, the
   `trigger.*` rejections with `params`).
7. **Repo green** — `pnpm run typecheck` (exit 0), `pnpm run build` (exit 0 —
   client 491.86 kB / host 455.99 kB), full `pnpm vitest run` (611/5 of 616, the
   5 modulo the documented pre-existing environment/load failures, §4).

## 3. Test-stage fixes (made while verifying)

- **`tests/rpc-handler.test.ts`** — filled the §10.4 gap: the Phase 9 build
  covered the happy-path dispatch + shape validation but not the structured
  failure surface. Added 5 cases: `triggerCreate` `invalidCandidate` +
  `containsSecrets`; `triggerUpdate` `unknown` + `invalidCandidate`;
  `triggerSetEnabled` `unknown`; `triggerDelete` `unknown`; `triggerFire`
  `unknown`/`disabled`/`goalEmpty` — each round-tripping its `dashboardCode` +
  `params` through `decodeDashboardError`. (67 → 72 cases.)
- **`src/client/Dashboard.tsx` + `src/client/controller.ts`** — filled the §10.5 /
  §11.5 **approval-policy** gap: the Phase 9 build shipped the Automations tab
  without the spec-required **approval policy** (the `approvalMode` data existed
  in the record but the UI never rendered or set it). Added the **approval-mode
  select** to the Add trigger dialog (dispatched in `triggerCreate`) and the
  **Approval policy** label to each trigger row (the mode label, or the "use
  default" marker). Tightened the client `approvalMode` mirror type to
  `ClientApprovalMode` (the wire validator now checks against
  `CLIENT_APPROVAL_MODES`) so the dynamic `t(`mode.${…}`)` label typechecks.
  **Deferred to Phase 11** (spec §12): the `next-run` column and the trigger
  detail view — the working tab ships without them.
- **`tests/dashboard-automations.test.tsx`** — filled the §10.5 gap for the new
  approval-policy surface: added 2 cases — the row renders the approval policy
  (mode label vs the "use default" marker) and the Add dialog dispatches
  `triggerCreate` with a chosen approval mode. (10 → 12 cases.)
- **Type errors under `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`**
  (all in Phase 9 code, fixed for the §11.7 typecheck gate): the dialog
  `approvalMode` state is `ClientApprovalMode | ''` (matching the Phase 7 run
  pattern) with the submit value cast to `ClientApprovalMode`; the wire validator
  casts the `unknown` to `string` before `includes`; the test `trigger()` helper
  spreads a conditional `approvalMode` (no `undefined` under
  `exactOptionalPropertyTypes`).

## 4. Known pre-existing failures (carried, documented)

`tests/project-catalog.test.ts` — 3 of 6 cases fail on this host because
`tmpdir()` yields `/var/folders/…` while the catalog canonicalizes paths to
`/private/var/folders/…` (macOS symlink). Present since Phase 3 (baseline then
295/3 of 298; Phase 5 336/3 of 339; Phase 6 425/3 of 428; Phase 7 489/3 of
492; Phase 8 547/3 of 550; Phase 9 611/5 of 616 — the 3 tmpdir cases plus
under-load flakes). The fix-vs-document decision is open in `maintain.md`.
Unchanged by Phase 9 (all 57 new Phase 9 tests pass; `project-catalog` is
exactly 3/6 in isolation).

`tests/integration-strategy.test.ts` — the git-worktree cases are flaky
**under full-suite load** (temp-dir / worktree contention); they pass 7/7 in
isolation. Not introduced by Phase 9 (the Phase 9 diff does not touch the merge
strategy).
