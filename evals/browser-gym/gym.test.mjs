import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { auditNative, readiness, scoreRun, summarizeTrials, verifiedOutcome } from './gym.mjs';

const record = (id, usage, model = 'claude-haiku-5-5', content = []) => JSON.stringify({
  type: 'assistant', timestamp: '2026-10-07T20:00:00Z', message: { id, model, usage, content },
});
const usage = (fresh, write, read, output) => ({ input_tokens: fresh, cache_creation_input_tokens: write,
  cache_read_input_tokens: read, output_tokens: output });
const ready = { candidate: 'abc123', fixtureFingerprint: 'seed1', model: 'claude-haiku-5-5',
  toolCommit: '6b1223e', caseId: 'cash-pepsi', profileImplemented: true, fixtureReady: true,
  loginProven: true, cashierRoleProven: true, spaBootProven: true, rqDevProven: true,
  receiptCaptureProven: true, exclusiveBrowserProven: true, verifierReady: true, stopBudgetEnforced: true,
  skill: { canonical: 'canonical', installed: 'installed' } };
const contract = { id: 'cash-pepsi', requiredChecks: ['totals', 'bill'] };
const proof = { verifier: 'independent', caseId: 'cash-pepsi', candidate: 'abc123', fixtureFingerprint: 'seed1',
  checks: [{ id: 'totals', passed: true, artifacts: ['db.json'] }, { id: 'bill', passed: true, artifacts: ['bill.png'] }] };

test('typed input rejection preserves the source chain without inventing an observation', () => {
  const receipt = { success: false, type: 'workflow-input-rejection', value: {
    rejection: { code: 'WORKFLOW_MISSING_ARGUMENTS', stage: 'input-validation', commandDispatched: false }, output: { profile: 'current-24k' }
  } };
  const trace = rejection => [record('one', usage(1, 0, 0, 1), 'claude-haiku-5-5', [
    { type: 'tool_use', id: 'o', name: 'mcp__cdp-workflow__observe', input: { task: 'read' } },
    { type: 'tool_use', id: 'bad', name: 'mcp__cdp-workflow__act', input: {} },
    { type: 'tool_use', id: 'a', name: 'mcp__cdp-workflow__act', input: { source: 's1' } }
  ]), JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'o', content: JSON.stringify({ type: 'workflow-observation', value: { view: { source: { id: 's1' } }, output: { profile: 'current-24k' } } }) },
    { type: 'tool_result', tool_use_id: 'bad', content: JSON.stringify(rejection) },
    { type: 'tool_result', tool_use_id: 'a', content: JSON.stringify({ type: 'workflow-observation', value: { view: { source: { id: 's2' } }, output: { profile: 'current-24k' } } }) }
  ] } })].join('\n');
  const good = auditNative(trace(receipt));
  assert.equal(good.unavailableReceipts, 0);
  assert.equal(good.chainMismatches, 0);
  assert.equal(good.workflow[1].returnedSource, undefined);
  assert.equal(good.workflow[1].inputRejected, true);
  receipt.value.rejection.commandDispatched = true;
  const bad = auditNative(trace(receipt));
  assert.equal(bad.unavailableReceipts, 1);
  assert.ok(bad.chainMismatches > 0);
  receipt.value.rejection.commandDispatched = false;
  for (const extra of [{ view: { source: { id: 'forged' } } }, { action: { actionDelivered: true } }]) {
    assert.equal(auditNative(trace({ ...receipt, value: { ...receipt.value, ...extra } })).unavailableReceipts, 1);
  }
  const validRequest = trace(receipt).replace('"input":{}', '"input":{"task":"click","source":"wrong","action":"click"}');
  const disguised = auditNative(validRequest);
  assert.equal(disguised.unavailableReceipts, 1);
  assert.ok(disguised.chainMismatches > 0);
});

