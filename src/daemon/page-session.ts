/**
 * Page session - maintains WebSocket connection and log buffers for a single page
 */

import { WebSocket } from 'ws';
import { CircularBuffer } from './circular-buffer.js';
import type { ConsoleMessage, NetworkRequest, CDPMessage, StackFrame, DialogInfo } from '../context.js';
import { CommandTimeoutError } from '../cdp/command-timeout.js';

const DEFAULT_BUFFER_SIZE = 500;
const DIALOG_PROBE_TIMEOUT_MS = 350;
const MAX_DIALOG_MESSAGE_LENGTH = 1_000;

export interface PageDialogStatus {
  open: boolean;
  /** Present only when Page.javascriptDialogOpening was observed by this daemon. */
  dialog?: DialogInfo;
  observedAt?: number;
  /** A short probe can infer an already-open dialog but cannot reveal its text. */
  inferred?: boolean;
  /** The bounded probe failed, but no dialog event was observed. */
  probeUnavailable?: boolean;
}

export interface PageSessionOptions {
  pageId: string;
  webSocketUrl: string;
  bufferSize?: number;
  onClose?: () => void;
}

export class PageSession {
  readonly pageId: string;
  private webSocketUrl: string;
  private ws: WebSocket | null = null;
  private messageId = 1;
  private consoleId = 1;

  private consoleBuffer: CircularBuffer<ConsoleMessage>;
  private consoleById: Map<number, ConsoleMessage> = new Map();
  private networkBuffer: CircularBuffer<NetworkRequest>;
  private networkRequests: Map<string, NetworkRequest> = new Map();
  private dialogStatus: PageDialogStatus = { open: false };

  private closed = false;
  private onCloseCallback?: () => void;

  constructor(options: PageSessionOptions) {
    this.pageId = options.pageId;
    this.webSocketUrl = options.webSocketUrl;
    this.onCloseCallback = options.onClose;

    const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.consoleBuffer = new CircularBuffer(bufferSize);
    this.networkBuffer = new CircularBuffer(bufferSize);
  }

