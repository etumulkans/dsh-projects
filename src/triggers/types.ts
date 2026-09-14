/**
 * DSH Projects Phase 9 — Trigger domain types (spec §3, §5).
 *
 * A `ProjectTriggerRecord` is a durable, per-project automation rule that
 * creates Project Runs from events. The `type` union is a superset of
 * `ProjectRunSource` (it adds `pr-event`, split out per master spec §27).
 * `manual` is never persisted — it is the implicit `runCreate` path.
 */

import type { ApprovalMode } from '../approvals/types.ts'
import type { ProjectId } from '../catalog/types.ts'
import type { RunId } from '../runs/types.ts'

/** The seven trigger types (master spec §27). `manual` is the implicit runCreate path. */
export const TRIGGER_TYPES = [
  'manual', 'tracker', 'schedule', 'webhook', 'repository-event', 'pr-event', 'system',
] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]

export type TriggerId = string

/** Durable trigger rule stored in the `dsh_projects` domain `project_triggers` table. */
export interface ProjectTriggerRecord {
  readonly id: TriggerId
  readonly projectId: ProjectId
  readonly type: TriggerType
  readonly enabled: boolean
  /** Per-type payload (spec §3.3), credential-free (a secret is a ref, never a value). */
  readonly config: Record<string, unknown>
  /** 1..500 chars; `{{placeholder}}` tokens filled from the firing event. */
  readonly goalTemplate: string
  /** The per-trigger approval policy applied to the runs it creates (Phase 7). */
  readonly approvalMode?: ApprovalMode
  /** Set by the fire path (the "Last run" the Automations UI shows). */
  readonly lastFiredAt?: string
  readonly lastRunId?: RunId
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * The idempotency dedupe record (spec §4.2). The deterministic id
 * `${triggerId}:${sourceEventKey}` makes the dedupe restart-safe.
 */
export interface TriggerFireRecord {
  readonly id: string
  readonly triggerId: TriggerId
  readonly sourceEventKey: string
  readonly runId: RunId
  readonly firedAt: string
}

/** The `triggerCreate` RPC / service input (spec §5.2). */
export interface TriggerCreateInput {
  readonly projectId: ProjectId
  readonly type: string
  readonly config: Record<string, unknown>
  readonly goalTemplate: string
  readonly approvalMode?: ApprovalMode
}

/** The `triggerUpdate` RPC / service input (a partial patch, spec §5.2). */
export interface TriggerUpdateInput {
  readonly goalTemplate?: string
  readonly config?: Record<string, unknown>
  readonly approvalMode?: ApprovalMode
}

/** One firing event yielded by a `TriggerAdapter` (spec §5.5). */
export interface TriggerEvent {
  /** The stable dedupe key (spec §4.1). */
  readonly sourceEventKey: string
  /** The `{{placeholder}}` values for the goal template. */
  readonly data: Record<string, string>
}

/** The context handed to a `TriggerAdapter` (spec §5.5). */
export interface TriggerAdapterContext {
  /** Fire one event for the trigger (the idempotent run-creation path). */
  readonly fire: (trigger: ProjectTriggerRecord, event: TriggerEvent) => Promise<unknown>
  /** The deterministic clock (the schedule adapter's time source). */
  readonly clock: () => string
  /** The scoped task-source registry (the tracker adapter's read-side seam). */
  readonly sources: {
    readonly requireScoped: (scope: string, kind: string) => {
      readonly listIssuesByStates: (states: readonly string[], signal?: AbortSignal) => Promise<readonly {
        readonly nativeRef: string
        readonly identifier: string
        readonly title: string
        readonly state: { readonly name: string }
        readonly url?: string
      }[]>
    }
  }
}

/**
 * The `TriggerAdapter` seam (spec §5.5). One adapter per type: `poll` for the
 * pull-based adapters (tracker/schedule), `onEvent` for the push-based ones
 * (webhook/repository-event/pr-event/system).
 */
export interface TriggerAdapter {
  readonly type: TriggerType
  poll?(trigger: ProjectTriggerRecord, ctx: TriggerAdapterContext): Promise<readonly TriggerEvent[]>
  onEvent?(trigger: ProjectTriggerRecord, event: TriggerEvent): void
}
