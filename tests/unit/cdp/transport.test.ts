import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  CDPCommandError,
  FlattenedSessionTransport,
  type CDPSocket
} from '../../../src/cdp/transport.js';

class TranscriptSocket extends EventEmitter implements CDPSocket {
  readonly readyState = 1;
  readonly sent: any[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.emit('close');
  }
}

describe('FlattenedSessionTransport', () => {
  it('correlates interleaved browser and flattened-session responses', async () => {
    const socket = new TranscriptSocket();
    const transport = new FlattenedSessionTransport(socket, 500);

    const browserResult = transport.send('Target.getTargets');
    const childResult = transport.send('Runtime.evaluate', { expression: '1' }, 'session-child');

    expect(socket.sent).toEqual([
      { id: 1, method: 'Target.getTargets', params: {} },
      {
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: '1' },
        sessionId: 'session-child'
      }
    ]);

    socket.emit('message', Buffer.from(JSON.stringify({ id: 2, result: { value: 'child' } })));
    socket.emit('message', Buffer.from(JSON.stringify({ id: 1, result: { value: 'browser' } })));
    await expect(childResult).resolves.toEqual({ value: 'child' });
    await expect(browserResult).resolves.toEqual({ value: 'browser' });
    transport.close();
  });

  it('preserves the emitting session on flattened events', () => {
    const socket = new TranscriptSocket();
    const transport = new FlattenedSessionTransport(socket);
    const events: any[] = [];
    transport.onEvent((event) => events.push(event));

    socket.emit('message', Buffer.from(JSON.stringify({
      method: 'Target.attachedToTarget',
      sessionId: 'parent-session',
      params: { sessionId: 'child-session', targetInfo: { targetId: 'child' } }
    })));

    expect(events).toEqual([{
      method: 'Target.attachedToTarget',
      sessionId: 'parent-session',
      params: { sessionId: 'child-session', targetInfo: { targetId: 'child' } }
    }]);
    transport.close();
  });

  it('reports protocol errors without echoing command parameters', async () => {
    const socket = new TranscriptSocket();
    const transport = new FlattenedSessionTransport(socket);
    const result = transport.send('Runtime.evaluate', {
      expression: 'secret-card-number'
    }, 'session-child');

    socket.emit('message', Buffer.from(JSON.stringify({
      id: 1,
      error: { code: -32000, message: 'context disappeared' }
    })));

    await expect(result).rejects.toMatchObject({
      name: 'CDPCommandError',
      method: 'Runtime.evaluate',
      code: -32000
    } satisfies Partial<CDPCommandError>);
    await expect(result).rejects.not.toThrow('secret-card-number');
    transport.close();
  });
});