test('host-offloaded MCP result retains source chain and declared profile only through pinned controller artifact', () => {
  const sessionId = '684c056f-9765-4d3c-b461-e937cec65401';
  const originalPath = `C:/Users/example/.claude/projects/project/${sessionId}/tool-results/mcp-cdp-workflow-act-123.txt`;
  const blocks = [{ type: 'text', text: JSON.stringify({ type: 'workflow-observation', value: {
    action: { commandSucceeded: true }, view: { source: { id: 's2' } }, output: { profile: 'rich-64k' } } }) }];
  const bytes = Buffer.from(JSON.stringify(blocks));
  const entry = { originalPath, path: resolve('preserved/result.txt'), sha256: createHash('sha256').update(bytes).digest('hex') };
  const trace = [JSON.stringify({ type: 'assistant', sessionId, message: { id: 'one', model: 'claude-haiku-5-5', usage: usage(1, 0, 0, 1), content: [
    { type: 'tool_use', id: 'o', name: 'mcp__cdp-workflow__observe', input: {} },
    { type: 'tool_use', id: 'a', name: 'mcp__cdp-workflow__act', input: { source: 's1' } },
    { type: 'tool_use', id: 'b', name: 'mcp__cdp-workflow__act', input: { source: 's2' } } ] } }),
    JSON.stringify({ type: 'user', sessionId, message: { content: [
      { type: 'tool_result', tool_use_id: 'o', content: [{ type: 'text', text: JSON.stringify({ type: 'workflow-observation', value: { view: { source: { id: 's1' } } } }) }] },
      { type: 'tool_result', tool_use_id: 'a', content: `Error: result (74,433 characters) exceeds maximum allowed tokens. Output has been saved to ${originalPath}.\nFormat: JSON array with schema: [{type: string, text: string}]` },
      { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: JSON.stringify({ type: 'workflow-observation', value: { view: { source: { id: 's3' } } } }) }] } ] } }) ].join('\n');
  const good = auditNative(trace, { persistedResults: [entry], read: () => bytes });
  assert.equal(good.chainMismatches, 0);
  assert.equal(good.offloadedResults, 1);
  assert.equal(good.unavailableReceipts, 0);
  assert.equal(good.workflow[1].omissions.profile, 'rich-64k');
  assert.equal(good.workflow[1].persistedArtifact.sha256, entry.sha256);
  let reads = 0;
  for (const entries of [[], [{ ...entry, originalPath: originalPath.replace(sessionId, 'other') }]]) {
    const missing = auditNative(trace, { persistedResults: entries, read: () => { reads++; return bytes; } });
    assert.equal(missing.unavailableReceipts, 1);
    assert.equal(missing.chainUnavailable, 1);
  }
  assert.equal(reads, 0);
  assert.throws(() => auditNative(trace, { persistedResults: [entry], read: () => Buffer.from('changed') }), /hash changed/);
});

test('streamed assistant records count once using maximum reported components', () => {
  const a = auditNative([record('one', usage(10, 20, 30, 2)), record('one', usage(10, 20, 30, 8))].join('\n'));
  assert.equal(a.processedTokens, 68);
  assert.equal(a.usage.output_tokens, 8);
  assert.equal(a.peakInputTokens, 60);
});
test('Haiku 100k threshold is per request and includes cache reads', () => {
  const low = auditNative(record('one', usage(1, 0, 99_999, 0)));
  const high = auditNative(record('one', usage(1, 0, 100_000, 0)));
  assert.equal(low.longContextRequests, 0);
  assert.equal(high.longContextRequests, 1);
  assert.ok(high.estimatedApiUsd > low.estimatedApiUsd * 4.99);
  const two = auditNative([record('one', usage(0, 0, 60_000, 0)), record('two', usage(0, 0, 60_000, 0))].join('\n'));
  assert.equal(two.longContextRequests, 0);
});
test('one-hour cache writes cost 2x input, not 1.25x', () => {
  const a = auditNative(record('one', { ...usage(0, 100, 0, 0), cache_creation: { ephemeral_1h_input_tokens: 100 } }));
  assert.equal(a.estimatedApiUsd, 0.00002);
  assert.equal(a.warnings.length, 0);
});
test('unknown cache TTL is explicitly estimated; unknown model cannot silently cost zero', () => {
  assert.ok(auditNative(record('one', usage(0, 100, 0, 0))).warnings.length);
  assert.equal(auditNative(record('one', usage(1, 0, 0, 0), 'unknown')).estimatedApiUsd, null);
});

