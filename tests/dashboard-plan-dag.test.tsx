import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlanDag } from '../src/client/Dashboard.tsx'
import { createDashboardTranslator } from '../src/client/i18n.tsx'
import type { PlannedTask } from '../src/plans/types.ts'
import type { ProjectTaskView } from '../src/tasks/types.ts'

const t = createDashboardTranslator('en')

const task = (id: string, title: string, dependencies: readonly string[] = []): PlannedTask => ({
  id, title, description: `Description of ${title}`, dependencies, acceptanceCriteria: [],
})

const projectTask = (planTaskId: string, status: ProjectTaskView['status']): ProjectTaskView => ({
  id: `task-${planTaskId}`,
  runId: 'run-1',
  planId: 'plan-1',
  planTaskId,
  title: `Task ${planTaskId}`,
  dependencies: [],
  status,
  acceptanceCriteria: [],
  attempt: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  version: 1,
})

describe('Phase 11 — Plan dependency DAG (spec §5.6)', () => {
  it('degenerates a linear plan (no dependencies) to a vertical list', () => {
    const tasks = [task('t1', 'First'), task('t2', 'Second'), task('t3', 'Third')]
    const markup = renderToStaticMarkup(<PlanDag tasks={tasks} t={t} />)

    expect(markup).toContain('dshd-plan-dag-linear')
    expect(markup).toContain('t1 · First')
    expect(markup).toContain('t2 · Second')
    expect(markup).toContain('t3 · Third')
  })

  it('lays out a dependent plan into layers and colors nodes by status', () => {
    // t1 -> t2 -> t4, and t1 -> t3 -> t4 (a diamond).
    const tasks = [
      task('t1', 'Root'),
      task('t2', 'Left', ['t1']),
      task('t3', 'Right', ['t1']),
      task('t4', 'Join', ['t2', 't3']),
    ]
    const projectTasks = [
      projectTask('t1', 'succeeded'),
      projectTask('t2', 'running'),
      projectTask('t3', 'pending'),
      projectTask('t4', 'blocked'),
    ]
    const markup = renderToStaticMarkup(<PlanDag tasks={tasks} projectTasks={projectTasks} t={t} />)

    // Layered layout (not the linear fallback).
    expect(markup).not.toContain('dshd-plan-dag-linear')
    expect(markup).toContain('dshd-dag-layer')
    expect(markup).toContain('Layer 1')
    expect(markup).toContain('Layer 3')

    // Every node is present.
    expect(markup).toContain('t1 · Root')
    expect(markup).toContain('t2 · Left')
    expect(markup).toContain('t3 · Right')
    expect(markup).toContain('t4 · Join')

    // Status coloring classes.
    expect(markup).toContain('dshd-dag-node-succeeded')
    expect(markup).toContain('dshd-dag-node-running')
    expect(markup).toContain('dshd-dag-node-blocked')
    expect(markup).toContain('dshd-dag-node-pending')

    // Dependency labels.
    expect(markup).toContain('Depends on t1')
    expect(markup).toContain('Depends on t2, t3')
  })

  it('guards against dependency cycles without throwing', () => {
    const tasks = [task('t1', 'A', ['t2']), task('t2', 'B', ['t1'])]
    const markup = renderToStaticMarkup(<PlanDag tasks={tasks} t={t} />)
    expect(markup).toContain('t1 · A')
    expect(markup).toContain('t2 · B')
  })
})
