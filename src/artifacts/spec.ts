/** Zod schema for the `dsh_projects` project_artifacts table (Phase 8, spec §3.1). */

import { z } from 'zod'
import { ARTIFACT_KINDS, type ProjectArtifactRecord } from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

/**
 * The inline `content` bound (spec §4.1): 64 KB. A `content` longer than this
 * is rejected at creation with `artifact.contentTooLarge` — the caller must
 * store a `path` reference instead. The bound is enforced by the service
 * (`validateArtifact`); the schema keeps the storage contract strict but does
 * not re-check the bound (the service is the single authority).
 */
export const MAX_ARTIFACT_CONTENT_LENGTH = 65_536

/**
 * Durable run artifact record (spec §3.1). Append-only: no `version` and no
 * `updatedAt` (an artifact is never mutated or deleted). `title` is `nonBlank`
 * with a 200-char cap; `content`/`path`/`url`/`metadata` are optional;
 * `metadata` is `z.record(z.string(), z.unknown()).optional()` (the
 * kind-specific shape is validated by the trigger site, not the table — the
 * approval `payload` pattern).
 */
export const projectArtifactRecordSchema = z.object({
  id,
  projectId: id,
  runId: id.optional(),
  taskId: id.optional(),
  kind: z.enum(ARTIFACT_KINDS),
  title: nonBlank.max(200),
  content: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: timestamp,
}).strict() as z.ZodType<ProjectArtifactRecord>