test('iteration exports cannot silently lose fresh input or output from top-level counters', () => {
  for (const field of ['input_tokens', 'output_tokens']) {
    const counters = usage(0, 0, 0, 0); counters[field] = 100;
    const a = auditNative(record('one', { ...counters, iterations: [{ type: 'message', ...usage(1, 0, 0, 1) }] }));
    assert.equal(a.estimatedApiUsd, null);
    assert.ok(a.warnings.some(w => w.includes('attribution')));
  }
});

test('host-truncated error fragments do not manufacture a source or a transport attestation', () => {
  const tools = [{ type: 'tool_use', id: 'one', name: 'mcp__cdp-workflow__act', input: { source: 'old' } },
    { type: 'tool_use', id: 'two', name: 'mcp__cdp-workflow__act', input: { source: 'new' } }];
  const error = '{"type":"workflow-stale","value":{"view":{"source":{"id":"new"}},\n\n... [13671 characters truncated] ...\n\n"output":{"profile":"current-24k"}}}\n' +
    JSON.stringify({ type: 'workflow-execution-budget', value: { actionsUsed: 1 } });
  const a = auditNative([record('one', usage(1, 0, 0, 1), 'claude-haiku-5-5', tools),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: error }] } })].join('\n'));
  assert.equal(a.truncatedResults, 1);
  assert.equal(a.chainMismatches, 0);
  assert.equal(a.chainUnavailable, 2);
  assert.equal(a.workflow[0].returnedSource, undefined);
  assert.equal(a.workflow[0].omissions, undefined);
  assert.deepEqual(a.workflow[0].executionBudgets, [{ actionsUsed: 1 }]);
});
test('malformed transcript and invalid usage fail rather than undercount', () => {
  assert.throws(() => auditNative('{truncated'));
  assert.throws(() => auditNative(record('one', usage(-1, 0, 0, 0))));
});
test('counts real compaction boundary records without treating tool pruning as compaction', () => {
  const row = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'compact1' });
  assert.equal(auditNative([row, row, record('one', usage(1, 0, 0, 0))].join('\n')).compactionBoundaries, 1);
});
test('readiness rejects missing login, receipt capture, stop enforcement and skill drift', () => {
  const missing = readiness({ ...ready, loginProven: false, receiptCaptureProven: false, stopBudgetEnforced: false }, () => true, () => 'same');
  assert.equal(missing.ready, false);
  assert.equal(missing.blockers.length, 3);
  assert.equal(readiness(ready, () => true, path => path).ready, false);
  assert.equal(readiness(ready, () => true, () => 'same').ready, true);
});
test('planned rich profile cannot be mistaken for implemented behavior', () => {
  assert.equal(readiness({ ...ready, profileImplemented: false }, () => true, () => 'same').ready, false);
});
test('worker PASS cannot replace independent evidence; missing bill is a failure', () => {
  assert.equal(verifiedOutcome(contract, proof, () => true), true);
  assert.equal(verifiedOutcome(contract, { ...proof, verifier: 'worker' }, () => true), false);
  assert.equal(verifiedOutcome(contract, proof, path => path !== 'bill.png'), false);
  assert.equal(verifiedOutcome(contract, { ...proof, checks: proof.checks.slice(0, 1) }, () => true), false);
});
test('failure costs and false passes stay in cost per verified success', () => {
  const summary = summarizeTrials([
    { model: 'haiku', profile: 'compact', verified: true, estimatedApiUsd: 0.1 },
    { model: 'haiku', profile: 'compact', verified: false, workerClaimedPass: true, estimatedApiUsd: 0.2 },
  ])[0];
  assert.ok(Math.abs(summary.costPerVerifiedSuccess - 0.3) < 1e-9);
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.falsePasses, 1);
  assert.equal(summarizeTrials([{ model: 'haiku', profile: 'compact', verified: false, estimatedApiUsd: 1 }])[0].costPerVerifiedSuccess, null);
});
test('missing cost does not fabricate a cheaper group', () => {
  assert.equal(summarizeTrials([{ model: 'haiku', profile: 'compact', verified: true, estimatedApiUsd: null }])[0].costPerVerifiedSuccess, null);
});
test('score includes supervisor cost but pins the worker actual model independently', () => {
  const run = { model: 'claude-haiku-5-5', profile: 'current-24k', caseId: 'cash-pepsi',
    candidate: 'abc123', fixtureFingerprint: 'seed1', proof,
    transcripts: [{ path: 'worker', role: 'worker', model: 'claude-haiku-5-5' },
      { path: 'parent', role: 'supervisor', model: 'claude-sonnet-5-5' }] };
  const read = path => record('one', usage(10, 0, 0, 10), path === 'parent' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5');
  const scored = scoreRun(run, { cases: [contract] }, read, () => true);
  assert.equal(scored.verified, true);
  assert.ok(scored.estimatedApiUsd > scored.audits[0].estimatedApiUsd);
  assert.equal(scoreRun({ ...run, candidate: 'other' }, { cases: [contract] }, read, () => true).verified, false);
  assert.equal(scoreRun(run, { cases: [contract] }, () => record('one', usage(10, 0, 0, 10), 'claude-sonnet-5-5'), () => true).verified, false);
});
test('CLI example readiness fails with exit 2 before any model can be launched', () => {
  const child = spawnSync(process.execPath, ['evals/browser-gym/gym.mjs', 'preflight', 'evals/browser-gym/fixture.example.json'], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stdout).ready, false);
});
test('stale recovery source is usable and missing sources are counted as mismatches', () => {
  const tool = (id, name, input) => ({ type: 'tool_use', id, name: `mcp__cdp-workflow__${name}`, input });
  const result = (id, source, action) => JSON.stringify({ type: 'user', message: { content: [{
    type: 'tool_result', tool_use_id: id, content: JSON.stringify({ type: action ? 'workflow-stale' : 'workflow-observation', value: { view: { source: { id: source } }, action } }),
  }] } });
  const rows = [
    record('one', usage(0, 0, 0, 0), 'claude-haiku-5-5', [tool('o', 'observe', {})]), result('o', 'old'),
    record('two', usage(0, 0, 0, 0), 'claude-haiku-5-5', [tool('a', 'act', { source: 'old' })]),
    result('a', 'fresh', { code: 'WORKFLOW_STALE_SOURCE', actionDelivered: false }),
    record('three', usage(0, 0, 0, 0), 'claude-haiku-5-5', [tool('b', 'act', { source: 'fresh' })]), result('b', 'next'),
  ];
  const a = auditNative(rows.join('\n'));
  assert.equal(a.chainMismatches, 0);
  assert.equal(a.workflow[1].actionDelivered, false);
  assert.equal(auditNative(record('one', usage(0, 0, 0, 0), 'claude-haiku-5-5', [tool('b', 'act', {})])).chainMismatches, 1);
});
test('on-demand compaction is billed through iterations despite zero top-level tokens', () => {
  const row = record('compact', { ...usage(0, 0, 0, 0), iterations: [
    { type: 'compaction', input_tokens: 144, output_tokens: 276 },
  ] });
  const a = auditNative([row, row].join('\n'));
  assert.equal(a.processedTokens, 420);
  assert.equal(a.compactionIterations, 1);
  assert.equal(a.peakInputTokens, 144);
  assert.ok(Math.abs(a.estimatedApiUsd - 0.0001524) < 1e-12);
});
test('multiple billing phases count iterations without adding top-level usage again', () => {
  const a = auditNative(record('one', { ...usage(500, 0, 0, 100), iterations: [
    { type: 'compaction', input_tokens: 200, output_tokens: 50 },
    { type: 'message', input_tokens: 300, output_tokens: 50 },
  ] }));
  assert.equal(a.processedTokens, 600);
  assert.equal(a.peakInputTokens, 300);
  assert.equal(a.estimatedApiUsd, null);
  assert.ok(a.warnings.length);
});
test('unattributed cache usage in iteration exports cannot silently reduce estimated cost', () => {
  const a = auditNative(record('one', { ...usage(0, 100, 0, 0), iterations: [
    { type: 'compaction', input_tokens: 100, output_tokens: 10 },
  ] }));
  assert.equal(a.estimatedApiUsd, null);
});

