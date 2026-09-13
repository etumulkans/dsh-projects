/**
 * DSH Projects Phase 4 — local Harness task worker (spec §6.2).
 *
 * The default `TaskWorker`: one owned `ctx.agents.create` session per task —
 * the same mechanism as `HarnessAgentRunner` / `HarnessCoordinatorDriver`
 * (architecture doc §3.3 "Phase 4+ worker foundation"). The task reports its
 * result exactly once via the `dsh_projects_report_task_result` tool; token
 * usage and turn count come from the session's event stream.
 *
 * `ctx.agents` is a hard dependency of this plugin (in the `inject` list), so
 * this worker is available in every composition of the plugin.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentProfileConfig } from '../config.ts'
import { emptyTokens, type TokenTotals } from '../runtime/types.ts'
import { truncateSummary, type TaskWorker, type TaskWorkerInput, type TaskWorkerResult } from './worker.ts'
import { MAX_SUMMARY_LENGTH } from './constants.ts'

/** One structured task result from the worker session. */
interface TaskResultReport {
  readonly kind: 'succeeded' | 'failed'
  readonly summary?: string
  readonly error?: string
}

/** The default worker: a local Harness agent session per task. */
export class LocalTaskWorker implements TaskWorker {
  readonly kind = 'local' as const
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly ctx: Context,
    private readonly agentProfile: AgentProfileConfig,
  ) {}

  async start(input: TaskWorkerInput): Promise<TaskWorkerResult> {
    if (input.signal.aborted) return { kind: 'failed', error: 'task execution aborted' }
    const controller = new AbortController()
    this.controllers.set(input.sessionId, controller)
    const onAbort = (): void => {
      controller.abort()
    }
    input.signal.addEventListener('abort', onAbort, { once: true })

    let reported: TaskResultReport | undefined
    try {
      const result = await this.runSession(input, report => { reported = report }, controller)
      const { tokens, turnCount } = result
      if (controller.signal.aborted) {
        return { kind: 'failed', error: 'task execution aborted', ...(tokens.total === 0 ? {} : { tokenUsage: tokens }) }
      }
      if (reported === undefined) {
        const ended = result.error ?? 'session ended without reporting a task result'
        return {
          kind: 'failed',
          error: ended,
          agentId: input.sessionId,
          ...(tokens.total === 0 ? {} : { tokenUsage: tokens }),
          ...(turnCount === 0 ? {} : { turnCount }),
        }
      }
      return {
        kind: reported.kind,
        ...(reported.summary === undefined ? {} : { summary: truncateSummary(reported.summary, MAX_SUMMARY_LENGTH) }),
        ...(reported.error === undefined ? {} : { error: reported.error }),
        agentId: input.sessionId,
        ...(tokens.total === 0 ? {} : { tokenUsage: tokens }),
        ...(turnCount === 0 ? {} : { turnCount }),
      }
    } finally {
      input.signal.removeEventListener('abort', onAbort)
      this.controllers.delete(input.sessionId)
    }
  }

  async stop(agentId: string): Promise<void> {
    this.controllers.get(agentId)?.abort()
  }

  private async runSession(
    input: TaskWorkerInput,
    onReport: (report: TaskResultReport) => void,
    controller: AbortController,
  ): Promise<{ error?: string; tokens: TokenTotals; turnCount: number }> {
    const sessionId = SessionId(input.sessionId)
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    const presets = this.ctx.get('agentPresets')
    // Role → Agent Preset mapping (master spec §15): the task's role label
    // selects a preset when configured; otherwise the profile default.
    const rolePreset = input.role !== undefined
      ? this.agentProfile.roles?.[input.role]
      : undefined
    const presetId = rolePreset !== undefined ? rolePreset : this.agentProfile.agentPreset
    if (presetId !== undefined && presets === undefined) {
      return {
        error: `agentPreset ${JSON.stringify(presetId)} is configured but ctx.agentPresets is unavailable`,
        tokens: emptyTokens(),
        turnCount: 0,
      }
    }
    const resolvedPreset = presets === undefined ? undefined : await presets.resolve(presetId)

    let tokens: TokenTotals = emptyTokens()
    let turnCount = 0
    let handle: AgentHandle | undefined
    let removeEventListener: (() => void) | undefined
    let removeControllerAbort: (() => void) | undefined
    const onAbort = (): void => {
      handle?.agent.cancel({ kind: 'hook', reason: 'dsh-projects task execution cancelled' })
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    // `stop(agentId)` aborts the tracked controller; cancel the live session so
    // the adapter's finally can flush + dispose (spec §6.2).
    const onControllerAbort = (): void => {
      handle?.agent.cancel({ kind: 'hook', reason: 'dsh-projects task execution stopped' })
    }
    controller.signal.addEventListener('abort', onControllerAbort, { once: true })
    removeControllerAbort = () => { controller.signal.removeEventListener('abort', onControllerAbort) }
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: input.cwd,
          ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset.id }),
        },
        agentOptions: { provider: selection.provider, model: selection.model },
        signal: input.signal,
        setup: async (agentCtx) => {
          if (presets !== undefined) await presets.mount(agentCtx, resolvedPreset?.id)
          installModelSelection(agentCtx, selected)
          this.installReportTool(agentCtx, onReport)
        },
      })
      this.ctx.permissionPresets.set(handle.agent.session, this.agentProfile.permissionPreset)
      removeEventListener = this.ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return
        if (event.type === 'turn/start') {
          turnCount = Math.max(turnCount, event.data.turn)
        } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
          tokens = addUsage(tokens, event.data.usage)
        }
      })
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderTaskPrompt(input) }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      await this.ctx.sessions.flush(handle.agent.session)
      const end = lastTurnEnd(handle.agent.session.events, firstSeq)
      if (end?.data.reason.kind === 'error') {
        return { error: `${end.data.reason.error.code}: ${end.data.reason.error.message}`, tokens, turnCount }
      }
      if (end?.data.reason.kind === 'blocked') {
        return { error: 'the task session ended blocked', tokens, turnCount }
      }
      if (end?.data.reason.kind !== 'completed') {
        return { error: `the task session ended as ${end?.data.reason.kind ?? 'unknown'}`, tokens, turnCount }
      }
      return { tokens, turnCount }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), tokens, turnCount }
    } finally {
      input.signal.removeEventListener('abort', onAbort)
      removeControllerAbort?.()
      removeEventListener?.()
      if (handle !== undefined) {
        try {
          await this.ctx.sessions.flush(handle.agent.session)
        } finally {
          await handle.dispose()
        }
      }
    }
  }

  /** Register `dsh_projects_report_task_result` in the session scope (spec §6.2). */
  private installReportTool(agentCtx: Context, onReport: (report: TaskResultReport) => void): void {
    const tools = agentCtx.get('tools')
    if (tools === undefined) throw new Error('dsh-projects: ctx.tools is unavailable in the Agent scope')
    let reported = false
    tools.register(defineTool({
      name: 'dsh_projects_report_task_result',
      description: 'Report the result of this task. Call exactly once when the task work is finished.',
      parameters: {
        kind: {
          type: 'string',
          enum: ['succeeded', 'failed'],
          required: true,
          description: 'Whether the task work succeeded or failed.',
        },
        summary: {
          type: 'string',
          description: 'Concise human-readable result summary (required when kind is succeeded).',
        },
        error: {
          type: 'string',
          description: 'What failed and why (required when kind is failed).',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        if (reported) throw new Error('task result already reported')
        reported = true
        if (args.kind !== 'succeeded' && args.kind !== 'failed') {
          throw new Error(`unknown result kind ${String(args.kind)}`)
        }
        const report: TaskResultReport = {
          kind: args.kind,
          ...(args.summary === undefined || args.summary === '' ? {} : { summary: args.summary }),
          ...(args.error === undefined || args.error === '' ? {} : { error: args.error }),
        }
        onReport(report)
        return { accepted: true } as never
      },
    }))
  }
}

