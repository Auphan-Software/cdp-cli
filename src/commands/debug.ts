/**
 * Debugging commands: console, snapshot, eval, screenshot, status
 */

import { CDPContext, ConsoleMessage } from '../context.js';
import { outputLine, outputError, outputCommandError, outputSuccess, outputRaw } from '../output.js';
import { readFileSync, writeFileSync } from 'fs';
import { extname } from 'node:path';
import { resizePngBuffer } from '../resize.js';
import { describeCliPath, normalizeCliPath } from '../path.js';
import { createExecSession, createExecSessionByPageRef } from '../daemon/exec.js';
import {
  awaitStreamWindow,
  outputStreamStopped,
  resolveStreamWindow,
  withSetupDeadline,
  type MonitorSocket,
  type StreamWindowOptions
} from './stream-monitor.js';
import { DaemonClient } from '../daemon/client.js';
import { fetch as undiciFetch } from 'undici';
import {
  version as cliVersion,
  build as cliBuild,
  runtime as cliRuntime,
  commit as cliCommit,
  dirty as cliDirty
} from '../version.js';

/**
 * Get the ax snapshot script for evaluating in page context
 */
function getAxSnapshotScript(): string {
  return `
(() => {
  const results = [];
  const seen = new Set();

  // Selectors for clickable elements
  const clickableSelector = [
    'button',
    '[role="button"]',
    'a[href]',
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="reset"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    'select',
    'label',
    'summary',
    '[onclick]',
    '[onmousedown]',
    '[ng-click]',
    '[data-action]',
    'li.item',
    '[class*="-btn"]'
  ].join(',');

  // Selectors for fillable elements
  const fillableSelector = [
    'input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
    'textarea',
    '[contenteditable="true"]'
  ].join(',');

  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);

    // Try data-testid or name
    const testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';

    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';

    // Build a path, anchored on nearest ID
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 4) {
      let selector = current.tagName.toLowerCase();

      // If we hit an ID, anchor there and stop
      if (current.id && current !== el) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(selector);
      current = parent;
    }
    return parts.join(' > ');
  }

  function formatElement(el) {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const rect = el.getBoundingClientRect();

    // Skip invisible elements
    if (rect.width === 0 && rect.height === 0) return null;

    // Skip duplicates
    if (seen.has(el)) return null;
    seen.add(el);

    const info = {
      role: role || tag + (type ? ':' + type : ''),
      selector: getSelector(el)
    };

    // Get label/name
    const rawText = (el.innerText || '').trim();
    const text = rawText.replace(/[\\r\\n]+/g, ' ').replace(/\\s{2,}/g, ' ').slice(0, 80);
    const title = el.getAttribute('title');
    const ariaLabel = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const value = el.value;
    const name = el.getAttribute('name');

    // Try aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    let labelledByText = '';
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) labelledByText = (labelEl.innerText || '').trim().replace(/[\\r\\n]+/g, ' ').replace(/\\s{2,}/g, ' ').slice(0, 60);
    }

    // For icon buttons, check child elements for title/aria-label
    let iconLabel = '';
    if (!text && (tag === 'button' || tag === 'a')) {
      const icon = el.querySelector('[title], [aria-label], i[class], svg[class]');
      if (icon) {
        iconLabel = icon.getAttribute('title') || icon.getAttribute('aria-label') || '';
        if (!iconLabel && icon.className) {
          // Try to extract icon name from class (e.g., 'fa-edit' -> 'edit')
          const match = icon.className.match(/(?:fa|icon|bi|mdi)-([a-z-]+)/i);
          if (match) iconLabel = match[1].replace(/-/g, ' ');
        }
      }
    }

    if (ariaLabel) info.label = ariaLabel;
    else if (labelledByText) info.label = labelledByText;
    else if (title) info.label = title;
    else if (iconLabel) info.label = iconLabel;
    else if (text && text.length < 60) info.label = text;
    else if (placeholder) info.label = placeholder;

    if (name) info.name = name;
    if (value && tag === 'select') info.value = value;
    if (value && (tag === 'input' || tag === 'textarea') && type !== 'password') {
      info.value = value.slice(0, 40);
    }

    // Checkbox/radio state
    if (el.checked !== undefined) info.checked = el.checked;

    // Select options
    if (tag === 'select' && el.options) {
      info.options = Array.from(el.options).slice(0, 5).map(o => o.text.trim().slice(0, 30));
      if (el.options.length > 5) info.options.push('...');
    }

    return info;
  }

  // Find clickable elements
  document.querySelectorAll(clickableSelector).forEach(el => {
    const info = formatElement(el);
    if (info) {
      info.action = 'click';
      results.push(info);
    }
  });

  // Find fillable elements
  document.querySelectorAll(fillableSelector).forEach(el => {
    const info = formatElement(el);
    if (info) {
      info.action = 'fill';
      results.push(info);
    }
  });

  return results;
})()
  `;
}