test('only explicitly zero synthetic usage is excluded from pricing and model identity', () => {
  const normal = record('one', usage(1, 0, 0, 1));
  const zero = record('synthetic', { ...usage(0, 0, 0, 0), iterations: null }, '<synthetic>');
  const a = auditNative([normal, zero, zero].join('\n'));
  assert.deepEqual(a.models, { 'claude-haiku-5-5': 1 });
  assert.equal(a.zeroUsageSyntheticMessages, 1);
  assert.equal(a.estimatedApiUsd, auditNative(normal).estimatedApiUsd);
  for (const value of [usage(1, 0, 0, 0), {}, { ...usage(0, 0, 0, 0), iterations: [{ type: 'compaction', output_tokens: 1 }] },
    { ...usage(0, 0, 0, 0), cache_creation: { ephemeral_1h_input_tokens: 1 } },
    { ...usage(0, 0, 0, 0), iterations: [{ type: 'message', cache_creation: { ephemeral_5m_input_tokens: 1 } }] }]) {
    const unknown = auditNative(record('synthetic', value, '<synthetic>'));
    assert.equal(unknown.estimatedApiUsd, null);
    assert.deepEqual(unknown.models, { '<synthetic>': 1 });
  }
  assert.equal(auditNative(record('unknown', usage(0, 0, 0, 0), 'unknown')).estimatedApiUsd, null);
  assert.throws(() => auditNative(record('synthetic', { ...usage(0, 0, 0, 0), cache_creation: { ephemeral_5m_input_tokens: -1 } }, '<synthetic>')));
  const run = { model: 'claude-haiku-5-5', profile: 'compact', caseId: contract.id, candidate: proof.candidate,
    fixtureFingerprint: proof.fixtureFingerprint, proof, transcripts: [{ path: 'worker', role: 'worker', model: 'claude-haiku-5-5' }] };
  assert.equal(scoreRun(run, { cases: [contract] }, () => [normal, zero].join('\n'), () => true).identityMatches, true);
});

