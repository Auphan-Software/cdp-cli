/** Deterministic browser workflow. Binary screenshots never enter text output. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CDPContext } from './context.js';
import { capture } from './commands/state.js';
import { StateStore } from './state/store.js';
import { diffStates } from './state/diff.js';
import type { PageState } from './state/types.js';
import { projectState } from './experimental/decision.js';
import { DaemonClient } from './daemon/client.js';

const execFileAsync = promisify(execFile);
const exeMode = typeof CDP_CLI_EXE_MODE !== 'undefined' && CDP_CLI_EXE_MODE === true;
export interface WorkflowOptions {
  page: string; task: string; source?: string; frame?: string; maxElements?: number;
  stabilityMs?: number; full?: boolean; action?: string; selector?: string; value?: string;
  url?: string; key?: string; waitFor?: string; waitForText?: string; screenshot?: boolean;
}

/** Child processes isolate legacy command output/errors and retain all input guards. */
export async function runCli(args: string[], env = process.env): Promise<{ rows: any[]; ok: boolean }> {
  let stdout: string;
  let ok = true;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [...(exeMode ? [] : [resolve(process.argv[1])]), ...args],
      { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
  } catch (error) {
    ok = false;
    const failure = error as { stdout?: string; killed?: boolean };
    stdout = failure.stdout ?? '';
    if (failure.killed) throw new Error('WORKFLOW_COMMAND_TIMEOUT: delivery may be unknown; do not repeat automatically');
  }
  const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { throw new Error('WORKFLOW_INVALID_COMMAND_OUTPUT'); }
  });
  if (!rows.length) throw new Error('WORKFLOW_EMPTY_COMMAND_OUTPUT');
  return { rows, ok: ok && !rows.some(row => row.error === true || row.success === false) };
}

export function semanticSignature(state: PageState): string {
  return JSON.stringify({ targetId: state.targetId, session: state.session, captureProfile: state.captureProfile,
    url: state.url, title: state.title, readyState: state.readyState, bodyTextHash: state.bodyTextHash,
    dialog: state.dialog, focus: state.focus, hints: state.hints, coverage: { ...state.coverage, unstable: undefined, volatileKeys: undefined },
    elements: state.elements.map(({ box: _box, ...node }) => node) });
}

