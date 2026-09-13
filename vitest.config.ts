import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The Phase 5 Git suites (worktree provisioning, integration, storage
    // reopens) spawn many real `git` processes and share one disk. On an
    // 8-core host the default fork count starves them and their timeouts fire
    // under load; a bounded pool keeps the disk-bound files from contending
    // with every other test file.
    maxWorkers: 4,
  },
})
