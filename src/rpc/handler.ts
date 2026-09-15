/** Trusted-host Connection RPC adapter for the Dashboard client. */

import type { DashboardRuntimeCoordinator } from '../runtime/coordinator.ts'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { DashboardDomainError, encodeDashboardError } from '../runtime/errors.ts'
import { RUN_PHASES } from '../runs/state-machine.ts'
import type { ProjectRunService } from '../runs/run-service.ts'
import { RUN_PLAN_PATTERNS, RUN_PLAN_STATUSES } from '../plans/spec.ts'
import type { RunPlanService } from '../plans/plan-service.ts'
import type { CreatePlanInput, PlannedTaskInput, RunPlanPattern, RunPlanStatus } from '../plans/types.ts'
import type { CoordinatorService } from '../coordinator/coordinator-service.ts'
import type { ProjectMemoryService } from '../memory/memory-service.ts'
import { MEMORY_KINDS, MEMORY_STATUSES, type MemoryKind, type MemoryStatus } from '../memory/types.ts'
import type { ProjectTaskService } from '../tasks/task-service.ts'
import type { ApprovalService } from '../approvals/approval-service.ts'
import { APPROVAL_MODES } from '../approvals/types.ts'
import type { ProjectArtifactService } from '../artifacts/artifact-service.ts'
import { ARTIFACT_KINDS, type ArtifactKind } from '../artifacts/types.ts'
import type { ProjectTriggerService } from '../triggers/trigger-service.ts'
import type { RunBudget } from '../runs/types.ts'
import { runBudgetSchema } from '../runs/spec.ts'
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
  coordinator?: CoordinatorService,
  tasks?: ProjectTaskService,
  memory?: ProjectMemoryService,
  approvals?: ApprovalService,
  artifacts?: ProjectArtifactService,
  triggers?: ProjectTriggerService,
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
        return success(await snapshotWithRuns(runtime, runs, tasks))
      case 'refresh':
        await runtime.refresh()
        return success(await snapshotWithRuns(runtime, runs, tasks))
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
        return success(await snapshotWithRuns(runtime, runs, tasks))
      }
      case 'runDetail': {
        if (runs === undefined) return badRequest('runDetail is unavailable: the Project Run service is not mounted')
        const runId = readStringField(payload, 'runId')
        if (runId === undefined) return badRequest('runDetail requires a non-empty `runId`')
        const detail = await runs.runDetail(runId)
        // Additive (Phase 4): attach the run's tasks when a task service is mounted.
        // Additive (Phase 7): attach the run's approvals when the Approval
        // service is mounted (the on-demand pattern, §6.2).
        // Additive (Phase 8): attach the run's artifacts + final report when the
        // Artifact service is mounted (the on-demand pattern, §7).
        const tasksList = tasks === undefined ? undefined : tasks.taskList(detail.run.id)
        const approvalsList = approvals === undefined ? undefined : approvals.listApprovals(detail.run.id)
        const artifactsList = artifacts === undefined ? undefined : artifacts.list({ runId: detail.run.id })
        // Additive (Phase 9): attach the run's originating trigger (resolved from
        // `sourceRef`) when the Trigger service is mounted (the on-demand pattern).
        const trigger = triggers !== undefined && detail.run.sourceRef !== undefined
          ? triggers.get(detail.run.sourceRef)
          : undefined
        if (tasksList === undefined && approvalsList === undefined && artifactsList === undefined && trigger === undefined) {
          return success(detail)
        }
        const finalReport = artifactsList === undefined ? undefined : artifactsList.find(artifact => artifact.kind === 'final-report')
        return success({
          ...detail,
          ...(tasksList === undefined ? {} : { tasks: tasksList }),
          ...(approvalsList === undefined ? {} : { approvals: approvalsList }),
          ...(artifactsList === undefined ? {} : { artifacts: artifactsList }),
          ...(finalReport === undefined ? {} : { finalReport }),
          ...(trigger === undefined ? {} : { trigger }),
        })
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
        return success(await snapshotWithRuns(runtime, runs, tasks))
      }
      case 'planCreate': {
        if (plans === undefined) return badRequest('planCreate is unavailable: the Run Plan service is not mounted')
        const input = readCreatePlan(payload)
        if (typeof input === 'string') return badRequest(input)
        return success(await plans.createPlan(input))
      }
      case 'planList': {
        if (plans === undefined) return badRequest('planList is unavailable: the Run Plan service is not mounted')
        const runId = readUuidField(payload, 'runId')
        if (runId === undefined) return badRequest('planList requires a uuid `runId`')
        return success(plans.planList(runId))
      }
      case 'planDetail': {
        if (plans === undefined) return badRequest('planDetail is unavailable: the Run Plan service is not mounted')
        const planId = readUuidField(payload, 'planId')
        if (planId === undefined) return badRequest('planDetail requires a uuid `planId`')
        return success(plans.planDetail(planId))
      }
      case 'planTransition': {
        if (plans === undefined) return badRequest('planTransition is unavailable: the Run Plan service is not mounted')
        const planId = readUuidField(payload, 'planId')
        if (planId === undefined) return badRequest('planTransition requires a uuid `planId`')
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
      case 'runCoordinate': {
        if (coordinator === undefined) return badRequest('runCoordinate is unavailable: the Coordinator service is not mounted')
        const runId = readUuidField(payload, 'runId')
        if (runId === undefined) return badRequest('runCoordinate requires a uuid `runId`')
        return success(await coordinator.coordinate(runId))
      }
      case 'taskRetry': {
        if (tasks === undefined) return badRequest('taskRetry is unavailable: the Task service is not mounted')
        const taskId = readUuidField(payload, 'taskId')
        if (taskId === undefined) return badRequest('taskRetry requires a uuid `taskId`')
        return success(await tasks.taskRetry(taskId))
      }
      case 'memoryList': {
        if (memory === undefined) return badRequest('memoryList is unavailable: the Project Memory service is not mounted')
        const projectId = readStringField(payload, 'projectId')
        if (projectId === undefined) return badRequest('memoryList requires a non-empty `projectId`')
        const query = readOptionalString(payload, 'query')
        if (query === false) return badRequest('memoryList `query` must be a non-empty string when provided')
        const kinds = readMemoryKinds(payload)
        if (kinds === false) return badRequest('memoryList `kinds` must be an array of memory kinds when provided')
        const tags = readStringArray(payload, 'tags')
        if (tags === false) return badRequest('memoryList `tags` must be an array of strings when provided')
        const limit = readOptionalInteger(payload, 'limit', 1, 100)
        if (limit === false) return badRequest('memoryList `limit` must be an integer from 1 to 100')
        const includeArchived = readBooleanField(payload, 'includeArchived')
        return success(await memory.list({
          projectId,
          ...(query === undefined ? {} : { query }),
          ...(kinds === undefined ? {} : { kinds }),
          ...(tags === undefined ? {} : { tags }),
          ...(limit === undefined ? {} : { limit }),
          ...(includeArchived === undefined ? {} : { includeArchived }),
        }))
      }
      case 'memoryCreate': {
        if (memory === undefined) return badRequest('memoryCreate is unavailable: the Project Memory service is not mounted')
        const projectId = readStringField(payload, 'projectId')
        if (projectId === undefined) return badRequest('memoryCreate requires a non-empty `projectId`')
        const kind = readMemoryKind(payload)
        if (kind === undefined) return badRequest('memoryCreate requires a valid `kind`')
        const title = readStringField(payload, 'title')
        if (title === undefined) return badRequest('memoryCreate requires a non-empty `title`')
        const body = readStringField(payload, 'body')
        if (body === undefined) return badRequest('memoryCreate requires a non-empty `body`')
        const tags = readStringArray(payload, 'tags')
        if (tags === false) return badRequest('memoryCreate `tags` must be an array of strings when provided')
        const pinned = readBooleanField(payload, 'pinned')
        const confidence = readOptionalConfidence(payload)
        if (confidence === false) return badRequest('memoryCreate `confidence` must be a number from 0 to 1 when provided')
        return success(await memory.create({
          projectId,
          kind,
          title,
          body,
          ...(tags === undefined ? {} : { tags }),
          ...(pinned === undefined ? {} : { pinned }),
          ...(confidence === undefined ? {} : { confidence }),
        }))
      }
      case 'memoryUpdate': {
        if (memory === undefined) return badRequest('memoryUpdate is unavailable: the Project Memory service is not mounted')
        const id = readStringField(payload, 'id')
        if (id === undefined) return badRequest('memoryUpdate requires a non-empty `id`')
        const expectedVersion = readOptionalInteger(payload, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === undefined) return badRequest('memoryUpdate requires a positive integer `expectedVersion`')
        if (expectedVersion === false) return badRequest('memoryUpdate `expectedVersion` must be a positive integer')
        const title = readOptionalString(payload, 'title')
        if (title === false) return badRequest('memoryUpdate `title` must be a non-empty string when provided')
        const body = readOptionalString(payload, 'body')
        if (body === false) return badRequest('memoryUpdate `body` must be a non-empty string when provided')
        const tags = readStringArray(payload, 'tags')
        if (tags === false) return badRequest('memoryUpdate `tags` must be an array of strings when provided')
        const pinned = readBooleanField(payload, 'pinned')
        if (![title, body, tags, pinned].some(field => field !== undefined)) {
          return badRequest('memoryUpdate requires at least one patch field')
        }
        return success(await memory.update(id, expectedVersion, {
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(tags === undefined ? {} : { tags }),
          ...(pinned === undefined ? {} : { pinned }),
        }))
      }
      case 'memorySetStatus': {
        if (memory === undefined) return badRequest('memorySetStatus is unavailable: the Project Memory service is not mounted')
        const id = readStringField(payload, 'id')
        if (id === undefined) return badRequest('memorySetStatus requires a non-empty `id`')
        const expectedVersion = readOptionalInteger(payload, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === undefined) return badRequest('memorySetStatus requires a positive integer `expectedVersion`')
        if (expectedVersion === false) return badRequest('memorySetStatus `expectedVersion` must be a positive integer')
        const status = readMemoryStatus(payload)
        if (status === undefined) return badRequest('memorySetStatus requires a valid `status`')
        return success(await memory.setStatus(id, expectedVersion, status))
      }
      case 'approvalList': {
        if (approvals === undefined) return badRequest('approvalList is unavailable: the Approval service is not mounted')
        const runId = readUuidField(payload, 'runId')
        const projectId = readOptionalString(payload, 'projectId')
        if (projectId === false) return badRequest('approvalList `projectId` must be a non-empty string when provided')
        if (runId === undefined && projectId === undefined) {
          return badRequest('approvalList requires a uuid `runId` or a non-empty `projectId`')
        }
        const list = approvals.listApprovals(runId, projectId)
        return success({ approvals: list })
      }
      case 'approvalResolve': {
        if (approvals === undefined) return badRequest('approvalResolve is unavailable: the Approval service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('approvalResolve requires a uuid `id`')
        const decision = readApprovalDecision(payload)
        if (decision === undefined) return badRequest('approvalResolve requires a `decision` of approved | rejected')
        const expectedVersion = readOptionalInteger(payload, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === false) return badRequest('approvalResolve `expectedVersion` must be a positive integer when provided')
        const resolvedBy = readOptionalString(payload, 'resolvedBy')
        if (resolvedBy === false) return badRequest('approvalResolve `resolvedBy` must be a non-empty string when provided')
        return success(await approvals.resolveApproval(id, decision, {
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          ...(resolvedBy === undefined ? {} : { resolvedBy }),
        }))
      }
      case 'approvalExpire': {
        if (approvals === undefined) return badRequest('approvalExpire is unavailable: the Approval service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('approvalExpire requires a uuid `id`')
        const expectedVersion = readOptionalInteger(payload, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === false) return badRequest('approvalExpire `expectedVersion` must be a positive integer when provided')
        return success(await approvals.expireApproval(id, {
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        }))
      }
      case 'artifactList': {
        if (artifacts === undefined) return badRequest('artifactList is unavailable: the Artifact service is not mounted')
        const runId = readUuidField(payload, 'runId')
        const projectId = readOptionalString(payload, 'projectId')
        if (projectId === false) return badRequest('artifactList `projectId` must be a non-empty string when provided')
        const kind = readArtifactKind(payload)
        if (kind === false) return badRequest('artifactList `kind` must be a valid artifact kind when provided')
        if (runId === undefined && projectId === undefined) {
          return badRequest('artifactList requires a uuid `runId` or a non-empty `projectId`')
        }
        const list = artifacts.list({
          ...(runId === undefined ? {} : { runId }),
          ...(runId === undefined && projectId !== undefined ? { projectId } : {}),
          ...(kind === undefined ? {} : { kind }),
        })
        return success({ artifacts: list })
      }
      case 'artifactCreate': {
        if (artifacts === undefined) return badRequest('artifactCreate is unavailable: the Artifact service is not mounted')
        const input = readCreateArtifact(payload)
        if (typeof input === 'string') return badRequest(input)
        return success(await artifacts.create(input))
      }
      case 'artifactGet': {
        if (artifacts === undefined) return badRequest('artifactGet is unavailable: the Artifact service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('artifactGet requires a uuid `id`')
        const record = artifacts.get(id)
        if (record === undefined) {
          throw new DashboardDomainError('artifact.unknown', `Unknown artifact ${id}`, { id })
        }
        return success(record)
      }
      case 'runGenerateReport': {
        if (artifacts === undefined) return badRequest('runGenerateReport is unavailable: the Artifact service is not mounted')
        const runId = readUuidField(payload, 'runId')
        if (runId === undefined) return badRequest('runGenerateReport requires a uuid `runId`')
        // on-demand mode: the service throws the structured artifact.runUnknown /
        // artifact.reportFailed error (the outer catch encodes it for the client).
        const report = await artifacts.generateFinalReport(runId, 'on-demand')
        return success(report)
      }
      case 'triggerList': {
        if (triggers === undefined) return badRequest('triggerList is unavailable: the Trigger service is not mounted')
        const projectId = readOptionalString(payload, 'projectId')
        if (projectId === false || projectId === undefined) {
          return badRequest('triggerList requires a non-empty `projectId`')
        }
        return success({ triggers: triggers.listProjected(projectId) })
      }
      case 'triggerCreate': {
        if (triggers === undefined) return badRequest('triggerCreate is unavailable: the Trigger service is not mounted')
        const input = readCreateTrigger(payload)
        if (typeof input === 'string') return badRequest(input)
        return success(await triggers.create(input))
      }
      case 'triggerGet': {
        if (triggers === undefined) return badRequest('triggerGet is unavailable: the Trigger service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('triggerGet requires a uuid `id`')
        const record = triggers.getProjected(id)
        if (record === undefined) throw new DashboardDomainError('trigger.unknown', `Unknown trigger ${id}`, { id })
        return success(record)
      }
      case 'triggerUpdate': {
        if (triggers === undefined) return badRequest('triggerUpdate is unavailable: the Trigger service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('triggerUpdate requires a uuid `id`')
        const patch = readUpdateTrigger(payload)
        if (typeof patch === 'string') return badRequest(patch)
        return success(await triggers.update(id, patch))
      }
      case 'triggerSetEnabled': {
        if (triggers === undefined) return badRequest('triggerSetEnabled is unavailable: the Trigger service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('triggerSetEnabled requires a uuid `id`')
        const enabled = payload !== null && typeof payload === 'object' && 'enabled' in payload && typeof (payload as { enabled?: unknown }).enabled === 'boolean'
          ? (payload as { enabled: boolean }).enabled
          : false
        return success(await triggers.setEnabled(id, enabled))
      }
      case 'triggerDelete': {
        if (triggers === undefined) return badRequest('triggerDelete is unavailable: the Trigger service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('triggerDelete requires a uuid `id`')
        await triggers.delete(id)
        return success({ ok: true })
      }
      case 'triggerFire': {
        if (triggers === undefined) return badRequest('triggerFire is unavailable: the Trigger service is not mounted')
        const id = readUuidField(payload, 'id')
        if (id === undefined) return badRequest('triggerFire requires a uuid `id`')
        // The `event` is optional — a `triggerFire` without an event fires a
        // synthetic "manual fire" event (the UI's "Run now" affordance), so it
        // is not idempotent (the explicit-intent semantics).
        const event = readTriggerEvent(payload)
        return success(await triggers.fire(id, event))
      }
      case 'runSetBudget': {
        if (runs === undefined) return badRequest('runSetBudget is unavailable: the Project Run service is not mounted')
        const runId = readUuidField(payload, 'runId')
        if (runId === undefined) return badRequest('runSetBudget requires a uuid `runId`')
        const budget = readRunBudget(payload)
        if (typeof budget === 'string') return badRequest(budget)
        if (budget === undefined) return badRequest('runSetBudget requires a `budget` object')
        const expectedVersion = readOptionalInteger(payload, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === false) return badRequest('runSetBudget `expectedVersion` must be a positive integer when provided')
        return success(await runs.setRunBudget(runId, budget, expectedVersion))
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
async function snapshotWithRuns(
  runtime: DashboardRuntimeCoordinator,
  runs?: ProjectRunService,
  tasks?: ProjectTaskService,
): Promise<DashboardSnapshot> {
  const snapshot = await runtime.snapshot()
  if (runs === undefined) return snapshot
  const selection = runtime.selection()
  if (selection === undefined) return snapshot
  const summary = await runs.listForSnapshot(selection)
  // Additive (Phase 4): the worker kind + per-run task counts when a task service is mounted.
  if (tasks === undefined) return { ...snapshot, runs: summary }
  return {
    ...snapshot,
    runs: {
      ...summary,
      worker: tasks.workerKind(),
      runs: summary.runs.map(view => ({ ...view, taskCounts: tasks.taskCounts(view.id) })),
    },
  }
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
  // Phase 7 (spec §6.2): optional approval mode + budget.
  const approvalMode = readApprovalMode(object)
  if (approvalMode === false) return 'runCreate `approvalMode` must be one of manual | plan | guarded | autonomous when provided'
  const budget = readRunBudget(object)
  if (typeof budget === 'string') return `runCreate ${budget}`
  return {
    goal,
    ...(projectId === undefined ? {} : { projectId }),
    ...(source === undefined ? {} : { source: source as import('../runs/types.ts').ProjectRunSource }),
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(approvalMode === undefined ? {} : { approvalMode }),
    ...(budget === undefined ? {} : { budget }),
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

/** Phase 7: `approvalResolve` decision — `approved` | `rejected`. */
function readApprovalDecision(value: unknown): 'approved' | 'rejected' | undefined {
  const object = readObject(value)
  const field = object?.['decision']
  return field === 'approved' || field === 'rejected' ? field : undefined
}

/** Phase 8: an artifact kind. `false` = present but invalid. */
function readArtifactKind(value: unknown): ArtifactKind | undefined | false {
  const object = readObject(value)
  if (object === undefined || !('kind' in object)) return undefined
  const field = object['kind']
  return typeof field === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(field)
    ? (field as ArtifactKind)
    : false
}

/**
 * Phase 8: read the `artifactCreate` input. Returns `undefined`-free input when
 * well-formed, or an error string. The semantic validation (the §5.3 reasons,
 * the 64 KB bound, the secrets scan) happens in the service, which throws the
 * structured `artifact.*` errors.
 */
function readCreateArtifact(value: unknown): import('../artifacts/types.ts').ArtifactCreateInput | string {
  const object = readObject(value)
  const projectId = readStringField(object, 'projectId')
  if (projectId === undefined) return 'artifactCreate requires a non-empty `projectId`'
  const runId = readUuidField(object, 'runId')
  if (runId !== undefined && !UUID_PATTERN.test(runId)) return 'artifactCreate `runId` must be a uuid when provided'
  const taskId = readUuidField(object, 'taskId')
  if (taskId !== undefined && !UUID_PATTERN.test(taskId)) return 'artifactCreate `taskId` must be a uuid when provided'
  const kind = readArtifactKind(object)
  if (kind === false) return 'artifactCreate `kind` must be a valid artifact kind'
  if (kind === undefined) return 'artifactCreate requires a `kind`'
  const title = readStringField(object, 'title')
  if (title === undefined) return 'artifactCreate requires a non-empty `title`'
  // Optional reference/content fields: present-but-empty is dropped (treated as
  // absent) — the service's §5.3 rules then apply to whatever is provided.
  const content = readOptionalString(object, 'content')
  const path = readOptionalString(object, 'path')
  const url = readOptionalString(object, 'url')
  const metadata = readObjectField(object, 'metadata')
  return {
    projectId,
    ...(runId === undefined ? {} : { runId }),
    ...(taskId === undefined ? {} : { taskId }),
    kind,
    title,
    ...(content === undefined || content === false ? {} : { content }),
    ...(path === undefined || path === false ? {} : { path }),
    ...(url === undefined || url === false ? {} : { url }),
    ...(metadata === undefined ? {} : { metadata: metadata as Record<string, unknown> }),
  }
}

/** Phase 9: `triggerCreate` input. The per-type `config` shape is validated by the service. */
function readCreateTrigger(value: unknown): import('../triggers/types.ts').TriggerCreateInput | string {
  const object = readObject(value)
  const projectId = readStringField(object, 'projectId')
  if (projectId === undefined) return 'triggerCreate requires a non-empty `projectId`'
  const type = readStringField(object, 'type')
  if (type === undefined) return 'triggerCreate requires a non-empty `type`'
  const goalTemplate = readStringField(object, 'goalTemplate')
  if (goalTemplate === undefined) return 'triggerCreate requires a non-empty `goalTemplate`'
  const config = readObjectField(object, 'config')
  const approvalMode = readApprovalMode(object)
  if (approvalMode === false) return 'triggerCreate `approvalMode` must be a valid approval mode when provided'
  return {
    projectId,
    type,
    ...(config === undefined ? { config: {} } : { config: config as Record<string, unknown> }),
    goalTemplate,
    ...(approvalMode === undefined ? {} : { approvalMode }),
  }
}

/** Phase 9: `triggerUpdate` patch (a partial — at least one field required). */
function readUpdateTrigger(value: unknown): import('../triggers/types.ts').TriggerUpdateInput | string {
  const object = readObject(value)
  if (object === undefined) return 'triggerUpdate requires an object'
  const goalTemplate = readOptionalString(object, 'goalTemplate')
  const config = readObjectField(object, 'config')
  const approvalMode = readApprovalMode(object)
  if (approvalMode === false) return 'triggerUpdate `approvalMode` must be a valid approval mode when provided'
  const hasGoal = goalTemplate !== undefined && goalTemplate !== false
  const hasConfig = config !== undefined
  const hasApproval = approvalMode !== undefined
  if (!hasGoal && !hasConfig && !hasApproval) {
    return 'triggerUpdate requires at least one of `goalTemplate`, `config`, or `approvalMode`'
  }
  return {
    ...(hasGoal ? { goalTemplate: goalTemplate as string } : {}),
    ...(hasConfig ? { config: config as Record<string, unknown> } : {}),
    ...(hasApproval ? { approvalMode } : {}),
  }
}

/** Phase 9: `triggerFire` event. Optional — a synthetic "manual fire" when absent (the "Run now" affordance). */
function readTriggerEvent(value: unknown): import('../triggers/types.ts').TriggerEvent {
  const object = readObject(value)
  const eventField = object !== undefined ? object['event'] : undefined
  if (eventField !== undefined && eventField !== null && typeof eventField === 'object' && !Array.isArray(eventField)) {
    const eventObject = eventField as Record<string, unknown>
    const sourceEventKey = typeof eventObject['sourceEventKey'] === 'string' && eventObject['sourceEventKey'] !== ''
      ? eventObject['sourceEventKey']
      : undefined
    if (sourceEventKey !== undefined) {
      const data: Record<string, string> = {}
      const dataField = eventObject['data']
      if (dataField !== undefined && dataField !== null && typeof dataField === 'object' && !Array.isArray(dataField)) {
        for (const [key, field] of Object.entries(dataField as Record<string, unknown>)) {
          if (typeof field === 'string') data[key] = field
        }
      }
      return { sourceEventKey, data }
    }
  }
  // The synthetic "manual fire" event (the UI's "Run now" affordance) — not
  // idempotent (the explicit-intent semantics).
  return { sourceEventKey: `manual:${crypto.randomUUID()}`, data: {} }
}

/** Phase 7: `runCreate` approval mode. `false` = present but invalid. */
function readApprovalMode(value: unknown): import('../approvals/types.ts').ApprovalMode | undefined | false {
  const object = readObject(value)
  if (object === undefined || !('approvalMode' in object)) return undefined
  const field = object['approvalMode']
  return typeof field === 'string' && (APPROVAL_MODES as readonly string[]).includes(field)
    ? (field as import('../approvals/types.ts').ApprovalMode)
    : false
}

/**
 * Phase 7: read the optional `budget` object. Returns `undefined` when absent,
 * a `RunBudget` when present (schema validation happens in the service, which
 * throws `run.budgetInvalid`), or an error string when present but not an object.
 */
function readRunBudget(value: unknown): RunBudget | undefined | string {
  const object = readObject(value)
  if (object === undefined || !('budget' in object)) return undefined
  const field = object['budget']
  if (typeof field !== 'object' || field === null || Array.isArray(field)) {
    return '`budget` must be an object when provided'
  }
  return field as RunBudget
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** Spec §7: plan endpoint ids must be uuids — anything else is a bad request. */
function readUuidField(value: unknown, field: string): string | undefined {
  const object = readObject(value)
  const id = object === undefined ? undefined : readStringField(object, field)
  if (id === undefined || !UUID_PATTERN.test(id)) return undefined
  return id
}

function readCreatePlan(value: unknown): CreatePlanInput | string {
  const object = readObject(value)
  const runId = readUuidField(object, 'runId')
  if (runId === undefined) return 'planCreate requires a uuid `runId`'
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

/** Spec §9: a single memory kind — anything outside the fixed set is invalid. */
function readMemoryKind(value: unknown): string | undefined {
  const object = readObject(value)
  const field = object?.['kind']
  return typeof field === 'string' && (MEMORY_KINDS as readonly string[]).includes(field) ? field : undefined
}

/** Spec §9: a list of memory kinds; `false` marks an invalid payload shape. */
function readMemoryKinds(value: unknown): MemoryKind[] | undefined | false {
  const object = readObject(value)
  if (object === undefined || !('kinds' in object)) return undefined
  const field = object['kinds']
  if (!Array.isArray(field)
    || field.some(item => typeof item !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(item))) {
    return false
  }
  return field as MemoryKind[]
}

/** Spec §9: the target status for memorySetStatus. */
function readMemoryStatus(value: unknown): MemoryStatus | undefined {
  const object = readObject(value)
  const field = object?.['status']
  return typeof field === 'string' && (MEMORY_STATUSES as readonly string[]).includes(field)
    ? (field as MemoryStatus)
    : undefined
}

/** Spec §9: confidence is a finite number in [0, 1] when provided. */
function readOptionalConfidence(value: unknown): number | undefined | false {
  const object = readObject(value)
  if (object === undefined || !('confidence' in object)) return undefined
  const field = object['confidence']
  return typeof field === 'number' && Number.isFinite(field) && field >= 0 && field <= 1 ? field : false
}
