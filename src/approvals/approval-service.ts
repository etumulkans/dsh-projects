/** Durable approval requests: the Phase 7 approval objects (spec §4). */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import { DashboardDomainError } from '../runtime/errors.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import type { ProjectRunEventRecord, RunId } from '../runs/types.ts'
import {
  type ApprovalId,
  type ApprovalRequestRecord,
  type ApprovalStatus,
  type ApprovalType,
} from './types.ts'

/** Payload of the `dsh-projects/approval/requested` Cordis event. */
export interface ApprovalRequestedEvent {
  readonly approvalId: ApprovalId
  readonly runId: RunId
  readonly projectId: string
  readonly type: ApprovalType
  readonly at: string
}

/** Payload of the `dsh-projects/approval/resolved` Cordis event. */
export interface ApprovalResolvedEvent {
  readonly approvalId: ApprovalId
  readonly runId: RunId
  readonly projectId: string
  readonly type: ApprovalType
  readonly status: ApprovalStatus
  readonly resolvedBy: string
  readonly at: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** An approval object was created (persisted first). */
    'dsh-projects/approval/requested'(event: ApprovalRequestedEvent): void
    /** An approval object was resolved or expired (persisted first). */
    'dsh-projects/approval/resolved'(event: ApprovalResolvedEvent): void
  }
}

export interface ApprovalServiceHooks {
  /**
   * Fired after a resolve/expire is persisted (spec §4.6). Wired in `index.ts`
   * to move the run (merge approved → `integrating`, merge rejected →
   * `blocked`); a guard miss is a logged no-op there.
   */
  readonly onApprovalResolved?: (record: ApprovalRequestRecord) => Promise<void>
}

const MAX_SUMMARY_LENGTH = 500
const MAX_RESOLVER_LENGTH = 200
const DEFAULT_RESOLVED_BY = 'dashboard'
const EXPIRED_RESOLVED_BY = 'system'

/**
 * Owns the `project_approvals` table (spec §3.1). Host-only: the client never
 * imports this module (the Phase 6 isolation invariant extends — a scan test
 * asserts it). Borrows the shared `dsh_projects` tables from the Run service
 * (the same pattern as `ProjectMemoryService`): `start()` after
 * `runService.start()`, `stop()` before `runService.stop()`.
 */