/**
 * Format ax snapshot elements into output lines
 */
function formatAxElements(elements: any[]): string {
  const lines = elements.map((el: any) => {
    let line = `[${el.role}]`;
    if (el.label) line += ` "${el.label}"`;
    if (el.name) line += ` name=${el.name}`;
    if (el.value) line += ` value="${el.value}"`;
    if (el.checked !== undefined) line += el.checked ? ' ✓' : ' ○';
    if (el.options) line += ` options=[${el.options.map((o: string) => `"${o}"`).join(',')}]`;
    line += ` → ${el.selector}`;
    return line;
  });
  return lines.join('\n');
}

/**
 * Stream live console messages for a bounded window (or until interrupted with
 * `--follow`). Passive monitor: no exclusive workspace lease is held.
 */
export async function listConsole(
  context: CDPContext,
  options: { type?: string; page: string } & StreamWindowOptions
): Promise<void> {
  let ws: Awaited<ReturnType<typeof context.connect>> | undefined;
  let pageId: string | undefined;
  try {
    const window = resolveStreamWindow(options, 'list-console');

    // The bounded window only starts once we are listening, so bound the
    // connection phase too.
    ws = await withSetupDeadline(
      (async () => {
        const page = await context.findPage(options.page);
        pageId = page.id;
        await context.ensureDaemonPageSession(page);
        await context.assertNoDevTools(page.id);

        // Passive monitor: assert ownership, but take no exclusive lease.
        const socket = await context.connect(page, { lease: false });

        context.setupConsoleCollection(
          socket,
          (message: ConsoleMessage) => {
            if (options.type && message.type !== options.type) {
              return;
            }

            outputLine({
              type: message.type,
              timestamp: message.timestamp,
              text: message.text,
              source: message.source,
              ...(message.line !== undefined && { line: message.line }),
              ...(message.url && { url: message.url })
            });
          },
          { retain: false }
        );
        await context.sendCommand(socket, 'Runtime.enable');
        return socket;
      })(),
      'list-console'
    );

    const reason = await awaitStreamWindow(window, {
      socket: ws as unknown as MonitorSocket,
      ...(context.workspaceSessionName
        ? { revalidate: () => context.assertSessionTargetAccess(pageId as string) }
        : {})
    });
    outputStreamStopped('list-console', window, reason);
  } catch (error) {
    outputError(
      (error as Error).message,
      (error as { code?: string }).code ?? 'LIST_CONSOLE_FAILED'
    );
    if (ws) {
      ws.close();
    }
    process.exit(1);
  } finally {
    // A passive monitor holds no lease of its own, so it must not release
    // leases another operation on this context may still hold.
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Take a snapshot of the page (DOM or accessibility tree)
 */
export async function snapshot(
  context: CDPContext,
  options: { format?: string; page: string; frame?: string }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  let directWs: Awaited<ReturnType<typeof context.connect>> | undefined;
  try {
    const format = options.format || 'ax';

    // For frame targeting, we need direct WebSocket (daemon doesn't support contextId)
    if (options.frame) {
      const page = await context.findPage(options.page);
      directWs = await context.connect(page);

      // Resolve frame context
      const contextId = await context.resolveFrameContext(directWs, options.frame);

      if (format === 'text') {
        const result = await context.sendCommand(directWs, 'Runtime.evaluate', {
          expression: 'document.body.innerText',
          contextId,
          returnByValue: true
        });
        outputRaw(result.result?.value || '');
      } else if (format === 'ax') {
        const result = await context.sendCommand(directWs, 'Runtime.evaluate', {
          expression: getAxSnapshotScript(),
          contextId,
          returnByValue: true
        });
        const elements = result.result?.value || [];
        outputRaw(formatAxElements(elements));
      } else {
        throw new Error(`Unknown snapshot format: ${format}`);
      }
      return;
    }

    // No frame - use daemon if available (optimized path)
    session = await createExecSessionByPageRef(context, options.page);
    await session.assertNoDevTools();
    await session.assertNoDialog();

    if (format === 'text') {
      // Simple text snapshot
      await session.exec('Runtime.enable');
      const result = await session.exec('Runtime.evaluate', {
        expression: 'document.body.innerText',
        returnByValue: true
      });

      outputRaw(result.result?.value || '');
    } else if (format === 'ax') {
      await session.exec('Runtime.enable');
      const result = await session.exec('Runtime.evaluate', {
        expression: getAxSnapshotScript(),
        returnByValue: true
      });
      outputRaw(formatAxElements(result.result?.value || []));
    } else {
      throw new Error(`Unknown snapshot format: ${format}`);
    }
  } catch (error) {
    outputCommandError(
      error,
      'SNAPSHOT_FAILED',
      { format: options.format }
    );
    await session?.close();
    await context.releaseSessionLeases();
    session = undefined;
    process.exit(1);
  } finally {
    await session?.close();
    directWs?.close();
  }
}

/**
 * Evaluate JavaScript expression
 */
export async function evaluate(
  context: CDPContext,
  expression: string,
  options: { page: string; file?: string; async?: boolean; frame?: string; stdin?: boolean }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  let directWs: Awaited<ReturnType<typeof context.connect>> | undefined;
  const filePath = options.file ? describeCliPath(options.file) : undefined;
  try {
    // Read from file, stdin, or use expression
    let code = expression;
    if (filePath) {
      code = readFileSync(filePath.normalizedPath, 'utf-8');
    } else if (options.stdin) {
      code = readFileSync(0, 'utf-8');
    }

    // Wrap in async IIFE if --async
    if (options.async) {
      code = `(async () => { ${code} })()`;
    }

    // For frame targeting, we need direct WebSocket (daemon doesn't support contextId)
    // Otherwise use daemon if available (optimized path)
    let contextId: number | undefined;

    if (options.frame) {
      // Frame targeting requires direct WebSocket
      const page = await context.findPage(options.page);
      directWs = await context.connect(page);

      // Resolve frame context FIRST (this internally enables Runtime and Page domains)
      // Must be done before any other Runtime.enable call to catch context events
      contextId = await context.resolveFrameContext(directWs, options.frame);

      const result = await context.sendCommand(directWs, 'Runtime.evaluate', {
        expression: code,
        contextId,
        returnByValue: true,
        awaitPromise: true
      });

      if (result.exceptionDetails) {
        outputError(
          result.exceptionDetails.text,
          'EVAL_EXCEPTION',
          result.exceptionDetails
        );
        await session?.close();
        await context.releaseSessionLeases();
        process.exit(1);
      }

      outputLine({
        success: true,
        value: result.result?.value,
        type: result.result?.type,
        frame: options.frame
      });
    } else {
      // No frame - use daemon path if available
      session = await createExecSessionByPageRef(context, options.page);
      await session.assertNoDevTools();
      await session.assertNoDialog();

      await session.exec('Runtime.enable');

      const result = await session.exec('Runtime.evaluate', {
        expression: code,
        returnByValue: true,
        awaitPromise: true
      });

      if (result.exceptionDetails) {
        outputError(
          result.exceptionDetails.text,
          'EVAL_EXCEPTION',
          result.exceptionDetails
        );
        await session?.close();
        await context.releaseSessionLeases();
        process.exit(1);
      }

      outputLine({
        success: true,
        value: result.result?.value,
        type: result.result?.type
      });
    }
  } catch (error) {
    outputCommandError(
      error,
      'EVAL_FAILED',
      {
        expression,
        frame: options.frame,
        ...(filePath && { file: filePath })
      }
    );
    await session?.close();
    await context.releaseSessionLeases();
    process.exit(1);
  } finally {
    await session?.close();
    if (directWs) {
      directWs.close();
    }
  }
}

/**
 * Read the pixel dimensions out of an encoded image.
 *
 * Reported so a caller writing to --output learns what it captured without
 * having to decode the file itself. Returns null for anything unparseable
 * rather than failing the capture, since the file has already been written.
 */
export function imageDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then the IHDR chunk carries width/height big-endian.
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk the marker segments to the start-of-frame, which holds the size.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // Standalone markers carry no length payload to skip over.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return null;
  }

  // WebP: RIFF container, dimensions depend on which VP8 chunk follows.
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const read24 = (at: number) => buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16);
      return { width: read24(24) + 1, height: read24(27) + 1 };
    }
  }

  return null;
}

