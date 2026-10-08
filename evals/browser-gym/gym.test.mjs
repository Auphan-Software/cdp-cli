import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
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
    type: 'tool_result', tool_use_id: id, content: JSON.stringify({ value: { view: { source: { id: source } }, action } }),
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
