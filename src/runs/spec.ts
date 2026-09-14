/** Harness storage-domain declaration for DSH Projects Run state (Phase 1) + Run Plans (Phase 2) + Tasks (Phase 4) + Approvals (Phase 7). */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { runPlanRecordSchema } from '../plans/spec.ts'
import type { RunPlanRecord } from '../plans/types.ts'
import type { PlanId } from '../plans/types.ts'
import { projectTaskRecordSchema, tokenUsageSchema } from '../tasks/spec.ts'
import type { ProjectTaskRecord } from '../tasks/types.ts'
import type { TaskId } from '../tasks/types.ts'
import { projectMemoryRecordSchema } from '../memory/spec.ts'
import type { MemoryId, ProjectMemoryRecord } from '../memory/types.ts'
import { projectApprovalRecordSchema } from '../approvals/spec.ts'
import type { ApprovalId, ApprovalRequestRecord } from '../approvals/types.ts'
import { projectArtifactRecordSchema } from '../artifacts/spec.ts'
import type { ArtifactId, ProjectArtifactRecord } from '../artifacts/types.ts'
import { projectTriggerRecordSchema, triggerFireRecordSchema } from '../triggers/spec.ts'
import type { ProjectTriggerRecord, TriggerFireRecord, TriggerId } from '../triggers/types.ts'
import type { ProjectRunEventRecord, ProjectRunRecord, RunBudget, RunEventId, RunId } from './types.ts'

// Re-exported for existing importers (the schema lives in `tasks/spec.ts` so
// the runs ↔ tasks spec import edge stays one-way).
export { tokenUsageSchema }

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

/**
 * Additive (Phase 7): the run's budget limits (master spec §30, spec §3.2).
 * All keys optional; a key absent (or the object itself absent) is unlimited
 * for that key. `maxCost` is declared but unenforceable until a cost source
 * exists (spec §5.5) — a plain non-negative number (costs are fractional).
 */
export const runBudgetSchema = z.object({
  maxRuntimeMinutes: z.number().int().min(1).max(100_000).optional(),
  maxTotalTokens: z.number().int().min(1).optional(),
  maxInputTokens: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  maxAgents: z.number().int().min(1).max(50).optional(),
  maxConcurrentAgents: z.number().int().min(1).max(50).optional(),
  maxReplans: z.number().int().min(1).optional(),
  maxRetriesPerTask: z.number().int().min(1).optional(),
  maxCost: z.number().min(0).optional(),
}).strict() as z.ZodType<RunBudget>

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
  /** Additive (Phase 3): prefixed session id (`dsh-coordinator-<uuid>`), not a bare uuid. */
  coordinatorSessionId: nonBlank.optional(),
  /**
   * Additive (Phase 4): per-run task concurrency override. Absent uses the
   * default of 1 (shared working tree for non-Git projects; Git projects
   * isolate every task in its own worktree from Phase 5).
   */
  maxConcurrentAgents: z.number().int().min(1).max(50).optional(),
  // Additive (Phase 5): integration result, set when the run's task branches
  // are merged into the integration branch (spec §3.2).
  integrationBranch: nonBlank.optional(),
  integrationHead: nonBlank.optional(),
  // Additive (Phase 7): approval mode + budget enforcement (master spec §18, §30).
  approvalMode: z.enum(['manual', 'plan', 'guarded', 'autonomous']).optional(),
  budget: runBudgetSchema.optional(),
  budgetWarnings: z.array(z.string()).optional(),
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
  'run.coordinator.started', 'run.coordinator.completed', 'run.coordinator.failed',
  // Additive (Phase 4): task lifecycle. One aggregate materialization event
  // plus per-task ready/started/completed/failed (spec §3.4).
  'tasks.materialized', 'task.ready', 'task.started', 'task.completed', 'task.failed',
  // Additive (Phase 5): the run's integration step (spec §3.3).
  'run.integration.started', 'run.integration.completed', 'run.integration.failed',
  // Additive (Phase 6): memory distillation of a finished run (spec §3.3).
  'run.memory.distilled', 'run.memory.distillation.failed',
  // Additive (Phase 7): the approval-object projection (spec §3.3).
  'run.approval.requested', 'run.approval.resolved',
  // Additive (Phase 7): budget enforcement (spec §5.2).
  'run.budget.warning', 'run.budget.exceeded',
  // Additive (Phase 8): the artifact projection (spec §3.2).
  'artifact.created',
  // Additive (Phase 8): final-report generation failure (spec §6.5).
  'run.report.failed',
  // Additive (Phase 9): a trigger created a run (spec §3.4).
  'trigger.fired',
  // Additive (Phase 10): restart reconciliation — a stale `running` task was
  // interrupted (session gone) before re-queue/fail, and a non-terminal Run
  // was re-driven (spec §3.1).
  'task.interrupted', 'run.recovered',
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
    // Additive (Phase 4): durable Project Task DAG rows.
    tasks: domainTable<TaskId, ProjectTaskRecord>(projectTaskRecordSchema),
    // Additive (Phase 6): durable per-project knowledge (spec §3.1).
    memory: domainTable<MemoryId, ProjectMemoryRecord>(projectMemoryRecordSchema),
    // Additive (Phase 7): durable approval requests (master spec §19, spec §3.1).
    project_approvals: domainTable<ApprovalId, ApprovalRequestRecord>(projectApprovalRecordSchema),
    // Additive (Phase 8): durable run artifacts (master spec §26, spec §3.1).
    project_artifacts: domainTable<ArtifactId, ProjectArtifactRecord>(projectArtifactRecordSchema),
    // Additive (Phase 9): durable trigger rules (master spec §27, spec §3.1).
    project_triggers: domainTable<TriggerId, ProjectTriggerRecord>(projectTriggerRecordSchema),
    // Additive (Phase 9): the trigger idempotency dedupe records (spec §4.2).
    trigger_fires: domainTable<string, TriggerFireRecord>(triggerFireRecordSchema),
  },
})
