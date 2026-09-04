import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { CDPDaemon } from '../../../src/daemon/daemon.js';
import { DaemonClient, resolveDaemonUrl } from '../../../src/daemon/client.js';
import { SessionFoundationError } from '../../../src/sessions/errors.js';

const originalFetch = globalThis.fetch;
const originalDaemonUrl = process.env.CDP_DAEMON_URL;
let daemon: CDPDaemon | undefined;

beforeEach(() => {
  delete process.env.CDP_DAEMON_URL;
});

afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
  globalThis.fetch = originalFetch;
  if (originalDaemonUrl === undefined) {
    delete process.env.CDP_DAEMON_URL;
  } else {
    process.env.CDP_DAEMON_URL = originalDaemonUrl;
  }
});

describe('resolveDaemonUrl', () => {
  it('uses the default daemon only for the default Chrome endpoint', () => {
    expect(resolveDaemonUrl({})).toBe('http://127.0.0.1:9223');
    expect(resolveDaemonUrl({ cdpUrl: 'http://localhost:9222' })).toBe('http://127.0.0.1:9223');
    expect(resolveDaemonUrl({ cdpUrl: 'http://127.0.0.1:9222/' })).toBe('http://127.0.0.1:9223');
  });

  it('prefers an explicit daemon URL, then CDP_DAEMON_URL', () => {
    process.env.CDP_DAEMON_URL = 'http://127.0.0.1:9334';
    expect(resolveDaemonUrl({
      daemonUrl: 'http://127.0.0.1:9444',
      cdpUrl: 'http://127.0.0.1:9333'
    })).toBe('http://127.0.0.1:9444');
    expect(resolveDaemonUrl({ cdpUrl: 'http://127.0.0.1:9333' })).toBe('http://127.0.0.1:9334');
  });

  it('refuses to guess the default daemon for a custom Chrome endpoint', () => {
    expect(() => resolveDaemonUrl({ cdpUrl: 'http://127.0.0.1:9333' })).toThrowError(
      expect.objectContaining({
        code: 'DAEMON_URL_REQUIRED',
        details: expect.objectContaining({
          cdpUrl: 'http://127.0.0.1:9333',
          defaultCdpUrl: 'http://localhost:9222',
          defaultDaemonUrl: 'http://127.0.0.1:9223',
          environmentVariable: 'CDP_DAEMON_URL'
        })
      })
    );
  });

  it('treats a blank CDP_DAEMON_URL as unset', () => {
    process.env.CDP_DAEMON_URL = '   ';
    expect(() => resolveDaemonUrl({ cdpUrl: 'http://127.0.0.1:9333' })).toThrow(SessionFoundationError);
    expect(resolveDaemonUrl({ cdpUrl: 'http://localhost:9222' })).toBe('http://127.0.0.1:9223');
  });
});

describe('DaemonClient daemon configuration guard', () => {
  it('fails every request, including health probes, before contacting any daemon', async () => {
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return { ok: true, json: async () => ({ status: 'ok', sessions: 0 }) };
    }) as unknown as typeof fetch;

    const client = new DaemonClient({ cdpUrl: 'http://127.0.0.1:9333' });
    await expect(client.isRunning()).rejects.toMatchObject({ code: 'DAEMON_URL_REQUIRED' });
    await expect(client.getStatus()).rejects.toMatchObject({ code: 'DAEMON_URL_REQUIRED' });
    await expect(client.listSessions()).rejects.toMatchObject({ code: 'DAEMON_URL_REQUIRED' });
    await expect(client.startDaemon({ cdpUrl: 'http://127.0.0.1:9333' })).rejects.toMatchObject({
      code: 'DAEMON_URL_REQUIRED'
    });
    await expect(client.acquireWorkspaceLease('agent', 'page-1')).rejects.toMatchObject({
      code: 'DAEMON_URL_REQUIRED'
    });
    expect(fetched).toBe(0);
  });

  it('still reports a stopped daemon as not running when the configuration is explicit', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = new DaemonClient({
      daemonUrl: 'http://127.0.0.1:9334',
      cdpUrl: 'http://127.0.0.1:9333'
    });
    await expect(client.isRunning()).resolves.toBe(false);
  });
});

describe('daemon workspace access diagnostics', () => {
  async function startDaemon(
    resolver: (sessionName: string, pageId: string) => Promise<string>
  ): Promise<DaemonClient> {
    globalThis.fetch = undiciFetch as unknown as typeof fetch;
    daemon = new CDPDaemon({
      port: 0,
      cdpUrl: 'http://127.0.0.1:1',
      workspaceRootResolver: resolver
    });
    await daemon.start();
    return new DaemonClient({ daemonUrl: `http://127.0.0.1:${daemon.listeningPort}` });
  }

  it('distinguishes an unknown session from a page owned by another session', async () => {
    const client = await startDaemon(async (sessionName, pageId) => {
      if (sessionName !== 'alpha') {
        throw new SessionFoundationError('SESSION_NOT_FOUND', `Session not found: ${sessionName}`, {
          sessionName
        });
      }
      throw new SessionFoundationError(
        'PAGE_NOT_OWNED',
        `Page ${pageId} is not owned by session ${sessionName}`,
        { sessionName, pageId, actualOwner: 'beta' }
      );
    });

    await expect(client.acquireWorkspaceLease('ghost', 'page-1')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      details: { sessionName: 'ghost' }
    });
    await expect(client.acquireWorkspaceLease('alpha', 'page-1')).rejects.toMatchObject({
      code: 'PAGE_NOT_OWNED',
      details: { sessionName: 'alpha', pageId: 'page-1', actualOwner: 'beta' }
    });
  });

describe('DaemonClient structured remote errors', () => {
  const sessionNotFound = {
    error: true,
    message: 'Session not found: ghost',
    code: 'SESSION_NOT_FOUND',
    details: { sessionName: 'ghost', pageId: 'p1' }
  };
  const serve = (status: number, body: unknown) => {
    globalThis.fetch = (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    })) as unknown as typeof fetch;
  };
  const expectSessionNotFound = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      message: 'Session not found: ghost',
      details: { sessionName: 'ghost', pageId: 'p1' }
    });

  it('keeps the daemon code and details on the log and batch endpoints', async () => {
    const client = new DaemonClient({ daemonUrl: 'http://127.0.0.1:9445' });
    serve(404, sessionNotFound);

    await expectSessionNotFound(client.getConsoleLogs('p1', { workspaceSession: 'ghost' }));
    await expectSessionNotFound(client.getNetworkLogs('p1', { workspaceSession: 'ghost' }));
    await expectSessionNotFound(client.getConsoleMessageDetail('p1', 1, 'ghost'));
    await expectSessionNotFound(client.clearLogs('p1', 'ghost'));
    await expectSessionNotFound(client.execBatch('p1', [{ method: 'Runtime.enable' }]));
    await expect(client.getConsoleLogs('p1')).rejects.toBeInstanceOf(SessionFoundationError);
  });

  it('still treats unstructured daemon answers the old way', async () => {
    const client = new DaemonClient({ daemonUrl: 'http://127.0.0.1:9445' });
    serve(404, { error: 'Message not found' });
    await expect(client.getConsoleMessageDetail('p1', 1)).resolves.toBeNull();
    await expect(client.clearLogs('p1')).resolves.toBe(false);
    await expect(client.getConsoleLogs('p1')).rejects.toThrow('Message not found');

    globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(client.clearLogs('p1')).resolves.toBe(false);
  });
});
});
