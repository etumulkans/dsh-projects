/** Zod schemas for the `dsh_projects` project_triggers + trigger_fires tables (Phase 9, spec §3). */

import { z } from 'zod'
import { APPROVAL_MODES } from '../approvals/types.ts'
import { TRIGGER_TYPES, type ProjectTriggerRecord, type TriggerFireRecord } from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

/**
 * The `goalTemplate` bound (spec §3.1): 500 chars. A longer template is
 * rejected at creation with `trigger.invalidCandidate` (reason
 * `goal-template-too-long`). The bound is enforced by the service
 * (`validateTrigger`); the schema keeps the storage contract strict.
 */
export const MAX_GOAL_TEMPLATE_LENGTH = 500

/**
 * Durable trigger rule record (spec §3.1). Mutable (unlike artifacts): a
 * trigger is a rule the user edits (it has an `updatedAt` + the service
 * exposes update/setEnabled/delete). `config` is `z.record(z.string(),
 * z.unknown())` (the per-type shape is validated by the service, not the
 * table — the approval `payload` / artifact `metadata` pattern).
 */
export const projectTriggerRecordSchema = z.object({
  id,
  projectId: id,
  type: z.enum(TRIGGER_TYPES),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  goalTemplate: nonBlank.max(MAX_GOAL_TEMPLATE_LENGTH),
  approvalMode: z.enum(APPROVAL_MODES).optional(),
  lastFiredAt: timestamp.optional(),
  lastRunId: id.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict() as z.ZodType<ProjectTriggerRecord>

/**
 * The idempotency dedupe record (spec §4.2). The `id` is the deterministic
 * `${triggerId}:${sourceEventKey}` (the dedupe key).
 */
export const triggerFireRecordSchema = z.object({
  id: nonBlank,
  triggerId: id,
  sourceEventKey: nonBlank,
  runId: id,
  firedAt: timestamp,
}).strict() as z.ZodType<TriggerFireRecord>
