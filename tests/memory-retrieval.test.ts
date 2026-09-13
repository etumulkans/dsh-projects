/** DSH Projects Phase 6 — pure retrieval + context-budget tests (spec §12.1). */

import { describe, expect, it } from 'vitest'
import {
  buildMemoryPacket,
  COORDINATOR_MEMORY_BUDGET,
  normalizeTerms,
  searchMemory,
  termOverlap,
  TASK_MEMORY_BUDGET,
  type MemoryBudgets,
} from '../src/memory/retrieval.ts'
import type { ProjectMemoryRecord } from '../src/memory/types.ts'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

function entry(overrides: Partial<ProjectMemoryRecord> & { id: string }): ProjectMemoryRecord {
  return {
    projectId: P1,
    kind: 'testing',
    title: 'Integration tests require PostgreSQL',
    body: 'Start postgres and redis before running the integration suite.',
    tags: [],
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

describe('normalizeTerms (spec §4.3)', () => {
  it('lowercases, splits on non-word chars, drops short tokens', () => {
    expect(normalizeTerms('Integration Tests Require POSTGRES, v12!')).toEqual([
      'integration', 'tests', 'require', 'postgres', 'v12',
    ])
  })

  it('drops the stopword list after tokenization', () => {
    expect(normalizeTerms('the use of with from by at as')).toEqual(['use'])
  })

  it('keeps unicode word characters', () => {
    expect(normalizeTerms('Café Zürich')).toEqual(['café', 'zürich'])
  })

  it('returns [] for empty / stopword-only text', () => {
    expect(normalizeTerms('')).toEqual([])
    expect(normalizeTerms('the and of')).toEqual([])
  })
})

describe('termOverlap (spec §4.3)', () => {
  it('is a containment ratio robust to length differences', () => {
    // {postgres} is fully contained in the longer set → 1.
    expect(termOverlap(['postgres'], ['postgres', 'integration', 'tests'])).toBe(1)
  })

  it('is symmetric and partial for partial overlap (|A∩B| / min(|A|,|B|))', () => {
    expect(termOverlap(['a1', 'b2', 'c3'], ['a1', 'b2', 'x9', 'y8'])).toBeCloseTo(2 / 3)
    expect(termOverlap(['x9', 'y8', 'a1', 'b2'], ['a1', 'b2', 'c3'])).toBeCloseTo(2 / 3)
  })

  it('returns 0 when either set is empty', () => {
    expect(termOverlap([], ['a1', 'b2'])).toBe(0)
    expect(termOverlap(['a1', 'b2'], [])).toBe(0)
  })
})

describe('searchMemory (spec §5.1)', () => {
  it('filters by projectId', () => {
    const a = entry({ id: 'a' })
    const b = entry({ id: 'b', projectId: P2 })
    expect(searchMemory([a, b], { projectId: P1 }).map(e => e.id)).toEqual(['a'])
    expect(searchMemory([a, b], { projectId: P2 }).map(e => e.id)).toEqual(['b'])
  })

  it('filters by kinds subset', () => {
    const a = entry({ id: 'a', kind: 'testing' })
    const b = entry({ id: 'b', kind: 'architecture', title: 'Service layout' })
    expect(searchMemory([a, b], { projectId: P1, kinds: ['architecture'] }).map(e => e.id)).toEqual(['b'])
  })

  it('filters by tags (all listed, case-insensitive)', () => {
    const a = entry({ id: 'a', tags: ['ci', 'postgres'] })
    const b = entry({ id: 'b', tags: ['CI'] })
    const c = entry({ id: 'c', tags: ['postgres'] })
    expect(searchMemory([a, b, c], { projectId: P1, tags: ['postgres', 'CI'] }).map(e => e.id)).toEqual(['a'])
  })

  it('scores title hits 3x, tag hits 2x, body hits 1x', () => {
    const q = 'postgres'
    const inTitle = entry({ id: 't', title: `Postgres setup`, body: 'nothing relevant here at all' })
    const inTag = entry({ id: 'g', tags: ['postgres'], title: 'database notes', body: 'nothing relevant here at all' })
    const inBody = entry({ id: 'b', title: 'database notes', body: `always start ${q} first` })
    const ids = searchMemory([inBody, inTag, inTitle], { projectId: P1, query: q }).map(e => e.id)
    expect(ids).toEqual(['t', 'g', 'b'])
  })

  it('orders pinned first regardless of score (zero-score entries are filtered out with a query)', () => {
    const scored = entry({ id: 's', title: 'Postgres setup' })
    // Pinned entry matches only in the body (score 1/3 < 1.0) — still first.
    const pinned = entry({ id: 'p', pinned: true, title: 'database note', body: 'always start postgres first' })
    const zeroScore = entry({ id: 'z', title: 'unrelated note', body: 'no query terms at all' })
    const ids = searchMemory([scored, pinned, zeroScore], { projectId: P1, query: 'postgres' }).map(e => e.id)
    expect(ids).toEqual(['p', 's'])
  })

  it('tie-breaks by updatedAt desc, then id asc', () => {
    const newer = entry({ id: 'id-b', updatedAt: '2026-09-02T00:00:00.000Z' })
    const older = entry({ id: 'id-a', updatedAt: '2026-09-01T00:00:00.000Z' })
    expect(searchMemory([older, newer], { projectId: P1 }).map(e => e.id)).toEqual(['id-b', 'id-a'])
    const sameTimeA = entry({ id: 'zzz' })
    const sameTimeB = entry({ id: 'aaa' })
    expect(searchMemory([sameTimeA, sameTimeB], { projectId: P1 }).map(e => e.id)).toEqual(['aaa', 'zzz'])
  })

  it('applies limit after sorting', () => {
    const entries = [1, 2, 3, 4].map(n => entry({ id: `e${n}`, title: `Postgres note ${n}` }))
    expect(searchMemory(entries, { projectId: P1, query: 'postgres', limit: 2 }).map(e => e.id)).toEqual(['e1', 'e2'])
  })

  it('returns [] for an empty pool and orders by recency without a query', () => {
    expect(searchMemory([], { projectId: P1 })).toEqual([])
    const newer = entry({ id: 'n', updatedAt: '2026-09-03T00:00:00.000Z' })
    const older = entry({ id: 'o', updatedAt: '2026-09-01T00:00:00.000Z' })
    expect(searchMemory([older, newer], { projectId: P1 }).map(e => e.id)).toEqual(['n', 'o'])
  })

  it('is deterministic: identical inputs produce identical outputs', () => {
    const pool = [
      entry({ id: 'd1', title: 'Postgres notes', pinned: true }),
      entry({ id: 'd2', title: 'Postgres notes', updatedAt: '2026-09-04T00:00:00.000Z' }),
      entry({ id: 'd3', kind: 'architecture', title: 'gateway layout' }),
      entry({ id: 'd4', tags: ['postgres'], title: 'ops runbook' }),
    ]
    const first = searchMemory(pool, { projectId: P1, query: 'postgres' })
    const second = searchMemory([...pool].reverse(), { projectId: P1, query: 'postgres' })
    expect(second).toEqual(first)
  })
})

describe('buildMemoryPacket (spec §5.2)', () => {
  const budgets: MemoryBudgets = COORDINATOR_MEMORY_BUDGET

  it('returns undefined when there is nothing to render', () => {
    expect(buildMemoryPacket([], budgets)).toBeUndefined()
    const tiny: MemoryBudgets = { maxEntries: 10, maxChars: 4000, pinnedMaxChars: 0, retrievedMaxChars: 0 }
    expect(buildMemoryPacket([entry({ id: 'a' })], tiny)).toBeUndefined()
  })

  it('renders the exact header and sections in MEMORY_KINDS order', () => {
    const testing = entry({ id: 't', kind: 'testing', title: 'Tests need Postgres' })
    const arch = entry({ id: 'a', kind: 'architecture', title: 'Gateway layout' })
    const packet = buildMemoryPacket([testing, arch], budgets)
    expect(packet).toBe(
      [
        'PROJECT MEMORY (knowledge persisted from earlier runs — verify before relying on it):',
        '',
        'ARCHITECTURE:',
        '- Gateway layout: Start postgres and redis before running the integration suite.',
        '',
        'TESTING:',
        '- Tests need Postgres: Start postgres and redis before running the integration suite.',
      ].join('\n'),
    )
  })

  it('renders the PINNED section first', () => {
    const pinned = entry({ id: 'p', pinned: true, title: 'Pinned fact', body: 'the pinned body' })
    const plain = entry({ id: 'n', title: 'Plain fact', body: 'the plain body' })
    const packet = buildMemoryPacket([plain, pinned], budgets)
    expect(packet).toContain('PINNED:\n- Pinned fact: the pinned body')
    expect(packet!.indexOf('PINNED:')).toBeLessThan(packet!.indexOf('TESTING:'))
  })

  it('truncates long bodies at 300 chars with an ellipsis', () => {
    const long = 'x'.repeat(400)
    const packet = buildMemoryPacket([entry({ id: 'l', title: 'Long body', body: long })], budgets)
    expect(packet).toBe(
      [
        'PROJECT MEMORY (knowledge persisted from earlier runs — verify before relying on it):',
        '',
        'TESTING:',
        `- Long body: ${'x'.repeat(299)}…`,
      ].join('\n'),
    )
  })

  it('flattens newlines inside titles/bodies to single lines', () => {
    const packet = buildMemoryPacket([entry({ id: 'n', title: 'Multi\nline title', body: 'a\nb' })], budgets)
    expect(packet).toContain('- Multi line title: a b')
    expect(packet).not.toContain('\n- Multi\n')
  })

  it('stops a section at its character budget without partial lines', () => {
    const first = entry({ id: '1', kind: 'testing', title: 'First entry title', body: 'b1' })
    const second = entry({ id: '2', kind: 'testing', title: 'Second entry title', body: 'b2' })
    const firstLine = `- First entry title: b1`.length
    const header = 'TESTING:'.length
    const tight: MemoryBudgets = {
      ...TASK_MEMORY_BUDGET,
      retrievedMaxChars: header + firstLine + 5, // room for the header + one line, not two
    }
    const packet = buildMemoryPacket([first, second], tight)
    expect(packet).toContain('- First entry title: b1')
    expect(packet).not.toContain('Second entry title')
  })

  it('respects the pinned budget separately from the retrieved budget', () => {
    const pinned = entry({ id: 'p', pinned: true, title: 'Pinned body line', body: 'pb' })
    const plain = entry({ id: 'n', title: 'Plain body line', body: 'qb' })
    const pinnedLine = `- Pinned body line: pb`.length
    const tight: MemoryBudgets = {
      ...TASK_MEMORY_BUDGET,
      pinnedMaxChars: 'PINNED:'.length + pinnedLine + 5,
      retrievedMaxChars: 0,
    }
    const packet = buildMemoryPacket([plain, pinned], tight)
    expect(packet).toContain('PINNED:\n- Pinned body line: pb')
    expect(packet).not.toContain('Plain body line')
  })
})
