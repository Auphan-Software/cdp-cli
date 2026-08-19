/**
 * Shared wait utilities for post-action polling
 */

import { WebSocket } from 'ws';
import { CDPContext } from '../context.js';

export interface WaitOptions {
  waitFor?: string;
  waitForText?: string;
  /** JavaScript condition that must evaluate to a truthy value. */
  waitForExpression?: string;
  /** URL substring identifying a network response to await. */
  waitForResponse?: string;
  /** Optional final HTTP status required with waitForResponse. */
  waitForStatus?: number;
  /** Optional literal text that must occur in the matched response body. */
  waitForBodyText?: string;
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

export interface NetworkIdleWatcher {
  /** Resolve once observed requests have finished and the network is quiet. */
  wait(timeout: number): Promise<void>;
  /** Detach the message listener; safe to call more than once. */
  dispose(): void;
}

export interface NetworkResponseResult {
  requestId: string;
  url: string;
  status: number;
  /** Present only when a body condition was requested; the body is never returned. */
  bodyMatched?: boolean;
}

export interface NetworkResponseWatcher {
  /** Resolve when the matching response (and optional body predicate) is observed. */
  wait(timeout: number): Promise<NetworkResponseResult>;
  /** Detach the message listener; safe to call more than once. */
  dispose(): void;
}

export interface StandaloneWaitResult {
  page: string;
  waitedFor: {
    selector?: string;
    text?: string;
    expression?: boolean;
    idle?: boolean;
    response?: string;
    status?: number;
    bodyText?: boolean;
    frame?: string;
  };
}

/**
 * Wait against an already-open page without dispatching an action. The network
 * watchers attach before polling begins, so activity occurring immediately
 * after the command connects is not missed. Page lookup inherits CDPContext's
 * exact session-target enforcement when --session is active.
 */
export async function waitForPageConditions(
  context: CDPContext,
  pageRef: string,
  options: WaitOptions
): Promise<StandaloneWaitResult> {
  const hasWait = options.waitFor || options.waitForText || options.waitForExpression || options.waitForIdle || options.waitForResponse;
  if (!hasWait) {
    throw new Error('Provide at least one wait condition (selector, text, expression, idle, or response)');
  }
  if (options.waitForNavigation) {
    throw new Error('wait-for-navigation requires an action that can trigger navigation');
  }
  if ((options.waitForStatus !== undefined || options.waitForBodyText !== undefined) && !options.waitForResponse) {
    throw new Error('waitForStatus and waitForBodyText require waitForResponse');
  }

  const page = await context.findPage(pageRef);
  await context.assertNoDevTools(page.id);
  const ws = await context.connect(page);
  let idleWatcher: NetworkIdleWatcher | undefined;
  let responseWatcher: NetworkResponseWatcher | undefined;

  try {
    await context.assertNoDialog(ws);
    await context.sendCommand(ws, 'Page.enable');
    await context.sendCommand(ws, 'Runtime.enable');
    if (options.waitForIdle) idleWatcher = await armNetworkIdleWatcher(context, ws);
    if (options.waitForResponse) responseWatcher = await armNetworkResponseWatcher(context, ws, options);

    await handleWaitOptions(context, ws, options, undefined, idleWatcher, responseWatcher);
    return {
      page: page.id,
      waitedFor: {
        ...(options.waitFor && { selector: options.waitFor }),
        ...(options.waitForText && { text: options.waitForText }),
        ...(options.waitForExpression && { expression: true }),
        ...(options.waitForIdle && { idle: true }),
        ...(options.waitForResponse && { response: options.waitForResponse }),
        ...(options.waitForStatus !== undefined && { status: options.waitForStatus }),
        ...(options.waitForBodyText && { bodyText: true }),
        ...(options.waitForFrame && { frame: options.waitForFrame })
      }
    };
  } finally {
    responseWatcher?.dispose();
    idleWatcher?.dispose();
    ws.close();
  }
}

/**
 * Begin observing network activity before an action is sent to the page.
 *
 * Request IDs, rather than a counter, make duplicate protocol messages and
 * redirect chains safe: a request is pending at most once and a terminal event
 * only completes an ID that was actually observed.
 */
export async function armNetworkIdleWatcher(
  context: CDPContext,
  ws: WebSocket
): Promise<NetworkIdleWatcher> {
  await context.sendCommand(ws, 'Network.enable');

  const pendingRequestIds = new Set<string>();
  let lastActivity = Date.now();
  const idleThreshold = 500;

  const messageHandler = (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const requestId: string | undefined = msg.params?.requestId;
      if (!requestId) return;

      if (msg.method === 'Network.requestWillBeSent') {
        // A redirect retains its request ID and remains pending; refreshing the
        // activity timestamp captures that real hop without double-counting it.
        if (!pendingRequestIds.has(requestId) || msg.params?.redirectResponse) {
          pendingRequestIds.add(requestId);
          lastActivity = Date.now();
        }
      }

      if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
        if (pendingRequestIds.delete(requestId)) {
          lastActivity = Date.now();
        }
      }
    } catch {
      // Ignore parse errors
    }
  };

  ws.on('message', messageHandler);

  return {
    async wait(timeout: number): Promise<void> {
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (pendingRequestIds.size === 0 && Date.now() - lastActivity >= idleThreshold) {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      throw new Error('Timeout waiting for idle state');
    },
    dispose() {
      ws.off('message', messageHandler);
    }
  };
}

