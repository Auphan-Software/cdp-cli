import { describe, expect, it } from 'vitest';
import { TargetRegistry } from '../../../src/cdp/target-registry.js';
import type { BrowserConnection } from '../../../src/cdp/browser-connection.js';
import {
  SessionStore,
  WorkspaceSessionService,
  type SessionFileSystem
} from '../../../src/sessions/index.js';

class MemoryFileSystem implements SessionFileSystem {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  }
  async mkdir(): Promise<void> {}
  async writeFile(path: string, data: string): Promise<void> { this.files.set(path, data); }
  async rename(from: string, to: string): Promise<void> {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  async unlink(path: string): Promise<void> { this.files.delete(path); }
}

function fakeBrowser(options: { failCreateTargetAt?: number } = {}) {
  const registry = new TargetRegistry();
  const methods: string[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let contextId = 0;
  let targetId = 0;
  const browser = {
    browserInstanceId: 'browser-1',
    registry,
    async refreshTargets() { return registry.list(); },
    async send(method: string, params: Record<string, unknown> = {}) {
      methods.push(method);
      calls.push({ method, params });
      if (method === 'Target.createTarget') {
        targetId += 1;
        if (targetId === options.failCreateTargetAt) {
          throw new Error('synthetic replacement failure');
        }
        const id = `page-${targetId}`;
        registry.upsertTarget({
          targetId: id,
          type: 'page',
          browserContextId: typeof params.browserContextId === 'string'
            ? params.browserContextId
            : undefined
        });
        return { targetId: id };
      }
      if (method === 'Target.createBrowserContext') {
        contextId += 1;
        return { browserContextId: `context-${contextId}` };
      }
      if (method === 'Target.disposeBrowserContext') {
        for (const target of registry.list()) {
          if (target.browserContextId === params.browserContextId) {
            registry.removeTarget(target.targetId);
          }
        }
      }
      return {};
    },
    async waitForTarget(predicate: (target: any) => boolean) {
      return registry.list().find(predicate);
    },
    close() {}
  };
  return { browser: browser as unknown as BrowserConnection, methods, calls };
}

describe('WorkspaceSessionService', () => {
  it('rejects adopting a target from a different browser context', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => String(fs.files.size)
    });
    const { browser } = fakeBrowser();
    const service = await WorkspaceSessionService.open('http://localhost:9222', {
      browser,
      store
    });
    await service.createSession('checkout');
    browser.registry.upsertTarget({ targetId: 'default-page', type: 'page' });

    await expect(service.adoptTarget('checkout', 'default-page')).rejects.toMatchObject({
      code: 'TARGET_CONTEXT_MISMATCH'
    });
    service.close();
  });

  it('removes shared-session metadata without disposing the default context', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => String(fs.files.size)
    });
    const { browser, methods } = fakeBrowser();
    const service = await WorkspaceSessionService.open('http://localhost:9222', {
      browser,
      store
    });
    const created = await service.createSession('legacy', { isolation: 'shared' });
    expect(created.browserContextId).toBeNull();

    const removed = await service.removeSession('legacy', { force: true });
    expect(removed.affectedPageIds).toEqual(['page-1']);
    expect(service.listSessions()).toEqual([]);
    expect(methods).not.toContain('Target.disposeBrowserContext');
    service.close();
  });

  it('resets only the named session, disposes its old context, and creates one replacement', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => String(fs.files.size)
    });
    const { browser, calls } = fakeBrowser();
    const service = await WorkspaceSessionService.open('http://localhost:9222', {
      browser,
      store
    });
    const resetBefore = await service.createSession('agent-1154');
    const untouched = await service.createSession('other-agent');

    const reset = await service.resetSession('agent-1154', { force: true });

    expect(reset.affectedPageIds).toEqual(['page-1']);
    expect(reset.session.name).toBe('agent-1154');
    expect(reset.replacement.name).toBe('agent-1154');
    expect(reset.replacement.browserContextId).not.toBe(resetBefore.browserContextId);
    expect(reset.pageId).toBe('page-3');
    expect(service.listSessions().map((session) => session.name).sort()).toEqual([
      'agent-1154',
      'other-agent'
    ]);
    expect(service.listSessions().find((session) => session.name === 'other-agent')).toEqual(untouched);
    expect(calls.filter((call) => call.method === 'Target.disposeBrowserContext')).toEqual([
      { method: 'Target.disposeBrowserContext', params: { browserContextId: 'context-1' } }
    ]);
    service.close();
  });

  it('refuses to reset a shared session because its owned pages cannot be disposed safely', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => String(fs.files.size)
    });
    const { browser } = fakeBrowser();
    const service = await WorkspaceSessionService.open('http://localhost:9222', {
      browser,
      store
    });
    await service.createSession('legacy', { isolation: 'shared' });

    await expect(service.resetSession('legacy', { force: true })).rejects.toMatchObject({
      code: 'SHARED_CONTEXT_DISPOSAL_FORBIDDEN'
    });
    expect(service.listSessions().map((session) => session.name)).toEqual(['legacy']);
    service.close();
  });

  it('reports an incomplete reset when the old context is gone but replacement creation fails', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => String(fs.files.size)
    });
    const { browser, calls } = fakeBrowser({ failCreateTargetAt: 2 });
    const service = await WorkspaceSessionService.open('http://localhost:9222', {
      browser,
      store
    });
    await service.createSession('agent-1154');

    await expect(service.resetSession('agent-1154', { force: true })).rejects.toMatchObject({
      code: 'SESSION_RESET_INCOMPLETE',
      details: {
        sessionName: 'agent-1154',
        affectedPageIds: ['page-1'],
        cause: 'Failed to create target'
      }
    });
    expect(service.listSessions()).toEqual([]);
    expect(calls.filter((call) => call.method === 'Target.disposeBrowserContext')).toEqual([
      { method: 'Target.disposeBrowserContext', params: { browserContextId: 'context-1' } },
      { method: 'Target.disposeBrowserContext', params: { browserContextId: 'context-2' } }
    ]);
    service.close();
  });
});