/**
 * Take a screenshot
 */
export async function screenshot(
  context: CDPContext,
  options: { output?: string; format?: string; page: string; quality?: number; scale?: number; selector?: string }
): Promise<void> {
  let ws;
  const outputPath = options.output ? describeCliPath(options.output) : undefined;
  try {
    // Get page
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);

    // Check for blocking dialog before attempting screenshot
    await context.assertNoDialog(ws);

    const validFormats = ['jpeg', 'png', 'webp'];
    const detectedFormat = (() => {
      const explicitFormat = options.format?.toLowerCase();
      if (explicitFormat) {
        return explicitFormat;
      }

      if (!options.output) {
        return undefined;
      }

      const extension = extname(normalizeCliPath(options.output)).toLowerCase();
      if (!extension) {
        return undefined;
      }

      const normalizedExtension = extension.slice(1);
      if (normalizedExtension === 'jpg') {
        return 'jpeg';
      }

      if (validFormats.includes(normalizedExtension)) {
        return normalizedExtension;
      }

      return undefined;
    })();

    const scale = options.scale ?? 1;

    if (scale <= 0 || scale > 1) {
      throw new Error(`Invalid scale: ${scale}. Must be between 0 (exclusive) and 1 (inclusive).`);
    }

    // Downscaling decodes and re-encodes as PNG, so a scaled capture has to be
    // PNG or the resizer is handed bytes it cannot parse.
    if (scale !== 1 && detectedFormat && detectedFormat !== 'png') {
      throw new Error(
        `--scale re-encodes to PNG and cannot produce ${detectedFormat}. Use --format png (and a .png output path), or drop --scale.`
      );
    }

    const format = detectedFormat ?? (scale !== 1 ? 'png' : 'jpeg');

    if (!validFormats.includes(format)) {
      throw new Error(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    }

    const quality = options.quality || 90;

    const captureParams: Record<string, any> = {
      format,
      quality: format === 'jpeg' ? quality : undefined
    };

    // If --selector provided, scroll element into view and clip to its bounds
    if (options.selector) {
      await context.sendCommand(ws, 'Runtime.enable');
      const boundsResult = await context.sendCommand(ws, 'Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const rect = el.getBoundingClientRect();
          // Page.captureScreenshot clips in document coordinates, not viewport
          // coordinates, so the scroll offset has to be added back in.
          return {
            x: rect.x + window.scrollX,
            y: rect.y + window.scrollY,
            width: rect.width,
            height: rect.height
          };
        })()`,
        returnByValue: true,
        awaitPromise: false
      });

      const bounds = boundsResult.result?.value;
      if (!bounds) {
        throw new Error(`Element not found: ${options.selector}`);
      }

      if (bounds.width === 0 && bounds.height === 0) {
        throw new Error(`Element has no visible area to capture: ${options.selector}`);
      }

      const padding = 10;
      captureParams.clip = {
        x: Math.max(0, bounds.x - padding),
        y: Math.max(0, bounds.y - padding),
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
        scale: 1
      };
      // Lets the clip extend past the current viewport, which it does whenever
      // the element is taller than the window.
      captureParams.captureBeyondViewport = true;
    }

    const result = await context.sendCommand(ws, 'Page.captureScreenshot', captureParams);

    let buffer: Buffer = Buffer.from(result.data, 'base64');

    // Resize if scale !== 1 (avoids CDP viewport side effects)
    if (scale !== 1) {
      buffer = Buffer.from(await resizePngBuffer(buffer, scale));
    }

    if (outputPath) {
      writeFileSync(outputPath.normalizedPath, buffer);

      const dimensions = imageDimensions(buffer);

      outputSuccess('Screenshot saved', {
        file: outputPath.resolvedPath,
        requestedFile: outputPath.requestedPath,
        translatedPath: outputPath.translated,
        format,
        size: buffer.length,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null
      });
    } else {
      outputLine({
        success: true,
        format,
        data: buffer.toString('base64')
      });
    }
  } catch (error) {
    outputCommandError(
      error,
      'SCREENSHOT_FAILED',
      { output: outputPath ?? options.output }
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
 * Check for and optionally handle JavaScript dialogs (alert/confirm/prompt)
 */
export async function dialog(
  context: CDPContext,
  options: { page: string; dismiss?: boolean; accept?: boolean; promptText?: string }
): Promise<void> {
  let ws;
  try {
    const page = await context.findPage(options.page);
    ws = await context.connect(page);

    const dialogInfo = await context.checkForDialog(ws);

    if (!dialogInfo) {
      outputLine({
        success: true,
        dialog: null,
        message: 'No dialog present'
      });
      return;
    }

    // If action specified, handle the dialog
    if (options.dismiss || options.accept) {
      const action = options.accept ? 'accept' : 'dismiss';
      await context.handleDialog(ws, options.accept ?? false, options.promptText);

      outputSuccess(`Dialog ${action}ed`, {
        type: dialogInfo.type,
        message: dialogInfo.message,
        action,
        promptText: options.promptText
      });
    } else {
      // Just report dialog info
      outputLine({
        success: true,
        dialog: {
          type: dialogInfo.type,
          message: dialogInfo.message,
          url: dialogInfo.url,
          defaultPrompt: dialogInfo.defaultPrompt
        },
        hint: "Use --dismiss or --accept to handle the dialog"
      });
    }
  } catch (error) {
    outputCommandError(
      error,
      'DIALOG_FAILED',
      {}
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
 * Get combined status of daemon and Chrome
 */
export async function status(context: CDPContext): Promise<void> {
  try {
    // Check daemon status
    const client = new DaemonClient({ cdpUrl: context.cdpUrl });
    const daemonStatus = await client.getStatus();

    // Check Chrome status
    let chromeStatus: { running: boolean; version?: string; pages?: number } = { running: false };
    try {
      const res = await (globalThis.fetch ?? undiciFetch)(`http://localhost:9222/json/version`, {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) {
        const version = await res.json() as { Browser?: string };
        const pages = await context.getPages();
        chromeStatus = {
          running: true,
          version: version.Browser,
          pages: pages.length
        };
      }
    } catch {
      // Chrome not running
    }

    outputLine({
      // Discrete fields so a harness can gate on the version without parsing
      // the human-facing --version string, whose build suffix makes PHP's
      // version_compare report an equal version as older.
      // `commit` is the field to compare across callers: build timestamps are
      // rewritten by copying and by git checkout, so only the source SHA can
      // tell "same tool" from "stale exe shadowing a fresh npm build".
      cli: {
        version: cliVersion,
        build: cliBuild,
        runtime: cliRuntime,
        commit: cliCommit,
        dirty: cliDirty
      },
      daemon: {
        running: daemonStatus.running,
        sessions: daemonStatus.sessions
      },
      chrome: chromeStatus
    });
  } catch (error) {
    outputCommandError(
      error,
      'STATUS_FAILED',
      {}
    );
    await context.releaseSessionLeases();
    process.exit(1);
  }
}

