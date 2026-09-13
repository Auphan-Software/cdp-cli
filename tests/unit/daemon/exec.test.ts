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

  it('rules a dialog out only when a check positively reported none open', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([{
      pageId: 'page-1', connected: true, consoleLogs: 0, networkLogs: 0
    }]);
    vi.spyOn(DaemonClient.prototype, 'getDialogStatus').mockResolvedValue({ open: false });
    const cause = new CommandTimeoutError('Runtime.evaluate', 8_000);
    vi.spyOn(DaemonClient.prototype, 'execCommand').mockRejectedValue(cause);

    const page: Page = {
      id: 'page-1', title: 'Example', url: 'https://example.test/', type: 'page',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-1'
    };
    const session = await createExecSession(new CDPContext(), page);
    await session.assertNoDialog();

    const error = await session.exec('Runtime.evaluate', { expression: '1' }).then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error?.message).toContain('Page page-1 did not answer Runtime.evaluate within 8000ms');
    expect(error?.message).toContain('No JavaScript dialog was open when the command was issued');
    // The load-bearing half: the dialog escape hatch must NOT be suggested once
    // a dialog has been ruled out, because dismissing one that is not there
    // reports success and changes nothing.
    expect(error?.message).not.toContain('--dismiss');
    expect(error?.message).toContain('NOT a dialog');
    // The original timeout stays reachable for callers that inspect it.
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    // The machine-readable classification survives the friendlier message.
    expect(error).toBeInstanceOf(CommandTimeoutError);
    expect((error as CommandTimeoutError).timeoutMs).toBe(8_000);
    await session.close();
  });

  it('does not claim a wedge, or rule out a dialog, when nothing established dialog state', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([{
      pageId: 'page-1', connected: true, consoleLogs: 0, networkLogs: 0
    }]);
    const cause = new CommandTimeoutError('Runtime.evaluate', 250);
    vi.spyOn(DaemonClient.prototype, 'execCommand').mockRejectedValue(cause);

    const page: Page = {
      id: 'page-1', title: 'Example', url: 'https://example.test/', type: 'page',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-1'
    };
    // No assertNoDialog() call: a short --timeout on a merely slow page looks
    // exactly like this, so the message must not assert a wedge or an absent
    // dialog it never observed.
    const session = await createExecSession(new CDPContext(), page);

    const error = await session.exec('Runtime.evaluate', { expression: '1' }).then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error?.message).toContain('Page page-1 did not answer Runtime.evaluate within 250ms');
    expect(error?.message).toContain('Dialog state was not established');
    expect(error?.message).not.toContain('NOT a dialog');
    expect(error?.message).toContain('may simply need longer than the timeout allowed');
    // Still no blind dismissal: the caller is sent to the check, not the remedy.
    expect(error?.message).not.toContain('--dismiss');
    await session.close();
  });

  it('gives the direct WebSocket route the same diagnosis as the daemon route', async () => {
    // No daemon session for this page, so execution falls back to a direct
    // connection - which is exactly when a degraded daemon makes the message
    // matter most.
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([]);
    const context = new CDPContext();
    vi.spyOn(context, 'connect').mockResolvedValue({ close: () => {} } as never);
    vi.spyOn(context, 'assertNoDevTools').mockResolvedValue(undefined as never);
    const cause = new CommandTimeoutError('Runtime.evaluate', 5_000);
    vi.spyOn(context, 'sendCommand').mockRejectedValue(cause);

    const page: Page = {
      id: 'page-2', title: 'Example', url: 'https://example.test/', type: 'page',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-2'
    };
    const session = await createExecSession(context, page);

    const error = await session.exec('Runtime.evaluate', { expression: '1' }).then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error?.message).toContain('Page page-2 did not answer Runtime.evaluate within 5000ms');
    expect(error?.message).not.toContain('--dismiss');
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
