/**
 * Shared wait utilities for post-action polling
 */

import { WebSocket } from 'ws';
import { CDPContext } from '../context.js';

export interface WaitOptions {
  waitFor?: string;
  waitForText?: string;
  waitForIdle?: boolean;
  waitForFrame?: string;
  waitForNavigation?: boolean;
  timeout?: number;
}

/**
 * The frame that post-action waits apply to.
 *
 * A caller who targeted an iframe with --frame almost always means that frame's
 * document, so --frame supplies the default and --wait-for-frame overrides it.
 * Without this, clicking inside a frame and then waiting would check the top
 * document and report a success against the wrong DOM.
 */
export function effectiveWaitFrame(options: { frame?: string } & WaitOptions): string | undefined {
  return options.waitForFrame ?? options.frame;
}

export interface NavigationResult {
  url: string;
  loaderId: string;
}

export interface NavigationWatcher {
  /** Resolve once the main frame has committed AND finished loading a new document */
  wait(timeout: number): Promise<NavigationResult>;
  /** Detach the message listener; safe to call more than once */
  dispose(): void;
}

/**
 * Start listening for a document replacement in the main frame, or in a
 * specific iframe when `frameSpec` names one.
 *
 * This has to be armed *before* the action that triggers the navigation:
 * a form POST can commit and finish loading before a post-action listener
 * would have attached, and the events would be missed entirely.
 *
 * Detection is by loaderId, not by text or URL, so it reports a genuine
 * document swap. Same-document navigations (hash changes, history.pushState)
 * keep the loaderId and deliberately do NOT satisfy this wait.
 *
 * A frame ID survives that frame navigating, so it is safe to resolve up front
 * and match against afterwards; an execution context ID would not be.
 */
export async function armNavigationWatcher(
  context: CDPContext,
  ws: WebSocket,
  frameSpec?: string
): Promise<NavigationWatcher> {
  await context.sendCommand(ws, 'Page.enable');

  const targetFrameId = await context.resolveFrameId(ws, frameSpec);

  const tree = await context.sendCommand(ws, 'Page.getFrameTree');
  const mainFrameId: string | undefined = tree?.frameTree?.frame?.id;

  // A subframe wait keys on that frame's own starting loaderId, so the frame
  // tree has to be walked rather than just read at the root.
  const findFrame = (node: any): any => {
    if (!node?.frame) return undefined;
    if (node.frame.id === targetFrameId) return node.frame;
    for (const child of node.childFrames ?? []) {
      const found = findFrame(child);
      if (found) return found;
    }
    return undefined;
  };

  const watchingMainFrame = targetFrameId === undefined || targetFrameId === mainFrameId;
  const watchedFrameId = watchingMainFrame ? mainFrameId : targetFrameId;
  const startLoaderId: string | undefined = watchingMainFrame
    ? tree?.frameTree?.frame?.loaderId
    : findFrame(tree?.frameTree)?.loaderId;

  // Page.loadEventFired is main-frame only. A subframe reports completion via
  // Page.frameStoppedLoading, and via Page.lifecycleEvent when those are on.
  if (!watchingMainFrame) {
    try {
      await context.sendCommand(ws, 'Page.setLifecycleEventsEnabled', { enabled: true });
    } catch {
      // frameStoppedLoading alone is enough; lifecycle events are a bonus signal.
    }
  }

  // Held in one object so the closure's writes stay visible to wait() without
  // fighting TypeScript's narrowing of captured `let` bindings.
  const state: { committed: NavigationResult | null; loaded: boolean } = {
    committed: null,
    loaded: false
  };

  const messageHandler = (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.method === 'Page.frameNavigated') {
        const frame = msg.params?.frame;
        if (!frame) return;

        if (watchingMainFrame) {
          // Subframe loads (ads, iframes) must not satisfy a main-frame wait.
          if (frame.parentId) return;
          if (mainFrameId && frame.id !== mainFrameId) return;
        } else if (frame.id !== watchedFrameId) {
          return;
        }

        if (startLoaderId && frame.loaderId === startLoaderId) return;

        state.committed = { url: frame.url, loaderId: frame.loaderId };
        state.loaded = false;
        return;
      }

      if (!state.committed) return;

      // Ordered after frameNavigated on the same connection, so a completion
      // signal only counts once the new document has committed.
      if (watchingMainFrame) {
        if (msg.method === 'Page.loadEventFired') {
          state.loaded = true;
        }
        return;
      }

      if (msg.method === 'Page.frameStoppedLoading' && msg.params?.frameId === watchedFrameId) {
        state.loaded = true;
        return;
      }

      if (
        msg.method === 'Page.lifecycleEvent' &&
        msg.params?.name === 'load' &&
        msg.params?.frameId === watchedFrameId
      ) {
        state.loaded = true;
      }
    } catch {
      // Ignore parse errors
    }
  };

  ws.on('message', messageHandler);

  return {
    async wait(timeout: number): Promise<NavigationResult> {
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (state.committed && state.loaded) {
          return state.committed;
        }
        await new Promise(r => setTimeout(r, 50));
      }

      const target = watchingMainFrame ? 'the main frame' : `frame ${frameSpec}`;

      if (state.committed) {
        throw new Error(
          `Timeout waiting for navigation after ${timeout}ms: a new document committed at ${state.committed.url} in ${target} but never finished loading`
        );
      }

      const hint = watchingMainFrame
        ? ' If the navigation happens inside an iframe (for example a form POST in a frame), name that frame with --wait-for-frame <selector|index>.'
        : ' Check that the POST really replaces that frame\'s document rather than the top one.';

      throw new Error(
        `Timeout waiting for navigation after ${timeout}ms: ${target} never replaced its document. ` +
        'A same-document change (hash route, pushState) does not count as a navigation.' + hint
      );
    },
    dispose() {
      ws.off('message', messageHandler);
    }
  };
}

