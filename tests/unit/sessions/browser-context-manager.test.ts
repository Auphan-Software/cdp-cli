import { describe, expect, it } from 'vitest';
import {
  BROWSER_CONTEXT_BOUNDARY_NOTICE,
  BrowserContextManager,
  type BrowserContextProtocol,
  type TargetIdentity
} from '../../../src/sessions/index.js';

class FakeProtocol implements BrowserContextProtocol {
  createContextCalls = 0;
  createTargetCalls: Array<{ url: string; browserContextId?: string }> = [];
  disposeCalls: Array<{ browserContextId: string }> = [];
  targets: TargetIdentity[] = [];

  async createBrowserContext(): Promise<{ browserContextId: string }> {
    this.createContextCalls += 1;
    return { browserContextId: `context-${this.createContextCalls}` };
  }

  async createTarget(params: { url: string; browserContextId?: string }): Promise<{ targetId: string }> {
    this.createTargetCalls.push(params);
    return { targetId: `page-${this.createTargetCalls.length}` };
  }

  async disposeBrowserContext(params: { browserContextId: string }): Promise<void> {
    this.disposeCalls.push(params);
  }

  async getTargets(): Promise<readonly TargetIdentity[]> {
    return this.targets;
  }
}

describe('BrowserContextManager', () => {
  it('creates isolated contexts by default and places targets inside them', async () => {
    const protocol = new FakeProtocol();
    const manager = new BrowserContextManager(protocol);
    const metadata = await manager.createSessionContext('alpha');
    const pageId = await manager.createTarget('alpha', 'https://example.test');

    expect(metadata).toEqual({
      sessionName: 'alpha',
      browserContextId: 'context-1',
      isolation: 'isolated',
      pageIds: [],
      boundaryNotice: BROWSER_CONTEXT_BOUNDARY_NOTICE
    });
    expect(pageId).toBe('page-1');
    expect(protocol.createTargetCalls).toEqual([
      { url: 'https://example.test', browserContextId: 'context-1' }
    ]);
  });

  it('requires explicit shared compatibility mode and does not create a context', async () => {
    const protocol = new FakeProtocol();
    const manager = new BrowserContextManager(protocol);
    const metadata = await manager.createSessionContext('legacy', { isolation: 'shared' });
    await manager.createTarget('legacy');

    expect(protocol.createContextCalls).toBe(0);
    expect(metadata.isolation).toBe('shared');
    expect(metadata.browserContextId).toBeNull();
    expect(protocol.createTargetCalls).toEqual([{ url: 'about:blank' }]);
  });

  it('requires explicit disposal confirmation and returns every affected page ID', async () => {
    const protocol = new FakeProtocol();
    const manager = new BrowserContextManager(protocol);
    await manager.createSessionContext('alpha');
    await manager.createTarget('alpha');
    manager.registerPage('alpha', 'adopted-page');
    protocol.targets = [
      { targetId: 'protocol-page', browserContextId: 'context-1' },
      { targetId: 'other-page', browserContextId: 'context-other' }
    ];

    await expect(manager.disposeSessionContext('alpha', {})).rejects.toMatchObject({
      code: 'CONTEXT_DISPOSAL_NOT_CONFIRMED'
    });
    expect(protocol.disposeCalls).toEqual([]);

    await expect(manager.disposeSessionContext('alpha', { confirmed: true })).resolves.toEqual([
      'adopted-page',
      'page-1',
      'protocol-page'
    ]);
    expect(protocol.disposeCalls).toEqual([{ browserContextId: 'context-1' }]);
    expect(manager.getSessionContext('alpha')).toBeUndefined();
  });

  it('never lets one session dispose a shared compatibility context', async () => {
    const protocol = new FakeProtocol();
    const manager = new BrowserContextManager(protocol);
    await manager.createSessionContext('legacy', {
      isolation: 'shared',
      sharedContextId: 'shared-context'
    });

    await expect(manager.disposeSessionContext('legacy', { force: true })).rejects.toMatchObject({
      code: 'SHARED_CONTEXT_DISPOSAL_FORBIDDEN'
    });
    expect(protocol.disposeCalls).toEqual([]);
  });

  it('states that BrowserContext metadata is accident isolation, not security', async () => {
    const manager = new BrowserContextManager(new FakeProtocol());
    const context = await manager.createSessionContext('alpha');
    expect(context.boundaryNotice).toContain('not a security boundary');
  });
});

