/** Small external stores for shell visibility and trusted-host RPC state. */

import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { DashboardSnapshot, TaskTimelinePage } from '../runtime/types.ts'
import type { AddDiscoveryRootInput, ProjectScanResult, RegisterProjectInput } from '../catalog/types.ts'
import type { CreateRunInput, ProjectRunPhase, RunDetailView } from '../runs/types.ts'
import type { CreatePlanInput, RunPlanRecord, RunPlanStatus } from '../plans/types.ts'
import type { CreateTaskInput, UpdateTaskInput } from '../task-source/index.ts'
import {
  DashboardRequestError,
  dashboardProtocolError,
  dashboardRpcError,
  normalizeDashboardError,
} from './errors.ts'

export interface DashboardDataState {
  readonly snapshot?: DashboardSnapshot | undefined
  readonly loading: boolean
  readonly error?: DashboardRequestError | undefined
}

/**
 * Phase 6: client-side mirror of the server's 15 memory kinds. Intentionally
 * duplicated instead of imported — `src/client/**` must never import
 * `src/memory/**` (the import-scan invariant).
 */
export const CLIENT_MEMORY_KINDS = [
  'architecture', 'decision', 'convention', 'dependency', 'environment',
  'testing', 'deployment', 'operations', 'research', 'finding',
  'known-problem', 'failure-pattern', 'procedure', 'repository-map',
  'user-preference',
] as const

export type ClientMemoryKind = (typeof CLIENT_MEMORY_KINDS)[number]
export type ClientMemoryStatus = 'active' | 'superseded' | 'archived'

/** Phase 6: client-side shape of a project memory record (spec §9 wire format). */
export interface MemoryEntryView {
  readonly id: string
  readonly projectId: string
  readonly kind: ClientMemoryKind
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
  readonly sourceRunId?: string
  readonly sourceTaskId?: string
  readonly sourceSessionId?: string
  readonly confidence?: number
  readonly status: ClientMemoryStatus
  readonly supersedes?: string
  readonly pinned?: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export interface MemoryListPayload {
  readonly entries: readonly MemoryEntryView[]
  /** Per-kind counts over all active entries (unfiltered, zero-filled). */
  readonly counts: Record<ClientMemoryKind, number>
}

export interface MemoryCreatePayload {
  readonly entry: MemoryEntryView
  readonly supersededId?: string
}

export interface MemoryListInput {
  readonly projectId: string
  readonly query?: string
  readonly kinds?: readonly ClientMemoryKind[]
  readonly tags?: readonly string[]
  readonly limit?: number
  readonly includeArchived?: boolean
}

export interface MemoryCreateInput {
  readonly projectId: string
  readonly kind: ClientMemoryKind
  readonly title: string
  readonly body: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly confidence?: number
}

export interface MemoryUpdateInput {
  readonly id: string
  readonly expectedVersion: number
  readonly title?: string
  readonly body?: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
}

export interface MemorySetStatusInput {
  readonly id: string
  readonly expectedVersion: number
  readonly status: ClientMemoryStatus
}

export interface DashboardDataPort {
  getSnapshot(): DashboardDataState
  subscribe(listener: () => void): () => void
  start(): () => void
  refresh(): Promise<void>
  setPaused(paused: boolean): Promise<void>
  stopIssue(key: string): Promise<void>
  loadTimeline(key: string, cursor?: string): Promise<TaskTimelinePage>
  createTask(input: CreateTaskInput): Promise<void>
  updateTask(nativeRef: string, changes: UpdateTaskInput): Promise<void>
  deleteTask(nativeRef: string): Promise<void>
  switchProject(projectId: string): Promise<void>
  switchGlobal(): Promise<void>
  addDiscoveryRoot(input: AddDiscoveryRootInput): Promise<void>
  removeDiscoveryRoot(id: string): Promise<void>
  scanProjects(rootId: string): Promise<ProjectScanResult>
  registerProjectCandidate(token: string): Promise<void>
  registerProject(input: RegisterProjectInput): Promise<void>
  createRun(input: CreateRunInput): Promise<void>
  runTransition(input: {
    runId: string
    to: ProjectRunPhase
    expectedVersion?: number
    error?: string
    resultSummary?: string
  }): Promise<void>
  loadRunDetail(runId: string): Promise<RunDetailView>
  /** Phase 3: start one Coordinator Lead session for a created/planning run. */
  coordinateRun(runId: string): Promise<void>
  createPlan(input: CreatePlanInput): Promise<RunPlanRecord>
  loadPlans(runId: string): Promise<readonly RunPlanRecord[]>
  planTransition(input: {
    planId: string
    status: RunPlanStatus
    expectedRevision?: number
    replanReason?: string
  }): Promise<RunPlanRecord>
  /** Phase 4: re-queue one failed task (the view refreshes from the next snapshot). */
  taskRetry(taskId: string): Promise<void>
  /** Phase 6: fetch a project's memory list on demand (the runDetail pattern; no snapshot projection). */
  loadMemory(input: MemoryListInput): Promise<MemoryListPayload>
  createMemory(input: MemoryCreateInput): Promise<MemoryCreatePayload>
  updateMemory(input: MemoryUpdateInput): Promise<MemoryEntryView>
  setMemoryStatus(input: MemorySetStatusInput): Promise<MemoryEntryView>
}

/** Root overlay visibility shared by the sidebar trigger and shell-overlay entry. */
export class DashboardUiController {
  private openValue = false
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): boolean => this.openValue

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open = (): void => { this.set(true) }
  close = (): void => { this.set(false) }
  toggle = (): void => { this.set(!this.openValue) }

