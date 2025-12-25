/**
 * Page session - maintains WebSocket connection and log buffers for a single page
 */

import { WebSocket } from 'ws';
import { CircularBuffer } from './circular-buffer.js';
import type { ConsoleMessage, NetworkRequest, CDPMessage, StackFrame } from '../context.js';

const DEFAULT_BUFFER_SIZE = 500;

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

    return new Promise((resolve, reject) => {
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
      });

      this.ws.on('error', (err) => {
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  /**
   * Enable Runtime and Network domains
   */
  private async enableLogging(): Promise<void> {
    if (!this.ws) return;

    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Network.enable');
  }

  /**
   * Send CDP command (public for daemon command execution)
   */
  sendCommand(method: string, params?: any): Promise<any> {
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
        reject(new Error(`Command timeout: ${method}`));
      }, 10000);

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

    // Network requests
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request, timestamp, type } = message.params;
      const entry = this.updateNetworkRequest(requestId, {
        url: request.url,
        method: request.method,
        timestamp: timestamp * 1000,
        type,
        requestHeaders: request.headers
      });
      // Only push to buffer on initial request
      this.networkBuffer.push(entry);
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
    }
  }

  /**
   * Update network request entry
   */
  private updateNetworkRequest(requestId: string, patch: Partial<NetworkRequest>): NetworkRequest {
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
