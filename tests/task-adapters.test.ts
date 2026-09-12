/**
 * DSH Projects Phase 4 — worker adapter tests (spec §12).
 *
 * `LocalTaskWorker` against a fake `ctx.agents` (report-tool outcome mapping,
 * usage accumulation, abort mapping), `TeamTaskWorker` against a fake
 * `TeamService` (lead spawn, teammate spawn, ERROR: prefix contract),
 * `UnavailableWorker`, and the invariant-1 import-isolation source scan.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { LocalTaskWorker } from '../src/tasks/local-adapter.ts'
import { TeamTaskWorker, resolveTeamTaskWorker } from '../src/tasks/team-adapter.ts'
import { UnavailableWorker, truncateSummary, type TaskWorkerInput } from '../src/tasks/worker.ts'
import { MAX_SUMMARY_LENGTH } from '../src/tasks/constants.ts'
import type { AgentProfileConfig } from '../src/config.ts'

const PROFILE: AgentProfileConfig = {
  id: 'profile-1',
  permissionPreset: 'workspace-write',
  workerHost: 'test-host',
}

function taskInput(overrides: Partial<TaskWorkerInput> = {}): TaskWorkerInput {
  return {
    taskId: '0f8fad5b-5899-4a45-8f2b-1c2d3e4f5a6b',
    runId: '123e4567-e89b-42d3-a456-426614174000',
    projectId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    sessionId: 'dsh-task-5005b473-3f2a-4c1e-9d8b-7a6c5e4d3f2e',
    cwd: '/tmp/dsh-task-cwd',
    title: 'Write the parser',
    description: 'Implement the parser for the task language.',
    acceptanceCriteria: ['The parser rejects invalid input'],
    attempt: 1,
    signal: new AbortController().signal,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// LocalTaskWorker
// ---------------------------------------------------------------------------

interface FakeLocalRuntime {
  readonly ctx: Context
  readonly created: Array<{ sessionId: string; meta: Record<string, unknown>; agentOptions: { provider: string; model: string } }>
  readonly permissionSets: Array<{ sessionId: string; preset: string }>
  readonly followups: unknown[]
  readonly cancelCalls: Array<{ kind: string; reason: string }>
  readonly session: { id: string; seq: number; events: unknown[] }
  readonly reportTools: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }>
  readonly disposed: { count: number }
  release(): void
  emitSessionEvent(event: unknown): void
}

function fakeLocalRuntime(): FakeLocalRuntime {
  let resolveIdle: (() => void) | undefined
  const idlePromise = new Promise<void>(resolve => { resolveIdle = resolve })
  let sessionEventListener: ((session: { id: string }, event: unknown) => void) | undefined
  const created: FakeLocalRuntime['created'] = []
  const permissionSets: FakeLocalRuntime['permissionSets'] = []
  const followups: unknown[] = []
  const cancelCalls: FakeLocalRuntime['cancelCalls'] = []
  const reportTools: FakeLocalRuntime['reportTools'] = []
  const disposed = { count: 0 }
  const session = { id: '', seq: 0, events: [] as unknown[] }
  const tools = {
    register: (tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }): void => {
      reportTools.push(tool)
    },
  }
  const agentCtx = {
    on: (_event: string, _handler: unknown): (() => void) => () => undefined,
    get: (name: string): unknown => name === 'tools' ? tools : undefined,
  }
  const ctx = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'test-model' }),
    },
    get: (_name: string): unknown => undefined,
    agents: {
      create: async (options: {
        sessionId: { toString(): string }
        meta: Record<string, unknown>
        agentOptions: { provider: string; model: string }
        signal: AbortSignal
        setup: (agent: unknown) => Promise<void> | void
      }) => {
        session.id = options.sessionId.toString()
        created.push({
          sessionId: options.sessionId.toString(),
          meta: { ...options.meta },
          agentOptions: { ...options.agentOptions },
        })
        await options.setup(agentCtx)
        return {
          agent: {
            session,
            followup: (message: unknown): void => { followups.push(message) },
            whenIdle: (): Promise<void> => idlePromise,
            cancel: (args: { kind: string; reason: string }): void => { cancelCalls.push(args) },
          },
          dispose: async (): Promise<void> => { disposed.count += 1 }
        }
      },
    },
    permissionPresets: {
      set: (target: { id: string }, preset: string): void => { permissionSets.push({ sessionId: target.id, preset }) },
    },
    on: (event: string, handler: (session: { id: string }, event: unknown) => void): (() => void) => {
      if (event === 'session/event') sessionEventListener = handler
      return () => undefined
    },
    sessions: {
      flush: async (_session: unknown): Promise<void> => undefined,
    },
  } as unknown as Context
  return {
    ctx,
    created,
    permissionSets,
    followups,
    cancelCalls,
    session,
    reportTools,
    disposed,
    release: (): void => { resolveIdle?.() },
    emitSessionEvent: (event: unknown): void => { sessionEventListener?.({ id: session.id }, event) },
  }
}

function sessionEvents(
  turn: number,
  endReason: { kind: 'completed' } | { kind: 'error'; error: { code: string; message: string } } | { kind: 'blocked' } | { kind: 'aborted' },
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number },
): unknown[] {
  const events: unknown[] = [
    { seq: turn, time: 0, type: 'turn/start', data: { turn } },
  ]
  if (usage !== undefined) {
    events.push({
      seq: turn + 1,
      time: 0,
      type: 'assistant/message',
      data: { turn, step: 1, message: { role: 'assistant', content: [] }, usage },
    })
  }
  events.push({ seq: turn + (usage === undefined ? 1 : 2), time: 0, type: 'turn/end', data: { turn, reason: endReason } })
  return events
}

describe('LocalTaskWorker (spec §6.2)', () => {
  it('creates one session per task, reports success with usage and turn count', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const input = taskInput()
    const started = worker.start(input)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(rt.created).toHaveLength(1)
    expect(rt.created[0]).toMatchObject({
      sessionId: input.sessionId,
      meta: { cwd: input.cwd },
      agentOptions: { provider: 'deepseek', model: 'test-model' },
    })
    expect(rt.permissionSets).toEqual([{ sessionId: input.sessionId, preset: 'workspace-write' }])
    // the task prompt carries the work, criteria, and the report contract
    const promptText = JSON.stringify(rt.followups[0])
    expect(promptText).toContain('Write the parser')
    expect(promptText).toContain('Implement the parser for the task language.')
    expect(promptText).toContain('The parser rejects invalid input')
    expect(promptText).toContain('dsh_projects_report_task_result')
    // the agent reports success through the tool (exactly once)
    const report = rt.reportTools.find(tool => tool.name === 'dsh_projects_report_task_result')!
    await report.execute({ kind: 'succeeded', summary: 'Parser implemented and tested.' })
    await expect(report.execute({ kind: 'succeeded', summary: 'again' })).rejects.toThrow(/already reported/)
    // usage arrives through the session/event stream; then the turn ends
    rt.session.events.push(...sessionEvents(1, { kind: 'completed' }, {
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3,
    }))
    rt.emitSessionEvent({ seq: 1, time: 0, type: 'turn/start', data: { turn: 1 } })
    rt.emitSessionEvent({
      seq: 2,
      time: 0,
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 } },
    })
    rt.emitSessionEvent({ seq: 3, time: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    rt.release()
    const result = await started
    expect(result).toMatchObject({
      kind: 'succeeded',
      summary: 'Parser implemented and tested.',
      agentId: input.sessionId,
      tokenUsage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, total: 18 },
      turnCount: 1,
    })
    expect(rt.disposed.count).toBe(1)
  })

  it('maps a failed report through with the error', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const input = taskInput()
    const started = worker.start(input)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const report = rt.reportTools.find(tool => tool.name === 'dsh_projects_report_task_result')!
    await report.execute({ kind: 'failed', error: 'the fixture suite went red' })
    rt.session.events.push(...sessionEvents(1, { kind: 'completed' }))
    rt.release()
    const result = await started
    expect(result).toMatchObject({ kind: 'failed', error: 'the fixture suite went red', agentId: input.sessionId })
  })

  it('fails when the session ends completed without a report', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const started = worker.start(taskInput())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(rt.reportTools).toHaveLength(1)
    rt.session.events.push(...sessionEvents(1, { kind: 'completed' }))
    rt.release()
    const result = await started
    expect(result).toMatchObject({ kind: 'failed', error: 'session ended without reporting a task result' })
  })

  it('carries a native turn-end error reason into the failure', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const started = worker.start(taskInput())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    rt.session.events.push(...sessionEvents(1, { kind: 'error', error: { code: 'MODEL_RATE_LIMITED', message: 'slow down' } }))
    rt.release()
    const result = await started
    expect(result).toMatchObject({ kind: 'failed' })
    expect(result.error).toContain('MODEL_RATE_LIMITED')
    expect(result.error).toContain('slow down')
  })

  it('fails a blocked turn end with the blocked reason', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const started = worker.start(taskInput())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    rt.session.events.push(...sessionEvents(1, { kind: 'blocked' }))
    rt.release()
    const result = await started
    expect(result).toMatchObject({ kind: 'failed', error: 'the task session ended blocked' })
  })

  it('stop() cancels the live session and the outcome is the abort mapping', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const input = taskInput()
    const started = worker.start(input)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await worker.stop(input.sessionId)
    expect(rt.cancelCalls).toEqual([
      expect.objectContaining({ reason: 'dsh-projects task execution stopped' }),
    ])
    rt.session.events.push(...sessionEvents(1, { kind: 'aborted' }))
    rt.release()
    const result = await started
    expect(result).toMatchObject({ kind: 'failed', error: 'task execution aborted' })
    expect(rt.disposed.count).toBe(1)
  })

  it('returns the abort mapping without creating a session when pre-aborted', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const controller = new AbortController()
    controller.abort()
    const result = await worker.start(taskInput({ signal: controller.signal }))
    expect(result).toMatchObject({ kind: 'failed', error: 'task execution aborted' })
    expect(rt.created).toHaveLength(0)
  })

  it('truncates over-long summaries to the persisted limit', async () => {
    const rt = fakeLocalRuntime()
    const worker = new LocalTaskWorker(rt.ctx, PROFILE)
    const started = worker.start(taskInput())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const report = rt.reportTools.find(tool => tool.name === 'dsh_projects_report_task_result')!
    await report.execute({ kind: 'succeeded', summary: 'x'.repeat(MAX_SUMMARY_LENGTH + 50) })
    rt.session.events.push(...sessionEvents(1, { kind: 'completed' }))
    rt.release()
    const result = await started
    expect(result.kind).toBe('succeeded')
    expect(result.summary).toHaveLength(MAX_SUMMARY_LENGTH + 1)
    expect(result.summary!.endsWith('…')).toBe(true)
  })
})

describe('truncateSummary', () => {
  it('leaves short summaries untouched and marks truncated ones', () => {
    expect(truncateSummary('ok', 10)).toBe('ok')
    expect(truncateSummary('1234567890', 5)).toBe('12345…')
  })
})

// ---------------------------------------------------------------------------
// TeamTaskWorker
// ---------------------------------------------------------------------------

interface TeamTaskRow {
  id: string
  revision: number
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
}

interface FakeTeamRuntime {
  readonly ctx: Context
  readonly created: Array<{ sessionId: string }>
  readonly team: {
    createTaskCalls: Array<{ subject: string; description: string }>
    spawnCalls: Array<{ name: string; context: string; prompt: unknown[] }>
    interruptCalls: Array<{ targetName: string }>
    rows: TeamTaskRow[]
    members: Array<{ id: string; name: string; role: 'lead' | 'teammate'; status: string; diagnostics: string[] }>
    setRow(row: Partial<TeamTaskRow> & { id: string }): void
    setMemberStatus(name: string, status: string, diagnostics?: string[]): void
    change: { release: () => void }
  }
  releaseLead(): void
}

function fakeTeamRuntime(): FakeTeamRuntime {
  let resolveIdle: (() => void) | undefined
  const idlePromise = new Promise<void>(resolve => { resolveIdle = resolve })
  let changeResolver: (() => void) | undefined
  const changePromise = new Promise<void>(resolve => { changeResolver = resolve })
  let changeCounter = 0
  const created: Array<{ sessionId: string }> = []
  const createTaskCalls: FakeTeamRuntime['team']['createTaskCalls'] = []
  const spawnCalls: FakeTeamRuntime['team']['spawnCalls'] = []
  const interruptCalls: FakeTeamRuntime['team']['interruptCalls'] = []
  const rows: TeamTaskRow[] = []
  const members: FakeTeamRuntime['team']['members'] = []
  const session = { id: '', seq: 0, events: [] as unknown[] }
  const teams = {
    createTask: async (_caller: unknown, request: { subject: string; description: string }): Promise<{ id: string; revision: number; status: string; description: string }> => {
      createTaskCalls.push({ subject: request.subject, description: request.description })
      const row: TeamTaskRow = { id: `tt-${rows.length + 1}`, revision: 1, subject: request.subject, description: request.description, status: 'pending' }
      rows.push(row)
      return { id: row.id, revision: row.revision, status: row.status, description: row.description }
    },
    spawnTeammate: async (_caller: unknown, request: { name: string; description: string; prompt: unknown[]; context: string; provider: string; signal: AbortSignal }): Promise<{ member: { id: string; name: string; status: string } }> => {
      spawnCalls.push({ name: request.name, context: request.context, prompt: request.prompt })
      members.push({ id: `m-${request.name}`, name: request.name, role: 'teammate', status: 'provisioning', diagnostics: [] })
      return { member: { id: `m-${request.name}`, name: request.name, status: 'provisioning' } }
    },
    listTasks: (_caller: unknown): TeamTaskRow[] => rows,
    listMembers: (_caller: unknown): FakeTeamRuntime['team']['members'] => members,
    waitForChange: async (_caller: unknown, _timeoutMs: number, _signal: AbortSignal): Promise<{ timedOut: boolean }> => {
      changeCounter += 1
      if (changeCounter === 1) {
        await changePromise
        return { timedOut: false }
      }
      return { timedOut: false }
    },
    interrupt: (_caller: unknown, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' } => {
      interruptCalls.push({ targetName })
      return { previousStatus: 'running' }
    },
  }
  const ctx = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'test-model' }),
    },
    get: (name: string): unknown => name === 'agentTeams' ? teams : undefined,
    agents: {
      create: async (options: { sessionId: { toString(): string }; signal: AbortSignal; setup: (agent: unknown) => void }) => {
        session.id = options.sessionId.toString()
        created.push({ sessionId: options.sessionId.toString() })
        await options.setup({
          on: (_event: string, _handler: unknown): (() => void) => () => undefined,
        })
        return {
          agent: { session },
          dispose: async (): Promise<void> => undefined
        }
      },
    },
    sessions: {
      flush: async (_session: unknown): Promise<void> => undefined,
    },
  } as unknown as Context
  return {
    ctx,
    created,
    team: {
      createTaskCalls,
      spawnCalls,
      interruptCalls,
      rows,
      members,
      setRow: (row: Partial<TeamTaskRow> & { id: string }): void => {
        const existing = rows.find(candidate => candidate.id === row.id)!
        Object.assign(existing, row)
      },
      setMemberStatus: (name: string, status: string, diagnostics: string[] = []): void => {
        const member = members.find(candidate => candidate.name === name)!
        member.status = status
        member.diagnostics = diagnostics
      },
      change: {
        release: (): void => { changeResolver?.() },
      },
    },
    releaseLead: (): void => { resolveIdle?.() },
  }
}

describe('TeamTaskWorker (spec §6.3, experimental)', () => {
  it('posts the work as a team task, spawns one teammate, and maps the completed summary', async () => {
    const rt = fakeTeamRuntime()
    const worker = resolveTeamTaskWorker(rt.ctx, PROFILE)!
    const input = taskInput()
    const started = worker.start(input)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    // one Lead session per task; the team task carries the work
    expect(rt.created).toHaveLength(1)
    expect(rt.created[0]!.sessionId).toBe(`dsh-task-lead-${input.sessionId.slice('dsh-task-'.length)}`)
    expect(rt.team.createTaskCalls).toEqual([{ subject: input.title, description: input.description }])
    // one teammate, fresh context, prompt carries the team task id + ERROR contract
    expect(rt.team.spawnCalls).toHaveLength(1)
    expect(rt.team.spawnCalls[0]!.name).toBe(`task-${input.taskId.slice(-8)}-1`)
    expect(rt.team.spawnCalls[0]!.context).toBe('fresh')
    const prompt = JSON.stringify(rt.team.spawnCalls[0]!.prompt)
    expect(prompt).toContain(rt.team.rows[0]!.id)
    expect(prompt).toContain('ERROR:')
    expect(prompt).toContain('The parser rejects invalid input')
    // the teammate completes the team task with a summary in the description
    rt.team.setRow({ id: rt.team.rows[0]!.id, status: 'completed', description: 'Shipped the parser with tests.' })
    rt.team.change.release()
    const result = await started
    expect(result).toMatchObject({
      kind: 'succeeded',
      summary: 'Shipped the parser with tests.',
      agentId: rt.team.spawnCalls[0]!.name,
    })
  })

  it('maps the ERROR: description prefix to a failure with the detail', async () => {
    const rt = fakeTeamRuntime()
    const worker = resolveTeamTaskWorker(rt.ctx, PROFILE)!
    const started = worker.start(taskInput())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    rt.team.setRow({ id: rt.team.rows[0]!.id, status: 'completed', description: 'ERROR: the build exploded on main' })
    rt.team.change.release()
    const result = await started
    expect(result).toMatchObject({
      kind: 'failed',
      error: 'the build exploded on main',
      agentId: rt.team.spawnCalls[0]!.name,
    })
  })

  it('fails when the team task completes without a summary', async () => {
    const rt = fakeTeamRuntime()
    const worker = resolveTeamTaskWorker(rt.ctx, PROFILE)!
    const started = worker.start(taskInput())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    rt.team.setRow({ id: rt.team.rows[0]!.id, status: 'completed', description: '   ' })
    rt.team.change.release()
    const result = await started
    expect(result).toMatchObject({ kind: 'failed', error: 'team task completed without a summary' })
  })

  it('maps a failed teammate to a failure with its diagnostics', async () => {
    const rt = fakeTeamRuntime()
    const worker = resolveTeamTaskWorker(rt.ctx, PROFILE)!
    const started = worker.start(taskInput())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const memberName = rt.team.spawnCalls[0]!.name
    rt.team.setMemberStatus(memberName, 'failed', ['out of memory'])
    rt.team.change.release()
    const result = await started
    expect(result).toMatchObject({ kind: 'failed', error: 'out of memory', agentId: memberName })
  })

  it('stop() interrupts the live teammate', async () => {
    const rt = fakeTeamRuntime()
    const worker = resolveTeamTaskWorker(rt.ctx, PROFILE)!
    const input = taskInput()
    const started = worker.start(input)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const memberName = rt.team.spawnCalls[0]!.name
    await worker.stop(memberName)
    expect(rt.team.interruptCalls).toEqual([{ targetName: memberName }])
  })

  it('resolveTeamTaskWorker returns the worker only for a usable mounted service', () => {
    const rt = fakeTeamRuntime()
    const resolved = resolveTeamTaskWorker(rt.ctx, PROFILE)
    expect(resolved).toBeInstanceOf(TeamTaskWorker)
    expect(resolved?.kind).toBe('agent-team')
    // a missing or incomplete surface resolves to undefined (caller degrades)
    const absent: Context = { get: () => undefined } as unknown as Context
    expect(resolveTeamTaskWorker(absent, PROFILE)).toBeUndefined()
    const partial: Context = { get: () => ({ spawnTeammate: () => undefined }) } as unknown as Context
    expect(resolveTeamTaskWorker(partial, PROFILE)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// UnavailableWorker
// ---------------------------------------------------------------------------

describe('UnavailableWorker (spec §6.4)', () => {
  it('rejects with task.workerUnavailable and stops as a no-op', async () => {
    const worker = new UnavailableWorker()
    expect(worker.kind).toBe('unavailable')
    await expect(worker.start())
      .rejects.toMatchObject({ dashboardCode: 'task.workerUnavailable' })
    await expect(worker.stop()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Invariant 1: import isolation
// ---------------------------------------------------------------------------

function scanSrcFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      out.push(...scanSrcFiles(path))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(path)
    }
  }
  return out
}

describe('invariant 1: experimental surface isolation', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  it('agentTeams appears only in src/tasks/team-adapter.ts', () => {
    const offenders = scanSrcFiles(join(root, 'src'))
      .filter(path => readFileSync(path, 'utf8').includes('agentTeams'))
      .map(path => path.slice(root.length + 1))
    expect(offenders.sort()).toEqual(['src/tasks/team-adapter.ts'])
  })

  it('no source file references the out-of-scope ctx.subagents surface', () => {
    const offenders = scanSrcFiles(join(root, 'src'))
      .filter(path => readFileSync(path, 'utf8').includes('subagents'))
      .map(path => path.slice(root.length + 1))
    expect(offenders).toEqual([])
  })
})
