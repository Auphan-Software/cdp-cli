/**
 * Input automation commands: click, fill, select, press-key
 */

import { CDPContext, type Page } from '../context.js';
import { outputError, outputCommandError, outputSuccess } from '../output.js';
import { describeChar, describeKey, type KeyDescriptor } from '../keys.js';
import {
  armNavigationWatcher,
  armNetworkIdleWatcher,
  armNetworkResponseWatcher,
  effectiveWaitFrame,
  handleWaitOptions,
  type NavigationWatcher,
  type NetworkIdleWatcher,
  type NetworkResponseWatcher,
  type WaitOptions
} from './wait.js';

type TextMatchMode = 'exact' | 'contains' | 'regex';

interface ClickTargetInput {
  selector?: string;
  text?: string;
  match?: TextMatchMode;
  caseSensitive?: boolean;
  nth?: number;
  within?: string;
}

interface DragTargetInput {
  selector?: string;
  text?: string;
  match?: TextMatchMode;
  caseSensitive?: boolean;
  nth?: number;
  within?: string;
  x?: number;
  y?: number;
}

interface DragOptions {
  page: string;
  touch?: boolean;
  longpress?: number;
  steps?: number;
  duration?: number;
  frame?: string;
}

interface ElementMetadata {
  tagName: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface ElementMatch {
  nodeId: number;
  /** Retained remote handle, used to scroll and hit-test the element. */
  objectId?: string;
  metadata: ElementMetadata;
}

/**
 * Result of scrolling an element into view and hit-testing its center.
 */
interface ClickPoint {
  rect: ElementMetadata['rect'];
  scrolled: boolean;
  inViewport: boolean;
  hitOk: boolean;
  hit: string | null;
  /** The click point resolves to a nested frame, so the event is delivered to *its* document. */
  hitIsFrame: boolean;
  hitFrameSrc: string | null;
}

class ClickError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class FillError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Helper function to find element by selector
 */
async function findElement(
  context: CDPContext,
  ws: any,
  selector: string
): Promise<{ nodeId: number }> {
  await context.sendCommand(ws, 'DOM.enable');
  const doc = await context.sendCommand(ws, 'DOM.getDocument');
  const node = await context.sendCommand(ws, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector
  });

  if (!node.nodeId) {
    throw new Error(`Element not found: ${selector}`);
  }

  return { nodeId: node.nodeId };
}

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  const sliceLength = Math.max(maxLength - 3, 0);
  const prefix = text.slice(0, sliceLength);
  return `${prefix}...`;
}

function normalizeMetadata(raw: any): ElementMetadata {
  const classes = Array.isArray(raw?.classes)
    ? raw.classes.filter((cls: unknown): cls is string => typeof cls === 'string')
    : [];
  const rectSource = raw?.rect ?? {};
  const toNumber = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const tagName =
    typeof raw?.tagName === 'string' ? raw.tagName.toLowerCase() : '';

  return {
    tagName,
    id: typeof raw?.id === 'string' && raw.id.length > 0 ? raw.id : null,
    classes,
    text: typeof raw?.text === 'string' ? raw.text : '',
    rect: {
      x: toNumber(rectSource.x),
      y: toNumber(rectSource.y),
      width: toNumber(rectSource.width),
      height: toNumber(rectSource.height)
    }
  };
}

function summarizeMatches(matches: ElementMatch[]): string[] {
  return matches.map((match, index) => {
    const { tagName, id, classes, text } = match.metadata;
    let line = `${index + 1}. [${tagName}]`;
    if (text) line += ` "${truncate(text, 50)}"`;
    // Build selector from metadata
    let selector = tagName;
    if (id) selector += `#${id}`;
    if (classes.length) selector += `.${classes.join('.')}`;
    line += ` → ${selector}`;
    return line;
  });
}

function roundRect(rect: ElementMetadata['rect']): ElementMetadata['rect'] {
  const roundValue = (value: number): number =>
    Number.isFinite(value) ? Math.round(value) : 0;

  return {
    x: roundValue(rect.x),
    y: roundValue(rect.y),
    width: roundValue(rect.width),
    height: roundValue(rect.height)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isExecutionContextLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context|context.*destroyed|cannot find context|target closed|session closed|inspected target navigated|no frame with given id/i.test(message);
}

/**
 * Dispatch a full keyDown/keyUp pair for one key.
 */
async function dispatchKey(
  context: CDPContext,
  ws: any,
  descriptor: KeyDescriptor
): Promise<void> {
  const base = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode
  };

  await context.sendCommand(ws, 'Input.dispatchKeyEvent', {
    ...base,
    // keyDown carries the inserted text; a bare rawKeyDown would type nothing.
    type: descriptor.text ? 'keyDown' : 'rawKeyDown',
    ...(descriptor.text
      ? { text: descriptor.text, unmodifiedText: descriptor.text }
      : {})
  });

  await context.sendCommand(ws, 'Input.dispatchKeyEvent', {
    ...base,
    type: 'keyUp'
  });
}

async function safeReleaseObject(
  context: CDPContext,
  ws: any,
  objectId?: string
): Promise<void> {
  if (!objectId) {
    return;
  }
  try {
    await context.sendCommand(ws, 'Runtime.releaseObject', { objectId });
  } catch {
    // Ignore release errors – the target may already be gone.
  }
}

async function getElementMetadataFromObjectId(
  context: CDPContext,
  ws: any,
  objectId: string,
  release: boolean = true
): Promise<ElementMetadata> {
  try {
    const callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `
        function() {
          const rect = this.getBoundingClientRect();
          const classList = this.classList ? Array.from(this.classList) : [];
          const textContent = (this.innerText || '').trim();
          return {
            tagName: (this.tagName || '').toLowerCase(),
            id: this.id || null,
            classes: classList,
            text: textContent,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          };
        }
      `,
      returnByValue: true
    });
    return normalizeMetadata(callResult.result?.value);
  } finally {
    if (release) {
      await safeReleaseObject(context, ws, objectId);
    }
  }
}

/**
 * Scroll the element into view when needed, then re-measure and hit-test it.
 *
 * CDP input coordinates are viewport-relative, so an element sitting below the
 * fold must be scrolled in first or the events land on empty space. The hit
 * test then confirms the click point actually reaches the element rather than
 * an overlay stacked on top of it.
 */
async function getClickPoint(
  context: CDPContext,
  ws: any,
  objectId: string,
  priorRect: ElementMetadata['rect'],
  scroll: boolean = true
): Promise<ClickPoint> {
  // DOM.scrollIntoViewIfNeeded accounts for clipping scroll containers, which
  // a viewport-only visibility test cannot: an element scrolled out of an
  // inner overflow box still reports an on-screen bounding rect.
  let scrollError: string | undefined;
  if (scroll) {
    try {
      await context.sendCommand(ws, 'DOM.scrollIntoViewIfNeeded', { objectId });
    } catch (error) {
      scrollError = (error as Error).message;
    }
  }

  const callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `
      function() {
        const el = this;
        if (!el.isConnected) {
          return { detached: true };
        }

        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const inViewport =
          cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;

        let hit = inViewport ? document.elementFromPoint(cx, cy) : null;
        while (hit && hit.shadowRoot) {
          const deeper = hit.shadowRoot.elementFromPoint(cx, cy);
          if (!deeper || deeper === hit) break;
          hit = deeper;
        }

        // The click counts as landing on the target if the hit node is the
        // element itself or anything nested inside it.
        let node = hit;
        let hitOk = false;
        while (node) {
          if (node === el) {
            hitOk = true;
            break;
          }
          const root = node.getRootNode();
          node = node.parentElement ||
            (root && root.host ? root.host : null);
        }

        const describe = (n) => {
          if (!n) return null;
          let out = (n.tagName || '').toLowerCase();
          if (n.id) out += '#' + n.id;
          if (n.classList && n.classList.length) {
            out += '.' + Array.from(n.classList).join('.');
          }
          return out;
        };

        // A frame under the click point means the event is handed to another
        // document, which this session cannot see into. Whether it arrived is
        // only knowable after the fact - see verifyFrameReached.
        const hitTag = hit && hit.tagName;
        const hitIsFrame = hitTag === 'IFRAME' || hitTag === 'FRAME';

        // Origin and path only: hosted widgets carry session tokens and
        // customer data in the iframe query string, and this goes to logs.
        let hitFrameSrc = null;
        if (hitIsFrame) {
          const raw = hit.getAttribute('src');
          if (raw) {
            try {
              const parsed = new URL(raw, document.baseURI);
              hitFrameSrc = parsed.origin + parsed.pathname;
            } catch (e) {
              hitFrameSrc = raw.split('?')[0].split('#')[0];
            }
          }
        }

        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          inViewport,
          hitOk,
          hit: describe(hit),
          hitIsFrame,
          hitFrameSrc
        };
      }
    `,
    returnByValue: true
  });

  const value = callResult.result?.value;

  if (!value) {
    throw new ClickError(
      'Could not measure the element before clicking',
      'CLICK_MEASURE_FAILED',
      {}
    );
  }

  if (value.detached) {
    throw new ClickError(
      'Element was removed from the document before the click',
      'CLICK_DETACHED',
      {}
    );
  }

  const rect = normalizeMetadata({ rect: value.rect }).rect;

  if (scrollError && !value.hitOk) {
    throw new ClickError(
      `Element could not be scrolled into view: ${scrollError}`,
      'CLICK_OFFSCREEN',
      { rect: roundRect(rect) }
    );
  }

  return {
    rect,
    scrolled: rect.x !== priorRect.x || rect.y !== priorRect.y,
    inViewport: Boolean(value.inViewport),
    hitOk: Boolean(value.hitOk),
    hit: typeof value.hit === 'string' ? value.hit : null,
    hitIsFrame: Boolean(value.hitIsFrame),
    hitFrameSrc: typeof value.hitFrameSrc === 'string' ? value.hitFrameSrc : null
  };
}