  private set(value: boolean): void {
    if (this.openValue === value) return
    this.openValue = value
    for (const listener of [...this.listeners]) listener()
  }
}

/** Polling Dashboard projection; transport/business failures share one UI error path. */
export class DashboardDataController implements DashboardDataPort {
  private state: DashboardDataState = { loading: true }
  private readonly listeners = new Set<() => void>()
  private interval: ReturnType<typeof setInterval> | undefined
  private activeRequests = 0

  constructor(private readonly rpc: ClientConnectionRpc) {}

  getSnapshot = (): DashboardDataState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start = (): (() => void) => {
    void this.call('refresh', {}, true)
    if (this.interval === undefined) this.interval = setInterval(() => { void this.readState() }, 5000)
    return () => {
      if (this.interval !== undefined) clearInterval(this.interval)
      this.interval = undefined
    }
  }

  async refresh(): Promise<void> {
    await this.call('refresh', {}, false, true)
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.call('pause', { paused }, false, true)
  }

  async stopIssue(key: string): Promise<void> {
    await this.call('stop', { key }, false, true)
  }

  async loadTimeline(key: string, cursor?: string): Promise<TaskTimelinePage> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'timeline', {
        key,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 30,
      }) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseTimelinePage(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async createTask(input: CreateTaskInput): Promise<void> {
    await this.call('createTask', input, false, true)
  }

  async updateTask(nativeRef: string, changes: UpdateTaskInput): Promise<void> {
    await this.call('updateTask', { nativeRef, changes }, false, true)
  }

  async deleteTask(nativeRef: string): Promise<void> {
    await this.call('deleteTask', { nativeRef }, false, true)
  }

  async switchProject(projectId: string): Promise<void> {
    await this.call('switchProject', { projectId }, false, true)
  }

  async switchGlobal(): Promise<void> {
    await this.call('switchGlobal', {}, false, true)
  }

  async addDiscoveryRoot(input: AddDiscoveryRootInput): Promise<void> {
    await this.call('addDiscoveryRoot', input, false, true)
  }

  async removeDiscoveryRoot(id: string): Promise<void> {
    await this.call('removeDiscoveryRoot', { id }, false, true)
  }

  async scanProjects(rootId: string): Promise<ProjectScanResult> {
    return await this.callProjectScan(rootId)
  }

  async registerProjectCandidate(token: string): Promise<void> {
    await this.call('registerProjectCandidate', { token }, false, true)
  }

  async registerProject(input: RegisterProjectInput): Promise<void> {
    await this.call('registerProject', input, false, true)
  }

  async createRun(input: CreateRunInput): Promise<void> {
    await this.call('runCreate', input, false, true)
  }

  async runTransition(input: {
    runId: string
    to: ProjectRunPhase
    expectedVersion?: number
    error?: string
    resultSummary?: string
  }): Promise<void> {
    await this.call('runTransition', input, false, true)
  }

  async loadRunDetail(runId: string): Promise<RunDetailView> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'runDetail', { runId }) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseRunDetail(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async coordinateRun(runId: string): Promise<void> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'runCoordinate', { runId }) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async createPlan(input: CreatePlanInput): Promise<RunPlanRecord> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'planCreate', input) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseRunPlan(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async loadPlans(runId: string): Promise<readonly RunPlanRecord[]> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'planList', { runId }) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseRunPlanList(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async planTransition(input: {
    planId: string
    status: RunPlanStatus
    expectedRevision?: number
    replanReason?: string
  }): Promise<RunPlanRecord> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'planTransition', input) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseRunPlan(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async taskRetry(taskId: string): Promise<void> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'taskRetry', { taskId }) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async loadMemory(input: MemoryListInput): Promise<MemoryListPayload> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'memoryList', input) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseMemoryList(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async createMemory(input: MemoryCreateInput): Promise<MemoryCreatePayload> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'memoryCreate', input) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseMemoryCreate(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async updateMemory(input: MemoryUpdateInput): Promise<MemoryEntryView> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'memoryUpdate', input) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseMemoryEntry(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  async setMemoryStatus(input: MemorySetStatusInput): Promise<MemoryEntryView> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'memorySetStatus', input) as RpcResult<unknown>
      if (!result.ok) throw dashboardRpcError(result.error.code, result.error.message)
      return parseMemoryEntry(result.value)
    } catch (error) {
      throw normalizeDashboardError(error)
    } finally {
      this.activeRequests -= 1
    }
  }

  private async readState(): Promise<void> {
    await this.call('state', {}, false)
  }

  private async call(endpoint: string, payload: unknown, announceLoading = true, propagateError = false): Promise<void> {
    this.activeRequests += 1
    if (announceLoading) {
      const { error: _previousError, ...current } = this.state
      this.publish({ ...current, loading: true })
    }
    try {
      const result = await this.rpc.call('/dsh-dashboard', endpoint, payload) as RpcResult<unknown>
      if (!result.ok) {
        throw dashboardRpcError(result.error.code, result.error.message)
      }
      const snapshot = parseSnapshot(result.value)
      this.publish({ snapshot, loading: false })
    } catch (error) {
      const normalized = normalizeDashboardError(error)
      this.publish(propagateError
        ? { ...this.state, loading: false }
        : { ...this.state, loading: false, error: normalized })
      if (propagateError) throw normalized
    } finally {
      this.activeRequests -= 1
      if (this.activeRequests === 0 && this.state.loading) this.publish({ ...this.state, loading: false })
    }
  }

  private async callProjectScan(rootId: string): Promise<ProjectScanResult> {
    this.activeRequests += 1
    try {
      const result = await this.rpc.call('/dsh-dashboard', 'scanProjects', { rootId }) as RpcResult<unknown>
      if (!result.ok) {
        throw dashboardRpcError(result.error.code, result.error.message)
      }
      const scan = parseProjectScan(result.value)
      return scan
    } catch (error) {
      const normalized = normalizeDashboardError(error)
      throw normalized
    } finally {
      this.activeRequests -= 1
      if (this.activeRequests === 0 && this.state.loading) this.publish({ ...this.state, loading: false })
    }
  }

  private publish(next: DashboardDataState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

function parseSnapshot(value: unknown): DashboardSnapshot {
  if (value === null || typeof value !== 'object' || (value as { version?: unknown }).version !== 2) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned an unsupported state payload')
  }
  return value as DashboardSnapshot
}