/**
 * The task prompt: identity, work, acceptance criteria, and the report
 * contract. No invented capabilities — the agent works in `cwd` with its
 * normal tools.
 */
function renderTaskPrompt(input: TaskWorkerInput): string {
  const criteria = input.acceptanceCriteria.length === 0
    ? ''
    : `\nAcceptance criteria:\n${input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
  const role = input.role === undefined ? '' : `\nRole: ${input.role}\n`
  // Phase 5: one line of worktree guidance when the task runs in its own
  // Git worktree (spec §6.1); the shared-tree prompt is unchanged otherwise.
  const worktree = input.branch === undefined
    ? ''
    : `\nYou are working in a dedicated Git worktree on branch ${input.branch}; your changes will be committed to this branch.\n`
  return [
    `You are executing one task of a project run. Work in the current working directory (${input.cwd}).`,
    worktree,
    '',
    `Task ${input.attempt}: ${input.title}`,
    '',
    input.description,
    role,
    criteria,
    'When the task work is finished, call dsh_projects_report_task_result exactly once:',
    '- kind "succeeded" with a concise summary (what was done and the outcome), or',
    '- kind "failed" with an error describing what failed and why.',
  ].filter(line => line !== undefined).join('\n')
}

function lastTurnEnd(events: readonly SessionEvent[], firstSeq: number): SessionEvent<'turn/end'> | undefined {
  return events.filter((event): event is SessionEvent<'turn/end'> => event.seq >= firstSeq && event.type === 'turn/end').at(-1)
}

/** Accumulate one usage sample (mirrors `harness-runner.ts` `addUsage`). */
function addUsage(current: TokenTotals, usage: TokenUsage): TokenTotals {
  const input = usage.inputTokens
  const output = usage.outputTokens
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const reasoning = usage.reasoningTokens ?? 0
  return {
    input: current.input + input,
    output: current.output + output,
    cacheRead: current.cacheRead + cacheRead,
    cacheWrite: current.cacheWrite + cacheWrite,
    reasoning: current.reasoning + reasoning,
    total: current.total + input + output + cacheRead + cacheWrite,
  }
}
