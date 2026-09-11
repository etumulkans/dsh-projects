/** Trusted-host Connection RPC adapter for the Dashboard client. */

import type { DashboardRuntimeCoordinator } from '../runtime/coordinator.ts'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { DashboardDomainError, encodeDashboardError } from '../runtime/errors.ts'
import { RUN_PHASES } from '../runs/state-machine.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import { RUN_PLAN_PATTERNS, RUN_PLAN_STATUSES } from '../plans/spec.ts'
import type { RunPlanService } from '../plans/plan-service.ts'
import type { CreatePlanInput, PlannedTaskInput, RunPlanPattern, RunPlanStatus } from '../plans/types.ts'
import type { DashboardSnapshot } from '../runtime/types.ts'

/** Dispatch the intentionally small Dashboard RPC surface. */
export async function handleDashboardRpc(
  runtime: DashboardRuntimeCoordinator,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  ready: Promise<void> = Promise.resolve(),
  runs?: ProjectRunService,
  plans?: RunPlanService,
): Promise<RpcResult<unknown>> {
  if (signal.aborted) {
    return failure('cancelled', localizedError('request.cancelled', 'Dashboard request was cancelled'))
  }
  try {
    await ready
    if (signal.aborted) {
      return failure('cancelled', localizedError('request.cancelled', 'Dashboard request was cancelled'))
    }
    switch (endpoint) {
      case 'state':
        return success(await snapshotWithRuns(runtime, runs))
      case 'refresh':
        await runtime.refresh()
        return success(await snapshotWithRuns(runtime, runs))
      case 'issue': {
        const key = readStringField(payload, 'key')
        if (key === undefined) return badRequest('issue requires a non-empty `key`')
        const detail = runtime.issueDetail(key)
        return detail === undefined ? badRequest(`unknown issue key ${JSON.stringify(key)}`) : success(detail)
      }
      case 'timeline': {
        const key = readStringField(payload, 'key')
        const cursor = readTimelineCursor(payload)
        const limit = readOptionalInteger(payload, 'limit', 1, 100)
        if (key === undefined) return badRequest('timeline requires a non-empty `key`')
        if (cursor === false) return badRequest('timeline `cursor` is invalid')
        if (limit === false) return badRequest('timeline `limit` must be an integer from 1 to 100')
        const page = runtime.issueTimeline(key, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        })
        return page === undefined ? badRequest(`unknown issue key ${JSON.stringify(key)}`) : success(page)
      }
      case 'pause': {
        const paused = readBooleanField(payload, 'paused')
        if (paused === undefined) return badRequest('pause requires a boolean `paused`')
        runtime.setPaused(paused)
        return success(await runtime.snapshot())
      }
      case 'stop': {
        const key = readStringField(payload, 'key')
        if (key === undefined) return badRequest('stop requires a non-empty `key`')
        if (!runtime.stopIssue(key)) return badRequest(`issue ${JSON.stringify(key)} has no running Agent`)
        return success(await runtime.snapshot())
      }
      case 'createTask': {
        const input = readCreateTask(payload)
        if (typeof input === 'string') return badRequest(input)
        await runtime.createTask(input, signal)
        return success(await runtime.snapshot())
      }
      case 'updateTask': {
        const nativeRef = readStringField(payload, 'nativeRef')
        const changes = readUpdateTask(readObjectField(payload, 'changes'))
        if (nativeRef === undefined) return badRequest('updateTask requires a non-empty `nativeRef`')
        if (typeof changes === 'string') return badRequest(changes)
        await runtime.updateTask(nativeRef, changes, signal)
        return success(await runtime.snapshot())
      }
      case 'deleteTask': {
        const nativeRef = readStringField(payload, 'nativeRef')
        if (nativeRef === undefined) return badRequest('deleteTask requires a non-empty `nativeRef`')
        if (!await runtime.deleteTask(nativeRef, signal)) return badRequest(`unknown local task ${JSON.stringify(nativeRef)}`)
        return success(await runtime.snapshot())
      }
      case 'switchProject': {
        const projectId = readStringField(payload, 'projectId')
        if (projectId === undefined) return badRequest('switchProject requires a non-empty `projectId`')
        await runtime.switchProject(projectId)
        return success(await runtime.snapshot())
      }
      case 'switchGlobal': {
        await runtime.switchGlobal()
        return success(await runtime.snapshot())
      }
      case 'addDiscoveryRoot': {
        const path = readStringField(payload, 'path')
        const maxDepth = readOptionalInteger(payload, 'maxDepth', 1, 8)
        if (path === undefined) return badRequest('addDiscoveryRoot requires a non-empty `path`')
        if (maxDepth === false) return badRequest('addDiscoveryRoot `maxDepth` must be an integer from 1 to 8')
        await runtime.addDiscoveryRoot({ path, ...(maxDepth === undefined ? {} : { maxDepth }) })
        return success(await runtime.snapshot())
      }
      case 'removeDiscoveryRoot': {
        const id = readStringField(payload, 'id')
        if (id === undefined) return badRequest('removeDiscoveryRoot requires a non-empty `id`')
        if (!await runtime.removeDiscoveryRoot(id)) return badRequest(`unknown discovery root ${JSON.stringify(id)}`)
        return success(await runtime.snapshot())
      }
      case 'scanProjects': {
        const rootId = readStringField(payload, 'rootId')
        if (rootId === undefined) return badRequest('scanProjects requires a non-empty `rootId`')
        return success(await runtime.scanProjects(rootId, signal))
      }
      case 'registerProjectCandidate': {
        const token = readStringField(payload, 'token')
        if (token === undefined) return badRequest('registerProjectCandidate requires a non-empty `token`')
        await runtime.registerProjectCandidate(token)
        return success(await runtime.snapshot())
      }
      case 'registerProject': {
        const path = readStringField(payload, 'path')
        const name = readOptionalString(payload, 'name')
        if (path === undefined) return badRequest('registerProject requires a non-empty `path`')
        if (name === false) return badRequest('registerProject `name` must be a non-empty string when provided')
        await runtime.registerProject({ path, ...(name === undefined ? {} : { name }) })
        return success(await runtime.snapshot())
      }
      case 'runCreate': {
        if (runs === undefined) return badRequest('runCreate is unavailable: the Project Run service is not mounted')
        const input = readCreateRun(payload)
        if (typeof input === 'string') return badRequest(input)
        await runs.createRun(input, runtime.selection() ?? { mode: 'global' })
        return success(await snapshotWithRuns(runtime, runs))
      }
      case 'runDetail': {
        if (runs === undefined) return badRequest('runDetail is unavailable: the Project Run service is not mounted')
        const runId = readStringField(payload, 'runId')
        if (runId === undefined) return badRequest('runDetail requires a non-empty `runId`')
        return success(await runs.runDetail(runId))
      }
      case 'runTransition': {
        if (runs === undefined) return badRequest('runTransition is unavailable: the Project Run service is not mounted')
        const runId = readStringField(payload, 'runId')
        if (runId === undefined) return badRequest('runTransition requires a non-empty `runId`')
        const to = readRunPhase(payload)
        if (to === undefined) return badRequest('runTransition requires a valid `to` phase')
        const expectedVersion = readOptionalInteger(payload, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === false) return badRequest('runTransition `expectedVersion` must be a positive integer when provided')
        const error = readOptionalString(payload, 'error')
        if (error === false) return badRequest('runTransition `error` must be a non-empty string when provided')
        const resultSummary = readOptionalString(payload, 'resultSummary')
        if (resultSummary === false) return badRequest('runTransition `resultSummary` must be a non-empty string when provided')
        await runs.transitionRun(runId, to, {
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          ...(error === undefined ? {} : { error }),
          ...(resultSummary === undefined ? {} : { resultSummary }),
        })
        return success(await snapshotWithRuns(runtime, runs))
      }
      case 'planCreate': {
        if (plans === undefined) return badRequest('planCreate is unavailable: the Run Plan service is not mounted')
        const input = readCreatePlan(payload)
        if (typeof input === 'string') return badRequest(input)
        return success(await plans.createPlan(input))
      }
      case 'planList': {
        if (plans === undefined) return badRequest('planList is unavailable: the Run Plan service is not mounted')
        const runId = readStringField(payload, 'runId')
        if (runId === undefined) return badRequest('planList requires a non-empty `runId`')
        return success(plans.planList(runId))
      }
      case 'planDetail': {
        if (plans === undefined) return badRequest('planDetail is unavailable: the Run Plan service is not mounted')
        const planId = readStringField(payload, 'planId')
        if (planId === undefined) return badRequest('planDetail requires a non-empty `planId`')
        return success(plans.planDetail(planId))
      }
      case 'planTransition': {
        if (plans === undefined) return badRequest('planTransition is unavailable: the Run Plan service is not mounted')
        const planId = readStringField(payload, 'planId')
        if (planId === undefined) return badRequest('planTransition requires a non-empty `planId`')
        const status = readPlanStatus(payload)
        if (status === undefined) return badRequest('planTransition requires a valid `status`')
        const expectedRevision = readOptionalInteger(payload, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER)
        if (expectedRevision === false) return badRequest('planTransition `expectedRevision` must be a positive integer when provided')
        const replanReason = readOptionalString(payload, 'replanReason')
        if (replanReason === false) return badRequest('planTransition `replanReason` must be a non-empty string when provided')
        return success(await plans.transitionPlan(planId, status, {
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(replanReason === undefined ? {} : { replanReason }),
        }))
      }
      default:
        return badRequest(`unknown Dashboard endpoint ${JSON.stringify(endpoint)}`)
    }
  } catch (error) {
    if (signal.aborted) {
      return failure(
        'cancelled',
        localizedError(
          'request.cancelled',
          signal.reason instanceof Error ? signal.reason.message : 'Dashboard request was cancelled',
        ),
      )
    }
    const encoded = encodeDashboardError(error)
    return failure(
      encoded === undefined ? 'internal' : 'bad-request',
      encoded ?? (error instanceof Error ? error.message : String(error)),
    )
  }
}

