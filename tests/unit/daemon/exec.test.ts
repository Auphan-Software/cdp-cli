import { afterEach, describe, expect, it, vi } from 'vitest';
import { CDPContext, type Page } from '../../../src/context.js';
import { DaemonClient } from '../../../src/daemon/client.js';
import { createExecSession } from '../../../src/daemon/exec.js';

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
