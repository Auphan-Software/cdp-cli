# Wait-For on Click and Fill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--wait-for`, `--wait-for-text`, `--wait-for-idle`, `--wait-for-frame`, and `--timeout` options to the `click` and `fill` commands so callers can wait for DOM changes after an action.

**Architecture:** Extract the three wait functions (`waitForSelector`, `waitForText`, `waitForIdle`) and the frame-polling pattern from `pages.ts` into a new shared `src/commands/wait.ts` module. Both `click`/`fill` and `navigate` import from it. After executing their action, click/fill call `handleWaitOptions()` which orchestrates all wait conditions in the same order as navigate.

**Tech Stack:** TypeScript, Vitest, CDP WebSocket protocol

---

### Task 1: Create `src/commands/wait.ts` — Extract wait functions

**Files:**
- Create: `src/commands/wait.ts`
- Test: `tests/unit/commands/wait.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/commands/wait.test.ts`:

```typescript
/**
 * Tests for shared wait utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { waitForSelector, waitForText, handleWaitOptions } from '../../../src/commands/wait.js';

describe('Wait Utilities', () => {
  beforeEach(() => {
    installMockFetch();
  });

  describe('waitForSelector', () => {
    it('should resolve immediately when selector exists', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      // Override Runtime.evaluate to return true (element found)
      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await waitForSelector(context, ws as any, '#exists', 5000);
      // No error = success
    });

    it('should throw on timeout when selector never appears', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: false } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await expect(waitForSelector(context, ws as any, '#missing', 200))
        .rejects.toThrow('Timeout waiting for selector: #missing');
    });

    it('should pass contextId for frame-scoped waits', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      let capturedContextId: number | undefined;
      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          capturedContextId = msg.params.contextId;
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await waitForSelector(context, ws as any, '#el', 5000, 99);
      expect(capturedContextId).toBe(99);
    });
  });

  describe('waitForText', () => {
    it('should resolve when text is found', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await expect(
        (await import('../../../src/commands/wait.js')).waitForText(context, ws as any, 'hello', 5000)
      ).resolves.toBeUndefined();
    });

    it('should throw on timeout when text never appears', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: false } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await expect(
        (await import('../../../src/commands/wait.js')).waitForText(context, ws as any, 'nope', 200)
      ).rejects.toThrow('Timeout waiting for text: nope');
    });
  });

  describe('handleWaitOptions', () => {
    it('should be a no-op when no wait options provided', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      // Should resolve immediately with no options
      await handleWaitOptions(context, ws as any, {});
    });

    it('should wait for selector when waitFor is set', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await handleWaitOptions(context, ws as any, { waitFor: '#result' });
    });

    it('should wait for text when waitForText is set', async () => {
      const context = new CDPContext();
      const page = await context.findPage('page1');
      const ws = await context.connect(page) as unknown as MockWebSocket;

      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
          setTimeout(() => {
            ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
          }, 5);
          ws.sentMessages.push(msg);
          return;
        }
        origSend(data);
      };

      await handleWaitOptions(context, ws as any, { waitForText: 'Brandy' });
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/commands/wait.test.ts`
Expected: FAIL — cannot resolve `../../../src/commands/wait.js`

**Step 3: Write `src/commands/wait.ts`**

```typescript
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

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.requestWillBeSent') requestHandler();
      if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') responseHandler();
    } catch {
      // Ignore parse errors
    }
  });

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
 * Orchestrate all wait conditions after an action.
 * Order: idle → frame resolve → selector → text
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/commands/wait.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/wait.ts tests/unit/commands/wait.test.ts
git commit -m "feat: extract shared wait utilities to src/commands/wait.ts"
```

---

### Task 2: Refactor `pages.ts` to import from `wait.ts`

**Files:**
- Modify: `src/commands/pages.ts:76-304` (remove local wait functions, import from wait.ts)

**Step 1: Write the failing test (existing tests should still pass)**

No new test needed — existing `pages.test.ts` tests validate navigate still works.

Run: `npx vitest run tests/unit/commands/pages.test.ts`
Expected: PASS (baseline)

**Step 2: Modify `src/commands/pages.ts`**

Remove the `NavigateOptions` interface (lines 76-82), `waitForSelector` (87-112), `waitForText` (117-142), `waitForIdle` (147-197) functions. Import from `wait.ts` instead. Replace the wait section in `navigate()` (lines 249-282) with a call to `handleWaitOptions()`.

Replace the top of the file's imports and the `NavigateOptions` type:

```typescript
import { WebSocket } from 'ws';
import { CDPContext, Page } from '../context.js';
import { outputLines, outputLine, outputError, outputSuccess } from '../output.js';
import { DaemonClient } from '../daemon/client.js';
import { handleWaitOptions, type WaitOptions } from './wait.js';

type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

export type NavigateOptions = WaitOptions;
```

Delete the three local functions (`waitForSelector`, `waitForText`, `waitForIdle` — lines 84-197).

In the `navigate()` function, replace lines 249-282 (the wait options block) with:

```typescript
    // Handle wait options
    await handleWaitOptions(context, ws, options);
```

