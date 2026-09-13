/**
 * DSH Projects Phase 6 — Project Memory storage service (spec §4).
 *
 * `ProjectMemoryService` follows the sibling-service pattern exactly
 * (`RunPlanService`/`ProjectTaskService`): it borrows the shared
 * `dsh_projects` domain opened by `ProjectRunService` and owns the
 * `memory` table (plus `runs`/`run_events` for distillation events and
 * `tasks` for distillation prompt data). Writes are async through the
 * domain's atomic `update` chain (CAS on `version`); reads are synchronous
 * (Map-backed tables).
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import type { ProjectRunEventRecord, ProjectRunRecord, RunEventId, RunId } from '../runs/types.ts'
import type { TaskId, ProjectTaskRecord } from '../tasks/types.ts'
import { buildDistillationPrompt, MEMORY_DISTILLATION_PERMISSION_PRESET, type MemoryDistillationDriver, type MemoryDistillationSubmission } from './distillation.ts'
import { buildMemoryPacket, normalizeTerms, searchMemory, termOverlap, type MemoryBudgets, type MemorySearchInput } from './retrieval.ts'
import { MEMORY_KINDS, type MemoryId, type MemoryKind, type MemoryStatus, type ProjectMemoryRecord } from './types.ts'

export const MAX_MEMORY_TITLE_LENGTH = 200
export const MAX_MEMORY_BODY_LENGTH = 12_000
export const MAX_MEMORY_TAGS = 20
export const MAX_MEMORY_TAG_LENGTH = 40
/** A candidate supersedes an existing same-kind active entry at this containment overlap (spec §4.3). */
export const SUPERSESSION_OVERLAP_THRESHOLD = 0.6

/** The §4.2 rejection reasons surfaced as `memory.invalidCandidate` params. */
export type MemoryInvalidReason =
  | 'unknown-kind'
  | 'empty-title'
  | 'title-too-long'
  | 'empty-body'
  | 'body-too-long'
  | 'too-many-tags'
  | 'invalid-tag'
  | 'invalid-confidence'
  | 'empty-patch'
  | 'contains-secrets'

const SECRET_PATTERNS: readonly RegExp[] = [
  /(api[_-]?key|apikey|token|secret|password)\s*[:=]\s*\S{8,}/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
]

export interface MemoryCreateInput {
  readonly projectId: string
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly confidence?: number
  /** Distillation provenance (spec §6.3). */
  readonly sourceRunId?: string
  readonly sourceTaskId?: string
  readonly sourceSessionId?: string
}

export interface MemoryUpdatePatch {
  readonly title?: string
  readonly body?: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
}

export interface MemoryListInput extends MemorySearchInput {
  readonly includeArchived?: boolean
}

export interface MemoryListResult {
  readonly entries: ProjectMemoryRecord[]
  /** Per-kind counts over ALL active entries of the project (unfiltered, zero-filled). */
  readonly counts: Record<MemoryKind, number>
}

export interface MemoryDistillationResult {
  readonly persisted: number
  readonly superseded: number
}

interface MemoryTables {
  readonly memory: KvTable<MemoryId, ProjectMemoryRecord>
  readonly runs: KvTable<RunId, ProjectRunRecord>
  readonly events: KvTable<RunEventId, ProjectRunEventRecord>
  readonly tasks: KvTable<TaskId, ProjectTaskRecord>
}

const EVENT_DETAIL_LIMIT = 200

function truncateDetail(value: string): string {
  return value.length <= EVENT_DETAIL_LIMIT ? value : `${value.slice(0, EVENT_DETAIL_LIMIT - 1)}…`
}

/**
 * Pure candidate validation (spec §4.2): returns the normalized record
 * fields or throws `memory.invalidCandidate` with a §4.2 `reason`. Enforces
 * only hard limits + the secrets scan — no semantic judgment (that is the
 * distillation prompt's job, spec §6.2).
 */
