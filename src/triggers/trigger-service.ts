/**
 * DSH Projects Phase 9 — ProjectTriggerService (spec §5).
 *
 * Host-only (the client never imports it — the Phase 6/7/8 isolation invariant
 * extends: a scan asserts no `src/client/**` file imports `src/triggers/**`).
 *
 * Stores durable trigger rules (`project_triggers`) and the idempotency dedupe
 * records (`trigger_fires`), and fires them: a fire renders the `goalTemplate`,
 * creates a run via `ProjectRunService.createRun` (the trigger's `approvalMode` +
 * `source`/`sourceRef`), and is idempotent across duplicate events and process
 * restarts (check-then-put on `${triggerId}:${sourceEventKey}`).
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import type { ProjectCatalogSelection } from '../catalog/types.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import type { ProjectRunEventRecord, ProjectRunRecord, ProjectRunSource } from '../runs/types.ts'
import { SECRET_PATTERNS } from '../memory/memory-service.ts'
import { ScopedTaskSourceRegistry, type TaskSourceRegistry } from '../task-source/index.ts'
import { renderGoalTemplate } from './goal-template.ts'
import { MAX_GOAL_TEMPLATE_LENGTH } from './spec.ts'
import {
  TRIGGER_TYPES,
  type ProjectTriggerRecord,
  type TriggerAdapter,
  type TriggerAdapterContext,
  type TriggerCreateInput,
  type TriggerEvent,
  type TriggerId,
  type TriggerType,
  type TriggerUpdateInput,
} from './types.ts'

/** Payload of the `dsh-projects/trigger/*` Cordis events (spec §5). */
export interface TriggerLifecycleEvent {
  readonly id: TriggerId
  readonly projectId: string
  readonly type: TriggerType
  readonly enabled?: boolean
  readonly runId?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A trigger was created (persisted first). */
    'dsh-projects/trigger/created'(event: TriggerLifecycleEvent): void
    /** A trigger was updated. */
    'dsh-projects/trigger/updated'(event: TriggerLifecycleEvent): void
    /** A trigger's enabled flag changed. */
    'dsh-projects/trigger/setEnabled'(event: TriggerLifecycleEvent): void
    /** A trigger was deleted. */
    'dsh-projects/trigger/deleted'(event: TriggerLifecycleEvent): void
    /** A trigger created a run (the run is persisted first). */
    'dsh-projects/trigger/fired'(event: TriggerLifecycleEvent): void
    /** A push-based adapter received an event for a trigger (the onEvent path). */
    'dsh-projects/trigger/event'(event: {
      readonly triggerId: TriggerId
      readonly type: TriggerType
      readonly sourceEventKey: string
      readonly data: Record<string, string>
    }): void
  }
}

/** The trigger type → run source mapping (spec §3.2). `pr-event` maps to the closest existing source. */
const TRIGGER_TYPE_TO_RUN_SOURCE: Record<TriggerType, ProjectRunSource> = {
  manual: 'manual',
  tracker: 'tracker',
  schedule: 'schedule',
  webhook: 'webhook',
  'repository-event': 'repository-event',
  'pr-event': 'repository-event',
  system: 'system',
}

/** The run goal bound (reused from the run service — a rendered goal must fit a run). */
const MAX_GOAL_LENGTH = 4_000

const TRACKER_SOURCE_KINDS = ['linear', 'github', 'jira', 'asana', 'gitlab', 'local'] as const

export type TriggerInvalidReason =
  | 'unknown-type'
  | 'manual-reserved'
  | 'empty-goal-template'
  | 'goal-template-too-long'
  | 'invalid-config'
  | 'contains-secrets'

/**
 * The pure trigger validation (spec §5.4). Enforces: the `type` is a known
 * `TRIGGER_TYPES` member (not `manual`); the `goalTemplate` is non-empty (1..500);
 * the per-type `config` is valid (spec §3.3); the `approvalMode` (when present) is
 * a known `ApprovalMode`; and a secrets scan (a `config`/`goalTemplate` containing
 * what looks like a secret is rejected; a webhook `secretRef` is a *ref* and is
 * allowed). No semantic judgment beyond the hard limits.
 */
