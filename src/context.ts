/**
 * Chrome DevTools Protocol connection context
 * Manages connection to Chrome browser via CDP REST API and WebSocket
 */

import { WebSocket } from 'ws';
import { fetch as undiciFetch } from 'undici';
import { getPageNotFoundHint } from './validation.js';
import { BrowserConnection, type BrowserConnectionOptions } from './cdp/browser-connection.js';
import { WorkspaceSessionService } from './sessions/workspace-session-service.js';
import { SessionFoundationError } from './sessions/errors.js';
import { DaemonClient } from './daemon/client.js';

let defaultWorkspaceSession: string | undefined;
const pendingWorkspaceReleases = new Set<Promise<void>>();

process.on('beforeExit', async () => {
  if (pendingWorkspaceReleases.size > 0) {
    await Promise.allSettled([...pendingWorkspaceReleases]);
  }
});

/** CLI parse hook; library callers should pass workspaceSession to the constructor. */
export function setDefaultWorkspaceSession(name: string | undefined): void {
  defaultWorkspaceSession = name;
}

export interface CDPContextOptions {
  workspaceSession?: string;
  sessionStorePath?: string;
}

export interface Page {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
  description?: string;
}

export interface CDPMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export interface StackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface ConsoleMessage {
  id: number;
  type: string;
  timestamp: number;
  text: string;
  source: string;
  line?: number;
  url?: string;
  args?: any[];
  stackTrace?: StackFrame[];
}

export interface DialogInfo {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  url: string;
  defaultPrompt?: string;
}

/**
 * Build the one actionable dialog diagnosis used by direct and daemon-backed
 * execution. Browser-owned UI (such as a client-certificate picker) is not a
 * CDP JavaScript dialog and cannot be dismissed by this command.
 */
export function dialogBlockerError(dialog: DialogInfo): Error {
  const typeLabel = dialog.type.charAt(0).toUpperCase() + dialog.type.slice(1);
  const canDismiss = !dialog.message.includes('dismiss manually');
  const hint = canDismiss
    ? `Use 'cdp-cli dialog <page> --dismiss' to dismiss it, or '--accept' to accept.`
    : 'Dismiss the dialog manually in the browser, or close and reopen the page. Browser-owned pickers (such as client-certificate selection) cannot be dismissed through CDP.';
  return new Error(`${typeLabel} dialog is blocking the page: "${dialog.message}"\n${hint}`);
}

export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  type?: string;
  size?: number;
  timestamp: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  failure?: NetworkFailure;
}

/** Details supplied when Chrome reports that a request did not complete. */
export interface NetworkFailure {
  errorText: string;
  canceled: boolean;
  blockedReason?: string;
  corsErrorStatus?: unknown;
}

export interface FrameInfo {
  id: string;
  parentId?: string;
  url: string;
  name?: string;
  securityOrigin?: string;
}

export interface ExecutionContextInfo {
  id: number;
  frameId: string;
  origin: string;
  name: string;
}

/**
 * CDP Context manages connection to Chrome
 */
export class CDPContext {
  private cdpUrl: string;
  // CDP message ID counter (resets to 1 for each new context/command)
  private messageId = 1;
  private consoleId = 1;

  // Collected data
  private consoleMessages: Map<number, ConsoleMessage> = new Map();
  private networkRequests: Map<string, NetworkRequest> = new Map();
  private readonly activeWorkspaceLeases = new Set<{ release(): Promise<void> }>();

  readonly workspaceSessionName?: string;
  private readonly sessionStorePath?: string;

  constructor(
    cdpUrl: string = 'http://localhost:9222',
    options: CDPContextOptions = {}
  ) {
    this.cdpUrl = cdpUrl;
    this.workspaceSessionName = options.workspaceSession ?? defaultWorkspaceSession;
    this.sessionStorePath = options.sessionStorePath;
  }

  /** Connect to Chrome's browser target and discover flattened child targets. */
  async connectBrowser(options: BrowserConnectionOptions = {}): Promise<BrowserConnection> {
    return BrowserConnection.open(this.cdpUrl, options);
  }

