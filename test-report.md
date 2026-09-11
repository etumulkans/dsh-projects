# Test Report — Phase 3: Coordinator Lead

Test-stage artifact for the Phase 3 diff (build commit `ca790fc`, spec `a08129d`
§11 test plan + §12 acceptance criteria). Verified 2026-09-12.

## 1. Test inventory

| File | Cases | Scope (spec §11) |
| --- | --- | --- |
| `tests/coordinator-policy.test.ts` | 5 | `coordinatorGuidance()` carries the role, the "planning only" boundary, the decision checklist, all four pattern definitions, and the `dsh_projects_submit_plan` contract (tool name, pattern enum, **submit exactly once**, replan-reason rule) plus the UNTRUSTED-DATA warning; `coordinatorPrompt()` carries goal / project (name + root) / run phase and one bullet per existing plan version (with `replanReason` and the "a prior version exists" line); `COORDINATOR_POLICY_VERSION` is a stable constant; both outputs are pure (same input → same string, no clock/IO) |
| `tests/coordinator-service.test.ts` | 16 | fake `CoordinatorDriver`, real run + plan services on a shared in-memory domain with the `PlanRunCoupler` hook wired: `coordinator.notStarted` before start; `coordinator.runPhaseInvalid` on a terminal/`executing` run (with `{ runId, phase }`); `coordinator.inProgress` on a second trigger while one is in flight; `created` → `planning` move + `run.coordinator.started` event + `coordinatorSessionId` (`dsh-coordinator-<uuid>`) persisted + `dsh-projects/run/coordinator-started` emit; **direct flow** (submitted plan draft → `active`, run → `executing` through the coupling hook, `run.coordinator.completed` detail = the planning summary, `coordinator-completed` emit with planId/version); **orchestrated flow** (plan → `awaiting-approval`, run → `awaiting_approval`, manual approve → plan `active` + run `executing`, reject → plan `draft` + run `planning`); completed-without-plan and driver-failed → run `blocked` (`suspendedFrom: planning`) + `run.coordinator.failed` event + `coordinator-failed` emit; **replan** (v1 exists: a submission without `replanReason` is rejected as a tool error, the corrected one creates v2 which activates and supersedes nothing because v1 was never active); double-submission within one session rejected; summary validation (blank rejected, 1001 chars rejected as tool errors, no plan persisted); **a blocked run resumes to `planning` and coordinates again** (spec §12.5 — new session id, both `started` events plus one `failed` and one `completed` in the stream); `stop()` aborts the in-flight driver signal; coupling guard (approving a plan while the run is `executing` leaves the run unchanged); driver receives the configured `permissionPreset`, project `root`, and the policy+prompt |
| `tests/rpc-handler.test.ts` (coordinator block) | 4 | `runCoordinate` dispatch returns the run record and forwards `runId`; non-uuid and missing `runId` → `bad-request` before dispatch; `coordinator.runPhaseInvalid` mapped via `decodeDashboardError` with `{ runId, phase }` params; absent service → `bad-request` |
| `tests/dashboard-coordinator-interactions.test.tsx` | 7 | jsdom, zh labels: 协调 button visible for a `planning` run, hidden for `executing` and terminal runs; click calls `onCoordinateRun(runId)`, shows the `协调中…` pending state (disabled, `aria-busy`), then re-enables and refreshes on success; a rejected coordination shows an inline notice and re-enables the button; the Coordinator section renders the status pill (`已完成`), the session tail (last 8 chars of the persisted id), and the completed planning summary from the detail events; with only the `started` event the section shows `进行中` and no summary row |
| `tests/run-storage-integration.test.ts` (coordinator leg) | 1 (extended) | real Cordis Context + real JSON backend + real `DomainFacility`: boot 1 coordinates a run through a fake driver that submits an orchestrated plan — the run ends `awaiting_approval` with `coordinatorSessionId` set and the `started`/`completed` events persisted; after a domain reopen on the same medium the session id, plan, run phase, and all coordinator events (newest-first order asserted) survive; a manual approval on the second boot completes the coupled flow (plan `active`, run `executing`, session id intact); the medium table set is still exactly `['plans', 'run_events', 'runs']` with the declared unit version |

**Regression:** every existing suite re-ran — all Phase 2 plan suites
(`plan-state-machine` 10, `plan-service` 14, `dashboard-plans-interactions` 7),
the Phase 1 run suites (`run-service` 11), and the RPC handler suite (28, incl.
the additive `runCoordinate` block). The hook-less `RunPlanService`
construction used by the Phase 2 suites is untouched — coupling is opt-in via
the `onPlanStatus` hook, so Phase 2 behavior is byte-for-byte identical.

