/** dsh-dashboard Host plugin: Symphony semantics over Harness-native services. */

import type { Context } from '@deepseek-ai/cordis'
import { basename, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config as ConfigSchema, type Config as PluginConfig } from './config.ts'
import { ProjectCatalog } from './catalog/catalog.ts'
import type { ProjectRecord } from './catalog/types.ts'
import { HarnessAgentRunner } from './agent/harness-runner.ts'
import { AsanaTaskSource } from './asana/source.ts'
import { GitHubTaskSource } from './github/source.ts'
import { GitLabTaskSource } from './gitlab/source.ts'
import { JiraTaskSource } from './jira/source.ts'
import { LinearTaskSource } from './linear/source.ts'
import { LocalTaskSource } from './local/source.ts'
import { DashboardOrchestrator } from './orchestrator/orchestrator.ts'
import { handleDashboardRpc } from './rpc/handler.ts'
import { CoordinatorService } from './coordinator/coordinator-service.ts'
import { PlanRunCoupler } from './coordinator/coupling.ts'
import { RunPlanService } from './plans/plan-service.ts'
import { ProjectRunService } from './runs/run-service.ts'
import { ApprovalService } from './approvals/approval-service.ts'
import type { PlanApprovalEvent } from './approvals/types.ts'
import { HarnessMemoryDistillationDriver } from './memory/distillation.ts'
import { ProjectMemoryService } from './memory/memory-service.ts'
import { ProjectArtifactService } from './artifacts/artifact-service.ts'
import { ProjectTriggerService } from './triggers/trigger-service.ts'
import { PUSH_ADAPTERS } from './triggers/adapters/index.ts'
import { LocalTaskWorker } from './tasks/local-adapter.ts'
import { TaskWorktreeManager } from './tasks/git-workspace.ts'
import { resolveTeamTaskWorker } from './tasks/team-adapter.ts'
import { ProjectTaskService } from './tasks/task-service.ts'
import { UnavailableWorker, type TaskWorker } from './tasks/worker.ts'
import { ScopedTaskSourceRegistry, TaskSourceRegistry } from './task-source/index.ts'
import { DashboardRuntimeCoordinator } from './runtime/coordinator.ts'
import { WorkflowStore } from './workflow/store.ts'
import { providerString, providerStringMap, requireProviderString, workflowStateOrder } from './workflow/provider.ts'
import { WorkspaceManager } from './workspace/manager.ts'
import { resolveWorkspaceRoot } from './workspace/path-safety.ts'

export { TaskSourceRegistry } from './task-source/index.ts'
export type { TaskSource } from './task-source/index.ts'
export type { DashboardSnapshot, IssueDetailView } from './runtime/types.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-dashboard'

/** Phase 9: the trigger poll tick cadence (spec §5.6) — drives the pull-based adapters. */
const TRIGGER_POLL_INTERVAL_MS = 30_000

/** Harness-native capabilities required by the Web bundle. */
export const inject = [
  'agentDefaultModel',
  'agents',
  'connection',
  'credentials',
  'permissionPresets',
  'sessions',
  'storageDomain',
  'tools',
]

/** Public plugin configuration schema. */
export const Config = ConfigSchema

