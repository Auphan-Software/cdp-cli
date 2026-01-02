/**
 * Mock for daemon client in tests
 * Returns "daemon not running" so tests use direct WebSocket path
 */

import { vi } from 'vitest';

export function mockDaemonNotRunning(): void {
  vi.mock('../../src/daemon/client.js', () => ({
    DaemonClient: class MockDaemonClient {
      async isRunning(): Promise<boolean> {
        return false;
      }
      async listSessions(): Promise<any[]> {
        throw new Error('Daemon not running');
      }
      async execCommand(): Promise<any> {
        throw new Error('Daemon not running');
      }
      async execBatch(): Promise<any[]> {
        throw new Error('Daemon not running');
      }
    }
  }));
}
