/** Stdio bridge for owned browser allocations; images use MCP image blocks. */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runCli } from './workflow.js';
import { workflowViewProfile } from './workflow-output.js';
import { workflowReceipt } from './workflow-receipt.js';
import { version } from './version.js';

export interface WorkflowExecutionBudget {
  admitAction(): 'WORKFLOW_ACTION_BUDGET_EXHAUSTED' | 'WORKFLOW_DEADLINE_EXCEEDED' | undefined;
  snapshot(): { enabled: boolean; maxActions: number | null; actionsUsed: number; actionsRemaining: number | null;
    deadlineMs: number | null; elapsedMs: number; remainingMs: number | null; exhausted: boolean;
    counting: 'admitted-act-requests'; enforcement: 'before-action-command' };
}

/** One policy per bridge process. Unknown/failed delivery never refunds an action. */
export function createWorkflowBudget(env: NodeJS.ProcessEnv = process.env, now = () => performance.now()): WorkflowExecutionBudget {
  const read = (name: string): number | null => {
    const raw = env[name];
    if (raw === undefined) return null;
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0) {
      throw new Error(`WORKFLOW_INVALID_BUDGET_CONFIGURATION: ${name} must be a nonnegative safe integer`);
    }
    return Number(raw);
  };
  const maxActions = read('CDP_WORKFLOW_MAX_ACTIONS'), deadlineMs = read('CDP_WORKFLOW_DEADLINE_MS');
  const started = now();
  let actionsUsed = 0;
  const snapshot = () => {
    const elapsed = Math.max(0, now() - started);
    const actionsRemaining = maxActions === null ? null : Math.max(0, maxActions - actionsUsed);
    const remainingMs = deadlineMs === null ? null : Math.max(0, Math.ceil(deadlineMs - elapsed));
    return { enabled: maxActions !== null || deadlineMs !== null, maxActions, actionsUsed, actionsRemaining,
      deadlineMs, elapsedMs: Math.floor(elapsed), remainingMs,
      exhausted: actionsRemaining === 0 || (deadlineMs !== null && elapsed >= deadlineMs),
      counting: 'admitted-act-requests' as const, enforcement: 'before-action-command' as const };
  };
  return { snapshot, admitAction: () => {
    if (maxActions !== null && actionsUsed >= maxActions) return 'WORKFLOW_ACTION_BUDGET_EXHAUSTED';
    if (deadlineMs !== null && now() - started >= deadlineMs) return 'WORKFLOW_DEADLINE_EXCEEDED';
    actionsUsed++;
    return undefined;
  } };
}

let directCallBudget: WorkflowExecutionBudget | undefined;
function budgetContent(budget: WorkflowExecutionBudget): Array<{ type: 'text'; text: string }> {
  const status = budget.snapshot();
  return status.enabled ? [{ type: 'text', text: JSON.stringify({ type: 'workflow-execution-budget', value: status }) }] : [];
}

