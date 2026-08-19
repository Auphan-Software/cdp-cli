import { CDPContext } from '../context.js';
import { describeChar, describeKey, type KeyDescriptor } from '../keys.js';
import { BrowserConnection } from '../cdp/browser-connection.js';
import type { TargetExecutionContext, TargetRecord } from '../cdp/target-registry.js';

export interface PublicTarget {
  targetId: string;
  type: string;
  subtype?: string;
  title: string;
  url: string;
  attached: boolean;
  parentTargetId?: string;
  parentFrameId?: string;
  browserContextId?: string;
  childTargetIds: string[];
}

export interface IframeTargetResolution {
  parentTargetId: string;
  selector: string;
  frameId: string;
  /** Null means the frame is same-process and has no child Target session. */
  target: PublicTarget | null;
}

export interface TargetEvaluationOptions {
  awaitPromise?: boolean;
  timeoutMs?: number;
  userGesture?: boolean;
}

export interface TargetEvaluationResult<T = unknown> {
  targetId: string;
  type: string;
  value: T;
}

export interface TargetElementState {
  targetId: string;
  selector: string;
  tagName: string;
  id: string | null;
  name: string | null;
  type: string | null;
  value: string | null;
  valueLength: number | null;
  checked: boolean | null;
  disabled: boolean;
  readOnly: boolean;
  focused: boolean;
  connected: boolean;
  valid: boolean | null;
}

export interface TargetFillResult {
  targetId: string;
  selector: string;
  requestedValue: string;
  previousValue: string | null;
  actualValue: string | null;
  valueApplied: boolean;
  valueChanged: boolean;
  state: TargetElementState;
}

export interface TargetPressKeyOptions {
  /** Focus this exact, unique element before dispatching the key. */
  selector?: string;
}

export interface TargetPressKeyResult {
  targetId: string;
  selector: string | null;
  key: string;
  code: string;
  keyCode: number;
}

interface ResolvedElement {
  objectId: string;
  state: TargetElementState;
}

/** Return page/OOPIF topology with all URLs already query/fragment-redacted. */
export async function listTargets(context: CDPContext): Promise<PublicTarget[]> {
  return withBrowser(context, async (browser) => {
    const ownedTargetIds = await context.getSessionOwnedTargetIds();
    const targets = (await browser.refreshTargets())
      .filter((target) =>
        (target.type === 'page' || target.type === 'iframe') &&
        (ownedTargetIds === undefined || ownedTargetIds.has(target.targetId))
      );
    return targets.map((target) => toPublicTarget(target, targets));
  });
}

/** Resolve a literal targetId; this deliberately has no title/URL fallback. */
export async function resolveTarget(
  context: CDPContext,
  targetId: string
): Promise<PublicTarget> {
  await context.assertSessionTargetAccess(targetId);
  return context.withSessionTargetLease(targetId, () => withBrowser(context, async (browser) => {
    const target = browser.resolveTarget(targetId);
    const targets = browser.registry.list();
    return toPublicTarget(target, targets);
  }));
}

/**
 * Resolve an iframe owner in the parent target, ask DOM.describeNode for its
 * exact child frameId, then match only an iframe target with that same id.
 */
export async function resolveIframeTarget(
  context: CDPContext,
  parentTargetId: string,
  iframeSelector: string
): Promise<IframeTargetResolution> {
  await context.assertSessionTargetAccess(parentTargetId);
  return context.withSessionTargetLease(parentTargetId, () => withBrowser(context, async (browser) => {
    browser.resolveTarget(parentTargetId);
    const element = await resolveUniqueElement(browser, parentTargetId, iframeSelector);
    try {
      const described = await browser.sendToTarget(parentTargetId, 'DOM.describeNode', {
        objectId: element.objectId,
        depth: 0
      });
      const nodeName = typeof described?.node?.nodeName === 'string'
        ? described.node.nodeName.toLowerCase()
        : '';
      if (nodeName !== 'iframe' && nodeName !== 'frame') {
        throw new Error(`Selector does not identify an iframe: ${iframeSelector}`);
      }
      const frameId = described?.node?.frameId;
      if (typeof frameId !== 'string' || !frameId) {
        throw new Error(`Chrome did not expose a frameId for iframe: ${iframeSelector}`);
      }

      await browser.refreshTargets();
      const child = await browser.waitForTarget(
        (target) => target.type === 'iframe' && target.targetId === frameId
      );
      if (!child) {
        return {
          parentTargetId,
          selector: iframeSelector,
          frameId,
          target: null
        };
      }
      if (child.parentTargetId && child.parentTargetId !== parentTargetId) {
        throw new Error(
          `Frame ${frameId} belongs to target ${child.parentTargetId}, not ${parentTargetId}`
        );
      }
      const attached = await browser.ensureTargetSession(child.targetId);
      await context.assertSessionTargetAccess(child.targetId);
      return {
        parentTargetId,
        selector: iframeSelector,
        frameId,
        target: toPublicTarget(attached, browser.registry.list())
      };
    } finally {
      await releaseObject(browser, parentTargetId, element.objectId);
    }
  }));
}

