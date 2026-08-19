import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Worker processes race vite-node's module invalidation: when several
    // files import the same module right after its mtime changes, one worker
    // can receive a still-executing (empty) namespace, which surfaces as
    // "handleWaitOptions is not a function". Threads share one module graph.
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // CLI entry point, tested via integration
      all: true,
      // Vitest 4 requires thresholds under this key. The previous c8-shaped
      // fields were ignored, so start with a real non-regression floor while
      // the legacy command modules are brought up to the repository's 80% goal.
      thresholds: {
        lines: 45,
        functions: 45,
        branches: 40,
        statements: 45
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
