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
  timeout?: number;
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
 * Order: idle -> frame resolve -> selector -> text
 */
export async function handleWaitOptions(
  context: CDPContext,
  ws: WebSocket,
  options: WaitOptions
): Promise<void> {
  const timeout = options.timeout ?? 10000;
  const hasWait = options.waitFor || options.waitForText || options.waitForIdle;

  if (!hasWait) return;

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