/**
 * Wait for a CSS selector to appear in the page (or frame)
 */
export async function waitForSelector(
  context: CDPContext,
  ws: WebSocket,
  selector: string,
  timeout: number,
  contextId?: number
): Promise<void> {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < timeout) {
    const result = await context.sendCommand(ws, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
      returnByValue: true,
      contextId
    });

    if (result.result?.value === true) {
      return;
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`Timeout waiting for selector: ${selector}`);
}

/**
 * Wait for text to appear in the page body (or frame)
 */
export async function waitForText(
  context: CDPContext,
  ws: WebSocket,
  text: string,
  timeout: number,
  contextId?: number
): Promise<void> {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < timeout) {
    const result = await context.sendCommand(ws, 'Runtime.evaluate', {
      expression: `document.body.innerText.includes(${JSON.stringify(text)})`,
      returnByValue: true,
      contextId
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
export async function waitForIdle(
  context: CDPContext,
  ws: WebSocket,
  timeout: number
): Promise<void> {
  await context.sendCommand(ws, 'Network.enable');

  const start = Date.now();
  let pendingRequests = 0;
  let lastActivity = Date.now();
  const idleThreshold = 500;

  const requestHandler = () => {
    pendingRequests++;
    lastActivity = Date.now();
  };
  const responseHandler = () => {
    pendingRequests = Math.max(0, pendingRequests - 1);
    lastActivity = Date.now();
  };

  const messageHandler = (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.requestWillBeSent') requestHandler();
      if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') responseHandler();
    } catch {
      // Ignore parse errors
    }
  };

  ws.on('message', messageHandler);

  try {
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
  } finally {
    // Without this the counters keep mutating for the life of the connection,
    // which matters on the daemon's long-lived sessions.
    ws.off('message', messageHandler);
  }

  throw new Error('Timeout waiting for idle state');
}

/**
 * Orchestrate all wait conditions after an action.
 * Order: navigation -> idle -> frame resolve -> selector -> text
 *
 * Navigation is resolved first so that any selector/text condition is checked
 * against the new document rather than the outgoing one.
 *
 * `navigationWatcher` must have been armed by the caller before the action ran;
 * it is required whenever `options.waitForNavigation` is set.
 */
export async function handleWaitOptions(
  context: CDPContext,
  ws: WebSocket,
  options: WaitOptions,
  navigationWatcher?: NavigationWatcher
): Promise<void> {
  const timeout = options.timeout ?? 10000;
  const hasWait = options.waitFor || options.waitForText || options.waitForIdle || options.waitForNavigation;

  if (!hasWait) return;

  if (options.waitForNavigation) {
    if (!navigationWatcher) {
      throw new Error('waitForNavigation requires a navigation watcher armed before the action');
    }
    await navigationWatcher.wait(timeout);
  }

  if (options.waitForIdle) {
    await waitForIdle(context, ws, timeout);
  }

  // Resolve frame context for wait conditions if specified
  let waitContextId: number | undefined;
  if (options.waitForFrame && (options.waitFor || options.waitForText)) {
    const frameStart = Date.now();
    let frameResolved = false;
    let lastError: Error | undefined;
    while (Date.now() - frameStart < timeout) {
      try {
        waitContextId = await context.resolveFrameContext(ws, options.waitForFrame);
        frameResolved = true;
        break;
      } catch (e) {
        lastError = e as Error;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (!frameResolved) {
      throw new Error(`Timeout waiting for frame: ${options.waitForFrame}. Last error: ${lastError?.message}`);
    }
  }

  if (options.waitFor) {
    await waitForSelector(context, ws, options.waitFor, timeout, waitContextId);
  }

  if (options.waitForText) {
    await waitForText(context, ws, options.waitForText, timeout, waitContextId);
  }
}
