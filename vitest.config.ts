import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Worker processes race vite-node's module invalidation: when several
    // files import the same module right after its mtime changes, one worker
    // can receive a still-executing (empty) namespace, which surfaces as
    // "handleWaitOptions is not a function". Threads share one module graph.
    pool: 'threads',
    coverage: {
      provider: 'c8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // CLI entry point, tested via integration
      all: true,
      lines: 80,
      functions: 80,
      branches: 75,
      statements: 80
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