/** Compose built-in providers, the orchestrator, and trusted client RPC. */
export function apply(ctx: Context, config: PluginConfig): void {
  const agentProfile = config.agentProfile
  const linearConfig = config.linear ?? { endpoint: 'https://api.linear.app/graphql', apiKeyRef: 'LINEAR_API_KEY' }
  const githubConfig = config.github ?? { endpoint: 'https://api.github.com', tokenRef: 'GITHUB_TOKEN' }
  const jiraConfig = config.jira ?? { emailRef: 'JIRA_EMAIL', apiTokenRef: 'JIRA_API_TOKEN' }
  const asanaConfig = config.asana ?? { endpoint: 'https://app.asana.com/api/1.0', tokenRef: 'ASANA_ACCESS_TOKEN' }
  const gitlabConfig = config.gitlab ?? { endpoint: 'https://gitlab.com/api/v4', tokenRef: 'GITLAB_TOKEN' }
  const localConfig = config.local ?? { storePath: '~/.dsh-dashboard/tasks.json' }
  for (const ref of [
    linearConfig.apiKeyRef,
    githubConfig.tokenRef,
    jiraConfig.emailRef,
    jiraConfig.apiTokenRef,
    asanaConfig.tokenRef,
    gitlabConfig.tokenRef,
  ]) credentialRef(ref)
  const currentProjectRoot = resolveWorkspaceRoot(config.currentProject.root)
  const catalog = new ProjectCatalog(ctx, {
    currentProject: config.currentProject,
    discoveryRoots: config.discovery.roots,
  })
  // Phase 7 (spec §6.1): stamp the config default approval mode on new runs.
  const runService = new ProjectRunService(ctx, catalog, undefined, config.policyDefaults.approvalMode)
  // Phase 2: Run Plans borrow the shared dsh_projects domain from the Run
  // service (one open per domain name); it starts/stops just inside it.
  // Phase 3: the guarded run-phase coupling observes every plan status change.
  // Phase 4: tasks execute through the resolved worker seam (spec §6.4) and
  // materialize from the active plan version via the same onPlanStatus hook.
  const taskWorker = resolveTaskWorker(ctx, config, agentProfile)
  // Phase 5: Git projects provision a worktree + branch per task (spec §4);
  // the merge-in-order integration strategy is the service's default.
  const taskWorktrees = new TaskWorktreeManager()
  // Phase 6 (spec §6/§8): Project Memory borrows the shared domain tables and
  // distills succeeded runs through the Harness session driver.
  const memoryService = new ProjectMemoryService(ctx, catalog, runService, new HarnessMemoryDistillationDriver(ctx))
  // Phase 7 (spec §4): the Approval service borrows the shared domain (the
  // memory-service pattern); the merge gate + plan trigger sites resolve
  // through it. `onApprovalResolved` is not wired to a side effect here — the
  // resolution is durable and surfaced through the run event stream.
  const approvalService = new ApprovalService(ctx, catalog, runService)
  // Phase 8 (spec §6/§7): the Artifact service borrows the shared domain
  // tables; its `run/completed` listener generates the final report at the
  // run's terminal transition (fire-and-forget, never a run failure).
  const artifactService = new ProjectArtifactService(ctx, catalog, runService)
  const taskService = new ProjectTaskService(
    ctx,
    catalog,
    runService,
    taskWorker,
    taskWorktrees,
    undefined, // integrationStrategy (service default: merge-in-order)
    undefined, // clock
    undefined, // retryClock
    memoryService,
    // Spec §6.3: fire-and-forget distillation after a run reaches succeeded.
    { onRunSucceeded: run => { void memoryService.distillRun(run) } },
    approvalService,
    // Phase 10 (spec §4.3): session-existence probe for restart reconciliation —
    // the real installed `ctx.agents.get(sessionId) !== undefined` (a live
    // agent is returned for a live session, `undefined` for a gone one).
    sessionId => ctx.agents.get(SessionId(sessionId)) !== undefined,
  )
  const coupler = new PlanRunCoupler(ctx, runService)
  const planService = new RunPlanService(ctx, runService, undefined, {
    onPlanStatus: async event => {
      await coupler.handle(event)
      await taskService.handlePlanStatus(event)
    },
    // Phase 7 (spec §4.4): mirror the three plan-approval transition points
    // onto the approval-object store. `requested` opens a pending object;
    // `approved`/`rejected` resolve the pending object (direct activation has
    // no pending object and is a no-op). A hook failure never undoes the plan
    // transition (the plan service guards the hook).
    onPlanApproval: async (event: PlanApprovalEvent) => {
      if (event.action === 'requested') {
        await approvalService.requestApproval({
          runId: event.runId,
          type: 'plan',
          summary: event.summary,
          payload: { planId: event.planId, version: event.version },
        })
        return
      }
      const pending = approvalService.pendingFor(event.runId, 'plan')
      if (pending === undefined) return
      await approvalService.resolveApproval(pending.id, event.action, {
        expectedVersion: pending.version,
        resolvedBy: 'plan-ui',
      })
    },
  })
  const coordinator = new CoordinatorService(ctx, catalog, runService, planService, agentProfile, undefined, undefined, memoryService)
  const sourceRegistry = new TaskSourceRegistry(ctx)
  // Phase 9 (spec §5/§9): the Trigger service borrows the shared domain tables
  // (the sibling-service pattern); it starts after the Run service and stops
  // before it. The pull-based adapters (tracker + schedule) are driven by a
  // periodic poll; the push-based adapters (webhook + repository-event +
  // pr-event + system) register `ctx.on` listeners.
  const triggerService = new ProjectTriggerService(ctx, catalog, runService, sourceRegistry)
  const runner = new HarnessAgentRunner(ctx, {
    permissionPreset: agentProfile.permissionPreset,
    ...(agentProfile.agentPreset === undefined ? {} : { agentPreset: agentProfile.agentPreset }),
    workerHost: agentProfile.workerHost,
  })
  const timestamp = new Date().toISOString()
  const initialProject: ProjectRecord = {
    id: 'current-workspace',
    name: basename(currentProjectRoot),
    root: currentProjectRoot,
    policyPath: resolve(currentProjectRoot, config.currentProject.policyPath),
    repositoryIds: [],
    workspaceStrategy: 'controlled-directory',
    autonomousClaims: false,
    source: 'current-workspace',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const providerConfigs = { linearConfig, githubConfig, jiraConfig, asanaConfig, gitlabConfig, localConfig }
  const runtime = new DashboardRuntimeCoordinator(ctx, catalog, {
    initialProject,
    parseOptions: { defaults: config.policyDefaults, agentProfile },
    createRuntime: (project, workflow) => {
      const sources = sourceRegistry.scope(project.id)
      const disposeSources = registerProjectSources(ctx, sources, workflow, providerConfigs)
      const workspaces = new WorkspaceManager(
        ctx,
        agentProfile.workerHost,
        () => catalog.projectWorkspaceSource(project.id) ?? (project.id === initialProject.id ? catalog.executionWorkspaceSource() : undefined),
      )
      const orchestrator = new DashboardOrchestrator(
        ctx,
        workflow,
        sources,
        workspaces,
        runner,
        catalog,
        {
          agentProfile: agentProfile.id,
          permissionPreset: agentProfile.permissionPreset,
          ...(agentProfile.agentPreset === undefined ? {} : { agentPreset: agentProfile.agentPreset }),
          workerHost: agentProfile.workerHost,
        },
      )
      return { orchestrator, disposeSources }
    },
  })

  let disposed = false
  const startup = catalog.start().then(async () => {
    if (disposed) return
    await runService.start()
    memoryService.start()
    approvalService.start()
    artifactService.start()
    // Phase 9: start the Trigger service (after the Run service) and register
    // the push-based adapters (their `ctx.on` listeners are wired here).
    triggerService.start()
    for (const adapter of PUSH_ADAPTERS) triggerService.registerAdapter(adapter)
    planService.start()
    coordinator.start()
    taskService.start()
    // Phase 10 (spec §4.1): reconcile the in-flight execution a process restart
    // orphaned — before the runtime drives new work, so a re-queued task is not
    // double-dispatched. A failure is logged, never fatal to boot.
    await taskService.reconcileAfterRestart().catch((error: unknown) => {
      ctx.logger.warn('dsh-projects: startup reconciliation failed: %s', error instanceof Error ? error.message : String(error))
    })
    await runtime.start()
  })

  ctx.connection.rpc.handle(
    '/dsh-dashboard',
    (endpoint, payload, signal) => handleDashboardRpc(runtime, endpoint, payload, signal, startup, runService, planService, coordinator, taskService, memoryService, approvalService, artifactService, triggerService),
    { authority: 'trusted-host' },
  )

  ctx.effect(() => {
    void startup.catch((error: unknown) => {
      ctx.logger.error('dsh-dashboard: runtime failed to start: %s', error instanceof Error ? error.message : String(error))
    })
    // Phase 9 (spec §5.6): the lightweight poll tick drives the pull-based
    // adapters (tracker + schedule). It starts once the services are up and is
    // cleared on teardown. A failed poll never tears down the tick (it logs and
    // retries on the next beat).
    let pollTimer: ReturnType<typeof setInterval> | undefined
    void startup.then(() => {
      if (disposed || pollTimer !== undefined) return
      pollTimer = setInterval(() => {
        void triggerService.pollDueTriggers().catch((error: unknown) => {
          ctx.logger.warn('dsh-dashboard: trigger poll failed: %s', error instanceof Error ? error.message : String(error))
        })
      }, TRIGGER_POLL_INTERVAL_MS)
    })
    return async () => {
      disposed = true
      await startup.catch(() => undefined)
      if (pollTimer !== undefined) clearInterval(pollTimer)
      await runtime.stop()
      taskService.stop()
      coordinator.stop()
      planService.stop()
      memoryService.stop()
      approvalService.stop()
      artifactService.stop()
      triggerService.stop()
      await runService.stop()
      await catalog.stop()
    }
  }, 'dsh-dashboard runtime')
}

/**
 * Resolve the Phase 4 task worker (spec §6.4): the local Harness worker by
 * default (always available — `ctx.agents` is a hard plugin dependency), or
 * the experimental Agent Teams worker when configured AND mounted, else the
 * explicit unavailable state (no silent fallback).
 */
function resolveTaskWorker(ctx: Context, config: PluginConfig, agentProfile: PluginConfig['agentProfile']): TaskWorker {
  const kind = config.projects?.taskWorker ?? 'local'
  if (kind === 'agent-teams') {
    return resolveTeamTaskWorker(ctx, agentProfile) ?? new UnavailableWorker()
  }
  return new LocalTaskWorker(ctx, agentProfile)
}

interface ProviderConfigs {
  readonly linearConfig: NonNullable<PluginConfig['linear']>
  readonly githubConfig: NonNullable<PluginConfig['github']>
  readonly jiraConfig: NonNullable<PluginConfig['jira']>
  readonly asanaConfig: NonNullable<PluginConfig['asana']>
  readonly gitlabConfig: NonNullable<PluginConfig['gitlab']>
  readonly localConfig: NonNullable<PluginConfig['local']>
}

function registerProjectSources(
  ctx: Context,
  sources: ScopedTaskSourceRegistry,
  workflow: WorkflowStore,
  configs: ProviderConfigs,
): () => void {
  const disposers = [
    sources.register(new LinearTaskSource(ctx.credentials, configs.linearConfig, () => {
      const current = workflow.require().tracker
      return {
        projectSlug: requireProviderString(current.provider, 'project_slug', 'linear'),
        ...(providerString(current.provider, 'context_label') === undefined ? {} : { contextLabel: providerString(current.provider, 'context_label')! }),
        ...(providerString(current.provider, 'assignee') === undefined ? {} : { assignee: providerString(current.provider, 'assignee')! }),
        terminalStates: current.terminal_states,
      }
    })),
    sources.register(new GitHubTaskSource(ctx.credentials, configs.githubConfig, () => {
      const current = workflow.require().tracker
      return {
        owner: requireProviderString(current.provider, 'owner', 'github'),
        repo: requireProviderString(current.provider, 'repo', 'github'),
        ...(providerString(current.provider, 'context_label') === undefined ? {} : { contextLabel: providerString(current.provider, 'context_label')! }),
        ...(providerString(current.provider, 'assignee') === undefined ? {} : { assignee: providerString(current.provider, 'assignee')! }),
        states: workflowStateOrder(current.active_states, current.terminal_states, workflow.require().dashboard.visible_states),
        activeStates: current.active_states,
        terminalStates: current.terminal_states,
        stateLabels: providerStringMap(current.provider, 'state_labels'),
      }
    })),
    sources.register(new JiraTaskSource(ctx.credentials, configs.jiraConfig, () => {
      const definition = workflow.require()
      const current = definition.tracker
      return {
        siteUrl: requireProviderString(current.provider, 'site_url', 'jira'),
        projectKey: requireProviderString(current.provider, 'project_key', 'jira'),
        ...(providerString(current.provider, 'context_label') === undefined ? {} : { contextLabel: providerString(current.provider, 'context_label')! }),
        ...(providerString(current.provider, 'assignee') === undefined ? {} : { assignee: providerString(current.provider, 'assignee')! }),
        ...(providerString(current.provider, 'jql') === undefined ? {} : { jql: providerString(current.provider, 'jql')! }),
        states: workflowStateOrder(current.active_states, current.terminal_states, definition.dashboard.visible_states),
        activeStates: current.active_states,
        terminalStates: current.terminal_states,
      }
    })),
    sources.register(new AsanaTaskSource(ctx.credentials, configs.asanaConfig, () => {
      const definition = workflow.require()
      const current = definition.tracker
      return {
        projectGid: requireProviderString(current.provider, 'project_gid', 'asana'),
        ...(providerString(current.provider, 'context_label') === undefined ? {} : { contextLabel: providerString(current.provider, 'context_label')! }),
        ...(providerString(current.provider, 'assignee') === undefined ? {} : { assignee: providerString(current.provider, 'assignee')! }),
        states: workflowStateOrder(current.active_states, current.terminal_states, definition.dashboard.visible_states),
        activeStates: current.active_states,
        terminalStates: current.terminal_states,
      }
    })),
    sources.register(new GitLabTaskSource(ctx.credentials, configs.gitlabConfig, () => {
      const definition = workflow.require()
      const current = definition.tracker
      return {
        projectId: requireProviderString(current.provider, 'project_id', 'gitlab'),
        ...(providerString(current.provider, 'context_label') === undefined ? {} : { contextLabel: providerString(current.provider, 'context_label')! }),
        ...(providerString(current.provider, 'assignee') === undefined ? {} : { assignee: providerString(current.provider, 'assignee')! }),
        states: workflowStateOrder(current.active_states, current.terminal_states, definition.dashboard.visible_states),
        activeStates: current.active_states,
        terminalStates: current.terminal_states,
        stateLabels: providerStringMap(current.provider, 'state_labels'),
      }
    })),
    sources.register(new LocalTaskSource(configs.localConfig, () => {
      const definition = workflow.require()
      const current = definition.tracker
      return {
        projectId: providerString(current.provider, 'project_id') ?? 'local',
        ...(providerString(current.provider, 'context_label') === undefined ? {} : { contextLabel: providerString(current.provider, 'context_label')! }),
        states: workflowStateOrder(current.active_states, current.terminal_states, definition.dashboard.visible_states),
        activeStates: current.active_states,
        terminalStates: current.terminal_states,
      }
    })),
  ]
  return () => {
    for (const dispose of disposers.toReversed()) dispose()
  }
}
