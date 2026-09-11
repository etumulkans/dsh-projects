/** Harness storage-domain declaration for DSH Projects Run state (Phase 1) + Run Plans (Phase 2). */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { runPlanRecordSchema } from '../plans/spec.ts'
import type { RunPlanRecord } from '../plans/types.ts'
import type { PlanId } from '../plans/types.ts'
import type { ProjectRunEventRecord, ProjectRunRecord, RunEventId, RunId } from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

const tokenUsageSchema = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
  cacheWrite: z.number().int().min(0),
  reasoning: z.number().int().min(0),
  total: z.number().int().min(0),
})

export const projectRunRecordSchema = z.object({
  id,
  projectId: id,
  goal: nonBlank,
  source: z.enum(['manual', 'tracker', 'schedule', 'webhook', 'repository-event', 'system']),
  sourceRef: nonBlank.optional(),
  phase: z.enum([
    'created', 'planning', 'awaiting_approval', 'executing', 'integrating',
    'validating', 'finalizing', 'succeeded', 'failed', 'canceled', 'paused', 'blocked',
  ]),
  suspendedFrom: z.enum([
    'created', 'planning', 'awaiting_approval', 'executing', 'integrating',
    'validating', 'finalizing',
  ]).optional(),
  startedAt: timestamp.optional(),
  completedAt: timestamp.optional(),
  tokenUsage: tokenUsageSchema.optional(),
  resultSummary: nonBlank.optional(),
  error: nonBlank.optional(),
  /** Additive (Phase 2): the plan currently active for this run, if any. */
  activePlanId: id.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  phaseChangedAt: timestamp,
  version: z.number().int().min(1),
}).strict() as z.ZodType<ProjectRunRecord>

/**
 * High-level run event stream (Phase 1 run events + Phase 2 plan events).
 * Extending the enum is additive: stored records are unchanged, so the
 * domain version stays 0 (architecture doc §4).
 */
export const RUN_EVENT_TYPES = [
  'run.created', 'run.phase.changed', 'run.completed',
  'plan.created', 'plan.approval.requested', 'plan.approved', 'plan.rejected',
  'plan.superseded', 'plan.completed', 'run.replanned',
] as const satisfies readonly ProjectRunEventRecord['type'][]

export const projectRunEventRecordSchema = z.object({
  id,
  runId: id,
  projectId: id,
  type: z.enum(RUN_EVENT_TYPES),
  title: nonBlank,
  detail: nonBlank.optional(),
  seq: z.number().int().min(1),
  at: timestamp,
}).strict() as z.ZodType<ProjectRunEventRecord>

export const dshProjectsDomainSpec = defineDomain({
  name: 'dsh_projects',
  // Version 0 introduces the domain. Later phases add tables additively
  // (storage-domain initializes absent declared tables as empty); a format
  // change to existing records bumps the version with a migration.
  version: 0,
  tables: {
    runs: domainTable<RunId, ProjectRunRecord>(projectRunRecordSchema),
    run_events: domainTable<RunEventId, ProjectRunEventRecord>(projectRunEventRecordSchema),
    // Additive (Phase 2): versioned Run Plans.
    plans: domainTable<PlanId, RunPlanRecord>(runPlanRecordSchema),
  },
})
