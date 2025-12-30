#!/usr/bin/env node

// build/daemon/daemon.js
import { createServer } from "http";
import { WebSocket as WebSocket3 } from "ws";

// build/daemon/page-session.js
import { WebSocket } from "ws";

// build/daemon/circular-buffer.js
var CircularBuffer = class {
  constructor(capacity) {
    this.head = 0;
    this.count = 0;
    if (capacity <= 0) {
      throw new Error("Capacity must be positive");
    }
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }
  /**
   * Add an item to the buffer
   * If full, overwrites the oldest item
   */
  push(item) {
    const index = (this.head + this.count) % this.capacity;
    this.buffer[index] = item;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }
  /**
   * Get the last N items (most recent first)
   */
  getLast(n) {
    const count = Math.min(n, this.count);
    const result = [];
    for (let i = 0; i < count; i++) {
      const index = (this.head + this.count - 1 - i) % this.capacity;
      result.push(this.buffer[index]);
    }
    return result;
  }
  /**
   * Get all items in chronological order (oldest first)
   */
  getAll() {
    const result = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.capacity;
      result.push(this.buffer[index]);
    }
    return result;
  }
  /**
   * Clear all items
   */
  clear() {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
  /**
   * Current number of items in buffer
   */
  get size() {
    return this.count;
  }
  /**
   * Maximum capacity
   */
  get maxSize() {
    return this.capacity;
  }
};