export function validateTrigger(input: TriggerCreateInput): {
  readonly type: TriggerType
  readonly config: Record<string, unknown>
  readonly goalTemplate: string
  readonly approvalMode?: import('../approvals/types.ts').ApprovalMode
} {
  if (!(TRIGGER_TYPES as readonly string[]).includes(input.type)) {
    throw new DashboardDomainError('trigger.invalidCandidate', `unknown trigger type ${input.type}`, {
      reason: 'unknown-type',
      type: input.type,
    })
  }
  if (input.type === 'manual') {
    throw new DashboardDomainError('trigger.manualReserved', 'manual is the implicit runCreate path; it cannot be persisted as a trigger', {
      reason: 'manual-reserved',
    })
  }
  const goalTemplate = input.goalTemplate.trim()
  if (goalTemplate === '') {
    throw new DashboardDomainError('trigger.invalidCandidate', 'a trigger goal template must not be empty', {
      reason: 'empty-goal-template',
    })
  }
  if (goalTemplate.length > MAX_GOAL_TEMPLATE_LENGTH) {
    throw new DashboardDomainError('trigger.invalidCandidate', `a trigger goal template must be at most ${MAX_GOAL_TEMPLATE_LENGTH} characters`, {
      reason: 'goal-template-too-long',
      maxLength: MAX_GOAL_TEMPLATE_LENGTH,
    })
  }
  const config = validateConfig(input.type as TriggerType, input.config)
  if (input.approvalMode !== undefined && !isApprovalMode(input.approvalMode)) {
    throw new DashboardDomainError('trigger.invalidCandidate', `unknown approval mode ${String(input.approvalMode)}`, {
      reason: 'invalid-config',
      field: 'approvalMode',
    })
  }
  const secret = findSecret(goalTemplate, input.config)
  if (secret !== undefined) {
    throw new DashboardDomainError('trigger.containsSecrets', `the trigger ${input.type} config contains what looks like a secret`, {
      reason: secret,
    })
  }
  return {
    type: input.type as TriggerType,
    config,
    goalTemplate,
    ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
  }
}

function isApprovalMode(value: unknown): value is import('../approvals/types.ts').ApprovalMode {
  return value === 'manual' || value === 'plan' || value === 'guarded' || value === 'autonomous'
}

