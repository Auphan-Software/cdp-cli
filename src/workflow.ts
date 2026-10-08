/** Deterministic browser workflow. Binary screenshots never enter text output. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { CDPContext } from './context.js';
import { capture } from './commands/state.js';
import { StateStore } from './state/store.js';
import { diffStates } from './state/diff.js';
import type { PageState } from './state/types.js';
import { projectState, mustKeep } from './experimental/decision.js';
import { DaemonClient } from './daemon/client.js';
import { workflowProjectionProvider, workflowProjectionConfiguration, projectionReason } from './workflow-projection.js';
import { boundWorkflowResult, workflowViewProfile } from './workflow-output.js';

const execFileAsync = promisify(execFile);
const exeMode = typeof CDP_CLI_EXE_MODE !== 'undefined' && CDP_CLI_EXE_MODE === true;
export interface WorkflowOptions {
  page: string; task: string; source?: string; frame?: string; maxElements?: number;
  stabilityMs?: number; full?: boolean; action?: string; selector?: string; targetKey?: string; value?: string;
  url?: string; key?: string; waitFor?: string; waitForText?: string; screenshot?: boolean;
  offset?: number; limit?: number;
}

/** Opt-in site configuration; never infer harmlessness from time-shaped text. */
export function workflowClockSelectors(): string[] {
  const path = process.env.CDP_WORKFLOW_CONFIG ?? (process.platform === 'win32'
    ? join(process.env.ProgramData ?? 'C:/ProgramData', 'cdp-cli', 'workflow.json') : '/etc/cdp-cli/workflow.json');
  const configured = process.env.CDP_WORKFLOW_CLOCK_SELECTORS;
  const selectors = configured !== undefined ? JSON.parse(configured) : existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).clockSelectors : [];
  if (!Array.isArray(selectors) || selectors.length > 20 || selectors.some(s => typeof s !== 'string' || !s.trim() || s.length > 1000)) throw new Error('WORKFLOW_INVALID_CLOCK_CONFIGURATION');
  return selectors;
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

export function semanticSignature(state: PageState, clockTolerance = true): string {
  return JSON.stringify({ targetId: state.targetId, session: state.session, captureProfile: state.captureProfile,
    url: state.url, title: state.title, readyState: state.readyState, bodyTextHash: clockTolerance ? state.actionTextHash ?? state.bodyTextHash : state.bodyTextHash,
    dialog: state.dialog, focus: state.focus, hints: state.hints, coverage: { ...state.coverage, unstable: undefined, volatileKeys: undefined },
    elements: state.elements.map(({ box: _box, ...node }) => clockTolerance && node.cosmeticClock ? { ...node, text: undefined, name: undefined } : node) });
}

/** Resolve only canonical source metadata, never infer CSS from an opaque key. */
export function resolveWorkflowTarget(state: PageState, options: WorkflowOptions): string | undefined {
  if (options.targetKey === undefined) return options.selector;
  if (!['click', 'fill', 'select'].includes(options.action ?? '')) throw new Error('WORKFLOW_TARGET_KEY_ACTION_UNSUPPORTED: no action delivered');
  if (options.selector !== undefined) throw new Error('WORKFLOW_TARGET_CONFLICT: use either targetKey or selector; no action delivered');
  if (!options.targetKey.trim() || options.targetKey.length > 8000 || options.targetKey.includes('\0')) throw new Error('WORKFLOW_INVALID_TARGET_KEY: no action delivered');
  const matches = state.elements.filter(element => element.k === options.targetKey);
  if (matches.length !== 1 || matches[0].kq === 'ambiguous') throw new Error('WORKFLOW_TARGET_KEY_UNKNOWN_OR_AMBIGUOUS: no action delivered');
  const target = matches[0];
  if (!target.locator || target.locator.length > 8000 || target.locator.includes('\0')) throw new Error('WORKFLOW_TARGET_KEY_UNSUPPORTED: observe the target frame explicitly or use the existing target tools; no action delivered');
  if (target.state?.vis === false || target.state?.en === false) throw new Error('WORKFLOW_TARGET_KEY_UNAVAILABLE: no action delivered');
  return target.locator;
}

