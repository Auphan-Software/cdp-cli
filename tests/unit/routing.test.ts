import { expect, it } from 'vitest';
import { routeNext } from '../../src/experimental/routing.js';
import type { PageState } from '../../src/state/types.js';
import type { DecisionProvider } from '../../src/experimental/decision.js';

const state: PageState = { schema: 'cdp-cli.page-state/1', id: 's1', seq: 1, capturedAt: '', targetId: 't', digest: 'd',
  captureProfile: 'fixture', url: 'fixture', title: '', readyState: 'complete', bodyTextHash: '', nodeCount: 1,
  coverage: { truncated: false, unstable: false, unreachableFrames: [] }, elements: [{ k: 'top|save', kq: 'strong', role: 'button', name: 'Save' }] };
it('routes exact replay and semantic relocation before models, and hands off ambiguous replay', async () => {
  const target = { key: 'top|save', role: 'button', name: 'Save', frame: 'top', context: ['Orders'] };
  const actions = [{ id: 'save', kind: 'click' as const, target: 'top|save', description: 'Save' }];
  const evidence = { hints: { 'top|save': { context: ['Orders'] } } };
  const provider: DecisionProvider = { projectState: async () => { throw Error('must skip'); }, decideNext: async () => { throw Error('must skip'); } };
  expect((await routeNext('Save', state, actions, { replay: { target, kind: 'click' }, evidence, projection: provider })).stage).toBe('replay');
  expect((await routeNext('Save', { ...state, elements: [...state.elements, state.elements[0]] }, actions,
    { replay: { target, kind: 'click' }, evidence, projection: provider })).stage).toBe('diagnostic');
  expect((await routeNext('Save', state, actions, { replay: { target: { ...target, key: 'top|old' }, kind: 'click' }, evidence })).stage).toBe('semantic-relocation');
  const duplicate = { ...state, elements: [...state.elements, { ...state.elements[0], k: 'top|duplicate' }] };
  expect((await routeNext('Save', duplicate, actions, { replay: { target: { ...target, key: 'top|old' }, kind: 'click' },
    evidence: { hints: { ...evidence.hints, 'top|duplicate': { context: ['Orders'] } } }, paid: provider })).stage).toBe('diagnostic');
});
it('keeps evidence and skips unqualified visual proposals before a paid decision', async () => {
  const provider: DecisionProvider = { projectState: async () => [], decideNext: async () => ({ actionId: 'save', confidence: 1, margin: 1 }) };
  const visual: DecisionProvider = { ...provider, decideNext: async () => ({ actionId: 'save', confidence: 1, margin: 1, executionQualified: false }) };
  const result = await routeNext('Save', state, [{ id: 'save', kind: 'click', target: 'top|save', description: 'Save' }], {
    projection: provider, localVision: visual, paid: provider, needsVision: true,
    screenshot: { source: { id: 's1', digest: 'd', targetId: 't' }, mimeType: 'image/png', width: 1, height: 1, data: 'fixture' }
  });
  expect(result.stage).toBe('paid-decision');
  expect(result.view!.elements).toHaveLength(1);
  expect(result.trace.map(t=>t.stage)).toEqual(['local-projection','local-vision','paid-decision']);
});