// build/daemon/page-session.js
var DEFAULT_BUFFER_SIZE = 500;
var PageSession = class {
  constructor(options) {
    this.ws = null;
    this.messageId = 1;
    this.consoleId = 1;
    this.consoleById = /* @__PURE__ */ new Map();
    this.networkRequests = /* @__PURE__ */ new Map();
    this.closed = false;
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
  async connect() {
    if (this.closed) {
      throw new Error("Session is closed");
    }
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.webSocketUrl);
      this.ws.on("open", async () => {
        try {
          await this.enableLogging();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });
      this.ws.on("close", () => {
        this.ws = null;
        if (!this.closed && this.onCloseCallback) {
          this.onCloseCallback();
        }
      });
      this.ws.on("error", (err) => {
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }
  /**
   * Enable Runtime and Network domains
   */
  async enableLogging() {
    if (!this.ws)
      return;
    await this.sendCommand("Runtime.enable");
    await this.sendCommand("Network.enable");
  }
  /**
   * Send CDP command (public for daemon command execution)
   */
  sendCommand(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      const id = this.messageId++;
      const messageHandler = (data) => {
        const message = JSON.parse(data.toString());
        if (message.id === id) {
          clearTimeout(timeout);
          this.ws?.off("message", messageHandler);
          if (message.error) {
            reject(new Error(message.error.message || "CDP command failed"));
          } else {
            resolve(message.result);
          }
        }
      };
      const timeout = setTimeout(() => {
        this.ws?.off("message", messageHandler);
        reject(new Error(`Command timeout: ${method}`));
      }, 1e4);
      this.ws.on("message", messageHandler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /**
   * Handle incoming CDP message
   */
  handleMessage(data) {
    const message = JSON.parse(data.toString());
    if (message.method === "Runtime.consoleAPICalled") {
      const { type, args: args2, timestamp, stackTrace } = message.params;
      const text = args2.map((arg) => {
        if (arg.value !== void 0)
          return String(arg.value);
        if (arg.description !== void 0)
          return arg.description;
        return JSON.stringify(arg);
      }).join(" ");
      const frames = stackTrace?.callFrames?.map((f) => ({
        functionName: f.functionName || "(anonymous)",
        url: f.url,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber
      }));
      const consoleMsg = {
        id: this.consoleId++,
        type,
        timestamp: timestamp || Date.now(),
        text,
        source: "console-api",
        args: args2,
        stackTrace: frames
      };
      this.consoleBuffer.push(consoleMsg);
      this.consoleById.set(consoleMsg.id, consoleMsg);
    }
    if (message.method === "Runtime.exceptionThrown") {
      const { exceptionDetails, timestamp } = message.params;
      const frames = exceptionDetails.stackTrace?.callFrames?.map((f) => ({
        functionName: f.functionName || "(anonymous)",
        url: f.url,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber
      }));
      const consoleMsg = {
        id: this.consoleId++,
        type: "error",
        timestamp: timestamp || Date.now(),
        text: exceptionDetails.text,
        source: "exception",
        line: exceptionDetails.lineNumber,
        url: exceptionDetails.url,
        stackTrace: frames
      };
      this.consoleBuffer.push(consoleMsg);
      this.consoleById.set(consoleMsg.id, consoleMsg);
    }
    if (message.method === "Network.requestWillBeSent") {
      const { requestId, request, timestamp, type } = message.params;
      const entry = this.updateNetworkRequest(requestId, {
        url: request.url,
        method: request.method,
        timestamp: timestamp * 1e3,
        type,
        requestHeaders: request.headers
      });
      this.networkBuffer.push(entry);
    }
    if (message.method === "Network.responseReceived") {
      const { requestId, response, type } = message.params;
      this.updateNetworkRequest(requestId, {
        url: response.url || void 0,
        status: response.status,
        responseHeaders: response.headers,
        type: type ?? void 0
      });
    }
    if (message.method === "Network.loadingFinished") {
      const { requestId, encodedDataLength } = message.params;
      this.updateNetworkRequest(requestId, {
        size: encodedDataLength
      });
    }
  }
  /**
   * Update network request entry
   */
  updateNetworkRequest(requestId, patch) {
    const current = this.networkRequests.get(requestId);
    const next = {
      id: requestId,
      url: patch.url ?? current?.url ?? "",
      method: patch.method ?? current?.method ?? "GET",
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
  getConsoleLogs(count) {
    if (count === void 0) {
      return this.consoleBuffer.getAll();
    }
    return this.consoleBuffer.getLast(count).reverse();
  }
  /**
   * Get a specific console message by ID
   */
  getConsoleMessage(id) {
    return this.consoleById.get(id);
  }
  /**
   * Get last N network requests
   */
  getNetworkLogs(count) {
    if (count === void 0) {
      return this.networkBuffer.getAll();
    }
    return this.networkBuffer.getLast(count).reverse();
  }
  /**
   * Clear all buffers
   */
  clearLogs() {
    this.consoleBuffer.clear();
    this.consoleById.clear();
    this.networkBuffer.clear();
    this.networkRequests.clear();
  }
  /**
   * Check if connected
   */
  get isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  /**
   * Get buffer stats
   */
  getStats() {
    return {
      console: this.consoleBuffer.size,
      network: this.networkBuffer.size,
      connected: this.isConnected
    };
  }
  /**
   * Close the session
   */
  close() {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
};

// build/context.js
import { WebSocket as WebSocket2 } from "ws";
import { fetch as undiciFetch } from "undici";

// build/validation.js
var URL_PATTERN = /^(https?:\/\/|www\.|localhost|[a-z0-9-]+\.(com|org|net|io|dev|co|app))/i;
var NAV_ACTIONS = ["back", "forward", "reload"];
var LOG_TYPES = ["console", "network", "clear"];
function looksLikeUrl(value) {
  return URL_PATTERN.test(value);
}
function isNavAction(value) {
  return NAV_ACTIONS.includes(value.toLowerCase());
}
function isLogType(value) {
  return LOG_TYPES.includes(value.toLowerCase());
}
function getPageNotFoundHint(searchValue) {
  if (looksLikeUrl(searchValue)) {
    return `"${searchValue}" looks like a URL, not a page ID. Did you swap the parameter order?`;
  }
  if (isNavAction(searchValue)) {
    return `"${searchValue}" is a navigation action, not a page ID. Did you swap the parameter order?`;
  }
  if (isLogType(searchValue)) {
    return `"${searchValue}" is a log type, not a page ID. Did you swap the parameter order?`;
  }
  return void 0;
}

// build/context.js
var CDPContext = class {
  constructor(cdpUrl = "http://localhost:9222") {
    this.messageId = 1;
    this.consoleId = 1;
    this.consoleMessages = /* @__PURE__ */ new Map();
    this.networkRequests = /* @__PURE__ */ new Map();
    this.cdpUrl = cdpUrl;
  }
  /**
   * Get list of all open pages
   */
  async getPages() {
    const response = await (globalThis.fetch ?? undiciFetch)(`${this.cdpUrl}/json`);
    if (!response.ok) {
      throw new Error(`Failed to fetch pages: ${response.statusText}`);
    }
    const pages = await response.json();
    return pages.filter((p) => p.type === "page");
  }
  /**
   * Find a page by ID or title
   */
  async findPage(idOrTitle) {
    const pages = await this.getPages();
    if (pages.length === 0) {
      throw new Error("No pages found. Is Chrome running with --remote-debugging-port?");
    }
    const byId = pages.find((page) => page.id === idOrTitle);
    if (byId) {
      return byId;
    }
    const titleMatches = pages.filter((page) => page.title.includes(idOrTitle) && !page.url.startsWith("devtools://"));
    if (titleMatches.length === 0) {
      const hint = getPageNotFoundHint(idOrTitle);
      const availablePages = pages.slice(0, 3).map((p) => `  - "${p.title}" (${p.id})`).join("\n");
      const morePages = pages.length > 3 ? `
  ... and ${pages.length - 3} more` : "";
      let errorMsg = `Page not found: "${idOrTitle}"`;
      if (hint) {
        errorMsg += `

Hint: ${hint}`;
      }
      errorMsg += `

Available pages:
${availablePages}${morePages}`;
      errorMsg += `

Use 'cdp-cli list-pages' to see all pages.`;
      throw new Error(errorMsg);
    }
    if (titleMatches.length > 1) {
      const summary = titleMatches.map((page) => `"${page.title}" (${page.id})`).join(", ");
      throw new Error(`Multiple pages matched "${idOrTitle}". Use an exact page ID or refine the title. Matches: ${summary}`);
    }
    return titleMatches[0];
  }
  /**
   * Connect to a page via WebSocket
   */
  async connect(page) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket2(page.webSocketDebuggerUrl);
      ws.on("open", () => {
        resolve(ws);
      });
      ws.on("error", (error) => {
        reject(error);
      });
    });
  }
  /**
   * Check if DevTools is attached to a page via browser endpoint
   * Must check BEFORE connecting to page, as our connection counts as attached
   */
  async isDevToolsAttached(pageId) {
    const response = await (globalThis.fetch ?? undiciFetch)(`${this.cdpUrl}/json/version`);
    if (!response.ok)
      return false;
    const version = await response.json();
    if (!version.webSocketDebuggerUrl)
      return false;
    return new Promise((resolve) => {
      const ws = new WebSocket2(version.webSocketDebuggerUrl);
      const id = this.messageId++;
      ws.on("open", () => {
        ws.send(JSON.stringify({ id, method: "Target.getTargets", params: {} }));
      });
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id === id) {
          clearTimeout(timeout);
          ws.close();
          const target = message.result?.targetInfos?.find((t) => t.targetId === pageId);
          resolve(target?.attached === true);
        }
      });
      ws.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 2e3);
    });
  }
  /**
   * Auto-close DevTools if attached, or skip if daemon connected
   */
  async assertNoDevTools(pageId, skipIfDaemonConnected = true) {
    if (skipIfDaemonConnected) {
      try {
        const response = await (globalThis.fetch ?? undiciFetch)("http://127.0.0.1:9223/sessions");
        if (response.ok) {
          const data = await response.json();
          if (data.sessions?.some((s) => s.pageId === pageId && s.connected)) {
            return;
          }
        }
      } catch {
      }
    }
    if (!await this.isDevToolsAttached(pageId)) {
      return;
    }
    const closed = await this.closeDevToolsForPage(pageId);
    if (closed) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!await this.isDevToolsAttached(pageId)) {
        return;
      }
    }
    throw new Error("DevTools is open on this tab. Close DevTools to use this command.");
  }
  /**
   * Find and close DevTools window for a specific page
   */
  async closeDevToolsForPage(pageId) {
    try {
      const response = await (globalThis.fetch ?? undiciFetch)(`${this.cdpUrl}/json`);
      if (!response.ok)
        return false;
      const pages = await response.json();
      const targetPage = pages.find((p) => p.id === pageId);
      if (!targetPage)
        return false;
      const devToolsPage = pages.find((p) => p.url.startsWith("devtools://") && p.title.includes(targetPage.title.slice(0, 30)));
      if (!devToolsPage)
        return false;
      const closeResponse = await (globalThis.fetch ?? undiciFetch)(`${this.cdpUrl}/json/close/${devToolsPage.id}`);
      return closeResponse.ok;
    } catch {
      return false;
    }
  }
  /**
   * Send a CDP command and wait for response
   */
  async sendCommand(ws, method, params) {
    const id = this.messageId++;
    return new Promise((resolve, reject) => {
      const messageHandler = (data) => {
        const message = JSON.parse(data.toString());
        if (message.id === id) {
          clearTimeout(timeout);
          ws.off("message", messageHandler);
          if (message.error) {
            reject(new Error(message.error.message || "CDP command failed"));
          } else {
            resolve(message.result);
          }
        }
      };
      const timeout = setTimeout(() => {
        ws.off("message", messageHandler);
        reject(new Error(`Command timeout: ${method}`));
      }, 3e4);
      ws.on("message", messageHandler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /**
   * Setup console message collection
   */
  setupConsoleCollection(ws, onMessage) {
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "Runtime.consoleAPICalled") {
        const { type, args: args2, timestamp, stackTrace } = message.params;
        const text = args2.map((arg) => {
          if (arg.value !== void 0)
            return String(arg.value);
          if (arg.description !== void 0)
            return arg.description;
          return JSON.stringify(arg);
        }).join(" ");
        const frames = stackTrace?.callFrames?.map((f) => ({
          functionName: f.functionName || "(anonymous)",
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber
        }));
        const consoleMsg = {
          id: this.consoleId++,
          type,
          timestamp: timestamp || Date.now(),
          text,
          source: "console-api",
          args: args2,
          stackTrace: frames
        };
        this.consoleMessages.set(consoleMsg.id, consoleMsg);
        if (onMessage) {
          onMessage(consoleMsg);
        }
      }
      if (message.method === "Runtime.exceptionThrown") {
        const { exceptionDetails, timestamp } = message.params;
        const frames = exceptionDetails.stackTrace?.callFrames?.map((f) => ({
          functionName: f.functionName || "(anonymous)",
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber
        }));
        const consoleMsg = {
          id: this.consoleId++,
          type: "error",
          timestamp: timestamp || Date.now(),
          text: exceptionDetails.text,
          source: "exception",
          line: exceptionDetails.lineNumber,
          url: exceptionDetails.url,
          stackTrace: frames
        };
        this.consoleMessages.set(consoleMsg.id, consoleMsg);
        if (onMessage) {
          onMessage(consoleMsg);
        }
      }
    });
  }
  /**
   * Setup network request collection
   */
  setupNetworkCollection(ws, onRequest) {
    const updateRequest = (requestId, patch) => {
      const current = this.networkRequests.get(requestId);
      const next = {
        id: requestId,
        url: patch.url ?? current?.url ?? "",
        method: patch.method ?? current?.method ?? "GET",
        timestamp: patch.timestamp ?? current?.timestamp ?? Date.now(),
        type: patch.type ?? current?.type,
        status: patch.status ?? current?.status,
        size: patch.size ?? current?.size,
        requestHeaders: patch.requestHeaders ?? current?.requestHeaders,
        responseHeaders: patch.responseHeaders ?? current?.responseHeaders
      };
      this.networkRequests.set(requestId, next);
      return next;
    };
    const emit = (requestId, event) => {
      if (!onRequest) {
        return;
      }
      const entry = this.networkRequests.get(requestId);
      if (entry) {
        onRequest({ ...entry }, event);
      }
    };
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "Network.requestWillBeSent") {
        const { requestId, request, timestamp, type } = message.params;
        updateRequest(requestId, {
          url: request.url,
          method: request.method,
          timestamp: timestamp * 1e3,
          type,
          requestHeaders: request.headers
        });
        emit(requestId, "requestWillBeSent");
      }
      if (message.method === "Network.responseReceived") {
        const { requestId, response, type } = message.params;
        updateRequest(requestId, {
          url: response.url || "",
          status: response.status,
          responseHeaders: response.headers,
          type: type ?? void 0
        });
        emit(requestId, "responseReceived");
      }
      if (message.method === "Network.loadingFinished") {
        const { requestId, encodedDataLength } = message.params;
        updateRequest(requestId, {
          size: encodedDataLength
        });
        emit(requestId, "loadingFinished");
      }
    });
  }
  /**
   * Get all console messages collected in THIS context session only.
   * Note: Messages are NOT persisted across CLI commands.
   */
  getConsoleMessages() {
    return Array.from(this.consoleMessages.values());
  }
  /**
   * Get all network requests collected in THIS context session only.
   * Note: Requests are NOT persisted across CLI commands.
   */
  getNetworkRequests() {
    return Array.from(this.networkRequests.values());
  }
  /**
   * Close a page
   */
  async closePage(page) {
    const response = await fetch(`${this.cdpUrl}/json/close/${page.id}`);
    if (!response.ok) {
      throw new Error(`Failed to close page: ${response.statusText}`);
    }
  }
  /**
   * Create a new page
   */
  async createPage(url) {
    const endpoint = url ? `${this.cdpUrl}/json/new?${encodeURI(url).replace(/#/g, "%23")}` : `${this.cdpUrl}/json/new`;
    const response = await fetch(endpoint, { method: "PUT" });
    if (!response.ok) {
      throw new Error(`Failed to create page: ${response.statusText}`);
    }
    return await response.json();
  }
};

