/** Shared Git execution helper for DSH Projects workspace operations. */

import { execFile } from 'node:child_process'

/** Bounded output buffer for Git commands (stderr-tailed error messages). */
export const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024

/**
 * Run one git command and resolve its trimmed stdout. Stderr is kept as a
 * bounded tail in the error message; `cwd` is passed as `-C` (git >= 1.26).
 *
 * Extracted verbatim from `WorkspaceManager` (Phase 5) so the task worktree
 * module and the issue-workspace manager share one Git discipline (spec §4.1).
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = outerSignal === undefined ? timeout : AbortSignal.any([outerSignal, timeout])
  return await new Promise<string>((accept, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Git workspace operation was cancelled'))
        return
      }
      if (error !== null) {
        const detail = stderr.trim().slice(-4000)
        reject(new Error(`git ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`))
        return
      }
      accept(stdout.trim())
    })
  })
}
