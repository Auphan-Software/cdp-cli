import { afterEach, describe, expect, it, vi } from 'vitest';
import { CDPContext, type Page } from '../../../src/context.js';
import { DaemonClient } from '../../../src/daemon/client.js';
import { createExecSession } from '../../../src/daemon/exec.js';
import { CommandTimeoutError } from '../../../src/cdp/command-timeout.js';

afterEach(() => vi.restoreAllMocks());

describe('daemon execution dialog guard', () => {
  it('uses the same actionable JavaScript-dialog diagnosis as direct execution', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([{
      pageId: 'page-1', connected: true, consoleLogs: 0, networkLogs: 0
    }]);
    vi.spyOn(DaemonClient.prototype, 'getDialogStatus').mockResolvedValue({
      open: true,
      dialog: { type: 'confirm', message: 'Discard changes?', url: 'https://example.test/' }
    });

    const page: Page = {
      id: 'page-1', title: 'Example', url: 'https://example.test/', type: 'page',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-1'
    };
    const session = await createExecSession(new CDPContext(), page);

    await expect(session.assertNoDialog()).rejects.toThrow(
      "Confirm dialog is blocking the page: \"Discard changes?\"\nUse 'cdp-cli dialog <page> --dismiss' to dismiss it, or '--accept' to accept."
    );
    await session.close();
  });

  it('names the wedged renderer when the command itself times out, and offers no dialog remedy', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([{
      pageId: 'page-1', connected: true, consoleLogs: 0, networkLogs: 0
    }]);
    const cause = new CommandTimeoutError('Runtime.evaluate', 8_000);
    vi.spyOn(DaemonClient.prototype, 'execCommand').mockRejectedValue(cause);

    const page: Page = {
      id: 'page-1', title: 'Example', url: 'https://example.test/', type: 'page',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-1'
    };
    const session = await createExecSession(new CDPContext(), page);

    const error = await session.exec('Runtime.evaluate', { expression: '1' }).then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error?.message).toContain('Page page-1 did not answer Runtime.evaluate');
    expect(error?.message).toContain('renderer is not responding');
    // The load-bearing half: the dialog escape hatch must NOT be suggested for
    // a wedge, because dismissing a dialog that is not there reports success
    // and changes nothing.
    expect(error?.message).not.toContain('--dismiss');
    expect(error?.message).toContain('NOT a dialog');
    // The original timeout stays reachable for callers that inspect it.
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    await session.close();
  });

  it('passes every non-timeout failure through untouched', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([{
      pageId: 'page-1', connected: true, consoleLogs: 0, networkLogs: 0
    }]);
    const original = new Error('Cannot find context with specified id');
    vi.spyOn(DaemonClient.prototype, 'execCommand').mockRejectedValue(original);

    const page: Page = {
      id: 'page-1', title: 'Example', url: 'https://example.test/', type: 'page',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-1'
    };
    const session = await createExecSession(new CDPContext(), page);
    await expect(session.exec('Runtime.evaluate', {})).rejects.toBe(original);
    await session.close();
  });

  it('does not turn an unavailable probe into a false dialog diagnosis', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([{
      pageId: 'page-1', connected: true, consoleLogs: 0, networkLogs: 0
    }]);
    vi.spyOn(DaemonClient.prototype, 'getDialogStatus').mockResolvedValue({
      open: false,
      probeUnavailable: true
    });

    const page: Page = {
      id: 'page-1', title: 'Example', url: 'https://example.test/', type: 'page',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-1'
    };
    const session = await createExecSession(new CDPContext(), page);

    await expect(session.assertNoDialog()).resolves.toBeUndefined();
    await session.close();
  });
});
