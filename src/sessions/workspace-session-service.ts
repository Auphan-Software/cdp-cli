import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserConnection } from '../cdp/browser-connection.js';
import type { TargetRecord } from '../cdp/target-registry.js';
import { BrowserContextManager, type BrowserContextProtocol } from './browser-context-manager.js';
import { OperationLeaseManager } from './operation-lease-manager.js';
import { SessionStore, type SessionStoreLock } from './session-store.js';
import type { SessionMetadata, SessionIsolation, TargetIdentity } from './types.js';
import { WorkspaceSessionRegistry, type PageAccessResult } from './workspace-session-registry.js';
import { SessionFoundationError } from './errors.js';

export interface WorkspaceSessionServiceOptions {
  storePath?: string;
  browser?: BrowserConnection;
  store?: SessionStore;
  registry?: WorkspaceSessionRegistry;
  leases?: OperationLeaseManager;
}

export interface CreateWorkspaceSessionOptions {
  isolation?: SessionIsolation;
  url?: string;
}

export interface RemoveWorkspaceSessionResult {
  session: SessionMetadata;
  affectedPageIds: string[];
}

export interface ResetWorkspaceSessionResult extends RemoveWorkspaceSessionResult {
  replacement: SessionMetadata;
  pageId: string;
}

/** Stateful orchestration over the strict session foundation and browser CDP. */
export class WorkspaceSessionService {
  readonly registry: WorkspaceSessionRegistry;
  readonly leases: OperationLeaseManager;
  private readonly contexts: BrowserContextManager;

  private constructor(
    private readonly browser: BrowserConnection,
    private readonly store: SessionStore,
    registry: WorkspaceSessionRegistry,
    leases: OperationLeaseManager,
    private readonly storeLock: SessionStoreLock
  ) {
    this.registry = registry;
    this.leases = leases;
    this.contexts = new BrowserContextManager(browserProtocol(browser));
  }

  static async open(
    cdpUrl: string,
    options: WorkspaceSessionServiceOptions = {}
  ): Promise<WorkspaceSessionService> {
    const browser = options.browser ?? await BrowserConnection.open(cdpUrl);
    const store = options.store ?? new SessionStore(
      options.storePath ?? defaultWorkspaceSessionStorePath(cdpUrl)
    );
    const registry = options.registry ?? new WorkspaceSessionRegistry();
    const leases = options.leases ?? new OperationLeaseManager();
    let storeLock: SessionStoreLock | undefined;
    try {
      storeLock = await store.acquireExclusiveLock();
      const document = await store.load(browser.browserInstanceId);
      await browser.refreshTargets();
      const result = registry.reconcile(document.sessions, identities(browser.registry.list()));
      const service = new WorkspaceSessionService(browser, store, registry, leases, storeLock);
      for (const session of registry.listSessions()) {
        service.contexts.restoreSessionContext(
          session.name,
          session.browserContextId,
          session.isolation,
          session.pageIds
        );
      }
      if (result.droppedPageIds.length > 0 || result.inheritedPageIds.length > 0) {
        await service.persist();
      }
      return service;
    } catch (error) {
      storeLock?.release();
      if (!options.browser) browser.close();
      throw error;
    }
  }

  get browserInstanceId(): string {
    return this.browser.browserInstanceId;
  }

  async refresh(): Promise<void> {
    await this.browser.refreshTargets();
    const inherited = this.registry.observeTargets(identities(this.browser.registry.list()));
    for (const pageId of inherited) {
      const owner = this.registry.getOwner(pageId);
      if (owner) this.contexts.registerPage(owner, pageId);
    }
    if (inherited.length > 0) await this.persist();
  }

  listSessions(): SessionMetadata[] {
    return this.registry.listSessions();
  }

  async createSession(
    name: string,
    options: CreateWorkspaceSessionOptions = {}
  ): Promise<SessionMetadata> {
    const isolation = options.isolation ?? 'isolated';
    const managed = await this.contexts.createSessionContext(name, { isolation });
    try {
      this.registry.createSession({
        name,
        browserInstanceId: this.browser.browserInstanceId,
        browserContextId: managed.browserContextId,
        isolation
      });
      const pageId = await this.contexts.createTarget(name, options.url ?? 'about:blank');
      const target = await this.browser.waitForTarget((candidate) => candidate.targetId === pageId, 2_000);
      if (!target) throw new Error(`Chrome did not publish created target: ${pageId}`);
      this.registry.adoptTarget(name, pageId, identities(this.browser.registry.list()));
      await this.persist();
      return this.registry.getSession(name)!;
    } catch (error) {
      if (isolation === 'isolated') {
        await this.contexts.disposeSessionContext(name, { force: true }).catch(() => undefined);
      }
      if (this.registry.getSession(name)) this.registry.removeSession(name);
      throw error;
    }
  }

  async adoptTarget(name: string, targetId: string): Promise<SessionMetadata> {
    await this.browser.refreshTargets();
    const session = this.registry.getSession(name);
    if (!session) {
      throw new SessionFoundationError('SESSION_NOT_FOUND', `Session not found: ${name}`, {
        sessionName: name
      });
    }
    const target = this.browser.registry.getByTargetId(targetId);
    if (!target) {
      throw new SessionFoundationError('TARGET_NOT_FOUND', `Target not found: ${targetId}`, {
        targetId,
        exactMatchRequired: true
      });
    }
    const sessionContext = session.browserContextId ?? null;
    const targetContext = target.browserContextId ?? null;
    if (sessionContext !== targetContext) {
      throw new SessionFoundationError(
        'TARGET_CONTEXT_MISMATCH',
        `Target ${targetId} belongs to a different browser context`,
        {
          sessionName: name,
          targetId,
          sessionBrowserContextId: sessionContext,
          targetBrowserContextId: targetContext
        }
      );
    }
    const adopted = this.registry.adoptTarget(name, targetId, identities(this.browser.registry.list()));
    this.contexts.registerPage(name, targetId);
    await this.persist();
    return adopted;
  }

