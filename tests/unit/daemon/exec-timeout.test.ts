import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { CDPDaemon } from '../../../src/daemon/daemon.js';
import { DaemonClient } from '../../../src/daemon/client.js';
import { CDPContext, type Page } from '../../../src/context.js';
import { createExecSessionByPageRef } from '../../../src/daemon/exec.js';
import { CommandTimeoutError } from '../../../src/cdp/command-timeout.js';
import { WebSocket } from 'ws';

const originalFetch = globalThis.fetch;
let daemon: CDPDaemon | undefined;

afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

interface FakeSessionCall {
  method: string;
  params: any;
  /** Distinguishes "no timeout argument" from an explicit value. */
  args: number;
  timeoutMs?: number;
}

/**
 * A stand-in for a connected PageSession. It records the exact arity of every
 * sendCommand call so a test can prove the route passed nothing (and therefore
 * left PageSession's own 10s default in force) rather than passing undefined.
 */
function fakeSession(behaviour: (method: string) => any = () => ({ ok: true })) {
  const calls: FakeSessionCall[] = [];
  return {
    calls,
    isConnected: true,
    close() { /* the daemon closes every session on stop */ },
    sendCommand(method: string, params?: any, timeoutMs?: number) {
      calls.push({ method, params, args: arguments.length, timeoutMs });
      try {
        return Promise.resolve(behaviour(method));
      } catch (error) {
        return Promise.reject(error);
      }
    }
  };
}

async function startDaemonWithSession(
  pageId: string,
  session: ReturnType<typeof fakeSession>
): Promise<DaemonClient> {
  globalThis.fetch = undiciFetch as unknown as typeof fetch;
  daemon = new CDPDaemon({ port: 0, cdpUrl: 'http://127.0.0.1:1' });
  await daemon.start();
  (daemon as any).sessions.set(pageId, session);
  return new DaemonClient({ daemonUrl: `http://127.0.0.1:${daemon.listeningPort}` });
}

describe('daemon /exec round-trip timeout', () => {
  it('forwards an explicit timeout and omits the argument entirely without one', async () => {
    const session = fakeSession();
    const client = await startDaemonWithSession('page-1', session);

    await expect(client.execCommand('page-1', 'Runtime.evaluate', { expression: '1' }, undefined, 30_000))
      .resolves.toEqual({ ok: true });
    await expect(client.execCommand('page-1', 'Runtime.evaluate', { expression: '1' }))
      .resolves.toEqual({ ok: true });

    expect(session.calls).toHaveLength(2); // sentinel: the route really ran
    expect(session.calls[0]).toMatchObject({ method: 'Runtime.evaluate', timeoutMs: 30_000, args: 3 });
    // Two arguments means PageSession's own 10000 default is what applies.
    expect(session.calls[1].args).toBe(2);
    expect(session.calls[1].timeoutMs).toBeUndefined();
  });

  it('refuses an invalid timeout instead of silently falling back to the default', async () => {
    const session = fakeSession();
    const client = await startDaemonWithSession('page-1', session);

    for (const bad of [0, -1, 1.5, 600_001]) {
      await expect(
        client.execCommand('page-1', 'Runtime.evaluate', {}, undefined, bad)
      ).rejects.toThrow(/--timeout must be a whole number of milliseconds/);
    }

    expect(session.calls).toHaveLength(0); // the command never reached the page
  });

  it('reports a timed-out command as a typed timeout, not a generic command failure', async () => {
    const session = fakeSession((method) => {
      throw new CommandTimeoutError(method, 2_500);
    });
    const client = await startDaemonWithSession('page-1', session);

    const failure = await client
      .execCommand('page-1', 'Runtime.evaluate', {}, undefined, 2_500)
      .then(() => undefined, (error: unknown) => error);

    expect(session.calls).toHaveLength(1); // sentinel
    expect(failure).toBeInstanceOf(CommandTimeoutError);
    expect(failure).toMatchObject({
      method: 'Runtime.evaluate',
      timeoutMs: 2_500,
      message: 'Command timeout: Runtime.evaluate'
    });
  });

  it('still reports a non-timeout daemon failure the old way', async () => {
    const session = fakeSession((method) => {
      throw new Error(`Some other failure in ${method}`);
    });
    const client = await startDaemonWithSession('page-1', session);

    const failure = await client
      .execCommand('page-1', 'Runtime.evaluate', {})
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CommandTimeoutError);
    expect((failure as Error).message).toBe('Some other failure in Runtime.evaluate');
  });
});

