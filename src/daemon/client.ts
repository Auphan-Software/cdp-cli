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
import { CommandTimeoutError } from '../cdp/command-timeout.js';

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

/**
 * Canonical form for comparing two CDP HTTP endpoints. Loopback spellings are
 * interchangeable - Chrome answers on `localhost` and `127.0.0.1` alike - so
 * only the scheme and the effective port distinguish two endpoints on this host.
 */
function canonicalCdpEndpoint(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const host = LOOPBACK_HOSTS.has(parsed.hostname) ? 'localhost' : parsed.hostname.toLowerCase();
  return `${parsed.protocol}//${host}:${port}`;
}

/** True when both names denote the same Chrome debugging endpoint. */
export function sameCdpEndpoint(a: string | undefined, b: string | undefined): boolean {
  const left = canonicalCdpEndpoint(a ?? DEFAULT_CDP_URL);
  const right = canonicalCdpEndpoint(b ?? DEFAULT_CDP_URL);
  return left !== undefined && left === right;
}

/**
 * Refuse to drive one Chrome through a daemon that serves a different one.
 *
 * The daemon and the browser are selected by INDEPENDENT settings, and the
 * browser one has a silent default: `--cdp-url` falls back to
 * `http://localhost:9222` while `CDP_DAEMON_URL` selects only the daemon. A
 * shell that kept CDP_DAEMON_URL but lost CDP_URL therefore resolved every
 * page against the stock browser, where the caller's sessions do not exist -
 * surfacing as SESSION_STORE_STALE or "Page not found", which reads as a
 * corrupt session store rather than a routing mistake.
 *
 * `resolveDaemonUrl` already guards the INVERSE mismatch (a custom browser with
 * no daemon configured) with DAEMON_URL_REQUIRED. This is the missing
 * symmetric guard. It names BOTH endpoints, because either one may be the
 * wrong half.
 *
 * A daemon that does not report its own `cdpUrl` predates this field; the check
 * is then skipped rather than failed, so a mixed-version fleet keeps working.
 */
export function assertDaemonServesConfiguredBrowser(
  daemonUrl: string,
  daemonCdpUrl: string | undefined,
  commandCdpUrl: string | undefined
): void {
  if (daemonCdpUrl === undefined) return;
  if (sameCdpEndpoint(daemonCdpUrl, commandCdpUrl)) return;
  const browser = commandCdpUrl ?? DEFAULT_CDP_URL;
  throw new SessionFoundationError(
    'DAEMON_BROWSER_MISMATCH',
    `Daemon ${daemonUrl} serves Chrome at ${daemonCdpUrl}, but this command targets Chrome at ` +
      `${browser}${commandCdpUrl === undefined ? ' (the default, because neither --cdp-url nor CDP_URL is set)' : ''}. ` +
      'The daemon and the browser are selected independently: set CDP_URL (or --cdp-url) to ' +
      `${daemonCdpUrl}, or point CDP_DAEMON_URL at the daemon started for ${browser}.`,
    {
      daemonUrl,
      daemonCdpUrl,
      commandCdpUrl: browser,
      commandCdpUrlWasDefaulted: commandCdpUrl === undefined,
      defaultCdpUrl: DEFAULT_CDP_URL,
      environmentVariables: ['CDP_URL', 'CDP_DAEMON_URL']
    }
  );
}

/**
 * Pre-flight the daemon/browser agreement for a command that is about to
 * resolve workspace sessions WITHOUT going through `DaemonClient` first.
 *
 * The session store is keyed by the Chrome endpoint, so a misrouted command
 * opens the WRONG store and fails as `SESSION_STORE_STALE` - "persisted
 * sessions belong to a different browser instance" - which reads as a corrupt
 * store rather than as the routing mistake it is. Checking here means the
 * misroute is named before the store can be blamed for it.
 *
 * Only an EXPLICITLY configured daemon is probed. Without `CDP_DAEMON_URL`
 * there is no independent second setting to disagree with: the daemon is
 * either the stock one for the stock browser, or `resolveDaemonUrl` has
 * already refused to guess (`DAEMON_URL_REQUIRED`).
 */
