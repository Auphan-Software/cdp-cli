/**
 * A small transport for Chrome's flattened Target sessions.
 *
 * The browser WebSocket carries both browser commands and commands addressed
 * to child sessions. In flat mode the latter use the top-level `sessionId`
 * field; the deprecated Target.sendMessageToTarget tunnel is never needed.
 */

export interface CDPSocket {
  readonly readyState?: number;
  send(data: string): void;
  close(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'open', listener: () => void): unknown;
  off(event: 'message', listener: (data: unknown) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

export interface CDPEvent {
  method: string;
  params: Record<string, any>;
  /** The session which emitted the event, absent for browser-level events. */
  sessionId?: string;
}

interface PendingCommand {
  method: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ProtocolMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  sessionId?: string;
  result?: any;
  error?: {
    code?: number;
    message?: string;
  };
}

export type CDPEventListener = (event: CDPEvent) => void;

export class CDPCommandError extends Error {
  readonly method: string;
  readonly code?: number;

  constructor(method: string, message: string, code?: number) {
    super(`CDP command ${method} failed: ${message}`);
    this.name = 'CDPCommandError';
    this.method = method;
    this.code = code;
  }
}

/** Multiplexes browser commands and flattened child-session commands. */
export class FlattenedSessionTransport {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Set<CDPEventListener>();
  private readonly onMessageBound = (data: unknown): void => this.handleMessage(data);
  private readonly onCloseBound = (): void => this.handleClose();
  private readonly onErrorBound = (error: Error): void => this.handleSocketError(error);

  constructor(
    private readonly socket: CDPSocket,
    private readonly commandTimeoutMs = 30_000
  ) {
    socket.on('message', this.onMessageBound);
    socket.on('close', this.onCloseBound);
    socket.on('error', this.onErrorBound);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<any> {
    if (this.closed) {
      return Promise.reject(new Error(`Browser connection is closed; cannot send ${method}`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.commandTimeoutMs);

      this.pending.set(id, { method, resolve, reject, timeout });

      try {
        this.socket.send(JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {})
        }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(listener: CDPEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachSocketListeners();
    this.rejectAll(new Error('Browser connection closed'));
    this.socket.close();
  }

  private handleMessage(data: unknown): void {
    let message: ProtocolMessage;
    try {
      message = JSON.parse(toMessageText(data)) as ProtocolMessage;
    } catch {
      // Chrome is the trusted producer for this socket. An invalid frame
      // cannot be correlated safely, so leave it out of the command stream.
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CDPCommandError(
          pending.method,
          message.error.message ?? 'unknown protocol error',
          message.error.code
        ));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    const event: CDPEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {})
    };
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachSocketListeners();
    this.rejectAll(new Error('Browser connection closed unexpectedly'));
  }

  private handleSocketError(error: Error): void {
    if (this.closed) return;
    this.rejectAll(new Error(`Browser connection failed: ${error.message}`));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private detachSocketListeners(): void {
    this.socket.off('message', this.onMessageBound);
    this.socket.off('close', this.onCloseBound);
    this.socket.off('error', this.onErrorBound);
  }
}

function toMessageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    return Buffer.concat(data).toString();
  }
  return String(data);
}