The `outputSuccess` call (line 284) stays the same.

**Step 3: Run tests**

Run: `npx vitest run tests/unit/commands/pages.test.ts`
Expected: PASS — navigate still works identically

**Step 4: Commit**

```bash
git add src/commands/pages.ts
git commit -m "refactor: pages.ts imports wait utilities from shared module"
```

---

### Task 3: Add `WaitOptions` to `click` function

**Files:**
- Modify: `src/commands/input.ts:735-1024`
- Test: `tests/unit/commands/input.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/commands/input.test.ts` inside the `describe('click', ...)` block:

```typescript
    it('should call handleWaitOptions after click when wait-for is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      // Override Runtime.evaluate to handle wait polling
      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const origSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector') && msg.params.expression.includes('#result')) {
            setTimeout(() => {
              ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
            }, 5);
            ws.sentMessages.push(msg);
            return;
          }
          origSend(data);
        };
        return ws;
      };

      await input.click(context, 'button', {
        page: 'page1',
        waitFor: '#result'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedFor).toBe('#result');
    });

    it('should call handleWaitOptions after click when wait-for-text is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const origSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
            setTimeout(() => {
              ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
            }, 5);
            ws.sentMessages.push(msg);
            return;
          }
          origSend(data);
        };
        return ws;
      };

      await input.click(context, 'button', {
        page: 'page1',
        waitForText: 'Brandy'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedForText).toBe('Brandy');
    });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/commands/input.test.ts`
Expected: FAIL — `waitFor` not a property of click options

**Step 3: Modify `src/commands/input.ts`**

Add import at top:

```typescript
import { handleWaitOptions, type WaitOptions } from './wait.js';
```

Change the `click` function signature's `optionsInput` type to include wait options:

```typescript
export async function click(
  context: CDPContext,
  targetInput: ClickTargetInput | string,
  optionsInput: { page: string; double?: boolean; longpress?: number; touch?: boolean; frame?: string } & WaitOptions
): Promise<void> {
```

After the click action completes (after the mouse/touch event dispatch, before `outputSuccess` — around line 985), add:

```typescript
    // Handle post-action wait conditions
    await handleWaitOptions(context, ws, {
      waitFor: options.waitFor,
      waitForText: options.waitForText,
      waitForIdle: options.waitForIdle,
      waitForFrame: options.waitForFrame,
      timeout: options.timeout
    });
```

In the `outputSuccess` call, add wait metadata:

```typescript
    outputSuccess('Click performed', {
      // ...existing fields...
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
      ...(options.waitForIdle && { waitedForIdle: true }),
      ...(options.waitForFrame && { waitedInFrame: options.waitForFrame })
    });
```

Note: `options` needs to be spread from `optionsInput` with the wait fields included. Since the existing code does `const options = { ...optionsInput };`, the WaitOptions fields will already be on `options`.

**Step 4: Run tests**

Run: `npx vitest run tests/unit/commands/input.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/input.ts tests/unit/commands/input.test.ts
git commit -m "feat: add --wait-for options to click command"
```

---

### Task 4: Add `WaitOptions` to `fill` function

**Files:**
- Modify: `src/commands/input.ts:1029-1168`
- Test: `tests/unit/commands/input.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/commands/input.test.ts` inside the `describe('fill', ...)` block:

```typescript
    it('should call handleWaitOptions after fill when wait-for is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const origSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('querySelector') && msg.params.expression.includes('#filtered-list')) {
            setTimeout(() => {
              ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
            }, 5);
            ws.sentMessages.push(msg);
            return;
          }
          origSend(data);
        };
        return ws;
      };

      await input.fill(context, 'input#search', 'cash discounting', {
        page: 'page1',
        waitFor: '#filtered-list'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedFor).toBe('#filtered-list');
    });

    it('should call handleWaitOptions after fill when wait-for-text is set', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const origSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.evaluate' && msg.params.expression.includes('innerText')) {
            setTimeout(() => {
              ws.simulateMessage({ id: msg.id, result: { result: { value: true } } });
            }, 5);
            ws.sentMessages.push(msg);
            return;
          }
          origSend(data);
        };
        return ws;
      };

      await input.fill(context, 'input#search', 'cash discounting', {
        page: 'page1',
        waitForText: 'Brandy'
      });

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.waitedForText).toBe('Brandy');
    });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/commands/input.test.ts`
Expected: FAIL — `waitFor` not a property of fill options

**Step 3: Modify `src/commands/input.ts`**

Change the `fill` function signature's `options` type:

```typescript
export async function fill(
  context: CDPContext,
  selector: string,
  value: string,
  options: { page: string; nth?: number; within?: string; frame?: string } & WaitOptions
): Promise<void> {
```

After the fill action completes (after both the frame and non-frame paths output, but before the catch), add `handleWaitOptions` and wait metadata. The cleanest approach: move the two `outputSuccess` calls to after a shared wait block.

In the **frame path** (after the typing loop, before `outputSuccess` around line 1098):