export function validateMemoryCandidate(input: {
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly tags?: readonly string[]
  readonly confidence?: number
}): { readonly kind: MemoryKind; readonly title: string; readonly body: string; readonly tags: readonly string[]; readonly confidence?: number } {
  if (!(MEMORY_KINDS as readonly string[]).includes(input.kind)) {
    throw new DashboardDomainError('memory.invalidCandidate', `unknown memory kind ${JSON.stringify(input.kind)}`, { reason: 'unknown-kind' })
  }
  const title = input.title.trim()
  if (title === '') {
    throw new DashboardDomainError('memory.invalidCandidate', 'a memory title must not be empty', { reason: 'empty-title' })
  }
  if (title.length > MAX_MEMORY_TITLE_LENGTH) {
    throw new DashboardDomainError('memory.invalidCandidate', `a memory title must be at most ${MAX_MEMORY_TITLE_LENGTH} characters`, {
      reason: 'title-too-long',
      maxLength: MAX_MEMORY_TITLE_LENGTH,
    })
  }
  const body = input.body.trim()
  if (body === '') {
    throw new DashboardDomainError('memory.invalidCandidate', 'a memory body must not be empty', { reason: 'empty-body' })
  }
  if (body.length > MAX_MEMORY_BODY_LENGTH) {
    throw new DashboardDomainError('memory.invalidCandidate', `a memory body must be at most ${MAX_MEMORY_BODY_LENGTH} characters`, {
      reason: 'body-too-long',
      maxLength: MAX_MEMORY_BODY_LENGTH,
    })
  }
  const rawTags = input.tags ?? []
  if (rawTags.length > MAX_MEMORY_TAGS) {
    throw new DashboardDomainError('memory.invalidCandidate', `a memory entry may have at most ${MAX_MEMORY_TAGS} tags`, {
      reason: 'too-many-tags',
      max: MAX_MEMORY_TAGS,
    })
  }
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of rawTags) {
    const tag = raw.trim()
    if (tag === '' || tag.length > MAX_MEMORY_TAG_LENGTH) {
      throw new DashboardDomainError('memory.invalidCandidate', `an invalid memory tag ${JSON.stringify(raw)}`, { reason: 'invalid-tag' })
    }
    const key = tag.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      tags.push(tag)
    }
  }
  let confidence: number | undefined
  if (input.confidence !== undefined) {
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new DashboardDomainError('memory.invalidCandidate', 'a memory confidence must be a number in [0, 1]', { reason: 'invalid-confidence' })
    }
    confidence = input.confidence
  }
  const haystack = `${title}\n${body}`
  if (SECRET_PATTERNS.some(pattern => pattern.test(haystack))) {
    throw new DashboardDomainError('memory.invalidCandidate', 'a memory candidate contains what looks like a secret', { reason: 'contains-secrets' })
  }
  return { kind: input.kind as MemoryKind, title, body, tags, ...(confidence === undefined ? {} : { confidence }) }
}

/**
 * Deterministic supersession target (spec §4.3): the active same-kind entry
 * with the highest containment overlap ≥ 0.6 (ties → lexicographically
 * smallest id). No match → `undefined` (plain new entry, no `supersedes`).
 */
export function findSupersessionTarget(
  candidate: { readonly kind: MemoryKind; readonly title: string; readonly tags: readonly string[] },
  pool: readonly ProjectMemoryRecord[],
): ProjectMemoryRecord | undefined {
  const candidateTerms = normalizeTerms(candidate.title).concat(candidate.tags.flatMap(tag => normalizeTerms(tag)))
  let best: { entry: ProjectMemoryRecord; overlap: number } | undefined
  for (const entry of pool) {
    if (entry.kind !== candidate.kind || entry.status !== 'active') continue
    const entryTerms = normalizeTerms(entry.title).concat(entry.tags.flatMap(tag => normalizeTerms(tag)))
    const overlap = termOverlap(candidateTerms, entryTerms)
    if (overlap < SUPERSESSION_OVERLAP_THRESHOLD) continue
    if (best === undefined || overlap > best.overlap || (overlap === best.overlap && entry.id < best.entry.id)) {
      best = { entry, overlap }
    }
  }
  return best?.entry
}