function parseProjectScan(value: unknown): ProjectScanResult {
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { candidates?: unknown }).candidates)) {
    throw dashboardProtocolError(
      'response.unsupportedScan',
      'Dashboard Host returned an unsupported Project Catalog scan payload',
    )
  }
  return value as ProjectScanResult
}

function parseTimelinePage(value: unknown): TaskTimelinePage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported task timeline data')
  }
  const page = value as { events?: unknown; nextCursor?: unknown; coverage?: unknown; truncated?: unknown }
  if (!Array.isArray(page.events)
    || !page.events.every(isTimelineEvent)
    || (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
    || (page.coverage !== 'runtime-session' && page.coverage !== 'provider-summary')
    || typeof page.truncated !== 'boolean') {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported task timeline data')
  }
  return value as TaskTimelinePage
}

function parseRunDetail(value: unknown): RunDetailView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Run detail data')
  }
  const detail = value as { run?: unknown; events?: unknown; truncated?: unknown; tasks?: unknown }
  if (!isRunView(detail.run)
    || !Array.isArray(detail.events)
    || !detail.events.every(isRunEventView)
    || typeof detail.truncated !== 'boolean'
    || (detail.tasks !== undefined && (!Array.isArray(detail.tasks) || !detail.tasks.every(isTaskView)))) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Run detail data')
  }
  return value as RunDetailView
}

function parseRunPlan(value: unknown): RunPlanRecord {
  if (!isRunPlanRecord(value)) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Run Plan data')
  }
  return value as RunPlanRecord
}

function parseRunPlanList(value: unknown): readonly RunPlanRecord[] {
  if (!Array.isArray(value) || !value.every(isRunPlanRecord)) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Run Plan list data')
  }
  return value as readonly RunPlanRecord[]
}

function isRunPlanRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  return typeof plan.id === 'string'
    && typeof plan.runId === 'string'
    && typeof plan.projectId === 'string'
    && typeof plan.version === 'number'
    && typeof plan.pattern === 'string'
    && typeof plan.rationale === 'string'
    && Array.isArray(plan.assumptions)
    && Array.isArray(plan.successCriteria)
    && Array.isArray(plan.tasks)
    && typeof plan.status === 'string'
    && (plan.replanReason === undefined || typeof plan.replanReason === 'string')
    && (plan.supersedesPlanId === undefined || typeof plan.supersedesPlanId === 'string')
    && typeof plan.createdAt === 'string'
    && typeof plan.revision === 'number'
}

function isTaskView(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string'
    && typeof task.runId === 'string'
    && typeof task.planId === 'string'
    && typeof task.planTaskId === 'string'
    && typeof task.title === 'string'
    && (task.role === undefined || typeof task.role === 'string')
    && Array.isArray(task.dependencies)
    && typeof task.status === 'string'
    && (task.assignedAgentId === undefined || typeof task.assignedAgentId === 'string')
    && Array.isArray(task.acceptanceCriteria)
    && typeof task.attempt === 'number'
    && (task.maxAttempts === undefined || typeof task.maxAttempts === 'number')
    && (task.outputSummary === undefined || typeof task.outputSummary === 'string')
    && (task.error === undefined || typeof task.error === 'string')
    && (task.tokenUsage === undefined || (task.tokenUsage !== null && typeof task.tokenUsage === 'object'))
    && (task.turnCount === undefined || typeof task.turnCount === 'number')
    && (task.startedAt === undefined || typeof task.startedAt === 'string')
    && (task.completedAt === undefined || typeof task.completedAt === 'string')
    && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string'
    && typeof task.version === 'number'
}

function isRunView(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const run = value as Record<string, unknown>
  return typeof run.id === 'string'
    && typeof run.projectId === 'string'
    && typeof run.goal === 'string'
    && typeof run.phase === 'string'
    && typeof run.createdAt === 'string'
    && typeof run.updatedAt === 'string'
    && typeof run.version === 'number'
}

function isRunEventView(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return typeof event.id === 'string'
    && typeof event.type === 'string'
    && typeof event.title === 'string'
    && (event.detail === undefined || typeof event.detail === 'string')
    && typeof event.seq === 'number'
    && typeof event.at === 'string'
}

function isTimelineEvent(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return typeof event.id === 'string'
    && typeof event.type === 'string'
    && ['task', 'agent', 'scheduler', 'system'].includes(String(event.category))
    && typeof event.title === 'string'
    && (event.detail === undefined || typeof event.detail === 'string')
    && typeof event.at === 'string'
}

function parseMemoryList(value: unknown): MemoryListPayload {
  if (!isMemoryList(value)) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Project Memory list data')
  }
  return value as MemoryListPayload
}

function parseMemoryCreate(value: unknown): MemoryCreatePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Project Memory create data')
  }
  const created = value as { entry?: unknown; supersededId?: unknown }
  if (!isMemoryEntry(created.entry)
    || (created.supersededId !== undefined && typeof created.supersededId !== 'string')) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Project Memory create data')
  }
  return value as MemoryCreatePayload
}

function parseMemoryEntry(value: unknown): MemoryEntryView {
  if (!isMemoryEntry(value)) {
    throw dashboardProtocolError('response.unsupportedState', 'Dashboard Host returned unsupported Project Memory entry data')
  }
  return value as MemoryEntryView
}

function isMemoryList(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const list = value as { entries?: unknown; counts?: unknown }
  return Array.isArray(list.entries)
    && list.entries.every(isMemoryEntry)
    && isMemoryCounts(list.counts)
}

function isMemoryCounts(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const counts = value as Record<string, unknown>
  return CLIENT_MEMORY_KINDS.every(kind => typeof counts[kind] === 'number')
}

function isMemoryEntry(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.projectId === 'string'
    && typeof entry.kind === 'string'
    && (CLIENT_MEMORY_KINDS as readonly string[]).includes(entry.kind)
    && typeof entry.title === 'string'
    && typeof entry.body === 'string'
    && Array.isArray(entry.tags)
    && entry.tags.every(tag => typeof tag === 'string')
    && (entry.sourceRunId === undefined || typeof entry.sourceRunId === 'string')
    && (entry.sourceTaskId === undefined || typeof entry.sourceTaskId === 'string')
    && (entry.sourceSessionId === undefined || typeof entry.sourceSessionId === 'string')
    && (entry.confidence === undefined || typeof entry.confidence === 'number')
    && typeof entry.status === 'string'
    && ['active', 'superseded', 'archived'].includes(entry.status)
    && (entry.supersedes === undefined || typeof entry.supersedes === 'string')
    && (entry.pinned === undefined || typeof entry.pinned === 'boolean')
    && typeof entry.createdAt === 'string'
    && typeof entry.updatedAt === 'string'
    && typeof entry.version === 'number'
}
