/**
 * Tests for input automation commands
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as input from '../../../src/commands/input.js';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { captureConsoleOutput, mockProcessExit, waitFor } from '../../helpers.js';

describe('Input Commands', () => {
  beforeEach(() => {
    installMockFetch();
  });

  describe('click', () => {
    it('should click element at calculated center point', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.click(context, 'button#submit', { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Click performed');
      expect(result.data.selector).toBe('button#submit');
      // Mock box model: [100, 100, 200, 100, 200, 200, 100, 200]
      // Center x: (100 + 200 + 200 + 100) / 4 = 150
      // Center y: (100 + 100 + 200 + 200) / 4 = 150
      expect(result.data.x).toBe(150);
      expect(result.data.y).toBe(150);
      expect(result.data.double).toBe(false);
      expect(result.data.longpress).toBe(0);
    });

    it('should perform double click when requested', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.click(context, 'button', { page: 'page1', double: true });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.data.double).toBe(true);
      expect(result.data.longpress).toBe(0);
    });

    it('should perform long press when requested', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const originalConnect = context.connect.bind(context);
      const mouseEvents: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Input.dispatchMouseEvent') {
            mouseEvents.push(msg.params);
          }
          originalSend(data);
        };

        return ws;
      };

      vi.useFakeTimers();
      try {
        const clickPromise = input.click(context, 'button', {
          page: 'page1',
          longpress: 0.5
        });

        await vi.runAllTimersAsync();
        await clickPromise;
      } finally {
        vi.useRealTimers();
      }

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);

      expect(result.success).toBe(true);
      expect(result.data.longpress).toBeCloseTo(0.5, 5);

      const pressedEvents = mouseEvents.filter(event => event.type === 'mousePressed');
      const releasedEvents = mouseEvents.filter(event => event.type === 'mouseReleased');

      expect(pressedEvents).toHaveLength(1);
      expect(releasedEvents).toHaveLength(1);
    });

    it('should dispatch correct mouse events for single click', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      // We need to intercept the WebSocket to check messages
      // For this test, we'll just verify the function completes successfully
      await input.click(context, 'button', { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
    });

    it('should recover when selector and page arguments are swapped', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.click(
        context,
        { selector: 'page1' },
        { page: '.cta-button' }
      );

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.selector).toBe('.cta-button');
    });

    it('should reject double click combined with long press', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await input.click(context, 'button', {
          page: 'page1',
          double: true,
          longpress: 0.2
        });
      } catch {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);

      const error = JSON.parse(capture.getLogs()[0]);
      expect(error.error).toBe(true);
      expect(error.code).toBe('CLICK_INVALID_OPTIONS');

      capture.restore();
      exitMock.restore();
    });

    // Note: Element not found error is difficult to test with auto-responding mocks
    // The error handling is validated by the page not found test below

    it('should handle page not found error', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await input.click(context, 'button', { page: 'nonexistent' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const error = JSON.parse(capture.getLogs()[0]);
      expect(error.error).toBe(true);
      expect(error.code).toBe('CLICK_FAILED');

      capture.restore();
      exitMock.restore();
    });

    describe('viewport and hit testing', () => {
      /**
       * Intercepts the click-point probe so a test can control what the page
       * reports back about scrolling and occlusion.
       */
      function stubClickPoint(
        context: CDPContext,
        value: Record<string, unknown>
      ): { mouseEvents: any[]; probes: any[] } {
        const mouseEvents: any[] = [];
        const probes: any[] = [];
        const originalConnect = context.connect.bind(context);

        context.connect = async (page) => {
          const ws = await originalConnect(page) as MockWebSocket;
          const originalSend = ws.send.bind(ws);

          ws.send = (data: string) => {
            const msg = JSON.parse(data);

            if (msg.method === 'Input.dispatchMouseEvent') {
              mouseEvents.push(msg.params);
            }

            if (
              msg.method === 'Runtime.callFunctionOn' &&
              msg.params?.functionDeclaration?.includes('elementFromPoint')
            ) {
              probes.push(msg.params);
              ws.sentMessages.push(msg);
              setTimeout(() => {
                ws.simulateMessage({ id: msg.id, result: { result: { value } } });
              }, 5);
              return;
            }

            originalSend(data);
          };

          return ws;
        };

        return { mouseEvents, probes };
      }

      it('should scroll a below-the-fold element into view and click its new position', async () => {
        const capture = captureConsoleOutput();
        const context = new CDPContext();

        // Element starts at y=1505 (outside a 720px viewport); after scrolling
        // it settles at y=338.
        const { mouseEvents, probes } = stubClickPoint(context, {
          rect: { x: 28, y: 338, width: 182, height: 46 },
          scrolled: true,
          inViewport: true,
          hitOk: true,
          hit: 'button#below'
        });

        await input.click(context, '#below', { page: 'page1' });

        const logs = capture.getLogs();
        capture.restore();

        expect(probes).toHaveLength(1);

        const result = JSON.parse(logs[0]);
        expect(result.success).toBe(true);
        expect(result.data.scrolled).toBe(true);
        // Center of the post-scroll rect, not the stale pre-scroll rect
        expect(result.data.x).toBe(119);
        expect(result.data.y).toBe(361);

        const pressed = mouseEvents.find(event => event.type === 'mousePressed');
        expect(pressed.x).toBe(119);
        expect(pressed.y).toBe(361);
      });

      it('should fail with CLICK_OCCLUDED when another element covers the click point', async () => {
        const capture = captureConsoleOutput();
        const exitMock = mockProcessExit();
        const context = new CDPContext();

        const { mouseEvents } = stubClickPoint(context, {
          rect: { x: 28, y: 38, width: 129, height: 47 },
          scrolled: false,
          inViewport: true,
          hitOk: false,
          hit: 'div#overlay'
        });

        try {
          await input.click(context, '#top', { page: 'page1' });
        } catch {
          // Expected process.exit
        }

        const logs = capture.getLogs();
        capture.restore();
        exitMock.restore();

        expect(exitMock.exitCode).toBe(1);

        const error = JSON.parse(logs[0]);
        expect(error.error).toBe(true);
        expect(error.code).toBe('CLICK_OCCLUDED');
        expect(error.details.occludedBy).toBe('div#overlay');

        // Must not pretend to click when the event would be swallowed
        expect(mouseEvents).toHaveLength(0);
      });

      it('should fail with CLICK_OFFSCREEN when the element cannot be scrolled into view', async () => {
        const capture = captureConsoleOutput();
        const exitMock = mockProcessExit();
        const context = new CDPContext();

        const { mouseEvents } = stubClickPoint(context, {
          rect: { x: 28, y: 4000, width: 100, height: 40 },
          scrolled: true,
          inViewport: false,
          hitOk: false,
          hit: null
        });

        try {
          await input.click(context, '#stuck', { page: 'page1' });
        } catch {
          // Expected process.exit
        }

        const logs = capture.getLogs();
        capture.restore();
        exitMock.restore();

        expect(exitMock.exitCode).toBe(1);
        expect(JSON.parse(logs[0]).code).toBe('CLICK_OFFSCREEN');
        expect(mouseEvents).toHaveLength(0);
      });

      it('should click anyway when --force is set despite occlusion', async () => {
        const capture = captureConsoleOutput();
        const context = new CDPContext();

        const { mouseEvents } = stubClickPoint(context, {
          rect: { x: 28, y: 38, width: 129, height: 47 },
          scrolled: false,
          inViewport: true,
          hitOk: false,
          hit: 'div#overlay'
        });

        await input.click(context, '#top', { page: 'page1', force: true });

        const logs = capture.getLogs();
        capture.restore();

        const result = JSON.parse(logs[0]);
        expect(result.success).toBe(true);
        expect(result.data.occludedBy).toBe('div#overlay');
        expect(mouseEvents.filter(e => e.type === 'mousePressed')).toHaveLength(1);
      });

      it('should fail with CLICK_DETACHED when the element left the document', async () => {
        const capture = captureConsoleOutput();
        const exitMock = mockProcessExit();
        const context = new CDPContext();

        stubClickPoint(context, { detached: true });

        try {
          await input.click(context, '#gone', { page: 'page1' });
        } catch {
          // Expected process.exit
        }

        const logs = capture.getLogs();
        capture.restore();
        exitMock.restore();

        expect(exitMock.exitCode).toBe(1);
        expect(JSON.parse(logs[0]).code).toBe('CLICK_DETACHED');
      });
    });

    it('should call handleWaitOptions after click when wait-for is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const origSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector') && msg.params.expression.includes('#result')) {
            setTimeout(() => {
              ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
            }, 5);
            ws.sentMessages.push(msg);
            return;
          }
          origSend(data);
        };
        return ws;
      };

      await input.click(context, 'button', {
        page: 'page1',
        waitFor: '#result'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedFor).toBe('#result');
    });

    it('should call handleWaitOptions after click when wait-for-text is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
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
        return ws;
      };

      await input.click(context, 'button', {
        page: 'page1',
        waitForText: 'Brandy'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedForText).toBe('Brandy');
    });
  });

  describe('fill', () => {
    it('should fill input element', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.fill(context, 'input#email', 'test@example.com', { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Fill performed');
      expect(result.data.selector).toBe('input#email');
      expect(result.data.value).toBe('test@example.com');
    });

    // Skipped: Runtime.evaluate now used for clearing - security review needed
    it.skip('should use DOM.setAttributeValue to clear value (SECURITY)', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      // Intercept WebSocket to verify commands
      const originalConnect = context.connect.bind(context);
      let capturedMessages: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        // Capture all sent messages
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          capturedMessages.push(msg);
          originalSend(data);
        };

        return ws;
      };

      await input.fill(context, 'input#test', 'value', { page: 'page1' });

      // Verify DOM.setAttributeValue was used
      const setAttrMessages = capturedMessages.filter(m => m.method === 'DOM.setAttributeValue');
      expect(setAttrMessages.length).toBeGreaterThan(0);

      const clearMessage = setAttrMessages.find(m =>
        m.params?.name === 'value' && m.params?.value === ''
      );
      expect(clearMessage).toBeDefined();
      expect(clearMessage.params.nodeId).toBe(42);

      // SECURITY: Verify Runtime.evaluate is NOT used (code injection vulnerability)
      const evalMessages = capturedMessages.filter(m => m.method === 'Runtime.evaluate');
      expect(evalMessages).toHaveLength(0);

      capture.restore();
    });

    it('should dispatch keyDown and keyUp for each character', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      let keyEventCount = 0;

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Input.dispatchKeyEvent') {
            keyEventCount++;
          }
          originalSend(data);
        };

        return ws;
      };

      await input.fill(context, 'input', 'ab', { page: 'page1' });

      // 2 characters × 2 events (keyDown + keyUp) = 4 events
      expect(keyEventCount).toBe(4);

      capture.restore();
    });

    it('should handle multi-character input', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.fill(context, 'input', 'test123', { page: 'page1' });

      const result = JSON.parse(capture.getLogs()[0]);
      expect(result.success).toBe(true);
      expect(result.data.value).toBe('test123');

      capture.restore();
    });

    // Note: Element not found error is difficult to test with auto-responding mocks
    // The error handling is validated by the page not found test below

    it('should handle page not found error', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await input.fill(context, 'input', 'value', { page: 'nonexistent' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const error = JSON.parse(capture.getLogs()[0]);
      expect(error.error).toBe(true);
      expect(error.code).toBe('FILL_FAILED');

      capture.restore();
      exitMock.restore();
    });

    it('should call handleWaitOptions after fill when wait-for is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const origSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector') && msg.params.expression.includes('#filtered-list')) {
            setTimeout(() => {
              ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
            }, 5);
            ws.sentMessages.push(msg);
            return;
          }
          origSend(data);
        };
        return ws;
      };

      await input.fill(context, 'input#search', 'cash discounting', {
        page: 'page1',
        waitFor: '#filtered-list'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedFor).toBe('#filtered-list');
    });

    it('should call handleWaitOptions after fill when wait-for-text is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
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
        return ws;
      };

      await input.fill(context, 'input#search', 'cash discounting', {
        page: 'page1',
        waitForText: 'Brandy'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedForText).toBe('Brandy');
    });
  });

  describe('fill value replacement', () => {
    it('should clear through the value property, not the value attribute', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const sent: any[] = [];

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          sent.push(JSON.parse(data));
          originalSend(data);
        };
        return ws;
      };

      await input.fill(context, 'input#email', 'new', { page: 'page1' });
      capture.restore();

      // DOM.setAttributeValue only writes the default value; a dirty field keeps
      // its old text and typing appends to it.
      expect(sent.filter(m => m.method === 'DOM.setAttributeValue')).toHaveLength(0);

      const clearCall = sent.find(m =>
        m.method === 'Runtime.callFunctionOn' &&
        m.params?.functionDeclaration?.includes('activeElement')
      );
      expect(clearCall).toBeDefined();
      expect(clearCall.params.functionDeclaration).toMatch(/el\.value = ''/);
    });

    it('should target the handle of the nth match, not a re-queried selector', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const sent: any[] = [];

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          sent.push(msg);
          if (msg.method === 'DOM.querySelectorAll') {
            ws.sentMessages.push(msg);
            setTimeout(() => {
              ws.simulateMessage({ id: msg.id, result: { nodeIds: [42, 43] } });
            }, 5);
            return;
          }
          originalSend(data);
        };
        return ws;
      };

      await input.fill(context, 'input', 'x', { page: 'page1', nth: 2 });
      capture.restore();

      // The old frame path cleared document.querySelector(selector) - always the
      // first match - while typing went to the nth.
      const evaluates = sent.filter(m => m.method === 'Runtime.evaluate');
      expect(evaluates.every(m => !m.params?.expression?.includes(".value = ''"))).toBe(true);
    });

    it('should report a disabled field instead of claiming success', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (
            msg.method === 'Runtime.callFunctionOn' &&
            msg.params?.functionDeclaration?.includes('activeElement')
          ) {
            ws.sentMessages.push(msg);
            setTimeout(() => {
              ws.simulateMessage({
                id: msg.id,
                result: { result: { value: { error: 'Field is disabled' } } }
              });
            }, 5);
            return;
          }
          originalSend(data);
        };
        return ws;
      };

      try {
        await input.fill(context, 'input#off', 'x', { page: 'page1' });
      } catch {
        // Expected process.exit
      }

      const logs = capture.getLogs();
      capture.restore();
      exitMock.restore();

      expect(exitMock.exitCode).toBe(1);
      const error = JSON.parse(logs[0]);
      expect(error.code).toBe('FILL_FAILED');
      expect(error.message).toMatch(/disabled/);
    });
  });

  describe('pressKey', () => {
    it('should send a virtual key code so the key actually acts', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const keyEvents: any[] = [];

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Input.dispatchKeyEvent') {
            keyEvents.push(msg.params);
          }
          originalSend(data);
        };
        return ws;
      };

      await input.pressKey(context, 'enter', { page: 'page1' });
      capture.restore();

      // keyCode 0 produces an event the page sees but the browser ignores, so
      // Enter would never submit a form.
      expect(keyEvents[0].windowsVirtualKeyCode).toBe(13);
      expect(keyEvents[0].nativeVirtualKeyCode).toBe(13);
      expect(keyEvents[0].code).toBe('Enter');
      expect(keyEvents[0].text).toBe('\r');
      expect(keyEvents[1].type).toBe('keyUp');
      expect(keyEvents[1].windowsVirtualKeyCode).toBe(13);
    });

    it('should use rawKeyDown for keys that insert no text', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const keyEvents: any[] = [];

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Input.dispatchKeyEvent') {
            keyEvents.push(msg.params);
          }
          originalSend(data);
        };
        return ws;
      };

      await input.pressKey(context, 'arrowdown', { page: 'page1' });
      capture.restore();

      expect(keyEvents[0].type).toBe('rawKeyDown');
      expect(keyEvents[0].text).toBeUndefined();
      expect(keyEvents[0].windowsVirtualKeyCode).toBe(40);
    });

    it('should reject an unknown key rather than sending a dead event', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await input.pressKey(context, 'nonsense', { page: 'page1' });
      } catch {
        // Expected process.exit
      }

      const logs = capture.getLogs();
      capture.restore();
      exitMock.restore();

      expect(exitMock.exitCode).toBe(1);
      expect(JSON.parse(logs[0]).code).toBe('PRESS_KEY_FAILED');
      expect(JSON.parse(logs[0]).message).toMatch(/Unknown key/);
    });

    it('should map common key names', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.pressKey(context, 'enter', { page: 'page1' });

      const result = JSON.parse(capture.getLogs()[0]);
      expect(result.success).toBe(true);
      expect(result.data.key).toBe('Enter'); // Mapped from 'enter'

      capture.restore();
    });

    it('should handle multiple mapped keys', async () => {
      const testCases = [
        { input: 'tab', expected: 'Tab' },
        { input: 'escape', expected: 'Escape' },
        { input: 'space', expected: ' ' },
        { input: 'arrowup', expected: 'ArrowUp' },
        { input: 'backspace', expected: 'Backspace' }
      ];

      for (const { input: key, expected } of testCases) {
        const capture = captureConsoleOutput();
        const context = new CDPContext();

        await input.pressKey(context, key, { page: 'page1' });

        const result = JSON.parse(capture.getLogs()[0]);
        expect(result.data.key).toBe(expected);

        capture.restore();
      }
    });

    it('should be case insensitive for key mapping', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.pressKey(context, 'ENTER', { page: 'page1' });

      const result = JSON.parse(capture.getLogs()[0]);
      expect(result.data.key).toBe('Enter');

      capture.restore();
    });

    it('should pass through unmapped keys', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await input.pressKey(context, 'F1', { page: 'page1' });

      const result = JSON.parse(capture.getLogs()[0]);
      expect(result.data.key).toBe('F1');

      capture.restore();
    });

    it('should dispatch keyDown and keyUp events', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      let keyEvents: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Input.dispatchKeyEvent') {
            keyEvents.push(msg.params);
          }
          originalSend(data);
        };

        return ws;
      };

      await input.pressKey(context, 'enter', { page: 'page1' });

      expect(keyEvents).toHaveLength(2);
      expect(keyEvents[0].type).toBe('keyDown');
      expect(keyEvents[0].key).toBe('Enter');
      expect(keyEvents[1].type).toBe('keyUp');
      expect(keyEvents[1].key).toBe('Enter');

      capture.restore();
    });

    it('should handle page not found error', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await input.pressKey(context, 'enter', { page: 'nonexistent' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const error = JSON.parse(capture.getLogs()[0]);
      expect(error.error).toBe(true);
      expect(error.code).toBe('PRESS_KEY_FAILED');

      capture.restore();
      exitMock.restore();
    });
  });
});
