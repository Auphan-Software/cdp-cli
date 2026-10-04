import { describe, it, expect, vi } from 'vitest';
import { workflowProjectionProvider } from '../../src/workflow-projection.js';
import { projectState } from '../../src/experimental/decision.js';
import { QwenRerankerProvider } from '../../src/experimental/qwen-reranker.js';
import { diffStates } from '../../src/state/diff.js';
import type { PageState } from '../../src/state/types.js';

const state = { id: 'source', digest: 'digest', targetId: 'owned', url: 'https://example.test', title: 'Test',
  elements: [
    { k: 'parent', kq: 'stable', role: 'group', name: 'Context', state: { vis: false } },
    { k: 'alert', kq: 'stable', role: 'alert', text: 'Failed', state: { vis: true } },
    { k: 'changed', kq: 'stable', role: 'button', name: 'Updated control', state: { vis: false } },
    { k: 'other', kq: 'stable', role: 'button', name: 'Unrelated control', state: { vis: true } },
  ], coverage: { truncated: false } } as unknown as PageState;
describe('optional shared workflow projection', () => {
  it('is absent by default, can be explicitly disabled, and bypasses bad configuration safely', async () => {
    expect(workflowProjectionProvider({ LOCALAPPDATA: '/missing-config-root' })).toBeUndefined();
    expect(workflowProjectionProvider({ CDP_RERANK_URL: 'off', CDP_RERANK_CONFIG: '/missing' })).toBeUndefined();
    const provider = workflowProjectionProvider({ CDP_RERANK_URL: 'file:///bad' });
    const view = await projectState('inspect', state, { provider });
    expect(view.providerStatus).toBe('fallback');
    expect(view.elements.map(e => e.k)).toEqual(['alert', 'other']);
  });
  it('preserves errors, latest changes, and necessary hidden parents even when every candidate is rejected', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0 }], usage: { prompt_tokens: 20 } }) });
    vi.stubGlobal('fetch', fetch);
    try {
      const view = await projectState('inspect', state, { provider: workflowProjectionProvider({ CDP_RERANK_URL: 'http://192.168.1.140:8125' }),
        hints: { alert: { parents: ['parent'] } }, errors: [{ source: 'network', message: 'HTTP 500' }],
        diff: { to: { id: 'source', seq: undefined }, changes: [{ key: 'changed' }] } as any });
      expect(view.providerStatus).toBe('applied');
      expect(view.elements.map(e => e.k)).toEqual(['parent', 'alert', 'changed']);
      expect(view.errors[0].message).toBe('HTTP 500');
      expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(fetch.mock.calls[0][1].body).documents).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps deterministic evidence on busy service, timeout, or an unexpected model revision', async () => {
    for (const response of [
      { ok: false },
      { ok: true, json: async () => ({ modelRevision: 'wrong', results: [{ index: 0, relevance_score: 0 }], usage: { prompt_tokens: 1 } }) },
      new Error('timeout'),
    ]) {
      vi.stubGlobal('fetch', response instanceof Error ? vi.fn().mockRejectedValue(response) : vi.fn().mockResolvedValue(response));
      try {
        const view = await projectState('inspect', state, { provider: workflowProjectionProvider({ CDP_RERANK_URL: 'http://192.168.1.140:8125', CDP_RERANK_MODEL_REVISION: 'a'.repeat(64) }) });
        expect(view.providerStatus).toBe('fallback'); expect(view.elements.map(e => e.k)).toEqual(['alert', 'other']);
      } finally { vi.unstubAllGlobals(); }
    }
  });
  it('rejects a changed runtime even when the model revision matches', async () => {
    const provider = new QwenRerankerProvider({ url: 'http://192.168.1.140:8125', classifier: true,
      expectedModelRevision: 'a'.repeat(64), expectedRuntimeRevision: 'b'.repeat(40),
      fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ modelRevision: 'a'.repeat(64), runtimeRevision: 'c'.repeat(40),
        results: [{ index: 0, relevance_score: 0 }], usage: { prompt_tokens: 1 } }) }) });
    const view = await projectState('inspect', state, { provider });
    expect(view.providerStatus).toBe('fallback'); expect(view.elements.map(e => e.k)).toEqual(['alert', 'other']);
  });
  it('preserves previously volatile or ambiguous evidence when a later capture stabilizes', async () => {
    for (const ambiguous of [false, true]) {
      const current = structuredClone(state);
      Object.assign(current, { schema: 'cdp-cli.page-state/1', seq: 2, captureProfile: 'profile', bodyTextHash: 'same' });
      current.coverage = { truncated: false, unreachableFrames: [], blockedByDialog: false };
      const before = structuredClone(current); before.id = 'prior'; before.seq = 1;
      const priorNode = before.elements.find(node => node.k === 'other')!;
      priorNode.name = 'Earlier result';
      current.elements.find(node => node.k === 'other')!.name = 'Latest result';
      if (ambiguous) { priorNode.kq = 'ambiguous'; before.coverage.ambiguousKeys = ['other']; }
      else { before.coverage.volatileKeys = ['other']; before.coverage.unstable = true; }
      const view = await projectState('inspect', current, { diff: diffStates(before, current),
        provider: { projectState: async () => [], decideNext: async () => { throw new Error('unused'); } } });
      expect(view.elements).toEqual(expect.arrayContaining([expect.objectContaining({ k: 'other', name: 'Latest result' })]));
    }
  });
});
