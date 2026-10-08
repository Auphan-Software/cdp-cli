/** Read-only API qualification. No model generation and no browser actions. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function workflowSchemas(cli) {
  const result = spawnSync(process.execPath, [cli, 'workflow-mcp'], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
    encoding: 'utf8', timeout: 15000, maxBuffer: 1000000,
  });
  if (result.error || result.status !== 0) throw new Error('Workflow schema capture failed');
  const reply = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    .find(row => row.id === 1);
  if (!Array.isArray(reply?.result?.tools) || reply.result.tools.length !== 4)
    throw new Error('Expected four workflow tools');
  return reply.result.tools.map(tool => ({ name: tool.name,
    description: tool.description, input_schema: tool.inputSchema }));
}

export async function qualify({ key, tools, fetcher = fetch }) {
  const model = 'claude-haiku-5-5';
  const scope = 'read-only model and token-count qualification; not a performance benchmark';
  if (!key) return { model, scope, ready: false, reason: 'missing-api-credential', requests: [] };
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01',
    'content-type': 'application/json' };
  const requests = [];
  async function request(path, body) {
    const response = await fetcher('https://api.anthropic.com/v1/' + path, {
      method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    });
    // Never persist headers, credentials or server error text.
    const data = await response.json();
    const receipt = { endpoint: path, status: response.status, ok: response.ok };
    if (!response.ok) receipt.errorType = typeof data.error?.type === 'string' ? data.error.type : 'unknown';
    requests.push(receipt);
    return { ok: response.ok, data };
  }
  try {
    const identity = await request('models/' + model);
    if (!identity.ok || identity.data.id !== model)
      return { model, scope, ready: false, reason: 'model-not-qualified', requests };
    const common = { model, system: 'Complete the assigned browser journey and verify it. Stop when done.',
      messages: [{ role: 'user', content: 'Complete one fresh Pepsi cash invoice and preserve evidence.' }] };
    const baseline = await request('messages/count_tokens', common);
    const current = await request('messages/count_tokens', { ...common, tools });
    const native = await request('messages/count_tokens', { ...common,
      tools: [{ type: 'browser_toolset_20260801' }] });
    const counts = [baseline, current, native].map(row => row.data.input_tokens);
    const ready = [baseline, current, native].every(row => row.ok) &&
      counts.every(count => Number.isSafeInteger(count) && count >= 0);
    return { model, scope, ready, requests, ...(ready ? { tokenCounts: {
      promptOnly: counts[0], workflow: counts[1], nativeDefault: counts[2],
      workflowOverhead: counts[1] - counts[0], nativeDefaultOverhead: counts[2] - counts[0],
    } } : { reason: 'toolset-token-count-not-qualified' }) };
  } catch {
    return { model, scope, ready: false, reason: 'request-failed', requests };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [cli, output] = process.argv.slice(2);
    if (!cli || !output) throw new Error('Usage: native-browser-preflight.mjs PINNED_CLI OUTPUT_JSON');
    const schemas = workflowSchemas(resolve(cli));
    const report = await qualify({ key: process.env.ANTHROPIC_API_KEY, tools: schemas });
    report.cli = resolve(cli);
    report.buildIdentity = JSON.parse(readFileSync(resolve(cli, '..', 'build-info.json'), 'utf8'));
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ready: report.ready, reason: report.reason, output }));
    process.exitCode = report.ready ? 0 : 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
