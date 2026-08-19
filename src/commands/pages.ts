/**
 * Page management commands
 */

import { WebSocket } from 'ws';
import { CDPContext, Page } from '../context.js';
import { outputLines, outputLine, outputError, outputSuccess } from '../output.js';
import { DaemonClient } from '../daemon/client.js';
import {
  armNavigationWatcher,
  armNetworkIdleWatcher,
  armNetworkResponseWatcher,
  handleWaitOptions,
  type NavigationWatcher,
  type NetworkIdleWatcher,
  type NetworkResponseWatcher,
  type WaitOptions
} from './wait.js';

type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

export interface PageHealth {
  hasFocus: boolean | null;
  visibilityState: string | null;
  outerWidth: number | null;
  outerHeight: number | null;
  innerWidth: number | null;
  innerHeight: number | null;
  windowId: number | null;
  windowBounds: {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
  } | null;
  windowState: string | null;
}

const finiteNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Collect the document and browser-window state needed to diagnose focus
 * theft. This helper is intentionally read-only and never activates the page.
 */
export async function collectPageHealth(
  context: CDPContext,
  ws: WebSocket,
  targetId: string
): Promise<PageHealth> {
  const documentResult = await context.sendCommand(ws, 'Runtime.evaluate', {
    expression: `(() => ({
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    }))()`,
    returnByValue: true
  });
  const documentHealth = documentResult.result?.value ?? {};

  let windowId: number | null = null;
  let windowBounds: PageHealth['windowBounds'] = null;
  let windowState: string | null = null;
  try {
    const windowInfo = await context.sendCommand(ws, 'Browser.getWindowForTarget', {
      targetId
    });
    windowId = finiteNumberOrNull(windowInfo?.windowId);
    const bounds = windowInfo?.bounds;
    if (bounds && typeof bounds === 'object') {
      windowBounds = {
        ...(finiteNumberOrNull(bounds.left) !== null ? { left: bounds.left } : {}),
        ...(finiteNumberOrNull(bounds.top) !== null ? { top: bounds.top } : {}),
        ...(finiteNumberOrNull(bounds.width) !== null ? { width: bounds.width } : {}),
        ...(finiteNumberOrNull(bounds.height) !== null ? { height: bounds.height } : {})
      };
      windowState = typeof bounds.windowState === 'string' ? bounds.windowState : null;
    }
  } catch {
    // Browser window metadata is not exposed by every target/browser build.
  }

  return {
    hasFocus: typeof documentHealth.hasFocus === 'boolean' ? documentHealth.hasFocus : null,
    visibilityState: typeof documentHealth.visibilityState === 'string'
      ? documentHealth.visibilityState
      : null,
    outerWidth: finiteNumberOrNull(documentHealth.outerWidth),
    outerHeight: finiteNumberOrNull(documentHealth.outerHeight),
    innerWidth: finiteNumberOrNull(documentHealth.innerWidth),
    innerHeight: finiteNumberOrNull(documentHealth.innerHeight),
    windowId,
    windowBounds,
    windowState
  };
}

