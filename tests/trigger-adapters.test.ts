/** DSH Projects Phase 9 — trigger adapter tests (spec §10.3). */

import { describe, expect, it } from 'vitest'
import { computeScheduleSlot, scheduleAdapter } from '../src/triggers/adapters/schedule.ts'
import { trackerAdapter } from '../src/triggers/adapters/tracker.ts'
import { webhookAdapter } from '../src/triggers/adapters/webhook.ts'
import { prEventAdapter, repositoryEventAdapter } from '../src/triggers/adapters/git-event.ts'
import { systemAdapter } from '../src/triggers/adapters/system.ts'
import { PULL_ADAPTERS, PUSH_ADAPTERS, TRIGGER_ADAPTERS } from '../src/triggers/adapters/index.ts'
import type { ProjectTriggerRecord, TriggerAdapterContext, TriggerEvent } from '../src/triggers/types.ts'

const ANCHOR = '2026-09-10T00:00:00.000Z'

function trigger(overrides: Partial<ProjectTriggerRecord> = {}): ProjectTriggerRecord {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    projectId: 'proj-1',
    type: 'tracker',
    enabled: true,
    config: {},
    goalTemplate: 'g',
    createdAt: ANCHOR,
    updatedAt: ANCHOR,
    ...overrides,
  }
}

function context(overrides: Partial<TriggerAdapterContext> = {}): TriggerAdapterContext {
  return {
    fire: async () => undefined,
    clock: () => ANCHOR,
    sources: {
      requireScoped: () => { throw new Error('no source in this context') },
    },
    ...overrides,
  }
}

describe('trigger adapter registry (spec §10.3)', () => {
  it('exposes one adapter per type (manual has no poll/onEvent)', () => {
    expect(Object.keys(TRIGGER_ADAPTERS).sort()).toEqual(
      ['manual', 'pr-event', 'repository-event', 'schedule', 'system', 'tracker', 'webhook'],
    )
    expect(TRIGGER_ADAPTERS.manual.poll).toBeUndefined()
    expect(TRIGGER_ADAPTERS.manual.onEvent).toBeUndefined()
  })

  it('splits pull-based (tracker + schedule) from push-based (the four onEvent adapters)', () => {
    expect(PULL_ADAPTERS.map(a => a.type).sort()).toEqual(['schedule', 'tracker'])
    expect(PUSH_ADAPTERS.map(a => a.type).sort()).toEqual(['pr-event', 'repository-event', 'system', 'webhook'])
  })
})

describe('tracker adapter (spec §10.3)', () => {
  it('poll yields one TriggerEvent per ready issue (sourceEventKey + data), and does not rewrite the source', async () => {
    const issue = {
      nativeRef: 'LI-42',
      identifier: 'LI-42',
      title: 'Broken build',
      state: { name: 'ready' },
      url: 'https://linear.app/x/LI-42',
    }
    const listIssuesByStates = async (states: readonly string[]) => {
      expect(states).toEqual(['ready'])
      return [issue]
    }
    const source = { kind: 'linear', listIssuesByStates }
    const ctx = context({
      sources: { requireScoped: (scope: string, kind: string) => { expect(scope).toBe('proj-1'); expect(kind).toBe('linear'); return source } },
    })
    const t = trigger({ type: 'tracker', config: { sourceKind: 'linear', readyStates: ['ready'] } })
    const events = await trackerAdapter.poll!(t, ctx)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      sourceEventKey: 'linear:LI-42:ready',
      data: {
        'issue.key': 'LI-42',
        'issue.title': 'Broken build',
        'issue.state': 'ready',
        'issue.url': 'https://linear.app/x/LI-42',
      },
    })
  })

  it('an issue not in a ready state yields no event (the source is only read, not rewritten)', async () => {
    const listIssuesByStates = async () => []
    const source = { kind: 'linear', listIssuesByStates }
    const ctx = context({ sources: { requireScoped: () => source } })
    const t = trigger({ type: 'tracker', config: { sourceKind: 'linear', readyStates: ['ready'] } })
    const events = await trackerAdapter.poll!(t, ctx)
    expect(events).toEqual([])
    // The source object is unchanged (the adapter only calls listIssuesByStates).
    expect(source).toEqual({ kind: 'linear', listIssuesByStates })
  })

  it('a missing sourceKind/readyStates yields no event (defensive)', async () => {
    const ctx = context()
    const t = trigger({ type: 'tracker', config: {} })
    const events = await trackerAdapter.poll!(t, ctx)
    expect(events).toEqual([])
  })
})