/**
 * Query DOM elements and return structured data (text, html, attrs, styles)
 */
export async function query(
  context: CDPContext,
  selector: string,
  options: {
    page: string;
    text?: boolean;
    html?: boolean;
    attrs?: boolean;
    styles?: string;
    all?: boolean;
    frame?: string;
  }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  let directWs: Awaited<ReturnType<typeof context.connect>> | undefined;
  try {
    // Default to --text --attrs if no flags specified
    const hasFlags = options.text || options.html || options.attrs || options.styles;
    const wantText = options.text || !hasFlags;
    const wantAttrs = options.attrs || !hasFlags;
    const wantHtml = options.html || false;
    const styleProps = options.styles ? options.styles.split(',').map(s => s.trim()) : [];

    const jsExpression = `(() => {
      const selector = ${JSON.stringify(selector)};
      const all = ${options.all ? 'true' : 'false'};
      const wantText = ${wantText};
      const wantHtml = ${wantHtml};
      const wantAttrs = ${wantAttrs};
      const styleProps = ${JSON.stringify(styleProps)};

      const els = all
        ? Array.from(document.querySelectorAll(selector))
        : (() => { const el = document.querySelector(selector); return el ? [el] : []; })();

      if (els.length === 0) {
        return [{ type: 'query', selector, exists: false }];
      }

      return els.map(el => {
        const rect = el.getBoundingClientRect();
        const result = {
          type: 'query',
          selector,
          exists: true,
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
        };

        if (wantText) {
          result.text = (el.textContent || '').trim();
        }
        if (wantHtml) {
          const html = (el.innerHTML || '').trim();
          result.html = html.length > 2000 ? html.slice(0, 2000) + '...' : html;
        }
        if (wantAttrs) {
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          result.attrs = attrs;
        }
        if (styleProps.length > 0) {
          const computed = getComputedStyle(el);
          const styles = {};
          for (const prop of styleProps) {
            const cssProp = prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
            styles[prop] = computed.getPropertyValue(cssProp);
          }
          result.styles = styles;
        }
        return result;
      });
    })()`;

    let evalResult: any;

    if (options.frame) {
      const page = await context.findPage(options.page);
      directWs = await context.connect(page);
      const contextId = await context.resolveFrameContext(directWs, options.frame);
      const result = await context.sendCommand(directWs, 'Runtime.evaluate', {
        expression: jsExpression,
        contextId,
        returnByValue: true
      });
      evalResult = result;
    } else {
      session = await createExecSessionByPageRef(context, options.page);
      await session.assertNoDevTools();
      await session.assertNoDialog();
      await session.exec('Runtime.enable');
      evalResult = await session.exec('Runtime.evaluate', {
        expression: jsExpression,
        returnByValue: true
      });
    }

    if (evalResult.exceptionDetails) {
      outputError(
        evalResult.exceptionDetails.text || 'Query evaluation failed',
        'QUERY_EXCEPTION',
        evalResult.exceptionDetails
      );
      await session?.close();
      await context.releaseSessionLeases();
      process.exit(1);
    }

    const elements = evalResult.result?.value || [];
    for (const el of elements) {
      outputLine(el);
    }
  } catch (error) {
    outputCommandError(
      error,
      'QUERY_FAILED',
      { selector }
    );
    await session?.close();
    await context.releaseSessionLeases();
    session = undefined;
    process.exit(1);
  } finally {
    await session?.close();
    directWs?.close();
  }
}

