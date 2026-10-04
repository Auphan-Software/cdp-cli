import { describe, it, expect, vi } from 'vitest';
import { projectState, mustKeep, expandState, decideNext, type DecisionProvider, type Evidence } from '../../src/experimental/decision.js';
import { describeTarget, relocateTarget, verifyReplayEffect, resolveProposedTarget } from '../../src/experimental/replay.js';
import { JevProvider } from '../../src/experimental/jev.js';
import { diffStates } from '../../src/state/diff.js';
import type { PageState, StateElement } from '../../src/state/types.js';

const element = (k: string, role = 'button', rest: Partial<StateElement> = {}): StateElement =>
  ({ k, role, name: k, kq: 'strong', state: { vis: true, en: true }, box: [0, 0, 10, 10], ...rest });
function state(elements: StateElement[], overrides: Partial<PageState> = {}): PageState {
  return { schema: 'cdp-cli.page-state/1', id: 's1', seq: 1, digest: 'digest', capturedAt: '', targetId: 'page',
    captureProfile: 'profile', url: 'http://fixture/', title: 'Fixture', readyState: 'complete', bodyTextHash: 'text',
    nodeCount: elements.length, elements, coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false }, ...overrides };
}
const provider = (keep: string[] = []): DecisionProvider => ({
  projectState: vi.fn(async () => keep), decideNext: vi.fn(async () => ({ actionId: 'click', confidence: .99, margin: .98 }))
});

describe('experimental projection safety', () => {
  it('protects changed/removed evidence, alerts, live, dialog, focus, editable, values, selection, targets, task terms and ancestors', async () => {
    const nodes = [element('changed'), element('alert', 'alert'), element('status', 'status'), element('dialog', 'dialog'),
      element('focus'), element('edit', 'textbox'), element('value', 'text', { value: { len: 4, h: 'masked' } }),
      element('selected', 'option', { state: { selected: true } }), element('checked', 'checkbox', { state: { checked: true } }),
      element('current', 'link', { state: { current: 'page' } }), element('target'), element('live', 'text'),
      element('error', 'text', { name: 'Request failed' }), element('term', 'text', { name: 'Invoice' }), element('parent', 'text'), element('noise')];
    const before = state([...nodes, element('gone')]);
    const after = state(nodes.map(e => e.k === 'changed' ? { ...e, name: 'new' } : e), { id: 's2', seq: 2, focus: 'focus' });
    const evidence: Evidence = { diff: diffStates(before, after), targets: ['target'], hints: { live: { live: true }, term: { parents: ['parent'] } },
      errors: [{ source: 'network', message: 'HTTP 500' }] };
    const canonical = JSON.stringify(after);
    const view = await projectState('Invoice', after, { ...evidence, provider: provider() });
    expect(view.elements.map(e => e.k)).toEqual(nodes.filter(e => e.k !== 'noise').map(e => e.k));
    expect(view.diff!.changes.some(c => c.key === 'gone')).toBe(true);
    expect(view.errors).toEqual(evidence.errors);
    expect(view.url).toBe(after.url);
    expect(JSON.stringify(after)).toBe(canonical);
    expect(expandState(view, after, ['noise'])).toEqual([nodes.at(-1)]);
    expect(() => expandState(view, { ...after, digest: 'stale' })).toThrow('STALE_SOURCE');
    expect(() => expandState(view, after, ['invented'])).toThrow('UNKNOWN_KEY');
    view.elements[6].value!.h = 'mutated';
    expect(JSON.stringify(after)).toBe(canonical);
  });
  it('does not deduplicate repeated controls; prunes hidden noise and redundant representation only', async () => {
    const s = state([element('row:a', 'button', { name: 'Edit', text: 'Edit' }), element('row:b', 'button', { name: 'Edit' }),
      element('hidden', 'text', { state: { vis: false } }), element('alert', 'alert', { state: { vis: false } })]);
    const view = await projectState('task', s);
    expect(view.elements.map(e => e.k)).toEqual(['row:a', 'row:b', 'alert']);
    expect(view.elements[0]).not.toHaveProperty('text');
    expect(view.elements[0]).not.toHaveProperty('box');
    expect(view.elements[0]).not.toHaveProperty('state');
  });
  it.each(['node', 'chunk', 'region', 'hybrid'] as const)('retains safeguards for %s', async granularity => {
    const s = state([element('a', 'alert'), element('b'), element('c')]);
    const view = await projectState('task', s, { granularity, provider: provider(), hints: { b: { region: 'main' }, c: { region: 'footer' } } });
    expect(view.elements.map(e => e.k)).toEqual(['a']);
  });
  it('falls back atomically on missing/invalid/provider failure and protects parents of selected nodes', async () => {
    const s = state([element('child'), element('parent', 'text', { state: { vis: false } })]);
    const hints = { child: { parents: ['parent'] } };
    const view = await projectState('task', s, { provider: provider(['node:0']), granularity: 'node', hints });
    expect(view.elements.map(e => e.k)).toEqual(['child', 'parent']);
    const bad = await projectState('task', s, { provider: provider(['invented']) });
    expect(bad.providerStatus).toBe('fallback');
    expect(bad.elements.map(e => e.k)).toEqual(['child']);
    const p = provider(); p.projectState = async () => { throw new Error('timeout'); };
    expect((await projectState('task', s, { provider: p })).providerStatus).toBe('fallback');
    await expect(projectState('task', s, { diff: { to: { id: 'bad', seq: 1 } } as any })).rejects.toThrow('DIFF_MISMATCH');
    await expect(projectState('task', state([element('same'), element('same')]))).rejects.toThrow('DUPLICATE_KEYS');
  });
  it('exposes the residual false-negative risk: unchanged clues outside task vocabulary can be removed', async () => {
    const s = state([element('invoice', 'button'), element('clue', 'text', { name: 'Account frozen' })]);
    expect(mustKeep('invoice', s).has('clue')).toBe(false);
    const view = await projectState('invoice', s, { provider: provider() });
    expect(view.elements.some(e => e.k === 'clue')).toBe(false);
    expect(expandState(view, s, ['clue'])).toHaveLength(1);
  });
});

