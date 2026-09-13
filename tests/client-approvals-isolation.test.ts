/**
 * Client isolation invariant (Phase 7, spec §3.1): the Web bundle
 * (src/client/**) must never import the server-side Approval implementation
 * (src/approvals/**). The client carries its own mirror types
 * (CLIENT_APPROVAL_MODES & friends in controller.ts) and talks to the
 * approval service only through the typed DashboardDataPort RPC surface.
 * The host-agnostic `RunBudget` lives in src/runs/types.ts (not approvals/),
 * so importing it stays legal.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = join(__dirname, '..', 'src', 'client')

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(path))
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('client approvals isolation (spec §3.1)', () => {
  it('src/client never imports src/approvals', async () => {
    const files = await collectFiles(CLIENT_ROOT)
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const line of source.split('\n')) {
        if (/from\s+['"]\.\.\/approvals\//.test(line) || /from\s+['"]\.\.\/\.\.\/approvals\//.test(line) || /from\s+['"]src\/approvals\//.test(line)) {
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
