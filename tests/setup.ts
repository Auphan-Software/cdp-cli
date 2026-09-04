/**
 * Vitest setup file
 * Runs before all tests
 */

import { vi } from 'vitest';
import { MockWebSocket } from './mocks/websocket.mock.js';
import { createMockFetch } from './mocks/fetch.mock.js';

// Unit tests describe the stock endpoints (Chrome 9222, daemon 9223). A worker shell
// that exports per-agent CDP_URL / CDP_DAEMON_URL / CDP_SESSION would otherwise
// silently redirect the mocked daemon probes and fail the suite.
for (const name of ['CDP_URL', 'CDP_DAEMON_URL', 'CDP_SESSION', 'CDP_PAGE']) {
  delete process.env[name];
}

// Mock the ws module globally
vi.mock('ws', () => ({
  WebSocket: MockWebSocket
}));

// Mock fs module for screenshot tests, but keep real implementations for other functions
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    writeFileSync: vi.fn()
  };
});

// Install mock fetch globally BEFORE any imports
// This ensures daemon checks fail and tests use direct WebSocket path
globalThis.fetch = createMockFetch() as any;
