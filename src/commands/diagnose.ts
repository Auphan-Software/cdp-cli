/**
 * Bounded, read-only diagnostic evidence for a page failure.
 *
 * This module intentionally does not expose storage, cookies, request bodies,
 * or unredacted query values. It is an importable primitive; CLI wiring can
 * choose when a failure merits a bundle without changing normal command output.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CDPContext, type ConsoleMessage, type NetworkRequest } from '../context.js';
import { DaemonClient } from '../daemon/client.js';
import { outputLine } from '../output.js';
import { describeCliPath } from '../path.js';
import { build, commit, dirty, runtime, version } from '../version.js';

const MAX_CONSOLE_ERRORS = 20;
const MAX_NETWORK_FAILURES = 20;
const MAX_DOM_NODES = 40;

export interface DiagnosePageOptions {
  page: string;
  /** Existing or new directory in which manifest.json and screenshot.png go. */
  outputDir?: string;
}

export interface DiagnosticBundle {
  generatedAt: string;
  provenance: {
    cli: { version: string; build: string; runtime: string; commit: string; dirty: boolean };
    daemon: { running: boolean; sessions?: number };
  };
  page: Record<string, unknown>;
  dialog: Record<string, unknown> | null;
  frames: Array<Record<string, unknown>>;
  consoleErrors: Array<Record<string, unknown>>;
  networkFailures: Array<Record<string, unknown>>;
  dom: Record<string, unknown> | null;
  artifacts?: {
    directory: ReturnType<typeof describeCliPath>;
    manifest: string;
    screenshot?: string;
    screenshotError?: string;
  };
}

/** Collect, optionally persist, emit, and return a privacy-safe page evidence bundle. */
export async function diagnosePage(
  context: CDPContext,
  options: DiagnosePageOptions
): Promise<DiagnosticBundle> {
  const page = await context.findPage(options.page);
  const daemon = new DaemonClient({ cdpUrl: context.cdpUrl });
  const daemonStatus = await daemon.getStatus();
  const ws = await context.connect(page);
  const output = options.outputDir ? describeCliPath(options.outputDir) : undefined;

  try {
    const [frameResult, pageStateResult, windowResult, versionResult, dialogResult, daemonLogs] = await Promise.all([
      capture(() => context.getFrameTree(ws)),
      capture(() => context.sendCommand(ws, 'Runtime.evaluate', {
        expression: compactPageStateExpression(),
        returnByValue: true,
        awaitPromise: false
      })),
      capture(() => context.sendCommand(ws, 'Browser.getWindowForTarget')),
      capture(() => context.sendCommand(ws, 'Browser.getVersion')),
      capture(() => context.checkForDialog(ws)),
      collectDaemonEvidence(daemon, daemonStatus.running, page.id)
    ]);

    const state = pageStateResult.value?.result?.value as Record<string, unknown> | undefined;
    const browser = versionResult.value as Record<string, unknown> | undefined;
    const bundle: DiagnosticBundle = {
      generatedAt: new Date().toISOString(),
      provenance: {
        cli: { version, build, runtime, commit, dirty },
        daemon: daemonStatus
      },
      page: {
        id: page.id,
        title: bounded(page.title, 300),
        targetUrl: redactUrl(page.url),
        currentUrl: redactUrl(String(state?.url ?? page.url)),
        readyState: state?.readyState ?? null,
        visible: state?.visible ?? null,
        focused: state?.focused ?? null,
        activeElement: state?.activeElement ?? null,
        windowBounds: windowResult.value?.bounds ?? null,
        browserProduct: browser?.product ?? null,
        collectionErrors: compactErrors({
          pageState: pageStateResult.error,
          frames: frameResult.error,
          window: windowResult.error,
          browserVersion: versionResult.error,
          dialog: dialogResult.error
        })
      },
      dialog: dialogResult.value ? redactDialog(dialogResult.value) : null,
      frames: (frameResult.value ?? []).slice(0, 50).map(frame => ({
        id: frame.id,
        parentId: frame.parentId ?? null,
        name: bounded(frame.name ?? '', 160) || null,
        url: redactUrl(frame.url),
        securityOrigin: frame.securityOrigin ?? null
      })),
      consoleErrors: daemonLogs.consoleErrors,
      networkFailures: daemonLogs.networkFailures,
      dom: normalizeDom(state?.dom),
    };

    if (output) {
      // This is the sole write location. mkdir is non-destructive and does not
      // clean or replace any prior bundle contents.
      mkdirSync(output.resolvedPath, { recursive: true });
      // Report absolute artifact paths, while `directory` preserves the
      // requested/translated input details for callers that need provenance.
      const manifestPath = join(output.resolvedPath, 'manifest.json');
      const screenshotPath = join(output.resolvedPath, 'screenshot.png');
      assertDiagnosticArtifactsAvailable(manifestPath, screenshotPath, output.resolvedPath);
      let screenshotError: string | undefined;
      try {
        const result = await context.sendCommand(ws, 'Page.captureScreenshot', { format: 'png' });
        writeFileSync(screenshotPath, Buffer.from(result.data, 'base64'), { flag: 'wx' });
      } catch (error) {
        screenshotError = bounded((error as Error).message, 500);
      }
      bundle.artifacts = {
        directory: output,
        manifest: manifestPath,
        ...(screenshotError ? { screenshotError } : { screenshot: screenshotPath })
      };
      writeFileSync(manifestPath, JSON.stringify(bundle, null, 2), { flag: 'wx' });
    }

    outputLine({
      success: true,
      type: 'diagnostic-bundle',
      data: bundle,
      ...(bundle.artifacts && { manifest: bundle.artifacts.manifest })
    });
    return bundle;
  } finally {
    ws.close();
  }
}

