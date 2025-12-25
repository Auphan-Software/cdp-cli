/**
 * Vitest setup file
 * Runs before all tests
 */

import { vi } from 'vitest';
import { MockWebSocket } from './mocks/websocket.mock.js';
import { createMockFetch } from './mocks/fetch.mock.js';

// Mock the ws module globally
vi.mock('ws', () => ({
  WebSocket: MockWebSocket
}));

// Mock fs module for screenshot tests
vi.mock('fs', () => ({
  writeFileSync: vi.fn()
}));

// Install mock fetch globally BEFORE any imports
// This ensures daemon checks fail and tests use direct WebSocket path
globalThis.fetch = createMockFetch() as any;
