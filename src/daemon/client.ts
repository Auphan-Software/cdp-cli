/**
 * Daemon client - CLI interface to communicate with the daemon
 */

import { spawn, ChildProcess } from 'child_process';
import { fetch as undiciFetch } from 'undici';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { ConsoleMessage, NetworkRequest, DialogInfo } from '../context.js';
import { SessionFoundationError, type SessionErrorCode } from '../sessions/errors.js';
import type { OperationLease } from '../sessions/operation-lease-manager.js';

const DEFAULT_DAEMON_PORT = 9223;
const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
const DEFAULT_CDP_URL = 'http://localhost:9222';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface DaemonClientOptions {
  /** Explicit daemon endpoint. Wins over `CDP_DAEMON_URL`. */
  daemonUrl?: string;
  /**
   * Chrome CDP endpoint the command targets. The stock daemon on 9223 is only
   * assumed for the stock Chrome endpoint on 9222; any other endpoint needs an
   * explicit daemon URL so a command can never silently talk to a daemon that
   * serves a different Chrome.
   */
  cdpUrl?: string;
}

/** True when the URL names the stock local Chrome debugging endpoint. */
export function isDefaultCdpUrl(cdpUrl: string | undefined): boolean {
  if (cdpUrl === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname) && parsed.port === '9222';
}

/**
 * Resolve which daemon a command may talk to. Throws `DAEMON_URL_REQUIRED`
 * instead of guessing when the Chrome endpoint is custom and no daemon URL was
 * configured explicitly.
 */
export function resolveDaemonUrl(options: DaemonClientOptions = {}): string {
  const explicit = options.daemonUrl?.trim();
  if (explicit) return explicit;
  const configured = process.env.CDP_DAEMON_URL?.trim();
  if (configured) return configured;
  if (isDefaultCdpUrl(options.cdpUrl)) return DEFAULT_DAEMON_URL;
  throw new SessionFoundationError(
    'DAEMON_URL_REQUIRED',
    `CDP endpoint ${options.cdpUrl} is not the default ${DEFAULT_CDP_URL}, so the default daemon at ` +
      `${DEFAULT_DAEMON_URL} cannot be assumed to serve it. Set CDP_DAEMON_URL to the daemon started ` +
      'for this endpoint.',
    {
      cdpUrl: options.cdpUrl,
      defaultCdpUrl: DEFAULT_CDP_URL,
      defaultDaemonUrl: DEFAULT_DAEMON_URL,
      environmentVariable: 'CDP_DAEMON_URL'
    }
  );
}

export interface DaemonDialogStatus {
  open: boolean;
  dialog?: DialogInfo;
  observedAt?: number;
  inferred?: boolean;
  probeUnavailable?: boolean;
}

export class DaemonClient {
  private readonly options: DaemonClientOptions;
  private resolvedBaseUrl?: string;

  constructor(options: DaemonClientOptions = {}) {
    this.options = { ...options };
  }

  /**
   * Daemon endpoint, resolved on first use so that constructing a client is
   * side-effect free while every request still fails fast on a configuration
   * problem (see `resolveDaemonUrl`).
   */
  private get baseUrl(): string {
    this.resolvedBaseUrl ??= resolveDaemonUrl(this.options);
    return this.resolvedBaseUrl;
  }