/** Report page health without changing focus or visibility. */
export async function pageHealth(
  context: CDPContext,
  idOrTitle: string
): Promise<void> {
  let ws;
  try {
    const page = await context.findPage(idOrTitle);
    await context.assertNoDevTools(page.id);
    ws = await context.connect(page);
    await context.sendCommand(ws, 'Runtime.enable');

    const health = await collectPageHealth(context, ws, page.id);
    outputSuccess('Page health collected', { page: page.id, ...health });
  } catch (error) {
    outputError(
      (error as Error).message,
      'PAGE_HEALTH_FAILED',
      { page: idOrTitle }
    );
    await context.releaseSessionLeases();
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Explicitly activate a target. Callers opt into this separately from health
 * inspection and input commands; nothing auto-steals the user's foreground.
 */
export async function activatePage(
  context: CDPContext,
  idOrTitle: string
): Promise<void> {
  let ws;
  try {
    const page = await context.findPage(idOrTitle);
    await context.assertNoDevTools(page.id);
    ws = await context.connect(page);

    await context.sendCommand(ws, 'Target.activateTarget', { targetId: page.id });
    await context.sendCommand(ws, 'Page.bringToFront');

    outputSuccess('Page activated', { page: page.id, activated: true });
  } catch (error) {
    outputError(
      (error as Error).message,
      'ACTIVATE_PAGE_FAILED',
      { page: idOrTitle }
    );
    await context.releaseSessionLeases();
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

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
    await context.releaseSessionLeases();
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
    await context.releaseSessionLeases();
    process.exit(1);
  }
}

export type NavigateOptions = WaitOptions;

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
  let navigationWatcher: NavigationWatcher | undefined;
  let networkIdleWatcher: NetworkIdleWatcher | undefined;
  let networkResponseWatcher: NetworkResponseWatcher | undefined;

  try {
    // Get page to navigate
    const page = await context.findPage(pageIdOrTitle);
    await context.assertNoDevTools(page.id);

    // Connect to page
    ws = await context.connect(page);

    // Enable required domains
    await context.sendCommand(ws, 'Page.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    if (options.waitForNavigation) {
      navigationWatcher = await armNavigationWatcher(context, ws, options.waitForFrame);
    }
    if (options.waitForIdle) {
      networkIdleWatcher = await armNetworkIdleWatcher(context, ws);
    }
    if (options.waitForResponse) {
      networkResponseWatcher = await armNetworkResponseWatcher(context, ws, options);
    }

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
      const navigation = await context.sendCommand(ws, 'Page.navigate', { url: action });
      if (typeof navigation?.errorText === 'string' && navigation.errorText.length > 0) {
        throw new Error(`Navigation failed: ${navigation.errorText}`);
      }
    }

    // Handle wait options
    await handleWaitOptions(context, ws, options, navigationWatcher, networkIdleWatcher, networkResponseWatcher);

    outputSuccess('Navigation complete', {
      action,
      page: page.id,
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
      ...(options.waitForExpression && { waitedForExpression: true }),
      ...(options.waitForResponse && { waitedForResponse: options.waitForResponse }),
      ...(options.waitForStatus !== undefined && { waitedForStatus: options.waitForStatus }),
      ...(options.waitForBodyText && { waitedForBodyText: true }),
      ...(options.waitForIdle && { waitedForIdle: true }),
      ...(options.waitForFrame && { waitedInFrame: options.waitForFrame }),
      ...(options.waitForNavigation && { waitedForNavigation: true })
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'NAVIGATE_FAILED',
      { action, page: pageIdOrTitle }
    );
    await context.releaseSessionLeases();
    process.exit(1);
  } finally {
    if (navigationWatcher) {
      navigationWatcher.dispose();
    }
    if (networkIdleWatcher) {
      networkIdleWatcher.dispose();
    }
    if (networkResponseWatcher) {
      networkResponseWatcher.dispose();
    }
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

    // Acquire the workspace lease and close Chrome before touching the
    // daemon's warm PageSession. Deleting that session first could disrupt a
    // concurrent operation and only then discover the lease conflict.
    await context.closePage(page);

    const daemonClient = new DaemonClient();
    if (await daemonClient.isRunning()) {
      try {
        await daemonClient.deleteSession(page.id, context.workspaceSessionName);
      } catch {
        // Chrome is already closed; stale daemon cleanup is best effort.
      }
    }

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
    await context.releaseSessionLeases();
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

    // Chrome clamps to the available screen area and ignores width/height for
    // maximized/fullscreen windows, so report what the window actually became.
    const applied = await context.sendCommand(ws, 'Browser.getWindowForTarget', {
      targetId: page.id
    });
    const actual = applied?.bounds ?? {};

    outputSuccess('Window resized', {
      page: page.id,
      windowId,
      width: actual.width ?? bounds.width,
      height: actual.height ?? bounds.height,
      state: actual.windowState ?? bounds.windowState,
      requested: { width: bounds.width, height: bounds.height, state: bounds.windowState }
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
    await context.releaseSessionLeases();
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}