async function collectDaemonEvidence(
  daemon: DaemonClient,
  daemonRunning: boolean,
  pageId: string
): Promise<{ consoleErrors: Array<Record<string, unknown>>; networkFailures: Array<Record<string, unknown>> }> {
  if (!daemonRunning) return { consoleErrors: [], networkFailures: [] };
  try {
    const [consoleLogs, networkLogs] = await Promise.all([
      daemon.getConsoleLogs(pageId, { last: MAX_CONSOLE_ERRORS }),
      daemon.getNetworkLogs(pageId, { last: MAX_NETWORK_FAILURES })
    ]);
    return {
      consoleErrors: consoleLogs
        .filter(log => log.type === 'error' || log.source === 'exception')
        .slice(-MAX_CONSOLE_ERRORS)
        .map(redactConsole),
      networkFailures: networkLogs
        .filter(log => log.failure)
        .slice(-MAX_NETWORK_FAILURES)
        .map(redactNetworkFailure)
    };
  } catch {
    // The daemon is optional; unavailable history must not prevent direct page evidence.
    return { consoleErrors: [], networkFailures: [] };
  }
}

function compactPageStateExpression(): string {
  return `(() => {
    const visible = document.visibilityState === 'visible';
    const active = document.activeElement;
    const nodes = Array.from(document.body ? document.body.querySelectorAll('*') : [])
      .slice(0, ${MAX_DOM_NODES})
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: (el.id || '').slice(0, 80) || undefined,
          role: el.getAttribute('role') || undefined,
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
        };
      });
    return {
      url: location.href,
      readyState: document.readyState,
      visible,
      focused: document.hasFocus(),
      activeElement: active ? { tag: active.tagName.toLowerCase(), id: (active.id || '').slice(0, 80) || undefined } : null,
      dom: { nodeCount: document.body ? document.body.querySelectorAll('*').length : 0, nodes, truncated: nodes.length === ${MAX_DOM_NODES} }
    };
  })()`;
}

async function capture<T>(operation: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await operation() };
  } catch (error) {
    return { error: bounded((error as Error).message, 500) };
  }
}

function normalizeDom(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const dom = value as { nodeCount?: unknown; nodes?: unknown; truncated?: unknown };
  return {
    nodeCount: typeof dom.nodeCount === 'number' ? dom.nodeCount : null,
    nodes: Array.isArray(dom.nodes) ? dom.nodes.slice(0, MAX_DOM_NODES) : [],
    truncated: dom.truncated === true
  };
}

function redactConsole(log: ConsoleMessage): Record<string, unknown> {
  return {
    type: log.type,
    timestamp: log.timestamp,
    text: redactText(bounded(log.text, 1_000)),
    source: log.source,
    ...(log.url && { url: redactUrl(log.url) }),
    ...(log.line !== undefined && { line: log.line })
  };
}

function redactNetworkFailure(log: NetworkRequest): Record<string, unknown> {
  return {
    id: log.id,
    method: log.method,
    url: redactUrl(log.url),
    status: log.status ?? null,
    type: log.type ?? null,
    timestamp: log.timestamp,
    failure: log.failure ? {
      errorText: bounded(log.failure.errorText, 500),
      canceled: log.failure.canceled,
      blockedReason: log.failure.blockedReason ?? null
    } : null
  };
}

export function redactDialog(dialog: { type?: string; message?: string; url?: string; defaultPrompt?: string }): Record<string, unknown> {
  const message = dialog.message ?? '';
  return {
    type: dialog.type ?? 'unknown',
    message: message ? '[REDACTED]' : '',
    messageLength: message.length,
    url: redactUrl(dialog.url ?? ''),
    ...(dialog.defaultPrompt !== undefined && { defaultPrompt: '[REDACTED]' })
  };
}

export function assertDiagnosticArtifactsAvailable(
  manifestPath: string,
  screenshotPath: string,
  outputDirectory: string
): void {
  if (existsSync(manifestPath) || existsSync(screenshotPath)) {
    throw new Error(
      `Diagnostic artifact already exists; choose a new --output-dir: ${outputDirectory}`
    );
  }
}

/** Redact every query value, rather than attempting to guess which key is a credential. */
export function redactUrl(input: string): string {
  if (!input) return input;
  try {
    const url = new URL(input);
    for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, '[REDACTED]');
    return url.toString();
  } catch {
    const query = input.indexOf('?');
    return query === -1 ? input : `${input.slice(0, query)}?[REDACTED_QUERY]`;
  }
}

function redactText(input: string): string {
  return input
    .replace(/https?:\/\/[^\s"'<>]+/g, redactUrl)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/\b(token|secret|password|authorization|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b\d{6}\b/g, '[REDACTED_CODE]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_NUMBER]');
}

function compactErrors(errors: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(errors).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function bounded(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}