/**
 * Retain a handle on the frame element sitting under the click point.
 *
 * The check has to be about the frame that was aimed at, not about whatever
 * occupies those coordinates once the click has been dispatched: a page that
 * is still settling moves things under the cursor, and re-deriving the node
 * would name the element that drifted in rather than the frame.
 */
async function getHitFrameHandle(
  context: CDPContext,
  ws: any,
  objectId: string,
  point: { x: number; y: number }
): Promise<string | undefined> {
  const callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `
      function(cx, cy) {
        // Same descent as the hit test, or this would retain the shadow host
        // where that one resolved a frame inside the shadow root.
        let hit = document.elementFromPoint(cx, cy);
        while (hit && hit.shadowRoot) {
          const deeper = hit.shadowRoot.elementFromPoint(cx, cy);
          if (!deeper || deeper === hit) break;
          hit = deeper;
        }

        const tag = hit && hit.tagName;
        return (tag === 'IFRAME' || tag === 'FRAME') ? hit : null;
      }
    `,
    arguments: [{ value: point.x }, { value: point.y }]
  });

  return callResult.result?.objectId;
}

/**
 * Watch the document that owns the frame for the click we are about to send.
 *
 * Events do not cross a frame boundary: a click that goes into the frame is
 * invisible to the document around it. So if that document sees the mousedown,
 * the frame did not get it - the browser delivered it outside the frame, where
 * it did nothing the caller asked for. Armed before dispatch, read after.
 */
async function armFrameWitness(
  context: CDPContext,
  ws: any,
  frameObjectId: string
): Promise<void> {
  await context.sendCommand(ws, 'Runtime.callFunctionOn', {
    objectId: frameObjectId,
    functionDeclaration: `
      function() {
        const doc = this.ownerDocument;
        doc.__cdpClickWitness = null;
        doc.__cdpClickWitnessListener = (event) => {
          if (doc.__cdpClickWitness) return;
          const n = event.target;
          let out = (n && n.tagName ? n.tagName : 'unknown').toLowerCase();
          if (n && n.id) out += '#' + n.id;
          if (n && n.classList && n.classList.length) {
            out += '.' + Array.from(n.classList).join('.');
          }
          doc.__cdpClickWitness = out;
        };
        doc.addEventListener('mousedown', doc.__cdpClickWitnessListener, true);
        doc.addEventListener('touchstart', doc.__cdpClickWitnessListener, true);
      }
    `
  });
}

/**
 * Did the click actually get into the frame under the click point?
 *
 * Chrome delivers input to a nested frame through the browser process, and a
 * click can miss it - the frame's routing is not live the moment the element
 * mounts, and a page still settling can move what is under the point between
 * the hit test and the dispatch. Either way the event lands in the surrounding
 * document and silently does nothing. Measured on a live Bambora card field
 * (Chrome 151.0.7922.138): clicks up to ~500ms after the iframe mounted were
 * swallowed, clicks from ~1s on landed.
 *
 * Two signals, each used only in the direction it is trustworthy:
 *  - the surrounding document seeing the event proves it did NOT reach the
 *    frame (measured: the only signal that stays correct when the frame's own
 *    content calls preventDefault on mousedown, which suppresses focus);
 *  - focus moving to the frame element proves it DID, and arrives in 15-40ms,
 *    so the common case does not pay the whole window.
 */
async function verifyFrameReached(
  context: CDPContext,
  ws: any,
  frameObjectId: string,
  timeoutMs: number = 500
): Promise<{ reached: boolean | null; sawInDocument: string | null; active: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: { reached: boolean | null; sawInDocument: string | null; active: string | null } = {
    reached: true,
    sawInDocument: null,
    active: null
  };

  try {
    for (;;) {
      // The click may have navigated the page or torn the frame down, which
      // takes the execution context with it. That is a click that plainly did
      // something, so it is unverifiable rather than failed.
      let callResult;
      try {
        callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
        objectId: frameObjectId,
        functionDeclaration: `
          function() {
            const doc = this.ownerDocument;
            const active = doc.activeElement;

            const describe = (n) => {
              if (!n) return null;
              let out = (n.tagName || '').toLowerCase();
              if (n.id) out += '#' + n.id;
              if (n.classList && n.classList.length) {
                out += '.' + Array.from(n.classList).join('.');
              }
              return out;
            };

            return {
              saw: doc.__cdpClickWitness || null,
              focused: active === this,
              active: describe(active)
            };
          }
        `,
          returnByValue: true
        });
      } catch {
        return { reached: null, sawInDocument: null, active: null };
      }

      const value = callResult.result?.value;
      if (value) {
        last = {
          // Nothing seen outside the frame is the verdict this settles on, so
          // it only counts once the window has run out.
          reached: !value.saw,
          sawInDocument: typeof value.saw === 'string' ? value.saw : null,
          active: typeof value.active === 'string' ? value.active : null
        };

        if (value.saw) {
          return last;
        }
        if (value.focused) {
          return { ...last, reached: true };
        }
      }

      if (Date.now() >= deadline) {
        return last;
      }
      await delay(25);
    }
  } finally {
    // Best effort: if the context is gone there is no listener left to remove,
    // and failing to tidy up must not turn a verdict into an error.
    try {
      await context.sendCommand(ws, 'Runtime.callFunctionOn', {
        objectId: frameObjectId,
        functionDeclaration: `
          function() {
            const doc = this.ownerDocument;
            if (doc.__cdpClickWitnessListener) {
              doc.removeEventListener('mousedown', doc.__cdpClickWitnessListener, true);
              doc.removeEventListener('touchstart', doc.__cdpClickWitnessListener, true);
            }
            delete doc.__cdpClickWitnessListener;
            delete doc.__cdpClickWitness;
          }
        `
      });
    } catch {
      // context destroyed by the click - nothing to clean up
    }
  }
}

/**
 * Arm a capture listener in the document that owns an ordinary click target.
 * CDP accepting Input.dispatchMouseEvent only proves that the browser process
 * accepted the command. A background/focus-stolen window can accept it without
 * the page ever receiving the corresponding mouse event.
 */
async function armDocumentClickWitness(
  context: CDPContext,
  ws: any,
  objectId: string,
  point: { x: number; y: number },
  expectedEventType: 'mousedown' | 'touchstart'
): Promise<void> {
  await context.sendCommand(ws, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `
      function(expectedX, expectedY, expectedEventType) {
        const doc = this.ownerDocument;
        const expectedTarget = this;
        doc.__cdpDocumentClickWitness = {
          expectedX,
          expectedY,
          expectedEventType,
          seen: false,
          event: null
        };
        doc.__cdpDocumentClickWitnessListener = (event) => {
          const witness = doc.__cdpDocumentClickWitness;
          if (!witness || witness.seen) return;
          if (event.type !== witness.expectedEventType) return;
          const eventPoint = event.type === 'touchstart' ? event.touches[0] : event;
          if (!eventPoint ||
              (event.type === 'mousedown' && event.button !== 0) ||
              Math.abs(eventPoint.clientX - witness.expectedX) > 1 ||
              Math.abs(eventPoint.clientY - witness.expectedY) > 1) return;

          const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
          const targetMatches = path.includes(expectedTarget) ||
            (event.target && expectedTarget.contains(event.target));
          if (!targetMatches) return;

          const n = event.target;
          let target = (n && n.tagName ? n.tagName : 'unknown').toLowerCase();
          if (n && n.id) target += '#' + n.id;
          witness.seen = true;
          witness.event = {
            type: event.type,
            x: eventPoint.clientX,
            y: eventPoint.clientY,
            target
          };
        };
        doc.addEventListener('mousedown', doc.__cdpDocumentClickWitnessListener, true);
        doc.addEventListener('touchstart', doc.__cdpDocumentClickWitnessListener, true);
      }
    `,
    arguments: [{ value: point.x }, { value: point.y }, { value: expectedEventType }]
  });
}

/**
 * Read and remove the ordinary-document click witness. A destroyed execution
 * context means the click navigated or otherwise replaced the document, so the
 * result is deliberately unverifiable rather than a false failure.
 */
async function verifyDocumentClickDelivered(
  context: CDPContext,
  ws: any,
  objectId: string
): Promise<{ delivered: boolean | null; event: Record<string, unknown> | null }> {
  try {
    const callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `
        function() {
          const doc = this.ownerDocument;
          const witness = doc.__cdpDocumentClickWitness;
          return {
            documentSurvives: !!doc.defaultView && doc.defaultView.document === doc,
            seen: witness ? witness.seen === true : null,
            event: witness ? witness.event : null
          };
        }
      `,
      returnByValue: true
    });

    const value = callResult.result?.value;
    if (value?.documentSurvives !== true || typeof value?.seen !== 'boolean') {
      return { delivered: null, event: null };
    }
    return {
      delivered: value.seen,
      event: value.event && typeof value.event === 'object' ? value.event : null
    };
  } catch {
    return { delivered: null, event: null };
  } finally {
    try {
      await context.sendCommand(ws, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `
          function() {
            const doc = this.ownerDocument;
            if (doc.__cdpDocumentClickWitnessListener) {
              doc.removeEventListener('mousedown', doc.__cdpDocumentClickWitnessListener, true);
              doc.removeEventListener('touchstart', doc.__cdpDocumentClickWitnessListener, true);
            }
            delete doc.__cdpDocumentClickWitnessListener;
            delete doc.__cdpDocumentClickWitness;
          }
        `
      });
    } catch {
      // Navigation/context loss also removes the old document and its listener.
    }
  }
}