test('budget metadata in either position preserves typed receipts and source chaining', () => {
  const tools = ['observe', 'act'].map((name, i) => record(`m${i}`, usage(0, 0, 0, 0), 'claude-haiku-5-5',
    [{ type: 'tool_use', id: `${i}`, name: `mcp__cdp-workflow__${name}`, input: i ? { source: 'old' } : {} }]));
  const budget = { type: 'text', text: JSON.stringify({ type: 'workflow-execution-budget', value: { actionsUsed: 1 } }) };
  const result = (id, receipt, before) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result',
    tool_use_id: id, content: before ? [budget, receipt] : [receipt, budget] }] } });
  const receipt = (type, source, action) => ({ type: 'text', text: JSON.stringify({ type,
    value: { view: { source: { id: source } }, action, output: { omitted: 12 } } }) });
  for (const before of [false, true]) {
    const a = auditNative([tools[0], result('0', receipt('workflow-observation', 'old'), before), tools[1],
      result('1', receipt('workflow-stale', 'fresh', { actionDelivered: false, deliveryUnknown: false, code: 'WORKFLOW_STALE_SOURCE' }), before)].join('\n'));
    assert.equal(a.chainMismatches, 0);
    assert.equal(a.workflow[1].returnedSource, 'fresh');
    assert.equal(a.workflow[1].actionDelivered, false);
    assert.deepEqual(a.workflow[1].omissions, { omitted: 12 });
    assert.deepEqual(a.workflow[1].executionBudgets, [{ actionsUsed: 1 }]);
  }
});