  /**
   * Connect and start logging
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('Session is closed');
    }

    // A connect that does not complete MUST NOT leave its socket open. The
    // reject paths below run with the socket already ESTABLISHED (the open
    // handler rejects when `enableLogging` fails - a wedged renderer answers
    // neither Runtime.enable nor Network.enable), and `ws` pins its TCP socket
    // to the event loop, so an unclosed one is never collected. The caller in
    // `Daemon.registerPage` drops the session on failure, and the 5s health
    // check re-registers any page that is not in `sessions` - which a failed
    // registration never is. One page that cannot register therefore leaked one
    // ESTABLISHED socket every 5 seconds, without bound, until the machine ran
    // out of ephemeral ports. Measured at ~1/tick from a single wedged page.
    try {
      await new Promise<void>((resolve, reject) => {
        this.ws = new WebSocket(this.webSocketUrl);

        this.ws.on('open', async () => {
          try {
            await this.enableLogging();
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('close', () => {
          this.ws = null;
          if (!this.closed && this.onCloseCallback) {
            this.onCloseCallback();
          }
          // A socket that closes before the handshake completes must settle
          // this promise; otherwise `connect()` never returns and the caller
          // holds the session forever.
          reject(new Error(`Page ${this.pageId} closed its debugging connection while connecting`));
        });

        this.ws.on('error', (err) => {
          reject(err);
        });
      });
    } catch (error) {
      this.abortSocket();
      throw error;
    }
  }

  /**
   * Discard the socket of a connection that failed to come up.
   *
   * `terminate()` rather than `close()`: this connection is being thrown away,
   * a close handshake with an endpoint that just failed us may never complete
   * (ws then holds the socket for its own 30s close timeout), and an abort
   * leaves no TIME_WAIT behind for a path the health check retries every 5s.
   */
  private abortSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.terminate();
    } catch {
      // Already gone; the socket is what mattered.
    }
  }

  /**
   * Enable the domains used by logs and dialog state. Page.enable is bounded:
   * an already-open modal must not make daemon registration wait for a normal
   * command timeout.
   */
  private async enableLogging(): Promise<void> {
    if (!this.ws) return;

    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Network.enable');
    try {
      await this.sendCommand('Page.enable', undefined, DIALOG_PROBE_TIMEOUT_MS);
    } catch {
      // Page events may be unavailable while a modal is already blocking. The
      // status endpoint will make one equally short best-effort probe later.
    }
  }

  /**
   * Send CDP command (public for daemon command execution)
   */
  sendCommand(method: string, params?: any, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = this.messageId++;

      const messageHandler = (data: Buffer) => {
        const message: CDPMessage = JSON.parse(data.toString());
        if (message.id === id) {
          clearTimeout(timeout);
          this.ws?.off('message', messageHandler);
          if (message.error) {
            reject(new Error(message.error.message || 'CDP command failed'));
          } else {
            resolve(message.result);
          }
        }
      };

      const timeout = setTimeout(() => {
        this.ws?.off('message', messageHandler);
        reject(new CommandTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.ws.on('message', messageHandler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Handle incoming CDP message
   */
  private handleMessage(data: Buffer): void {
    const message: CDPMessage = JSON.parse(data.toString());

    // Console messages
    if (message.method === 'Runtime.consoleAPICalled') {
      const { type, args, timestamp, stackTrace } = message.params;
      const text = args.map((arg: any) => {
        if (arg.value !== undefined) return String(arg.value);
        if (arg.description !== undefined) return arg.description;
        return JSON.stringify(arg);
      }).join(' ');

      // Parse stack trace if available
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

      this.consoleBuffer.push(consoleMsg);
      this.consoleById.set(consoleMsg.id, consoleMsg);
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const { exceptionDetails, timestamp } = message.params;

      // Parse exception stack trace
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

      this.consoleBuffer.push(consoleMsg);
      this.consoleById.set(consoleMsg.id, consoleMsg);
    }

    if (message.method === 'Page.javascriptDialogOpening') {
      const params = message.params ?? {};
      this.dialogStatus = {
        open: true,
        dialog: sanitizeDialog(params),
        observedAt: Date.now()
      };
    }

    if (message.method === 'Page.javascriptDialogClosed') {
      this.dialogStatus = { open: false };
    }

    // Network requests
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request, timestamp, type, redirectResponse } = message.params;
      let isNewRequest = !this.networkRequests.has(requestId);

      // Chrome reuses requestId across a redirect chain. Keep the completed hop
      // in the log and start a new record for the next URL.
      if (redirectResponse && this.networkRequests.has(requestId)) {
        this.updateNetworkRequest(requestId, {
          url: redirectResponse.url,
          status: redirectResponse.status,
          responseHeaders: redirectResponse.headers
        });
        this.networkRequests.delete(requestId);
        isNewRequest = true;
      }

      const entry = this.updateNetworkRequest(requestId, {
        url: request.url,
        method: request.method,
        timestamp: timestamp * 1000,
        type,
        requestHeaders: request.headers
      });

      // The same requestWillBeSent can be observed more than once; the buffer
      // receives one entry per request hop, while later events update it in place.
      if (isNewRequest) {
        this.networkBuffer.push(entry);
      }
    }

    if (message.method === 'Network.responseReceived') {
      const { requestId, response, type } = message.params;
      this.updateNetworkRequest(requestId, {
        url: response.url || undefined,
        status: response.status,
        responseHeaders: response.headers,
        type: type ?? undefined
      });
    }

    if (message.method === 'Network.loadingFinished') {
      const { requestId, encodedDataLength } = message.params;
      this.updateNetworkRequest(requestId, {
        size: encodedDataLength
      });
      this.networkRequests.delete(requestId);
    }

    if (message.method === 'Network.loadingFailed') {
      const { requestId, errorText, canceled, blockedReason, corsErrorStatus } = message.params;
      this.updateNetworkRequest(requestId, {
        failure: {
          errorText: errorText ?? 'Request failed',
          canceled: canceled === true,
          ...(blockedReason !== undefined && { blockedReason }),
          ...(corsErrorStatus !== undefined && { corsErrorStatus })
        }
      });
      this.networkRequests.delete(requestId);
    }
  }

  /**
   * Update network request entry
   */
  private updateNetworkRequest(requestId: string, patch: Partial<NetworkRequest>): NetworkRequest {
    const current = this.networkRequests.get(requestId);

    if (current) {
      // The buffer stores this same object. Mutating it is deliberate: replacing
      // the map entry would leave the persistent log with stale request data.
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
          (current as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return current;
    }

    const next: NetworkRequest = {
      id: requestId,
      url: patch.url ?? '',
      method: patch.method ?? 'GET',
      timestamp: patch.timestamp ?? Date.now(),
      type: patch.type,
      status: patch.status,
      size: patch.size,
      requestHeaders: patch.requestHeaders,
      responseHeaders: patch.responseHeaders,
      failure: patch.failure
    };

    this.networkRequests.set(requestId, next);
    return next;
  }

  /**
   * Get last N console messages
   */
  getConsoleLogs(count?: number): ConsoleMessage[] {
    if (count === undefined) {
      return this.consoleBuffer.getAll();
    }
    return this.consoleBuffer.getLast(count).reverse(); // Return in chronological order
  }

  /**
   * Get a specific console message by ID
   */
  getConsoleMessage(id: number): ConsoleMessage | undefined {
    return this.consoleById.get(id);
  }

  /**
   * Get last N network requests
   */
  getNetworkLogs(count?: number): NetworkRequest[] {
    if (count === undefined) {
      return this.networkBuffer.getAll();
    }
    return this.networkBuffer.getLast(count).reverse(); // Return in chronological order
  }

  /**
   * Return the latest dialog state without issuing an unbounded CDP command.
   * Page events cover dialogs opened after registration. For a dialog that was
   * already open, a short Runtime probe provides a deliberately conservative
   * best-effort signal with no retained sensitive prompt text.
   */
  async getDialogStatus(): Promise<PageDialogStatus> {
    if (this.dialogStatus.open) return cloneDialogStatus(this.dialogStatus);
    if (!this.isConnected) return { open: false };

    try {
      await this.sendCommand('Runtime.evaluate', { expression: '1', timeout: 200 }, DIALOG_PROBE_TIMEOUT_MS);
      return { open: false };
    } catch {
      return {
        open: false,
        probeUnavailable: true
      };
    }
  }

  /**
   * Clear all buffers
   */
  clearLogs(): void {
    this.consoleBuffer.clear();
    this.consoleById.clear();
    this.networkBuffer.clear();
    this.networkRequests.clear();
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get buffer stats
   */
  getStats(): { console: number; network: number; connected: boolean } {
    return {
      console: this.consoleBuffer.size,
      network: this.networkBuffer.size,
      connected: this.isConnected
    };
  }

  /**
   * Close the session
   */
  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

function sanitizeDialog(params: Record<string, unknown>): DialogInfo {
  const type = params.type;
  return {
    type: type === 'confirm' || type === 'prompt' || type === 'beforeunload' ? type : 'alert',
    message: redactAndBound(typeof params.message === 'string' ? params.message : ''),
    url: redactUrl(typeof params.url === 'string' ? params.url : '')
    // Never persist defaultPrompt: it can contain form data or other sensitive input.
  };
}

function cloneDialogStatus(status: PageDialogStatus): PageDialogStatus {
  return {
    open: status.open,
    ...(status.dialog && { dialog: { ...status.dialog } }),
    ...(status.observedAt !== undefined && { observedAt: status.observedAt }),
    ...(status.inferred && { inferred: true }),
    ...(status.probeUnavailable && { probeUnavailable: true })
  };
}

function redactAndBound(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, redactUrl).slice(0, MAX_DIALOG_MESSAGE_LENGTH);
}

function redactUrl(input: string): string {
  if (!input) return input;
  try {
    const url = new URL(input);
    for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, '[REDACTED]');
    return url.toString();
  } catch {
    const queryIndex = input.indexOf('?');
    return queryIndex === -1 ? input : `${input.slice(0, queryIndex)}?[REDACTED_QUERY]`;
  }
}
