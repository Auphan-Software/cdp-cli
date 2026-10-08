/** Stdio bridge for owned browser allocations; images use MCP image blocks. */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runCli } from './workflow.js';
import { workflowViewProfile } from './workflow-output.js';
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
  source: { type: 'string', description: 'view.source.id from the latest observation or action result, including fresh state after a no-delivery stale rejection; required for act/expand.' },
  frame: { type: 'string', description: 'Stable same-origin iframe selector; cross-origin targets use the existing target tools.' },
  full: { type: 'boolean', description: 'Expand the observation without deterministic pruning.' },
  screenshot: { type: 'boolean', description: 'Also return screenshot pixels; use only when visual evidence is needed.' },
  maxElements: { type: 'integer', minimum: 1, maximum: 10000, description: 'Canonical capture cap, not an output budget. Acts inherit their source cap.' },
  stabilityMs: { type: 'integer', minimum: 0, maximum: 5000 },
  offset: { type: 'integer', minimum: 0, maximum: 10000, description: 'Historical expand element offset; source-bound pagination.' },
  limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Historical expand maximum records; byte budget may return fewer.' },
  action: { type: 'string', enum: ['click', 'fill', 'select', 'press-key', 'navigate', 'back', 'forward', 'reload'] },
  selector: { type: 'string', description: 'CSS selector, mutually exclusive with targetKey.' },
  targetKey: { type: 'string', description: 'Exact element k from the source view; preferred for click/fill/select. Mutually exclusive with selector. Unsupported nested-frame/shadow targets require the existing target tools.' },
  value: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' },
  waitFor: { type: 'string', description: 'CSS selector wait armed with the action.' },
  waitForText: { type: 'string', description: 'Text wait; prefer selectors for asynchronously replaced pages.' }
};
const optionsByTool: Record<string, string[]> = {
  observe: ['task', 'source', 'frame', 'full', 'screenshot', 'maxElements', 'stabilityMs'],
  act: ['task', 'source', 'frame', 'full', 'screenshot', 'stabilityMs', 'action', 'selector', 'targetKey', 'value', 'url', 'key', 'waitFor', 'waitForText'],
  expand: ['task', 'source', 'offset', 'limit'],
  screenshot: ['task', 'source', 'frame', 'full', 'maxElements', 'stabilityMs']
};
const tools = Object.keys(optionsByTool).map(name => ({ name,
  description: name === 'act' ? 'Perform one bounded browser action and return fresh compact state, diff and diagnostic errors in the same call. Requires the last source ID. Never retry a possibly delivered action blindly.' :
    name === 'expand' ? 'Read the full canonical historical capture for a source ID; it is not a fresh observation.' :
    name === 'screenshot' ? 'Capture owned-page screenshot pixels and compact state together. Use for visual evidence, not every step.' :
    'Observe the inherited owned CDP page with protected evidence and optional configured relevance projection. Busy or unavailable providers retain the deterministic view.',
  inputSchema: { type: 'object', properties: Object.fromEntries(optionsByTool[name].map(key => [key, properties[key as keyof typeof properties]])), required: name === 'act' ? ['task', 'source', 'action'] : name === 'expand' ? ['task', 'source'] : ['task'], additionalProperties: false }
}));

export async function callWorkflowTool(name: string, args: Record<string, unknown>, executionBudget?: WorkflowExecutionBudget): Promise<unknown> {
  workflowViewProfile(); // Validate inherited transport settings before admission or child dispatch.
  if (!tools.some(tool => tool.name === name)) throw new Error('Unknown workflow tool');
  const page = process.env.CDP_PAGE?.trim(), session = process.env.CDP_SESSION?.trim();
  if (!page || !session) throw new Error('CDP_PAGE and CDP_SESSION must be inherited from the browser owner. Use existing CLI setup/preflight; this server never adopts or creates a page.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
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
    (name === 'act' && typeof args.action !== 'string')) throw new Error('Missing task/source/action');
  const budget = executionBudget ?? (directCallBudget ??= createWorkflowBudget());
  if (name === 'act') {
    const code = budget.admitAction();
    if (code) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, type: 'workflow-budget-rejection', value: {
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
  const content: unknown[] = result.rows.map(row => ({ type: 'text', text: JSON.stringify(row) }));
  const shot = result.rows[result.rows.length - 1]?.value?.screenshot;
  if (shot?.available && shot.path) {
    try {
      const bytes = readFileSync(shot.path);
      if (bytes.length > 10 * 1024 * 1024) content.push({ type: 'text', text: 'Image exceeds transport limit; use the saved artifact with the existing image reader.' });
      else content.push({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
    } catch { content.push({ type: 'text', text: 'Screenshot artifact could not be read. Preserve the action/state evidence above; request new screenshot evidence without repeating the action.' }); }
  }
  content.push(...budgetContent(budget));
  return { content, ...(result.ok ? {} : { isError: true }) };
}

export async function serveWorkflowMcp(): Promise<void> {
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
