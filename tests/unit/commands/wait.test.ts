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

      await expect(watcher.wait(250)).rejects.toThrow('committed at https://example.com/slow in the main frame but never finished loading');
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

    /**
     * A form POST inside an iframe navigates only that frame. Page.loadEventFired
     * is main-frame only, so a subframe wait has to key on frameStoppedLoading.
     */
    describe('frame-scoped waits', () => {
      const armedOnFrame = async () => {
        const context = new CDPContext();
        const page = await context.findPage('page1');
        const ws = await context.connect(page) as unknown as MockWebSocket;
        // resolveFrameId walks the frame tree; index 1 is the first child frame.
        const watcher = await armNavigationWatcher(context, ws as any, '1');
        return { ws, watcher };
      };

      it('should resolve on a subframe commit followed by frameStoppedLoading', async () => {
        const { ws, watcher } = await armedOnFrame();

        setTimeout(() => {
          ws.simulateMessage({
            method: 'Page.frameNavigated',
            params: {
              frame: {
                id: 'child-frame',
                parentId: 'frame123',
                url: 'https://example.com/inner2',
                loaderId: 'child-loader-2'
              }
            }
          });
          ws.simulateMessage({
            method: 'Page.frameStoppedLoading',
            params: { frameId: 'child-frame' }
          });
        }, 20);

        const result = await watcher.wait(5000);
        watcher.dispose();

        expect(result.url).toBe('https://example.com/inner2');
        expect(result.loaderId).toBe('child-loader-2');
      });

      it('should accept a lifecycle load event for the target frame', async () => {
        const { ws, watcher } = await armedOnFrame();

        setTimeout(() => {
          ws.simulateMessage({
            method: 'Page.frameNavigated',
            params: {
              frame: { id: 'child-frame', parentId: 'frame123', url: 'https://example.com/x', loaderId: 'l2' }
            }
          });
          ws.simulateMessage({
            method: 'Page.lifecycleEvent',
            params: { frameId: 'child-frame', name: 'load' }
          });
        }, 20);

        const result = await watcher.wait(5000);
        watcher.dispose();
        expect(result.loaderId).toBe('l2');
      });

      it('should ignore a main-frame navigation when watching a subframe', async () => {
        const { ws, watcher } = await armedOnFrame();

        ws.simulateMessage({
          method: 'Page.frameNavigated',
          params: { frame: { id: 'frame123', url: 'https://example.com/top2', loaderId: 'top-loader-2' } }
        });
        ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });

        await expect(watcher.wait(250)).rejects.toThrow('frame 1 never replaced its document');
        watcher.dispose();
      });

      it('should not let a main-frame load event complete a subframe wait', async () => {
        const { ws, watcher } = await armedOnFrame();

        ws.simulateMessage({
          method: 'Page.frameNavigated',
          params: {
            frame: { id: 'child-frame', parentId: 'frame123', url: 'https://example.com/slow', loaderId: 'l9' }
          }
        });
        // Main-frame completion signal must not satisfy the subframe wait.
        ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });

        await expect(watcher.wait(250)).rejects.toThrow('committed at https://example.com/slow in frame 1 but never finished loading');
        watcher.dispose();
      });

      it('should point at --wait-for-frame when a main-frame wait times out', async () => {
        const { watcher } = await armed();

        await expect(watcher.wait(200)).rejects.toThrow('--wait-for-frame');
        watcher.dispose();
      });
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