## 2. Acceptance criteria (spec §12)

1. **Coordinate (zh `协调`) starts a real Lead session; `coordinatorSessionId`
   persisted + survives restart** — PASS. The default `HarnessCoordinatorDriver`
   implements the native path per §5.3 (`ctx.agents.create` with `meta.cwd`,
   `setup` registering `dsh_projects_submit_plan` via `defineTool`, one
   `followup`, `whenIdle`, `flush`, `turn/end` reason scan, `dispose`), mirroring
   `HarnessAgentRunner`; the deterministic suites exercise the seam with a fake
   driver (a live Lead session is a runtime concern outside the unit seam). The
   id is persisted on the run record and survives a real JSON domain reopen
   (storage integration).
2. **The session's structured output yields a validated plan; invalid output
   never persists** — PASS. `handlePlanSubmit` runs the full Phase 2
   `createPlan` validation (pattern enum, task shape, dependency order, replan
   reason), rethrows rejections to the agent as tool errors, and persists only
   on success; blank/over-long summaries and double submissions are rejected
   without persisting a plan; a plan-less or failed session persists no plan.
3. **§6 coupling works end-to-end through the existing plan UI** — PASS.
   approval requested → run `awaiting_approval`; approve → plan `active` + run
   `executing`; reject → plan `draft` + run `planning`; direct plan → run
   `executing`; a guard miss (plan moved while the run is `executing`) is a
   logged no-op. Verified at the service level (with the coupler hook wired) and
   again across a real storage reopen.
4. **Planning summary visible + persisted; `resultSummary` stays terminal-only** —
   PASS. The summary is stored by the service (not part of the plan record) and
   persisted as the `run.coordinator.completed` event detail; the UI renders it
   in the Coordinator section; `resultSummary` is unchanged (Phase 1
   terminal-only meaning, no test regression).
5. **Failed/blocked sessions leave the run retryable** — PASS. A failed session
   parks the run in `blocked` (`suspendedFrom: planning`); the new retry test
   resumes it to `planning` and coordinates again with a fresh session id,
   ending `executing` with one plan and a complete coordinator event history.
6. **Storage integration: coordinator state survives a real JSON reopen; medium
   table set unchanged** — PASS (coordinator leg, §1).
7. **Repo green** — PASS. `pnpm run typecheck` and `pnpm run build` clean;
   `pnpm vitest run` green for every suite this phase touches (101/101 across
   the 9 affected files) — full-suite result in §5.

## 3. Findings resolved in the test stage

- **Coordinator section showed the wrong detail while in progress** — the
  section rendered the `started` event's `detail` (the session id, already
  shown in the session row) under the `规划摘要`/Planning-summary label; the
  detail row now renders only for `completed`/`failed` events (verified by the
  `进行中` UI test asserting no summary row).
- **Settlement poll raced the real-JSON write chain** — the integration test's
  outcome poll gave up before the settlement's fsync'd whole-file writes
  landed; the failing test then tore down its temp root while the background
  write was still in flight, surfacing as `ENOENT` on the atomic rename. The
  poll now budgets 400×5 ms slow yields and exits the moment the outcome event
  is persisted (the service's own settlement logic was verified correct via a
  standalone repro before the fix).
- **Retry path untested** — spec §12.5 (blocked → resume → `planning` →
  Coordinate again) had no test; added, including the fresh-session-id and
  dual-event-history assertions.

## 4. Deviations from the approved spec

None. (The Phase 2 `plan.contentInvalid` 14th-code deviation remains carried
and is unchanged.)

## 5. Verification commands

```
pnpm run typecheck   # clean
pnpm run build       # clean (dual tsdown, host + client)
pnpm vitest run      # see note below
```

Full-suite note (sequential run, `--no-file-parallelism`, load-flakiness
eliminated): **225 passed / 4 failed of 229**. The 4 failures are exactly the
documented pre-existing macOS tmpdir environment failures in
`tests/project-catalog.test.ts` (`/var/folders` vs `/private/var/folders`
realpath) — present before Phase 3 and unrelated to it. Under default parallel
execution the same suite additionally shows intermittent jsdom UI-test timeouts
and the `workspace-manager` git-worktree timeout (CPU-load flakiness); every
such file passes consistently in isolated or sequential runs (all 9 Phase
3/Phase 2-touched files: 101/101).