describe('bounded decisions and replay', () => {
  const actions = [{ id: 'click', kind: 'click' as const, target: 'top|a', description: 'Submit' },
    { id: 'escalate', kind: 'escalate' as const, description: 'Need more evidence' }];
  it('accepts only existing targets and allowed high-confidence decisions', async () => {
    const view = await projectState('task', state([element('top|a')]));
    expect((await decideNext('task', view, actions, provider())).action?.id).toBe('click');
    const p = provider(); p.decideNext = async () => ({ actionId: 'shell', confidence: 1, margin: 1 });
    expect((await decideNext('task', view, actions, p)).escalate).toBe(true);
    p.decideNext = async () => ({ actionId: 'click', confidence: .99, margin: .01 });
    expect((await decideNext('task', view, actions, p)).escalate).toBe(true);
    expect((await decideNext('task', view, actions, provider(), { confidence: NaN, margin: 0 })).escalate).toBe(true);
    expect((await decideNext('task', { ...view, elements: [] }, actions, provider())).reason).toBe('target-unavailable');
    expect((await decideNext('task', { ...view, elements: view.elements.map(e => ({ ...e, kq: 'weak' })) }, actions, provider())).reason).toBe('target-unavailable');
    expect((await decideNext('task', { ...view, coverage: { ...view.coverage, truncated: true } }, actions, provider())).reason).toBe('incomplete-coverage');
  });
  it('relocates stale keys by exact semantics and context, refuses ambiguous/wrong-frame/weak identities', () => {
    const old = element('top|old', 'button', { name: 'Edit' });
    const descriptor = describeTarget(old, ['Order 42']);
    const current = element('top|new', 'button', { name: 'Edit' });
    expect(relocateTarget(descriptor, state([old]), { 'top|old': ['Order 42'] }).stage).toBe('exact');
    expect(relocateTarget(descriptor, state([current]), { 'top|new': ['Order 42'] })).toEqual({ stage: 'semantic', key: 'top|new' });
    expect(relocateTarget(descriptor, state([current, { ...current, k: 'top|other' }]), {
      'top|new': ['Order 42'], 'top|other': ['Order 42'] }).reason).toBe('ambiguous');
    expect(relocateTarget(descriptor, state([{ ...current, k: 'frame|new' }])).stage).toBe('escalate');
    expect(relocateTarget(descriptor, state([{ ...current, kq: 'weak' }])).stage).toBe('escalate');
    expect(relocateTarget(descriptor, state([old], { coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false, dialogProbeUnavailable: true } })).stage).toBe('escalate');
    expect(relocateTarget(descriptor, state([old], { coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false, actionUnverified: true } })).stage).toBe('escalate');
  });
  it('requires a new semantic effect, so already-present success and delivered no-ops fail', () => {
    const before = state([element('result', 'status', { name: 'Saved' })]);
    const after = state(before.elements, { id: 's2', seq: 2 });
    expect(verifyReplayEffect(before, after, { mustChange: [{ key: 'result', field: 'name', to: 'Saved' }] }).outcome).toBe('FAILED');
    expect(verifyReplayEffect(before, after, { mustNotChange: [{ key: 'result' }] }).outcome).toBe('UNKNOWN');
    const changed = state([element('result', 'status', { name: 'Updated' })], { id: 's2', seq: 2 });
    expect(verifyReplayEffect(before, changed, { mustChange: [{ key: 'result', field: 'name', from: 'Saved', to: 'Updated' }] }).outcome).toBe('PASSED');
    expect(verifyReplayEffect(before, changed, { mustChange: [{ key: 'result', field: 'name', to: 'Wrong business effect' }] }).outcome).toBe('FAILED');
  });
  it('revalidates proposals against fresh semantics and session ownership', async () => {
    const s = state([element('top|a', 'button', { name: 'Submit' })]);
    const view = await projectState('Submit', s);
    expect(resolveProposedTarget(view, actions[0], { ...s, targetId: 'other' }).stage).toBe('escalate');
    expect(resolveProposedTarget(view, actions[0], state([element('top|a', 'button', { name: 'Delete' })])).stage).toBe('escalate');
    expect(resolveProposedTarget(view, actions[0], s).stage).toBe('exact');
  });
});

