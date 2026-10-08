import { describe, it, expect } from 'vitest';
import { resolveWorkflowTarget, semanticSignature } from '../../src/workflow.js';
import { projectState } from '../../src/experimental/decision.js';
import type { PageState, StateElement } from '../../src/state/types.js';

const node: StateElement = { k: 'top|path:html:1>body:1>button:2', kq: 'weak', role: 'button', name: 'Same label',
  locator: 'html:nth-of-type(1)>body:nth-of-type(1)>button:nth-of-type(2)', state: { vis: true, en: true } };
const state = (elements = [node]): PageState => ({ schema: 'cdp-cli.page-state/1', id: 'source', seq: 1, capturedAt: '',
  targetId: 'page', captureProfile: 'profile', url: 'http://fixture/', title: '', readyState: 'complete',
  bodyTextHash: 'body', nodeCount: 1, elements, digest: 'digest',
  coverage: { truncated: false, blockedByDialog: false, unreachableFrames: [] } });
const options = { page: 'page', task: 'click', action: 'click', targetKey: node.k };

describe('source-bound workflow targets', () => {
  it('resolves an exact weak key through canonical metadata and preserves CSS compatibility', () => {
    expect(resolveWorkflowTarget(state(), options)).toBe(node.locator);
    expect(resolveWorkflowTarget(state(), { page: 'page', task: 'click', action: 'click', selector: '#save' })).toBe('#save');
    expect(() => resolveWorkflowTarget(state(), { ...options, selector: '#save' })).toThrow('TARGET_CONFLICT');
    expect(() => resolveWorkflowTarget(state(), { ...options, action: 'navigate' })).toThrow('ACTION_UNSUPPORTED');
  });
  it('fails closed for unknown, duplicate, ambiguous, unavailable and unsupported source targets', () => {
    expect(() => resolveWorkflowTarget(state(), { ...options, targetKey: 'made-up' })).toThrow('UNKNOWN_OR_AMBIGUOUS');
    expect(() => resolveWorkflowTarget(state([node, node]), options)).toThrow('UNKNOWN_OR_AMBIGUOUS');
    expect(() => resolveWorkflowTarget(state([{ ...node, kq: 'ambiguous' }]), options)).toThrow('UNKNOWN_OR_AMBIGUOUS');
    expect(() => resolveWorkflowTarget(state([{ ...node, locator: undefined }]), options)).toThrow('UNSUPPORTED');
    for (const flag of ['vis', 'en']) expect(() => resolveWorkflowTarget(state([{ ...node, state: { [flag]: false } }]), options)).toThrow('UNAVAILABLE');
    expect(() => resolveWorkflowTarget(state(), { ...options, targetKey: ' ' })).toThrow('INVALID_TARGET_KEY');
  });
  it('includes locator drift in stale comparison without exposing canonical locators in any projection', async () => {
    const original = state();
    const changed = state([{ ...node, locator: 'html>body>button:nth-of-type(3)' }]);
    expect(semanticSignature(changed)).not.toBe(semanticSignature(original));
    for (const prune of [true, false]) {
      const view = await projectState('click', original, { prune });
      expect(view.elements[0].k).toBe(node.k);
      expect(view.elements[0]).not.toHaveProperty('locator');
    }
    expect(original.elements[0].locator).toBe(node.locator);
  });
  it('protects the action target and parent context when a relevance provider excludes them', async () => {
    const parent = { k: 'row', kq: 'strong' as const, role: 'text', text: 'Account B', state: { vis: false } };
    const background = { k: 'background', kq: 'strong' as const, role: 'button', name: 'Unrelated' };
    const view = await projectState('inspect', state([node, parent, background]), {
      targets: [node.k], hints: { [node.k]: { parents: [parent.k], context: ['Account B'] } },
      provider: { projectState: async () => [], decideNext: async () => ({ actionId: '', confidence: 0, margin: 0 }) }
    });
    expect(view.providerStatus).toBe('applied');
    expect(view.elements.map(element => element.k)).toEqual([node.k, parent.k]);
    expect(view.elements[0].context).toEqual(['Account B']);
    expect(view.elements[0]).not.toHaveProperty('locator');
  });
  it('keeps the visible operator action surface when task vocabulary misses Add and More', async () => {
    const nodes: StateElement[] = [
      { k: 'add', kq: 'strong', role: 'button', name: 'Add', state: { vis: true, en: true } },
      { k: 'more', kq: 'strong', role: 'div', name: 'More', state: { vis: true, en: true } },
      { k: 'disabled', kq: 'strong', role: 'button', name: 'Unavailable action', state: { vis: true, en: false } },
      { k: 'parent', kq: 'strong', role: 'text', text: 'Current customer', state: { vis: false } },
      { k: 'hidden-action', kq: 'strong', role: 'button', name: 'Hidden navigation', state: { vis: false, en: true } },
      { k: 'background', kq: 'strong', role: 'text', text: 'Decoration', state: { vis: true } }
    ];
    const canonical = state(nodes), original = JSON.stringify(canonical);
    const view = await projectState('Create one counter invoice and buy one Pepsi for cash', canonical, {
      protectVisibleActions: true, hints: { more: { parents: ['parent'] } },
      provider: { projectState: async () => [], decideNext: async () => ({ actionId: '', confidence: 0, margin: 0 }) }
    });
    expect(view.elements.map(element => element.k)).toEqual(['add', 'more', 'disabled', 'parent']);
    expect(view.providerStatus).toBe('applied');
    expect(JSON.stringify(canonical)).toBe(original);
  });
});
