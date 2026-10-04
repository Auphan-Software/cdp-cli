// Fixture-only stdio bridge. No filesystem, shell, arbitrary URL, or evaluation tool.
import { createInterface } from 'node:readline';
const url = new URL(process.argv[2]);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('LOOPBACK_REQUIRED');
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') {
      initialized = true;
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cdp-fixture', version: '1' } };
    } else if (message.method === 'ping') result = {};
    else if (initialized && ['tools/list', 'tools/call'].includes(message.method)) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-token': process.env.CDP_FIXTURE_TOKEN ?? '' },
        body: JSON.stringify({ method: message.method, params: message.params }), signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('FIXTURE_TOOL_FAILED');
      result = await response.json();
    } else throw new Error('UNSUPPORTED_METHOD');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch {
    if (message?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'FIXTURE_PROTOCOL_ERROR' } }) + '\n');
  }
}
