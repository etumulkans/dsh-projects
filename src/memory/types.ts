/** DSH Projects Phase 6 — Project Memory domain types (spec §3.1). */

/** The 15 declared memory kinds (master spec §20) — the complete set. */
export const MEMORY_KINDS = [
  'architecture', 'decision', 'convention', 'dependency', 'environment',
  'testing', 'deployment', 'operations', 'research', 'finding',
  'known-problem', 'failure-pattern', 'procedure', 'repository-map',
  'user-preference',
] as const

/** Entry lifecycle. `superseded` and `archived` are history, never deleted. */
export const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]
export type MemoryId = string

/**
 * Durable per-project knowledge record (master spec §20, spec §3.1).
 * `superseded` entries are immutable (audit trail); the system never
 * deletes an entry (supersession/archiving only, master spec §22).
 */
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
