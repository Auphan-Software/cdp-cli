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

function fakeBrowser() {
  const registry = new TargetRegistry();
  const methods: string[] = [];
  const browser = {
    browserInstanceId: 'browser-1',
    registry,
    async refreshTargets() { return registry.list(); },
    async send(method: string, params: Record<string, unknown> = {}) {
      methods.push(method);
      if (method === 'Target.createTarget') {
        registry.upsertTarget({
          targetId: 'page-1',
          type: 'page',
          browserContextId: typeof params.browserContextId === 'string'
            ? params.browserContextId
            : undefined
        });
        return { targetId: 'page-1' };
      }
      if (method === 'Target.createBrowserContext') return { browserContextId: 'context-1' };
      return {};
    },
    async waitForTarget(predicate: (target: any) => boolean) {
      return registry.list().find(predicate);
    },
    close() {}
  };
  return { browser: browser as unknown as BrowserConnection, methods };
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
});
