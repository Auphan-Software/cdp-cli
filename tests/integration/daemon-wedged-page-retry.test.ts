/**
 * Regression: a page the daemon cannot register must not cost a socket per
 * health-check tick, and must not be retried forever in silence.
 *
 * This drives the real `CDPDaemon` against a stand-in browser whose page
 * endpoint accepts the WebSocket but cannot complete `enableLogging()`. The
 * daemon runs its own health check, unmodified in shape - only its period is
 * shortened, so >= 20 REAL ticks fit in a test.
 *
 * Two invariants:
 *  - live connections to the debugging endpoint stay BOUNDED across the ticks
 *    (bounded, not constant: a backed-off retry may legitimately hold one
 *    while it is in flight). Before the fix this grew one per tick.
 *  - the daemon stops retrying and SAYS SO. A silent give-up is just a
 *    quieter version of the same defect.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { fetch as undiciFetch } from 'undici';
import { CDPDaemon } from '../../src/daemon/daemon.js';

// `tests/setup.ts` doubles `ws` and `fetch` for the whole suite. This file is
// about real sockets against a real local server, so it opts back in to both.
vi.mock('ws', async () => await vi.importActual('ws'));

const TICKS = 22;
const TICK_MS = 60;
const MAX_ATTEMPTS = 5;
/**
 * A backed-off retry may be in flight while we sample, and the browser-level
 * discovery socket is a legitimate long-lived connection. Anything beyond a
 * handful means per-tick accumulation, which is the defect.
 */
const BOUNDED = 4;

describe('daemon retries for a page that cannot be registered', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it(`keeps live connections bounded across ${TICKS} health-check ticks and abandons the page`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
    cleanups.push(() => { globalThis.fetch = realFetch; });

    const browser = await startStandInBrowser();
    cleanups.push(() => browser.stop());

    const daemon = new CDPDaemon({
      port: 0,
      cdpUrl: browser.httpUrl,
      healthCheckIntervalMs: TICK_MS,
      // Keep the backoff inside the test window; the shape is what matters,
      // not the production constants.
      registrationBaseDelayMs: 10,
      registrationMaxDelayMs: 40,
      registrationMaxAttempts: MAX_ATTEMPTS
    });
    await daemon.start();
    cleanups.push(() => daemon.stop());

    let peakLive = 0;
    for (let tick = 0; tick < TICKS; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      peakLive = Math.max(peakLive, browser.liveConnections());
    }

    const abandoned = daemon.unregisterablePages.filter((page) => page.gaveUp);

    expect({
      peakLive: peakLive <= BOUNDED,
      attemptsMade: browser.pageConnectionAttempts >= MAX_ATTEMPTS,
      // The give-up must be bounded by the policy, not by the tick count:
      // 22 ticks with no give-up would mean it retried on every one.
      attemptsStopped: browser.pageConnectionAttempts <= MAX_ATTEMPTS,
      abandonedPageIds: abandoned.map((page) => page.pageId),
      abandonedAttempts: abandoned.map((page) => page.attempts),
      reasonRecorded: abandoned.every((page) => page.reason.length > 0),
      noNextAttempt: abandoned.every((page) => page.nextAttemptAt === null)
    }).toEqual({
      peakLive: true,
      attemptsMade: true,
      attemptsStopped: true,
      abandonedPageIds: ['wedged-page'],
      abandonedAttempts: [MAX_ATTEMPTS],
      reasonRecorded: true,
      noNextAttempt: true
    });

    // And it is visible to whoever asks the daemon, not just internally.
    const health = await undiciFetch(`http://127.0.0.1:${daemon.listeningPort}/health`);
    expect(await health.json()).toMatchObject({ unregisterablePages: 1, abandonedPages: 1 });

    const listed = await undiciFetch(`http://127.0.0.1:${daemon.listeningPort}/sessions`);
    const body = await listed.json() as { unregisterable: Array<{ pageId: string; gaveUp: boolean }> };
    expect(body.unregisterable).toEqual([
      expect.objectContaining({ pageId: 'wedged-page', gaveUp: true })
    ]);
  }, 20_000);
});

/**
 * A stand-in for Chrome's debugging endpoint: it publishes one page, accepts
 * that page's WebSocket, and answers every command with an error, so
 * `enableLogging()` cannot complete. A never-answering endpoint reaches the
 * same reject through `sendCommand`'s 10s timeout; failing fast keeps the
 * test deterministic and quick.
 */
async function startStandInBrowser(): Promise<{
  httpUrl: string;
  liveConnections(): number;
  readonly pageConnectionAttempts: number;
  stop(): Promise<void>;
}> {
  const live = new Set<ServerSocket>();
  let pageConnectionAttempts = 0;

  const http: Server = createServer((req, res) => {
    const port = (http.address() as { port: number }).port;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/version') {
      res.end(JSON.stringify({
        Browser: 'StandIn/1.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/stand-in`
      }));
      return;
    }
    if (req.url === '/json') {
      res.end(JSON.stringify([{
        id: 'wedged-page',
        type: 'page',
        title: 'wedged',
        url: 'about:blank',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/wedged-page`
      }]));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  const ws = new WebSocketServer({ server: http });
  ws.on('connection', (socket, request) => {
    const isPage = (request.url ?? '').includes('/devtools/page/');
    if (isPage) pageConnectionAttempts += 1;
    live.add(socket);
    socket.on('close', () => live.delete(socket));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string };
      if (typeof message.id !== 'number') return;
      if (!isPage) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
        return;
      }
      socket.send(JSON.stringify({
        id: message.id,
        error: { code: -32000, message: `renderer is wedged; cannot service ${message.method}` }
      }));
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;

  return {
    httpUrl: `http://127.0.0.1:${port}`,
    liveConnections: () => live.size,
    get pageConnectionAttempts() { return pageConnectionAttempts; },
    stop: async () => {
      for (const socket of live) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}
