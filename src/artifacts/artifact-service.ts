/**
 * DSH Projects Phase 8 — Artifact storage service (spec §5).
 *
 * `ProjectArtifactService` follows the sibling-service pattern exactly
 * (`RunPlanService`/`ProjectTaskService`/`ProjectMemoryService`): it borrows
 * the shared `dsh_projects` domain opened by `ProjectRunService` and owns the
 * `project_artifacts` table (plus `runs`/`run_events` for the
 * `artifact.created` projection). Artifacts are append-only (no update/delete);
 * the one exception is the `final-report` regeneration (spec §6.3), a private
 * in-place replace. The run's terminal transition triggers the final report via
 * the `dsh-projects/run/completed` Cordis event (fire-and-forget).
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import type { ProjectRunEventRecord, ProjectRunRecord, RunEventId, RunId } from '../runs/types.ts'
import type { ProjectTaskRecord, TaskId } from '../tasks/types.ts'
import type { ProjectMemoryRecord, MemoryId } from '../memory/types.ts'
import type { ApprovalRequestRecord, ApprovalId } from '../approvals/types.ts'
import { SECRET_PATTERNS } from '../memory/memory-service.ts'
import { buildFinalReport } from './final-report.ts'
import { MAX_ARTIFACT_CONTENT_LENGTH } from './spec.ts'
import { ARTIFACT_KINDS, type ArtifactCreateInput, type ArtifactId, type ArtifactKind, type ProjectArtifactRecord } from './types.ts'

export const MAX_ARTIFACT_TITLE_LENGTH = 200

/** The §5.3 rejection reasons surfaced as `artifact.invalidCandidate` params. */
export type ArtifactInvalidReason =
  | 'unknown-kind'
  | 'empty-title'
  | 'title-too-long'
  | 'content-too-large'
  | 'missing-url'
  | 'kind-reserved'
  | 'contains-secrets'

const EVENT_DETAIL_LIMIT = 200

function truncateDetail(value: string): string {
  return value.length <= EVENT_DETAIL_LIMIT ? value : `${value.slice(0, EVENT_DETAIL_LIMIT - 1)}…`
}

/**
 * Pure candidate validation (spec §5.3): returns the normalized record fields
 * or throws an `artifact.*` error. Enforces only the hard limits + the secrets
 * scan + the kind-specific rules (§4) — no semantic judgment. The `final-report`
 * kind is rejected here (`artifact.kindReserved`) — it is generator-only.
 */
