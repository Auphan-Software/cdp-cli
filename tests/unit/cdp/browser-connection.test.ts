import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { BrowserConnection } from '../../../src/cdp/browser-connection.js';
import type { CDPSocket } from '../../../src/cdp/transport.js';

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/fake-instance';

interface FakeTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/**
 * A scriptable stand-in for Chrome's browser WebSocket.
 *
 * Per-session behaviour is switchable at runtime so a test can make one
 * renderer busy (no reply at all, which is what a blocked main thread looks
 * like on the wire) and later let it answer normally.
 */
class FakeChromeSocket extends EventEmitter implements CDPSocket {
  readonly readyState = 1;
  readonly sent: Array<{ id: number; method: string; params: any; sessionId?: string }> = [];
  readonly targets: FakeTarget[] = [];

  /** Session ids whose Page.enable never answers. */
  readonly hangingSessions = new Set<string>();
  /** Session ids whose Page.enable answers with a protocol error. */
  readonly deadSessions = new Map<string, string>();

  private nextSession = 1;
  private readonly sessionByTarget = new Map<string, string>();

  addTarget(targetId: string, type = 'page'): FakeTarget {
    const target = { targetId, type, title: targetId, url: `https://example.test/${targetId}` };
    this.targets.push(target);
    return target;
  }

  /** Session id Chrome handed out for a target, once attached. */
  sessionFor(targetId: string): string | undefined {
    return this.sessionByTarget.get(targetId);
  }

  /** Count of a session-scoped method actually put on the wire. */
  countSent(method: string, sessionId?: string): number {
    return this.sent.filter(
      (msg) => msg.method === method && (sessionId === undefined || msg.sessionId === sessionId)
    ).length;
  }

  /** Simulate Chrome attaching a target on its own, after the connection opened. */
  attachExistingTarget(targetId: string): string {
    const target = this.targets.find((candidate) => candidate.targetId === targetId);
    if (!target) throw new Error(`test setup: no such fake target ${targetId}`);
    const sessionId = this.openSession(targetId);
    this.emitEvent({
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: target, waitingForDebugger: false }
    });
    return sessionId;
  }

  detachSession(sessionId: string): void {
    for (const [targetId, candidate] of this.sessionByTarget) {
      if (candidate === sessionId) this.sessionByTarget.delete(targetId);
    }
    this.emitEvent({ method: 'Target.detachedFromTarget', params: { sessionId } });
  }

  send(data: string): void {
    const message = JSON.parse(data);
    this.sent.push(message);
    queueMicrotask(() => this.respond(message));
  }

  close(): void {
    this.emit('close');
  }

  private openSession(targetId: string): string {
    const sessionId = `session-${this.nextSession++}`;
    this.sessionByTarget.set(targetId, sessionId);
    return sessionId;
  }

  private emitEvent(payload: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  private reply(id: number, result: Record<string, unknown>): void {
    this.emitEvent({ id, result });
  }

  private replyError(id: number, message: string): void {
    this.emitEvent({ id, error: { code: -32000, message } });
  }

  private respond(message: { id: number; method: string; params: any; sessionId?: string }): void {
    const { id, method, sessionId } = message;

    if (sessionId) {
      if (method === 'Page.enable') {
        if (this.hangingSessions.has(sessionId)) return; // busy renderer: no reply at all
        const dead = this.deadSessions.get(sessionId);
        if (dead) {
          this.replyError(id, dead);
          return;
        }
      }
      this.reply(id, {});
      return;
    }

    switch (method) {
      case 'Target.setDiscoverTargets':
      case 'Target.setAutoAttach':
        this.reply(id, {});
        return;
      case 'Target.getTargets':
        this.reply(id, { targetInfos: this.targets });
        return;
      case 'Target.attachToTarget': {
        const targetId = message.params?.targetId as string;
        const existing = this.sessionByTarget.get(targetId);
        if (existing) {
          this.reply(id, { sessionId: existing });
          return;
        }
        const target = this.targets.find((candidate) => candidate.targetId === targetId);
        const newSession = this.openSession(targetId);
        if (target) {
          this.emitEvent({
            method: 'Target.attachedToTarget',
            params: { sessionId: newSession, targetInfo: target, waitingForDebugger: false }
          });
        }
        this.reply(id, { sessionId: newSession });
        return;
      }
      default:
        this.reply(id, {});
    }
  }
}

function fakeFetch() {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ webSocketDebuggerUrl: BROWSER_WS })
  });
}