/**
 * Turn a remote array of elements into matches, retaining each element handle.
 */
async function matchesFromArrayHandle(
  context: CDPContext,
  ws: any,
  arrayObjectId: string
): Promise<ElementMatch[]> {
  const matches: ElementMatch[] = [];

  try {
    const props = await context.sendCommand(ws, 'Runtime.getProperties', {
      objectId: arrayObjectId,
      ownProperties: true
    });

    for (const descriptor of props.result ?? []) {
      if (!/^\d+$/.test(descriptor.name)) {
        continue;
      }

      const objectId = descriptor.value?.objectId;
      if (!objectId) {
        continue;
      }

      let nodeId = -1;
      try {
        const requested = await context.sendCommand(ws, 'DOM.requestNode', {
          objectId
        });
        if (typeof requested?.nodeId === 'number') {
          nodeId = requested.nodeId;
        }
      } catch {
        // Elements inside frames may not map to a nodeId; coordinates still work.
      }

      const metadata = await getElementMetadataFromObjectId(
        context,
        ws,
        objectId,
        false
      );

      matches.push({ nodeId, objectId, metadata });
    }
  } finally {
    await safeReleaseObject(context, ws, arrayObjectId);
  }

  return matches;
}

async function getElementMetadataForNode(
  context: CDPContext,
  ws: any,
  nodeId: number
): Promise<{ metadata: ElementMetadata; objectId?: string }> {
  const resolved = await context.sendCommand(ws, 'DOM.resolveNode', { nodeId });
  const objectId = resolved.object?.objectId;

  if (!objectId) {
    const described = await context.sendCommand(ws, 'DOM.describeNode', {
      nodeId,
      depth: 0,
      pierce: false
    });
    const attributes = Array.isArray(described.node?.attributes)
      ? described.node.attributes
      : [];
    const attrMap: Record<string, string> = {};
    for (let i = 0; i < attributes.length; i += 2) {
      attrMap[attributes[i]] = attributes[i + 1];
    }

    return {
      metadata: normalizeMetadata({
        tagName: typeof described.node?.nodeName === 'string'
          ? described.node.nodeName.toLowerCase()
          : '',
        id: attrMap.id ?? null,
        classes: (attrMap.class || '')
          .split(/\s+/)
          .filter(Boolean),
        text: '',
        rect: {
          x: 0,
          y: 0,
          width: 0,
          height: 0
        }
      })
    };
  }

  return {
    metadata: await getElementMetadataFromObjectId(context, ws, objectId, false),
    objectId
  };
}

async function resolveBySelector(
  context: CDPContext,
  ws: any,
  selector: string,
  within?: string
): Promise<ElementMatch[]> {
  const doc = await context.sendCommand(ws, 'DOM.getDocument');

  let rootNodeId = doc.root.nodeId;
  if (within) {
    const containerResult = await context.sendCommand(ws, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: within
    });
    if (!containerResult.nodeId) {
      throw new Error(`Container not found: ${within}`);
    }
    rootNodeId = containerResult.nodeId;
  }

  const result = await context.sendCommand(ws, 'DOM.querySelectorAll', {
    nodeId: rootNodeId,
    selector
  });

  const nodeIds: number[] = Array.isArray(result.nodeIds)
    ? result.nodeIds
    : typeof (result as { nodeId?: number }).nodeId === 'number'
      ? [ (result as { nodeId: number }).nodeId ]
      : [];

  const matches: ElementMatch[] = [];

  for (const nodeId of nodeIds) {
    const { metadata, objectId } = await getElementMetadataForNode(context, ws, nodeId);
    matches.push({ nodeId, objectId, metadata });
  }

  return matches;
}

function buildTextSearchExpression(
  text: string,
  match: TextMatchMode,
  caseSensitive: boolean,
  within?: string
): string {
  const serializedText = JSON.stringify(text);
  const serializedMatch = JSON.stringify(match);
  const caseFlag = caseSensitive ? 'true' : 'false';
  const serializedWithin = within ? JSON.stringify(within) : 'null';

  return `
(() => {
  const pattern = ${serializedText};
  const mode = ${serializedMatch};
  const caseSensitive = ${caseFlag};
  const withinSelector = ${serializedWithin};
  let normalizedPattern = pattern;
  const results = [];
  const seen = new Set();
  let regex = null;
  const actionableSelector = 'button,[role="button"],li.item,[class*="-btn"],input[type="submit"],input[type="button"],input[type="reset"],input[type="checkbox"],input[type="radio"],a[href],textarea,select,label,summary';

  if (mode === 'regex') {
    try {
      regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (error) {
      return { error: error.message };
    }
  } else if (!caseSensitive && typeof pattern === 'string') {
    normalizedPattern = pattern.toLowerCase();
  }

  let root = document.body || document.documentElement;
  if (withinSelector) {
    const container = document.querySelector(withinSelector);
    if (!container) {
      return { error: 'Container not found: ' + withinSelector };
    }
    root = container;
  }
  if (!root) {
    return { matches: [] };
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!el) continue;

    const textContent = (el.innerText || '').trim();
    if (!textContent) continue;

    let isMatch = false;
    if (mode === 'regex') {
      if (!regex) continue;
      isMatch = regex.test(textContent);
    } else {
      const candidate = caseSensitive ? textContent : textContent.toLowerCase();
      if (mode === 'contains') {
        isMatch = candidate.includes(normalizedPattern);
      } else {
        isMatch = candidate === normalizedPattern;
      }
    }

    if (isMatch) {
      const actionable = el.closest(actionableSelector);
      const directMatch = el.matches && el.matches(actionableSelector);
      let target = actionable || (directMatch ? el : null);

      // Fallback: check for inline handlers or button-like classes
      if (!target) {
        const hasInlineHandler = (node) => {
          return node.hasAttribute && (
            node.hasAttribute('onclick') ||
            node.hasAttribute('onmousedown') ||
            node.hasAttribute('onmouseup') ||
            node.hasAttribute('ontouchstart') ||
            node.hasAttribute('onpointerdown') ||
            node.hasAttribute('ng-click') ||
            node.hasAttribute('data-action')
          );
        };

        const hasButtonClass = (node) => {
          if (!node.classList) return false;
          for (const cls of node.classList) {
            if (cls.endsWith('-btn') || cls.includes('button')) return true;
          }
          return false;
        };

        // Check element and ancestors for clickability
        let candidate = el;
        while (candidate && candidate !== document.body) {
          if (hasInlineHandler(candidate) || hasButtonClass(candidate)) {
            target = candidate;
            break;
          }
          candidate = candidate.parentElement;
        }
      }

      if (!target || seen.has(target)) continue;

      const rect = target.getBoundingClientRect();
      const hasLayout = rect && (rect.width !== 0 || rect.height !== 0);
      if (!hasLayout) continue;

      seen.add(target);
      results.push(target);
    }
  }

  return { matches: results };
})()
  `.trim();
}

async function resolveByText(
  context: CDPContext,
  ws: any,
  target: ClickTargetInput
): Promise<ElementMatch[]> {
  const text = target.text ?? '';
  const matchMode: TextMatchMode = target.match ?? 'exact';
  const caseSensitive = target.caseSensitive ?? false;
  const within = target.within;

  const expression = buildTextSearchExpression(text, matchMode, caseSensitive, within);
  const evaluation = await context.sendCommand(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: false
  });

  if (evaluation.exceptionDetails) {
    const message =
      evaluation.exceptionDetails.text ||
      evaluation.exceptionDetails.exception?.description ||
      'Runtime evaluation failed';
    throw new ClickError(message, 'CLICK_TEXT_SEARCH_ERROR', {
      text,
      match: matchMode,
      caseSensitive
    });
  }

  const evalResult = evaluation.result;
  const containerId = evalResult?.objectId;

  if (!containerId) {
    const errorMessage =
      typeof evalResult?.value === 'object' && evalResult?.value !== null
        ? (evalResult.value as Record<string, unknown>).error
        : undefined;

    if (typeof errorMessage === 'string') {
      throw new ClickError(
        `Invalid text pattern: ${errorMessage}`,
        'CLICK_TEXT_SEARCH_ERROR',
        { text, match: matchMode, caseSensitive }
      );
    }

    return [];
  }

  let matchesObjectId: string | undefined;
  let searchError: string | undefined;

  try {
    const containerProps = await context.sendCommand(
      ws,
      'Runtime.getProperties',
      {
        objectId: containerId,
        ownProperties: true
      }
    );

    for (const descriptor of containerProps.result ?? []) {
      if (descriptor.name === 'error' && descriptor.value) {
        const value = descriptor.value.value;
        if (typeof value === 'string') {
          searchError = value;
        }
      }
      if (descriptor.name === 'matches' && descriptor.value?.objectId) {
        matchesObjectId = descriptor.value.objectId;
      }
    }
  } finally {
    await safeReleaseObject(context, ws, containerId);
  }

  if (typeof searchError === 'string' && searchError.length > 0) {
    throw new ClickError(
      `Invalid text pattern: ${searchError}`,
      'CLICK_TEXT_SEARCH_ERROR',
      { text, match: matchMode, caseSensitive }
    );
  }

  if (!matchesObjectId) {
    return [];
  }

  const matches = await matchesFromArrayHandle(context, ws, matchesObjectId);

  const unique: ElementMatch[] = [];
  const seenKeys = new Set<string>();

  for (const match of matches) {
    const { nodeId, metadata } = match;
    const rect = metadata.rect;
    const key = [
      nodeId,
      metadata.tagName,
      metadata.id ?? '',
      metadata.classes.join(' '),
      rect.x.toFixed(4),
      rect.y.toFixed(4),
      rect.width.toFixed(4),
      rect.height.toFixed(4),
      truncate(metadata.text, 32)
    ].join('|');

    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    unique.push(match);
  }

  return unique;
}