function readCreateTask(value: unknown): import('../task-source/index.ts').CreateTaskInput | string {
  const object = readObject(value)
  const title = readStringField(object, 'title')
  if (title === undefined) return 'createTask requires a non-empty `title`'
  const description = readOptionalString(object, 'description')
  if (description === false) return 'createTask `description` must be a string when provided'
  const state = readOptionalString(object, 'state')
  if (state === false) return 'createTask `state` must be a non-empty string when provided'
  const priority = readOptionalPriority(object, 'priority')
  if (priority === false || priority === null) return 'createTask `priority` must be an integer from 1 to 4 when provided'
  return {
    title,
    ...(description === undefined ? {} : { description }),
    ...(state === undefined ? {} : { state }),
    ...(priority === undefined ? {} : { priority }),
  }
}

function readUpdateTask(value: unknown): import('../task-source/index.ts').UpdateTaskInput | string {
  const object = readObject(value)
  const title = readOptionalString(object, 'title')
  if (title === false) return 'updateTask `title` must be a non-empty string when provided'
  const description = readOptionalNullableString(object, 'description')
  if (description === false) return 'updateTask `description` must be a string or null when provided'
  const state = readOptionalString(object, 'state')
  if (state === false) return 'updateTask `state` must be a non-empty string when provided'
  const priority = readOptionalPriority(object, 'priority')
  if (priority === false) return 'updateTask `priority` must be an integer from 1 to 4, null, or omitted'
  const expectedUpdatedAt = readOptionalTimestamp(object, 'expectedUpdatedAt')
  if (expectedUpdatedAt === false) return 'updateTask `expectedUpdatedAt` must be an ISO timestamp when provided'
  if (![title, description, state, priority].some(field => field !== undefined)) return 'updateTask requires at least one change'
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(state === undefined ? {} : { state }),
    ...(priority === undefined ? {} : { priority }),
    ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
  }
}