export function actionArgs(options: WorkflowOptions): string[] {
  const required = (value: string | undefined, label: string): string => {
    if (value === undefined || (label !== 'value' && !value.trim())) throw new Error(`WORKFLOW_REQUIRED_${label.toUpperCase()}`);
    return value;
  };
  const selector = () => required(options.selector, 'selector');
  let args: string[];
  switch (options.action) {
    case 'click': args = ['click', selector(), options.page]; break;
    case 'fill': args = ['fill', selector(), required(options.value, 'value'), options.page, '--expect-value']; break;
    case 'select': args = ['select', selector(), required(options.value, 'value'), options.page]; break;
    case 'press-key':
      if (options.frame) throw new Error('WORKFLOW_FRAMED_KEY_UNSUPPORTED: use the existing frame-aware input path');
      args = ['press-key', required(options.key, 'key'), options.page]; break;
    case 'navigate': {
      const url = required(options.url, 'url');
      if (!/^https?:\/\//i.test(url)) throw new Error('WORKFLOW_HTTP_URL_REQUIRED');
      args = ['navigate', url, options.page]; break;
    }
    case 'back': case 'forward': case 'reload': args = ['navigate', options.action, options.page]; break;
    default: throw new Error('WORKFLOW_INVALID_ACTION');
  }
  if (options.frame) args.push(options.action === 'navigate' || ['back', 'forward', 'reload'].includes(options.action!) ? '--wait-for-frame' : '--frame', options.frame);
  if (options.waitFor) args.push('--wait-for', options.waitFor);
  if (options.waitForText) args.push('--wait-for-text', options.waitForText);
  args.push('--timeout', '10000');
  return args;
}

export async function workflow(context: CDPContext, operation: string, options: WorkflowOptions): Promise<unknown> {
  if (!options.task.trim() || options.task.length > 8000) throw new Error('WORKFLOW_INVALID_TASK');
  if (options.frame && /^\d+$/.test(options.frame) && options.frame !== '0') throw new Error('WORKFLOW_STABLE_FRAME_SELECTOR_REQUIRED');
  const page = await context.findPage(options.page);
  options = { ...options, page: page.id, frame: options.frame === '0' ? undefined : options.frame };
  const store = new StateStore(context.cdpUrl, context.workspaceSessionName, page.id, process.env.CDP_STATE_ROOT);
  const previous = options.source ? store.load(options.source) : undefined;
  const take = async (stabilityMs = options.stabilityMs ?? 200): Promise<PageState> => {
    let state: PageState | undefined;
    if (!await capture(context, { page: page.id, frame: options.frame, maxElements: options.maxElements ?? 2000,
      stabilityMs, quiet: true, includeHints: true, onCaptured: value => { state = value; } }) || !state) throw new Error('WORKFLOW_OBSERVATION_FAILED');
    return state;
  };
  if (operation === 'expand') {
    if (!previous) throw new Error('WORKFLOW_SOURCE_REQUIRED');
    return { success: true, type: 'workflow-expand', value: { state: previous, historical: true,
      instruction: 'Canonical capture at source time; observe again before a new action.' } };
  }
  if (!['observe', 'act', 'screenshot'].includes(operation)) throw new Error('WORKFLOW_INVALID_OPERATION');
  let action: unknown;
  let current: PageState;
  if (operation === 'act') {
    if (!previous) throw new Error('WORKFLOW_SOURCE_REQUIRED');
    const args = actionArgs(options);
    const before = await take(0);
    if (previous.coverage.unstable || before.coverage.blockedByDialog || before.coverage.dialogProbeUnavailable ||
      semanticSignature(previous) !== semanticSignature(before)) throw new Error('WORKFLOW_STALE_SOURCE: observe again; no action delivered');
    let deliveryUnknown = false;
    let result: Awaited<ReturnType<typeof runCli>>;
    try { result = await runCli([...args, '--cdp-url', context.cdpUrl, ...(context.workspaceSessionName ? ['--session', context.workspaceSessionName] : [])]); }
    catch {
      deliveryUnknown = true;
      result = { ok: false, rows: [{ error: true, code: 'WORKFLOW_ACTION_DELIVERY_UNKNOWN',
        message: 'Action transport or output failed after dispatch. Recover state before considering another interaction.' }] };
    }
    const actionEvidence = options.action === 'select' ? result.rows.map(row => {
      if (!row.data || typeof row.data !== 'object') return row;
      const value = { ...row.data };
      for (const field of ['value', 'previousValue']) if (typeof value[field] === 'string') value[field] = store.mask(value[field]);
      return { ...row, data: value };
    }) : result.rows;
    action = { kind: options.action, commandSucceeded: deliveryUnknown ? null : result.ok, deliveryUnknown, evidence: actionEvidence,
      instruction: result.ok ? 'Command delivery is not proof of the expected effect; check state and assertions.' :
        'A failed command or wait may follow a delivered interaction. Inspect recovered state; do not repeat the action blindly.' };
    try { current = await take(); }
    catch { return { success: false, type: 'workflow-action', value: { action, observationUnavailable: true,
      instruction: 'Observe to recover evidence; do not repeat the action blindly.' } }; }
  } else current = await take();
  const diff = previous ? diffStates(previous, current) : undefined;
  const errors: Array<{ source: 'console' | 'network'; message: string }> = [];
  const diagnostics: Record<string, unknown> = { boundedLast: 100, console: 'unavailable', network: 'unavailable' };
  let daemon: DaemonClient | undefined;
  try { daemon = new DaemonClient({ cdpUrl: context.cdpUrl }); }
  catch { diagnostics.daemon = 'unconfigured'; }
  if (daemon && await daemon.isRunning().catch(() => false)) {
    try {
      const logs = await daemon.getConsoleLogs(page.id, { last: 100, workspaceSession: context.workspaceSessionName });
      errors.push(...logs.filter(log => /error|warn|exception/i.test(log.type)).map(log => ({ source: 'console' as const, message: log.text })));
      diagnostics.console = 'available'; diagnostics.consoleAtLimit = logs.length >= 100;
    } catch { /* Missing diagnostic access stays explicit. */ }
    try {
      const logs = await daemon.getNetworkLogs(page.id, { last: 100, workspaceSession: context.workspaceSessionName });
      errors.push(...logs.filter(log => (log.status ?? 0) >= 400 || log.failure).map(log => ({ source: 'network' as const, message: `${log.method} ${log.url} ${log.status ?? ''} ${log.failure?.errorText ?? ''}` })));
      diagnostics.network = 'available'; diagnostics.networkAtLimit = logs.length >= 100;
    } catch { /* Never interpret unavailable logs as a clean page. */ }
  }
  const view = await projectState(options.task, current, { prune: !options.full, hints: current.hints, diff, errors });
  let screenshot: unknown;
  if (operation === 'screenshot' || options.screenshot) {
    try {
      const directory = join(store.dir, 'evidence');
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}.png`);
      const result = await runCli(['screenshot', page.id, '--output', path, '--format', 'png', '--cdp-url', context.cdpUrl,
        ...(context.workspaceSessionName ? ['--session', context.workspaceSessionName] : [])]);
      screenshot = { available: result.ok, path: result.ok ? path : undefined, source: view.source, evidence: result.rows,
        semanticStable: result.ok ? semanticSignature(current) === semanticSignature(await take(0)) : false };
    } catch {
      screenshot = { available: false, semanticStable: null, source: view.source,
        instruction: 'Screenshot or alignment capture failed; action/state evidence remains valid at its capture time. Recover pixels without repeating the action.' };
    }
  }
  return { success: true, type: 'workflow-observation', value: { ...(action ? { action } : {}), view, diagnostics,
    canonicalPath: join(store.dir, `${current.id}.json`), ...(screenshot ? { screenshot } : {}) } };
}