/** Evaluate JavaScript in the exact target's own default execution context. */
export async function evaluateTarget<T = unknown>(
  context: CDPContext,
  targetId: string,
  expression: string,
  options: TargetEvaluationOptions = {}
): Promise<TargetEvaluationResult<T>> {
  await context.assertSessionTargetAccess(targetId);
  return context.withSessionTargetLease(targetId, () => withBrowser(context, async (browser) => {
    const result = await evaluateInTarget<T>(browser, targetId, expression, options);
    return {
      targetId,
      type: result.type,
      value: result.value
    };
  }));
}

/** Inspect one unique element inside an exact page or OOPIF target. */
export async function queryTarget(
  context: CDPContext,
  targetId: string,
  selector: string
): Promise<TargetElementState> {
  await context.assertSessionTargetAccess(targetId);
  return context.withSessionTargetLease(targetId, () => withBrowser(context, async (browser) => {
    const element = await resolveUniqueElement(browser, targetId, selector);
    try {
      return element.state;
    } finally {
      await releaseObject(browser, targetId, element.objectId);
    }
  }));
}

/** Focus, clear, type into, and re-read one target-local field. */
export async function fillTarget(
  context: CDPContext,
  targetId: string,
  selector: string,
  value: string
): Promise<TargetFillResult> {
  await context.assertSessionTargetAccess(targetId);
  return context.withSessionTargetLease(targetId, () => withBrowser(context, async (browser) => {
    let element = await resolveUniqueElement(browser, targetId, selector);
    const previousValue = element.state.value;
    try {
      const prepared = await browser.sendToTarget(targetId, 'Runtime.callFunctionOn', {
        objectId: element.objectId,
        functionDeclaration: `function() {
          if (!this.isConnected) return { error: 'detached' };
          if (this.disabled) return { error: 'disabled' };
          if (this.readOnly) return { error: 'readonly' };
          this.focus({ preventScroll: true });
          if (typeof this.select === 'function') this.select();
          else if (typeof this.setSelectionRange === 'function') {
            this.setSelectionRange(0, String(this.value || '').length);
          }
          return { focused: this.ownerDocument.activeElement === this };
        }`,
        returnByValue: true
      });
      const preparation = checkedCallValue(prepared, targetId, 'prepare field');
      if (preparation?.error) {
        throw new Error(`Cannot fill ${selector}: field is ${preparation.error}`);
      }
      if (preparation?.focused !== true) {
        // DOM.focus is a separate protocol path and handles controls whose
        // JavaScript focus method is wrapped by application code.
        await browser.sendToTarget(targetId, 'DOM.focus', { objectId: element.objectId });
      }

      await dispatchKey(browser, targetId, describeKey('backspace'));
      for (const char of value) {
        await dispatchKey(browser, targetId, describeChar(char));
      }

      // Native typing emits input. A completed field edit also emits change;
      // hosted payment integrations commonly validate on either event.
      try {
        await browser.sendToTarget(targetId, 'Runtime.callFunctionOn', {
          objectId: element.objectId,
          functionDeclaration: `function() {
            if (this.isConnected) this.dispatchEvent(new Event('change', { bubbles: true }));
            return this.isConnected;
          }`,
          returnByValue: true
        });
      } catch {
        // A reactive control may replace itself during the last key event. The
        // exact selector is resolved again below instead of trusting the old id.
      }

      await delay(20);
      await releaseObject(browser, targetId, element.objectId);
      element = await resolveUniqueElement(browser, targetId, selector);
      const state = element.state;
      return {
        targetId,
        selector,
        requestedValue: value,
        previousValue,
        actualValue: state.value,
        valueApplied: state.value === value,
        valueChanged: state.value !== previousValue,
        state
      };
    } finally {
      await releaseObject(browser, targetId, element.objectId);
    }
  }));
}