  /**
   * Get list of all open pages
   */
  async getPages(): Promise<Page[]> {
    const pages = await this.getRawPages();
    if (!this.workspaceSessionName) return pages;

    const service = await this.openWorkspaceService();
    try {
      await service.refresh();
      const session = service.registry.getSession(this.workspaceSessionName);
      if (!session) {
        throw new SessionFoundationError(
          'SESSION_NOT_FOUND',
          `Session not found: ${this.workspaceSessionName}`,
          { sessionName: this.workspaceSessionName }
        );
      }
      const owned = new Set(session.pageIds);
      return pages.filter((page) => owned.has(page.id));
    } finally {
      service.close();
    }
  }

  private async getRawPages(): Promise<Page[]> {
    const response = await (globalThis.fetch ?? undiciFetch)(`${this.cdpUrl}/json`);
    if (!response.ok) {
      throw new Error(`Failed to fetch pages: ${response.statusText}`);
    }
    const pages = await response.json() as Page[];
    return pages.filter(p => p.type === 'page');
  }

  /**
   * Find a page by ID or title
   */
  async findPage(idOrTitle: string): Promise<Page> {
    if (this.workspaceSessionName) {
      const pages = await this.getRawPages();
      const exact = pages.find((page) => page.id === idOrTitle);
      await this.assertSessionTargetAccess(idOrTitle);
      if (!exact) {
        throw new Error(`Target not found by exact targetId: ${idOrTitle}`);
      }
      return exact;
    }
    const pages = await this.getPages();

    if (pages.length === 0) {
      throw new Error('No pages found. Is Chrome running with --remote-debugging-port?');
    }

    // Prefer exact ID match, which guarantees uniqueness.
    const byId = pages.find((page) => page.id === idOrTitle);
    if (byId) {
      return byId;
    }

    const titleMatches = pages.filter((page) =>
      page.title.includes(idOrTitle) && !page.url.startsWith('devtools://')
    );

    if (titleMatches.length === 0) {
      // Provide helpful hint if the value looks like something else
      const hint = getPageNotFoundHint(idOrTitle);
      const availablePages = pages
        .slice(0, 3)
        .map((p) => `  - "${p.title}" (${p.id})`)
        .join('\n');
      const morePages = pages.length > 3 ? `\n  ... and ${pages.length - 3} more` : '';

      let errorMsg = `Page not found: "${idOrTitle}"`;
      if (hint) {
        errorMsg += `\n\nHint: ${hint}`;
      }
      errorMsg += `\n\nAvailable pages:\n${availablePages}${morePages}`;
      errorMsg += `\n\nUse 'cdp-cli list-pages' to see all pages.`;

      throw new Error(errorMsg);
    }

    if (titleMatches.length > 1) {
      const summary = titleMatches
        .map((page) => `"${page.title}" (${page.id})`)
        .join(', ');
      throw new Error(
        `Multiple pages matched "${idOrTitle}". Use an exact page ID or refine the title. Matches: ${summary}`
      );
    }

    return titleMatches[0];
  }