// build/daemon/daemon.js
var DEFAULT_DAEMON_PORT = 9223;
var DEFAULT_CDP_URL = "http://localhost:9222";
var DEFAULT_BUFFER_SIZE2 = 500;
var CDPDaemon = class {
  constructor(config2 = {}) {
    this.sessions = /* @__PURE__ */ new Map();
    this.server = null;
    this.healthCheckInterval = null;
    this.browserWs = null;
    this.browserMessageId = 1;
    this.config = {
      port: config2.port ?? DEFAULT_DAEMON_PORT,
      cdpUrl: config2.cdpUrl ?? DEFAULT_CDP_URL,
      bufferSize: config2.bufferSize ?? DEFAULT_BUFFER_SIZE2
    };
    this.context = new CDPContext(this.config.cdpUrl);
  }
  /**
   * Start the daemon server
   */
  async start() {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve, reject) => {
      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.config.port} already in use (daemon may already be running)`));
        } else {
          reject(err);
        }
      });
      this.server.listen(this.config.port, "127.0.0.1", async () => {
        this.startHealthCheck();
        await this.startTargetDiscovery();
        resolve();
      });
    });
  }
  /**
   * Stop the daemon
   */
  async stop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.browserWs) {
      this.browserWs.close();
      this.browserWs = null;
    }
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => resolve());
      });
    }
  }
  /**
   * Periodic health check - detect Chrome restarts and new pages
   */
  startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const pages = await this.context.getPages();
        const pageIds = new Set(pages.map((p) => p.id));
        for (const [pageId, session] of this.sessions) {
          if (!pageIds.has(pageId)) {
            session.close();
            this.sessions.delete(pageId);
          }
        }
        for (const page of pages) {
          if (!this.sessions.has(page.id)) {
            await this.registerPage(page);
          }
        }
      } catch {
        if (!this.browserWs || this.browserWs.readyState !== WebSocket3.OPEN) {
          this.startTargetDiscovery().catch(() => {
          });
        }
      }
    }, 5e3);
  }
  /**
   * Register a page for logging
   */
  async registerPage(page) {
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
  async startTargetDiscovery() {
    try {
      const response = await fetch(`${this.config.cdpUrl}/json/version`);
      if (!response.ok)
        return;
      const version = await response.json();
      if (!version.webSocketDebuggerUrl)
        return;
      if (this.browserWs) {
        this.browserWs.close();
      }
      this.browserWs = new WebSocket3(version.webSocketDebuggerUrl);
      this.browserWs.on("open", async () => {
        this.sendBrowserCommand("Target.setDiscoverTargets", { discover: true });
      });
      this.browserWs.on("message", async (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "Target.targetCreated") {
          const targetInfo = message.params?.targetInfo;
          if (targetInfo?.type === "page") {
            try {
              const pages = await this.context.getPages();
              const page = pages.find((p) => p.id === targetInfo.targetId);
              if (page) {
                await this.registerPage(page);
              }
            } catch {
            }
          }
        }
        if (message.method === "Target.targetDestroyed") {
          const targetId = message.params?.targetId;
          if (targetId && this.sessions.has(targetId)) {
            const session = this.sessions.get(targetId);
            session?.close();
            this.sessions.delete(targetId);
          }
        }
      });
      this.browserWs.on("close", () => {
        this.browserWs = null;
      });
      this.browserWs.on("error", () => {
        this.browserWs?.close();
        this.browserWs = null;
      });
    } catch {
    }
  }
  /**
   * Send command to browser WebSocket
   */
  sendBrowserCommand(method, params) {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket3.OPEN)
      return;
    const id = this.browserMessageId++;
    this.browserWs.send(JSON.stringify({ id, method, params }));
  }
  /**
   * Handle HTTP request
   */
  async handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://localhost:${this.config.port}`);
    const path = url.pathname;
    const method = req.method || "GET";
    res.setHeader("Content-Type", "application/json");
    try {
      if (method === "GET" && path === "/health") {
        this.sendJson(res, 200, { status: "ok", sessions: this.sessions.size });
        return;
      }
      if (method === "POST" && path === "/shutdown") {
        this.sendJson(res, 200, { status: "shutting_down" });
        setImmediate(async () => {
          await this.stop();
          process.exit(0);
        });
        return;
      }
      if (method === "GET" && path === "/sessions") {
        const sessions = [];
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
      if (method === "POST" && path === "/sessions") {
        const body = await this.readBody(req);
        const { pageId, webSocketUrl } = body;
        if (!pageId || !webSocketUrl) {
          this.sendJson(res, 400, { error: "pageId and webSocketUrl required" });
          return;
        }
        if (this.sessions.has(pageId)) {
          const stats = this.sessions.get(pageId).getStats();
          this.sendJson(res, 200, { status: "exists", pageId, ...stats });
          return;
        }
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
          this.sendJson(res, 201, { status: "created", pageId });
        } catch (err) {
          this.sendJson(res, 500, { error: `Failed to connect: ${err.message}` });
        }
        return;
      }
      if (method === "DELETE" && path.startsWith("/sessions/")) {
        const pageId = decodeURIComponent(path.slice("/sessions/".length));
        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: "Session not found" });
          return;
        }
        session.close();
        this.sessions.delete(pageId);
        this.sendJson(res, 200, { status: "deleted", pageId });
        return;
      }
      if (method === "GET" && path.startsWith("/logs/detail/")) {
        const rest = path.slice("/logs/detail/".length);
        const [pageId, messageIdStr] = rest.split("/").map(decodeURIComponent);
        const messageId = parseInt(messageIdStr, 10);
        if (!pageId || isNaN(messageId)) {
          this.sendJson(res, 400, { error: "Invalid page ID or message ID" });
          return;
        }
        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: "Session not found" });
          return;
        }
        const message = session.getConsoleMessage(messageId);
        if (!message) {
          this.sendJson(res, 404, { error: "Message not found" });
          return;
        }
        this.sendJson(res, 200, { message });
        return;
      }
      if (method === "GET" && path.startsWith("/logs/console/")) {
        const pageId = decodeURIComponent(path.slice("/logs/console/".length));
        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: "Session not found" });
          return;
        }
        const lastParam = url.searchParams.get("last");
        const last = lastParam ? parseInt(lastParam, 10) : void 0;
        const typeFilter = url.searchParams.get("type");
        let logs = session.getConsoleLogs(last);
        if (typeFilter) {
          logs = logs.filter((log) => log.type === typeFilter);
        }
        this.sendJson(res, 200, { logs });
        return;
      }
      if (method === "GET" && path.startsWith("/logs/network/")) {
        const pageId = decodeURIComponent(path.slice("/logs/network/".length));
        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: "Session not found" });
          return;
        }
        const lastParam = url.searchParams.get("last");
        const last = lastParam ? parseInt(lastParam, 10) : void 0;
        const typeFilter = url.searchParams.get("type");
        let logs = session.getNetworkLogs(last);
        if (typeFilter) {
          logs = logs.filter((log) => log.type === typeFilter);
        }
        this.sendJson(res, 200, { logs });
        return;
      }
      if (method === "DELETE" && path.startsWith("/logs/")) {
        const pageId = decodeURIComponent(path.slice("/logs/".length));
        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: "Session not found" });
          return;
        }
        session.clearLogs();
        this.sendJson(res, 200, { status: "cleared", pageId });
        return;
      }
      if (method === "POST" && path.startsWith("/exec/")) {
        const pageId = decodeURIComponent(path.slice("/exec/".length));
        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: "Session not found" });
          return;
        }
        if (!session.isConnected) {
          this.sendJson(res, 503, { error: "Session not connected" });
          return;
        }
        const body = await this.readBody(req);
        const { method: cdpMethod, params: cdpParams } = body;
        if (!cdpMethod) {
          this.sendJson(res, 400, { error: "CDP method required" });
          return;
        }
        try {
          const result = await session.sendCommand(cdpMethod, cdpParams);
          this.sendJson(res, 200, { result });
        } catch (err) {
          this.sendJson(res, 500, { error: err.message });
        }
        return;
      }
      if (method === "POST" && path === "/exec-batch") {
        const body = await this.readBody(req);
        const { pageId, commands } = body;
        if (!pageId || !Array.isArray(commands)) {
          this.sendJson(res, 400, { error: "pageId and commands array required" });
          return;
        }
        const session = this.sessions.get(pageId);
        if (!session) {
          this.sendJson(res, 404, { error: "Session not found" });
          return;
        }
        if (!session.isConnected) {
          this.sendJson(res, 503, { error: "Session not connected" });
          return;
        }
        const results = [];
        for (const cmd of commands) {
          try {
            const result = await session.sendCommand(cmd.method, cmd.params);
            results.push({ success: true, result });
          } catch (err) {
            results.push({ success: false, error: err.message });
          }
        }
        this.sendJson(res, 200, { results });
        return;
      }
      this.sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      this.sendJson(res, 500, { error: err.message });
    }
  }
  /**
   * Read JSON body
   */
  async readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }
  /**
   * Send JSON response
   */
  sendJson(res, status, data) {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  }
};
async function runDaemon(config2 = {}) {
  const daemon = new CDPDaemon(config2);
  process.on("SIGINT", async () => {
    await daemon.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await daemon.stop();
    process.exit(0);
  });
  await daemon.start();
  process.stdin.resume();
}

// build/daemon/daemon-entry.js
var args = process.argv.slice(2);
var config = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cdp-url" && args[i + 1]) {
    config.cdpUrl = args[++i];
  } else if (args[i] === "--port" && args[i + 1]) {
    config.port = parseInt(args[++i], 10);
  } else if (args[i] === "--buffer-size" && args[i + 1]) {
    config.bufferSize = parseInt(args[++i], 10);
  }
}
runDaemon(config).catch((err) => {
  console.error("Daemon error:", err.message);
  process.exit(1);
});
