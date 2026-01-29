/**
 * Page management commands
 */

import { WebSocket } from 'ws';
import { CDPContext, Page } from '../context.js';
import { outputLines, outputLine, outputError, outputSuccess } from '../output.js';
import { DaemonClient } from '../daemon/client.js';

type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

/**
 * List all open pages
 */
export async function listPages(context: CDPContext): Promise<void> {
  try {
    const pages = await context.getPages();

    const output = pages.map(page => ({
      id: page.id,
      title: page.title,
      url: page.url,
      type: page.type
    }));

    outputLines(output);
  } catch (error) {
    outputError(
      (error as Error).message,
      'LIST_PAGES_FAILED',
      { error: String(error) }
    );
    process.exit(1);
  }
}

/**
 * Create a new page
 */
export async function newPage(
  context: CDPContext,
  url?: string
): Promise<void> {
  try {
    const page = await context.createPage(url);

    // Register with daemon if running
    const daemonClient = new DaemonClient();
    let loggingEnabled = false;

    if (await daemonClient.isRunning()) {
      try {
        await daemonClient.createSession(page.id, page.webSocketDebuggerUrl);
        loggingEnabled = true;
      } catch {
        // Daemon registration failed, but page was still created
      }
    }

    outputSuccess('Page created', {
      id: page.id,
      title: page.title,
      url: page.url,
      logging: loggingEnabled
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'NEW_PAGE_FAILED',
      { url }
    );
    process.exit(1);
  }
}

export interface NavigateOptions {
  waitFor?: string;
  waitForText?: string;
  waitForIdle?: boolean;
  timeout?: number;
}

/**
 * Wait for a CSS selector to appear in the page
 */
async function waitForSelector(
  context: CDPContext,
  ws: WebSocket,
  selector: string,
  timeout: number
): Promise<void> {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < timeout) {
    const result = await context.sendCommand(ws, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
      returnByValue: true
    });

    if (result.result?.value === true) {
      return;
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`Timeout waiting for selector: ${selector}`);
}

/**
 * Wait for text to appear in the page body
 */
async function waitForText(
  context: CDPContext,
  ws: WebSocket,
  text: string,
  timeout: number
): Promise<void> {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < timeout) {
    const result = await context.sendCommand(ws, 'Runtime.evaluate', {
      expression: `document.body.innerText.includes(${JSON.stringify(text)})`,
      returnByValue: true
    });

    if (result.result?.value === true) {
      return;
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`Timeout waiting for text: ${text}`);
}

/**
 * Wait for network idle and DOM ready
 */
async function waitForIdle(
  context: CDPContext,
  ws: WebSocket,
  timeout: number
): Promise<void> {
  await context.sendCommand(ws, 'Network.enable');

  const start = Date.now();
  let pendingRequests = 0;
  let lastActivity = Date.now();
  const idleThreshold = 500; // ms of no network activity

  // Track network requests
  const requestHandler = () => {
    pendingRequests++;
    lastActivity = Date.now();
  };
  const responseHandler = () => {
    pendingRequests = Math.max(0, pendingRequests - 1);
    lastActivity = Date.now();
  };

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.requestWillBeSent') requestHandler();
      if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') responseHandler();
    } catch {
      // Ignore parse errors
    }
  });

  // Wait for document ready + network idle
  while (Date.now() - start < timeout) {
    const docReady = await context.sendCommand(ws, 'Runtime.evaluate', {
      expression: `document.readyState === 'complete'`,
      returnByValue: true
    });

    const isDocReady = docReady.result?.value === true;
    const isNetworkIdle = pendingRequests === 0 && (Date.now() - lastActivity) >= idleThreshold;

    if (isDocReady && isNetworkIdle) {
      return;
    }

    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error('Timeout waiting for idle state');
}

/**
 * Navigate page (or back/forward/reload)
 */