describe('optional Jev adapter wire contract', () => {
  it('batches relevance, validates answers, records usage, and does not serialize credentials', async () => {
    const mockFetch = vi.fn(async (_url: unknown, init: any) => {
      const req = JSON.parse(init.body);
      return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(req.questions)
        .map(k => [k, { type: 'noul', noul: .01 }])), usage: { input_tokens: 20, output_tokens: 2 } }) } as Response;
    });
    const p = new JevProvider({ key: 'unit-test-placeholder', fetch: mockFetch as any });
    const view = await projectState('task', state(Array.from({ length: 13 }, (_, i) => element(`n${i}`))), { provider: p, granularity: 'node' });
    expect(view.omitted.count).toBe(13);
    expect(p.metrics.calls).toBe(3);
    expect(p.metrics.inputTokens).toBe(60);
    expect(JSON.stringify(p)).not.toContain('unit-test-placeholder');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/systemone');
  });
  it('choice probabilities govern margin; malformed/auth failures fail safely without server body', async () => {
    const view = await projectState('task', state([]));
    const actions = [{ id: 'continue', kind: 'continue' as const, description: 'Continue' }, { id: 'escalate', kind: 'escalate' as const, description: 'Escalate' }];
    const p = new JevProvider({ key: 'unit-test-placeholder', fetch: (async () => ({ ok: true, json: async () => ({ model: 'jev-1.13.0',
      answers: { next: { type: 'choice', choice: 'continue', probabilities: { continue: .99, escalate: .01 } } } }) })) as any });
    expect((await decideNext('task', view, actions, p)).action?.id).toBe('continue');
    const bad = new JevProvider({ key: 'unit-test-placeholder', fetch: (async () => ({ ok: false, text: async () => 'sensitive' })) as any });
    await expect(bad.decideNext('task', view, actions)).rejects.toThrow('JEV_REQUEST_FAILED');
    expect((await decideNext('task', view, actions, bad)).reason).toBe('provider-failed');
  });
  it('limits calls before sending and falls back after a malformed later batch', async () => {
    const view = await projectState('task', state([]));
    const units = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, keys: [], nodes: [] }));
    const limitedFetch = vi.fn();
    const limited = new JevProvider({ key: 'unit-test-placeholder', maxProjectionCalls: 1, fetch: limitedFetch as any });
    await expect(limited.projectState('task', view, units)).rejects.toThrow('BUDGET');
    expect(limitedFetch).not.toHaveBeenCalled();
    let calls = 0;
    const p = new JevProvider({ key: 'unit-test-placeholder', fetch: (async (_url: unknown, init: any) => {
      calls++;
      const req = JSON.parse(init.body);
      return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(req.questions)
        .map(k => [k, { type: 'noul', noul: calls === 1 ? .01 : NaN }])) }) };
    }) as any });
    const s = state(Array.from({ length: 7 }, (_,i)=>element(`n${i}`)));
    const result = await projectState('task', s, { provider: p, granularity: 'node' });
    expect(result.providerStatus).toBe('fallback');
    expect(result.elements).toHaveLength(7);
    expect(p.metrics.missingUsageCalls).toBe(2);
  });
  it('aborts timed-out requests and rejects malformed choice distributions', async () => {
    const view = await projectState('task', state([]));
    const actions = [{ id: 'continue', kind: 'continue' as const, description: 'Continue' }, { id: 'escalate', kind: 'escalate' as const, description: 'Escalate' }];
    const slow = new JevProvider({ key: 'unit-test-placeholder', timeoutMs: 5,
      fetch: ((_url: unknown, init: any) => new Promise((_resolve,reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('transport failure')), { once: true });
      })) as any });
    await expect(slow.decideNext('task', view, actions)).rejects.toThrow('JEV_REQUEST_FAILED');
    for (const probabilities of [{ continue: 1 }, { continue: .9, escalate: .9 }, { continue: .01, escalate: .99 }]) {
      const p = new JevProvider({ key: 'unit-test-placeholder', fetch: (async () => ({ ok: true, json: async () => ({ model: 'jev-1.13.0',
        answers: { next: { type: 'choice', choice: 'continue', probabilities } } }) })) as any });
      expect((await decideNext('task', view, actions, p)).reason).toBe('provider-failed');
    }
  });
});
