/**
 * Chrome DevTools Protocol connection context
 * Manages connection to Chrome browser via CDP REST API and WebSocket
 */

import { WebSocket } from 'ws';
import { fetch as undiciFetch } from 'undici';
import { getPageNotFoundHint } from './validation.js';

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

  constructor(cdpUrl: string = 'http://localhost:9222') {
    this.cdpUrl = cdpUrl;
  }

  /**
   * Get list of all open pages
   */
  async getPages(): Promise<Page[]> {
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
      page.title.includes(idOrTitle)
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
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);

      ws.on('open', () => {
        resolve(ws);
      });

      ws.on('error', (error) => {
        reject(error);
      });
    });
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
   * Throw if DevTools is attached (for commands that need Page domain)
   * Skips check if cdp-cli daemon is connected (its connection shows as attached but works fine)
   */
  async assertNoDevTools(pageId: string, skipIfDaemonConnected = true): Promise<void> {
    if (skipIfDaemonConnected) {
      // Check if daemon is connected to this page
      try {
        const response = await (globalThis.fetch ?? undiciFetch)('http://127.0.0.1:9223/sessions');
        if (response.ok) {
          const data = await response.json() as { sessions: Array<{ pageId: string; connected: boolean }> };
          if (data.sessions?.some(s => s.pageId === pageId && s.connected)) {
            return; // Daemon connected - skip check
          }
        }
      } catch {
        // Daemon not running
      }
    }

    if (await this.isDevToolsAttached(pageId)) {
      throw new Error('DevTools is open on this tab. Close DevTools to use this command.');
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
      event: 'requestWillBeSent' | 'responseReceived' | 'loadingFinished'
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
        responseHeaders: patch.responseHeaders ?? current?.responseHeaders
      };

      this.networkRequests.set(requestId, next);
      return next;
    };

    const emit = (
      requestId: string,
      event: 'requestWillBeSent' | 'responseReceived' | 'loadingFinished'
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
    const response = await fetch(`${this.cdpUrl}/json/close/${page.id}`);
    if (!response.ok) {
      throw new Error(`Failed to close page: ${response.statusText}`);
    }
  }

  /**
   * Create a new page
   */
  async createPage(url?: string): Promise<Page> {
    const endpoint = url
      // Chrome expects the literal URL after '?', so use encodeURI to keep protocol delimiters while escaping spaces; fragments must still be escaped.
      ? `${this.cdpUrl}/json/new?${encodeURI(url).replace(/#/g, '%23')}`
      : `${this.cdpUrl}/json/new`;

    const response = await fetch(endpoint, { method: 'PUT' });
    if (!response.ok) {
      throw new Error(`Failed to create page: ${response.statusText}`);
    }

    return await response.json() as Page;
  }

}