export class ApprovalService {
  private approvals: KvTable<ApprovalId, ApprovalRequestRecord> | undefined
  private runs: KvTable<RunId, unknown> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ProjectCatalog,
    private readonly runService: ProjectRunService,
    private readonly hooks: ApprovalServiceHooks = {},
  ) {}

  /** Borrow the shared domain tables; requires the Run service to be started. */
  start(): void {
    if (this.approvals !== undefined) throw new Error('dsh-projects: Approval service is already started')
    const domain = this.runService.domain()
    this.approvals = domain.table('project_approvals')
    this.runs = domain.table('runs')
  }

  /** Drop table references only; the Run service owns the shared domain lifecycle. Idempotent. */
  stop(): void {
    this.approvals = undefined
    this.runs = undefined
  }

  /**
   * Create a pending approval (spec §4.3). Idempotent per (run, type): an
   * existing pending object for the same (runId, type) is returned, not
   * duplicated. A terminal object for the same (runId, type) never blocks a
   * new request — the new pending object supersedes it (the old object is
   * retained for the audit trail, never deleted).
   */
  async requestApproval(input: {
    readonly runId: RunId
    readonly type: ApprovalType
    readonly summary: string
    readonly payload?: unknown
  }): Promise<ApprovalRequestRecord> {
    const approvals = this.requireStarted()
    const runs = this.requireRuns()
    const run = runs.get(input.runId) as { readonly projectId: string } | undefined
    if (run === undefined) {
      throw new DashboardDomainError('approval.runUnknown', `unknown Run ${input.runId}`, { runId: input.runId })
    }
    const summary = input.summary.trim()
    if (summary.length < 1 || summary.length > MAX_SUMMARY_LENGTH) {
      throw new DashboardDomainError('approval.invalidStatus', `approval summary must be 1..${MAX_SUMMARY_LENGTH} chars`)
    }
    for (const [, existing] of approvals.entries()) {
      if (existing.runId === input.runId && existing.type === input.type && existing.status === 'pending') {
        return existing
      }
    }
    const at = new Date().toISOString()
    const record: ApprovalRequestRecord = {
      id: randomUUID(),
      projectId: run.projectId,
      runId: input.runId,
      type: input.type,
      summary,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      status: 'pending',
      requestedAt: at,
      createdAt: at,
      updatedAt: at,
      version: 1,
    }
    await approvals.put(record.id, record)
    await this.appendRunEvent(record, 'run.approval.requested', `Approval requested: ${record.type}`, record.summary)
    this.ctx.emit('dsh-projects/approval/requested', {
      approvalId: record.id,
      runId: record.runId,
      projectId: record.projectId,
      type: record.type,
      at,
    })
    return record
  }

  /**
   * Resolve a pending approval (spec §4.3). CAS on `version`; resolving a
   * terminal object → `approval.invalidStatus`; `resolvedBy` defaults to
   * `'dashboard'`.
   */
  async resolveApproval(
    id: ApprovalId,
    decision: 'approved' | 'rejected',
    input: { readonly expectedVersion?: number; readonly resolvedBy?: string } = {},
  ): Promise<ApprovalRequestRecord> {
    const approvals = this.requireStarted()
    const existing = approvals.get(id)
    if (existing === undefined) {
      throw new DashboardDomainError('approval.unknown', `unknown approval ${id}`, { id })
    }
    if (existing.status !== 'pending') {
      throw new DashboardDomainError('approval.invalidStatus', `approval ${id} is ${existing.status}, not pending`, {
        id,
        status: existing.status,
      })
    }
    const resolvedBy = (input.resolvedBy ?? DEFAULT_RESOLVED_BY).trim()
    if (resolvedBy.length < 1 || resolvedBy.length > MAX_RESOLVER_LENGTH) {
      throw new DashboardDomainError('approval.invalidStatus', `resolvedBy must be 1..${MAX_RESOLVER_LENGTH} chars`)
    }
    const at = new Date().toISOString()
    let next: ApprovalRequestRecord
    try {
      next = await approvals.update(id, current => {
        if (current.status !== 'pending') {
          throw new DashboardDomainError('approval.invalidStatus', `approval ${id} is ${current.status}, not pending`, {
            id,
            status: current.status,
          })
        }
        if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
          throw new DashboardDomainError(
            'approval.staleVersion',
            `approval ${id} changed concurrently (expected version ${input.expectedVersion}, found ${current.version})`,
            { expectedVersion: input.expectedVersion, actualVersion: current.version },
          )
        }
        return {
          ...current,
          status: decision,
          resolvedAt: at,
          resolvedBy,
          updatedAt: at,
          version: current.version + 1,
        }
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new DashboardDomainError('approval.unknown', `unknown approval ${id}`, { id })
      }
      throw error
    }
    await this.appendRunEvent(next, 'run.approval.resolved', `Approval ${next.status}: ${next.type}`, `${next.type} ${next.status} by ${resolvedBy}`)
    this.ctx.emit('dsh-projects/approval/resolved', {
      approvalId: next.id,
      runId: next.runId,
      projectId: next.projectId,
      type: next.type,
      status: next.status,
      resolvedBy,
      at,
    })
    const hook = this.hooks.onApprovalResolved
    if (hook !== undefined) await hook(next)
    return next
  }

  /**
   * Explicit expiry (spec §4.3, no TTL): mark a pending object `expired`
   * (e.g. its run was canceled). The only path to `expired`.
   */
  async expireApproval(id: ApprovalId, input: { readonly expectedVersion?: number } = {}): Promise<ApprovalRequestRecord> {
    const approvals = this.requireStarted()
    const existing = approvals.get(id)
    if (existing === undefined) {
      throw new DashboardDomainError('approval.unknown', `unknown approval ${id}`, { id })
    }
    if (existing.status !== 'pending') {
      throw new DashboardDomainError('approval.invalidStatus', `approval ${id} is ${existing.status}, not pending`, {
        id,
        status: existing.status,
      })
    }
    const at = new Date().toISOString()
    let next: ApprovalRequestRecord
    try {
      next = await approvals.update(id, current => {
        if (current.status !== 'pending') {
          throw new DashboardDomainError('approval.invalidStatus', `approval ${id} is ${current.status}, not pending`, {
            id,
            status: current.status,
          })
        }
        if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
          throw new DashboardDomainError(
            'approval.staleVersion',
            `approval ${id} changed concurrently (expected version ${input.expectedVersion}, found ${current.version})`,
            { expectedVersion: input.expectedVersion, actualVersion: current.version },
          )
        }
        return {
          ...current,
          status: 'expired',
          resolvedAt: at,
          resolvedBy: EXPIRED_RESOLVED_BY,
          updatedAt: at,
          version: current.version + 1,
        }
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new DashboardDomainError('approval.unknown', `unknown approval ${id}`, { id })
      }
      throw error
    }
    await this.appendRunEvent(next, 'run.approval.resolved', `Approval expired: ${next.type}`, `${next.type} expired by ${EXPIRED_RESOLVED_BY}`)
    this.ctx.emit('dsh-projects/approval/resolved', {
      approvalId: next.id,
      runId: next.runId,
      projectId: next.projectId,
      type: next.type,
      status: next.status,
      resolvedBy: EXPIRED_RESOLVED_BY,
      at,
    })
    const hook = this.hooks.onApprovalResolved
    if (hook !== undefined) await hook(next)
    return next
  }

  /** All approvals for a run and/or project, newest first (spec §4.3). */
  listApprovals(runId?: RunId, projectId?: string): ApprovalRequestRecord[] {
    const approvals = this.requireStarted()
    const rows: ApprovalRequestRecord[] = []
    for (const [, record] of approvals.entries()) {
      if (runId !== undefined && record.runId !== runId) continue
      if (projectId !== undefined && record.projectId !== projectId) continue
      rows.push(record)
    }
    // Newest first. `requestedAt` is millisecond-resolution, so records created
    // in the same tick tie; the table iterates in insertion (creation) order,
    // so reversing it before the stable sort makes same-tick records list in
    // true creation order (latest created first) without depending on the
    // random id.
    rows.reverse()
    rows.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
    return rows
  }

  /** The pending approval for (runId, type), if any (the §4.4 wiring lookup). */
  pendingFor(runId: RunId, type: ApprovalType): ApprovalRequestRecord | undefined {
    const approvals = this.requireStarted()
    for (const [, record] of approvals.entries()) {
      if (record.runId === runId && record.type === type && record.status === 'pending') return record
    }
    return undefined
  }

  private requireStarted(): KvTable<ApprovalId, ApprovalRequestRecord> {
    const approvals = this.approvals
    if (approvals === undefined) throw new DashboardDomainError('approval.notStarted', 'Approval service is not started')
    return approvals
  }

  private requireRuns(): KvTable<RunId, unknown> {
    const runs = this.runs
    if (runs === undefined) throw new DashboardDomainError('approval.notStarted', 'Approval service is not started')
    return runs
  }

  private async appendRunEvent(
    record: ApprovalRequestRecord,
    type: 'run.approval.requested' | 'run.approval.resolved',
    title: string,
    detail: string,
  ): Promise<void> {
    const runs = this.requireRuns()
    const run = runs.get(record.runId) as { readonly projectId: string } | undefined
    if (run === undefined) return
    const events = this.runService.domain().table('run_events')
    let seq = 0
    for (const [, existing] of events.entries()) {
      if (existing.runId === record.runId && existing.seq > seq) seq = existing.seq
    }
    const at = new Date().toISOString()
    const event: ProjectRunEventRecord = {
      id: randomUUID(),
      runId: record.runId,
      projectId: run.projectId,
      type,
      title,
      detail,
      seq: seq + 1,
      at,
    }
    await events.put(event.id, event)
  }
}