  async removeSession(
    name: string,
    options: { confirmed?: boolean; force?: boolean }
  ): Promise<RemoveWorkspaceSessionResult> {
    if (options?.confirmed !== true && options?.force !== true) {
      throw new SessionFoundationError(
        'CONTEXT_DISPOSAL_NOT_CONFIRMED',
        'Session removal requires confirmed: true or force: true',
        { sessionName: name }
      );
    }
    const session = this.registry.getSession(name);
    if (!session) {
      // Reuse the registry's structured SESSION_NOT_FOUND contract.
      this.registry.removeSession(name);
      throw new Error('unreachable');
    }
    const affectedPageIds = session.isolation === 'isolated'
      ? await this.contexts.disposeSessionContext(name, options)
      : [...session.pageIds].sort();
    const removed = this.registry.removeSession(name);
    await this.persist();
    return { session: removed, affectedPageIds };
  }

  /**
   * Reset one named session by disposing the same isolated browser context that
   * removal would dispose. Reset must never erase the global session store or
   * leave an untracked context running in Chrome.
   */
  async resetSession(
    name: string,
    options: { confirmed?: boolean; force?: boolean }
  ): Promise<ResetWorkspaceSessionResult> {
    const current = this.registry.getSession(name);
    if (!current) {
      this.registry.removeSession(name);
      throw new Error('unreachable');
    }
    if (current.isolation === 'shared') {
      throw new SessionFoundationError(
        'SHARED_CONTEXT_DISPOSAL_FORBIDDEN',
        'A shared compatibility session cannot be reset because its pages share the default context',
        { sessionName: name }
      );
    }
    const removed = await this.removeSession(name, options);
    let replacement: SessionMetadata;
    try {
      replacement = await this.createSession(name, { isolation: current.isolation });
    } catch (error) {
      throw new SessionFoundationError(
        'SESSION_RESET_INCOMPLETE',
        `Session ${name} was disposed but its replacement could not be created`,
        {
          sessionName: name,
          affectedPageIds: removed.affectedPageIds,
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }
    return {
      ...removed,
      replacement,
      pageId: replacement.pageIds[0]
    };
  }

  async checkAccess(name: string, targetId: string): Promise<PageAccessResult> {
    await this.refresh();
    return this.registry.checkPageAccess(name, targetId);
  }

  async assertAccess(name: string, targetId: string): Promise<{ rootTargetId: string }> {
    const result = await this.checkAccess(name, targetId);
    if (!result.ok) {
      const { SessionFoundationError } = await import('./errors.js');
      throw new SessionFoundationError(result.error.code, result.error.message, result.error.details);
    }
    return { rootTargetId: result.rootTargetId };
  }

  async createTarget(name: string, url = 'about:blank'): Promise<string> {
    const pageId = await this.contexts.createTarget(name, url);
    const target = await this.browser.waitForTarget((candidate) => candidate.targetId === pageId, 2_000);
    if (!target) throw new Error(`Chrome did not publish created target: ${pageId}`);
    this.registry.adoptTarget(name, pageId, identities(this.browser.registry.list()));
    await this.persist();
    return pageId;
  }

  async withTargetLease<T>(
    name: string,
    targetId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const { rootTargetId } = await this.assertAccess(name, targetId);
    return this.leases.withLease(rootTargetId, name, async () => operation());
  }

  close(): void {
    this.browser.close();
    this.storeLock.release();
  }

  private persist(): Promise<void> {
    return this.store.save({ version: 1, sessions: this.registry.listSessions() });
  }
}

export function defaultWorkspaceSessionStorePath(cdpUrl: string): string {
  const endpointKey = createHash('sha256').update(cdpUrl).digest('hex').slice(0, 16);
  return join(homedir(), '.cdp-cli', `sessions-${endpointKey}.json`);
}

function identities(targets: readonly TargetRecord[]): TargetIdentity[] {
  return targets
    .filter((target) => target.type === 'page' || target.type === 'iframe')
    .map((target) => ({
      targetId: target.targetId,
      frameId: target.targetId,
      ...(target.browserContextId ? { browserContextId: target.browserContextId } : {}),
      ...(target.parentTargetId ? { parentId: target.parentTargetId } : {}),
      ...(target.parentFrameId ? { parentFrameId: target.parentFrameId } : {}),
      ...(target.openerTargetId ? { openerId: target.openerTargetId } : {})
    }));
}

function browserProtocol(browser: BrowserConnection): BrowserContextProtocol {
  return {
    createBrowserContext: async () => browser.send('Target.createBrowserContext'),
    createTarget: async (params) => browser.send('Target.createTarget', params),
    disposeBrowserContext: async (params) => browser.send('Target.disposeBrowserContext', params),
    getTargets: async () => {
      await browser.refreshTargets();
      return identities(browser.registry.list());
    }
  };
}
