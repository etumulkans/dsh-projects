/** DSH Projects Phase 7 — Approvals domain types (spec §3.1, §4). */

/**
 * The six declared approval types (master spec §19). Phase 7 has trigger
 * sites for `plan` and `merge` only; the other four are declared in the
 * schema and supported generically by the RPC/UI (no fake trigger sites —
 * spec §11).
 */
export const APPROVAL_TYPES = [
  'plan', 'external-write', 'git-push', 'pull-request', 'merge', 'dangerous-action',
] as const

/** Object lifecycle. `expired` is reached only by an explicit call (no TTL — spec §11). */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const

/** The four approval modes (master spec §18). */
export const APPROVAL_MODES = ['manual', 'plan', 'guarded', 'autonomous'] as const

export type ApprovalType = (typeof APPROVAL_TYPES)[number]
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export type ApprovalMode = (typeof APPROVAL_MODES)[number]
export type ApprovalId = string

/** The gated stages that have a trigger site in Phase 7 (spec §4.2). */
export type ApprovalStage = 'plan' | 'merge'

/**
 * Durable approval request (master spec §19, spec §3.1). Terminal objects are
 * retained for the audit trail — the system never deletes an approval
 * (supersession only, spec §4.3).
 */
export interface ApprovalRequestRecord {
  readonly id: ApprovalId
  readonly projectId: string
  readonly runId: string
  readonly type: ApprovalType
  /** 1..500 chars; the human-readable summary of what is being approved. */
  readonly summary: string
  /** Structured context for the type (e.g. branch names for merge). */
  readonly payload?: unknown
  readonly status: ApprovalStatus
  readonly requestedAt: string
  readonly resolvedAt?: string
  /** 1..200 chars; who resolved (defaults to `'dashboard'`). */
  readonly resolvedBy?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

/**
 * Fired by the plan service at the three existing plan-approval transition
 * points (spec §4.4): `awaiting-approval` → `requested`, `active` →
 * `approved`, `draft` (from `awaiting-approval`) → `rejected`.
 */
export interface PlanApprovalEvent {
  readonly runId: string
  readonly planId: string
  readonly version: number
  readonly action: 'requested' | 'approved' | 'rejected'
  readonly summary: string
}