const properties = {
  task: { type: 'string', description: 'Current reproduction or evidence goal, not the full coding conversation.' },
  screenshotScale: { type: 'number', minimum: 0.1, maximum: 1, description: 'Raster pixel scale only (default1). Original same-capture pixels are retained. Reduced text may require scale1 evidence; viewport/action coordinates do not change.' },
  source: { type: 'string', description: 'view.source.id from the latest observation or action result, including fresh state after a no-delivery stale rejection; required for act/expand.' },
  frame: { type: 'string', description: 'Stable same-origin iframe selector; cross-origin targets use the existing target tools.' },
  full: { type: 'boolean', description: 'Explicit rich state/diff/diagnostic result. Default actions and screenshots return short receipts. Use expand for complete historical evidence.' },
  screenshot: { type: 'boolean', description: 'Also return screenshot pixels; use only when visual evidence is needed.' },
  maxElements: { type: 'integer', minimum: 1, maximum: 10000, description: 'Canonical capture cap, not an output budget. Acts inherit their source cap.' },
  stabilityMs: { type: 'integer', minimum: 0, maximum: 5000 },
  offset: { type: 'integer', minimum: 0, maximum: 50000000, description: 'Historical element/record offset, or Unicode codepoint offset for artifact fragments; source-bound pagination.' },
  limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Historical expand maximum records; byte budget may return fewer.' },
  section: { type: 'string', enum: ['elements', 'receipt', 'errors', 'changes', 'coverage', 'artifact'], description: 'Historical evidence section. receipt includes delivery/witness and diagnostics. artifact returns paginated Unicode JSON fragments for oversized records. Available without file tools.' },
  receiptId: { type: 'string', description: 'Optional recovery.receiptId for an action whose post-action observation failed. Source remains recovery.source; this retrieves delivery evidence only.' },
  action: { type: 'string', enum: ['click', 'fill', 'select', 'press-key', 'navigate', 'back', 'forward', 'reload'] },
  selector: { type: 'string', description: 'CSS selector, mutually exclusive with targetKey.' },
  targetKey: { type: 'string', description: 'Exact element k from the source view; preferred for click/fill/select. Mutually exclusive with selector. Unsupported nested-frame/shadow targets require the existing target tools.' },
  value: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' },
  waitFor: { type: 'string', description: 'CSS selector wait armed with the action.' },
  waitForText: { type: 'string', description: 'Text wait; prefer selectors for asynchronously replaced pages.' }
};
const optionsByTool: Record<string, string[]> = {
  observe: ['task', 'source', 'frame', 'full', 'screenshot', 'screenshotScale', 'maxElements', 'stabilityMs'],
  act: ['task', 'source', 'frame', 'full', 'screenshot', 'screenshotScale', 'stabilityMs', 'action', 'selector', 'targetKey', 'value', 'url', 'key', 'waitFor', 'waitForText'],
  expand: ['task', 'source', 'offset', 'limit', 'section', 'receiptId'],
  screenshot: ['task', 'source', 'frame', 'full', 'screenshotScale', 'maxElements', 'stabilityMs']
};
const tools = Object.keys(optionsByTool).map(name => ({ name,
  description: name === 'act' ? 'Perform one bounded action; return a short delivery/witness receipt and fresh view.source.id. No unsolicited state dump. Observe for controls, expand for historical errors/changes/receipt, full:true for rich output. Command success is not task proof; never retry uncertain delivery.' :
    name === 'expand' ? 'Read source-bound historical elements or receipt/errors/changes/coverage evidence. It is not a fresh observation. Use for required omitted evidence.' :
    name === 'screenshot' ? 'Return owned-page pixels and alignment metadata without a state dump. Use view.source.id next. Full evidence remains available through expand; semanticStable:false is uncertain alignment.' :
    'Observe the owned page. Unnamed controls include captured CSS viewport boxes for matching pixels; use their source-bound keys to act.',
  inputSchema: { type: 'object', properties: Object.fromEntries(optionsByTool[name].map(key => [key, properties[key as keyof typeof properties]])), required: name === 'act' ? ['task', 'source', 'action'] : name === 'expand' ? ['task', 'source'] : ['task'], additionalProperties: false }
}));