/**
 * Extract computed styles with optional sibling comparison
 */
export async function styles(
  context: CDPContext,
  selector: string,
  options: {
    page: string;
    compareSiblings?: boolean;
    props?: string;
    frame?: string;
  }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  let directWs: Awaited<ReturnType<typeof context.connect>> | undefined;
  try {
    const defaultProps = ['color', 'fontSize', 'fontWeight', 'textAlign', 'margin', 'padding', 'lineHeight', 'display'];
    const styleProps = options.props ? options.props.split(',').map(s => s.trim()) : defaultProps;
    const compareSiblings = options.compareSiblings || false;

    const jsExpression = `(() => {
      const selector = ${JSON.stringify(selector)};
      const props = ${JSON.stringify(styleProps)};
      const compareSiblings = ${compareSiblings};

      function extractStyles(el) {
        const computed = getComputedStyle(el);
        const result = {
          tag: el.tagName,
          class: el.className || undefined
        };
        for (const prop of props) {
          const cssProp = prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
          result[prop] = computed.getPropertyValue(cssProp);
        }
        return result;
      }

      const el = document.querySelector(selector);
      if (!el) {
        return { type: 'styles', selector, exists: false };
      }

      const result = {
        type: 'styles',
        selector,
        element: extractStyles(el)
      };

      if (compareSiblings) {
        const parent = el.parentElement;
        if (parent) {
          result.parent = extractStyles(parent);
          result.siblings = Array.from(parent.children)
            .filter(c => c !== el && c.nodeType === 1)
            .slice(0, 10)
            .map(c => extractStyles(c));
        }
      }

      return result;
    })()`;

    let evalResult: any;

    if (options.frame) {
      const page = await context.findPage(options.page);
      directWs = await context.connect(page);
      const contextId = await context.resolveFrameContext(directWs, options.frame);
      const result = await context.sendCommand(directWs, 'Runtime.evaluate', {
        expression: jsExpression,
        contextId,
        returnByValue: true
      });
      evalResult = result;
    } else {
      session = await createExecSessionByPageRef(context, options.page);
      await session.assertNoDevTools();
      await session.assertNoDialog();
      await session.exec('Runtime.enable');
      evalResult = await session.exec('Runtime.evaluate', {
        expression: jsExpression,
        returnByValue: true
      });
    }

    if (evalResult.exceptionDetails) {
      outputError(
        evalResult.exceptionDetails.text || 'Styles evaluation failed',
        'STYLES_EXCEPTION',
        evalResult.exceptionDetails
      );
      await session?.close();
      await context.releaseSessionLeases();
      process.exit(1);
    }

    outputLine(evalResult.result?.value || { type: 'styles', selector, exists: false });
  } catch (error) {
    outputCommandError(
      error,
      'STYLES_FAILED',
      { selector }
    );
    await session?.close();
    await context.releaseSessionLeases();
    session = undefined;
    process.exit(1);
  } finally {
    await session?.close();
    directWs?.close();
  }
}