  /**
   * Connect to a page via WebSocket
   */
  async connect(page: Page): Promise<WebSocket> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);

      ws.on('open', () => {
        resolve(ws);
      });

      ws.on('error', (error) => {
        reject(error);
      });
    });
    if (this.workspaceSessionName) {
      try {
        const lease = await this.beginSessionTargetLease(page.id);
        this.activeWorkspaceLeases.add(lease);
        ws.once('close', () => {
          this.activeWorkspaceLeases.delete(lease);
          void lease.release();
        });
      } catch (error) {
        ws.close();
        throw error;
      }
    }
    return ws;
  }

  /**
   * Check if DevTools is attached to a page via browser endpoint
   * Must check BEFORE connecting to page, as our connection counts as attached
   */
  async isDevToolsAttached(pageId: string): Promise<boolean> {
    // Get browser websocket URL
    const response = await (globalThis.fetch ?? undiciFetch)(`${this.cdpUrl}/json/version`);
    if (!response.ok) return false;
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) return false;

    return new Promise((resolve) => {
      const ws = new WebSocket(version.webSocketDebuggerUrl!);
      const id = this.messageId++;

      ws.on('open', () => {
        ws.send(JSON.stringify({ id, method: 'Target.getTargets', params: {} }));
      });

      ws.on('message', (data: Buffer) => {
        const message: CDPMessage = JSON.parse(data.toString());
        if (message.id === id) {
          clearTimeout(timeout);
          ws.close();
          const target = message.result?.targetInfos?.find(
            (t: { targetId: string }) => t.targetId === pageId
          );
          resolve(target?.attached === true);
        }
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });

      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 2000);
    });
  }

  /**
   * Auto-close DevTools if attached, or skip if daemon connected
   */
  async assertNoDevTools(pageId: string, skipIfDaemonConnected = true): Promise<void> {
    // Check if daemon is connected - if so, skip (daemon connection is benign)
    if (skipIfDaemonConnected) {
      try {
        const response = await (globalThis.fetch ?? undiciFetch)('http://127.0.0.1:9223/sessions');
        if (response.ok) {
          const data = await response.json() as { sessions: Array<{ pageId: string; connected: boolean }> };
          if (data.sessions?.some(s => s.pageId === pageId && s.connected)) {
            return;
          }
        }
      } catch {
        // Daemon not running
      }
    }

    if (!await this.isDevToolsAttached(pageId)) {
      return; // Not attached, we're good
    }

    // DevTools is attached - try to auto-close it
    const closed = await this.closeDevToolsForPage(pageId);
    if (closed) {
      // Wait for Chrome to release the debugger connection
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify it's actually detached now
      if (!await this.isDevToolsAttached(pageId)) {
        return; // Successfully closed
      }
    }

    throw new Error('DevTools is open on this tab. Close DevTools to use this command.');
  }

  /**
   * Find and close DevTools window for a specific page
   */
  private async closeDevToolsForPage(pageId: string): Promise<boolean> {
    try {
      // Get all pages including DevTools
      const response = await (globalThis.fetch ?? undiciFetch)(`${this.cdpUrl}/json`);
      if (!response.ok) return false;

      const pages = await response.json() as Page[];

      // Find the target page to get its title
      const targetPage = pages.find(p => p.id === pageId);
      if (!targetPage) return false;

      // Find DevTools page that matches this page's title
      // DevTools title format: "DevTools - <page title>"
      const devToolsPage = pages.find(p =>
        p.url.startsWith('devtools://') &&
        p.title.includes(targetPage.title.slice(0, 30))
      );

      if (!devToolsPage) return false;

      // Close the DevTools page
      const closeResponse = await (globalThis.fetch ?? undiciFetch)(
        `${this.cdpUrl}/json/close/${devToolsPage.id}`
      );

      return closeResponse.ok;
    } catch {
      return false;
    }
  }

  /**
   * Send a CDP command and wait for response
   */
  async sendCommand(
    ws: WebSocket,
    method: string,
    params?: any
  ): Promise<any> {
    const id = this.messageId++;

    return new Promise((resolve, reject) => {
      const messageHandler = (data: Buffer) => {
        const message: CDPMessage = JSON.parse(data.toString());

        if (message.id === id) {
          clearTimeout(timeout);
          ws.off('message', messageHandler);

          if (message.error) {
            reject(new Error(message.error.message || 'CDP command failed'));
          } else {
            resolve(message.result);
          }
        }
      };

      const timeout = setTimeout(() => {
        ws.off('message', messageHandler);
        reject(new Error(`Command timeout: ${method}`));
      }, 30000);

      ws.on('message', messageHandler);

      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Check if a JavaScript dialog (alert/confirm/prompt) is currently open
   * Uses multiple strategies since dialog events only fire at open time
   */
  async checkForDialog(ws: WebSocket): Promise<DialogInfo | null> {
    // Strategy 1: Listen for dialog event while enabling Page domain
    const eventBasedCheck = new Promise<DialogInfo | null>((resolve) => {
      let dialogInfo: DialogInfo | null = null;
      let resolved = false;

      const messageHandler = (data: Buffer) => {
        const message: CDPMessage = JSON.parse(data.toString());
        if (message.method === 'Page.javascriptDialogOpening') {
          dialogInfo = {
            type: message.params.type,
            message: message.params.message,
            url: message.params.url,
            defaultPrompt: message.params.defaultPrompt
          };
          if (!resolved) {
            resolved = true;
            ws.off('message', messageHandler);
            resolve(dialogInfo);
          }
        }
      };

      ws.on('message', messageHandler);

      // Short timeout since dialog blocks commands
      const enableTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.off('message', messageHandler);
          resolve(dialogInfo);
        }
      }, 300);

      this.sendCommand(ws, 'Page.enable', {}).then(() => {
        clearTimeout(enableTimeout);
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            ws.off('message', messageHandler);
            resolve(dialogInfo);
          }
        }, 50);
      }).catch(() => {
        clearTimeout(enableTimeout);
        if (!resolved) {
          resolved = true;
          ws.off('message', messageHandler);
          resolve(dialogInfo);
        }
      });
    });

    const result = await eventBasedCheck;
    if (result) return result;

    // Strategy 2: Try Runtime.evaluate - if it times out, dialog is likely blocking
    // This catches already-open dialogs that we missed the event for
    try {
      const evalPromise = this.sendCommand(ws, 'Runtime.evaluate', {
        expression: '1',
        timeout: 200
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 300)
      );
      await Promise.race([evalPromise, timeoutPromise]);
      // If we get here, no dialog is blocking
      return null;
    } catch {
      // A timeout or execution error is not proof of a dialog: navigation,
      // target teardown, and a busy renderer look identical here. Only the
      // Page.javascriptDialogOpening event is a trustworthy positive signal.
      return null;
    }
  }

  /**
   * Dismiss or accept a JavaScript dialog
   */
  async handleDialog(ws: WebSocket, accept: boolean, promptText?: string): Promise<void> {
    // Ensure Page domain is enabled (required for handleJavaScriptDialog)
    // This may timeout if dialog is blocking, which is fine
    try {
      await Promise.race([
        this.sendCommand(ws, 'Page.enable', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
      ]);
    } catch {
      // Page.enable may timeout due to dialog, continue anyway
    }

    await this.sendCommand(ws, 'Page.handleJavaScriptDialog', {
      accept,
      promptText
    });
  }

  /**
   * Assert no dialog is open, throw descriptive error if one is
   */
  async assertNoDialog(ws: WebSocket): Promise<void> {
    const dialog = await this.checkForDialog(ws);
    if (dialog) {
      throw dialogBlockerError(dialog);
    }
  }

  /**
   * Setup console message collection
   */
  setupConsoleCollection(ws: WebSocket, onMessage?: (message: ConsoleMessage) => void): void {
    ws.on('message', (data: Buffer) => {
      const message: CDPMessage = JSON.parse(data.toString());

      if (message.method === 'Runtime.consoleAPICalled') {
        const { type, args, timestamp, stackTrace } = message.params;
        const text = args.map((arg: any) => {
          if (arg.value !== undefined) return String(arg.value);
          if (arg.description !== undefined) return arg.description;
          return JSON.stringify(arg);
        }).join(' ');

        const frames: StackFrame[] | undefined = stackTrace?.callFrames?.map((f: any) => ({
          functionName: f.functionName || '(anonymous)',
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber
        }));

        const consoleMsg: ConsoleMessage = {
          id: this.consoleId++,
          type,
          timestamp: timestamp || Date.now(),
          text,
          source: 'console-api',
          args,
          stackTrace: frames
        };

        this.consoleMessages.set(consoleMsg.id, consoleMsg);
        if (onMessage) {
          onMessage(consoleMsg);
        }
      }

      if (message.method === 'Runtime.exceptionThrown') {
        const { exceptionDetails, timestamp } = message.params;

        const frames: StackFrame[] | undefined = exceptionDetails.stackTrace?.callFrames?.map((f: any) => ({
          functionName: f.functionName || '(anonymous)',
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber
        }));

        const consoleMsg: ConsoleMessage = {
          id: this.consoleId++,
          type: 'error',
          timestamp: timestamp || Date.now(),
          text: exceptionDetails.text,
          source: 'exception',
          line: exceptionDetails.lineNumber,
          url: exceptionDetails.url,
          stackTrace: frames
        };

        this.consoleMessages.set(consoleMsg.id, consoleMsg);
        if (onMessage) {
          onMessage(consoleMsg);
        }
      }
    });
  }

  /**
   * Setup network request collection
   */
  setupNetworkCollection(
    ws: WebSocket,
    onRequest?: (
      request: NetworkRequest,
      event: 'requestWillBeSent' | 'responseReceived' | 'loadingFinished' | 'loadingFailed'
    ) => void
  ): void {
    const updateRequest = (requestId: string, patch: Partial<NetworkRequest>): NetworkRequest => {
      const current = this.networkRequests.get(requestId);

      const next: NetworkRequest = {
        id: requestId,
        url: patch.url ?? current?.url ?? '',
        method: patch.method ?? current?.method ?? 'GET',
        timestamp: patch.timestamp ?? current?.timestamp ?? Date.now(),
        type: patch.type ?? current?.type,
        status: patch.status ?? current?.status,
        size: patch.size ?? current?.size,
        requestHeaders: patch.requestHeaders ?? current?.requestHeaders,
        responseHeaders: patch.responseHeaders ?? current?.responseHeaders,
        failure: patch.failure ?? current?.failure
      };

      this.networkRequests.set(requestId, next);
      return next;
    };

    const emit = (
      requestId: string,
      event: 'requestWillBeSent' | 'responseReceived' | 'loadingFinished' | 'loadingFailed'
    ): void => {
      if (!onRequest) {
        return;
      }
      const entry = this.networkRequests.get(requestId);
      if (entry) {
        onRequest({ ...entry }, event);
      }
    };

    ws.on('message', (data: Buffer) => {
      const message: CDPMessage = JSON.parse(data.toString());

      if (message.method === 'Network.requestWillBeSent') {
        const { requestId, request, timestamp, type } = message.params;
        updateRequest(requestId, {
          url: request.url,
          method: request.method,
          timestamp: timestamp * 1000,
          type,
          requestHeaders: request.headers
        });
        emit(requestId, 'requestWillBeSent');
      }

      if (message.method === 'Network.responseReceived') {
        const { requestId, response, type } = message.params;
        updateRequest(requestId, {
          url: response.url || '',
          status: response.status,
          responseHeaders: response.headers,
          type: type ?? undefined
        });
        emit(requestId, 'responseReceived');
      }

      if (message.method === 'Network.loadingFinished') {
        const { requestId, encodedDataLength } = message.params;
        updateRequest(requestId, {
          size: encodedDataLength
        });
        emit(requestId, 'loadingFinished');
      }

      if (message.method === 'Network.loadingFailed') {
        const { requestId, errorText, canceled, blockedReason, corsErrorStatus } = message.params;
        updateRequest(requestId, {
          failure: {
            errorText: typeof errorText === 'string' ? errorText : 'Request failed',
            canceled: canceled === true,
            ...(typeof blockedReason === 'string' ? { blockedReason } : {}),
            ...(corsErrorStatus === undefined ? {} : { corsErrorStatus })
          }
        });
        emit(requestId, 'loadingFailed');
      }
    });
  }

  /**
   * Get all console messages collected in THIS context session only.
   * Note: Messages are NOT persisted across CLI commands.
   */
  getConsoleMessages(): ConsoleMessage[] {
    return Array.from(this.consoleMessages.values());
  }

  /**
   * Get all network requests collected in THIS context session only.
   * Note: Requests are NOT persisted across CLI commands.
   */
  getNetworkRequests(): NetworkRequest[] {
    return Array.from(this.networkRequests.values());
  }

  /**
   * Close a page
   */
  async closePage(page: Page): Promise<void> {
    const close = async (): Promise<void> => {
      const response = await fetch(`${this.cdpUrl}/json/close/${page.id}`);
      if (!response.ok) {
        throw new Error(`Failed to close page: ${response.statusText}`);
      }
    };
    if (!this.workspaceSessionName) return close();
    await this.withSessionTargetLease(page.id, close);
  }

  /**
   * Create a new page
   */
  async createPage(url?: string): Promise<Page> {
    if (this.workspaceSessionName) {
      const service = await this.openWorkspaceService();
      try {
        const pageId = await service.createTarget(this.workspaceSessionName, url ?? 'about:blank');
        const deadline = Date.now() + 2_000;
        for (;;) {
          const page = (await this.getRawPages()).find((candidate) => candidate.id === pageId);
          if (page) return page;
          if (Date.now() >= deadline) {
            throw new Error(`Created target did not appear in page list: ${pageId}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        service.close();
      }
    }
    const endpoint = url
      // Chrome parses everything after '?' as a query string, so a URL passed
      // literally is cut at its first '&' and loses the rest, fragment included.
      // Percent-encoding the whole URL as one opaque value survives that parse
      // and Chrome unescapes it back before navigating.
      ? `${this.cdpUrl}/json/new?${encodeURIComponent(url)}`
      : `${this.cdpUrl}/json/new`;

    const response = await fetch(endpoint, { method: 'PUT' });
    if (!response.ok) {
      throw new Error(`Failed to create page: ${response.statusText}`);
    }

    return await response.json() as Page;
  }

  /** Enforce exact target ownership when this context has --session. */
  async assertSessionTargetAccess(targetId: string): Promise<void> {
    if (!this.workspaceSessionName) return;
    const service = await this.openWorkspaceService();
    try {
      await service.assertAccess(this.workspaceSessionName, targetId);
    } finally {
      service.close();
    }
  }

  async getSessionOwnedTargetIds(): Promise<Set<string> | undefined> {
    if (!this.workspaceSessionName) return undefined;
    const service = await this.openWorkspaceService();
    try {
      await service.refresh();
      const session = service.registry.getSession(this.workspaceSessionName);
      if (!session) {
        throw new SessionFoundationError(
          'SESSION_NOT_FOUND',
          `Session not found: ${this.workspaceSessionName}`,
          { sessionName: this.workspaceSessionName }
        );
      }
      return new Set(session.pageIds);
    } finally {
      service.close();
    }
  }

  async withSessionTargetLease<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.workspaceSessionName) return operation();
    const lease = await this.beginSessionTargetLease(targetId);
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  async beginSessionTargetLease(targetId: string): Promise<{ release(): Promise<void> }> {
    if (!this.workspaceSessionName) return { release: async () => undefined };
    await this.assertSessionTargetAccess(targetId);
    const daemon = new DaemonClient();
    if (!await daemon.isRunning()) {
      await daemon.startDaemon({ cdpUrl: this.cdpUrl });
    }
    const owner = this.workspaceSessionName;
    const lease = await daemon.acquireWorkspaceLease(owner, targetId);
    const heartbeat = setInterval(() => {
      void daemon.heartbeatWorkspaceLease(
        owner,
        targetId,
        lease.leaseId,
        lease.rootTargetId
      ).catch(() => {
        clearInterval(heartbeat);
      });
    }, 20_000);
    heartbeat.unref();
    let released = false;
    return {
      release: () => {
        if (released) return Promise.resolve();
        released = true;
        clearInterval(heartbeat);
        const pending = daemon
          .releaseWorkspaceLease(owner, targetId, lease.leaseId, lease.rootTargetId)
          .catch(() => undefined);
        pendingWorkspaceReleases.add(pending);
        void pending.finally(() => pendingWorkspaceReleases.delete(pending));
        return pending;
      }
    };
  }

  async releaseSessionLeases(): Promise<void> {
    const active = [...this.activeWorkspaceLeases];
    this.activeWorkspaceLeases.clear();
    await Promise.allSettled(active.map((lease) => lease.release()));
  }

  private openWorkspaceService(): Promise<WorkspaceSessionService> {
    return WorkspaceSessionService.open(this.cdpUrl, { storePath: this.sessionStorePath });
  }

  /**
   * Get frame tree for a page
   */
  async getFrameTree(ws: WebSocket): Promise<FrameInfo[]> {
    await this.sendCommand(ws, 'Page.enable');
    const result = await this.sendCommand(ws, 'Page.getFrameTree');

    const frames: FrameInfo[] = [];

    const collectFrames = (node: any, parentId?: string) => {
      const frame = node.frame;
      frames.push({
        id: frame.id,
        parentId,
        url: frame.url,
        name: frame.name || undefined,
        securityOrigin: frame.securityOrigin
      });

      if (node.childFrames) {
        for (const child of node.childFrames) {
          collectFrames(child, frame.id);
        }
      }
    };

    collectFrames(result.frameTree);
    return frames;
  }

  /**
   * Get execution contexts (one per frame)
   */
  async getExecutionContexts(ws: WebSocket): Promise<ExecutionContextInfo[]> {
    const contexts: ExecutionContextInfo[] = [];

    return new Promise((resolve) => {
      const messageHandler = (data: Buffer) => {
        const message: CDPMessage = JSON.parse(data.toString());
        if (message.method === 'Runtime.executionContextCreated') {
          const ctx = message.params.context;
          contexts.push({
            id: ctx.id,
            frameId: ctx.auxData?.frameId || '',
            origin: ctx.origin,
            name: ctx.name
          });
        }
      };

      ws.on('message', messageHandler);

      // Disable then re-enable Runtime to force fresh context events
      // (if already enabled, we won't get events for existing contexts)
      this.sendCommand(ws, 'Runtime.disable')
        .then(() => this.sendCommand(ws, 'Runtime.enable'))
        .then(() => {
          // Give time for all context events to arrive
          setTimeout(() => {
            ws.off('message', messageHandler);
            resolve(contexts);
          }, 100);
        });
    });
  }

  /**
   * Resolve frame specification to execution context ID
   * @param ws WebSocket connection
   * @param frameSpec Frame specification: selector (e.g. "#iframe"), index (e.g. "1"), or "auto"
   * @returns contextId for Runtime.evaluate, or undefined for top frame
   */
  async resolveFrameContext(
    ws: WebSocket,
    frameSpec?: string
  ): Promise<number | undefined> {
    const frameId = await this.resolveFrameId(ws, frameSpec);
    if (frameId === undefined) {
      return undefined; // Top frame, use default context
    }

    const contexts = await this.getExecutionContexts(ws);
    const contextId = contexts.find(c => c.frameId === frameId)?.id;

    // Returning undefined here would silently fall back to the top frame,
    // so callers would run against the wrong document and still succeed.
    if (contextId === undefined) {
      const frames = await this.getFrameTree(ws);
      const frame = frames.find(f => f.id === frameId);
      throw new Error(
        `No execution context found for frame ${frameSpec} (${frame?.url ?? 'unknown url'}). The frame may still be loading.`
      );
    }

    return contextId;
  }

  /**
   * Resolve a frame specification to a CDP frame ID.
   *
   * Frame IDs survive a navigation of that frame, while execution context IDs
   * do not, so this is what a navigation watcher has to key on.
   *
   * @param frameSpec Frame specification: selector (e.g. "#iframe") or index (1 = first iframe)
   * @returns frame ID, or undefined for the top frame
   */
  async resolveFrameId(
    ws: WebSocket,
    frameSpec?: string
  ): Promise<string | undefined> {
    if (!frameSpec || frameSpec === '0') {
      return undefined; // Top frame
    }

    const frames = await this.getFrameTree(ws);

    // If numeric, treat as frame index (0 = top, 1 = first child, etc.)
    if (/^\d+$/.test(frameSpec)) {
      const index = parseInt(frameSpec, 10);
      if (index === 0) return undefined;
      // frames[0] is top, frames[1] is first iframe
      const frameId = frames[index]?.id;
      if (index > 0 && index <= frames.length - 1 && frameId) {
        return frameId;
      }
      throw new Error(`Frame index ${index} not found. Available: 0-${frames.length - 1}`);
    }

    // Otherwise treat as CSS selector - find the iframe element in the top
    // document, then match it to a frame by URL or name.
    await this.sendCommand(ws, 'Runtime.enable');
    const iframeInfo = await this.sendCommand(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const iframe = document.querySelector(${JSON.stringify(frameSpec)});
        if (!iframe || iframe.tagName !== 'IFRAME') return null;
        return {
          src: iframe.src,
          name: iframe.name || iframe.id || '',
          contentWindow: !!iframe.contentWindow
        };
      })()`,
      returnByValue: true
    });

    if (!iframeInfo.result?.value) {
      throw new Error(`No iframe found matching selector: ${frameSpec}`);
    }

    const { src, name } = iframeInfo.result.value;

    const matchingFrame = frames.find(f =>
      f.parentId && // Must be a child frame
      (f.url === src || f.name === name || (name && f.url.includes(name)))
    );

    if (!matchingFrame) {
      const availableFrames = frames
        .filter(f => f.parentId)
        .map((f, i) => `  ${i + 1}. ${f.name || '(unnamed)'} - ${f.url}`)
        .join('\n');
      throw new Error(`Could not find frame context for: ${frameSpec}\n\nAvailable frames:\n${availableFrames}`);
    }

    return matchingFrame.id;
  }

  /**
   * Evaluate expression in a specific frame
   */
  async evaluateInFrame(
    ws: WebSocket,
    expression: string,
    frameSpec?: string,
    options: { returnByValue?: boolean; awaitPromise?: boolean } = {}
  ): Promise<any> {
    const contextId = await this.resolveFrameContext(ws, frameSpec);

    await this.sendCommand(ws, 'Runtime.enable');
    return this.sendCommand(ws, 'Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: options.returnByValue ?? true,
      awaitPromise: options.awaitPromise ?? false
    });
  }

}