/** Dispatch one functional key pair to an exact target session. */
export async function pressKeyTarget(
  context: CDPContext,
  targetId: string,
  key: string,
  options: TargetPressKeyOptions = {}
): Promise<TargetPressKeyResult> {
  await context.assertSessionTargetAccess(targetId);
  return context.withSessionTargetLease(targetId, () => withBrowser(context, async (browser) => {
    const descriptor = describeKey(key);
    let element: ResolvedElement | undefined;
    try {
      if (options.selector) {
        element = await resolveUniqueElement(browser, targetId, options.selector);
        await browser.sendToTarget(targetId, 'DOM.focus', { objectId: element.objectId });
      } else {
        // This also proves that an unambiguous target-local default context is
        // live before routing input to whatever is already focused there.
        await browser.getDefaultExecutionContext(targetId);
      }
      await dispatchKey(browser, targetId, descriptor);
      return {
        targetId,
        selector: options.selector ?? null,
        key: descriptor.key,
        code: descriptor.code,
        keyCode: descriptor.keyCode
      };
    } finally {
      if (element) await releaseObject(browser, targetId, element.objectId);
    }
  }));
}

async function withBrowser<T>(
  context: CDPContext,
  operation: (browser: BrowserConnection) => Promise<T>
): Promise<T> {
  const browser = await context.connectBrowser();
  try {
    return await operation(browser);
  } finally {
    browser.close();
  }
}

async function evaluateInTarget<T>(
  browser: BrowserConnection,
  targetId: string,
  expression: string,
  options: TargetEvaluationOptions = {}
): Promise<{ type: string; value: T }> {
  const context = await browser.getDefaultExecutionContext(targetId);
  const result = await browser.sendToTarget(targetId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: options.awaitPromise ?? true,
    ...(options.userGesture === undefined ? {} : { userGesture: options.userGesture }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...executionContextSelector(context)
  });
  if (result?.exceptionDetails) {
    const text = typeof result.exceptionDetails.text === 'string'
      ? result.exceptionDetails.text
      : 'JavaScript evaluation failed';
    throw new Error(`Evaluation failed in target ${targetId}: ${text}`);
  }
  const remote = result?.result;
  if (!remote || typeof remote.type !== 'string') {
    throw new Error(`Chrome returned no evaluation result for targetId: ${targetId}`);
  }
  const value = Object.prototype.hasOwnProperty.call(remote, 'value')
    ? remote.value
    : remote.unserializableValue;
  return { type: remote.type, value: value as T };
}

