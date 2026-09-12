/**
 * DSH Projects Phase 4 — Agent Teams task worker (spec §6.3, experimental).
 *
 * **This is the only file in the codebase that may reference the experimental
 * `ctx.agentTeams` surface** (architecture doc §4; invariant 1). The installed
 * `TeamService` is caller-scoped — every method takes `caller: Agent` — so
 * the worker establishes one Lead agent session per task, spawns one
 * teammate for the work, posts the work as a shared team task, waits for the
 * terminal edge, and disposes the Lead (tearing the team down with it).
 *
 * The surface is explicitly experimental (master spec §13): this file is
 * expected to be the only file that needs significant modification if the API
 * changes. Disabled unless the plugin config selects `agent-teams` AND the
 * host composition mounted the experimental plugin (spec §6.4).
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentProfileConfig } from '../config.ts'
import { truncateSummary, type TaskWorker, type TaskWorkerInput, type TaskWorkerResult } from './worker.ts'
import { MAX_SUMMARY_LENGTH } from './constants.ts'

/** Structural slice of the experimental `TeamService` (architecture doc §3.5). */
interface TeamService {
  spawnTeammate(caller: unknown, request: {
    readonly name: string
    readonly description: string
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly context: 'fresh' | 'fork'
    readonly provider: string
    readonly signal: AbortSignal
  }): Promise<{ readonly member: { readonly id: string; readonly name: string; readonly status: string } }>
  createTask(caller: unknown, request: {
    readonly subject: string
    readonly description: string
    readonly blockedBy?: readonly string[]
  }): Promise<{ readonly id: string; readonly revision: number; readonly status: string; readonly description: string }>
  listTasks(caller: unknown): {
    readonly id: string
    readonly revision: number
    readonly subject: string
    readonly description: string
    readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted'
    readonly ownerName?: string
  }[]
  listMembers(caller: unknown): {
    readonly id: string
    readonly name: string
    readonly role: 'lead' | 'teammate'
    readonly status: 'running' | 'idle' | 'inactive' | 'provisioning' | 'failed'
    readonly diagnostics: string[]
  }[]
  waitForChange(caller: unknown, timeoutMs: number, signal: AbortSignal): Promise<{ readonly timedOut: boolean }>
  interrupt(caller: unknown, targetName: string): { readonly previousStatus: 'running' | 'idle' | 'inactive' }
}

/** Wait-loop poll interval for the team terminal edge. */
const TEAM_WAIT_POLL_MS = 2_000

/**
 * Structural guard: the value is a usable TeamService. This is the ONLY place
 * in the codebase that inspects the experimental surface (invariant 1); the
 * rest of the plugin only ever sees the narrow `TaskWorker` seam.
 */
function isTeamService(value: unknown): value is TeamService {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.spawnTeammate === 'function'
    && typeof candidate.createTask === 'function'
    && typeof candidate.listTasks === 'function'
    && typeof candidate.listMembers === 'function'
    && typeof candidate.waitForChange === 'function'
    && typeof candidate.interrupt === 'function'
}

/**
 * Resolve the experimental worker from the host context (spec §6.4). Returns
 * `undefined` when the host composition did not mount the experimental Agent
 * Teams plugin — the caller then degrades to the explicit unavailable state
 * (no silent fallback to the local worker).
 */
export function resolveTeamTaskWorker(ctx: Context, agentProfile: AgentProfileConfig): TeamTaskWorker | undefined {
  // The experimental augmentation is not a dependency of this plugin, so the
  // lookup goes through an untyped face of the context.
  const reflection = ctx as unknown as { get: (name: string, strict?: boolean) => unknown }
  const mounted = reflection.get('agentTeams')
  const teams = (mounted ?? (ctx as unknown as { agentTeams?: unknown }).agentTeams) as unknown
  if (!isTeamService(teams)) return undefined
  return new TeamTaskWorker(ctx, agentProfile, teams)
}

/** The opt-in experimental worker (spec §6.3). */
export class TeamTaskWorker implements TaskWorker {
  readonly kind = 'agent-team' as const
  private readonly liveMembers = new Map<string, () => void>()