export class ProjectMemoryService {
  private tables: MemoryTables | undefined
  /** The §5.1 retrieval strategy seam (default: the lexical implementation). */
  private readonly strategy = (pool: readonly ProjectMemoryRecord[], input: MemorySearchInput): ProjectMemoryRecord[] =>
    searchMemory(pool, input)

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly runService: ProjectRunService,
    private readonly driver: MemoryDistillationDriver | undefined,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Borrow the shared domain tables; requires the Run service to be started. */
  start(): void {
    if (this.tables !== undefined) throw new Error('dsh-projects: Memory service is already started')
    const domain = this.runService.domain()
    this.tables = {
      memory: domain.table('memory'),
      runs: domain.table('runs'),
      events: domain.table('run_events'),
      tasks: domain.table('tasks'),
    }
  }

  /** Drop table references only; the Run service owns the shared domain lifecycle. Idempotent. */
  stop(): void {
    this.tables = undefined
  }

  /** §4.1 — `searchMemory` over `active` (+ `archived` when `includeArchived`). */
  async list(input: MemoryListInput): Promise<MemoryListResult> {
    const tables = this.requireStarted()
    this.requireProject(input.projectId)
    const includeArchived = input.includeArchived === true
    const pool = this.poolFor(tables.memory, input.projectId, includeArchived)
    return {
      entries: this.strategy(pool, {
        projectId: input.projectId,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
      counts: this.kindCounts(tables.memory, input.projectId),
    }
  }

  /** §5.1 — the synchronous retrieval interface over the project's active pool. */
  search(input: MemorySearchInput): ProjectMemoryRecord[] {
    const tables = this.requireStarted()
    return this.strategy(this.poolFor(tables.memory, input.projectId, false), input)
  }

  /** §5.2 — the bounded context packet; `undefined` when there is nothing to render. */
  packetFor(input: { readonly projectId: string; readonly query?: string; readonly budgets: MemoryBudgets }): string | undefined {
    const tables = this.requireStarted()
    const pool = this.poolFor(tables.memory, input.projectId, false)
    const retrieved = this.strategy(pool, {
      projectId: input.projectId,
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.budgets.maxEntries,
    })
    return buildMemoryPacket(retrieved, input.budgets)
  }

  /** §4.1 — manual notes and the persistence half of distillation; dedup always applied. */
  async create(input: MemoryCreateInput): Promise<{ entry: ProjectMemoryRecord; supersededId?: string }> {
    const tables = this.requireStarted()
    this.requireProject(input.projectId)
    const fields = validateMemoryCandidate(input)
    const now = this.clock()
    const pool = this.poolFor(tables.memory, input.projectId, false).filter(entry => entry.kind === fields.kind)
    const target = findSupersessionTarget(fields, pool)
    const entry: ProjectMemoryRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      kind: fields.kind,
      title: fields.title,
      body: fields.body,
      tags: fields.tags,
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
      ...(input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId }),
      ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
      ...(fields.confidence === undefined ? {} : { confidence: fields.confidence }),
      status: 'active',
      ...(target === undefined ? {} : { supersedes: target.id }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    await tables.memory.put(entry.id, entry)
    if (target !== undefined) {
      await tables.memory.update(target.id, current => ({
        ...current,
        status: 'superseded',
        updatedAt: now,
        version: current.version + 1,
      }))
    }
    return { entry, ...(target === undefined ? {} : { supersededId: target.id }) }
  }

  /** §4.1 — CAS update; ≥ 1 patch field; `superseded` entries are immutable. */
  async update(id: MemoryId, expectedVersion: number, patch: MemoryUpdatePatch): Promise<ProjectMemoryRecord> {
    const tables = this.requireStarted()
    const hasPatch = patch.title !== undefined || patch.body !== undefined || patch.tags !== undefined || patch.pinned !== undefined
    if (!hasPatch) {
      throw new DashboardDomainError('memory.invalidCandidate', 'a memory update requires at least one field', { reason: 'empty-patch' })
    }
    const existing = tables.memory.get(id)
    if (existing === undefined) {
      throw new DashboardDomainError('memory.unknown', `unknown memory entry ${id}`, { id })
    }
    if (existing.status === 'superseded') {
      throw new DashboardDomainError('memory.immutable', `memory entry ${id} is superseded and immutable`, { id })
    }
    const merged = validateMemoryCandidate({
      kind: existing.kind,
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      tags: patch.tags ?? existing.tags,
      ...(existing.confidence === undefined ? {} : { confidence: existing.confidence }),
    })
    const now = this.clock()
    try {
      return await tables.memory.update(id, current => {
        if (current.version !== expectedVersion) {
          throw new DashboardDomainError(
            'memory.staleVersion',
            `memory ${id} changed concurrently (expected version ${expectedVersion}, found ${current.version})`,
            { expectedVersion, actualVersion: current.version },
          )
        }
        return {
          ...current,
          title: merged.title,
          body: merged.body,
          tags: merged.tags,
          pinned: patch.pinned ?? (current.pinned === true),
          updatedAt: now,
          version: current.version + 1,
        }
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new DashboardDomainError('memory.unknown', `unknown memory entry ${id}`, { id })
      }
      throw error
    }
  }

  /** §4.1 — legal moves: active ↔ archived, active → superseded. CAS. */
  async setStatus(id: MemoryId, expectedVersion: number, status: MemoryStatus): Promise<ProjectMemoryRecord> {
    const tables = this.requireStarted()
    const existing = tables.memory.get(id)
    if (existing === undefined) {
      throw new DashboardDomainError('memory.unknown', `unknown memory entry ${id}`, { id })
    }
    if (existing.status === 'superseded') {
      throw new DashboardDomainError('memory.immutable', `memory entry ${id} is superseded and immutable`, { id })
    }
    if (status === existing.status) {
      throw new DashboardDomainError('memory.invalidStatus', `memory entry ${id} is already ${status}`, { id, status })
    }
    if (existing.status === 'archived' && status !== 'active') {
      throw new DashboardDomainError('memory.invalidStatus', `illegal memory status transition ${existing.status} → ${status}`, {
        id,
        from: existing.status,
        to: status,
      })
    }
    const now = this.clock()
    try {
      return await tables.memory.update(id, current => {
        if (current.version !== expectedVersion) {
          throw new DashboardDomainError(
            'memory.staleVersion',
            `memory ${id} changed concurrently (expected version ${expectedVersion}, found ${current.version})`,
            { expectedVersion, actualVersion: current.version },
          )
        }
        return { ...current, status, updatedAt: now, version: current.version + 1 }
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new DashboardDomainError('memory.unknown', `unknown memory entry ${id}`, { id })
      }
      throw error
    }
  }

  /**
   * §6.3 — distill durable memory from a succeeded run. Fire-and-forget
   * semantics: never throws into the caller (all failures become the
   * failed-event or a warn log); no driver → silent no-op (no event).
   */
  async distillRun(run: ProjectRunRecord): Promise<MemoryDistillationResult> {
    const tables = this.requireStarted()
    if (run.phase !== 'succeeded' || this.driver === undefined) {
      return { persisted: 0, superseded: 0 }
    }
    const controller = new AbortController()
    let persisted = 0
    let superseded = 0
    try {
      this.requireProject(run.projectId)
      const project = this.catalog.project(run.projectId)
      const tasks = this.runTasks(tables, run.id)
      const existingTitles = this.poolFor(tables.memory, run.projectId, false).map(entry => entry.title)
      const prompt = buildDistillationPrompt({
        goal: run.goal,
        tasks: tasks.map(task => ({
          planTaskId: task.planTaskId,
          title: task.title,
          status: task.status,
          ...(task.outputSummary === undefined ? {} : { outputSummary: task.outputSummary }),
        })),
        existingTitles,
      })
      const sessionId = `dsh-memory-${randomUUID()}`
      const result = await this.driver.start({
        sessionId,
        cwd: project?.root ?? process.cwd(),
        permissionPreset: MEMORY_DISTILLATION_PERMISSION_PRESET,
        prompt,
        signal: controller.signal,
        onMemorySubmit: async (submission: MemoryDistillationSubmission) => {
          const counts = await this.persistCandidates({ run, projectId: run.projectId, sessionId, submission })
          persisted = counts.persisted
          superseded = counts.superseded
          return counts
        },
      })
      if (result.kind === 'failed' || result.kind === 'blocked') {
        await this.appendRunEvent(tables, {
          runId: run.id,
          projectId: run.projectId,
          type: 'run.memory.distillation.failed',
          title: 'Memory distillation failed',
          detail: result.error === undefined ? result.kind : result.error,
          at: this.clock(),
        })
        return { persisted, superseded }
      }
      if (persisted + superseded > 0) {
        await this.appendRunEvent(tables, {
          runId: run.id,
          projectId: run.projectId,
          type: 'run.memory.distilled',
          title: 'Memory distilled',
          detail: `${persisted} entries persisted (${superseded} superseded)`,
          at: this.clock(),
        })
      }
      return { persisted, superseded }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('dsh-projects: memory distillation failed for run %s: %s', run.id, message)
      try {
        await this.appendRunEvent(tables, {
          runId: run.id,
          projectId: run.projectId,
          type: 'run.memory.distillation.failed',
          title: 'Memory distillation failed',
          detail: message,
          at: this.clock(),
        })
      } catch {
        // The event append itself failed (e.g. service stopped mid-flight);
        // the warn above already recorded the cause. Never throw out.
      }
      return { persisted, superseded }
    }
  }

  /** §4.2 — persist each candidate; invalid ones are skipped + warned, never thrown. */
  private async persistCandidates(input: {
    readonly run: ProjectRunRecord
    readonly projectId: string
    readonly sessionId: string
    readonly submission: MemoryDistillationSubmission
  }): Promise<MemoryDistillationResult> {
    let persisted = 0
    let superseded = 0
    for (const candidate of input.submission.entries) {
      try {
        const { supersededId } = await this.create({
          projectId: input.projectId,
          kind: candidate.kind,
          title: candidate.title,
          body: candidate.body,
          ...(candidate.tags === undefined ? {} : { tags: candidate.tags }),
          ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
          sourceRunId: input.run.id,
          ...(candidate.sourceTaskId === undefined ? {} : { sourceTaskId: candidate.sourceTaskId }),
          sourceSessionId: input.sessionId,
        })
        persisted++
        if (supersededId !== undefined) superseded++
      } catch (error) {
        const reason = error instanceof DashboardDomainError ? String(error.params.reason ?? 'unknown') : 'unknown'
        this.ctx.logger.warn('dsh-projects: skipping invalid memory candidate for run %s (%s): %s',
          input.run.id, reason, error instanceof Error ? error.message : String(error))
      }
    }
    return { persisted, superseded }
  }

  private runTasks(tables: MemoryTables, runId: RunId): ProjectTaskRecord[] {
    const tasks: ProjectTaskRecord[] = []
    for (const [, task] of tables.tasks.entries()) {
      if (task.runId === runId) tasks.push(task)
    }
    tasks.sort((a, b) => a.planTaskId < b.planTaskId ? -1 : a.planTaskId > b.planTaskId ? 1 : 0)
    return tasks
  }

  /** Active pool of the project (+ archived when asked) — the retrieval pool. */
  private poolFor(memory: KvTable<MemoryId, ProjectMemoryRecord>, projectId: string, includeArchived: boolean): ProjectMemoryRecord[] {
    const statuses = new Set<MemoryStatus>(includeArchived ? ['active', 'archived'] : ['active'])
    const pool: ProjectMemoryRecord[] = []
    for (const [, entry] of memory.entries()) {
      if (entry.projectId === projectId && statuses.has(entry.status)) pool.push(entry)
    }
    return pool
  }

  private kindCounts(memory: KvTable<MemoryId, ProjectMemoryRecord>, projectId: string): Record<MemoryKind, number> {
    const counts = Object.fromEntries(MEMORY_KINDS.map(kind => [kind, 0])) as Record<MemoryKind, number>
    for (const [, entry] of memory.entries()) {
      if (entry.projectId === projectId && entry.status === 'active') counts[entry.kind]++
    }
    return counts
  }

  private requireProject(projectId: string): void {
    if (this.catalog.project(projectId) === undefined) {
      throw new DashboardDomainError('memory.projectNotFound', `unknown project ${projectId}`, { projectId })
    }
  }

  /** §3.3 — append on the run's per-run seq (the existing appendRunEvent pattern). */
  private async appendRunEvent(tables: MemoryTables, input: {
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

  private requireStarted(): MemoryTables {
    const tables = this.tables
    if (tables === undefined) throw new DashboardDomainError('memory.notStarted', 'Memory service is not started')
    return tables
  }
}