describe('schedule adapter (spec §10.3)', () => {
  it('everyMs fires on the next slot (deterministic under a fake clock)', () => {
    const config = { everyMs: 3_600_000 } // 1 hour
    const anchor = Date.parse(ANCHOR)
    // Not yet due (elapsed < everyMs).
    expect(computeScheduleSlot(config, ANCHOR, new Date(anchor + 1_000).toISOString())).toBeUndefined()
    // Exactly one slot due.
    expect(computeScheduleSlot(config, ANCHOR, new Date(anchor + 3_600_000).toISOString())).toBe(1)
    // Two slots due.
    expect(computeScheduleSlot(config, ANCHOR, new Date(anchor + 7_200_000).toISOString())).toBe(2)
  })

  it('a restart does not re-fire (the slot is recomputed from the persisted anchor)', () => {
    const config = { everyMs: 3_600_000 }
    const anchor = Date.parse(ANCHOR)
    const now = new Date(anchor + 3_600_000).toISOString()
    // The same clock + config + anchor always yields the same slot index.
    expect(computeScheduleSlot(config, ANCHOR, now)).toBe(1)
    expect(computeScheduleSlot(config, ANCHOR, now)).toBe(1)
  })

  it('cron fires on the scheduled slot (star-slash-N)', () => {
    const config = { cron: '*/5 * * * *' } // every 5 minutes
    const anchor = Date.parse(ANCHOR)
    // Not yet due.
    expect(computeScheduleSlot(config, ANCHOR, new Date(anchor + 60_000).toISOString())).toBeUndefined()
    // One 5-minute slot due (the slot timestamp).
    const slot = computeScheduleSlot(config, ANCHOR, new Date(anchor + 300_000).toISOString())
    expect(slot).toBe(anchor + 300_000)
  })

  it('poll yields one event with the slot key + schedule.at data', async () => {
    const config = { everyMs: 3_600_000 }
    const anchor = Date.parse(ANCHOR)
    const nowIso = new Date(anchor + 3_600_000).toISOString()
    const ctx = context({ clock: () => nowIso })
    const t = trigger({ type: 'schedule', config })
    const events = await scheduleAdapter.poll!(t, ctx)
    expect(events).toHaveLength(1)
    expect(events[0]!.sourceEventKey).toBe('1')
    expect(events[0]!.data['schedule.at']).toBeTruthy()
  })

  it('a not-yet-due schedule yields no event', async () => {
    const config = { everyMs: 3_600_000 }
    const anchor = Date.parse(ANCHOR)
    const ctx = context({ clock: () => new Date(anchor + 1_000).toISOString() })
    const t = trigger({ type: 'schedule', config })
    const events = await scheduleAdapter.poll!(t, ctx)
    expect(events).toEqual([])
  })
})

describe('webhook adapter (spec §10.3)', () => {
  it('onEvent accepts a valid payload (non-empty key + webhook.id) and rejects malformed ones', () => {
    const t = trigger({ type: 'webhook', config: { path: '/hooks/x', secretRef: 'ref' } })
    // Valid — does not throw.
    expect(() => webhookAdapter.onEvent!(t, { sourceEventKey: 'payload-1', data: { 'webhook.id': 'payload-1' } })).not.toThrow()
    // Missing key.
    expect(() => webhookAdapter.onEvent!(t, { sourceEventKey: '', data: { 'webhook.id': 'x' } })).toThrow()
    // Missing webhook.id.
    expect(() => webhookAdapter.onEvent!(t, { sourceEventKey: 'k', data: {} })).toThrow()
  })
})

describe('system adapter (spec §10.3)', () => {
  it('onEvent accepts a valid internal event and rejects malformed ones', () => {
    const t = trigger({ type: 'system', config: { event: 'dsh-projects/run/completed' } })
    expect(() => systemAdapter.onEvent!(t, { sourceEventKey: 'evt-1', data: { 'system.event': 'dsh-projects/run/completed' } })).not.toThrow()
    expect(() => systemAdapter.onEvent!(t, { sourceEventKey: '', data: { 'system.event': 'e' } })).toThrow()
    expect(() => systemAdapter.onEvent!(t, { sourceEventKey: 'k', data: {} })).toThrow()
  })
})

describe('git-event adapter (spec §10.3)', () => {
  it('repository-event onEvent requires a non-empty key', () => {
    const t = trigger({ type: 'repository-event', config: { event: 'repo.push' } })
    expect(() => repositoryEventAdapter.onEvent!(t, { sourceEventKey: 'push-1', data: {} })).not.toThrow()
    expect(() => repositoryEventAdapter.onEvent!(t, { sourceEventKey: '', data: {} })).toThrow()
  })

  it('pr-event onEvent requires a non-empty key (the PR number) + the pr.number data field', () => {
    const t = trigger({ type: 'pr-event', config: { event: 'pr.opened' } })
    expect(() => prEventAdapter.onEvent!(t, { sourceEventKey: '123', data: { 'pr.number': '123' } })).not.toThrow()
    expect(() => prEventAdapter.onEvent!(t, { sourceEventKey: '', data: { 'pr.number': '123' } })).toThrow()
    expect(() => prEventAdapter.onEvent!(t, { sourceEventKey: '123', data: {} })).toThrow()
  })
})
