/**
 * Client isolation invariant (spec §4): the Web bundle (src/client/**) must
 * never import the server-side Trigger implementation (src/triggers/**). The
 * client carries its own mirror types (CLIENT_TRIGGER_TYPES & friends in
 * controller.ts) and talks to the trigger service only through the typed
 * DashboardDataPort RPC surface.
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

describe('client triggers isolation (spec §4)', () => {
  it('src/client never imports src/triggers', async () => {
    const files = await collectFiles(CLIENT_ROOT)
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const line of source.split('\n')) {
        if (/from\s+['"]\.\.\/triggers\//.test(line) || /from\s+['"]\.\.\/\.\.\/triggers\//.test(line) || /from\s+['"]src\/triggers\//.test(line)) {
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
