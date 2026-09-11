/**
 * DSH Projects Phase 3 — guarded Run–plan phase coupling (spec §6).
 *
 * Observes plan status-change events (via the `RunPlanService` hook) and moves
 * the run's lifecycle phase, guarded by the run phase. The run state machine
 * remains the single authority: a guard miss (unexpected run phase) is a
 * no-op, logged, never an error.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectRunService } from '../runs/run-service.ts'
import type { PlanStatusChangedEvent } from '../plans/plan-service.ts'

/**
 * Applies the Phase 3 run-phase coupling for plan status changes:
 *
 * | plan `to`            | run phase required            | run transition  |
 * | -------------------- | ----------------------------- | --------------- |
 * | `awaiting-approval`  | `planning`                    | → awaiting_approval |
 * | `active`             | `planning` or `awaiting_approval` | → executing |
 * | `draft` (rejected)   | `awaiting_approval`           | → planning      |
 *
 * Every other run phase is untouched, so Phase 2 manual flows stay intact.
 */
export class PlanRunCoupler {
  constructor(
    private readonly ctx: Context,
    private readonly runService: ProjectRunService,
  ) {}

  /** Guarded run transition for one plan status change; never throws. */
  async handle(event: PlanStatusChangedEvent): Promise<void> {
    let toPhase: 'awaiting_approval' | 'executing' | 'planning' | undefined
    switch (event.to) {
      case 'awaiting-approval':
        toPhase = 'awaiting_approval'
        break
      case 'active':
        toPhase = 'executing'
        break
      case 'draft':
        toPhase = 'planning'
        break
      default:
        return
    }
    try {
      const run = await this.runService.runDetail(event.runId)
      if (!this.guardAllows(run.run.phase, event.to)) return
      await this.runService.transitionRun(event.runId, toPhase)
    } catch (error) {
      // A guard miss, concurrent move, or terminal run is a no-op by design;
      // the plan transition stands and the run phase simply does not follow.
      this.ctx.logger.warn(
        `dsh-projects: plan coupling did not move run ${event.runId} to ${toPhase} ` +
          `(plan ${event.planId} v${event.version} → ${event.to}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Whether the run phase is one from which this plan transition may move it. */
  private guardAllows(runPhase: string, planTo: PlanStatusChangedEvent['to']): boolean {
    switch (planTo) {
      case 'awaiting-approval':
        return runPhase === 'planning'
      case 'active':
        return runPhase === 'planning' || runPhase === 'awaiting_approval'
      case 'draft':
        return runPhase === 'awaiting_approval'
      default:
        return false
    }
  }
}