/** Attach the additive `runs` projection without disturbing the base Dashboard snapshot. */
async function snapshotWithRuns(runtime: DashboardRuntimeCoordinator, runs?: ProjectRunService): Promise<DashboardSnapshot> {
  const snapshot = await runtime.snapshot()
  if (runs === undefined) return snapshot
  const selection = runtime.selection()
  if (selection === undefined) return snapshot
  return { ...snapshot, runs: await runs.listForSnapshot(selection) }
}

const RUN_SOURCES = ['manual', 'tracker', 'schedule', 'webhook', 'repository-event', 'system'] as const

function readCreateRun(value: unknown): import('../runs/types.ts').CreateRunInput | string {
  const object = readObject(value)
  const goal = readStringField(object, 'goal')
  if (goal === undefined) return 'runCreate requires a non-empty `goal`'
  const projectId = readOptionalString(object, 'projectId')
  if (projectId === false) return 'runCreate `projectId` must be a non-empty string when provided'
  const source = readOptionalString(object, 'source')
  if (source === false
    || (source !== undefined && !RUN_SOURCES.includes(source as (typeof RUN_SOURCES)[number]))) {
    return 'runCreate `source` must be one of manual | tracker | schedule | webhook | repository-event | system when provided'
  }
  const sourceRef = readOptionalString(object, 'sourceRef')
  if (sourceRef === false) return 'runCreate `sourceRef` must be a non-empty string when provided'
  return {
    goal,
    ...(projectId === undefined ? {} : { projectId }),
    ...(source === undefined ? {} : { source: source as import('../runs/types.ts').ProjectRunSource }),
    ...(sourceRef === undefined ? {} : { sourceRef }),
  }
}

