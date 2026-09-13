import { WebSocket } from 'ws';
import { fetch as undiciFetch } from 'undici';
import {
  FlattenedSessionTransport,
  type CDPEvent,
  type CDPSocket
} from './transport.js';
import {
  TargetRegistry,
  type ProtocolTargetInfo,
  type TargetExecutionContext,
  type TargetRecord
} from './target-registry.js';

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

export interface BrowserConnectionOptions {
  /** Test seam; production callers should use the default WebSocket. */
  socketFactory?: (validatedBrowserEndpoint: string) => CDPSocket;
  /** Test seam; production callers should use the configured global fetch. */
  fetch?: FetchLike;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * How long opening the connection may spend eagerly configuring the pages
   * that already exist. A blocked renderer answers no command at all, so this
   * must be far shorter than `commandTimeoutMs`: see `initialize()`. This caps
   * only how long opening WAITS; when the work finishes sooner - including when
   * it fails sooner, because `commandTimeoutMs` is short - the cap never binds.
   */
  startupConfigureTimeoutMs?: number;
}

/** Upper bound on the eager whole-browser configuration done while opening. */
const DEFAULT_STARTUP_CONFIGURE_TIMEOUT_MS = 2_000;

const RELEVANT_TARGET_FILTER = [
  { type: 'page', exclude: false },
  { type: 'iframe', exclude: false },
  { exclude: true }
];

/**
 * A browser-target CDP connection with flattened child sessions.
 *
 * Callers supply only the HTTP remote-debugging endpoint. The WebSocket URL is
 * fetched from Chrome, validated against that endpoint, used transiently, and
 * never exposed by the connection or target registry.
 */
export class BrowserConnection {
  readonly registry = new TargetRegistry();

  private readonly sessionConfiguration = new Map<string, Promise<void>>();
  /** Bumped whenever a new configuration is installed. Eviction can keep the
   * map the same size while replacing its contents, so a size-based drain can
   * finish while a replacement is still in flight. Count installations. */
  private configurationGeneration = 0;
  private readonly disposeEventListener: () => void;
  private closed = false;

  private constructor(
    private readonly transport: FlattenedSessionTransport,
    readonly browserInstanceId: string,
    private readonly startupConfigureTimeoutMs: number = DEFAULT_STARTUP_CONFIGURE_TIMEOUT_MS
  ) {
    this.disposeEventListener = transport.onEvent((event) => this.handleEvent(event));
  }

  static async open(
    cdpUrl: string,
    options: BrowserConnectionOptions = {}
  ): Promise<BrowserConnection> {
    const httpEndpoint = validateHttpEndpoint(cdpUrl);
    const fetchImpl = options.fetch ?? ((globalThis.fetch ?? undiciFetch) as unknown as FetchLike);
    const browserEndpoint = await fetchBrowserWebSocketEndpoint(
      httpEndpoint,
      fetchImpl,
      options.connectTimeoutMs ?? 10_000
    );
    const socket = options.socketFactory
      ? options.socketFactory(browserEndpoint.toString())
      : (new WebSocket(browserEndpoint.toString()) as unknown as CDPSocket);

    try {
      await waitForSocketOpen(socket, options.connectTimeoutMs ?? 10_000);
      const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
      const connection = new BrowserConnection(
        new FlattenedSessionTransport(socket, commandTimeoutMs),
        browserInstanceIdFromEndpoint(browserEndpoint),
        options.startupConfigureTimeoutMs ?? DEFAULT_STARTUP_CONFIGURE_TIMEOUT_MS
      );
      await connection.initialize();
      return connection;
    } catch (error) {
      try {
        socket.close();
      } catch {
        // The opening error is the useful failure.
      }
      throw error;
    }
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<any> {
    this.assertOpen();
    return this.transport.send(method, params, sessionId);
  }

  async refreshTargets(): Promise<TargetRecord[]> {
    const result = await this.send('Target.getTargets');
    for (const info of arrayOfTargetInfo(result?.targetInfos)) {
      this.registry.upsertTarget(info);
    }
    return this.registry.list();
  }

  /** Resolve a literal target id. Titles, URLs, and substrings are never used. */
  resolveTarget(targetId: string): TargetRecord {
    if (!targetId) throw new Error('A targetId is required');
    const target = this.registry.getByTargetId(targetId);
    if (!target) {
      throw new Error(`Target not found by exact targetId: ${targetId}`);
    }
    return target;
  }

  async ensureTargetSession(targetId: string): Promise<TargetRecord> {
    // A detach plus re-attach can land between configuring a session and
    // reading the registry back, which would hand the caller a record whose
    // session was never configured (or none at all, sending the command at
    // browser scope). Verify the record still owns the session that was
    // configured, and restart at most once so target churn cannot loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      let target = this.resolveTarget(targetId);
      if (target.type !== 'page' && target.type !== 'iframe') {
        throw new Error(`Target ${targetId} has unsupported type: ${target.type}`);
      }

      if (!target.sessionId) {
        const attached = await this.send('Target.attachToTarget', {
          targetId,
          flatten: true
        });
        if (typeof attached?.sessionId !== 'string' || !attached.sessionId) {
          throw new Error(`Chrome did not return a session for targetId: ${targetId}`);
        }

        // Chrome normally emits attachedToTarget before the command response.
        // Record the response as a deterministic fallback for older builds.
        target = this.registry.getBySessionId(attached.sessionId)
          ?? this.registry.attachSession(attached.sessionId, targetToProtocolInfo(target));
      }

      const sessionId = target.sessionId!;
      await this.configureSession(sessionId);
      const current = this.resolveTarget(targetId);
      if (current.sessionId === sessionId) return current;
    }

    throw new Error(
      `Target ${targetId} kept re-attaching while its session was configured`
    );
  }