async function resolveUniqueElement(
  browser: BrowserConnection,
  targetId: string,
  selector: string
): Promise<ResolvedElement> {
  if (!selector) throw new Error('A selector is required');
  const executionContext = await browser.getDefaultExecutionContext(targetId);
  const selectorJson = JSON.stringify(selector);
  const countResult = await browser.sendToTarget(targetId, 'Runtime.evaluate', {
    expression: `document.querySelectorAll(${selectorJson}).length`,
    returnByValue: true,
    ...executionContextSelector(executionContext)
  });
  if (countResult?.exceptionDetails) {
    throw new Error(`Invalid selector for target ${targetId}: ${selector}`);
  }
  const count = countResult?.result?.value;
  if (count !== 1) {
    throw new Error(
      count === 0
        ? `Element not found in target ${targetId}: ${selector}`
        : `Selector matched ${String(count)} elements in target ${targetId}: ${selector}`
    );
  }

  const objectResult = await browser.sendToTarget(targetId, 'Runtime.evaluate', {
    expression: `document.querySelector(${selectorJson})`,
    returnByValue: false,
    objectGroup: 'cdp-cli-target',
    ...executionContextSelector(executionContext)
  });
  if (objectResult?.exceptionDetails || objectResult?.result?.subtype === 'null') {
    throw new Error(`Element disappeared from target ${targetId}: ${selector}`);
  }
  const objectId = objectResult?.result?.objectId;
  if (typeof objectId !== 'string' || !objectId) {
    throw new Error(`Chrome did not return an element handle for target ${targetId}`);
  }

  try {
    const inspected = await browser.sendToTarget(targetId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(selector) {
        const matches = this.ownerDocument.querySelectorAll(selector);
        if (!this.isConnected || matches.length !== 1 || matches[0] !== this) {
          return { exact: false };
        }
        const hasValue = 'value' in this || this.isContentEditable;
        const value = 'value' in this
          ? String(this.value)
          : (this.isContentEditable ? String(this.textContent || '') : null);
        const validity = this.validity && typeof this.validity.valid === 'boolean'
          ? this.validity.valid
          : null;
        return {
          exact: true,
          tagName: String(this.tagName || '').toLowerCase(),
          id: this.id || null,
          name: typeof this.name === 'string' && this.name ? this.name : null,
          type: typeof this.type === 'string' && this.type ? this.type : null,
          value: hasValue ? value : null,
          valueLength: typeof value === 'string' ? value.length : null,
          checked: typeof this.checked === 'boolean' ? this.checked : null,
          disabled: this.disabled === true,
          readOnly: this.readOnly === true,
          focused: this.ownerDocument.activeElement === this,
          connected: this.isConnected === true,
          valid: validity
        };
      }`,
      arguments: [{ value: selector }],
      returnByValue: true
    });
    const value = checkedCallValue(inspected, targetId, 'inspect element');
    if (!value?.exact) {
      throw new Error(`Element changed while resolving target ${targetId}: ${selector}`);
    }
    return {
      objectId,
      state: normalizeElementState(targetId, selector, value)
    };
  } catch (error) {
    await releaseObject(browser, targetId, objectId);
    throw error;
  }
}

function normalizeElementState(
  targetId: string,
  selector: string,
  value: any
): TargetElementState {
  return {
    targetId,
    selector,
    tagName: typeof value.tagName === 'string' ? value.tagName : '',
    id: typeof value.id === 'string' ? value.id : null,
    name: typeof value.name === 'string' ? value.name : null,
    type: typeof value.type === 'string' ? value.type : null,
    value: typeof value.value === 'string' ? value.value : null,
    valueLength: typeof value.valueLength === 'number' ? value.valueLength : null,
    checked: typeof value.checked === 'boolean' ? value.checked : null,
    disabled: value.disabled === true,
    readOnly: value.readOnly === true,
    focused: value.focused === true,
    connected: value.connected === true,
    valid: typeof value.valid === 'boolean' ? value.valid : null
  };
}

function checkedCallValue(result: any, targetId: string, operation: string): any {
  if (result?.exceptionDetails) {
    throw new Error(`Could not ${operation} in target ${targetId}`);
  }
  return result?.result?.value;
}

function executionContextSelector(context: TargetExecutionContext): Record<string, unknown> {
  return context.uniqueId
    ? { uniqueContextId: context.uniqueId }
    : { contextId: context.id };
}

async function dispatchKey(
  browser: BrowserConnection,
  targetId: string,
  descriptor: KeyDescriptor
): Promise<void> {
  const base = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode
  };
  await browser.sendToTarget(targetId, 'Input.dispatchKeyEvent', {
    ...base,
    type: descriptor.text ? 'keyDown' : 'rawKeyDown',
    ...(descriptor.text
      ? { text: descriptor.text, unmodifiedText: descriptor.text }
      : {})
  });
  await browser.sendToTarget(targetId, 'Input.dispatchKeyEvent', {
    ...base,
    type: 'keyUp'
  });
}

async function releaseObject(
  browser: BrowserConnection,
  targetId: string,
  objectId: string
): Promise<void> {
  try {
    await browser.sendToTarget(targetId, 'Runtime.releaseObject', { objectId });
  } catch {
    // Navigation or reactive replacement can invalidate a handle first.
  }
}

function toPublicTarget(target: TargetRecord, allTargets: TargetRecord[]): PublicTarget {
  return {
    targetId: target.targetId,
    type: target.type,
    ...(target.subtype ? { subtype: target.subtype } : {}),
    title: target.title,
    url: target.url,
    attached: target.attached,
    ...(target.parentTargetId ? { parentTargetId: target.parentTargetId } : {}),
    ...(target.parentFrameId ? { parentFrameId: target.parentFrameId } : {}),
    ...(target.browserContextId ? { browserContextId: target.browserContextId } : {}),
    childTargetIds: allTargets
      .filter((child) => child.parentTargetId === target.targetId)
      .map((child) => child.targetId)
      .sort()
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
