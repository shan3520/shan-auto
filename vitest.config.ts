import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Single home for tests (TQ-7): the legacy tests/ suites were pure or
    // ported duplicates and were removed, so only src/ is included.
    include: ['src/**/*.test.ts'],
    // Points every test file at its own scratch database, so a file that
    // forgets to set SHANAUTO_DB cannot write into the real ledger. See the
    // header of setup-isolation.ts for what got through before this existed.
    setupFiles: ['src/__tests__/setup-isolation.ts'],
    // Ledger tests share a module-level database handle, so they must not run
    // concurrently in separate workers against the same file.
    fileParallelism: false,
    testTimeout: 20_000,
    reporters: ['default'],
  },
});