  async sendToTarget(
    targetId: string,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<any> {
    const target = await this.ensureTargetSession(targetId);
    return this.send(method, params, target.sessionId);
  }

  async getDefaultExecutionContext(
    targetId: string,
    timeoutMs = 2_000
  ): Promise<TargetExecutionContext> {
    const target = await this.ensureTargetSession(targetId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const context = this.registry.getDefaultExecutionContext(target.sessionId!);
      if (context) return context;
      if (Date.now() >= deadline) {
        throw new Error(
          `No unambiguous default execution context exists for targetId: ${targetId}`
        );
      }
      await delay(20);
    }
  }

  async waitForTarget(
    predicate: (target: TargetRecord) => boolean,
    timeoutMs = 1_500
  ): Promise<TargetRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.registry.list().find(predicate);
      if (match) return match;
      if (Date.now() >= deadline) return undefined;
      await this.refreshTargets();
      await delay(25);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disposeEventListener();
    this.transport.close();
  }

  private async initialize(): Promise<void> {
    await this.send('Target.setDiscoverTargets', { discover: true });
    await this.refreshTargets();
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: RELEVANT_TARGET_FILTER
    });

    // Browser-level auto-attach covers current Chrome, while the explicit
    // attach makes the contract deterministic on older Chrome versions.
    //
    // Opening the browser connection is a whole-browser operation, so it must
    // cost a BOUNDED amount of time. One page whose renderer is blocked answers
    // no command at all, and this used to await it for the full command timeout
    // here and then again in the drain. Swallowing the rejection was never
    // enough - the latency is the defect, and it is paid by every other page
    // and every other caller sharing this browser. Measured on the live fleet
    // daemon with one wedged page out of twelve: 60s per workspace-lease
    // acquire and 37s per dialog-status call, for every agent on the machine,
    // because the daemon opens a fresh connection on every request.
    //
    // So: configure the existing pages concurrently, and stop WAITING after a
    // short budget. Stopping waiting is not abandoning the work. An unfinished
    // configuration stays in flight and memoised in `sessionConfiguration`, so
    // an operation that genuinely targets that page still awaits that same
    // promise and still reports its real error.
    // ONE budget for the whole eager phase, not one per step: the loop and the
    // drain both wait on the same blocked renderer, so a per-step budget would
    // be paid twice.
    const deadline = Date.now() + this.startupConfigureTimeoutMs;
    const pages = this.registry.list().filter((target) => target.type === 'page');
    await withTimeBudget(
      // allSettled, so one blocked or dead renderer cannot reject the batch.
      Promise.allSettled(pages.map((page) => this.ensureTargetSession(page.targetId))),
      deadline - Date.now()
    );
    await this.refreshTargets();
    await withTimeBudget(this.drainSessionConfiguration(), deadline - Date.now());
  }

  private handleEvent(event: CDPEvent): void {
    if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
      if (isTargetInfo(event.params.targetInfo)) {
        this.registry.upsertTarget(event.params.targetInfo);
      }
      return;
    }

    if (event.method === 'Target.targetDestroyed') {
      if (typeof event.params.targetId === 'string') {
        this.registry.removeTarget(event.params.targetId);
      }
      return;
    }

    if (event.method === 'Target.attachedToTarget') {
      const sessionId = event.params.sessionId;
      const targetInfo = event.params.targetInfo;
      if (typeof sessionId !== 'string' || !isTargetInfo(targetInfo)) return;
      this.registry.attachSession(sessionId, targetInfo, event.sessionId);
      if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
        // Event handlers cannot block the transport. Keep the promise so any
        // operation on this session observes configuration success or failure.
        void this.configureSession(sessionId).catch(() => undefined);
      }
      if (event.params.waitingForDebugger === true) {
        void this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
      }
      return;
    }

    if (event.method === 'Target.detachedFromTarget') {
      if (typeof event.params.sessionId === 'string') {
        this.sessionConfiguration.delete(event.params.sessionId);
        this.registry.detachSession(event.params.sessionId);
      }
      return;
    }

    if (!event.sessionId) return;
    if (event.method === 'Runtime.executionContextCreated') {
      this.registry.recordExecutionContext(event.sessionId, event.params.context);
    } else if (event.method === 'Runtime.executionContextDestroyed') {
      this.registry.removeExecutionContext(
        event.sessionId,
        typeof event.params.executionContextId === 'number'
          ? event.params.executionContextId
          : undefined,
        typeof event.params.executionContextUniqueId === 'string'
          ? event.params.executionContextUniqueId
          : undefined
      );
    } else if (event.method === 'Runtime.executionContextsCleared') {
      this.registry.clearExecutionContexts(event.sessionId);
    }
  }

  private configureSession(sessionId: string): Promise<void> {
    const existing = this.sessionConfiguration.get(sessionId);
    if (existing) return existing;

    const configuration = (async () => {
      await this.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: RELEVANT_TARGET_FILTER
      }, sessionId);
      await this.send('Page.enable', {}, sessionId);
      await this.send('Runtime.enable', {}, sessionId);
    })();

    // A failed configuration must not be cached. A renderer busy past the
    // command timeout used to poison this entry permanently, so every later
    // operation on the session rethrew the same rejection without ever
    // resending Page.enable. Evict on rejection so the next operation makes a
    // fresh attempt - exactly one attempt per operation, never a retry loop.
    // Evict only if the map still holds THIS promise: a detach plus re-attach
    // can install a newer in-flight configuration that must not be clobbered.
    const tracked: Promise<void> = configuration.catch((error: unknown) => {
      if (this.sessionConfiguration.get(sessionId) === tracked) {
        this.sessionConfiguration.delete(sessionId);
      }
      throw error;
    });
    this.sessionConfiguration.set(sessionId, tracked);
    this.configurationGeneration++;
    return tracked;
  }

  private async drainSessionConfiguration(): Promise<void> {
    // Attaching an iframe can attach another nested iframe while this batch is
    // settling, so repeat until no further configuration has been installed.
    // A size check is not enough: eviction plus a replacement attach leaves the
    // map the same size while a new promise is still pending. Failures are
    // per-session: one blocked renderer must not deny the whole browser
    // connection. The rejected entry has already been evicted, so an operation
    // that genuinely needs that session will retry and surface its real error.
    let observed = -1;
    while (observed !== this.configurationGeneration) {
      observed = this.configurationGeneration;
      await Promise.allSettled([...this.sessionConfiguration.values()]);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Browser connection is closed');
  }
}

