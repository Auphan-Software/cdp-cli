/**
 * Regression: a page that cannot be registered must not leak its socket.
 *
 * The daemon's health check re-registers every page that is not in `sessions`
 * every 5 seconds, and a page whose registration FAILED is by definition never
 * in `sessions`. So one un-registerable page used to open one ESTABLISHED
 * connection to the debugging port every 5 seconds, without bound, until the
 * machine ran out of ephemeral ports and Chrome had to be killed.
 *
 * The invariant is counted on the SERVER side of a stand-in debugging endpoint,
 * which is the same thing `Get-NetTCPConnection -LocalPort <port> -State
 * Established` counts against Chrome: live connections must not grow with the
 * number of attempts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { PageSession } from '../../src/daemon/page-session.js';

// `tests/setup.ts` replaces `ws` with an in-memory double for the whole suite.
// This file is about real sockets - a double cannot leak a file descriptor -
// so it opts back in to the real module.
vi.mock('ws', async () => await vi.importActual('ws'));

const ATTEMPTS = 25;

describe('daemon page registration socket accounting', () => {
  let server: WebSocketServer;
  let url: string;
  const live = new Set<ServerSocket>();

  beforeAll(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket) => {
      live.add(socket);
      socket.on('close', () => live.delete(socket));
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { id?: number; method?: string };
        if (typeof message.id !== 'number') return;
        // Stand in for a renderer that cannot service the logging domains.
        // Failing fast keeps the test deterministic; a wedged renderer reaches
        // the same reject through `sendCommand`'s timeout instead.
        socket.send(JSON.stringify({
          id: message.id,
          error: { code: -32000, message: `renderer cannot service ${message.method}` }
        }));
      });
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    url = `ws://127.0.0.1:${address.port}/devtools/page/stand-in`;
  });

  afterAll(async () => {
    for (const socket of live) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it(`does not grow live connections across ${ATTEMPTS} failed registrations`, async () => {
    // Registration genuinely fails, once, so the count below is measuring the
    // leak and not a silently-successful path.
    const probe = new PageSession({ pageId: 'page-probe', webSocketUrl: url });
    await expect(probe.connect()).rejects.toThrow();

    const afterFirst = await settledLiveCount(live);

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const session = new PageSession({ pageId: `page-${attempt}`, webSocketUrl: url });
      await expect(session.connect()).rejects.toThrow();
    }

    const afterMany = await settledLiveCount(live);

    // The real assertion: N attempts, no growth. Before the fix this reported
    // { afterFirst: 1, afterMany: 26 }; after it, { 0, 0 }. Asserted as one
    // object so a failure prints both numbers instead of stopping at the first.
    expect({ afterFirst, afterMany }).toEqual({ afterFirst: 0, afterMany: 0 });
  });

  it('closes the socket of a successfully connected session on close()', async () => {
    const quiet = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const quietLive = new Set<ServerSocket>();
    quiet.on('connection', (socket) => {
      quietLive.add(socket);
      socket.on('close', () => quietLive.delete(socket));
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { id?: number };
        if (typeof message.id === 'number') {
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        }
      });
    });
    await new Promise<void>((resolve) => quiet.once('listening', resolve));
    const address = quiet.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');

    try {
      const session = new PageSession({
        pageId: 'page-ok',
        webSocketUrl: `ws://127.0.0.1:${address.port}/devtools/page/page-ok`
      });
      await session.connect();
      expect(await settledLiveCount(quietLive, 1)).toBe(1);
      session.close();
      expect(await settledLiveCount(quietLive)).toBe(0);
    } finally {
      for (const socket of quietLive) socket.terminate();
      await new Promise<void>((resolve) => quiet.close(() => resolve()));
    }
  });
});

/**
 * Socket teardown is observed by the server asynchronously, so poll for the
 * expected count rather than sampling once. Returns the last count seen, so a
 * failure reports the real number instead of timing out.
 */
async function settledLiveCount(
  live: ReadonlySet<ServerSocket>,
  expected = 0,
  timeoutMs = 3_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (live.size === expected || Date.now() >= deadline) return live.size;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
