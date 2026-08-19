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
}

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
  private readonly disposeEventListener: () => void;
  private closed = false;

  private constructor(
    private readonly transport: FlattenedSessionTransport,
    readonly browserInstanceId: string
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
      const connection = new BrowserConnection(
        new FlattenedSessionTransport(socket, options.commandTimeoutMs ?? 30_000),
        browserInstanceIdFromEndpoint(browserEndpoint)
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

    await this.configureSession(target.sessionId!);
    return this.resolveTarget(targetId);
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
    for (const page of this.registry.list().filter((target) => target.type === 'page')) {
      await this.ensureTargetSession(page.targetId);
    }
    await this.refreshTargets();
    await this.drainSessionConfiguration();
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
    this.sessionConfiguration.set(sessionId, configuration);
    return configuration;
  }

  private async drainSessionConfiguration(): Promise<void> {
    // Attaching an iframe can attach another nested iframe while this batch is
    // settling, so repeat until the promise set stops growing.
    let observed = -1;
    while (observed !== this.sessionConfiguration.size) {
      observed = this.sessionConfiguration.size;
      await Promise.all(this.sessionConfiguration.values());
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
