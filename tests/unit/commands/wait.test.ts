/**
 * Tests for shared wait utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { waitForSelector, waitForText, handleWaitOptions } from '../../../src/commands/wait.js';

describe('Wait Utilities', () => {
  beforeEach(() => {
    installMockFetch();
  });

  describe('waitForSelector', () => {
    it('should resolve immediately when selector exists', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      // Override Runtime.evaluate to return true (element found)
      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await waitForSelector(context, ws as any, '#exists', 5000);
      // No error = success
    });

    it('should throw on timeout when selector never appears', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: false } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await expect(waitForSelector(context, ws as any, '#missing', 200))
        .rejects.toThrow('Timeout waiting for selector: #missing');
    });

    it('should pass contextId for frame-scoped waits', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      let capturedContextId: number | undefined;
      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          capturedContextId = msg.params.contextId;
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await waitForSelector(context, ws as any, '#el', 5000, 99);
      expect(capturedContextId).toBe(99);
    });
  });

  describe('waitForText', () => {
    it('should resolve when text is found', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await expect(
        (await import('../../../src/commands/wait.js')).waitForText(context, ws as any, 'hello', 5000)
      ).resolves.toBeUndefined();
    });

    it('should throw on timeout when text never appears', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: false } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await expect(
        (await import('../../../src/commands/wait.js')).waitForText(context, ws as any, 'nope', 200)
      ).rejects.toThrow('Timeout waiting for text: nope');
    });
  });

  describe('handleWaitOptions', () => {
    it('should be a no-op when no wait options provided', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      // Should resolve immediately with no options
      await handleWaitOptions(context, ws as any, {});
    });

    it('should wait for selector when waitFor is set', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await handleWaitOptions(context, ws as any, { waitFor: '#result' });
    });

    it('should wait for text when waitForText is set', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await handleWaitOptions(context, ws as any, { waitForText: 'Brandy' });
    });
  });
});