/** The per-type `config` validation (spec §3.3). */
function validateConfig(type: TriggerType, config: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'tracker': {
      const sourceKind = config.sourceKind
      if (typeof sourceKind !== 'string' || !TRACKER_SOURCE_KINDS.includes(sourceKind as (typeof TRACKER_SOURCE_KINDS)[number])) {
        throw new DashboardDomainError('trigger.invalidCandidate', 'a tracker trigger requires a valid `sourceKind` (linear/github/jira/asana/gitlab/local)', {
          reason: 'invalid-config', field: 'sourceKind',
        })
      }
      const readyStates = config.readyStates
      if (!Array.isArray(readyStates) || readyStates.length === 0 || readyStates.some(s => typeof s !== 'string' || s.trim() === '')) {
        throw new DashboardDomainError('trigger.invalidCandidate', 'a tracker trigger requires a non-empty `readyStates` array', {
          reason: 'invalid-config', field: 'readyStates',
        })
      }
      return { sourceKind, readyStates }
    }
    case 'schedule': {
      const everyMs = config.everyMs
      const cron = config.cron
      const hasEvery = typeof everyMs === 'number' && Number.isFinite(everyMs) && everyMs >= 1000
      const hasCron = typeof cron === 'string' && cron.trim() !== ''
      if (hasEvery === hasCron) {
        throw new DashboardDomainError('trigger.invalidCandidate', 'a schedule trigger requires exactly one of `everyMs` (>= 1000) or `cron`', {
          reason: 'invalid-config', field: 'everyMs/cron',
        })
      }
      const timezone = config.timezone
      if (timezone !== undefined && (typeof timezone !== 'string' || timezone.trim() === '')) {
        throw new DashboardDomainError('trigger.invalidCandidate', 'a schedule trigger `timezone` must be a non-empty string', {
          reason: 'invalid-config', field: 'timezone',
        })
      }
      const out: Record<string, unknown> = {}
      if (hasEvery) out.everyMs = everyMs
      if (hasCron) out.cron = cron
      if (timezone !== undefined) out.timezone = timezone
      return out
    }
    case 'webhook': {
      const path = config.path
      if (typeof path !== 'string' || path.trim() === '') {
        throw new DashboardDomainError('trigger.invalidCandidate', 'a webhook trigger requires a non-empty `path`', {
          reason: 'invalid-config', field: 'path',
        })
      }
      const secretRef = config.secretRef
      if (typeof secretRef !== 'string' || secretRef.trim() === '') {
        throw new DashboardDomainError('trigger.invalidCandidate', 'a webhook trigger requires a non-empty `secretRef` (a ref, never a value)', {
          reason: 'invalid-config', field: 'secretRef',
        })
      }
      return { path, secretRef }
    }
    case 'repository-event':
    case 'pr-event':
    case 'system': {
      const event = config.event
      if (typeof event !== 'string' || event.trim() === '') {
        throw new DashboardDomainError('trigger.invalidCandidate', `${type} trigger requires a non-empty 'event'`, {
          reason: 'invalid-config', field: 'event',
        })
      }
      return { event }
    }
    case 'manual':
      // Unreachable (manual is rejected above); satisfies the exhaustiveness check.
      throw new DashboardDomainError('trigger.manualReserved', 'manual is the implicit runCreate path', { reason: 'manual-reserved' })
  }
}

/** The secrets scan (reused from the Phase 6 memory patterns). Returns the matched reason or undefined. */
function findSecret(goalTemplate: string, config: Record<string, unknown>): string | undefined {
  const haystack = [goalTemplate, JSON.stringify(config)]
  for (const pattern of SECRET_PATTERNS) {
    for (const value of haystack) {
      if (pattern.test(value)) return 'secret-pattern'
    }
  }
  return undefined
}

interface TriggerTables {
  readonly triggers: {
    readonly get: (id: TriggerId) => ProjectTriggerRecord | undefined
    readonly put: (id: TriggerId, record: ProjectTriggerRecord) => Promise<void>
    readonly delete: (id: TriggerId) => Promise<boolean>
    readonly entries: () => IterableIterator<[TriggerId, ProjectTriggerRecord]>
  }
  readonly fires: {
    readonly get: (id: string) => import('./types.ts').TriggerFireRecord | undefined
    readonly put: (id: string, record: import('./types.ts').TriggerFireRecord) => Promise<void>
    readonly entries: () => IterableIterator<[string, import('./types.ts').TriggerFireRecord]>
  }
  readonly runs: { readonly get: (id: string) => ProjectRunRecord | undefined }
  readonly events: { readonly put: (id: string, record: ProjectRunEventRecord) => Promise<void>; readonly entries: () => IterableIterator<[string, ProjectRunEventRecord]> }
}

export class ProjectTriggerService {
  private tables: TriggerTables | undefined
  private readonly removeListeners: Array<() => void> = []

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly runService: ProjectRunService,
    private readonly sources: TaskSourceRegistry,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Borrow the shared domain tables + register the push-based adapter listeners; requires the Run service to be started. */
  start(): void {
    if (this.tables !== undefined) throw new Error('dsh-projects: Trigger service is already started')
    const domain = this.runService.domain()
    this.tables = {
      triggers: domain.table('project_triggers'),
      fires: domain.table('trigger_fires'),
      runs: domain.table('runs'),
      events: domain.table('run_events'),
    }
  }

