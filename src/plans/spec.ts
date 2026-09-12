/** Zod schemas for the `dsh_projects` plans table (Phase 2). */

import { z } from 'zod'
import type { PlannedTask, PlanSuccessCriterion, RunPlanPattern, RunPlanRecord, RunPlanStatus } from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

export const RUN_PLAN_PATTERNS = [
  'direct', 'prompt-chain', 'parallel-workers', 'supervisor', 'router', 'evaluation-loop',
] as const satisfies readonly RunPlanPattern[]

export const RUN_PLAN_STATUSES = [
  'draft', 'awaiting-approval', 'active', 'superseded', 'completed',
] as const satisfies readonly RunPlanStatus[]

export const planSuccessCriterionSchema = z.object({
  id: z.string().regex(/^c[1-9][0-9]*$/),
  description: nonBlank,
}).strict() as z.ZodType<PlanSuccessCriterion>

export const plannedTaskSchema = z.object({
  id: z.string().regex(/^t[1-9][0-9]*$/),
  title: nonBlank,
  description: nonBlank,
  role: nonBlank.optional(),
  dependencies: z.array(z.string().regex(/^t[1-9][0-9]*$/)).default([]),
  acceptanceCriteria: z.array(nonBlank).default([]),
}).strict() as z.ZodType<PlannedTask>

export const runPlanRecordSchema = z.object({
  id,
  runId: id,
  projectId: id,
  version: z.number().int().min(1),
  pattern: z.enum(RUN_PLAN_PATTERNS),
  rationale: nonBlank,
  assumptions: z.array(nonBlank).default([]),
  successCriteria: z.array(planSuccessCriterionSchema).default([]),
  tasks: z.array(plannedTaskSchema).default([]),
  status: z.enum(RUN_PLAN_STATUSES),
  replanReason: nonBlank.optional(),
  supersedesPlanId: id.optional(),
  createdAt: timestamp,
  revision: z.number().int().min(1),
}).strict() as z.ZodType<RunPlanRecord>