export async function assertConfiguredDaemonServesBrowser(cdpUrl: string | undefined): Promise<void> {
  if (!process.env.CDP_DAEMON_URL?.trim()) return;
  await new DaemonClient({ cdpUrl }).assertServesConfiguredBrowser();
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
  private endpointAgreement?: Promise<void>;

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
   * Daemon base URL for any request that resolves pages or sessions, verified
   * once per client to serve the browser this command targets.
   *
   * Lifecycle commands (`isRunning`, start/stop/status) deliberately use
   * `baseUrl` directly: they are how a caller inspects or repairs a daemon, so
   * they must not require agreement first.
   */
  private async base(): Promise<string> {
    const baseUrl = this.baseUrl;
    this.endpointAgreement ??= this.checkEndpointAgreement(baseUrl);
    try {
      await this.endpointAgreement;
    } catch (error) {
      // A real mismatch is a permanent configuration fault: keep it memoised so
      // every later call reports it identically instead of re-probing.
      throw error;
    }
    return baseUrl;
  }

  /**
   * Verify the daemon/browser agreement on its own, for callers that resolve
   * sessions without issuing a daemon request first.
   */
  async assertServesConfiguredBrowser(): Promise<void> {
    await this.base();
  }

  private async checkEndpointAgreement(baseUrl: string): Promise<void> {
    let daemonCdpUrl: string | undefined;
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok) return; // Not a mismatch; the caller's own request will fail.
      const body = await res.json() as { cdpUrl?: unknown };
      daemonCdpUrl = typeof body.cdpUrl === 'string' ? body.cdpUrl : undefined;
    } catch {
      // Unreachable or unparseable daemon is not evidence of a mismatch. Let
      // the actual request produce the actual failure.
      return;
    }
    assertDaemonServesConfiguredBrowser(baseUrl, daemonCdpUrl, this.options.cdpUrl);
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
    const res = await (globalThis.fetch ?? undiciFetch)(`${await this.base()}/sessions`, {
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
    const baseUrl = await this.base();
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
    const res = await (globalThis.fetch ?? undiciFetch)(`${await this.base()}/sessions`);
    const data = await res.json() as { sessions: any[] };
    return data.sessions ?? [];
  }

  /** Get the daemon's bounded JavaScript-dialog state for a page. */
  async getDialogStatus(pageId: string, workspaceSession?: string): Promise<DaemonDialogStatus> {
    const url = `${await this.base()}/sessions/${encodeURIComponent(pageId)}/dialog-status${sessionQuery(workspaceSession)}`;
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

    const url = `${await this.base()}/logs/console/${encodeURIComponent(pageId)}?${params}`;
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
    const url = `${await this.base()}/logs/detail/${encodeURIComponent(pageId)}/${messageId}${sessionQuery(workspaceSession)}`;
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

    const url = `${await this.base()}/logs/network/${encodeURIComponent(pageId)}?${params}`;
    const res = await (globalThis.fetch ?? undiciFetch)(url);

    if (!res.ok) throwRemoteError(await res.json() as RemoteError, 'Failed to get logs');

    const data = await res.json() as { logs: NetworkRequest[] };
    return data.logs ?? [];
  }

  /**
   * Clear logs for a page
   */
  async clearLogs(pageId: string, workspaceSession?: string): Promise<boolean> {
    const baseUrl = await this.base();
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
    workspace?: { sessionName: string; leaseId?: string },
    timeoutMs?: number
  ): Promise<any> {
    const res = await (globalThis.fetch ?? undiciFetch)(
      `${await this.base()}/exec/${encodeURIComponent(pageId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          params,
          workspaceSession: workspace?.sessionName,
          workspaceLeaseId: workspace?.leaseId,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        })
      }
    );

    const data = await res.json() as {
      result?: any;
      error?: string;
      timedOut?: boolean;
      method?: string;
      timeoutMs?: number;
    };
    if (!res.ok) {
      // A round-trip cap is not a page failure. Rebuild the typed error so the
      // caller can name the cap it exceeded instead of reporting a generic
      // command failure.
      if (data.timedOut === true) {
        throw new CommandTimeoutError(
          typeof data.method === 'string' ? data.method : method,
          typeof data.timeoutMs === 'number' ? data.timeoutMs : 0
        );
      }
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
      `${await this.base()}/exec-batch`,
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
    const res = await (globalThis.fetch ?? undiciFetch)(`${await this.base()}/workspace-leases`, {
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
