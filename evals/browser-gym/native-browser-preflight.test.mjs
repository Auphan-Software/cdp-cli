import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualify } from './native-browser-preflight.mjs';

test('missing credentials do not make API requests', async () => {
  const result = await qualify({ tools: [], fetcher: () => { throw new Error('must not call'); } });
  assert.equal(result.reason, 'missing-api-credential');
  assert.equal(result.ready, false);
});

test('qualifies model and both real API tool schemas using token counting only', async () => {
  const calls = [];
  const result = await qualify({ key: 'test-not-a-real-key', tools: [{ name: 'observe' }],
    fetcher: async (url, request) => {
      calls.push({ url, request });
      const index = calls.length;
      return { ok: true, status: 200, json: async () => index === 1
        ? { id: 'claude-haiku-5-5' } : { input_tokens: [0, 40, 200, 6700][index - 1] } };
    } });
  assert.equal(result.ready, true);
  assert.deepEqual(result.tokenCounts, { promptOnly: 40, workflow: 200, nativeDefault: 6700,
    workflowOverhead: 160, nativeDefaultOverhead: 6660 });
  assert.equal(calls.length, 4);
  assert(calls.every(call => !call.url.endsWith('/messages')));
  assert.equal(JSON.parse(calls[3].request.body).tools[0].type, 'browser_toolset_20260801');
  assert(!JSON.stringify(result).includes('test-not-a-real-key'));
});

test('API rejection is retained without credential or server message leakage', async () => {
  const result = await qualify({ key: 'private-key', tools: [], fetcher: async () => ({
    ok: false, status: 401, json: async () => ({ error: { type: 'authentication_error', message: 'private-key' } }),
  }) });
  assert.equal(result.ready, false);
  assert.equal(result.requests[0].errorType, 'authentication_error');
  assert(!JSON.stringify(result).includes('private-key'));
});

test('a supported model with an unsupported native toolset cannot pass', async () => {
  let count = 0;
  const result = await qualify({ key: 'test', tools: [], fetcher: async () => {
    count++;
    return { ok: count !== 4, status: count === 4 ? 400 : 200,
      json: async () => count === 1 ? { id: 'claude-haiku-5-5' }
        : count === 4 ? { error: { type: 'invalid_request_error' } } : { input_tokens: 10 } };
  } });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'toolset-token-count-not-qualified');
  assert.equal(result.tokenCounts, undefined);
});
