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

function configuredDaemonUrl(): string {
  const value = process.env.CDP_DAEMON_URL?.trim();
  return value || DEFAULT_DAEMON_URL;
}

export interface DaemonClientOptions {
  daemonUrl?: string;
}

export interface DaemonDialogStatus {
  open: boolean;
  dialog?: DialogInfo;
  observedAt?: number;
  inferred?: boolean;
  probeUnavailable?: boolean;
}

export class DaemonClient {
  private baseUrl: string;

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = options.daemonUrl ?? configuredDaemonUrl();
  }

  /**
   * Check if daemon is running
   */
  async isRunning(): Promise<boolean> {
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(`${this.baseUrl}/health`, {
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
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(`${this.baseUrl}/health`, {
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
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(
        `${this.baseUrl}/sessions/${encodeURIComponent(pageId)}${sessionQuery(workspaceSession)}`,
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

    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error || 'Failed to get logs');
    }

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
      if (res.status === 404) return null;
      const data = await res.json() as { error?: string };
      throw new Error(data.error || 'Failed to get message');
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

    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error || 'Failed to get logs');
    }

    const data = await res.json() as { logs: NetworkRequest[] };
    return data.logs ?? [];
  }

  /**
   * Clear logs for a page
   */
  async clearLogs(pageId: string, workspaceSession?: string): Promise<boolean> {
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(
        `${this.baseUrl}/logs/${encodeURIComponent(pageId)}${sessionQuery(workspaceSession)}`,
        { method: 'DELETE' }
      );
      return res.ok;
    } catch {
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

    const data = await res.json() as { results?: any[]; error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Batch command failed');
    }

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