export async function callWorkflowTool(name: string, args: Record<string, unknown>, executionBudget?: WorkflowExecutionBudget): Promise<unknown> {
  const profile = workflowViewProfile(); // Validate inherited transport settings before admission or child dispatch.
  if (!tools.some(tool => tool.name === name)) throw new Error('Unknown workflow tool');
  const page = process.env.CDP_PAGE?.trim(), session = process.env.CDP_SESSION?.trim();
  if (!page || !session) throw new Error('CDP_PAGE and CDP_SESSION must be inherited from the browser owner. Use existing CLI setup/preflight; this server never adopts or creates a page.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
  const budget = executionBudget ?? (directCallBudget ??= createWorkflowBudget());
  let rejection: string | undefined;
  if (args.query !== undefined) {
    rejection = 'WORKFLOW_QUERY_RETIRED';
  }
  if (args.screenshotScale !== undefined && (typeof args.screenshotScale !== 'number' || !Number.isFinite(args.screenshotScale) || args.screenshotScale < 0.1 || args.screenshotScale > 1))
    rejection = 'WORKFLOW_INVALID_SCREENSHOT_SCALE';
  if (rejection) return { content: [{ type: 'text', text: JSON.stringify({ success: false, type: 'workflow-input-rejection', value: {
    rejection: { code: rejection, stage: 'input-validation', commandDispatched: false },
    output: { bounded: false, profile: profile.profile, maxBytes: profile.maxBytes },
    instruction: 'No dispatch; budget unchanged. Omit retired query. screenshotScale must be finite 0.1..1. Reuse current source; do not repeat delivered actions.'
  } }) }, ...budgetContent(budget)] };
  const command = ['workflow', name, page];
  for (const [key, value] of Object.entries(args)) {
    if (!optionsByTool[name].includes(key)) throw new Error(`Unknown option for ${name}: ${key}. Acts inherit the canonical capture settings from their source.`);
    const property = properties[key as keyof typeof properties];
    if ((property.type === 'integer' && (!Number.isSafeInteger(value) || (value as number) < (property as any).minimum || (value as number) > (property as any).maximum)) ||
      (property.type !== 'integer' && typeof value !== property.type) || (typeof value === 'string' && (value.length > 8000 || value.includes('\0')))) throw new Error(`Invalid option: ${key}`);
    if ('enum' in property && !(property.enum as readonly unknown[]).includes(value)) throw new Error(`Invalid option: ${key}`);
    if (['waitFor', 'waitForText'].includes(key) && !(value as string).trim()) throw new Error(`Invalid empty wait: ${key}`);
    const flag = '--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    if (typeof value === 'boolean') command.push(value ? flag : '--no-' + flag.slice(2));
    else command.push(flag, String(value));
  }
  if (typeof args.task !== 'string' || !args.task.trim() || ((name === 'act' || name === 'expand') && (typeof args.source !== 'string' || !args.source.trim())) ||
    (name === 'act' && typeof args.action !== 'string')) return { content: [{ type: 'text', text: JSON.stringify({ success: false,
      type: 'workflow-input-rejection', value: {
        rejection: { code: 'WORKFLOW_MISSING_ARGUMENTS', stage: 'input-validation', commandDispatched: false },
        output: { bounded: false, profile: profile.profile, maxBytes: profile.maxBytes },
        instruction: 'No browser command dispatched. Supply a nonempty task, plus source and action for act or source for expand. Reuse valid current state; do not repeat a delivered action.'
      } }) }, ...budgetContent(budget)] };
  if (name === 'act') {
    const code = budget.admitAction();
    if (code) return { content: [{ type: 'text', text: JSON.stringify({ success: false, type: 'workflow-budget-rejection', value: {
      action: { kind: args.action, code, actionDelivered: false, commandSucceeded: false, deliveryUnknown: false },
      instruction: 'No action dispatched: the session execution budget is exhausted. Observe or expand to recover evidence; do not repeat previously delivered actions.'
    } }) }, ...budgetContent(budget)] };
  }
  command.push('--session', session, '--cdp-url', process.env.CDP_URL || 'http://localhost:9222');
  let result: Awaited<ReturnType<typeof runCli>>;
  try { result = await runCli(command); }
  catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, type: 'workflow-command-failed', value: {
      ...(name === 'act' ? { action: { kind: args.action, commandSucceeded: null, deliveryUnknown: true } } : {}),
      message: (error as Error).message,
      instruction: name === 'act' ? 'Command transport failed after admission; delivery may be unknown. Observe to recover evidence; do not repeat the action blindly.' : 'Recover observation evidence without repeating an action.'
    } }) }, ...budgetContent(budget)] };
  }
  const content: unknown[] = result.rows.map(row => ({ type: 'text', text: JSON.stringify(workflowReceipt(row, name, args.full === true)) }));
  const shot = result.rows[result.rows.length - 1]?.value?.screenshot;
  if (shot?.available && shot.path) {
    try {
      const bytes = readFileSync(shot.path);
      if (bytes.length > 10 * 1024 * 1024) content.push({ type: 'text', text: 'Image exceeds transport limit; use the saved artifact with the existing image reader.' });
      else content.push({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
    } catch { content.push({ type: 'text', text: 'Screenshot artifact could not be read. Preserve the action/state evidence above; request new screenshot evidence without repeating the action.' }); }
  }
  content.push(...budgetContent(budget));
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  const action = row?.value?.action;
  // Expected no-dispatch outcomes carry current recovery state. Claude truncates
  // MCP errors independently of our view budget, destroying that receipt's JSON.
  // Keep unexpected failures as MCP errors; a stale refusal remains success:false.
  const recoverableStale = row?.type === 'workflow-stale' && row.success === false &&
    action?.code === 'WORKFLOW_STALE_SOURCE' && action.actionDelivered === false &&
    action.commandSucceeded === false && action.deliveryUnknown === false;
  const recoverableTarget = row?.type === 'workflow-target-rejection' && row.success === false &&
    action?.code === 'WORKFLOW_TARGET_KEY_UNAVAILABLE' && action.actionDelivered === false &&
    action.commandSucceeded === false && action.deliveryUnknown === false && !!row.value.view?.source?.id;
  return { content, ...(result.ok || recoverableStale || recoverableTarget ? {} : { isError: true }) };
}

export async function serveWorkflowMcp(): Promise<void> {
  // Agent bridges use the measured compact transport unless the owner explicitly
  // selects another profile. Keep the composable CLI's default unchanged.
  process.env.CDP_WORKFLOW_VIEW_PROFILE ??= 'haiku-compact';
  const budget = createWorkflowBudget();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Serializing requests preserves browser ownership and action/observation order.
  for await (const line of input) {
    let request: any;
    try { if (line.length > 1000000) throw new Error('Request too large'); request = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON request' } }) + '\n'); continue; }
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }) + '\n'); continue;
    }
    if (request.id === undefined) continue;
    let result: unknown;
    try {
      if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cdp-workflow', version } };
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/call') {
        try { result = await callWorkflowTool(request.params?.name, request.params?.arguments ?? {}, budget); }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: (error as Error).message }, ...budgetContent(budget)] }; }
      } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Internal error' } }) + '\n'); }
  }
}