describe('default round-trip caps', () => {
  /** A socket that accepts commands and never answers any of them. */
  function silentSocket() {
    const handlers = new Set<(data: Buffer) => void>();
    return {
      // Match whatever the module under test compares against; the suite
      // replaces `ws` globally, so a hard-coded 1 would read as disconnected.
      readyState: (WebSocket as any).OPEN,
      send: () => undefined,
      close: () => undefined,
      on: (_event: string, handler: any) => handlers.add(handler),
      off: (_event: string, handler: any) => handlers.delete(handler)
    } as any;
  }

  it('keeps the direct path at 30000ms', async () => {
    vi.useFakeTimers();
    try {
      const failure = new CDPContext()
        .sendCommand(silentSocket(), 'Runtime.evaluate', {})
        .then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(29_999);
      // Still pending one millisecond short of the documented default.
      await vi.advanceTimersByTimeAsync(1);
      const error = await failure;
      expect(error).toBeInstanceOf(CommandTimeoutError);
      expect((error as CommandTimeoutError).timeoutMs).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the daemon page-session path at 10000ms', async () => {
    const { PageSession } = await import('../../../src/daemon/page-session.js');
    vi.useFakeTimers();
    try {
      const session = new PageSession({
        pageId: 'page-1',
        webSocketUrl: 'ws://example.test/devtools/page/page-1'
      });
      (session as any).ws = silentSocket();
      const failure = session
        .sendCommand('Runtime.evaluate', {})
        .then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await failure;
      expect(error).toBeInstanceOf(CommandTimeoutError);
      expect((error as CommandTimeoutError).timeoutMs).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ExecSession timeout routing', () => {
  const page: Page = {
    id: 'page-1',
    title: 'Example',
    url: 'https://example.test/',
    type: 'page',
    webSocketDebuggerUrl: 'ws://example.test/devtools/page/page-1'
  };

  it('passes the timeout through the daemon path', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([{
      pageId: 'page-1', connected: true, consoleLogs: 0, networkLogs: 0
    }]);
    const exec = vi.spyOn(DaemonClient.prototype, 'execCommand').mockResolvedValue({ ok: true });

    const session = await createExecSessionByPageRef(new CDPContext(), 'page-1');
    expect(session.useDaemon).toBe(true); // sentinel: this really is the daemon path

    await session.exec('Runtime.evaluate', { expression: '1' }, 45_000);
    await session.exec('Runtime.evaluate', { expression: '1' });

    expect(exec).toHaveBeenNthCalledWith(1, 'page-1', 'Runtime.evaluate', { expression: '1' }, undefined, 45_000);
    expect(exec).toHaveBeenNthCalledWith(2, 'page-1', 'Runtime.evaluate', { expression: '1' }, undefined, undefined);
    await session.close();
  });

  it('passes the timeout through the direct path', async () => {
    vi.spyOn(DaemonClient.prototype, 'listSessions').mockResolvedValue([]);
    const context = new CDPContext();
    vi.spyOn(context, 'findPage').mockResolvedValue(page);
    vi.spyOn(context, 'connect').mockResolvedValue({ close: () => undefined } as any);
    const send = vi.spyOn(context, 'sendCommand').mockResolvedValue({ ok: true });

    const session = await createExecSessionByPageRef(context, 'page-1');
    expect(session.useDaemon).toBe(false); // sentinel: this really is the direct path

    await session.exec('Runtime.evaluate', { expression: '1' }, 45_000);
    await session.exec('Runtime.evaluate', { expression: '1' });

    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), 'Runtime.evaluate', { expression: '1' }, 45_000);
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), 'Runtime.evaluate', { expression: '1' }, undefined);
    await session.close();
  });
});