/**
 * Device presets for emulation
 */
interface DevicePreset {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  touch: boolean;
  ua: string;
}

const DEVICE_PRESETS: Record<string, DevicePreset> = {
  ipad: {
    width: 1024,
    height: 1366,
    scale: 2,
    mobile: true,
    touch: true,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  iphone: {
    width: 390,
    height: 844,
    scale: 3,
    mobile: true,
    touch: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  desktop: {
    width: 0,
    height: 0,
    scale: 0,
    mobile: false,
    touch: false,
    ua: '',
  },
};

/**
 * Emulate a mobile device using CDP Emulation domain
 */
export async function emulate(
  context: CDPContext,
  device: string,
  options: {
    page: string;
    width?: number;
    height?: number;
    scale?: number;
    ua?: string;
    touch?: boolean;
  }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  try {
    // Emulation overrides are scoped to the CDP session that sets them. A
    // short-lived direct connection loses the user-agent override the moment
    // it closes, so prefer the daemon's long-lived session when there is one.
    session = await createExecSessionByPageRef(context, options.page);

    const isDesktop = device === 'desktop';

    if (isDesktop) {
      // Reset all overrides
      await session.exec('Emulation.clearDeviceMetricsOverride');
      await session.exec('Emulation.setUserAgentOverride', { userAgent: '' });
      await session.exec('Emulation.setTouchEmulationEnabled', { enabled: false });

      outputSuccess('Emulation reset to desktop', {
        device: 'desktop',
        persistent: session.useDaemon
      });
      return;
    }

    // Resolve preset or build custom
    const preset = DEVICE_PRESETS[device];
    if (!preset && !options.width) {
      throw new Error(`Unknown device "${device}". Use: ipad, iphone, desktop, or provide --width/--height`);
    }

    const width = options.width ?? preset?.width ?? 1024;
    const height = options.height ?? preset?.height ?? 768;
    const scale = options.scale ?? preset?.scale ?? 1;
    const mobile = preset?.mobile ?? true;
    const touch = options.touch ?? preset?.touch ?? false;
    const ua = options.ua ?? preset?.ua ?? '';

    // Set device metrics
    await session.exec('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile,
    });

    // Set user agent
    if (ua) {
      await session.exec('Emulation.setUserAgentOverride', { userAgent: ua });
    }

    // Enable touch
    if (touch) {
      await session.exec('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5,
      });
    }

    // Verify what the page actually ended up with, rather than echoing back the
    // values we asked for.
    const applied = await session.exec('Runtime.evaluate', {
      expression: `JSON.stringify({ width: innerWidth, height: innerHeight, ua: navigator.userAgent })`,
      returnByValue: true
    });

    let appliedUa: string | undefined;
    try {
      appliedUa = JSON.parse(applied.result?.value ?? '{}').ua;
    } catch {
      // Leave undefined; the warning below covers it.
    }

    const uaApplied = !ua || appliedUa === ua;

    outputSuccess(`Emulating ${preset ? device : 'custom device'}`, {
      device: preset ? device : 'custom',
      width,
      height,
      scale,
      mobile,
      touch,
      ua: ua || undefined,
      uaApplied,
      persistent: session.useDaemon,
      ...(uaApplied
        ? {}
        : {
            warning:
              'The user-agent override did not stick. Emulation is bound to the CDP session, so start the daemon (cdp-cli daemon start) to keep it alive.'
          })
    });
  } catch (error) {
    outputCommandError(
      error,
      'EMULATE_FAILED',
      { device }
    );
    await session?.close();
    await context.releaseSessionLeases();
    session = undefined;
    process.exit(1);
  } finally {
    await session?.close();
  }
}