async function resolveClickCandidates(
  context: CDPContext,
  ws: any,
  target: ClickTargetInput
): Promise<ElementMatch[]> {
  if (target.selector) {
    return resolveBySelector(context, ws, target.selector, target.within);
  }

  if (target.text) {
    return resolveByText(context, ws, target);
  }

  return [];
}

/**
 * Get iframe element's bounding rect in top frame
 */
async function getIframeRect(
  context: CDPContext,
  ws: any,
  frameSpec: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const result = await context.sendCommand(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const iframe = document.querySelector(${JSON.stringify(frameSpec)});
      if (!iframe || iframe.tagName !== 'IFRAME') return null;
      let rect = iframe.getBoundingClientRect();
      // Frame-local coordinates are offset by this rect, so the iframe itself
      // has to be on screen before anything inside it can be clicked.
      if (rect.top < 0 || rect.left < 0 ||
          rect.bottom > window.innerHeight || rect.right > window.innerWidth) {
        iframe.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        rect = iframe.getBoundingClientRect();
      }
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true
  });

  if (!result.result?.value) {
    throw new Error(`Iframe not found: ${frameSpec}`);
  }

  return result.result.value;
}

/**
 * Find elements in a frame context and return matches with metadata
 */
async function resolveClickCandidatesInFrame(
  context: CDPContext,
  ws: any,
  target: ClickTargetInput,
  contextId: number
): Promise<ElementMatch[]> {
  // Build the search expression based on target type
  let searchExpr: string;

  if (target.selector) {
    const selectorJson = JSON.stringify(target.selector);
    const withinJson = target.within ? JSON.stringify(target.within) : 'null';
    searchExpr = `(() => {
      let root = document.body || document.documentElement;
      if (${withinJson}) {
        const container = document.querySelector(${withinJson});
        if (!container) return [];
        root = container;
      }
      return Array.from(root.querySelectorAll(${selectorJson}));
    })()`;
  } else if (target.text) {
    const textJson = JSON.stringify(target.text);
    const matchJson = JSON.stringify(target.match || 'exact');
    const caseSensitive = target.caseSensitive ? 'true' : 'false';
    const withinJson = target.within ? JSON.stringify(target.within) : 'null';

    searchExpr = `(() => {
      const pattern = ${textJson};
      const mode = ${matchJson};
      const caseSensitive = ${caseSensitive};
      const withinSelector = ${withinJson};
      const results = [];
      const seen = new Set();
      let regex = null;
      let normalizedPattern = pattern;
      const actionableSelector = 'button,[role="button"],li.item,[class*="-btn"],input[type="submit"],input[type="button"],input[type="reset"],input[type="checkbox"],input[type="radio"],a[href],textarea,select,label,summary';

      if (mode === 'regex') {
        try { regex = new RegExp(pattern, caseSensitive ? '' : 'i'); }
        catch { return []; }
      } else if (!caseSensitive) {
        normalizedPattern = pattern.toLowerCase();
      }

      let root = document.body || document.documentElement;
      if (withinSelector) {
        const container = document.querySelector(withinSelector);
        if (!container) return [];
        root = container;
      }

      const elements = root.querySelectorAll(actionableSelector);
      for (const el of elements) {
        if (seen.has(el)) continue;
        const elText = (el.innerText || '').trim();
        let matched = false;

        if (mode === 'exact') {
          matched = caseSensitive ? elText === pattern : elText.toLowerCase() === normalizedPattern;
        } else if (mode === 'contains') {
          matched = caseSensitive ? elText.includes(pattern) : elText.toLowerCase().includes(normalizedPattern);
        } else if (regex) {
          matched = regex.test(elText);
        }

        if (matched) {
          seen.add(el);
          results.push(el);
        }
      }
      return results;
    })()`;
  } else {
    return [];
  }

  const result = await context.sendCommand(ws, 'Runtime.evaluate', {
    expression: searchExpr,
    contextId,
    returnByValue: false
  });

  const arrayObjectId = result.result?.objectId;
  if (!arrayObjectId) {
    return [];
  }

  return matchesFromArrayHandle(context, ws, arrayObjectId);
}

/**
 * Click an element by CSS selector or text match
 */