export async function navigate(
  context: CDPContext,
  action: string,
  pageIdOrTitle: string,
  options: NavigateOptions = {}
): Promise<void> {
  let ws;
  const timeout = options.timeout ?? 10000;

  try {
    // Get page to navigate
    const page = await context.findPage(pageIdOrTitle);
    await context.assertNoDevTools(page.id);

    // Connect to page
    ws = await context.connect(page);

    // Enable required domains
    await context.sendCommand(ws, 'Page.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    // Perform navigation action
    if (action === 'back') {
      const history = await context.sendCommand(ws, 'Page.getNavigationHistory');
      if (history.currentIndex > 0) {
        await context.sendCommand(ws, 'Page.navigateToHistoryEntry', {
          entryId: history.entries[history.currentIndex - 1].id
        });
      } else {
        throw new Error('Cannot navigate back: already at oldest page');
      }
    } else if (action === 'forward') {
      const history = await context.sendCommand(ws, 'Page.getNavigationHistory');
      if (history.currentIndex < history.entries.length - 1) {
        await context.sendCommand(ws, 'Page.navigateToHistoryEntry', {
          entryId: history.entries[history.currentIndex + 1].id
        });
      } else {
        throw new Error('Cannot navigate forward: already at newest page');
      }
    } else if (action === 'reload') {
      await context.sendCommand(ws, 'Page.reload');
    } else {
      // Assume it's a URL
      await context.sendCommand(ws, 'Page.navigate', { url: action });
    }

    // Handle wait options
    if (options.waitForIdle) {
      await waitForIdle(context, ws, timeout);
    }

    if (options.waitFor) {
      await waitForSelector(context, ws, options.waitFor, timeout);
    }

    if (options.waitForText) {
      await waitForText(context, ws, options.waitForText, timeout);
    }

    outputSuccess('Navigation complete', {
      action,
      page: page.id,
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
      ...(options.waitForIdle && { waitedForIdle: true })
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'NAVIGATE_FAILED',
      { action, page: pageIdOrTitle }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Close a page
 */
export async function closePage(
  context: CDPContext,
  idOrTitle: string
): Promise<void> {
  try {
    const page = await context.findPage(idOrTitle);

    // Clean up daemon session if running
    const daemonClient = new DaemonClient();
    if (await daemonClient.isRunning()) {
      try {
        await daemonClient.deleteSession(page.id);
      } catch {
        // Daemon cleanup failed, continue with page close
      }
    }

    await context.closePage(page);

    outputSuccess('Page closed', {
      id: page.id,
      title: page.title
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'CLOSE_PAGE_FAILED',
      { idOrTitle }
    );
    process.exit(1);
  }
}

/**
 * Resize the browser window containing the target page
 */
export async function resizeWindow(
  context: CDPContext,
  idOrTitle: string,
  options: { width: number; height: number; state?: WindowState }
): Promise<void> {
  let ws;
  try {
    const { width, height, state } = options;
    if (!Number.isFinite(width) || width <= 0) {
      throw new Error('Width must be a positive number');
    }

    if (!Number.isFinite(height) || height <= 0) {
      throw new Error('Height must be a positive number');
    }

    const page = await context.findPage(idOrTitle);
    await context.assertNoDevTools(page.id);
    ws = await context.connect(page);

    const windowInfo = await context.sendCommand(ws, 'Browser.getWindowForTarget', {
      targetId: page.id
    });

    const windowId = windowInfo?.windowId;
    if (typeof windowId !== 'number') {
      throw new Error('Unable to determine window for target page');
    }

    const bounds: {
      windowState: WindowState;
      width?: number;
      height?: number;
    } = {
      windowState: state ?? 'normal'
    };

    bounds.width = Math.round(width);
    bounds.height = Math.round(height);

    await context.sendCommand(ws, 'Browser.setWindowBounds', {
      windowId,
      bounds
    });

    outputSuccess('Window resized', {
      page: page.id,
      windowId,
      width: bounds.width,
      height: bounds.height,
      state: bounds.windowState
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'RESIZE_WINDOW_FAILED',
      {
        page: idOrTitle,
        width: options.width,
        height: options.height,
        state: options.state ?? 'normal'
      }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}