/**
 * Dismiss common UI overlays (toasts, notifications, modals)
 */
export async function dismissOverlays(
  context: CDPContext,
  options: { page: string; frame?: string }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  let directWs: Awaited<ReturnType<typeof context.connect>> | undefined;
  try {
    const jsExpression = `(() => {
      const selectors = [
        'button.notify-hide',
        '.toast-close',
        '.notification-dismiss',
        '[data-dismiss]',
        '.close-btn',
        '.modal .close',
        'button[aria-label="Close"]',
        'button[aria-label="Dismiss"]'
      ];
      const dismissed = [];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const text = (el.textContent || '').trim().slice(0, 40);
          el.click();
          dismissed.push({ selector: sel, text });
        }
      }
      return { type: 'dismiss-overlays', dismissed, count: dismissed.length };
    })()`;

    let evalResult: any;

    if (options.frame) {
      const page = await context.findPage(options.page);
      directWs = await context.connect(page);
      const contextId = await context.resolveFrameContext(directWs, options.frame);
      evalResult = await context.sendCommand(directWs, 'Runtime.evaluate', {
        expression: jsExpression,
        contextId,
        returnByValue: true
      });
    } else {
      session = await createExecSessionByPageRef(context, options.page);
      await session.assertNoDevTools();
      await session.assertNoDialog();
      await session.exec('Runtime.enable');
      evalResult = await session.exec('Runtime.evaluate', {
        expression: jsExpression,
        returnByValue: true
      });
    }

    if (evalResult.exceptionDetails) {
      outputError(
        evalResult.exceptionDetails.text || 'Dismiss overlays failed',
        'DISMISS_OVERLAYS_EXCEPTION',
        evalResult.exceptionDetails
      );
      await session?.close();
      await context.releaseSessionLeases();
      process.exit(1);
    }

    outputLine(evalResult.result?.value || { type: 'dismiss-overlays', dismissed: [], count: 0 });
  } catch (error) {
    outputCommandError(
      error,
      'DISMISS_OVERLAYS_FAILED',
      {}
    );
    await session?.close();
    await context.releaseSessionLeases();
    session = undefined;
    process.exit(1);
  } finally {
    await session?.close();
    directWs?.close();
  }
}
