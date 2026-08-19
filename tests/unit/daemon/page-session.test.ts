import { describe, expect, it } from 'vitest';
import { PageSession } from '../../../src/daemon/page-session.js';

describe('PageSession network logging', () => {
  const sessionWithMessages = () => {
    const session = new PageSession({
      pageId: 'page-1',
      webSocketUrl: 'ws://example.test/devtools/page/page-1'
    });
    const send = (message: unknown) => {
      (session as any).handleMessage(Buffer.from(JSON.stringify(message)));
    };
    return { session, send };
  };

  it('keeps the persistent buffer current as response and completion events arrive', async () => {
    const { session, send } = sessionWithMessages();

    send({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'request-1',
        timestamp: 123.456,
        type: 'Fetch',
        request: { url: 'https://example.test/api', method: 'POST', headers: { accept: 'application/json' } }
      }
    });
    send({
      method: 'Network.responseReceived',
      params: {
        requestId: 'request-1',
        type: 'Fetch',
        response: { url: 'https://example.test/api', status: 201, headers: { 'content-type': 'application/json' } }
      }
    });
    send({
      method: 'Network.loadingFinished',
      params: { requestId: 'request-1', encodedDataLength: 321 }
    });

    expect(session.getNetworkLogs()).toEqual([
      expect.objectContaining({
        id: 'request-1',
        status: 201,
        size: 321,
        responseHeaders: { 'content-type': 'application/json' }
      })
    ]);
  });

  it('records failed requests with structured cancellation and failure details', async () => {
    const { session, send } = sessionWithMessages();

    send({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'request-failed',
        timestamp: 1,
        type: 'Document',
        request: { url: 'https://example.test/canceled', method: 'GET', headers: {} }
      }
    });
    send({
      method: 'Network.loadingFailed',
      params: {
        requestId: 'request-failed',
        errorText: 'net::ERR_ABORTED',
        canceled: true,
        blockedReason: 'other'
      }
    });

    expect(session.getNetworkLogs()).toEqual([
      expect.objectContaining({
        id: 'request-failed',
        failure: {
          errorText: 'net::ERR_ABORTED',
          canceled: true,
          blockedReason: 'other'
        }
      })
    ]);
  });

  it('retains both redirect hops when Chrome reuses the request id', async () => {
    const { session, send } = sessionWithMessages();

    send({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'redirect-1',
        timestamp: 1,
        type: 'Document',
        request: { url: 'https://example.test/start', method: 'GET', headers: {} }
      }
    });
    send({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'redirect-1',
        timestamp: 2,
        type: 'Document',
        redirectResponse: { url: 'https://example.test/start', status: 302, headers: { location: '/next' } },
        request: { url: 'https://example.test/next', method: 'GET', headers: {} }
      }
    });
    send({
      method: 'Network.loadingFinished',
      params: { requestId: 'redirect-1', encodedDataLength: 99 }
    });

    expect(session.getNetworkLogs()).toEqual([
      expect.objectContaining({ url: 'https://example.test/start', status: 302 }),
      expect.objectContaining({ url: 'https://example.test/next', size: 99 })
    ]);
  });
});

describe('PageSession dialog state', () => {
  const sessionWithMessages = () => {
    const session = new PageSession({
      pageId: 'page-1',
      webSocketUrl: 'ws://example.test/devtools/page/page-1'
    });
    const send = (message: unknown) => {
      (session as any).handleMessage(Buffer.from(JSON.stringify(message)));
    };
    return { session, send };
  };

  it('retains a bounded, redacted opening event and clears it when Chrome closes the dialog', async () => {
    const { session, send } = sessionWithMessages();
    send({
      method: 'Page.javascriptDialogOpening',
      params: {
        type: 'prompt',
        message: `Open https://example.test/path?token=secret ${'x'.repeat(1_100)}`,
        url: 'https://app.example.test/checkout?session=secret',
        defaultPrompt: 'sensitive customer input'
      }
    });

    await expect(session.getDialogStatus()).resolves.toEqual(expect.objectContaining({
      open: true,
      dialog: expect.objectContaining({
        type: 'prompt',
        url: 'https://app.example.test/checkout?session=%5BREDACTED%5D'
      })
    }));
    const openStatus = await session.getDialogStatus();
    expect(openStatus.dialog?.message).toContain('token=%5BREDACTED%5D');
    expect(openStatus.dialog?.message.length).toBeLessThanOrEqual(1_000);
    expect(openStatus.dialog).not.toHaveProperty('defaultPrompt');

    send({ method: 'Page.javascriptDialogClosed', params: {} });
    await expect(session.getDialogStatus()).resolves.toEqual({ open: false });
  });
});