test('missing compaction generation makes cost incomplete; validated native cost-state stays supplemental', () => {
  const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c', sessionId: 'session' });
  const state = { type: 'cost-state', sessionId: 'session', totalCostUSD: 0.1, hasUnknownModelCost: false,
    modelUsage: { 'claude-haiku-5-5': { inputTokens: 100, outputTokens: 100, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, costUSD: 0.1 } } };
  const text = [boundary, record('one', usage(1, 0, 0, 1)), JSON.stringify(state)].join('\n');
  const a = auditNative(text, { path: 'raw.jsonl' });
  assert.equal(a.compactionCostComplete, false);
  assert.equal(a.estimatedApiUsd, null);
  assert.ok(a.assistantEstimatedApiUsd > 0);
  assert.equal(a.nativeCostState.reportedUsd, 0.1);
  assert.equal(a.rawTranscriptPath, 'raw.jsonl');
  assert.match(a.usageScope, /missing/);
  for (const invalid of [{ ...state, sessionId: 'other' }, { ...state, totalCostUSD: -1 },
    { ...state, hasUnknownModelCost: true }, { ...state, totalCostUSD: 0.2 },
    { ...state, modelUsage: { other: Object.values(state.modelUsage)[0] } }]) {
    const bad = auditNative([boundary, record('one', usage(1, 0, 0, 1)), JSON.stringify(invalid)].join('\n'));
    assert.equal(bad.nativeCostState, null);
    assert.equal(bad.estimatedApiUsd, null);
  }
  const billed = record('compaction', { ...usage(0, 0, 0, 0), iterations: [{ type: 'compaction', input_tokens: 5, output_tokens: 1 }] });
  assert.equal(auditNative([boundary, billed].join('\n')).compactionCostComplete, true);
});

test('a declared transport arm must match actual MCP receipts rather than worker metadata', () => {
  const call = record('worker', usage(1, 0, 0, 1), 'claude-haiku-5-5',
    [{type:'tool_use',id:'o',name:'mcp__cdp-workflow__observe',input:{task:'sale'}}]);
  const result = JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'o',
    content:JSON.stringify({type:'workflow-observation',value:{view:{source:{id:'source'}},
      output:{bounded:false,profile:'current-24k',maxBytes:24000}}})}]}});
  const run={model:'claude-haiku-5-5',profile:'arm',transportProfile:'rich-64k',caseId:contract.id,
    candidate:proof.candidate,fixtureFingerprint:proof.fixtureFingerprint,proof,
    transcripts:[{path:'worker',role:'worker',model:'claude-haiku-5-5'}]};
  const read=()=>[call,result].join('\n');
  assert.equal(scoreRun(run,{cases:[contract]},read,()=>true).profileMatches,false);
  assert.equal(scoreRun(run,{cases:[contract]},read,()=>true).verified,false);
  run.transportProfile='current-24k';
  assert.equal(scoreRun(run,{cases:[contract]},read,()=>true).verified,true);
  assert.equal(scoreRun(run,{cases:[contract]},()=>call,()=>true).profileMatches,false);
});
