/**
 * Page management commands
 */

import { WebSocket } from 'ws';
import { CDPContext, Page } from '../context.js';
import { outputLines, outputLine, outputError, outputSuccess } from '../output.js';
import { DaemonClient } from '../daemon/client.js';
import { armNavigationWatcher, handleWaitOptions, type NavigationWatcher, type WaitOptions } from './wait.js';

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
      navigationWatcher = await armNavigationWatcher(context, ws);
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
      await context.sendCommand(ws, 'Page.navigate', { url: action });
    }

    // Handle wait options
    await handleWaitOptions(context, ws, options, navigationWatcher);

    outputSuccess('Navigation complete', {
      action,
      page: page.id,
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
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
    process.exit(1);
  } finally {
    if (navigationWatcher) {
      navigationWatcher.dispose();
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
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}
