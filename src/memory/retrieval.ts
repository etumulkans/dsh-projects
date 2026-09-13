/**
 * DSH Projects Phase 6 — deterministic lexical retrieval + context budget
 * (spec §4.3, §5). Pure functions only: the storage service calls them, and
 * the lexical strategy sits behind the service's `strategy` seam so a future
 * semantic/vector strategy can replace it without touching callers
 * (master spec §23).
 */

import { MEMORY_KINDS, type MemoryKind, type ProjectMemoryRecord } from './types.ts'

/** Minimal stopword list (spec §4.3) — applied after tokenization. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'for', 'to', 'of',
  'and', 'or', 'this', 'that', 'it', 'with', 'from', 'by', 'at', 'as',
])

/**
 * Normalize free text into comparable term tokens (spec §4.3): lowercase,
 * keep unicode word runs, tokens of ≥ 3 chars, stopwords dropped.
 */
export function normalizeTerms(text: string): readonly string[] {
  const runs = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  return runs.filter(token => token.length >= 3 && !STOPWORDS.has(token))
}

/**
 * Containment overlap of two term sets (spec §4.3):
 * `|A ∩ B| / min(|A|, |B|)` — robust to different entry lengths; 0 when
 * either set is empty.
 */
export function termOverlap(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let shared = 0
  for (const term of setA) {
    if (setB.has(term)) shared++
  }
  return shared / Math.min(setA.size, setB.size)
}

export interface MemorySearchInput {
  readonly projectId: string
  readonly query?: string
  readonly kinds?: readonly MemoryKind[]
  readonly tags?: readonly string[]
  /** Applied after sorting; default 50 (spec §5.1). */
  readonly limit?: number
}

interface Scored {
  readonly entry: ProjectMemoryRecord
  readonly score: number
}

/**
 * Deterministic lexical search (spec §5.1). The caller passes the project's
 * pool (active entries; `superseded`/`archived` are history, never retrieval
 * results). Filters: `kinds` subset, `tags` = all listed tags
 * (case-insensitive). Scoring: `score = (3·|Q ∩ title| + 2·|Q ∩ tags| +
 * 1·|Q ∩ body|) / (3·|Q|)`; no query → all scores 0. Order: pinned first,
 * score desc, updatedAt desc, id asc.
 */
export function searchMemory(entries: readonly ProjectMemoryRecord[], input: MemorySearchInput): ProjectMemoryRecord[] {
  const kinds = input.kinds === undefined ? undefined : new Set(input.kinds)
  const tags = input.tags === undefined ? undefined : input.tags.map(tag => tag.trim().toLowerCase()).filter(tag => tag !== '')
  const pool = entries.filter(entry => {
    if (entry.projectId !== input.projectId) return false
    if (kinds !== undefined && !kinds.has(entry.kind)) return false
    if (tags !== undefined && tags.length > 0) {
      const entryTags = entry.tags.map(tag => tag.trim().toLowerCase())
      if (!tags.every(tag => entryTags.includes(tag))) return false
    }
    return true
  })
  const queryTerms = input.query === undefined ? [] : normalizeTerms(input.query)
  const scored = pool.map(entry => {
    const score = queryTerms.length === 0
      ? 0
      : (
          3 * hits(queryTerms, normalizeTerms(entry.title)) +
          2 * hits(queryTerms, entry.tags.flatMap(tag => normalizeTerms(tag))) +
          1 * hits(queryTerms, normalizeTerms(entry.body))
        ) / (3 * queryTerms.length)
    return { entry, score }
  })
  // Spec §5: with a query, only entries with score > 0 are returned;
  // without a query the whole pool is returned in recency order.
  const filtered = queryTerms.length === 0 ? scored : scored.filter(item => item.score > 0)
  filtered.sort((x, y) => {
    const pinned = Number(y.entry.pinned === true) - Number(x.entry.pinned === true)
    if (pinned !== 0) return pinned
    if (y.score !== x.score) return y.score - x.score
    if (x.entry.updatedAt !== y.entry.updatedAt) return x.entry.updatedAt < y.entry.updatedAt ? 1 : -1
    return x.entry.id < y.entry.id ? -1 : x.entry.id > y.entry.id ? 1 : 0
  })
  const limit = input.limit === undefined ? 50 : input.limit
  return filtered.slice(0, limit).map(({ entry }) => entry)
}

function hits(query: readonly string[], candidate: readonly string[]): number {
  const set = new Set(query)
  let n = 0
  for (const term of candidate) {
    if (set.has(term)) n++
  }
  return n
}

/** Retrieval budgets (master spec §24, spec §5.2). */
export interface MemoryBudgets {
  readonly maxEntries: number
  readonly maxChars: number
  readonly pinnedMaxChars: number
  readonly retrievedMaxChars: number
}

export const COORDINATOR_MEMORY_BUDGET: MemoryBudgets = {
  maxEntries: 10, maxChars: 4000, pinnedMaxChars: 1500, retrievedMaxChars: 2500,
}

export const TASK_MEMORY_BUDGET: MemoryBudgets = {
  maxEntries: 6, maxChars: 2000, pinnedMaxChars: 800, retrievedMaxChars: 1200,
}

/** One rendered packet line: `- title: body` (body truncated at 300 chars). */
function entryLine(entry: ProjectMemoryRecord): string {
  const title = entry.title.replace(/\s+/g, ' ').trim()
  const body = entry.body.replace(/\s+/g, ' ').trim()
  const truncated = body.length <= 300 ? body : `${body.slice(0, 299)}…`
  return `- ${title}: ${truncated}`
}

const PACKET_HEADER = 'PROJECT MEMORY (knowledge persisted from earlier runs — verify before relying on it):'

/**
 * Build the bounded context packet (spec §5.2): PINNED section first
 * (within `pinnedMaxChars`), then one section per present kind in
 * `MEMORY_KINDS` order for the non-pinned entries (within
 * `retrievedMaxChars`); rendered lines (headers included) count against the
 * section budget, no partial lines. `undefined` when nothing renders —
 * callers append nothing (no placeholder text, spec §2 invariant 2).
 */
export function buildMemoryPacket(entries: readonly ProjectMemoryRecord[], budgets: MemoryBudgets): string | undefined {
  const pinned = entries.filter(entry => entry.pinned === true)
  const rest = entries.filter(entry => entry.pinned !== true)
  const linesOut: string[] = [PACKET_HEADER, '']
  let anySection = false
  const emit = (header: string, sectionEntries: readonly ProjectMemoryRecord[], budget: number): void => {
    const lines: string[] = []
    let used = header.length
    for (const entry of sectionEntries) {
      const line = entryLine(entry)
      if (used + line.length > budget) break
      lines.push(line)
      used += line.length
    }
    if (lines.length === 0) return
    if (anySection) linesOut.push('')
    linesOut.push(header)
    linesOut.push(...lines)
    anySection = true
  }
  if (pinned.length > 0) {
    emit('PINNED:', pinned, budgets.pinnedMaxChars)
  }
  for (const kind of MEMORY_KINDS) {
    const byKind = rest.filter(entry => entry.kind === kind)
    if (byKind.length === 0) continue
    emit(`${kind.toUpperCase()}:`, byKind, budgets.retrievedMaxChars)
  }
  return anySection ? linesOut.join('\n') : undefined
}