/**
 * Begin observing a response before an action is dispatched. URL matching is a
 * literal substring deliberately: it is predictable for shell callers and
 * avoids accepting arbitrary regular expressions as CLI input. A body check is
 * deferred until loadingFinished and only yields a boolean, never body content.
 */
export async function armNetworkResponseWatcher(
  context: CDPContext,
  ws: WebSocket,
  options: Pick<WaitOptions, 'waitForResponse' | 'waitForStatus' | 'waitForBodyText'>
): Promise<NetworkResponseWatcher> {
  if (!options.waitForResponse) {
    throw new Error('waitForResponse is required to arm a network response watcher');
  }

  await context.sendCommand(ws, 'Network.enable');

  interface Candidate {
    requestId: string;
    url: string;
    status: number;
    finished: boolean;
    failed: boolean;
    bodyCheck?: Promise<boolean>;
  }

  const candidates = new Map<string, Candidate>();
  let lastMismatch = 'no matching response observed';

  const matches = (url: string, status: number): boolean => {
    if (!url.includes(options.waitForResponse!)) return false;
    if (options.waitForStatus !== undefined && status !== options.waitForStatus) {
      lastMismatch = `last matching URL had status ${status}, expected ${options.waitForStatus}`;
      return false;
    }
    return true;
  };

  const messageHandler = (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const requestId: string | undefined = msg.params?.requestId;
      if (!requestId) return;

      if (msg.method === 'Network.responseReceived') {
        const response = msg.params?.response;
        const url = String(response?.url ?? '');
        const status = Number(response?.status);
        if (!Number.isFinite(status) || !matches(url, status)) return;
        candidates.set(requestId, { requestId, url, status, finished: false, failed: false });
        return;
      }

      const candidate = candidates.get(requestId);
      if (!candidate) return;
      if (msg.method === 'Network.loadingFinished') candidate.finished = true;
      if (msg.method === 'Network.loadingFailed') {
        candidate.failed = true;
        lastMismatch = `matching response ${candidate.status} failed to finish loading`;
      }
    } catch {
      // Ignore malformed protocol events.
    }
  };

  ws.on('message', messageHandler);

  const bodyMatches = async (candidate: Candidate): Promise<boolean> => {
    if (!options.waitForBodyText) return true;
    if (!candidate.bodyCheck) {
      candidate.bodyCheck = context.sendCommand(ws, 'Network.getResponseBody', { requestId: candidate.requestId })
        .then((result) => {
          const raw = String(result?.body ?? '');
          const text = result?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
          // The predicate is deliberately bounded, and neither the original nor
          // truncated body is retained in result/error messages.
          return text.slice(0, 65_536).includes(options.waitForBodyText!);
        })
        .catch(() => false);
    }
    return candidate.bodyCheck;
  };

  return {
    async wait(timeout: number): Promise<NetworkResponseResult> {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        for (const candidate of candidates.values()) {
          if (candidate.failed) continue;
          if (!options.waitForBodyText) {
            return { requestId: candidate.requestId, url: candidate.url, status: candidate.status };
          }
          if (!candidate.finished) continue;
          if (await bodyMatches(candidate)) {
            return { requestId: candidate.requestId, url: candidate.url, status: candidate.status, bodyMatched: true };
          }
          lastMismatch = 'matching response body did not contain the requested text';
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timeout waiting for response: ${options.waitForResponse}. ${lastMismatch}`);
    },
    dispose() {
      ws.off('message', messageHandler);
    }
  };
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
  const watcher = await armNetworkIdleWatcher(context, ws);
  try {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await watcher.wait(timeout - (Date.now() - start));

      const docReady = await context.sendCommand(ws, 'Runtime.evaluate', {
        expression: `document.readyState === 'complete'`,
        returnByValue: true
      });
      if (docReady.result?.value === true) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error('Timeout waiting for idle state');
  } finally {
    watcher.dispose();
  }
}

/**
 * Poll a JavaScript expression until it resolves to a truthy value.
 *
 * This intentionally uses Runtime.evaluate rather than a page-side timer: the
 * caller retains the same timeout and frame semantics as the selector/text
 * waits, while `awaitPromise` lets an async predicate work without a wrapper.
 */
export async function waitForExpression(
  context: CDPContext,
  ws: WebSocket,
  expression: string,
  timeout: number,
  contextId?: number
): Promise<unknown> {
  const start = Date.now();
  const pollInterval = 100;
  let lastValue: unknown = undefined;
  let lastException: string | undefined;

  while (Date.now() - start < timeout) {
    try {
      const remaining = Math.max(1, timeout - (Date.now() - start));
      const result = await context.sendCommand(ws, 'Runtime.evaluate', {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
        timeout: remaining
      });

      if (result.exceptionDetails) {
        lastException = formatWaitText(result.exceptionDetails.text
          ?? result.exceptionDetails.exception?.description
          ?? 'JavaScript evaluation failed');
      } else {
        lastException = undefined;
        lastValue = result.result?.value ?? result.result?.unserializableValue ?? result.result?.description;
        if (lastValue) {
          return lastValue;
        }
      }
    } catch (error) {
      // Transient execution-context destruction is common immediately after a
      // navigation, and should behave like a false predicate until timeout.
      lastException = formatWaitText((error as Error).message);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  const detail = lastException
    ? `Last exception: ${lastException}`
    : `Last value: ${formatWaitValue(lastValue)}`;
  throw new Error(`Timeout waiting for expression. ${detail}`);
}

function formatWaitValue(value: unknown): string {
  try {
    const formatted = JSON.stringify(value);
    return (formatted ?? String(value)).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function formatWaitText(value: string): string {
  return value.slice(0, 500);
}

/**
 * Orchestrate all wait conditions after an action.
 * Order: navigation -> idle -> response -> frame resolve -> selector -> text -> expression
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
  navigationWatcher?: NavigationWatcher,
  networkIdleWatcher?: NetworkIdleWatcher,
  networkResponseWatcher?: NetworkResponseWatcher
): Promise<void> {
  const timeout = options.timeout ?? 10000;
  const hasWait = options.waitFor || options.waitForText || options.waitForExpression || options.waitForResponse || options.waitForIdle || options.waitForNavigation;

  if (!hasWait) return;

  if (options.waitForNavigation) {
    if (!navigationWatcher) {
      throw new Error('waitForNavigation requires a navigation watcher armed before the action');
    }
    await navigationWatcher.wait(timeout);
  }

  if (options.waitForIdle) {
    if (networkIdleWatcher) {
      await networkIdleWatcher.wait(timeout);
      const start = Date.now();
      let documentReady = false;
      while (Date.now() - start < timeout) {
        const docReady = await context.sendCommand(ws, 'Runtime.evaluate', {
          expression: `document.readyState === 'complete'`,
          returnByValue: true
        });
        if (docReady.result?.value === true) {
          documentReady = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!documentReady) {
        throw new Error('Timeout waiting for document ready state after network became idle');
      }
    } else {
      // Backward-compatible fallback for direct callers. Action commands arm
      // a watcher before dispatch so they cannot miss immediately-started I/O.
      await waitForIdle(context, ws, timeout);
    }
  }

  if (options.waitForResponse) {
    if (!networkResponseWatcher) {
      throw new Error('waitForResponse requires a response watcher armed before the action');
    }
    await networkResponseWatcher.wait(timeout);
  }

  // Resolve frame context for wait conditions if specified
  let waitContextId: number | undefined;
  if (options.waitForFrame && (options.waitFor || options.waitForText || options.waitForExpression)) {
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

  if (options.waitForExpression) {
    await waitForExpression(context, ws, options.waitForExpression, timeout, waitContextId);
  }
}