  /**
   * Check if daemon is running. A daemon configuration error is never
   * swallowed as "not running".
   */
  async isRunning(): Promise<boolean> {
    const baseUrl = this.baseUrl;
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start daemon in background
   * Returns true if started, false if already running
   */
  async startDaemon(options: { cdpUrl?: string; bufferSize?: number } = {}): Promise<{ started: boolean; pid?: number }> {
    // Check if already running
    if (await this.isRunning()) {
      return { started: false };
    }

    const args: string[] = [];

    // In exe mode, re-invoke self with --__daemon flag
    // In normal mode, spawn the daemon script directly
    if (typeof CDP_CLI_EXE_MODE !== 'undefined') {
      args.push('--__daemon');
    } else {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      args.push(join(__dirname, 'daemon-entry.js'));
    }

    if (options.cdpUrl) {
      args.push('--cdp-url', options.cdpUrl);
    }
    if (options.bufferSize) {
      args.push('--buffer-size', String(options.bufferSize));
    }
    const daemonPort = Number(new URL(this.baseUrl).port || DEFAULT_DAEMON_PORT);
    args.push('--port', String(daemonPort));

    // Spawn detached process
    const child: ChildProcess = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    child.unref();

    // Wait for daemon to be ready
    const maxWait = 5000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (await this.isRunning()) {
        return { started: true, pid: child.pid };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error('Daemon failed to start within timeout');
  }

  /**
   * Stop the daemon
   */
  async stopDaemon(): Promise<boolean> {
    if (!await this.isRunning()) {
      return false;
    }

    try {
      // Send shutdown request - daemon will handle graceful shutdown
      await (globalThis.fetch ?? undiciFetch)(`${this.baseUrl}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      // Connection may close before response - that's OK
    }

    // Wait for daemon to stop
    const maxWait = 3000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (!await this.isRunning()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return !await this.isRunning();
  }

  /**
   * Get daemon status
   */
  async getStatus(): Promise<{ running: boolean; sessions?: number }> {
    const baseUrl = this.baseUrl;
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) {
        const data = await res.json() as { status: string; sessions: number };
        return { running: true, sessions: data.sessions };
      }
      return { running: false };
    } catch {
      return { running: false };
    }
  }

  async acquireWorkspaceLease(
    sessionName: string,
    pageId: string
  ): Promise<OperationLease> {
    return this.workspaceLeaseRequest('acquire', sessionName, pageId);
  }

  async replaceOwnedWorkspaceLease(
    sessionName: string,
    pageId: string
  ): Promise<OperationLease> {
    return this.workspaceLeaseRequest('replace-owned', sessionName, pageId);
  }

  async heartbeatWorkspaceLease(
    sessionName: string,
    pageId: string,
    leaseId: string,
    rootTargetId?: string
  ): Promise<OperationLease> {
    return this.workspaceLeaseRequest('heartbeat', sessionName, pageId, leaseId, rootTargetId);
  }

  async releaseWorkspaceLease(
    sessionName: string,
    pageId: string,
    leaseId: string,
    rootTargetId?: string
  ): Promise<void> {
    await this.workspaceLeaseRequest('release', sessionName, pageId, leaseId, rootTargetId);
  }

  /**
   * Create session for a page
   */
  async createSession(
    pageId: string,
    webSocketUrl: string,
    workspaceSession?: string
  ): Promise<{ status: string; pageId: string }> {
    const res = await (globalThis.fetch ?? undiciFetch)(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, webSocketUrl, workspaceSession })
    });

    const data = await res.json() as any;
    if (!res.ok) {
      throw new Error(data.error || 'Failed to create session');
    }

    return data;
  }

  /**
   * Delete session for a page
   */
  async deleteSession(pageId: string, workspaceSession?: string): Promise<boolean> {
    const baseUrl = this.baseUrl;
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(
        `${baseUrl}/sessions/${encodeURIComponent(pageId)}${sessionQuery(workspaceSession)}`,
        { method: 'DELETE' }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<Array<{
    pageId: string;
    connected: boolean;
    consoleLogs: number;
    networkLogs: number;
  }>> {
    const res = await (globalThis.fetch ?? undiciFetch)(`${this.baseUrl}/sessions`);
    const data = await res.json() as { sessions: any[] };
    return data.sessions ?? [];
  }

  /** Get the daemon's bounded JavaScript-dialog state for a page. */
  async getDialogStatus(pageId: string, workspaceSession?: string): Promise<DaemonDialogStatus> {
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(pageId)}/dialog-status${sessionQuery(workspaceSession)}`;
    const res = await (globalThis.fetch ?? undiciFetch)(url, {
      signal: AbortSignal.timeout(10_000)
    });
    const data = await res.json() as { dialog?: DaemonDialogStatus } & RemoteError;
    if (!res.ok) throwRemoteError(data, 'Failed to get dialog status');
    return data.dialog ?? { open: false };
  }

  /**
   * Get console logs for a page
   */
  async getConsoleLogs(
    pageId: string,
    options: { last?: number; type?: string; workspaceSession?: string } = {}
  ): Promise<ConsoleMessage[]> {
    const params = new URLSearchParams();
    if (options.last !== undefined) params.set('last', String(options.last));
    if (options.type) params.set('type', options.type);
    if (options.workspaceSession) params.set('session', options.workspaceSession);

    const url = `${this.baseUrl}/logs/console/${encodeURIComponent(pageId)}?${params}`;
    const res = await (globalThis.fetch ?? undiciFetch)(url);

    if (!res.ok) throwRemoteError(await res.json() as RemoteError, 'Failed to get logs');

    const data = await res.json() as { logs: ConsoleMessage[] };
    return data.logs ?? [];
  }

  /**
   * Get a specific console message with full details (including stack trace)
   */
  async getConsoleMessageDetail(
    pageId: string,
    messageId: number,
    workspaceSession?: string
  ): Promise<ConsoleMessage | null> {
    const url = `${this.baseUrl}/logs/detail/${encodeURIComponent(pageId)}/${messageId}${sessionQuery(workspaceSession)}`;
    const res = await (globalThis.fetch ?? undiciFetch)(url);

    if (!res.ok) {
      const data = await res.json() as RemoteError;
      // Only an unstructured 404 means "no such message"; a structured
      // SESSION_NOT_FOUND / PAGE_NOT_OWNED must not be flattened to null.
      if (res.status === 404 && typeof data.code !== 'string') return null;
      throwRemoteError(data, 'Failed to get message');
    }

    const data = await res.json() as { message: ConsoleMessage };
    return data.message ?? null;
  }

  /**
   * Get network logs for a page
   */
  async getNetworkLogs(
    pageId: string,
    options: { last?: number; type?: string; workspaceSession?: string } = {}
  ): Promise<NetworkRequest[]> {
    const params = new URLSearchParams();
    if (options.last !== undefined) params.set('last', String(options.last));
    if (options.type) params.set('type', options.type);
    if (options.workspaceSession) params.set('session', options.workspaceSession);

    const url = `${this.baseUrl}/logs/network/${encodeURIComponent(pageId)}?${params}`;
    const res = await (globalThis.fetch ?? undiciFetch)(url);

    if (!res.ok) throwRemoteError(await res.json() as RemoteError, 'Failed to get logs');

    const data = await res.json() as { logs: NetworkRequest[] };
    return data.logs ?? [];
  }

  /**
   * Clear logs for a page
   */
  async clearLogs(pageId: string, workspaceSession?: string): Promise<boolean> {
    const baseUrl = this.baseUrl;
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(
        `${baseUrl}/logs/${encodeURIComponent(pageId)}${sessionQuery(workspaceSession)}`,
        { method: 'DELETE' }
      );
      if (res.ok) return true;
      const data = await res.json().catch(() => ({})) as RemoteError;
      if (typeof data.code === 'string') throwRemoteError(data, 'Failed to clear logs');
      return false;
    } catch (error) {
      if (error instanceof SessionFoundationError) throw error;
      return false;
    }
  }

  /**
   * Execute a CDP command through the daemon (uses warm WS connection)
   */
  async execCommand(
    pageId: string,
    method: string,
    params?: any,
    workspace?: { sessionName: string; leaseId?: string }
  ): Promise<any> {
    const res = await (globalThis.fetch ?? undiciFetch)(
      `${this.baseUrl}/exec/${encodeURIComponent(pageId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          params,
          workspaceSession: workspace?.sessionName,
          workspaceLeaseId: workspace?.leaseId
        })
      }
    );

    const data = await res.json() as { result?: any; error?: string };
    if (!res.ok) {
      throwRemoteError(data, 'Command failed');
    }

    return data.result;
  }

  /**
   * Execute multiple CDP commands in sequence through daemon
   */
  async execBatch(
    pageId: string,
    commands: Array<{ method: string; params?: any }>,
    workspace?: { sessionName: string; leaseId?: string }
  ): Promise<any[]> {
    const res = await (globalThis.fetch ?? undiciFetch)(
      `${this.baseUrl}/exec-batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageId,
          commands,
          workspaceSession: workspace?.sessionName,
          workspaceLeaseId: workspace?.leaseId
        })
      }
    );

    const data = await res.json() as { results?: any[] } & RemoteError;
    if (!res.ok) throwRemoteError(data, 'Batch command failed');

    return data.results ?? [];
  }

  private async workspaceLeaseRequest(
    action: 'acquire' | 'replace-owned' | 'heartbeat' | 'release',
    sessionName: string,
    pageId: string,
    leaseId?: string,
    rootTargetId?: string
  ): Promise<OperationLease> {
    const res = await (globalThis.fetch ?? undiciFetch)(`${this.baseUrl}/workspace-leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, sessionName, pageId, leaseId, rootTargetId })
    });
    const data = await res.json() as { lease?: OperationLease } & RemoteError;
    if (!res.ok) throwRemoteError(data, `Workspace lease ${action} failed`);
    return data.lease!;
  }
}

interface RemoteError {
  error?: string | boolean;
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
}

function throwRemoteError(data: RemoteError, fallback: string): never {
  if (typeof data.code === 'string' && typeof data.message === 'string') {
    throw new SessionFoundationError(
      data.code as SessionErrorCode,
      data.message,
      data.details
    );
  }
  throw new Error(typeof data.error === 'string' ? data.error : data.message ?? fallback);
}

function sessionQuery(workspaceSession?: string): string {
  return workspaceSession ? `?session=${encodeURIComponent(workspaceSession)}` : '';
}