export function actionArgs(options: WorkflowOptions): string[] {
  for (const value of [options.waitFor, options.waitForText]) if (value !== undefined && !value.trim()) throw new Error('WORKFLOW_EMPTY_WAIT');
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
  const transport = workflowViewProfile();
  if (!options.task.trim() || options.task.length > 8000) throw new Error('WORKFLOW_INVALID_TASK');
  if (options.frame && /^\d+$/.test(options.frame) && options.frame !== '0') throw new Error('WORKFLOW_STABLE_FRAME_SELECTOR_REQUIRED');
  const page = await context.findPage(options.page);
  const frameSupplied = options.frame !== undefined;
  options = { ...options, page: page.id, frame: options.frame === '0' ? undefined : options.frame };
  const store = new StateStore(context.cdpUrl, context.workspaceSessionName, page.id, process.env.CDP_STATE_ROOT);
  const previous = options.source ? store.load(options.source) : undefined;
  const settings = previous?.captureOptions;
  if (operation === 'act' && settings && ((options.maxElements !== undefined && options.maxElements !== settings.maxElements) ||
    (frameSupplied && options.frame !== settings.frame))) throw new Error('WORKFLOW_CAPTURE_PROFILE_MISMATCH: no action delivered; keep the source capture settings');
  if (operation === 'act' && settings) options = { ...options, maxElements: settings.maxElements, frame: settings.frame };
  const clockSelectors = operation === 'act' && settings ? settings.clockSelectors : workflowClockSelectors();
  const observationAlias = `workflow-${createHash('sha256').update(JSON.stringify([options.frame, options.maxElements ?? 2000])).digest('hex').slice(0, 16)}`;
  let observedBefore: PageState | undefined;
  let historyUnavailable = false;
  if (!previous && ['observe', 'screenshot'].includes(operation)) {
    try { observedBefore = store.load(observationAlias); }
    catch (error) { historyUnavailable = !(error instanceof Error && error.message.startsWith('STATE_NOT_FOUND:')); }
  }
  const take = async (stabilityMs = options.stabilityMs ?? 200, recordObservation = true, actionSelector?: string): Promise<PageState> => {
    let state: PageState | undefined;
    if (!await capture(context, { page: page.id, frame: options.frame, maxElements: options.maxElements ?? 2000,
      stabilityMs, quiet: true, includeHints: true, clockSelectors, actionSelector, name: recordObservation ? observationAlias : undefined,
      onCaptured: value => { state = value; } }) || !state) throw new Error('WORKFLOW_OBSERVATION_FAILED');
    return state;
  };
  if (operation === 'expand') {
    if (!previous) throw new Error('WORKFLOW_SOURCE_REQUIRED');
    const offset = options.offset ?? 0, limit = options.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > previous.elements.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('WORKFLOW_INVALID_EXPANSION_RANGE');
    const state = { ...previous, hints: undefined, elements: [] as PageState['elements'] };
    const expanded = { success: true, type: 'workflow-expand', value: { state, historical: true,
      output: { bounded: false, profile: transport.profile, maxBytes: transport.maxBytes },
      canonicalPath: join(store.dir, `${previous.id}.json`), pagination: { offset, total: previous.elements.length, nextOffset: null as number | null },
      instruction: 'Canonical capture at source time; pagination may omit elements and hints remain in canonicalPath. Observe again before a new action.' } };
    for (const node of previous.elements.slice(offset, offset + limit)) {
      const { locator: _locator, ...evidence } = node;
      state.elements.push(evidence);
      if (Buffer.byteLength(JSON.stringify(expanded)) > transport.maxBytes - 100) { state.elements.pop(); break; }
    }
    const next = offset + state.elements.length;
    if (next < previous.elements.length) expanded.value.pagination.nextOffset = next;
    // An indivisible node or metadata can exceed transport; the artifact is authoritative.
    if (Buffer.byteLength(JSON.stringify(expanded)) > transport.maxBytes || (next === offset && next < previous.elements.length)) {
      return { success: true, type: 'workflow-expand', value: { historical: true, source: { id: previous.id, digest: previous.digest },
        output: { bounded: true, profile: transport.profile, maxBytes: transport.maxBytes },
        canonicalPath: expanded.value.canonicalPath, artifactRequired: true, instruction: 'Record exceeds transport budget; read canonicalPath without repeating an action.' } };
    }
    return expanded;
  }
  if (!['observe', 'act', 'screenshot'].includes(operation)) throw new Error('WORKFLOW_INVALID_OPERATION');
  let action: unknown;
  let current: PageState;
  let stale = false;
  let refusalCode: string | undefined;
  if (operation === 'act') {
    if (!previous) throw new Error('WORKFLOW_SOURCE_REQUIRED');
    let selector: string | undefined;
    try { selector = resolveWorkflowTarget(previous, options); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'WORKFLOW_TARGET_KEY_UNAVAILABLE: no action delivered') throw error;
      refusalCode = 'WORKFLOW_TARGET_KEY_UNAVAILABLE';
    }
    const args = refusalCode ? [] : actionArgs({ ...options, selector, targetKey: undefined });
    const before = await take(options.stabilityMs ?? 200, false, selector);
    if (refusalCode || previous.coverage.unstable || before.coverage.unstable || before.coverage.blockedByDialog || before.coverage.dialogProbeUnavailable ||
      semanticSignature(previous) !== semanticSignature(before)) {
      stale = true;
      current = before;
      action = { kind: options.action, ...(options.targetKey ? { targetKey: options.targetKey } : {}), actionDelivered: false, commandSucceeded: false, deliveryUnknown: false,
        code: refusalCode ?? 'WORKFLOW_STALE_SOURCE', instruction: 'No action delivered. Inspect the fresh view/source and reassess; do not blindly retry.' };
    } else {
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
      const unwitnessedClick = options.action === 'click' && result.rows.some(row =>
        row.data?.clickDelivered === null && row.data?.frameReached !== true);
      action = { kind: options.action, ...(options.targetKey ? { targetKey: options.targetKey } : {}), commandSucceeded: deliveryUnknown ? null : result.ok,
        deliveryUnknown: deliveryUnknown || unwitnessedClick, evidence: actionEvidence,
        instruction: result.ok ? 'Command delivery is not proof of the expected effect; check state and assertions.' :
          'A failed command or wait may follow a delivered interaction. Inspect recovered state; do not repeat the action blindly.' };
      try { current = await take(); }
      catch { return boundWorkflowResult({ success: false, type: 'workflow-action', value: { action, observationUnavailable: true,
        instruction: 'Observe to recover evidence; do not repeat the action blindly.' } }, join(store.dir, `${previous.id}-workflow-${randomUUID()}.json`), new Set(), transport); }
      }
  } else current = await take();
  const diffBase = previous?.captureProfile === current.captureProfile ? previous : (observedBefore?.captureProfile === current.captureProfile ? observedBefore : undefined);
  const diff = diffBase ? diffStates(diffBase, current) : undefined;
  const errors: Array<{ source: 'console' | 'network'; message: string }> = [];
  const diagnostics: Record<string, unknown> = { boundedLast: 100, console: 'unavailable', network: 'unavailable' };
  if (historyUnavailable) diagnostics.workflowHistory = 'unavailable';
  if (previous && previous.captureProfile !== current.captureProfile) diagnostics.workflowHistory = 'profile-mismatch';
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
  const projectionBlocked = options.full ? 'full-view' : historyUnavailable ? 'history-unavailable' :
    (observedBefore && observedBefore.captureProfile !== current.captureProfile) ? 'profile-mismatch' :
      current.coverage.unstable || current.coverage.truncated || current.coverage.unreachableFrames.length ||
      current.coverage.dialogProbeUnavailable || current.coverage.blockedByDialog || diff?.coverage.unstable || diff?.coverage.truncated ||
      diff?.coverage.unreachableFrames.length || diff?.coverage.dialogProbeUnavailable ||
      diff?.changes.some(change => change.kind === 'text-unmodelled') ? 'unsafe-coverage' : undefined;
  const projection = workflowProjectionConfiguration();
  const provider = projectionBlocked ? undefined : workflowProjectionProvider();
  const targets = options.targetKey ? [options.targetKey] : [];
  const view = await projectState(options.task, current, { prune: !options.full, hints: current.hints, diff, errors, provider, targets, protectVisibleActions: true });
  Object.assign(view, { providerReason: projectionReason(projectionBlocked, projection.reason, view.providerStatus) });
  diagnostics.projectionConfig = { reason: projection.reason, path: projection.path };
  let screenshot: unknown;
  if (operation === 'screenshot' || options.screenshot) {
    try {
      const directory = join(store.dir, 'evidence');
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}.png`);
      const result = await runCli(['screenshot', page.id, '--output', path, '--format', 'png', '--cdp-url', context.cdpUrl,
        ...(context.workspaceSessionName ? ['--session', context.workspaceSessionName] : [])]);
      screenshot = { available: result.ok, path: result.ok ? path : undefined, source: view.source, evidence: result.rows,
        semanticStable: result.ok ? semanticSignature(current, false) === semanticSignature(await take(0, false), false) : false };
    } catch {
      screenshot = { available: false, semanticStable: null, source: view.source,
        instruction: 'Screenshot or alignment capture failed; action/state evidence remains valid at its capture time. Recover pixels without repeating the action.' };
    }
  }
  const result = { success: !stale, type: stale ? (refusalCode ? 'workflow-target-rejection' : 'workflow-stale') : 'workflow-observation', value: { ...(action ? { action } : {}), view, diagnostics,
    canonicalPath: join(store.dir, `${current.id}.json`), ...(screenshot ? { screenshot } : {}) } };
  return boundWorkflowResult(result, join(store.dir, `${current.id}-workflow.json`), mustKeep(options.task, current, { hints: current.hints, diff, errors, targets, protectVisibleActions: true }), transport);
}
