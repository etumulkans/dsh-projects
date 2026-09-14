/** DSH Projects Phase 8 — Artifact domain types (spec §3.1, master spec §26). */

import type { ProjectId } from '../catalog/types.ts'
import type { RunId } from '../runs/types.ts'
import type { TaskId } from '../tasks/types.ts'

/** The 12 declared artifact kinds (master spec §26) — the complete set. */
export const ARTIFACT_KINDS = [
  'plan', 'research-report', 'architecture-note', 'patch', 'diff',
  'test-report', 'validation-report', 'review-report', 'screenshot',
  'log-reference', 'pull-request', 'external-link', 'final-report',
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]
export type ArtifactId = string

/**
 * Durable run artifact record (master spec §26, spec §3.1). Append-only:
 * there is no `version` and no `updatedAt` — an artifact is never mutated or
 * deleted (the durable record of what a run produced). The one exception is
 * the `final-report` regeneration (spec §6.3), which replaces the single
 * existing `final-report` row for a run in place.
 */
export interface ProjectArtifactRecord {
  readonly id: ArtifactId
  readonly projectId: ProjectId
  /** The producing run (most artifacts are run-scoped). */
  readonly runId?: RunId
  /** The producing task (optional finer scope). */
  readonly taskId?: TaskId
  readonly kind: ArtifactKind
  readonly title: string
  /** Inline text, bounded (spec §4.1). */
  readonly content?: string
  /** File reference (no large binaries in JSON storage — spec §4.2). */
  readonly path?: string
  /** External reference (e.g. a PR URL). */
  readonly url?: string
  readonly metadata?: Record<string, unknown>
  readonly createdAt: string
}

/** Input to `ProjectArtifactService.create` (spec §5.2). */
export interface ArtifactCreateInput {
  readonly projectId: string
  readonly runId?: RunId
  readonly taskId?: TaskId
  /** Validated against `ARTIFACT_KINDS`. */
  readonly kind: string
  /** 1..200 chars. */
  readonly title: string
  /** ≤ 64 KB (spec §4.1). */
  readonly content?: string
  readonly path?: string
  readonly url?: string
  readonly metadata?: Record<string, unknown>
}
