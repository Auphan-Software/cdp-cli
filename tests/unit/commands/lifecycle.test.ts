/**
 * Tests for lifecycle commands (ready, findChrome)
 */

import { describe, it, expect, vi } from 'vitest';
import { captureConsoleOutput } from '../../helpers.js';
import { platform } from 'os';

// Test findChrome separately since it's a pure function
describe('Lifecycle Commands', () => {
  describe('findChrome', () => {
    // Note: findChrome tests skipped due to vitest fs mock complexity
    // The function is tested via integration tests
    it.skip('should return correct path type for platform', async () => {
      // Skipped - fs mock prevents testing
    });
  });

  describe('ready', () => {
    it('should output success when Chrome and daemon already running', async () => {
      const capture = captureConsoleOutput();

      // Mock fetch for this test
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        const urlStr = url.toString();

        if (urlStr.includes(':9223/health')) {
          return { ok: true, json: async () => ({ status: 'ok', sessions: 1 }) } as any;
        }
        if (urlStr.includes(':9222/json/version')) {
          return { ok: true, json: async () => ({ Browser: 'Chrome/120' }) } as any;
        }
        if (urlStr.includes(':9222/json')) {
          return {
            ok: true,
            json: async () => [{ id: 'p1', type: 'page', title: 'Test', url: 'http://t.com' }]
          } as any;
        }
        throw new Error('Unknown');
      };

      try {
        const { ready } = await import('../../../src/commands/lifecycle.js');
        await ready({ profile: '/tmp/p', port: 9222, cdpUrl: 'http://localhost:9222' });

        const logs = capture.getLogs();
        const successLog = logs.find(l => l.includes('"success":true'));
        expect(successLog).toBeDefined();

        const result = JSON.parse(successLog!);
        expect(result.data.chromeStarted).toBe(false);
        expect(result.data.daemonStarted).toBe(false);
      } finally {
        global.fetch = originalFetch;
        capture.restore();
      }
    });
  });
});
