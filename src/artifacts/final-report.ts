/**
 * DSH Projects Phase 8 — the deterministic final-report generator (spec §6.2,
 * master spec §64).
 *
 * `buildFinalReport` is a **pure** function: it renders the master spec §64
 * layout (Goal / Outcome / Changes / Validation / Git / Agents / Usage /
 * Project knowledge learned / Remaining risks) from the **persisted records** —
 * no model call, no fabricated data, byte-stable for the same inputs. Every
 * section is present; an empty section renders its header + "None." (the layout
 * is stable). The `final-report` artifact is the single place a user looks to
 * understand a finished run.
 */

import type { ProjectRunRecord } from '../runs/types.ts'
import type { ProjectTaskRecord } from '../tasks/types.ts'
import type { ProjectMemoryRecord } from '../memory/types.ts'
import type { ApprovalRequestRecord } from '../approvals/types.ts'
import type { ProjectArtifactRecord } from './types.ts'

const NONE = 'None.'

/** Humanize a millisecond duration (e.g. "3m 12s", "45s", "1h 4m"). */
function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}

/**
 * Render the master spec §64 final report from the persisted records (spec
 * §6.2). Pure and deterministic: the same inputs produce byte-identical output.
 * `approvals` is accepted for signature stability (the master spec §64 layout
 * has no approval section in Phase 8) but is not rendered.
 */
export function buildFinalReport(
  run: ProjectRunRecord,
  tasks: readonly ProjectTaskRecord[],
  memory: readonly ProjectMemoryRecord[],
  approvals: readonly ApprovalRequestRecord[],
  artifacts: readonly ProjectArtifactRecord[],
): string {
  // Goal
  const goal = run.goal.trim() === '' ? NONE : run.goal

  // Outcome: the terminal phase + the resultSummary (or the error, verbatim).
  const outcomeDetail = run.resultSummary !== undefined
    ? run.resultSummary
    : run.error !== undefined
      ? run.error
      : ''
  const outcome = outcomeDetail === '' ? run.phase : `${run.phase} — ${outcomeDetail}`

  // Changes: one line per task, plan order (planTaskId), status + summary.
  const orderedTasks = [...tasks].sort((a, b) => a.planTaskId.localeCompare(b.planTaskId, undefined, { numeric: true }))
  const changes = orderedTasks.length === 0
    ? [NONE]
    : orderedTasks.map(task => {
      const detail = task.outputSummary !== undefined && task.outputSummary.trim() !== ''
        ? task.outputSummary
        : task.status
      return `- ${task.title}: ${detail}`
    })

  // Validation: the integration step outcome (branch/head for Git projects).
  const validation: string[] = []
  if (run.integrationBranch !== undefined) {
    validation.push(`- Integrated branch ${run.integrationBranch}${run.integrationHead !== undefined ? ` @ ${run.integrationHead.slice(0, 8)}` : ''}`)
  } else {
    validation.push('- No Git isolation')
  }

  // Git: branch + head + the PR reference (a pull-request artifact, when present).
  const git: string[] = []
  git.push(`Branch: ${run.integrationBranch ?? 'None'}`)
  git.push(`Commit: ${run.integrationHead ?? 'None'}`)
  const pr = artifacts.find(artifact => artifact.kind === 'pull-request' && artifact.url !== undefined)
  if (pr !== undefined && pr.url !== undefined) git.push(`PR: ${pr.url}`)

  // Agents: the number of distinct task workers (assignedAgentId), else the
  // run's concurrency knob, else 0 (never invented).
  const agents = countAgents(run, tasks)

  // Usage: the run's token usage + runtime (never invented).
  const usage: string[] = []
  if (run.tokenUsage !== undefined) {
    usage.push(`Input: ${run.tokenUsage.input}`)
    usage.push(`Output: ${run.tokenUsage.output}`)
    usage.push(`Total: ${run.tokenUsage.total}`)
  } else {
    usage.push('No usage data')
  }
  if (run.startedAt !== undefined && run.completedAt !== undefined) {
    const started = Date.parse(run.startedAt)
    const completed = Date.parse(run.completedAt)
    if (Number.isFinite(started) && Number.isFinite(completed)) {
      usage.push(`Runtime: ${humanizeDuration(completed - started)}`)
    }
  }

  // Project knowledge learned: the memory entries distilled from this run.
  const knowledge = memory.length === 0
    ? [NONE]
    : memory.map(entry => `- ${entry.title}`)

  // Remaining risks: the failed/blocked tasks + the budget warnings.
  const risks: string[] = []
  for (const task of orderedTasks) {
    if (task.status === 'failed' || task.status === 'blocked') {
      risks.push(`- ${task.title} (${task.status})`)
    }
  }
  if (run.budgetWarnings !== undefined && run.budgetWarnings.length > 0) {
    for (const key of run.budgetWarnings) risks.push(`- Budget warning: ${key}`)
  }
  if (risks.length === 0) risks.push(NONE)

  return [
    'Goal', goal, '',
    'Outcome', outcome, '',
    'Changes', ...changes, '',
    'Validation', ...validation, '',
    'Git', ...git, '',
    'Agents', String(agents), '',
    'Usage', ...usage, '',
    'Project knowledge learned', ...knowledge, '',
    'Remaining risks', ...risks,
  ].join('\n')
}

/** The number of distinct task workers (assignedAgentId); falls back to the run's concurrency knob. */
function countAgents(run: ProjectRunRecord, tasks: readonly ProjectTaskRecord[]): number {
  const workers = new Set<string>()
  for (const task of tasks) {
    if (task.assignedAgentId !== undefined) workers.add(task.assignedAgentId)
  }
  if (workers.size > 0) return workers.size
  return run.maxConcurrentAgents ?? 0
}
