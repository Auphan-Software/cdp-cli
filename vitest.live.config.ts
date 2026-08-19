import { defineConfig } from 'vitest/config';

/**
 * Intentionally separate from vitest.config.ts: these tests use a real Chrome,
 * real WebSockets, and real HTTP servers.  They must never inherit unit-test
 * setup that replaces those globals.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
