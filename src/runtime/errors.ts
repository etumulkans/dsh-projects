/** Stable, JSON-safe error metadata shared across the Dashboard Host/client boundary. */

export type DashboardErrorCode =
  | 'catalog.candidateExpired'
  | 'catalog.globalEmpty'
  | 'catalog.maxDepthInvalid'
  | 'catalog.pathAbsolute'
  | 'catalog.pathEscapesRoot'
  | 'catalog.pathNotDirectory'
  | 'catalog.projectNameInvalid'
  | 'catalog.projectUnknown'
  | 'catalog.rootRemoved'
  | 'catalog.rootUnknown'
  | 'coordinator.inProgress'
  | 'coordinator.notStarted'
  | 'coordinator.projectUnknown'
  | 'coordinator.runPhaseInvalid'
  // Additive (Phase 7): approval objects (master spec §19).
  | 'approval.notStarted'
  | 'approval.runUnknown'
  | 'approval.invalidStatus'
  | 'approval.staleVersion'
  | 'approval.unknown'
  // Additive (Phase 8): the artifact store (master spec §26, spec §8).
  | 'artifact.notStarted'
  | 'artifact.unknown'
  | 'artifact.runUnknown'
  | 'artifact.badRequest'
  | 'artifact.invalidCandidate'
  | 'artifact.contentTooLarge'
  | 'artifact.missingUrl'
  | 'artifact.kindReserved'
  | 'artifact.containsSecrets'
  | 'artifact.reportFailed'
  // Additive (Phase 9): the trigger store (master spec §27, spec §7).
  | 'trigger.notStarted'
  | 'trigger.unknown'
  | 'trigger.badRequest'
  | 'trigger.invalidCandidate'
  | 'trigger.manualReserved'
  | 'trigger.containsSecrets'
  | 'trigger.disabled'
  | 'trigger.goalEmpty'
  | 'trigger.goalTooLong'
  | 'local.priorityInvalid'
  | 'local.projectInvalid'
  | 'local.stateUnknown'
  | 'local.storeInvalidJson'
  | 'local.storeProjectInvalid'
  | 'local.storeSchemaUnsupported'
  | 'local.storeTargetInvalid'
  | 'local.storeTaskInvalid'
  | 'local.taskChanged'
  | 'local.taskNotFound'
  | 'local.titleEmpty'
  | 'local.titleTooLong'
  | 'local.workflowStatesMissing'
  | 'memory.invalidCandidate'
  | 'memory.immutable'
  | 'memory.invalidStatus'
  | 'memory.notStarted'
  | 'memory.projectNotFound'
  | 'memory.staleVersion'
  | 'memory.unknown'
  | 'global.readOnly'
  | 'project.workflowInvalid'
  | 'plan.contentInvalid'
  | 'plan.notStarted'
  | 'plan.patternRequiresTasks'
  | 'plan.rationaleEmpty'
  | 'plan.rationaleTooLong'
  // Additive (Phase 7): the replan budget (master spec §30).
  | 'plan.replanBudgetExceeded'
  | 'plan.revisionConflict'
  | 'plan.runTerminal'
  | 'plan.runUnknown'
  | 'plan.supersedeReasonMissing'
  | 'plan.taskDependencyInvalid'
  | 'plan.taskTitleEmpty'
  | 'plan.tasksTooMany'
  | 'plan.transitionInvalid'
  | 'plan.unknown'
  // Additive (Phase 7): budget enforcement (master spec §30).
  | 'run.budgetInvalid'
  | 'run.budgetPhaseInvalid'
  | 'run.goalEmpty'
  | 'run.goalTooLong'
  | 'run.notStarted'
  | 'run.phaseUnknown'
  | 'run.projectRequired'
  | 'run.projectUnknown'
  | 'run.transitionInvalid'
  | 'run.unknown'
  | 'run.versionConflict'
  | 'task.commitFailed'
  | 'task.dagInvalid'
  | 'task.notStarted'
  // Additive (Phase 7): the per-task retry budget (master spec §30).
  | 'task.retryBudgetExceeded'
  | 'task.retryNotAllowed'
  | 'task.unknown'
  | 'task.workerUnavailable'
  | 'task.workspaceConflict'
  | 'task.worktreeFailed'
  | 'request.cancelled'
  | 'response.unsupportedScan'
  | 'response.unsupportedState'

export type DashboardErrorParams = Readonly<Record<string, string | number>>

export interface DashboardErrorEnvelope {
  readonly dashboardCode: string
  readonly params?: DashboardErrorParams
  readonly fallbackMessage: string
}

const DASHBOARD_ERROR_PREFIX = 'dsh-dashboard-error:'

/** Plugin-owned failure whose localized presentation belongs to the Dashboard client. */
export class DashboardDomainError extends Error {
  readonly dashboardCode: DashboardErrorCode
  readonly params: DashboardErrorParams

  constructor(dashboardCode: DashboardErrorCode, message: string, params: DashboardErrorParams = {}) {
    super(message)
    this.name = 'DashboardDomainError'
    this.dashboardCode = dashboardCode
    this.params = params
  }
}

/** Encode metadata into the message because the Harness RpcError detail variants are closed. */
export function encodeDashboardError(error: unknown): string | undefined {
  if (!(error instanceof DashboardDomainError)) return undefined
  const envelope = Object.keys(error.params).length === 0
    ? { dashboardCode: error.dashboardCode, fallbackMessage: error.message }
    : { dashboardCode: error.dashboardCode, params: { ...error.params }, fallbackMessage: error.message }
  return `${DASHBOARD_ERROR_PREFIX}${JSON.stringify(envelope)}`
}

/** Decode trusted Dashboard metadata while treating malformed or foreign messages as ordinary text. */
export function decodeDashboardError(message: string): DashboardErrorEnvelope | undefined {
  if (!message.startsWith(DASHBOARD_ERROR_PREFIX)) return undefined
  try {
    const value = JSON.parse(message.slice(DASHBOARD_ERROR_PREFIX.length)) as unknown
    if (!isRecord(value) || typeof value.dashboardCode !== 'string' || typeof value.fallbackMessage !== 'string') {
      return undefined
    }
    const params = readParams(value.params)
    return params === undefined
      ? { dashboardCode: value.dashboardCode, fallbackMessage: value.fallbackMessage }
      : { dashboardCode: value.dashboardCode, params, fallbackMessage: value.fallbackMessage }
  } catch {
    return undefined
  }
}

function readParams(value: unknown): DashboardErrorParams | undefined {
  if (!isRecord(value)) return undefined
  const params: Record<string, string | number> = {}
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string' || typeof field === 'number') params[key] = field
  }
  return Object.keys(params).length === 0 ? undefined : params
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
