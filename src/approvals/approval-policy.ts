/** Pure approval-mode policy (master spec §18, spec §4.2). No I/O. */

import type { ApprovalMode, ApprovalStage } from './types.ts'

/**
 * The mode → gated-stage table. `manual` and `plan` gate both the plan and
 * the merge; `guarded` and `autonomous` gate only the merge. The merge gate
 * applies in ALL modes (the merge is the protection; there is no per-run
 * override in Phase 7 — spec §11).
 */
const POLICY: Readonly<Record<ApprovalMode, readonly ApprovalStage[]>> = {
  manual: ['plan', 'merge'],
  plan: ['plan', 'merge'],
  guarded: ['merge'],
  autonomous: ['merge'],
}

/** Does this mode require an approval object at this stage? Pure. */
export function requiresApproval(mode: ApprovalMode, stage: ApprovalStage): boolean {
  return POLICY[mode].includes(stage)
}
