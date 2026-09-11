# Test Report — Phase 2: Versioned Run Plans

Test-stage artifact for the Phase 2 diff (build commit `6118085`, spec `7d797ca`
§10 test plan + §11 acceptance criteria). Verified 2026-09-11.

## 1. Test inventory

| File | Cases | Scope (spec §10) |
| --- | --- | --- |
| `tests/plan-state-machine.test.ts` | 10 | full status table, every allowed edge, forbidden edges (self, terminal→anything, `completed` from non-active), `replanReason` requirement, revision bump on mutating edges only, content immutability |
| `tests/plan-service.test.ts` | 14 | notStarted/double-start/stop idempotency; create validation (each §5.1 code, `direct` with zero tasks, dependency-order violations, missing replan reason on v2); version numbering v1→v2 with `supersedesPlanId`; activation sets `activePlanId` + supersedes prior active + `run.replanned` event + Cordis emit; supersede-of-active clears `activePlanId`; `expectedRevision` conflict; per-run event scoping (plan events interleaved on the run seq); restart persistence on shared storage; terminal-run rejection; full lifecycle with **all 7 Cordis emits asserted** (§6.2) |
| `tests/rpc-handler.test.ts` (plan block) | 8 | dispatch + record results; payload validation (bad pattern, **non-uuid ids**, negative revision, non-string arrays, bad status); absent-service bad-requests for all four endpoints; `decodeDashboardError` mapping incl. `plan.revisionConflict` params |
| `tests/dashboard-plans-interactions.test.tsx` | 7 | inspector shows versions + status + active chip; expand shows rationale/tasks/dependency markers; draft actions call `onPlanTransition({ planId, status, expectedRevision })`; supersede dialog requires a reason and stays open on failure; New Plan dialog trims, enforces replan reason after v1, earlier-only dependencies, closes on success; **plan events interleaved on the run timeline**; empty state with New Plan for a non-terminal run; terminal run hides New Plan |
| `tests/run-storage-integration.test.ts` | 2 (extended) | real JSON storage: plan created + activated in boot 1, after reopen the `plans` table is on disk, the run's `activePlanId` survives, plan events interleave on the shared seq, a transition continues; medium table set is `['plans', 'run_events', 'runs']`; version-mismatch rejection still enforced |

Existing Phase 1 suites (run service, run state machine, storage, dashboard
render/inspector/i18n, orchestrator, coordinator, …) re-ran unchanged.

## 2. Acceptance criteria (spec §11)

1. **v1 → v2 history, v1 `superseded` with stored reason, both readable** — PASS.
   `plan-service` "numbers replans…": v2 carries `supersedesPlanId`, stored
   `replanReason` (trimmed); both records returned by `planList`/`planDetail`.
   Storage integration re-reads both after reopen.
2. **Immutable content; only `status` moves via validated machine + CAS** — PASS.
   `plan-state-machine` asserts content immutability and the revision-bump rule
   (only `superseded`/`completed`); `plan-service` asserts `plan.revisionConflict`
   with `{ expectedRevision, actualRevision }` params and all forbidden edges.
3. **`activePlanId` set/cleared consistently** — PASS. Activation sets it (run
   version +1); supersede-of-prior-active on a newer activation moves it;
   direct supersede of the active plan clears it (absent property verified, not
   `undefined`); it now survives run phase transitions (state-machine carry-over
   fixed in the test stage) and a process restart (real JSON storage).
4. **Plan events interleaved on the run stream + visible; 7 Cordis events fire** —
   PASS. Event sequences asserted per-run newest-first (incl.
   `run.created → plan.created → plan.approved → plan.created → plan.superseded →
   plan.approved → run.replanned`); the full-lifecycle test asserts every
   `dsh-projects/plan/*` + `dsh-projects/run/replanned` emit with run/project/plan
   ids, version, and from/to; the UI test renders plan events in the run
   inspector timeline.
5. **State survives a process restart against the real JSON backend** — PASS.
   `run-storage-integration` boots two service pairs over the same on-disk medium.
6. **Runs tab + existing behavior unchanged; snapshot version stays 2; RPC
   additive** — PASS. `DashboardSnapshot.version` remains `2`
   (`src/runtime/types.ts`); all Phase 1 suites green; the four plan endpoints
   are additive and answer `bad-request` when the service is absent (same
   convention as the run endpoints).
7. **`pnpm run typecheck`, `pnpm run build`, `pnpm vitest run` green** — PASS.
   Typecheck and build clean; vitest 193 passed / 3 failed (196 total) — the 3
   failures are
   the documented pre-existing macOS tmpdir environment failures in
   `tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
   realpath), present before Phase 2 and unrelated to it.

## 3. Findings resolved in the test stage

- **Missing `dsh-projects/run/replanned` Cordis emit** — the event was persisted
  to `run_events` but never emitted on the bus; added in the build diff
  (verified by the supersede test).
- **Non-uuid plan ids were not rejected as bad requests** — the handler mirrored
  the Phase 1 string check; spec §7 requires non-uuid → `bad-request`. Added
  `readUuidField` to all four plan endpoints with dedicated test cases.
- **`activePlanId` dropped on run phase transitions** — the pure run state
  machine rebuilt records explicitly and lost the field; now carried over
  (verified by storage integration).
- **Coverage gap on Cordis events** — only 3 of 7 emits were asserted; the
  lifecycle test now asserts all 7 with payloads.

## 4. Deviations from the approved spec

- **`plan.contentInvalid` (14th `plan.*` code)** — spec §5.5 lists 13 codes; the
  implementation adds `plan.contentInvalid` for the task description /
  acceptance-criteria / success-criteria length-and-count constraints that §5.1
  constrains but does not name. Client mapping + zh/en locales are complete for
  all 14 (compile-enforced parity).

## 5. Verification commands

```
pnpm run typecheck   # clean
pnpm run build       # clean (dual tsdown, host + client)
pnpm vitest run      # 193 passed, 3 failed (pre-existing env, §2.7)
```
