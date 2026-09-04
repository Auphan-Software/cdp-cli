/**
 * Tests for page management commands
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as pages from '../../../src/commands/pages.js';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { captureConsoleOutput, mockProcessExit } from '../../helpers.js';

describe('Pages Commands', () => {
  beforeEach(() => {
    installMockFetch();
  });

  describe('listPages', () => {
    it('should output NDJSON list of pages', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.listPages(context);

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(4);

      const page1 = JSON.parse(logs[0]);
      expect(page1).toEqual({
        id: 'page1',
        title: 'Example Domain',
        url: 'https://example.com',
        type: 'page'
      });
    });

    it('should exit on error', async () => {
      installMockFetch({ failFetch: true });
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.listPages(context);
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const logs = capture.getLogs();
      expect(logs.length).toBeGreaterThan(0);

      const error = JSON.parse(logs[0]);
      expect(error.error).toBe(true);

      capture.restore();
      exitMock.restore();
    });
  });

  describe('newPage', () => {
    it('should create page without URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.newPage(context);

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('new-page-123');
      expect(result.data.url).toBe('about:blank');
    });

    it('still succeeds on a custom endpoint without a daemon URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext('http://localhost:9333');

      await pages.newPage(context);

      const result = JSON.parse(capture.getLogs()[0]);
      capture.restore();
      expect(result).toMatchObject({ success: true, data: { id: 'new-page-123', logging: false } });
    });

    it('should create page with URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.newPage(context, 'https://example.com');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.data.url).toBe('https://example.com');
    });
  });

  describe('navigate', () => {
    it('should navigate to URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'https://example.com', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.action).toBe('https://example.com');
    });

    it('fails when Chrome returns a navigation errorText', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();
      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const message = JSON.parse(data);
          if (message.method === 'Page.navigate') {
            ws.sentMessages.push(message);
            setTimeout(() => ws.simulateMessage({
              id: message.id,
              result: { errorText: 'net::ERR_NAME_NOT_RESOLVED' }
            }), 5);
            return;
          }
          originalSend(data);
        };
        return ws;
      };

      try {
        await pages.navigate(context, 'https://does-not-exist.invalid', 'page1');
      } catch {
        // Expected mocked process.exit.
      }
      const error = JSON.parse(capture.getLogs()[0]);
      expect(exitMock.exitCode).toBe(1);
      expect(error.message).toContain('ERR_NAME_NOT_RESOLVED');
      capture.restore();
      exitMock.restore();
    });

    it('should navigate back', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'back', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
    });

    it('should navigate forward', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'forward', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
    });

    it('should reload page', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'reload', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
    });

    it('should handle invalid page', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.navigate(context, 'reload', 'nonexistent');
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const error = JSON.parse(capture.getLogs()[0]);
      expect(error.error).toBe(true);

      capture.restore();
      exitMock.restore();
    });
  });

  describe('closePage', () => {
    it('should close page by ID', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.closePage(context, 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('page1');
    });

    it('still closes on a custom endpoint without a daemon URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext('http://localhost:9333');

      await pages.closePage(context, 'page1');

      const result = JSON.parse(capture.getLogs()[0]);
      capture.restore();
      expect(result).toMatchObject({ success: true, data: { id: 'page1' } });
    });

    it('should close page by title', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.closePage(context, 'GitHub Issues');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.title).toBe('GitHub Issues');
    });

    it('should error when title matches multiple pages', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.closePage(context, 'GitHub');
      } catch {
        // Expected exit
      }

      expect(exitMock.exitCode).toBe(1);
      const error = JSON.parse(capture.getLogs()[0]);
      expect(error.error).toBe(true);
      expect(error.message).toContain('Multiple pages matched');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('resizeWindow', () => {
    it('should resize window with provided dimensions', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const originalConnect = context.connect.bind(context);
      let sentMessages: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const message = JSON.parse(data);
          sentMessages.push(message);
          originalSend(data);
        };
        return ws;
      };

      await pages.resizeWindow(context, 'page1', { width: 1400, height: 900 });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.page).toBe('page1');
      // Reported dimensions are read back from the window, not echoed from the
      // request, since Chrome clamps and ignores sizes in some window states.
      expect(result.data.width).toBe(1400);
      expect(result.data.height).toBe(900);
      expect(result.data.state).toBe('normal');
      expect(result.data.requested).toEqual({ width: 1400, height: 900, state: 'normal' });

      const getWindowMessage = sentMessages.find(msg => msg.method === 'Browser.getWindowForTarget');
      expect(getWindowMessage).toBeDefined();
      expect(getWindowMessage.params.targetId).toBe('page1');

      const setBoundsMessage = sentMessages.find(msg => msg.method === 'Browser.setWindowBounds');
      expect(setBoundsMessage).toBeDefined();
      expect(setBoundsMessage.params.bounds.width).toBe(1400);
      expect(setBoundsMessage.params.bounds.height).toBe(900);
      expect(setBoundsMessage.params.bounds.windowState).toBe('normal');
    });

    it('should exit when page is not found', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.resizeWindow(context, 'missing-page', { width: 1200, height: 800 });
      } catch {
        // Expected due to process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const error = JSON.parse(capture.getLogs()[0]);
      expect(error.error).toBe(true);
      expect(error.code).toBe('RESIZE_WINDOW_FAILED');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('page health and activation', () => {
    it('should collect focus, visibility, viewport, and browser window state without activating', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const originalConnect = context.connect.bind(context);
      const sentMethods: string[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          sentMethods.push(msg.method);

          if (
            msg.method === 'Runtime.evaluate' &&
            msg.params?.expression?.includes('document.hasFocus()')
          ) {
            ws.sentMessages.push(msg);
            setTimeout(() => ws.simulateMessage({
              id: msg.id,
              result: {
                result: {
                  value: {
                    hasFocus: false,
                    visibilityState: 'visible',
                    outerWidth: 1440,
                    outerHeight: 900,
                    innerWidth: 1280,
                    innerHeight: 720
                  }
                }
              }
            }), 5);
            return;
          }
          if (msg.method === 'Browser.getWindowForTarget') {
            ws.sentMessages.push(msg);
            setTimeout(() => ws.simulateMessage({
              id: msg.id,
              result: {
                windowId: 7,
                bounds: {
                  left: 20,
                  top: 30,
                  width: 1440,
                  height: 900,
                  windowState: 'normal'
                }
              }
            }), 5);
            return;
          }
          originalSend(data);
        };
        return ws;
      };

      await pages.pageHealth(context, 'page1');

      const result = JSON.parse(capture.getLogs()[0]);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        page: 'page1',
        hasFocus: false,
        visibilityState: 'visible',
        outerWidth: 1440,
        outerHeight: 900,
        innerWidth: 1280,
        innerHeight: 720,
        windowId: 7,
        windowBounds: { left: 20, top: 30, width: 1440, height: 900 },
        windowState: 'normal'
      });
      expect(sentMethods).not.toContain('Target.activateTarget');
      expect(sentMethods).not.toContain('Page.bringToFront');
      capture.restore();
    });

    it('should explicitly activate with both target and page primitives', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const originalConnect = context.connect.bind(context);
      const sent: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          sent.push(JSON.parse(data));
          originalSend(data);
        };
        return ws;
      };

      await pages.activatePage(context, 'page1');

      const methods = sent.map(message => message.method);
      expect(methods.indexOf('Target.activateTarget')).toBeGreaterThanOrEqual(0);
      expect(methods.indexOf('Page.bringToFront')).toBeGreaterThan(
        methods.indexOf('Target.activateTarget')
      );
      expect(sent.find(message => message.method === 'Target.activateTarget')?.params)
        .toEqual({ targetId: 'page1' });

      const result = JSON.parse(capture.getLogs()[0]);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ page: 'page1', activated: true });
      capture.restore();
    });
  });
});