  /** Drop table references + the listeners. Idempotent. */
  stop(): void {
    for (const remove of this.removeListeners.splice(0)) remove()
    this.tables = undefined
  }

  /** §5.2 — persist a new trigger. Validates type + per-type config + goalTemplate (§5.4). `manual` is rejected. */
  async create(input: TriggerCreateInput): Promise<ProjectTriggerRecord> {
    const tables = this.requireStarted()
    this.requireProject(input.projectId)
    const fields = validateTrigger(input)
    const now = this.clock()
    const record: ProjectTriggerRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      type: fields.type,
      enabled: true,
      config: fields.config,
      goalTemplate: fields.goalTemplate,
      ...(fields.approvalMode === undefined ? {} : { approvalMode: fields.approvalMode }),
      createdAt: now,
      updatedAt: now,
    }
    await tables.triggers.put(record.id, record)
    this.ctx.emit('dsh-projects/trigger/created', { id: record.id, projectId: record.projectId, type: record.type })
    return record
  }

  /** §5.2 — list triggers (newest first). */
  list(projectId: string): ProjectTriggerRecord[] {
    const tables = this.requireStarted()
    const rows: ProjectTriggerRecord[] = []
    for (const [, record] of tables.triggers.entries()) {
      if (record.projectId === projectId) rows.push(record)
    }
    // Newest first: createdAt descending, with insertion order as the tiebreak
    // (a Map preserves insertion order, so a later-created trigger with an equal
    // timestamp sorts before an earlier one — deterministic even on a fixed clock).
    const indexed = rows.map((record, index) => ({ record, index }))
    indexed.sort((left, right) =>
      right.record.createdAt.localeCompare(left.record.createdAt) || right.index - left.index)
    return indexed.map(item => item.record)
  }

  /** §5.2 — the full record for the detail view. */
  get(id: TriggerId): ProjectTriggerRecord | undefined {
    const tables = this.requireStarted()
    return tables.triggers.get(id)
  }

  /** §5.2 — update the goal template / config / approval mode (not the enabled flag — use setEnabled). */
  async update(id: TriggerId, patch: TriggerUpdateInput): Promise<ProjectTriggerRecord> {
    const tables = this.requireStarted()
    const current = tables.triggers.get(id)
    if (current === undefined) throw new DashboardDomainError('trigger.unknown', `unknown trigger ${id}`, { id })
    const goalTemplate = patch.goalTemplate !== undefined ? patch.goalTemplate : current.goalTemplate
    const config = patch.config !== undefined ? patch.config : current.config
    const approvalMode = patch.approvalMode !== undefined ? patch.approvalMode : current.approvalMode
    // Re-validate the patched config against the existing type.
    const fields = validateTrigger({
      projectId: current.projectId,
      type: current.type,
      config,
      goalTemplate,
      ...(approvalMode === undefined ? {} : { approvalMode }),
    })
    const updated: ProjectTriggerRecord = {
      ...current,
      config: fields.config,
      goalTemplate: fields.goalTemplate,
      ...(fields.approvalMode === undefined ? {} : { approvalMode: fields.approvalMode }),
      updatedAt: this.clock(),
    }
    await tables.triggers.put(id, updated)
    this.ctx.emit('dsh-projects/trigger/updated', { id, projectId: current.projectId, type: current.type })
    return updated
  }

  /** §5.2 — the only state toggle the UI drives. */
  async setEnabled(id: TriggerId, enabled: boolean): Promise<ProjectTriggerRecord> {
    const tables = this.requireStarted()
    const current = tables.triggers.get(id)
    if (current === undefined) throw new DashboardDomainError('trigger.unknown', `unknown trigger ${id}`, { id })
    const updated: ProjectTriggerRecord = { ...current, enabled, updatedAt: this.clock() }
    await tables.triggers.put(id, updated)
    this.ctx.emit('dsh-projects/trigger/setEnabled', { id, projectId: current.projectId, type: current.type, enabled })
    return updated
  }

  /** §5.2 — delete a trigger (its fire records are kept — the provenance of created runs). */
  async delete(id: TriggerId): Promise<void> {
    const tables = this.requireStarted()
    const current = tables.triggers.get(id)
    if (current === undefined) throw new DashboardDomainError('trigger.unknown', `unknown trigger ${id}`, { id })
    await tables.triggers.delete(id)
    this.ctx.emit('dsh-projects/trigger/deleted', { id, projectId: current.projectId, type: current.type })
  }

  /**
   * §5.3 — fire one trigger for one event. Idempotent (§4): the same
   * `(triggerId, sourceEventKey)` creates at most one run. Returns the created
   * (or already-created) run. A disabled trigger is a no-op (returns undefined).
   */
  async fire(triggerId: TriggerId, event: TriggerEvent): Promise<ProjectRunRecord | undefined> {
    const tables = this.requireStarted()
    const trigger = tables.triggers.get(triggerId)
    if (trigger === undefined) throw new DashboardDomainError('trigger.unknown', `unknown trigger ${triggerId}`, { id: triggerId })
    if (!trigger.enabled) return undefined

    // §4.2 — the dedupe check (restart-safe: the record survives a reopen).
    const dedupeId = `${triggerId}:${event.sourceEventKey}`
    const existing = tables.fires.get(dedupeId)
    if (existing !== undefined) {
      return tables.runs.get(existing.runId)
    }

    // §5.3 — render the goal.
    const goal = renderGoalTemplate(trigger.goalTemplate, event.data).trim()
    if (goal === '') {
      throw new DashboardDomainError('trigger.goalEmpty', 'the rendered trigger goal is empty', {
        id: triggerId, template: trigger.goalTemplate,
      })
    }
    if (goal.length > MAX_GOAL_LENGTH) {
      throw new DashboardDomainError('trigger.goalTooLong', `the rendered trigger goal exceeds ${MAX_GOAL_LENGTH} characters`, {
        id: triggerId, maxLength: MAX_GOAL_LENGTH,
      })
    }

    // §5.3 — create the run via the existing ProjectRunService (the trigger's
    // approvalMode + source/sourceRef).
    const source = TRIGGER_TYPE_TO_RUN_SOURCE[trigger.type]
    const selection: ProjectCatalogSelection = { mode: 'project', projectId: trigger.projectId }
    const run = await this.runService.createRun(
      {
        goal,
        projectId: trigger.projectId,
        source,
        sourceRef: trigger.id,
        ...(trigger.approvalMode === undefined ? {} : { approvalMode: trigger.approvalMode }),
      },
      selection,
    )

    // §5.3 — persist the dedupe record (the deterministic id).
    const now = this.clock()
    await tables.fires.put(dedupeId, {
      id: dedupeId,
      triggerId,
      sourceEventKey: event.sourceEventKey,
      runId: run.id,
      firedAt: now,
    })

    // §5.3 — update the trigger's lastFiredAt/lastRunId.
    const updated: ProjectTriggerRecord = { ...trigger, lastFiredAt: now, lastRunId: run.id, updatedAt: now }
    await tables.triggers.put(triggerId, updated)

    // §5.3 — append the trigger.fired run event to the created run + emit.
    await this.appendRunEvent(tables, {
      runId: run.id,
      projectId: trigger.projectId,
      type: 'trigger.fired',
      title: `Trigger fired: ${trigger.type}`,
      detail: `${trigger.type} trigger ${triggerId} → run ${run.id}`,
      at: now,
    })
    this.ctx.emit('dsh-projects/trigger/fired', { id: triggerId, projectId: trigger.projectId, runId: run.id, type: trigger.type })
    return run
  }

  /**
   * §5.6 — the poll loop integration. Iterates the project's enabled
   * `tracker` + `schedule` triggers, calls each adapter's `poll`, and fires the
   * yielded events (via `fire`, §5.3). A disabled trigger is skipped.
   */
  async pollDueTriggers(): Promise<void> {
    const tables = this.requireStarted()
    const ctx: TriggerAdapterContext = {
      fire: (trigger, event) => this.fire(trigger.id, event),
      clock: this.clock,
      sources: {
        // Scope per trigger project: the service holds the unscoped registry and
        // builds a per-project view (the `scope` is the trigger's projectId).
        requireScoped: (scope, kind) => new ScopedTaskSourceRegistry(this.sources, scope).require(kind),
      },
    }
    for (const [, trigger] of tables.triggers.entries()) {
      if (!trigger.enabled) continue
      const adapter = this.adapters.get(trigger.type)
      if (adapter?.poll === undefined) continue
      let events: readonly TriggerEvent[]
      try {
        events = await adapter.poll(trigger, ctx)
      } catch (error) {
        this.ctx.logger.warn('dsh-projects: trigger %s poll failed: %s', trigger.id, error instanceof Error ? error.message : String(error))
        continue
      }
      for (const event of events) {
        try {
          await this.fire(trigger.id, event)
        } catch (error) {
          this.ctx.logger.warn('dsh-projects: trigger %s fire failed: %s', trigger.id, error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  /**
   * Register a push-based adapter (webhook/system/git-event) for a trigger type.
   * When the Host emits `dsh-projects/trigger/event` for a trigger of this type,
   * the service fires the event (the idempotent run-creation path). The adapter's
   * `onEvent` (when present) is invoked first for type-specific processing (e.g.
   * the webhook signature check); it may throw to reject the event (a warn log,
   * no fire).
   */
  registerAdapter(adapter: TriggerAdapter): void {
    this.adapters.set(adapter.type, adapter)
    const onEvent = adapter.onEvent
    const listener = (event: {
      readonly triggerId: TriggerId
      readonly type: TriggerType
      readonly sourceEventKey: string
      readonly data: Record<string, string>
    }) => {
      if (event.type !== adapter.type) return
      const trigger = this.get(event.triggerId)
      if (trigger === undefined || !trigger.enabled) return
      const triggerEvent: TriggerEvent = { sourceEventKey: event.sourceEventKey, data: event.data }
      if (onEvent !== undefined) {
        try {
          onEvent(trigger, triggerEvent)
        } catch (error) {
          this.ctx.logger.warn('dsh-projects: trigger %s onEvent rejected: %s', trigger.id, error instanceof Error ? error.message : String(error))
          return
        }
      }
      void this.fire(trigger.id, triggerEvent).catch(error => {
        this.ctx.logger.warn('dsh-projects: trigger %s onEvent fire failed: %s', trigger.id, error instanceof Error ? error.message : String(error))
      })
    }
    this.removeListeners.push(this.ctx.on('dsh-projects/trigger/event', listener))
  }

  private readonly adapters = new Map<TriggerType, TriggerAdapter>()

  /** §3.4 — append on the run's per-run seq (the existing appendRunEvent pattern). */
  private async appendRunEvent(tables: TriggerTables, input: {
    readonly runId: string
    readonly projectId: string
    readonly type: ProjectRunEventRecord['type']
    readonly title: string
    readonly detail: string
    readonly at: string
  }): Promise<void> {
    let seq = 0
    for (const [, existing] of tables.events.entries()) {
      if (existing.runId === input.runId && existing.seq > seq) seq = existing.seq
    }
    const record: ProjectRunEventRecord = {
      id: randomUUID(),
      runId: input.runId,
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      detail: input.detail,
      seq: seq + 1,
      at: input.at,
    }
    await tables.events.put(record.id, record)
  }

  private requireProject(projectId: string): void {
    if (this.catalog.project(projectId) === undefined) {
      throw new DashboardDomainError('trigger.badRequest', `unknown project ${projectId}`, { projectId })
    }
  }

  private requireStarted(): TriggerTables {
    const tables = this.tables
    if (tables === undefined) throw new DashboardDomainError('trigger.notStarted', 'Trigger service is not started')
    return tables
  }
}