export function validateArtifact(input: ArtifactCreateInput): {
  readonly kind: ArtifactKind
  readonly title: string
  readonly content?: string
  readonly path?: string
  readonly url?: string
  readonly metadata?: Record<string, unknown>
} {
  if (!(ARTIFACT_KINDS as readonly string[]).includes(input.kind)) {
    throw new DashboardDomainError('artifact.invalidCandidate', `unknown artifact kind ${JSON.stringify(input.kind)}`, { reason: 'unknown-kind' })
  }
  if (input.kind === 'final-report') {
    throw new DashboardDomainError('artifact.kindReserved', 'the final-report kind is reserved for the run completion pipeline (use runGenerateReport)', {
      reason: 'kind-reserved',
    })
  }
  const title = input.title.trim()
  if (title === '') {
    throw new DashboardDomainError('artifact.invalidCandidate', 'an artifact title must not be empty', { reason: 'empty-title' })
  }
  if (title.length > MAX_ARTIFACT_TITLE_LENGTH) {
    throw new DashboardDomainError('artifact.invalidCandidate', `an artifact title must be at most ${MAX_ARTIFACT_TITLE_LENGTH} characters`, {
      reason: 'title-too-long',
      maxLength: MAX_ARTIFACT_TITLE_LENGTH,
    })
  }
  let content: string | undefined
  if (input.content !== undefined) {
    content = input.content
    if (content.length > MAX_ARTIFACT_CONTENT_LENGTH) {
      throw new DashboardDomainError('artifact.contentTooLarge', `artifact content must be at most ${MAX_ARTIFACT_CONTENT_LENGTH} characters (store a path reference instead)`, {
        maxLength: MAX_ARTIFACT_CONTENT_LENGTH,
      })
    }
  }
  // Kind-specific rules (spec §4.4): pull-request/external-link require a url;
  // a screenshot requires a path or url (never inline bytes).
  if ((input.kind === 'pull-request' || input.kind === 'external-link') && input.url === undefined) {
    throw new DashboardDomainError('artifact.missingUrl', `a ${input.kind} artifact requires a url`, { reason: 'missing-url' })
  }
  if (input.kind === 'screenshot' && input.path === undefined && input.url === undefined) {
    throw new DashboardDomainError('artifact.missingUrl', 'a screenshot artifact requires a path or url (never inline bytes)', { reason: 'missing-url' })
  }
  // Secrets scan (spec §4.3): a hard rejection, the Phase 6 memory pattern.
  const haystack = [title, content ?? '', input.path ?? '', input.url ?? '', JSON.stringify(input.metadata ?? {})].join('\n')
  if (SECRET_PATTERNS.some(pattern => pattern.test(haystack))) {
    throw new DashboardDomainError('artifact.containsSecrets', 'an artifact contains what looks like a secret', { reason: 'contains-secrets' })
  }
  return {
    kind: input.kind as ArtifactKind,
    title,
    ...(content === undefined ? {} : { content }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}

interface ArtifactTables {
  readonly artifacts: KvTable<ArtifactId, ProjectArtifactRecord>
  readonly runs: KvTable<RunId, ProjectRunRecord>
  readonly events: KvTable<RunEventId, ProjectRunEventRecord>
  readonly tasks: KvTable<TaskId, ProjectTaskRecord>
  readonly memory: KvTable<MemoryId, ProjectMemoryRecord>
  readonly approvals: KvTable<ApprovalId, ApprovalRequestRecord>
}

export interface ArtifactListInput {
  readonly runId?: RunId
  readonly projectId?: string
  readonly kind?: ArtifactKind
}

export class ProjectArtifactService {
  private tables: ArtifactTables | undefined
  private removeCompletedListener: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly runService: ProjectRunService,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Borrow the shared domain tables + register the run/completed listener; requires the Run service to be started. */
  start(): void {
    if (this.tables !== undefined) throw new Error('dsh-projects: Artifact service is already started')
    const domain = this.runService.domain()
    this.tables = {
      artifacts: domain.table('project_artifacts'),
      runs: domain.table('runs'),
      events: domain.table('run_events'),
      tasks: domain.table('tasks'),
      memory: domain.table('memory'),
      approvals: domain.table('project_approvals'),
    }
    // Spec §6.1: the run's terminal transition triggers the final report
    // (fire-and-forget). The listener is registered here so the service owns
    // its own lifecycle (the task-service `onRunCanceled` pattern).
    this.removeCompletedListener = this.ctx.on('dsh-projects/run/completed', event => {
      if (event.runId === undefined) return
      void this.generateFinalReport(event.runId)
    })
  }

  /** Drop table references + the listener. Idempotent. */
  stop(): void {
    this.removeCompletedListener?.()
    this.removeCompletedListener = undefined
    this.tables = undefined
  }

  /** §5.2 — persist a new artifact (append-only). Emits the `artifact.created` run event when run-scoped. */
  async create(input: ArtifactCreateInput): Promise<ProjectArtifactRecord> {
    const tables = this.requireStarted()
    this.requireProject(input.projectId)
    const fields = validateArtifact(input)
    const now = this.clock()
    const record: ProjectArtifactRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      kind: fields.kind,
      title: fields.title,
      ...(fields.content === undefined ? {} : { content: fields.content }),
      ...(fields.path === undefined ? {} : { path: fields.path }),
      ...(fields.url === undefined ? {} : { url: fields.url }),
      ...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
      createdAt: now,
    }
    await tables.artifacts.put(record.id, record)
    if (record.runId !== undefined) {
      await this.appendRunEvent(tables, {
        runId: record.runId,
        projectId: record.projectId,
        type: 'artifact.created',
        title: `Artifact: ${record.title}`,
        detail: `${record.kind}: ${record.title}`,
        at: now,
      })
    }
    return record
  }

  /** §5.2 — list artifacts (newest first). At least one of runId/projectId required. */
  list(input: ArtifactListInput): ProjectArtifactRecord[] {
    const tables = this.requireStarted()
    if (input.runId === undefined && input.projectId === undefined) {
      throw new DashboardDomainError('artifact.badRequest', 'artifactList requires a runId or a projectId', {})
    }
    const rows: ProjectArtifactRecord[] = []
    for (const [, record] of tables.artifacts.entries()) {
      if (input.runId !== undefined && record.runId !== input.runId) continue
      if (input.runId === undefined && input.projectId !== undefined && record.projectId !== input.projectId) continue
      if (input.kind !== undefined && record.kind !== input.kind) continue
      rows.push(record)
    }
    // Newest first (createdAt descending, id tiebreak — the Phase 7 deterministic ordering).
    rows.reverse()
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    return rows
  }

  /** §5.2 — the full record for the detail view. */
  get(id: ArtifactId): ProjectArtifactRecord | undefined {
    const tables = this.requireStarted()
    return tables.artifacts.get(id)
  }

  /**
   * Spec §6.3 — the final-report generator. Reads the run's persisted records,
   * renders the deterministic report, and persists it (one `final-report` per
   * run, idempotent in-place replace).
   *
   * `mode` selects the failure contract:
   * - `'fire-and-forget'` (the run/completed listener): a failure is a warn log
   *   + a `run.report.failed` event + `undefined` — never thrown.
   * - `'on-demand'` (the `runGenerateReport` RPC): a failure throws the
   *   structured `artifact.runUnknown` / `artifact.reportFailed` error (the
   *   `run.report.failed` event is still emitted).
   */
  async generateFinalReport(runId: RunId, mode: 'fire-and-forget' | 'on-demand' = 'fire-and-forget'): Promise<ProjectArtifactRecord | undefined> {
    const tables = this.requireStarted()
    const run = tables.runs.get(runId)
    if (run === undefined) {
      if (mode === 'on-demand') {
        throw new DashboardDomainError('artifact.runUnknown', `unknown run ${runId}`, { runId })
      }
      return undefined
    }
    // Only terminal runs get a report (spec §6.1): succeeded/failed/canceled.
    if (run.phase !== 'succeeded' && run.phase !== 'failed' && run.phase !== 'canceled') {
      if (mode === 'on-demand') {
        throw new DashboardDomainError('artifact.reportFailed', `run ${runId} is not terminal (phase ${run.phase}); no final report`, { runId })
      }
      return undefined
    }
    try {
      const tasks = this.tasksForRun(tables, runId)
      const memory = this.memoryForRun(tables, runId)
      const approvals = this.approvalsForRun(tables, runId)
      const artifacts = this.list({ runId })
      const report = buildFinalReport(run, tasks, memory, approvals, artifacts)
      const now = this.clock()
      const existing = this.findFinalReport(artifacts)
      if (existing !== undefined) {
        // One final-report per run (spec §6.3 step 4): in-place replace.
        const updated = await tables.artifacts.update(existing.id, current => ({
          ...current,
          content: report,
          metadata: { phase: run.phase, generatedBy: 'pipeline' },
        }))
        return updated
      }
      const record: ProjectArtifactRecord = {
        id: randomUUID(),
        projectId: run.projectId,
        runId: run.id,
        kind: 'final-report',
        title: 'Final report',
        content: report,
        metadata: { phase: run.phase, generatedBy: 'pipeline' },
        createdAt: now,
      }
      await tables.artifacts.put(record.id, record)
      await this.appendRunEvent(tables, {
        runId: run.id,
        projectId: run.projectId,
        type: 'artifact.created',
        title: 'Artifact: Final report',
        detail: 'final-report: Final report',
        at: now,
      })
      return record
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('dsh-projects: final report generation failed for run %s: %s', runId, message)
      await this.appendRunEvent(tables, {
        runId: run.id,
        projectId: run.projectId,
        type: 'run.report.failed',
        title: 'Final report failed',
        detail: message,
        at: this.clock(),
      }).catch(() => { /* the event is best-effort; the warn log is the primary signal */ })
      if (mode === 'on-demand') {
        throw new DashboardDomainError('artifact.reportFailed', `final report generation failed for run ${runId}: ${message}`, { runId })
      }
      return undefined
    }
  }

  private tasksForRun(tables: ArtifactTables, runId: RunId): ProjectTaskRecord[] {
    const rows: ProjectTaskRecord[] = []
    for (const [, task] of tables.tasks.entries()) {
      if (task.runId === runId) rows.push(task)
    }
    return rows
  }

  private memoryForRun(tables: ArtifactTables, runId: RunId): ProjectMemoryRecord[] {
    const rows: ProjectMemoryRecord[] = []
    for (const [, entry] of tables.memory.entries()) {
      if (entry.sourceRunId === runId) rows.push(entry)
    }
    return rows
  }

  private approvalsForRun(tables: ArtifactTables, runId: RunId): ApprovalRequestRecord[] {
    const rows: ApprovalRequestRecord[] = []
    for (const [, record] of tables.approvals.entries()) {
      if (record.runId === runId) rows.push(record)
    }
    return rows
  }

  private findFinalReport(artifacts: readonly ProjectArtifactRecord[]): ProjectArtifactRecord | undefined {
    for (const artifact of artifacts) {
      if (artifact.kind === 'final-report') return artifact
    }
    return undefined
  }

  /** §3.2 — append on the run's per-run seq (the existing appendRunEvent pattern). */
  private async appendRunEvent(tables: ArtifactTables, input: {
    readonly runId: RunId
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
      detail: truncateDetail(input.detail),
      seq: seq + 1,
      at: input.at,
    }
    await tables.events.put(record.id, record)
  }

  private requireProject(projectId: string): void {
    if (this.catalog.project(projectId) === undefined) {
      throw new DashboardDomainError('artifact.badRequest', `unknown project ${projectId}`, { projectId })
    }
  }

  private requireStarted(): ArtifactTables {
    const tables = this.tables
    if (tables === undefined) throw new DashboardDomainError('artifact.notStarted', 'Artifact service is not started')
    return tables
  }
}
