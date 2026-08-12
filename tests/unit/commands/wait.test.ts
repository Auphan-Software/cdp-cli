/**
 * Tests for shared wait utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { waitForSelector, waitForText, handleWaitOptions, armNavigationWatcher } from '../../../src/commands/wait.js';

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

    it('should reject waitForNavigation without an armed watcher', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      await expect(
        handleWaitOptions(context, ws as any, { waitForNavigation: true, timeout: 200 })
      ).rejects.toThrow('requires a navigation watcher armed before the action');
    });

    it('should resolve navigation before checking text so text is read on the new document', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const watcher = await armNavigationWatcher(context, ws as any);

      let textChecked = false;
      let navigationDoneWhenTextChecked = false;
      let navigationDone = false;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
          textChecked = true;
          navigationDoneWhenTextChecked = navigationDone;
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      setTimeout(() => {
        ws.simulateMessage({
          method: 'Page.frameNavigated',
          params: { frame: { id: 'frame123', url: 'https://example.com/after', loaderId: 'loader-2' } }
        });
        ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });
        navigationDone = true;
      }, 60);

      await handleWaitOptions(
        context,
        ws as any,
        { waitForNavigation: true, waitForText: 'Saved', timeout: 5000 },
        watcher
      );

      watcher.dispose();

      expect(textChecked).toBe(true);
      expect(navigationDoneWhenTextChecked).toBe(true);
    });
  });

  /**
   * These cover the failure that --wait-for-text could not detect: on a
   * post-and-refresh page every label is already on the outgoing document, so a
   * text wait returns against the old DOM. Navigation is tracked by loaderId
   * instead, which only changes on a genuine document replacement.
   */
  describe('armNavigationWatcher', () => {
    const armed = async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;
      const watcher = await armNavigationWatcher(context, ws as any);
      return { context, ws, watcher };
    };

    it('should resolve once a new document commits and finishes loading', async () => {
      const { ws, watcher } = await armed();

      setTimeout(() => {
        ws.simulateMessage({
          method: 'Page.frameNavigated',
          params: { frame: { id: 'frame123', url: 'https://example.com/next', loaderId: 'loader-2' } }
        });
        ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });
      }, 20);

      const result = await watcher.wait(5000);
      watcher.dispose();

      expect(result.url).toBe('https://example.com/next');
      expect(result.loaderId).toBe('loader-2');
    });

    it('should not resolve on commit alone until the load event fires', async () => {
      const { ws, watcher } = await armed();

      ws.simulateMessage({
        method: 'Page.frameNavigated',
        params: { frame: { id: 'frame123', url: 'https://example.com/slow', loaderId: 'loader-2' } }
      });

      await expect(watcher.wait(250)).rejects.toThrow('committed at https://example.com/slow but never finished loading');
      watcher.dispose();
    });

    it('should ignore subframe navigations', async () => {
      const { ws, watcher } = await armed();

      ws.simulateMessage({
        method: 'Page.frameNavigated',
        params: { frame: { id: 'subframe', parentId: 'frame123', url: 'https://ads.example', loaderId: 'loader-9' } }
      });
      ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });

      await expect(watcher.wait(250)).rejects.toThrow('never replaced its document');
      watcher.dispose();
    });

    it('should ignore a same-document navigation that keeps the loader id', async () => {
      const { ws, watcher } = await armed();

      ws.simulateMessage({
        method: 'Page.frameNavigated',
        params: { frame: { id: 'frame123', url: 'https://example.com/#route', loaderId: 'loader-initial' } }
      });
      ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });

      await expect(watcher.wait(250)).rejects.toThrow('never replaced its document');
      watcher.dispose();
    });

    it('should stop listening after dispose', async () => {
      const { ws, watcher } = await armed();

      watcher.dispose();

      ws.simulateMessage({
        method: 'Page.frameNavigated',
        params: { frame: { id: 'frame123', url: 'https://example.com/next', loaderId: 'loader-2' } }
      });
      ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });

      await expect(watcher.wait(200)).rejects.toThrow('never replaced its document');
    });
  });
});