export async function click(
  context: CDPContext,
  targetInput: ClickTargetInput | string,
  optionsInput: { page: string; double?: boolean; longpress?: number; touch?: boolean; frame?: string; force?: boolean } & WaitOptions
): Promise<void> {
  let ws;
  let navigationWatcher: NavigationWatcher | undefined;
  let networkIdleWatcher: NetworkIdleWatcher | undefined;
  let networkResponseWatcher: NetworkResponseWatcher | undefined;
  const target: ClickTargetInput =
    typeof targetInput === 'string'
      ? { selector: targetInput }
      : { ...targetInput };
  const options = { ...optionsInput };
  const longpressSeconds =
    typeof options.longpress === 'number' && Number.isFinite(options.longpress)
      ? Math.max(0, options.longpress)
      : 0;
  const longpressMs = longpressSeconds > 0 ? longpressSeconds * 1000 : 0;

  try {
    if (options.double && longpressSeconds > 0) {
      throw new ClickError(
        'Double click cannot be combined with long press',
        'CLICK_INVALID_OPTIONS',
        {
          double: options.double,
          longpress: longpressSeconds
        }
      );
    }

    if (options.touch && options.double) {
      throw new ClickError(
        'Touch mode does not support double tap (use two separate taps)',
        'CLICK_INVALID_OPTIONS',
        { touch: true, double: true }
      );
    }

    let page: Page;
    try {
      page = await context.findPage(options.page);
    } catch (primaryError) {
      const candidatePageId = target.selector;

      if (!candidatePageId) {
        throw primaryError;
      }

      try {
        const resolvedPage = await context.findPage(candidatePageId);
        const originalSelector = options.page;

        options.page = candidatePageId;
        target.selector = originalSelector;
        page = resolvedPage;
      } catch {
        throw primaryError;
      }
    }

    await context.assertNoDevTools(page.id);
    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    await context.sendCommand(ws, 'DOM.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    // Frame offset for coordinate translation
    let frameOffsetX = 0;
    let frameOffsetY = 0;

    // Resolve elements - use frame context if specified
    let matches: ElementMatch[];
    if (options.frame) {
      // Get iframe rect for coordinate offset
      const iframeRect = await getIframeRect(context, ws, options.frame);
      frameOffsetX = iframeRect.x;
      frameOffsetY = iframeRect.y;

      // Resolve frame context
      const contextId = await context.resolveFrameContext(ws, options.frame);
      if (contextId === undefined) {
        throw new ClickError(
          `Could not resolve frame context: ${options.frame}`,
          'CLICK_FRAME_ERROR',
          { frame: options.frame }
        );
      }

      matches = await resolveClickCandidatesInFrame(context, ws, target, contextId);
    } else {
      matches = await resolveClickCandidates(context, ws, target);
    }

    if (matches.length === 0) {
      throw new ClickError(
        target.selector
          ? `Element not found: ${target.selector}`
          : `No element matched text "${target.text}"`,
        'CLICK_NOT_FOUND',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false,
          frame: options.frame
        }
      );
    }

    let selectedIndex = 0;
    if (typeof target.nth === 'number') {
      if (target.nth < 1 || target.nth > matches.length) {
        throw new ClickError(
          `--nth ${target.nth} is out of range (1-${matches.length})`,
          'CLICK_NTH_OUT_OF_RANGE',
          {
            selector: target.selector,
            text: target.text,
            requestedNth: target.nth,
            match: target.selector ? undefined : target.match ?? 'exact',
            caseSensitive: target.caseSensitive ?? false,
            matches: summarizeMatches(matches)
          }
        );
      }
      selectedIndex = target.nth - 1;
    } else if (matches.length > 1) {
      throw new ClickError(
        'Multiple elements matched. Use --nth to choose one.',
        'CLICK_AMBIGUOUS',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false,
          matches: summarizeMatches(matches)
        }
      );
    }

    const chosen = matches[selectedIndex];
    let rect = chosen.metadata.rect;

    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
      throw new ClickError(
        'Matched element has invalid layout coordinates',
        'CLICK_NO_LAYOUT',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false,
          rect: roundRect(rect)
        }
      );
    }

    if (rect.width === 0 && rect.height === 0) {
      throw new ClickError(
        'Matched element has no visible area to click',
        'CLICK_NO_HITBOX',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false,
          rect: roundRect(rect)
        }
      );
    }

    // Input events use viewport coordinates, so the element has to be scrolled
    // in and unobstructed before the rect means anything.
    let scrolled = false;
    let occludedBy: string | null = null;
    let clickPoint: ClickPoint | undefined;
    let hitFrameObjectId: string | undefined;

    if (chosen.objectId) {
      const point = await getClickPoint(context, ws, chosen.objectId, rect);
      clickPoint = point;
      rect = point.rect;
      scrolled = point.scrolled;
      occludedBy = point.hitOk ? null : point.hit;

      if (!point.inViewport) {
        throw new ClickError(
          'Element could not be scrolled into the viewport',
          'CLICK_OFFSCREEN',
          {
            selector: target.selector,
            text: target.text,
            frame: options.frame,
            rect: roundRect(rect)
          }
        );
      }

      if (!point.hitOk && !options.force) {
        throw new ClickError(
          `Click point is covered by ${point.hit ?? 'another element'}; the click would not reach the target. Use --force to click anyway.`,
          'CLICK_OCCLUDED',
          {
            selector: target.selector,
            text: target.text,
            frame: options.frame,
            occludedBy: point.hit,
            rect: roundRect(rect)
          }
        );
      }

      // Taken before the click, while the click point still means what the hit
      // test said it meant.
      if (point.hitIsFrame) {
        hitFrameObjectId = await getHitFrameHandle(context, ws, chosen.objectId, {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2
        });

        if (!hitFrameObjectId) {
          throw new ClickError(
            `Click point resolved to ${point.hit ?? 'a frame'} and then stopped resolving to a frame before the click could be sent; the page is still moving under the cursor`,
            'CLICK_MEASURE_FAILED',
            {
              selector: target.selector,
              text: target.text,
              hitFrame: point.hit
            }
          );
        }
      }
    }

    const width = rect.width;
    const height = rect.height;

    // Add frame offset for elements inside iframes
    const x = frameOffsetX + rect.x + width / 2;
    const y = frameOffsetY + rect.y + height / 2;
    const xRounded = Math.round(x);
    const yRounded = Math.round(y);
    const roundedRect = roundRect(rect);

    // Armed before dispatch, for the same reason: the evidence that the click
    // missed the frame is the event turning up outside it.
    if (hitFrameObjectId) {
      await armFrameWitness(context, ws, hitFrameObjectId);
    }

    const documentWitnessObjectId = !clickPoint?.hitIsFrame ? chosen.objectId : undefined;
    if (documentWitnessObjectId) {
      const witnessPoint = options.frame
        ? { x: rect.x + width / 2, y: rect.y + height / 2 }
        : { x, y };
      await armDocumentClickWitness(
        context,
        ws,
        documentWitnessObjectId,
        witnessPoint,
        options.touch ? 'touchstart' : 'mousedown'
      );
    }

    // Armed before dispatch: a form POST can commit and load before a
    // post-action listener would have attached.
    if (options.waitForNavigation) {
      navigationWatcher = await armNavigationWatcher(context, ws, effectiveWaitFrame(options));
    }
    if (options.waitForIdle) {
      networkIdleWatcher = await armNetworkIdleWatcher(context, ws);
    }
    if (options.waitForResponse) {
      networkResponseWatcher = await armNetworkResponseWatcher(context, ws, options);
    }

    if (options.touch) {
      // Touch tap sequence
      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{
          id: 0,
          x,
          y,
          radiusX: 2.5,
          radiusY: 2.5,
          rotationAngle: 0,
          force: 1.0
        }]
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      });
    } else {
      // Mouse click sequence
      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y
      });

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1
      });

      if (options.double) {
        await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 2
        });

        await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 2
        });
      }
    }

    // A click point that resolves to a frame is the one case where dispatching
    // says nothing about delivery: the event either goes into that frame's own
    // document, which this session cannot see into, or lands outside it and
    // does nothing at all. Confirm it arrived before calling this a click, the
    // same way occlusion is confirmed before dispatching.
    let frameReached: boolean | null = null;
    let clickDelivered: boolean | null = null;

    if (clickPoint?.hitIsFrame && hitFrameObjectId) {
      const verdict = await verifyFrameReached(context, ws, hitFrameObjectId);
      frameReached = verdict.reached;

      // Strictly false: null means the click took the page somewhere the check
      // could not follow, which is not a failed click.
      if (verdict.reached === false && !options.force) {
        throw new ClickError(
          `Click point is inside ${clickPoint.hit ?? 'a frame'}, but the click was delivered to ${verdict.sawInDocument} outside it, so the frame never got it. A frame that has just mounted is not routable yet, and a page that is still settling moves what is under the point - wait for it and click again, or use --force to dispatch and report anyway.`,
          'CLICK_FRAME_NOT_REACHED',
          {
            selector: target.selector,
            text: target.text,
            frame: options.frame,
            hitFrame: clickPoint.hit,
            frameSrc: clickPoint.hitFrameSrc,
            deliveredTo: verdict.sawInDocument,
            activeElement: verdict.active,
            x: xRounded,
            y: yRounded,
            rect: roundedRect
          }
        );
      }
    }

    if (documentWitnessObjectId) {
      const verdict = await verifyDocumentClickDelivered(
        context,
        ws,
        documentWitnessObjectId
      );
      clickDelivered = verdict.delivered;

      if (verdict.delivered === false) {
        throw new ClickError(
          `Chrome accepted the ${options.touch ? 'touch' : 'mouse'} dispatch, but no matching event reached the chosen element`,
          'CLICK_NOT_DELIVERED',
          {
            selector: target.selector,
            text: target.text,
            frame: options.frame,
            x: xRounded,
            y: yRounded,
            rect: roundedRect,
            witnessedEvent: verdict.event
          }
        );
      }
    }

    // Handle post-action wait conditions
    await handleWaitOptions(
      context,
      ws,
      {
        waitFor: options.waitFor,
        waitForText: options.waitForText,
        waitForExpression: options.waitForExpression,
        waitForResponse: options.waitForResponse,
        waitForStatus: options.waitForStatus,
        waitForBodyText: options.waitForBodyText,
        waitForIdle: options.waitForIdle,
        waitForFrame: effectiveWaitFrame(options),
        waitForNavigation: options.waitForNavigation,
        timeout: options.timeout
      },
      navigationWatcher,
      networkIdleWatcher,
      networkResponseWatcher
    );

    outputSuccess('Click performed', {
      strategy: target.selector ? 'css' : 'text',
      selector: target.selector ?? null,
      text: target.text ?? null,
      match: target.selector ? undefined : target.match ?? 'exact',
      caseSensitive: target.caseSensitive ?? false,
      within: target.within ?? null,
      frame: options.frame ?? null,
      index: selectedIndex + 1,
      totalMatches: matches.length,
      x: xRounded,
      y: yRounded,
      rect: roundedRect,
      double: options.double || false,
      longpress: longpressSeconds,
      touch: options.touch || false,
      scrolled,
      occludedBy,
      // null when the click point was not a frame, so there was nothing to reach
      frameReached,
      // null when delivery could not be witnessed (frame/touch/navigation/context loss)
      clickDelivered,
      ...(frameReached !== null && { hitFrame: clickPoint?.hit ?? null }),
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
      ...(options.waitForExpression && { waitedForExpression: true }),
      ...(options.waitForResponse && { waitedForResponse: options.waitForResponse }),
      ...(options.waitForStatus !== undefined && { waitedForStatus: options.waitForStatus }),
      ...(options.waitForBodyText && { waitedForBodyText: true }),
      ...(options.waitForIdle && { waitedForIdle: true }),
      ...(effectiveWaitFrame(options) && { waitedInFrame: effectiveWaitFrame(options) }),
      ...(options.waitForNavigation && { waitedForNavigation: true })
    });
  } catch (error) {
    if (error instanceof ClickError) {
      outputError(error.message, error.code, error.details);
    } else {
      outputCommandError(
        error,
        'CLICK_FAILED',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false
        }
      );
    }
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
 * Focus a field through its remote handle and clear its current value.
 *
 * Clearing has to go through the value *property*: DOM.setAttributeValue only
 * writes the `value` content attribute, which for an input is just the default
 * value. Once the field is dirty (typed into, or assigned by script) the
 * attribute is ignored, so the old text survives and typing appends to it.
 */
async function focusAndClearField(
  context: CDPContext,
  ws: any,
  objectId: string,
  selector: string
): Promise<{ tagName: string; cleared: string }> {
  try {
    await context.sendCommand(ws, 'DOM.scrollIntoViewIfNeeded', { objectId });
  } catch {
    // A field can still be focused and typed into without being on screen.
  }

  const callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `
      function() {
        const el = this;
        if (!el.isConnected) {
          return { error: 'Element was removed from the document' };
        }

        const tagName = (el.tagName || '').toLowerCase();
        const editable = el.isContentEditable === true;
        const isField = tagName === 'input' || tagName === 'textarea';

        if (tagName === 'select') {
          return { error: 'Cannot type into a <select>; use the select command instead: cdp-cli select <selector> <value> <page> (or --text "Label")' };
        }
        if (!isField && !editable) {
          return { error: 'Element is not a text field (<' + tagName + '>)' };
        }
        if (el.disabled === true) {
          return { error: 'Field is disabled' };
        }
        if (el.readOnly === true) {
          return { error: 'Field is read-only' };
        }

        el.focus();
        if (document.activeElement !== el) {
          return { error: 'Field could not be focused' };
        }

        const cleared = editable ? (el.textContent || '') : (el.value || '');
        if (editable) {
          el.textContent = '';
        } else {
          el.value = '';
        }
        // Let frameworks observe the clear before the keystrokes arrive.
        el.dispatchEvent(new Event('input', { bubbles: true }));

        return { tagName, cleared };
      }
    `,
    returnByValue: true
  });

  const value = callResult.result?.value;

  if (!value) {
    throw new Error(`Could not prepare field for typing: ${selector}`);
  }
  if (value.error) {
    throw new Error(`${value.error}: ${selector}`);
  }

  return {
    tagName: typeof value.tagName === 'string' ? value.tagName : '',
    cleared: typeof value.cleared === 'string' ? value.cleared : ''
  };
}