function readRunPhase(value: unknown): import('../runs/types.ts').ProjectRunPhase | undefined {
  const object = readObject(value)
  const field = object?.['to']
  return typeof field === 'string' && (RUN_PHASES as readonly string[]).includes(field)
    ? (field as import('../runs/types.ts').ProjectRunPhase)
    : undefined
}

function readPlanStatus(value: unknown): RunPlanStatus | undefined {
  const object = readObject(value)
  const field = object?.['status']
  return typeof field === 'string' && (RUN_PLAN_STATUSES as readonly string[]).includes(field)
    ? (field as RunPlanStatus)
    : undefined
}

function readCreatePlan(value: unknown): CreatePlanInput | string {
  const object = readObject(value)
  const runId = readStringField(object, 'runId')
  if (runId === undefined) return 'planCreate requires a non-empty `runId`'
  const pattern = object?.['pattern']
  if (typeof pattern !== 'string' || !(RUN_PLAN_PATTERNS as readonly string[]).includes(pattern)) {
    return 'planCreate `pattern` must be one of direct | prompt-chain | parallel-workers | supervisor | router | evaluation-loop'
  }
  const rationale = readOptionalString(object, 'rationale')
  if (rationale === false) return 'planCreate `rationale` must be a non-empty string when provided'
  const assumptions = readStringArray(object, 'assumptions')
  if (assumptions === false) return 'planCreate `assumptions` must be an array of strings when provided'
  const successCriteria = readStringArray(object, 'successCriteria')
  if (successCriteria === false) return 'planCreate `successCriteria` must be an array of strings when provided'
  const tasks = readPlannedTasks(object)
  if (typeof tasks === 'string') return tasks
  const replanReason = readOptionalString(object, 'replanReason')
  if (replanReason === false) return 'planCreate `replanReason` must be a non-empty string when provided'
  return {
    runId,
    pattern: pattern as RunPlanPattern,
    rationale: rationale ?? '',
    ...(assumptions === undefined ? {} : { assumptions }),
    ...(successCriteria === undefined ? {} : { successCriteria }),
    ...(tasks === undefined ? {} : { tasks }),
    ...(replanReason === undefined ? {} : { replanReason }),
  }
}