async function openConnection(
  socket: FakeChromeSocket,
  commandTimeoutMs = 40
): Promise<BrowserConnection> {
  return BrowserConnection.open('http://127.0.0.1:9222', {
    socketFactory: () => socket,
    fetch: fakeFetch() as any,
    commandTimeoutMs,
    connectTimeoutMs: 200
  });
}

describe('BrowserConnection session configuration', () => {
  it('retries configuration after a busy renderer timed one out', async () => {
    const socket = new FakeChromeSocket();
    socket.addTarget('page-idle');
    const connection = await openConnection(socket);

    // A target Chrome attaches after open, whose renderer is blocked.
    socket.addTarget('page-busy');
    const busySession = socket.attachExistingTarget('page-busy');
    socket.hangingSessions.add(busySession);

    // The attach-driven configuration must fail while the renderer is blocked.
    await expect(connection.sendToTarget('page-busy', 'Runtime.evaluate'))
      .rejects.toThrow(/CDP command timed out: Page\.enable/);
    expect(socket.countSent('Page.enable', busySession)).toBeGreaterThan(0); // sentinel

    // The renderer recovers. The next operation must re-send the configuration
    // instead of rethrowing the cached rejection forever.
    socket.hangingSessions.delete(busySession);
    const before = socket.countSent('Page.enable', busySession);
    await expect(connection.sendToTarget('page-busy', 'Runtime.evaluate')).resolves.toBeDefined();
    expect(socket.countSent('Page.enable', busySession)).toBe(before + 1);

    connection.close();
  });

  it('opens the browser connection even when one renderer is blocked', async () => {
    const socket = new FakeChromeSocket();
    socket.addTarget('page-busy');
    socket.addTarget('page-idle');
    // Chrome hands out session-1 to the first target it is asked to attach.
    socket.hangingSessions.add('session-1');

    const connection = await openConnection(socket);
    expect(socket.sessionFor('page-busy')).toBe('session-1'); // sentinel: the blocked one

    // A healthy sibling target is still usable.
    await expect(connection.sendToTarget('page-idle', 'Runtime.evaluate')).resolves.toBeDefined();
    connection.close();
  });

  it('shares one in-flight configuration between concurrent callers', async () => {
    const socket = new FakeChromeSocket();
    socket.addTarget('page-a');
    const connection = await openConnection(socket);
    const session = socket.sessionFor('page-a')!;
    const enablesAfterOpen = socket.countSent('Page.enable', session);

    await Promise.all([
      connection.ensureTargetSession('page-a'),
      connection.ensureTargetSession('page-a'),
      connection.ensureTargetSession('page-a')
    ]);

    expect(socket.countSent('Page.enable', session)).toBe(enablesAfterOpen);
    expect(enablesAfterOpen).toBe(1); // sentinel: configuration really ran once
    connection.close();
  });

  it('makes exactly one configuration attempt per operation on a dead target', async () => {
    const socket = new FakeChromeSocket();
    socket.addTarget('page-live');
    const connection = await openConnection(socket);

    socket.addTarget('page-dead');
    const deadSession = socket.attachExistingTarget('page-dead');
    socket.deadSessions.set(deadSession, 'Target closed');

    const before = socket.countSent('Page.enable', deadSession);
    await expect(connection.sendToTarget('page-dead', 'Runtime.evaluate'))
      .rejects.toThrow(/Target closed/);
    const afterFirst = socket.countSent('Page.enable', deadSession);
    expect(afterFirst).toBeGreaterThan(before); // sentinel

    await expect(connection.sendToTarget('page-dead', 'Runtime.evaluate'))
      .rejects.toThrow(/Target closed/);
    expect(socket.countSent('Page.enable', deadSession)).toBe(afterFirst + 1);

    connection.close();
  });

  it('re-configures a session after a real detach and re-attach', async () => {
    const socket = new FakeChromeSocket();
    socket.addTarget('page-a');
    const connection = await openConnection(socket);
    const firstSession = socket.sessionFor('page-a')!;

    socket.detachSession(firstSession);
    await connection.refreshTargets();

    await expect(connection.sendToTarget('page-a', 'Runtime.evaluate')).resolves.toBeDefined();
    const secondSession = socket.sessionFor('page-a')!;
    expect(secondSession).not.toBe(firstSession); // sentinel: a genuinely new session
    expect(socket.countSent('Page.enable', secondSession)).toBe(1);

    connection.close();
  });
});
