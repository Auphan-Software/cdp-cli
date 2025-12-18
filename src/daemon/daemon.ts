/**
 * CDP Daemon - background service for persistent page logging
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocket } from 'ws';
import { PageSession } from './page-session.js';
import { CDPContext, Page, CDPMessage } from '../context.js';

const DEFAULT_DAEMON_PORT = 9223;
const DEFAULT_CDP_URL = 'http://localhost:9222';
const DEFAULT_BUFFER_SIZE = 500;

interface DaemonConfig {
  port: number;
  cdpUrl: string;
  bufferSize: number;
}

interface SessionInfo {
  pageId: string;
  connected: boolean;
  consoleLogs: number;
  networkLogs: number;
}

export class CDPDaemon {
  private config: DaemonConfig;
  private sessions: Map<string, PageSession> = new Map();
  private context: CDPContext;
  private server: ReturnType<typeof createServer> | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private browserWs: WebSocket | null = null;
  private browserMessageId = 1;

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = {
      port: config.port ?? DEFAULT_DAEMON_PORT,
      cdpUrl: config.cdpUrl ?? DEFAULT_CDP_URL,
      bufferSize: config.bufferSize ?? DEFAULT_BUFFER_SIZE
    };
    this.context = new CDPContext(this.config.cdpUrl);
  }

  /**
   * Start the daemon server
   */
  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.config.port} already in use (daemon may already be running)`));
        } else {
          reject(err);
        }
      });

      this.server!.listen(this.config.port, '127.0.0.1', async () => {
        this.startHealthCheck();
        await this.startTargetDiscovery();
        resolve();
      });
    });
  }

  /**
   * Stop the daemon
   */
  async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Close browser WebSocket
    if (this.browserWs) {
      this.browserWs.close();
      this.browserWs = null;
    }

    // Close all sessions
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  /**
   * Periodic health check - detect Chrome restarts and new pages
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const pages = await this.context.getPages();
        const pageIds = new Set(pages.map(p => p.id));

        // Remove sessions for closed pages
        for (const [pageId, session] of this.sessions) {
          if (!pageIds.has(pageId)) {
            session.close();
            this.sessions.delete(pageId);
          }
        }

        // Auto-register untracked pages
        for (const page of pages) {
          if (!this.sessions.has(page.id)) {
            await this.registerPage(page);
          }
        }
      } catch {
        // Chrome not available - try to reconnect browser WS
        if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
          this.startTargetDiscovery().catch(() => {});
        }
      }
    }, 5000);
  }

  /**
   * Register a page for logging
   */
  private async registerPage(page: Page): Promise<boolean> {
    if (this.sessions.has(page.id)) {
      return true;
    }

    const session = new PageSession({
      pageId: page.id,
      webSocketUrl: page.webSocketDebuggerUrl,
      bufferSize: this.config.bufferSize,
      onClose: () => {
        this.sessions.delete(page.id);
      }
    });

    try {
      await session.connect();
      this.sessions.set(page.id, session);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Connect to browser and listen for new targets
   */
  private async startTargetDiscovery(): Promise<void> {
    try {
      // Get browser WebSocket URL
      const response = await fetch(`${this.config.cdpUrl}/json/version`);
      if (!response.ok) return;

      const version = await response.json() as { webSocketDebuggerUrl?: string };
      if (!version.webSocketDebuggerUrl) return;

      // Close existing connection if any
      if (this.browserWs) {
        this.browserWs.close();
      }

      // Connect to browser
      this.browserWs = new WebSocket(version.webSocketDebuggerUrl);

      this.browserWs.on('open', async () => {
        // Enable target discovery
        this.sendBrowserCommand('Target.setDiscoverTargets', { discover: true });
      });

      this.browserWs.on('message', async (data: Buffer) => {
        const message: CDPMessage = JSON.parse(data.toString());

        // Handle new target created
        if (message.method === 'Target.targetCreated') {
          const targetInfo = message.params?.targetInfo;
          if (targetInfo?.type === 'page') {
            // Fetch full page info to get webSocketDebuggerUrl
            try {
              const pages = await this.context.getPages();
              const page = pages.find(p => p.id === targetInfo.targetId);
              if (page) {
                await this.registerPage(page);
              }
            } catch {
              // Will be picked up by health check
            }
          }
        }

        // Handle target destroyed
        if (message.method === 'Target.targetDestroyed') {
          const targetId = message.params?.targetId;
          if (targetId && this.sessions.has(targetId)) {
            const session = this.sessions.get(targetId);
            session?.close();
            this.sessions.delete(targetId);
          }
        }
      });

      this.browserWs.on('close', () => {
        this.browserWs = null;
        // Will reconnect on next health check
      });

      this.browserWs.on('error', () => {
        this.browserWs?.close();
        this.browserWs = null;
      });
    } catch {
      // Chrome not available yet, will retry on health check
    }
  }

  /**
   * Send command to browser WebSocket
   */
  private sendBrowserCommand(method: string, params?: any): void {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) return;

    const id = this.browserMessageId++;
    this.browserWs.send(JSON.stringify({ id, method, params }));
  }

  /**
   * Handle HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.config.port}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    res.setHeader('Content-Type', 'application/json');

    try {
      // Health check
      if (method === 'GET' && path === '/health') {
        this.sendJson(res, 200, { status: 'ok', sessions: this.sessions.size });
        return;
      }

      // Shutdown
      if (method === 'POST' && path === '/shutdown') {
        this.sendJson(res, 200, { status: 'shutting_down' });
        setImmediate(async () => {
          await this.stop();
          process.exit(0);
        });
        return;
      }

      // List sessions
      if (method === 'GET' && path === '/sessions') {
        const sessions: SessionInfo[] = [];
        for (const [pageId, session] of this.sessions) {
          const stats = session.getStats();
          sessions.push({
            pageId,
            connected: stats.connected,
            consoleLogs: stats.console,
            networkLogs: stats.network
          });
        }
        this.sendJson(res, 200, { sessions });
        return;
      }

      // Create session for page
      if (method === 'POST' && path === '/sessions') {
        const body = await this.readBody(req);
        const { pageId, webSocketUrl } = body;

        if (!pageId || !webSocketUrl) {
          this.sendJson(res, 400, { error: 'pageId and webSocketUrl required' });
          return;
        }

        // Check if session already exists
        if (this.sessions.has(pageId)) {
          const stats = this.sessions.get(pageId)!.getStats();
          this.sendJson(res, 200, { status: 'exists', pageId, ...stats });
          return;
        }

        // Create new session
        const session = new PageSession({
          pageId,
          webSocketUrl,
          bufferSize: this.config.bufferSize,
          onClose: () => {
            this.sessions.delete(pageId);
          }
        });

        try {
          await session.connect();
          this.sessions.set(pageId, session);
          this.sendJson(res, 201, { status: 'created', pageId });
        } catch (err) {
          this.sendJson(res, 500, { error: `Failed to connect: ${(err as Error).message}` });
        }
        return;
      }

      // Delete session
      if (method === 'DELETE' && path.startsWith('/sessions/')) {
        const pageId = decodeURIComponent(path.slice('/sessions/'.length));
        const session = this.sessions.get(pageId);

        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        session.close();
        this.sessions.delete(pageId);
        this.sendJson(res, 200, { status: 'deleted', pageId });
        return;
      }

      // Get specific console message by ID
      if (method === 'GET' && path.startsWith('/logs/detail/')) {
        const rest = path.slice('/logs/detail/'.length);
        const [pageId, messageIdStr] = rest.split('/').map(decodeURIComponent);
        const messageId = parseInt(messageIdStr, 10);

        if (!pageId || isNaN(messageId)) {
          this.sendJson(res, 400, { error: 'Invalid page ID or message ID' });
          return;
        }

        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        const message = session.getConsoleMessage(messageId);
        if (!message) {
          this.sendJson(res, 404, { error: 'Message not found' });
          return;
        }

        this.sendJson(res, 200, { message });
        return;
      }

      // Get console logs
      if (method === 'GET' && path.startsWith('/logs/console/')) {
        const pageId = decodeURIComponent(path.slice('/logs/console/'.length));
        const session = this.sessions.get(pageId);

        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        const lastParam = url.searchParams.get('last');
        const last = lastParam ? parseInt(lastParam, 10) : undefined;
        const typeFilter = url.searchParams.get('type');

        let logs = session.getConsoleLogs(last);
        if (typeFilter) {
          logs = logs.filter(log => log.type === typeFilter);
        }

        this.sendJson(res, 200, { logs });
        return;
      }

      // Get network logs
      if (method === 'GET' && path.startsWith('/logs/network/')) {
        const pageId = decodeURIComponent(path.slice('/logs/network/'.length));
        const session = this.sessions.get(pageId);

        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        const lastParam = url.searchParams.get('last');
        const last = lastParam ? parseInt(lastParam, 10) : undefined;
        const typeFilter = url.searchParams.get('type');

        let logs = session.getNetworkLogs(last);
        if (typeFilter) {
          logs = logs.filter(log => log.type === typeFilter);
        }

        this.sendJson(res, 200, { logs });
        return;
      }

      // Clear logs
      if (method === 'DELETE' && path.startsWith('/logs/')) {
        const pageId = decodeURIComponent(path.slice('/logs/'.length));
        const session = this.sessions.get(pageId);

        if (!session) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }

        session.clearLogs();
        this.sendJson(res, 200, { status: 'cleared', pageId });
        return;
      }

      // Not found
      this.sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      this.sendJson(res, 500, { error: (err as Error).message });
    }
  }

  /**
   * Read JSON body
   */
  private async readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   */
  private sendJson(res: ServerResponse, status: number, data: any): void {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  }
}

/**
 * Run daemon as standalone process
 */
export async function runDaemon(config: Partial<DaemonConfig> = {}): Promise<void> {
  const daemon = new CDPDaemon(config);

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });

  await daemon.start();

  // Keep process alive
  process.stdin.resume();
}