function readPlannedTasks(value: unknown): readonly PlannedTaskInput[] | undefined | string {
  const object = readObject(value)
  const field = object?.['tasks']
  if (field === undefined) return undefined
  if (!Array.isArray(field)) return 'planCreate `tasks` must be an array when provided'
  const tasks: PlannedTaskInput[] = []
  for (let index = 0; index < field.length; index += 1) {
    const item = readObject(field[index])
    const title = item === undefined ? undefined : readStringField(item, 'title')
    const description = item === undefined ? undefined : readStringField(item, 'description')
    if (title === undefined) return `planCreate task t${index + 1} requires a non-empty \`title\``
    if (description === undefined) return `planCreate task t${index + 1} requires a non-empty \`description\``
    const dependencies = item === undefined ? undefined : readStringArray(item, 'dependencies')
    if (dependencies === false) return `planCreate task t${index + 1} \`dependencies\` must be an array of task ids when provided`
    const acceptanceCriteria = item === undefined ? undefined : readStringArray(item, 'acceptanceCriteria')
    if (acceptanceCriteria === false) return `planCreate task t${index + 1} \`acceptanceCriteria\` must be an array of strings when provided`
    tasks.push({
      title,
      description,
      ...(dependencies === undefined ? {} : { dependencies }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    })
  }
  return tasks
}

function readStringArray(value: unknown, key: string): string[] | undefined | false {
  const object = readObject(value)
  if (object === undefined || !(key in object)) return undefined
  const field = object[key]
  if (!Array.isArray(field) || field.some(item => typeof item !== 'string')) return false
  return [...field]
}

function success<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function failure(
  code: 'bad-request' | 'cancelled' | 'internal',
  message: string,
): RpcResult<never> {
  if (code === 'bad-request') return badRequest(message)
  if (code === 'cancelled') return { ok: false, error: { code, message, details: {} } }
  return { ok: false, error: { code, message, details: {} } }
}

function localizedError(code: 'request.cancelled', message: string): string {
  return encodeDashboardError(new DashboardDomainError(code, message)) ?? message
}

function readStringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() !== '' ? field : undefined
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  return readObject(readObject(value)?.[key])
}

function readOptionalString(value: unknown, key: string): string | undefined | false {
  const object = readObject(value)
  if (object === undefined || !(key in object)) return undefined
  const field = object[key]
  return typeof field === 'string' && field.trim() !== '' ? field.trim() : false
}

function readTimelineCursor(value: unknown): string | undefined | false {
  const cursor = readOptionalString(value, 'cursor')
  if (cursor === undefined || cursor === false) return cursor
  if (!cursor.startsWith('timeline:')) return false
  const separator = cursor.indexOf('|', 'timeline:'.length)
  if (separator < 0) return false
  try {
    const at = decodeURIComponent(cursor.slice('timeline:'.length, separator))
    const id = decodeURIComponent(cursor.slice(separator + 1))
    return Number.isFinite(Date.parse(at)) && id !== '' ? cursor : false
  } catch {
    return false
  }
}

function readOptionalNullableString(value: unknown, key: string): string | null | undefined | false {
  const object = readObject(value)
  if (object === undefined || !(key in object)) return undefined
  const field = object[key]
  if (field === null) return null
  return typeof field === 'string' ? field.trim() : false
}

function readOptionalPriority(value: unknown, key: string): number | null | undefined | false {
  const object = readObject(value)
  if (object === undefined || !(key in object)) return undefined
  const field = object[key]
  if (field === null) return null
  return typeof field === 'number' && Number.isInteger(field) && field >= 1 && field <= 4 ? field : false
}

function readOptionalTimestamp(value: unknown, key: string): string | undefined | false {
  const object = readObject(value)
  if (object === undefined || !(key in object)) return undefined
  const field = object[key]
  return typeof field === 'string' && field.trim() !== '' && Number.isFinite(Date.parse(field))
    ? new Date(field).toISOString()
    : false
}

function readOptionalInteger(value: unknown, key: string, minimum: number, maximum: number): number | undefined | false {
  const object = readObject(value)
  if (object === undefined || !(key in object)) return undefined
  const field = object[key]
  return typeof field === 'number' && Number.isInteger(field) && field >= minimum && field <= maximum ? field : false
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'boolean' ? field : undefined
}
