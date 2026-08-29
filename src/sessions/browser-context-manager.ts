import { SessionFoundationError } from './errors.js';
import { isValidSessionName, type SessionIsolation, type TargetIdentity } from './types.js';

export const BROWSER_CONTEXT_BOUNDARY_NOTICE =
  'BrowserContext provides accident isolation, not a security boundary.';

export interface BrowserContextProtocol {
  createBrowserContext(): Promise<{ browserContextId: string }>;
  createTarget(params: { url: string; browserContextId?: string; background?: boolean }): Promise<{ targetId: string }>;
  disposeBrowserContext(params: { browserContextId: string }): Promise<void>;
  getTargets?(): Promise<readonly TargetIdentity[]>;
}

export interface ManagedBrowserContext {
  sessionName: string;
  browserContextId: string | null;
  isolation: SessionIsolation;
  pageIds: string[];
  boundaryNotice: typeof BROWSER_CONTEXT_BOUNDARY_NOTICE;
}

export interface CreateBrowserContextOptions {
  isolation?: SessionIsolation;
  /** The compatibility context to use. Null means Chrome's default context. */
  sharedContextId?: string | null;
}

export interface DisposeBrowserContextOptions {
  /** Call sites must explicitly acknowledge that every page in the context is affected. */
  confirmed?: boolean;
  force?: boolean;
}

interface MutableManagedContext {
  sessionName: string;
  browserContextId: string | null;
  isolation: SessionIsolation;
  pageIds: Set<string>;
}

/** Owns browser-context creation, target placement, and confirmed disposal. */
export class BrowserContextManager {
  private readonly contexts = new Map<string, MutableManagedContext>();

  constructor(private readonly protocol: BrowserContextProtocol) {}

  async createSessionContext(
    sessionName: string,
    options: CreateBrowserContextOptions = {}
  ): Promise<ManagedBrowserContext> {
    validateName(sessionName);
    if (this.contexts.has(sessionName)) {
      throw new SessionFoundationError(
        'CONTEXT_ALREADY_EXISTS',
        `Browser context already exists for session ${sessionName}`,
        { sessionName }
      );
    }

    const isolation = options.isolation ?? 'isolated';
    let browserContextId: string | null;
    try {
      if (isolation === 'isolated') {
        const created = await this.protocol.createBrowserContext();
        if (!created.browserContextId) {
          throw new Error('Protocol returned an empty browser context ID');
        }
        browserContextId = created.browserContextId;
      } else {
        browserContextId = options.sharedContextId ?? null;
      }
    } catch (error) {
      throw protocolError('Failed to create browser context', error);
    }

    const context: MutableManagedContext = {
      sessionName,
      browserContextId,
      isolation,
      pageIds: new Set()
    };
    this.contexts.set(sessionName, context);
    return toManaged(context);
  }

  /** Restores metadata without issuing protocol commands. */
  restoreSessionContext(
    sessionName: string,
    browserContextId: string | null,
    isolation: SessionIsolation,
    pageIds: readonly string[] = []
  ): ManagedBrowserContext {
    validateName(sessionName);
    if (this.contexts.has(sessionName)) {
      throw new SessionFoundationError('CONTEXT_ALREADY_EXISTS', `Context already restored: ${sessionName}`);
    }
    if (isolation === 'isolated' && !browserContextId) {
      throw new SessionFoundationError(
        'SESSION_STORE_CORRUPT',
        'An isolated session requires a browser context ID',
        { sessionName }
      );
    }
    const context: MutableManagedContext = {
      sessionName,
      browserContextId,
      isolation,
      pageIds: new Set(pageIds)
    };
    this.contexts.set(sessionName, context);
    return toManaged(context);
  }

  async createTarget(sessionName: string, url = 'about:blank', background = true): Promise<string> {
    const context = this.requireContext(sessionName);
    const params: { url: string; browserContextId?: string; background?: boolean } = { url, background };
    if (context.browserContextId) params.browserContextId = context.browserContextId;

    let targetId: string;
    try {
      const created = await this.protocol.createTarget(params);
      if (!created.targetId) throw new Error('Protocol returned an empty target ID');
      targetId = created.targetId;
    } catch (error) {
      throw protocolError('Failed to create target', error);
    }
    context.pageIds.add(targetId);
    return targetId;
  }

  registerPage(sessionName: string, pageId: string): ManagedBrowserContext {
    if (!pageId) throw new SessionFoundationError('TARGET_NOT_FOUND', 'Page ID must not be empty');
    const context = this.requireContext(sessionName);
    context.pageIds.add(pageId);
    return toManaged(context);
  }

  getSessionContext(sessionName: string): ManagedBrowserContext | undefined {
    const context = this.contexts.get(sessionName);
    return context ? toManaged(context) : undefined;
  }

  async disposeSessionContext(
    sessionName: string,
    options: DisposeBrowserContextOptions
  ): Promise<string[]> {
    const context = this.requireContext(sessionName);
    if (options?.confirmed !== true && options?.force !== true) {
      throw new SessionFoundationError(
        'CONTEXT_DISPOSAL_NOT_CONFIRMED',
        'Browser context disposal requires confirmed: true or force: true',
        { sessionName }
      );
    }
    if (context.isolation === 'shared' || !context.browserContextId) {
      throw new SessionFoundationError(
        'SHARED_CONTEXT_DISPOSAL_FORBIDDEN',
        'A shared compatibility context cannot be disposed by a session',
        { sessionName, browserContextId: context.browserContextId }
      );
    }

    const affected = new Set(context.pageIds);
    if (this.protocol.getTargets) {
      let targets: readonly TargetIdentity[];
      try {
        targets = await this.protocol.getTargets();
      } catch (error) {
        throw protocolError('Failed to enumerate affected targets', error);
      }
      for (const target of targets) {
        if (target.browserContextId === context.browserContextId) affected.add(target.targetId);
      }
    }

    try {
      await this.protocol.disposeBrowserContext({ browserContextId: context.browserContextId });
    } catch (error) {
      throw protocolError('Failed to dispose browser context', error);
    }
    this.contexts.delete(sessionName);
    return [...affected].sort();
  }

  private requireContext(sessionName: string): MutableManagedContext {
    const context = this.contexts.get(sessionName);
    if (!context) {
      throw new SessionFoundationError(
        'CONTEXT_NOT_FOUND',
        `Browser context not found for session ${sessionName}`,
        { sessionName }
      );
    }
    return context;
  }
}

function validateName(sessionName: string): void {
  if (!isValidSessionName(sessionName)) {
    throw new SessionFoundationError('INVALID_SESSION_NAME', `Invalid session name: ${sessionName}`);
  }
}

function toManaged(context: MutableManagedContext): ManagedBrowserContext {
  return {
    sessionName: context.sessionName,
    browserContextId: context.browserContextId,
    isolation: context.isolation,
    pageIds: [...context.pageIds].sort(),
    boundaryNotice: BROWSER_CONTEXT_BOUNDARY_NOTICE
  };
}

function protocolError(message: string, error: unknown): SessionFoundationError {
  if (error instanceof SessionFoundationError) return error;
  return new SessionFoundationError('PROTOCOL_ERROR', message, {
    cause: error instanceof Error ? error.message : String(error)
  });
}