```typescript
      // Handle post-action wait conditions
      await handleWaitOptions(context, ws, {
        waitFor: options.waitFor,
        waitForText: options.waitForText,
        waitForIdle: options.waitForIdle,
        waitForFrame: options.waitForFrame,
        timeout: options.timeout
      });

      outputSuccess('Fill performed', {
        selector,
        value,
        within: options.within ?? null,
        frame: options.frame,
        ...(options.waitFor && { waitedFor: options.waitFor }),
        ...(options.waitForText && { waitedForText: options.waitForText }),
        ...(options.waitForIdle && { waitedForIdle: true }),
        ...(options.waitForFrame && { waitedInFrame: options.waitForFrame })
      });
```

In the **non-frame path** (after the typing loop, before `outputSuccess` around line 1149):

```typescript
      // Handle post-action wait conditions
      await handleWaitOptions(context, ws, {
        waitFor: options.waitFor,
        waitForText: options.waitForText,
        waitForIdle: options.waitForIdle,
        waitForFrame: options.waitForFrame,
        timeout: options.timeout
      });

      outputSuccess('Fill performed', {
        selector,
        value,
        within: options.within ?? null,
        frame: null,
        ...(options.waitFor && { waitedFor: options.waitFor }),
        ...(options.waitForText && { waitedForText: options.waitForText }),
        ...(options.waitForIdle && { waitedForIdle: true }),
        ...(options.waitForFrame && { waitedInFrame: options.waitForFrame })
      });
```

**Step 4: Run tests**

Run: `npx vitest run tests/unit/commands/input.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/input.ts tests/unit/commands/input.test.ts
git commit -m "feat: add --wait-for options to fill command"
```

---

### Task 5: Add CLI options to `click` and `fill` in `index.ts`

**Files:**
- Modify: `src/index.ts:501-682`

**Step 1: No new tests needed — this is CLI wiring only**

**Step 2: Modify `src/index.ts`**

In the **click command** (around line 578, after `.option('frame', ...)`), add:

```typescript
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after click'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after click'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after click',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Target iframe for wait checks (by selector or index)'
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
```

In the click handler (around line 616), add wait options to the options object:

```typescript
      {
        page: argv.page as string,
        double: argv.double as boolean,
        longpress: argv.longpress as number | undefined,
        touch: argv.touch as boolean,
        frame: argv.frame as string | undefined,
        waitFor: argv.waitFor as string | undefined,
        waitForText: argv.waitForText as string | undefined,
        waitForIdle: argv.waitForIdle as boolean | undefined,
        waitForFrame: argv.waitForFrame as string | undefined,
        timeout: argv.timeout as number | undefined
      }
```

In the **fill command** (around line 653, after `.option('frame', ...)`), add the same 5 options:

```typescript
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after fill'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after fill'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after fill',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Target iframe for wait checks (by selector or index)'
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
```

In the fill handler (around line 674), add wait options:

```typescript
      {
        page: argv.page as string,
        nth: argv.nth as number | undefined,
        within: argv.within as string | undefined,
        frame: argv.frame as string | undefined,
        waitFor: argv.waitFor as string | undefined,
        waitForText: argv.waitForText as string | undefined,
        waitForIdle: argv.waitForIdle as boolean | undefined,
        waitForFrame: argv.waitForFrame as string | undefined,
        timeout: argv.timeout as number | undefined
      }
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire --wait-for CLI options to click and fill commands"
```

---

### Task 6: Update README

**Files:**
- Modify: `README.md:339-415`

**Step 1: Update click section**

After the existing click examples (line 367), add:

```markdown

# Wait for DOM changes after click
cdp-cli click --text "Submit" "example" --wait-for "#success-message"
cdp-cli click --text "Submit" "example" --wait-for-text "Order confirmed"
cdp-cli click "#load-more" "example" --wait-for-idle
cdp-cli click "#tab2" "example" --wait-for ".tab-content" --wait-for-frame "#myframe"
```

Update the click description (line 340) to mention wait options.

**Step 2: Update fill section**

After the existing fill examples (line 415), add:

```markdown

# Wait for DOM changes after fill (e.g. filtered search results)
cdp-cli fill "#searchBox" "cash discounting" "example" --wait-for-text "Brandy"
cdp-cli fill "#filter" "active" "example" --wait-for ".results-loaded"
```

**Step 3: Add shared options note**

After each command's examples, add:

```markdown
Wait options (shared with navigate):
- `--wait-for <selector>`: Wait for CSS selector to appear after action
- `--wait-for-text <text>`: Wait for text to appear in page body
- `--wait-for-idle`: Wait for network idle and document ready
- `--wait-for-frame <spec>`: Target iframe for wait checks (by selector or index)
- `--timeout <ms>`: Timeout for wait operations (default: 10000)
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document --wait-for options on click and fill"
```

---

### Task 7: Run full test suite and verify

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Manual smoke test (if browser available)**

```bash
cdp-cli fill '#searchBox' 'cash discounting' "Jarvis" --wait-for-text 'Brandy' && \
cdp-cli click --text 'Brandy' --match contains "Jarvis"
```

**Step 3: Final commit if any fixes needed**
