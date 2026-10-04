/** Stdio bridge for owned browser allocations; images use MCP image blocks. */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { runCli } from './workflow.js';
import { version } from './version.js';

const properties = {
  task: { type: 'string', description: 'Current reproduction or evidence goal, not the full coding conversation.' },
  source: { type: 'string', description: 'view.source.id from the last observation; required for act/expand.' },
  frame: { type: 'string', description: 'Stable same-origin iframe selector; cross-origin targets use the existing target tools.' },
  full: { type: 'boolean', description: 'Expand the observation without deterministic pruning.' },
  screenshot: { type: 'boolean', description: 'Also return screenshot pixels; use only when visual evidence is needed.' },
  maxElements: { type: 'integer', minimum: 1, maximum: 10000 },
  stabilityMs: { type: 'integer', minimum: 0, maximum: 5000 },
  action: { type: 'string', enum: ['click', 'fill', 'select', 'press-key', 'navigate', 'back', 'forward', 'reload'] },
  selector: { type: 'string' }, value: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' },
  waitFor: { type: 'string', description: 'CSS selector wait armed with the action.' },
  waitForText: { type: 'string', description: 'Text wait; prefer selectors for asynchronously replaced pages.' }
};
const tools = ['observe', 'act', 'expand', 'screenshot'].map(name => ({ name,
  description: name === 'act' ? 'Perform one bounded browser action and return fresh compact state, diff and diagnostic errors in the same call. Requires the last source ID. Never retry a possibly delivered action blindly.' :
    name === 'expand' ? 'Read the full canonical historical capture for a source ID; it is not a fresh observation.' :
    name === 'screenshot' ? 'Capture owned-page screenshot pixels and compact state together. Use for visual evidence, not every step.' :
    'Observe the inherited owned CDP page with deterministic pruning and protected evidence. No local or paid model runs.',
  inputSchema: { type: 'object', properties, required: name === 'act' ? ['task', 'source', 'action'] : name === 'expand' ? ['task', 'source'] : ['task'], additionalProperties: false }
}));

export async function callWorkflowTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!tools.some(tool => tool.name === name)) throw new Error('Unknown workflow tool');
  const page = process.env.CDP_PAGE?.trim(), session = process.env.CDP_SESSION?.trim();
  if (!page || !session) throw new Error('CDP_PAGE and CDP_SESSION must be inherited from the browser owner. Use existing CLI setup/preflight; this server never adopts or creates a page.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
  const command = ['workflow', name, page];
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) throw new Error(`Unknown option: ${key}`);
    const property = properties[key as keyof typeof properties];
    if ((property.type === 'integer' && (!Number.isSafeInteger(value) || (value as number) < (property as any).minimum || (value as number) > (property as any).maximum)) ||
      (property.type !== 'integer' && typeof value !== property.type) || (typeof value === 'string' && (value.length > 8000 || value.includes('\0')))) throw new Error(`Invalid option: ${key}`);
    const flag = '--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    if (typeof value === 'boolean') command.push(value ? flag : '--no-' + flag.slice(2));
    else command.push(flag, String(value));
  }
  if (typeof args.task !== 'string' || !args.task.trim() || ((name === 'act' || name === 'expand') && typeof args.source !== 'string')) throw new Error('Missing task/source');
  command.push('--session', session, '--cdp-url', process.env.CDP_URL || 'http://localhost:9222');
  const result = await runCli(command);
  const content: unknown[] = result.rows.map(row => ({ type: 'text', text: JSON.stringify(row) }));
  const shot = result.rows[result.rows.length - 1]?.value?.screenshot;
  if (shot?.available && shot.path) {
    try {
      const bytes = readFileSync(shot.path);
      if (bytes.length > 10 * 1024 * 1024) content.push({ type: 'text', text: 'Image exceeds transport limit; use the saved artifact with the existing image reader.' });
      else content.push({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
    } catch { content.push({ type: 'text', text: 'Screenshot artifact could not be read. Preserve the action/state evidence above; request new screenshot evidence without repeating the action.' }); }
  }
  return { content, ...(result.ok ? {} : { isError: true }) };
}

export async function serveWorkflowMcp(): Promise<void> {
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
        try { result = await callWorkflowTool(request.params?.name, request.params?.arguments ?? {}); }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: (error as Error).message }] }; }
      } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Internal error' } }) + '\n'); }
  }
}