type FillVerificationStatus = 'exact' | 'observable' | 'lost' | 'unverifiable';

interface FillVerification {
  requestedValue: string;
  actualValue: string | null;
  originalConnected: boolean | null;
  replacementDetected: boolean | null;
  valueApplied: boolean | null;
  verification: FillVerificationStatus;
}

/**
 * Inspect the live field selected by the same selector/nth/within/frame tuple.
 * Reactive renderers commonly replace an input during its input/change handler,
 * so inspecting only the retained handle can report a value from a detached,
 * no-longer-visible node.
 */
async function verifyFilledField(
  context: CDPContext,
  ws: any,
  originalObjectId: string,
  selector: string,
  requestedValue: string,
  options: { nth?: number; within?: string; frame?: string },
  initialContextId?: number
): Promise<FillVerification> {
  const unverifiable = (): FillVerification => ({
    requestedValue,
    actualValue: null,
    originalConnected: null,
    replacementDetected: null,
    valueApplied: null,
    verification: 'unverifiable'
  });

  try {
    // Let change/input handlers and their queued reactive render complete. CDP
    // awaits the promise, giving the document two microtask checkpoints without
    // imposing a visible fixed delay on every fill.
    await context.sendCommand(ws, 'Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        queueMicrotask(() => queueMicrotask(resolve));
      })`,
      ...(initialContextId !== undefined ? { contextId: initialContextId } : {}),
      awaitPromise: true,
      returnByValue: true
    });

    let liveMatches: ElementMatch[];
    if (options.frame) {
      const liveContextId = await context.resolveFrameContext(ws, options.frame);
      if (liveContextId === undefined) {
        return unverifiable();
      }
      liveMatches = await resolveClickCandidatesInFrame(
        context,
        ws,
        { selector, within: options.within },
        liveContextId
      );
    } else {
      liveMatches = await resolveBySelector(context, ws, selector, options.within);
    }

    let liveIndex = 0;
    if (typeof options.nth === 'number') {
      liveIndex = options.nth - 1;
      if (liveIndex < 0 || liveIndex >= liveMatches.length) {
        return unverifiable();
      }
    } else if (liveMatches.length !== 1) {
      return unverifiable();
    }

    const liveObjectId = liveMatches[liveIndex]?.objectId;
    if (!liveObjectId) {
      return unverifiable();
    }

    const liveResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
      objectId: liveObjectId,
      functionDeclaration: `
        function() {
          const tagName = (this.tagName || '').toLowerCase();
          const editable = this.isContentEditable === true;
          const actualValue = editable
            ? (this.textContent || '')
            : (typeof this.value === 'string' ? this.value : null);
          return { actualValue, tagName };
        }
      `,
      returnByValue: true
    });
    const rawActualValue = liveResult.result?.value?.actualValue;
    if (typeof rawActualValue !== 'string') {
      return unverifiable();
    }

    let originalConnected: boolean | null = null;
    let replacementDetected: boolean | null = null;
    try {
      const identityResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
        objectId: originalObjectId,
        functionDeclaration: `
          function(liveField) {
            return {
              originalConnected: this.isConnected === true,
              sameNode: this === liveField
            };
          }
        `,
        arguments: [{ objectId: liveObjectId }],
        returnByValue: true
      });
      const identity = identityResult.result?.value;
      if (typeof identity?.originalConnected === 'boolean') {
        originalConnected = identity.originalConnected;
      }
      if (typeof identity?.sameNode === 'boolean') {
        replacementDetected = !identity.sameNode;
      } else if (originalConnected === false) {
        replacementDetected = true;
      }
    } catch {
      // The live value remains useful even if the old handle was invalidated.
    }

    let verification: FillVerificationStatus;
    let valueApplied: boolean | null;
    if (rawActualValue === requestedValue) {
      verification = 'exact';
      valueApplied = true;
    } else if (requestedValue.length > 0 && rawActualValue.length === 0) {
      verification = 'lost';
      valueApplied = false;
    } else {
      // A non-empty differing value may be a mask/formatter normalization. It
      // is observable, but exact application cannot be claimed or rejected.
      verification = 'observable';
      valueApplied = null;
    }

    return {
      requestedValue,
      actualValue: rawActualValue,
      originalConnected,
      replacementDetected,
      valueApplied,
      verification
    };
  } catch {
    // Navigation or execution-context replacement makes post-fill inspection
    // impossible. Typing may itself have caused it, so do not call that loss.
    return unverifiable();
  }
}

export interface SelectTargetInput {
  value?: string;
  text?: string;
  index?: number;
  match?: TextMatchMode;
  caseSensitive?: boolean;
}

/**
 * Set a <select> element's value.
 *
 * Chrome renders the option list as an OS-level popup that is not part of the
 * DOM, so there is no coordinate a synthetic mouse click can land on to choose
 * an option. The selection is therefore assigned through the element and the
 * events a completed user pick produces (`input` then `change`, both bubbling)
 * are dispatched, so page handlers observe exactly what they would from a real
 * gesture. The element is focused first, as a real pick would.
 */
export async function selectOption(
  context: CDPContext,
  selector: string,
  target: SelectTargetInput,
  options: { page: string; nth?: number; within?: string; frame?: string } & WaitOptions
): Promise<void> {
  let ws;
  let navigationWatcher: NavigationWatcher | undefined;
  let networkIdleWatcher: NetworkIdleWatcher | undefined;
  let networkResponseWatcher: NetworkResponseWatcher | undefined;

  try {
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    await context.sendCommand(ws, 'DOM.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    let matches: ElementMatch[];
    if (options.frame) {
      const contextId = await context.resolveFrameContext(ws, options.frame);
      if (contextId === undefined) {
        throw new Error(`Could not resolve frame context: ${options.frame}`);
      }
      matches = await resolveClickCandidatesInFrame(
        context,
        ws,
        { selector, within: options.within },
        contextId
      );
    } else {
      matches = await resolveBySelector(context, ws, selector, options.within);
    }

    if (matches.length === 0) {
      throw new Error(
        options.frame
          ? `Element not found in frame: ${selector}`
          : `Element not found: ${selector}`
      );
    }

    let selectedIndex = 0;
    if (typeof options.nth === 'number') {
      if (options.nth < 1 || options.nth > matches.length) {
        throw new Error(
          `--nth ${options.nth} is out of range (1-${matches.length})\n${summarizeMatches(matches).join('\n')}`
        );
      }
      selectedIndex = options.nth - 1;
    } else if (matches.length > 1) {
      throw new Error(
        `Multiple elements matched. Use --nth to choose one.\n${summarizeMatches(matches).join('\n')}`
      );
    }

    const chosen = matches[selectedIndex];
    if (!chosen.objectId) {
      throw new Error(`Could not resolve an element handle for: ${selector}`);
    }

    const strategy: 'value' | 'text' | 'index' =
      target.value !== undefined ? 'value' : target.text !== undefined ? 'text' : 'index';

    if (options.waitForNavigation) {
      navigationWatcher = await armNavigationWatcher(context, ws, effectiveWaitFrame(options));
    }
    if (options.waitForIdle) {
      networkIdleWatcher = await armNetworkIdleWatcher(context, ws);
    }
    if (options.waitForResponse) {
      networkResponseWatcher = await armNetworkResponseWatcher(context, ws, options);
    }

    const callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
      objectId: chosen.objectId,
      functionDeclaration: `
        function(strategy, needle, matchMode, caseSensitive) {
          const el = this;
          if (!el.isConnected) {
            return { error: 'Element was removed from the document' };
          }

          const tagName = (el.tagName || '').toLowerCase();
          if (tagName !== 'select') {
            return { error: 'Not a <select> element; got <' + tagName + '>' };
          }

          const options = Array.prototype.slice.call(el.options);
          const describe = options.map(function(o, i) {
            return (i + 1) + '. ' + JSON.stringify(o.text.trim()) + ' (value=' + JSON.stringify(o.value) + ')';
          });

          const normalize = function(s) {
            return caseSensitive ? s : s.toLowerCase();
          };

          let match = null;
          if (strategy === 'value') {
            match = options.find(function(o) { return o.value === needle; }) || null;
          } else if (strategy === 'index') {
            match = options[needle - 1] || null;
          } else {
            const want = normalize(String(needle));
            match = options.find(function(o) {
              const label = normalize(o.text.trim());
              if (matchMode === 'contains') return label.indexOf(want) !== -1;
              if (matchMode === 'regex') return new RegExp(needle, caseSensitive ? '' : 'i').test(o.text.trim());
              return label === want;
            }) || null;
          }

          if (!match) {
            return {
              error: 'No option matched',
              optionCount: options.length,
              options: describe
            };
          }

          if (match.disabled) {
            return { error: 'Matched option is disabled: ' + JSON.stringify(match.text.trim()) };
          }

          const previousValue = el.value;
          const previousText = el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : '';

          // A single pick clears any other selection, which is what the native
          // popup does even on a <select multiple> without modifier keys.
          for (const o of options) {
            o.selected = (o === match);
          }

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));

          return {
            value: el.value,
            text: match.text.trim(),
            optionIndex: options.indexOf(match) + 1,
            selectedIndex: el.selectedIndex,
            previousValue: previousValue,
            previousText: previousText,
            changed: previousValue !== el.value,
            optionCount: options.length,
            multiple: el.multiple === true
          };
        }
      `,
      arguments: [
        { value: strategy },
        { value: strategy === 'value' ? target.value : strategy === 'index' ? target.index : target.text },
        { value: target.match ?? 'exact' },
        { value: target.caseSensitive ?? false }
      ],
      returnByValue: true
    });

    const result = callResult.result?.value;
    if (!result) {
      throw new Error(`Could not set <select>: ${selector}`);
    }

    if (result.error) {
      const detail = Array.isArray(result.options) && result.options.length > 0
        ? `\nAvailable options:\n${result.options.join('\n')}`
        : '';
      const wanted = strategy === 'value'
        ? `value ${JSON.stringify(target.value)}`
        : strategy === 'index'
          ? `index ${target.index}`
          : `text ${JSON.stringify(target.text)}`;
      throw new Error(`${result.error} for ${wanted} on ${selector}${detail}`);
    }

    // Focus mirrors a real pick, and matters for pages that submit on blur.
    try {
      await context.sendCommand(ws, 'DOM.focus', { objectId: chosen.objectId });
    } catch {
      // A select can still be set without being focusable (hidden, disabled container).
    }

    await handleWaitOptions(
      context,
      ws,
      {
        waitFor: options.waitFor,
        waitForText: options.waitForText,
        waitForExpression: options.waitForExpression,
        waitForResponse: options.waitForResponse,
        waitForStatus: options.waitForStatus,
        waitForBodyText: options.waitForBodyText,
        waitForIdle: options.waitForIdle,
        waitForFrame: effectiveWaitFrame(options),
        waitForNavigation: options.waitForNavigation,
        timeout: options.timeout
      },
      navigationWatcher,
      networkIdleWatcher,
      networkResponseWatcher
    );

    outputSuccess('Option selected', {
      selector,
      strategy,
      value: result.value,
      text: result.text,
      optionIndex: result.optionIndex,
      selectedIndex: result.selectedIndex,
      previousValue: result.previousValue,
      previousText: result.previousText,
      changed: result.changed,
      optionCount: result.optionCount,
      multiple: result.multiple,
      within: options.within ?? null,
      frame: options.frame ?? null,
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
      ...(options.waitForExpression && { waitedForExpression: true }),
      ...(options.waitForResponse && { waitedForResponse: options.waitForResponse }),
      ...(options.waitForStatus !== undefined && { waitedForStatus: options.waitForStatus }),
      ...(options.waitForBodyText && { waitedForBodyText: true }),
      ...(options.waitForIdle && { waitedForIdle: true }),
      ...(effectiveWaitFrame(options) && { waitedInFrame: effectiveWaitFrame(options) }),
      ...(options.waitForNavigation && { waitedForNavigation: true })
    });
  } catch (error) {
    outputCommandError(
      error,
      'SELECT_FAILED',
      { selector, value: target.value, text: target.text, index: target.index, frame: options.frame }
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
 * Fill an input element
 */
export async function fill(
  context: CDPContext,
  selector: string,
  value: string,
  options: { page: string; nth?: number; within?: string; frame?: string; expectValue?: boolean; showValue?: boolean } & WaitOptions
): Promise<void> {
  let ws;
  let navigationWatcher: NavigationWatcher | undefined;
  let networkIdleWatcher: NetworkIdleWatcher | undefined;
  let networkResponseWatcher: NetworkResponseWatcher | undefined;

  try {
    // Get page
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    await context.sendCommand(ws, 'DOM.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    let matches: ElementMatch[];
    let initialContextId: number | undefined;
    if (options.frame) {
      initialContextId = await context.resolveFrameContext(ws, options.frame);
      if (initialContextId === undefined) {
        throw new Error(`Could not resolve frame context: ${options.frame}`);
      }
      matches = await resolveClickCandidatesInFrame(
        context,
        ws,
        { selector, within: options.within },
        initialContextId
      );
    } else {
      matches = await resolveBySelector(context, ws, selector, options.within);
    }

    if (matches.length === 0) {
      throw new Error(
        options.frame
          ? `Element not found in frame: ${selector}`
          : `Element not found: ${selector}`
      );
    }

    let selectedIndex = 0;
    if (typeof options.nth === 'number') {
      if (options.nth < 1 || options.nth > matches.length) {
        throw new Error(
          `--nth ${options.nth} is out of range (1-${matches.length})\n${summarizeMatches(matches).join('\n')}`
        );
      }
      selectedIndex = options.nth - 1;
    } else if (matches.length > 1) {
      throw new Error(
        `Multiple elements matched. Use --nth to choose one.\n${summarizeMatches(matches).join('\n')}`
      );
    }

    const chosen = matches[selectedIndex];
    if (!chosen.objectId) {
      throw new Error(`Could not resolve an element handle for: ${selector}`);
    }

    // Focus and clear through the chosen handle. Targeting the handle (rather
    // than re-querying the selector) is what makes --nth and --within apply to
    // the same element that was matched.
    const field = await focusAndClearField(context, ws, chosen.objectId, selector);

    if (options.waitForNavigation) {
      navigationWatcher = await armNavigationWatcher(context, ws, effectiveWaitFrame(options));
    }
    if (options.waitForIdle) {
      networkIdleWatcher = await armNetworkIdleWatcher(context, ws);
    }
    if (options.waitForResponse) {
      networkResponseWatcher = await armNetworkResponseWatcher(context, ws, options);
    }

    for (const char of value) {
      await dispatchKey(context, ws, describeChar(char));
    }

    // Typing emits `input` per keystroke; `change` normally waits for blur, so
    // emit it here to match what a completed edit looks like to the page.
    let changeContextLost = false;
    try {
      await context.sendCommand(ws, 'Runtime.callFunctionOn', {
        objectId: chosen.objectId,
        functionDeclaration: `
          function() {
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }
        `,
        returnByValue: true
      });
    } catch (error) {
      if (!isExecutionContextLoss(error)) {
        throw error;
      }
      changeContextLost = true;
    }

    const verification = changeContextLost
      ? {
          requestedValue: value,
          actualValue: null,
          originalConnected: null,
          replacementDetected: null,
          valueApplied: null,
          verification: 'unverifiable' as const
        }
      : await verifyFilledField(
          context,
          ws,
          chosen.objectId,
          selector,
          value,
          options,
          initialContextId
        );

    if (verification.verification === 'lost' || (options.expectValue && verification.verification !== 'exact')) {
      throw new FillError(
        verification.verification === 'lost'
          ? 'The requested value was typed, but the live field is empty after the page processed the edit'
          : 'The live field does not exactly equal the requested value',
        'FILL_VALUE_NOT_APPLIED',
        {
          selector,
          within: options.within,
          frame: options.frame,
          ...(options.showValue
            ? {
                requestedValue: verification.requestedValue,
                actualValue: verification.actualValue
              }
            : {
                requestedValueLength: verification.requestedValue.length,
                actualValueLength: verification.actualValue?.length ?? null
              }),
          originalConnected: verification.originalConnected,
          replacementDetected: verification.replacementDetected,
          valueApplied: verification.valueApplied,
          verification: verification.verification,
          exactValueRequired: options.expectValue === true
        }
      );
    }

    // Handle post-action wait conditions
    await handleWaitOptions(
      context,
      ws,
      {
        waitFor: options.waitFor,
        waitForText: options.waitForText,
        waitForExpression: options.waitForExpression,
        waitForResponse: options.waitForResponse,
        waitForStatus: options.waitForStatus,
        waitForBodyText: options.waitForBodyText,
        waitForIdle: options.waitForIdle,
        waitForFrame: effectiveWaitFrame(options),
        waitForNavigation: options.waitForNavigation,
        timeout: options.timeout
      },
      navigationWatcher,
      networkIdleWatcher,
      networkResponseWatcher
    );

    outputSuccess('Fill performed', {
      selector,
      ...(options.showValue
        ? {
            value,
            requestedValue: verification.requestedValue,
            actualValue: verification.actualValue,
            replaced: field.cleared
          }
        : {
            requestedValueLength: verification.requestedValue.length,
            actualValueLength: verification.actualValue?.length ?? null,
            replacedLength: field.cleared.length
          }),
      originalConnected: verification.originalConnected,
      replacementDetected: verification.replacementDetected,
      valueApplied: verification.valueApplied,
      verification: verification.verification,
      within: options.within ?? null,
      frame: options.frame ?? null,
      tagName: field.tagName,
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
      ...(options.waitForExpression && { waitedForExpression: true }),
      ...(options.waitForResponse && { waitedForResponse: options.waitForResponse }),
      ...(options.waitForStatus !== undefined && { waitedForStatus: options.waitForStatus }),
      ...(options.waitForBodyText && { waitedForBodyText: true }),
      ...(options.waitForIdle && { waitedForIdle: true }),
      ...(effectiveWaitFrame(options) && { waitedInFrame: effectiveWaitFrame(options) }),
      ...(options.waitForNavigation && { waitedForNavigation: true })
    });
  } catch (error) {
    if (error instanceof FillError) {
      outputError(error.message, error.code, error.details);
    } else {
      outputCommandError(
        error,
        'FILL_FAILED',
        {
          selector,
          frame: options.frame,
          ...(options.showValue ? { value } : { valueLength: value.length })
        }
      );
    }
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
 * Press a keyboard key
 */
export async function pressKey(
  context: CDPContext,
  key: string,
  options: { page: string } & WaitOptions
): Promise<void> {
  let ws;
  let navigationWatcher: NavigationWatcher | undefined;
  let networkIdleWatcher: NetworkIdleWatcher | undefined;
  let networkResponseWatcher: NetworkResponseWatcher | undefined;

  try {
    // Get page
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    const descriptor = describeKey(key);

    // Enter in a form field submits it, so the watcher has to be live before
    // the keystroke is dispatched.
    if (options.waitForNavigation) {
      navigationWatcher = await armNavigationWatcher(context, ws, effectiveWaitFrame(options));
    }
    if (options.waitForIdle) {
      networkIdleWatcher = await armNetworkIdleWatcher(context, ws);
    }
    if (options.waitForResponse) {
      networkResponseWatcher = await armNetworkResponseWatcher(context, ws, options);
    }

    await dispatchKey(context, ws, descriptor);

    await handleWaitOptions(
      context,
      ws,
      {
        waitFor: options.waitFor,
        waitForText: options.waitForText,
        waitForExpression: options.waitForExpression,
        waitForResponse: options.waitForResponse,
        waitForStatus: options.waitForStatus,
        waitForBodyText: options.waitForBodyText,
        waitForIdle: options.waitForIdle,
        waitForFrame: effectiveWaitFrame(options),
        waitForNavigation: options.waitForNavigation,
        timeout: options.timeout
      },
      navigationWatcher,
      networkIdleWatcher,
      networkResponseWatcher
    );

    outputSuccess('Key pressed', {
      key: descriptor.key,
      code: descriptor.code,
      keyCode: descriptor.keyCode,
      ...(options.waitFor && { waitedFor: options.waitFor }),
      ...(options.waitForText && { waitedForText: options.waitForText }),
      ...(options.waitForExpression && { waitedForExpression: true }),
      ...(options.waitForResponse && { waitedForResponse: options.waitForResponse }),
      ...(options.waitForStatus !== undefined && { waitedForStatus: options.waitForStatus }),
      ...(options.waitForBodyText && { waitedForBodyText: true }),
      ...(options.waitForIdle && { waitedForIdle: true }),
      ...(effectiveWaitFrame(options) && { waitedInFrame: effectiveWaitFrame(options) }),
      ...(options.waitForNavigation && { waitedForNavigation: true })
    });
  } catch (error) {
    outputCommandError(
      error,
      'PRESS_KEY_FAILED',
      { key }
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

class DragError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseCoordinates(input: string): { x: number; y: number } | null {
  const match = input.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const x = parseFloat(match[1]);
  const y = parseFloat(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

async function resolveDragTarget(
  context: CDPContext,
  ws: any,
  target: DragTargetInput,
  label: string,
  frameOffset?: { x: number; y: number },
  contextId?: number
): Promise<{ x: number; y: number; metadata?: ElementMetadata; objectId?: string }> {
  // Direct coordinates (add frame offset if provided)
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return {
      x: target.x + (frameOffset?.x ?? 0),
      y: target.y + (frameOffset?.y ?? 0)
    };
  }

  // Resolve via element
  const clickTarget: ClickTargetInput = {
    selector: target.selector,
    text: target.text,
    match: target.match,
    caseSensitive: target.caseSensitive,
    nth: target.nth,
    within: target.within
  };

  // Use frame context if provided
  const matches = contextId !== undefined
    ? await resolveClickCandidatesInFrame(context, ws, clickTarget, contextId)
    : await resolveClickCandidates(context, ws, clickTarget);

  if (matches.length === 0) {
    throw new DragError(
      target.selector
        ? `${label} element not found: ${target.selector}`
        : `${label}: no element matched text "${target.text}"`,
      'DRAG_NOT_FOUND',
      { label, selector: target.selector, text: target.text }
    );
  }

  let selectedIndex = 0;
  if (typeof target.nth === 'number') {
    if (target.nth < 1 || target.nth > matches.length) {
      throw new DragError(
        `${label}: --nth ${target.nth} is out of range (1-${matches.length})`,
        'DRAG_NTH_OUT_OF_RANGE',
        {
          label,
          selector: target.selector,
          text: target.text,
          requestedNth: target.nth,
          matches: summarizeMatches(matches)
        }
      );
    }
    selectedIndex = target.nth - 1;
  } else if (matches.length > 1) {
    throw new DragError(
      `${label}: multiple elements matched. Use --nth to choose one.`,
      'DRAG_AMBIGUOUS',
      {
        label,
        selector: target.selector,
        text: target.text,
        matches: summarizeMatches(matches)
      }
    );
  }

  const chosen = matches[selectedIndex];
  let rect = chosen.metadata.rect;

  // Same viewport constraint as click: the endpoint has to be on screen or the
  // mouse events land somewhere else entirely.
  if (chosen.objectId) {
    const point = await getClickPoint(context, ws, chosen.objectId, rect);
    rect = point.rect;

    if (!point.inViewport) {
      throw new DragError(
        `${label} could not be scrolled into the viewport`,
        'DRAG_OFFSCREEN',
        { label, selector: target.selector, text: target.text, rect: roundRect(rect) }
      );
    }
  }

  return {
    x: (frameOffset?.x ?? 0) + rect.x + rect.width / 2,
    y: (frameOffset?.y ?? 0) + rect.y + rect.height / 2,
    metadata: chosen.metadata,
    objectId: chosen.objectId
  };
}

/**
 * Drag from one element/position to another
 */
export async function drag(
  context: CDPContext,
  from: DragTargetInput,
  to: DragTargetInput,
  options: DragOptions
): Promise<void> {
  let ws;

  const steps = Math.max(1, options.steps ?? 10);
  const durationMs = Math.max(0, options.duration ?? 300);
  const longpressSeconds =
    typeof options.longpress === 'number' && Number.isFinite(options.longpress)
      ? Math.max(0, options.longpress)
      : 0;
  const longpressMs = longpressSeconds * 1000;
  const stepDelayMs = steps > 1 ? durationMs / (steps - 1) : 0;

  try {
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    await context.sendCommand(ws, 'DOM.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    // Frame targeting
    let frameOffset: { x: number; y: number } | undefined;
    let contextId: number | undefined;
    if (options.frame) {
      const iframeRect = await getIframeRect(context, ws, options.frame);
      frameOffset = { x: iframeRect.x, y: iframeRect.y };
      contextId = await context.resolveFrameContext(ws, options.frame);
    }

    const fromPos = await resolveDragTarget(context, ws, from, 'Source', frameOffset, contextId);
    const toPos = await resolveDragTarget(context, ws, to, 'Destination', frameOffset, contextId);

    // Scrolling the destination into view can push the source back off screen,
    // so re-measure both (without scrolling again) and require that they are
    // reachable at the same time.
    for (const [label, pos] of [['Source', fromPos], ['Destination', toPos]] as const) {
      if (!pos.objectId) {
        continue;
      }

      const refreshed = await getClickPoint(context, ws, pos.objectId, pos.metadata!.rect, false);
      if (!refreshed.inViewport) {
        throw new DragError(
          `${label} scrolled back out of view: the source and destination must be on screen at the same time`,
          'DRAG_OFFSCREEN',
          { label, rect: roundRect(refreshed.rect) }
        );
      }

      pos.x = (frameOffset?.x ?? 0) + refreshed.rect.x + refreshed.rect.width / 2;
      pos.y = (frameOffset?.y ?? 0) + refreshed.rect.y + refreshed.rect.height / 2;
    }

    if (options.touch) {
      // Touch drag sequence
      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{
          id: 0,
          x: fromPos.x,
          y: fromPos.y,
          radiusX: 2.5,
          radiusY: 2.5,
          rotationAngle: 0,
          force: 1.0
        }]
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      // Move through intermediate points
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const currentX = fromPos.x + (toPos.x - fromPos.x) * progress;
        const currentY = fromPos.y + (toPos.y - fromPos.y) * progress;

        if (stepDelayMs > 0) {
          await delay(stepDelayMs);
        }

        await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{
            id: 0,
            x: currentX,
            y: currentY,
            radiusX: 2.5,
            radiusY: 2.5,
            rotationAngle: 0,
            force: 1.0
          }]
        });
      }

      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      });
    } else {
      // Mouse drag sequence
      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: fromPos.x,
        y: fromPos.y
      });

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: fromPos.x,
        y: fromPos.y,
        button: 'left',
        clickCount: 1
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      // Move through intermediate points
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const currentX = fromPos.x + (toPos.x - fromPos.x) * progress;
        const currentY = fromPos.y + (toPos.y - fromPos.y) * progress;

        if (stepDelayMs > 0) {
          await delay(stepDelayMs);
        }

        await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: currentX,
          y: currentY,
          button: 'left'
        });
      }

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: toPos.x,
        y: toPos.y,
        button: 'left',
        clickCount: 1
      });
    }

    outputSuccess('Drag performed', {
      mode: options.touch ? 'touch' : 'mouse',
      frame: options.frame ?? null,
      from: {
        x: Math.round(fromPos.x),
        y: Math.round(fromPos.y),
        selector: from.selector ?? null,
        text: from.text ?? null
      },
      to: {
        x: Math.round(toPos.x),
        y: Math.round(toPos.y),
        selector: to.selector ?? null,
        text: to.text ?? null
      },
      steps,
      duration: durationMs,
      longpress: longpressSeconds
    });
  } catch (error) {
    if (error instanceof DragError) {
      outputError(error.message, error.code, error.details);
    } else {
      outputCommandError(
        error,
        'DRAG_FAILED',
        {
          from: { selector: from.selector, text: from.text },
          to: { selector: to.selector, text: to.text }
        }
      );
    }
    await context.releaseSessionLeases();
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}
