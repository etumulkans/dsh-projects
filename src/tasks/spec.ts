/** Zod schemas for the `dsh_projects` tasks table (Phase 4). */

import { z } from 'zod'
import type { ProjectTaskRecord, ProjectTaskStatus } from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

/**
 * Token usage counter. Defined here (not in `runs/spec.ts`) so that the
 * runs ↔ tasks spec import edge stays one-way: `runs/spec.ts` imports from
 * this module, never the reverse.
 */
export const tokenUsageSchema = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
  cacheWrite: z.number().int().min(0),
  reasoning: z.number().int().min(0),
  total: z.number().int().min(0),
})

export const TASK_STATUSES = [
  'pending', 'ready', 'running', 'blocked', 'awaiting-review',
  'succeeded', 'failed', 'canceled',
] as const satisfies readonly ProjectTaskStatus[]

/**
 * Durable task record (spec §3.2). `awaiting-review` is declared for schema
 * completeness (master spec §11) but unreachable in Phase 4; `workspaceId`
 * is reserved for Phase 5 and never written by Phase 4.
 */
export const projectTaskRecordSchema = z.object({
  id,
  runId: id,
  planId: id,
  planTaskId: z.string().regex(/^t[1-9][0-9]*$/),
  title: nonBlank,
  description: nonBlank,
  role: nonBlank.optional(),
  dependencies: z.array(id).default([]),
  status: z.enum(TASK_STATUSES),
  assignedAgentId: nonBlank.optional(),
  workspaceId: nonBlank.optional(),
  acceptanceCriteria: z.array(nonBlank).default([]),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).optional(),
  outputSummary: nonBlank.optional(),
  error: nonBlank.optional(),
  tokenUsage: tokenUsageSchema.optional(),
  turnCount: z.number().int().min(0).optional(),
  startedAt: timestamp.optional(),
  completedAt: timestamp.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  version: z.number().int().min(1),
}).strict() as z.ZodType<ProjectTaskRecord>
