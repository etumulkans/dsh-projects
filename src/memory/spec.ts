/** Zod schema for the `dsh_projects` memory table (Phase 6, spec §3.1). */

import { z } from 'zod'
import { MEMORY_KINDS, MEMORY_STATUSES, type ProjectMemoryRecord } from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

/**
 * Durable per-project knowledge record (spec §3.1). Bound validation:
 * title ≤ 200, body ≤ 12 000, ≤ 20 tags of ≤ 40 chars each — enforced by
 * the service (§4.2); the schema keeps the storage contract strict.
 */
export const projectMemoryRecordSchema = z.object({
  id,
  projectId: id,
  kind: z.enum(MEMORY_KINDS),
  title: nonBlank.max(200),
  body: nonBlank.max(12_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  sourceRunId: id.optional(),
  sourceTaskId: id.optional(),
  sourceSessionId: nonBlank.optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(MEMORY_STATUSES),
  supersedes: id.optional(),
  pinned: z.boolean().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  version: z.number().int().min(1),
}).strict() as z.ZodType<ProjectMemoryRecord>
