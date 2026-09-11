/**
 * `eval --timeout`: the cap is overridable, and blowing it is reported under
 * its own code so a harness can tell it apart from a page-level failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as debug from '../../../src/commands/debug.js';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { captureConsoleOutput, mockProcessExit } from '../../helpers.js';

/** A page whose Runtime.evaluate never answers; everything else behaves. */
function silentEvaluate(context: CDPContext): void {
  const originalConnect = context.connect.bind(context);
  context.connect = async (page) => {
    const ws = await originalConnect(page) as MockWebSocket;
    const originalSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      if (JSON.parse(data).method === 'Runtime.evaluate') return;
      originalSend(data);
    };
    return ws;
  };
}

describe('eval round-trip timeout', () => {
  beforeEach(() => {
    installMockFetch();
    vi.clearAllMocks();
  });

  it('reports a blown cap as EVAL_TIMEOUT naming the cap, not as EVAL_FAILED', async () => {
    const capture = captureConsoleOutput();
    const exitMock = mockProcessExit();
    const context = new CDPContext();
    silentEvaluate(context);

    try {
      await debug.evaluate(context, 'never()', { page: 'page1', timeout: 60 });
    } catch {
      // Expected process.exit
    }

    const logs = capture.getLogs();
    capture.restore();
    exitMock.restore();

    expect(logs).toHaveLength(1); // sentinel: something was actually reported
    const error = JSON.parse(logs[0]);
    expect(error.code).toBe('EVAL_TIMEOUT');
    expect(error.details).toMatchObject({
      timedOut: true,
      timeoutMs: 60,
      method: 'Runtime.evaluate',
      path: 'direct',
      expression: 'never()'
    });
    expect(error.message).toContain('60ms');
    expect(exitMock.exitCode).toBe(1);
  });

  it('lets a longer cap carry an in-page wait the shorter cap kills', async () => {
    const context = new CDPContext();
    const originalConnect = context.connect.bind(context);
    // Answer Runtime.evaluate only after 120ms, as a page awaiting a promise does.
    context.connect = async (page) => {
      const ws = await originalConnect(page) as MockWebSocket;
      const originalSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const message = JSON.parse(data);
        if (message.method === 'Runtime.evaluate') {
          setTimeout(() => ws.simulateMessage({
            id: message.id,
            result: { result: { value: 'slow ok', type: 'string' } }
          }), 120);
          return;
        }
        originalSend(data);
      };
      return ws;
    };

    // Short cap: fails.
    const shortCapture = captureConsoleOutput();
    const shortExit = mockProcessExit();
    try {
      await debug.evaluate(context, 'await slow()', { page: 'page1', async: true, timeout: 40 });
    } catch {
      // Expected process.exit
    }
    const shortLogs = shortCapture.getLogs();
    shortCapture.restore();
    shortExit.restore();
    expect(JSON.parse(shortLogs[0]).code).toBe('EVAL_TIMEOUT');

    // Longer cap over the same page: succeeds.
    const longCapture = captureConsoleOutput();
    await debug.evaluate(context, 'await slow()', { page: 'page1', async: true, timeout: 2_000 });
    const longLogs = longCapture.getLogs();
    longCapture.restore();
    expect(JSON.parse(longLogs[0])).toMatchObject({ success: true, value: 'slow ok' });
  });

  it('still reports a real in-page exception as EVAL_EXCEPTION', async () => {
    const capture = captureConsoleOutput();
    const exitMock = mockProcessExit();
    const context = new CDPContext();
    const originalConnect = context.connect.bind(context);
    context.connect = async (page) => {
      const ws = await originalConnect(page) as MockWebSocket;
      const originalSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const message = JSON.parse(data);
        if (message.method === 'Runtime.evaluate') {
          ws.simulateMessage({
            id: message.id,
            result: {
              result: { type: 'object' },
              exceptionDetails: { text: 'Uncaught ReferenceError: boom is not defined' }
            }
          });
          return;
        }
        originalSend(data);
      };
      return ws;
    };

    try {
      await debug.evaluate(context, 'boom()', { page: 'page1', timeout: 5_000 });
    } catch {
      // Expected process.exit
    }

    const logs = capture.getLogs();
    capture.restore();
    exitMock.restore();

    const error = JSON.parse(logs[0]);
    expect(error.code).toBe('EVAL_EXCEPTION');
    expect(error.message).toBe('Uncaught ReferenceError: boom is not defined');
  });

  it('still reports a non-timeout failure as EVAL_FAILED', async () => {
    const capture = captureConsoleOutput();
    const exitMock = mockProcessExit();
    const context = new CDPContext();

    try {
      await debug.evaluate(context, '2 + 2', { page: 'nonexistent', timeout: 5_000 });
    } catch {
      // Expected process.exit
    }

    const logs = capture.getLogs();
    capture.restore();
    exitMock.restore();

    expect(JSON.parse(logs[0]).code).toBe('EVAL_FAILED');
  });

  it('leaves the default cap untouched when no --timeout is given', async () => {
    const context = new CDPContext();
    const send = vi.spyOn(context, 'sendCommand');

    const capture = captureConsoleOutput();
    await debug.evaluate(context, '2 + 2', { page: 'page1' });
    const logs = capture.getLogs();
    capture.restore();

    // Byte-identical success output, and every round trip left on its default.
    expect(JSON.parse(logs[0])).toEqual({ success: true, value: 'test result', type: 'string' });
    expect(send).toHaveBeenCalled(); // sentinel
    for (const call of send.mock.calls) {
      expect(call[3]).toBeUndefined();
    }
  });
});
