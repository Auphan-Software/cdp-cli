/**
 * WebSocket shim for Bun runtime.
 * Wraps Bun's native WebSocket (browser API) with Node ws-compatible API.
 * Supports: .on(), .once(), .send(), .close(), .removeListener()
 */
import { EventEmitter } from 'events';

class WebSocketShim extends EventEmitter {
  constructor(url, protocols, options) {
    super();
    this.readyState = 0; // CONNECTING
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;

    this._ws = new globalThis.WebSocket(url, protocols);
    this._ws.binaryType = 'nodebuffer';

    this._ws.addEventListener('open', () => {
      this.readyState = 1;
      this.emit('open');
    });

    this._ws.addEventListener('message', (event) => {
      // Convert to Buffer for Node compat
      const data = event.data;
      this.emit('message', data);
    });

    this._ws.addEventListener('close', (event) => {
      this.readyState = 3;
      this.emit('close', event.code, event.reason);
    });

    this._ws.addEventListener('error', (event) => {
      this.emit('error', event.error || new Error('WebSocket error'));
    });
  }

  send(data, opts, cb) {
    try {
      this._ws.send(data);
      if (typeof cb === 'function') cb();
      if (typeof opts === 'function') opts();
    } catch (err) {
      if (typeof cb === 'function') cb(err);
      else if (typeof opts === 'function') opts(err);
      else this.emit('error', err);
    }
  }

  close(code, reason) {
    this.readyState = 2;
    this._ws.close(code, reason);
  }

  terminate() {
    this.readyState = 3;
    this._ws.close();
  }

  ping() {
    // Bun native WS doesn't support ping frames directly - no-op
  }

  pong() {
    // no-op
  }
}

// Static constants
WebSocketShim.CONNECTING = 0;
WebSocketShim.OPEN = 1;
WebSocketShim.CLOSING = 2;
WebSocketShim.CLOSED = 3;

export { WebSocketShim as WebSocket };
export default WebSocketShim;
