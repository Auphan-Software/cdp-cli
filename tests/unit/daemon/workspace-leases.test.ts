import { afterEach, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { CDPDaemon } from '../../../src/daemon/daemon.js';
import { DaemonClient } from '../../../src/daemon/client.js';
import { SessionFoundationError } from '../../../src/sessions/errors.js';

let daemon: CDPDaemon | undefined;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
  globalThis.fetch = originalFetch;
});

describe('daemon workspace lease authority', () => {
  it('rejects a concurrent client and allows immediate acquire after awaited release', async () => {
    globalThis.fetch = undiciFetch as unknown as typeof fetch;
    daemon = new CDPDaemon({
      port: 0,
      cdpUrl: 'http://127.0.0.1:1',
      workspaceRootResolver: async () => 'root-1'
    });
    await daemon.start();
    const daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
    const firstProcess = new DaemonClient({ daemonUrl });
    const secondProcess = new DaemonClient({ daemonUrl });

    const first = await firstProcess.acquireWorkspaceLease('alpha', 'child-1');
    await expect(secondProcess.acquireWorkspaceLease('beta', 'root-1')).rejects.toMatchObject({
      code: 'LEASE_CONFLICT'
    });

    await firstProcess.releaseWorkspaceLease(
      'alpha',
      'child-1',
      first.leaseId,
      first.rootTargetId
    );
    const second = await secondProcess.acquireWorkspaceLease('beta', 'root-1');
    expect(second.owner).toBe('beta');
    await secondProcess.releaseWorkspaceLease(
      'beta',
      'root-1',
      second.leaseId,
      second.rootTargetId
    );
  });

  it('ignores a forged root hint and validates ownership before acquisition', async () => {
    globalThis.fetch = undiciFetch as unknown as typeof fetch;
    daemon = new CDPDaemon({
      port: 0,
      cdpUrl: 'http://127.0.0.1:1',
      workspaceRootResolver: async (sessionName, pageId) => {
        if (sessionName === 'alpha' && pageId === 'child-1') return 'root-1';
        throw new SessionFoundationError('PAGE_NOT_OWNED', 'Target is not owned');
      }
    });
    await daemon.start();
    const daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;

    const forged = await undiciFetch(`${daemonUrl}/workspace-leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'acquire',
        sessionName: 'forged',
        pageId: 'not-owned',
        rootTargetId: 'root-1'
      })
    });
    expect(forged.ok).toBe(false);
    expect(await forged.json()).toMatchObject({ code: 'PAGE_NOT_OWNED' });

    const legitimate = await new DaemonClient({ daemonUrl })
      .acquireWorkspaceLease('alpha', 'child-1');
    expect(legitimate.rootTargetId).toBe('root-1');
  });

  it('lets forced reset replace a same-owner lease but rejects another owner', async () => {
    globalThis.fetch = undiciFetch as unknown as typeof fetch;
    daemon = new CDPDaemon({
      port: 0,
      cdpUrl: 'http://127.0.0.1:1',
      workspaceRootResolver: async (_sessionName, pageId) => pageId
    });
    await daemon.start();
    const client = new DaemonClient({ daemonUrl: `http://127.0.0.1:${daemon.listeningPort}` });
    const running = await client.acquireWorkspaceLease('alpha', 'root-1');
    await expect(client.replaceOwnedWorkspaceLease('beta', 'root-1')).rejects.toMatchObject({
      code: 'LEASE_NOT_OWNED'
    });
    const reset = await client.replaceOwnedWorkspaceLease('alpha', 'root-1');
    expect(reset.leaseId).not.toBe(running.leaseId);
    await client.releaseWorkspaceLease('alpha', 'root-1', reset.leaseId, reset.rootTargetId);
  });

  it('exposes persisted dialog state through the page status endpoint', async () => {
    globalThis.fetch = undiciFetch as unknown as typeof fetch;
    daemon = new CDPDaemon({ port: 0, cdpUrl: 'http://127.0.0.1:1' });
    await daemon.start();
    (daemon as any).sessions.set('page-with-dialog', {
      close: () => {},
      getDialogStatus: async () => ({
        open: true,
        dialog: { type: 'alert', message: 'Payment is blocked', url: 'https://example.test/' },
        observedAt: 123
      })
    });

    const client = new DaemonClient({ daemonUrl: `http://127.0.0.1:${daemon.listeningPort}` });
    await expect(client.getDialogStatus('page-with-dialog')).resolves.toEqual({
      open: true,
      dialog: { type: 'alert', message: 'Payment is blocked', url: 'https://example.test/' },
      observedAt: 123
    });
  });
});