  constructor(
    private readonly ctx: Context,
    private readonly agentProfile: AgentProfileConfig,
    private readonly teams: TeamService,
  ) {}

  async start(input: TaskWorkerInput): Promise<TaskWorkerResult> {
    if (input.signal.aborted) return { kind: 'failed', error: 'task execution aborted' }
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const leadSessionId = SessionId(input.sessionId.replace(/^dsh-task-/, 'dsh-task-lead-'))
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    const memberName = `task-${input.taskId.slice(-8)}-${input.attempt}`

    let handle: AgentHandle | undefined
    try {
      handle = await this.ctx.agents.create({
        sessionId: leadSessionId,
        meta: { cwd: input.cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        signal: input.signal,
        setup: (agentCtx) => {
          installModelSelection(agentCtx, selected)
        },
      })
      const lead = handle.agent
      const team = this.teams

      // 1. Post the work as a shared team task on the Lead's team board.
      const task = await team.createTask(lead, {
        subject: input.title,
        description: input.description,
      })
      // 2. Spawn one teammate to own the work.
      const spawned = await team.spawnTeammate(lead, {
        name: memberName,
        description: input.title,
        prompt: [{ type: 'text', text: renderTeamTaskPrompt(input, task.id) }],
        context: 'fresh',
        provider: selection.provider,
        signal: input.signal,
      })
      this.liveMembers.set(spawned.member.name, () => {
        try { team.interrupt(lead, spawned.member.name) } catch { /* best-effort */ }
      })
      try {
        // 3. Wait for the terminal edge: task completed, teammate failed, or abort.
        while (true) {
          if (input.signal.aborted) {
            this.liveMembers.get(spawned.member.name)?.()
            return { kind: 'failed', error: 'task execution aborted' }
          }
          await team.waitForChange(lead, TEAM_WAIT_POLL_MS, input.signal)
          const row = team.listTasks(lead).find(t => t.id === task.id)
          if (row !== undefined && row.status === 'completed') {
            const summary = row.description.trim()
            if (summary.startsWith('ERROR:')) {
              return {
                kind: 'failed',
                error: summary.slice('ERROR:'.length).trim() || 'team task reported failure',
                agentId: spawned.member.name,
              }
            }
            if (summary === '') {
              return { kind: 'failed', error: 'team task completed without a summary', agentId: spawned.member.name }
            }
            return {
              kind: 'succeeded',
              summary: truncateSummary(summary, MAX_SUMMARY_LENGTH),
              agentId: spawned.member.name,
            }
          }
          const member = team.listMembers(lead).find(m => m.name === memberName)
          if (member !== undefined && member.status === 'failed') {
            return {
              kind: 'failed',
              error: member.diagnostics[0] ?? 'teammate failed',
              agentId: member.name,
            }
          }
        }
      } finally {
        this.liveMembers.delete(spawned.member.name)
      }
    } catch (error) {
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (handle !== undefined) {
        try {
          await this.ctx.sessions.flush(handle.agent.session)
        } finally {
          await handle.dispose()
        }
      }
    }
  }

  async stop(agentId: string): Promise<void> {
    this.liveMembers.get(agentId)?.()
  }
}

/**
 * The teammate prompt: work in cwd, claim the team task, update its
 * description with the result, mark it complete. A failed outcome must start
 * the description with `ERROR:` (documented prompt contract, spec §6.3).
 */
function renderTeamTaskPrompt(input: TaskWorkerInput, teamTaskId: string): string {
  const criteria = input.acceptanceCriteria.length === 0
    ? ''
    : `\nAcceptance criteria:\n${input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
  const role = input.role === undefined ? '' : `\nRole: ${input.role}\n`
  return [
    `You are a teammate on an agent team executing one task of a project run. Work in the current working directory (${input.cwd}).`,
    '',
    `Task: ${input.title}`,
    '',
    input.description,
    role,
    criteria,
    `Your shared team task has id ${teamTaskId}. Claim it, do the work, then update its description with a concise result summary and mark it complete.`,
    'If the work cannot be completed, update the task description starting with "ERROR:" followed by what failed and why, and mark it complete.',
  ].filter(line => line !== undefined).join('\n')
}