function validateHttpEndpoint(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('CDP endpoint must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CDP endpoint must use http or https; WebSocket URLs are not accepted');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('CDP endpoint must not contain credentials, a query string, or a fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

async function fetchBrowserWebSocketEndpoint(
  httpEndpoint: URL,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<URL> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      `${httpEndpoint.toString().replace(/\/$/, '')}/json/version`,
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Chrome browser endpoint: ${response.status} ${response.statusText}`);
  }
  const version = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof version.webSocketDebuggerUrl !== 'string') {
    throw new Error('Chrome did not publish a browser WebSocket endpoint');
  }

  let browserEndpoint: URL;
  try {
    browserEndpoint = new URL(version.webSocketDebuggerUrl);
  } catch {
    throw new Error('Chrome published an invalid browser WebSocket endpoint');
  }
  const expectedProtocol = httpEndpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  if (browserEndpoint.protocol !== expectedProtocol) {
    throw new Error('Chrome browser WebSocket protocol does not match the CDP endpoint');
  }
  if (!sameEndpointAuthority(httpEndpoint, browserEndpoint)) {
    throw new Error('Chrome browser WebSocket authority does not match the CDP endpoint');
  }
  if (!browserEndpoint.pathname.startsWith('/devtools/browser/')) {
    throw new Error('Chrome published a non-browser WebSocket endpoint');
  }
  if (browserEndpoint.username || browserEndpoint.password || browserEndpoint.hash) {
    throw new Error('Chrome published an unsafe browser WebSocket endpoint');
  }
  return browserEndpoint;
}

function sameEndpointAuthority(httpEndpoint: URL, browserEndpoint: URL): boolean {
  const sameHost = httpEndpoint.hostname.toLowerCase() === browserEndpoint.hostname.toLowerCase()
    || (isLoopbackHost(httpEndpoint.hostname) && isLoopbackHost(browserEndpoint.hostname));
  return sameHost && effectivePort(httpEndpoint) === effectivePort(browserEndpoint);
}

function browserInstanceIdFromEndpoint(endpoint: URL): string {
  const prefix = '/devtools/browser/';
  const id = decodeURIComponent(endpoint.pathname.slice(prefix.length));
  if (!id) throw new Error('Chrome browser endpoint did not contain an instance ID');
  return id;
}

function effectivePort(endpoint: URL): string {
  if (endpoint.port) return endpoint.port;
  return endpoint.protocol === 'https:' || endpoint.protocol === 'wss:' ? '443' : '80';
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function waitForSocketOpen(socket: CDPSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out connecting to Chrome browser target')), timeoutMs);
    const onOpen = (): void => finish();
    const onError = (): void => finish(new Error('Failed to connect to Chrome browser target'));
    const onClose = (): void => finish(new Error('Chrome browser target closed while connecting'));
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    socket.on('open', onOpen);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function isTargetInfo(value: unknown): value is ProtocolTargetInfo {
  return Boolean(value)
    && typeof (value as ProtocolTargetInfo).targetId === 'string'
    && typeof (value as ProtocolTargetInfo).type === 'string';
}

function arrayOfTargetInfo(value: unknown): ProtocolTargetInfo[] {
  return Array.isArray(value) ? value.filter(isTargetInfo) : [];
}

function targetToProtocolInfo(target: TargetRecord): ProtocolTargetInfo {
  return {
    targetId: target.targetId,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: target.attached,
    ...(target.parentTargetId ? { parentId: target.parentTargetId } : {}),
    ...(target.parentFrameId ? { parentFrameId: target.parentFrameId } : {}),
    ...(target.browserContextId ? { browserContextId: target.browserContextId } : {}),
    ...(target.subtype ? { subtype: target.subtype } : {})
  };
}

/**
 * Wait for `work`, but give up waiting after `budgetMs` and resolve anyway.
 *
 * The work is NOT cancelled - it keeps running and stays memoised for whoever
 * actually needs it. This exists so that a whole-browser operation cannot be
 * held hostage by one unresponsive renderer. `work` must not reject: callers
 * pass an `allSettled`-backed promise, and the `catch` below is only a
 * belt-and-braces guard against an unhandled rejection warning.
 */
function withTimeBudget(work: Promise<unknown>, budgetMs: number): Promise<void> {
  void work.catch(() => undefined);
  if (budgetMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budgetMs);
    // Do not keep the event loop alive purely to finish opening a connection.
    timer.unref?.();
    void work.then(() => {
      clearTimeout(timer);
      resolve();
    }, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
