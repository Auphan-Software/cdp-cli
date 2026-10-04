import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, transcriptionIdle, validateRequest } from './service.mjs';

test('transcription admission fails closed for busy, missing and malformed monitor state', () => {
  const status = { status: 'ok', transcription_service_enabled: true, transcription_device: 'cuda', active_transcription_jobs: 0 };
  assert.equal(transcriptionIdle(status), true);
  for (const patch of [{ active_transcription_jobs: 1 }, { active_transcription_jobs: -1 }, { transcription_device: 'cpu' }, { status: 'error' }, { active_transcription_jobs: undefined }]) assert.equal(transcriptionIdle({ ...status, ...patch }), false);
  assert.equal(transcriptionIdle(undefined), false);
  assert.throws(() => validateRequest({ query: 'task', documents: Array(129).fill('x') }));
  assert.throws(() => validateRequest({ query: 'task', documents: ['x'.repeat(12001)] }));
});

test('gateway rejects parallel admission, yields between microbatches, and never returns partial rankings', async () => {
  let release; let active = true; let calls = 0;
  const server = createGateway({ config: { modelRevision: 'pinned', requestBudgetMs: 2000 }, ready: async () => true,
    gate: async () => ({ available: active, reason: 'transcription' }),
    rank: async body => { calls++; await new Promise(resolve => { release = resolve; }); return { results: body.documents.map((_, index) => ({ index, relevance_score: .5 })), usage: { prompt_tokens: 1 } }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/rerank`;
  const request = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'task', documents: Array(9).fill('evidence') }) });
  try {
    const first = request();
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await request()).status, 503);
    active = false; release();
    const response = await first;
    assert.equal(response.status, 503); assert.equal((await response.json()).results, undefined); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('service cache persists across requests, remaps reordered identities, and holds admission during worker drain', async () => {
  let calls = 0; let releaseDrain; let draining = false;
  const server = createGateway({ config: { modelRevision: 'model', runtimeRevision: 'runtime', requestBudgetMs: 2000 },
    ready: async () => true, gate: async () => ({ available: true }),
    rank: async body => { calls++; return { results: body.documents.map((d, index) => ({ index, relevance_score: d === 'A' ? .9 : .1 })), usage: { prompt_tokens: 10 } }; },
    drain: async () => { draining = true; await new Promise(resolve => { releaseDrain = resolve; }); draining = false; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = documents => fetch(`http://127.0.0.1:${server.address().port}/rerank`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'task', documents }) });
  try {
    assert.equal((await request(['A','B'])).status, 200);
    assert.equal(draining, true); assert.equal((await request(['A'])).status, 503);
    releaseDrain(); await new Promise(resolve => setTimeout(resolve, 5));
    const cached = await (await request(['B','A'])).json();
    assert.equal(calls, 1); assert.equal(cached.usage.prompt_tokens, 0);
    assert.deepEqual(cached.results, [{ index: 0, relevance_score: .1 }, { index: 1, relevance_score: .9 }]);
    assert.equal(cached.runtimeRevision, 'runtime');
  } finally { releaseDrain?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
