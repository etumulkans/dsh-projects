/** Zod schema for the `dsh_projects` project_approvals table (Phase 7, spec §3.1). */

import { z } from 'zod'
import { APPROVAL_STATUSES, APPROVAL_TYPES, type ApprovalRequestRecord } from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

/**
 * Durable approval request record (spec §3.1). `summary` is 1..500 chars;
 * `payload` is type-specific structured context validated by the trigger
 * site, not the table.
 */
export const projectApprovalRecordSchema = z.object({
  id,
  projectId: id,
  runId: id,
  type: z.enum(APPROVAL_TYPES),
  summary: nonBlank.max(500),
  payload: z.unknown().optional(),
  status: z.enum(APPROVAL_STATUSES),
  requestedAt: timestamp,
  resolvedAt: timestamp.optional(),
  resolvedBy: nonBlank.max(200).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  version: z.number().int().min(1),
}).strict() as z.ZodType<ApprovalRequestRecord>
