import { describe, expect, it } from 'vitest';
import { QwenRerankerProvider, relevanceScore, rerankerPrompt } from '../../src/experimental/qwen-reranker.js';
import { LocalVisionProvider } from '../../src/experimental/local-vision.js';
import { decideNext, type AgentView } from '../../src/experimental/decision.js';

const view: AgentView = { source: { id: 's1', digest: 'digest', targetId: 't' }, url: 'fixture', title: '',
  elements: [{ k: 'a', kq: 'strong', role: 'button', name: 'A' }], errors: [], coverage: { truncated: false, unstable: false, unreachableFrames: [] },
  omitted: { count: 0, expand: { sourceId: 's1', sourceDigest: 'digest' } }, providerStatus: 'unused' };
describe('local inference correctness boundaries', () => {
  it('normalizes only pre-sampling yes/no scores and rejects missing or truncated evidence', () => {
    const response = { completion_probabilities: [{ top_logprobs: [{ token: 'yes', logprob: -2 }, { token: 'no', logprob: -3 }] }] };
    expect(relevanceScore(response)).toBeCloseTo(1/(1+Math.exp(-1)));
    expect(() => relevanceScore({ ...response, truncated: true })).toThrow();
    expect(() => relevanceScore({ completion_probabilities: [{ top_logprobs: [{ token: 'Yes', logprob: -1 }] }] })).toThrow();
    expect(rerankerPrompt('task', 'document').endsWith('<think>\n\n</think>\n\n')).toBe(true);
  });
  it('does not return a partial projection after a bad score', async () => {
    let calls = 0;
    const provider = new QwenRerankerProvider({ url: 'http://localhost:8081', fetch: async () => {
      calls++;
      return new Response(JSON.stringify(calls===1 ? { tokens_evaluated: 12, completion_probabilities: [{ top_logprobs: [
        { token: 'yes', logprob: -.1 }, { token: 'no', logprob: -3 }] }] } : { tokens_evaluated: 12 }));
    } });
    await expect(provider.projectState('task', view, [{ id: 'x', keys: ['a'], nodes: view.elements }, { id: 'y', keys: [], nodes: [] }])).rejects.toThrow();
    expect(provider.metrics.batches[0].scores).toHaveLength(1);
  });
  it('never qualifies generated confidence for browser execution and rejects stale screenshots before inference', async () => {
    let calls = 0;
    const provider = new LocalVisionProvider({ url: 'http://localhost:8082', fetch: async () => {
      calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"actionId":"a","confidence":1}' } }] }));
    } });
    const actions = [{ id: 'a', kind: 'click' as const, target: 'a', description: 'Card A' }];
    expect((await decideNext('task', view, actions, provider)).escalate).toBe(true);
    expect((await decideNext('task', view, actions, provider, { confidence: 0, margin: 0 })).escalate).toBe(true);
    expect(provider.metrics.rawChoice).toBe('a');
    const result = await decideNext('task', view, actions, provider, undefined,
      { source: { ...view.source, digest: 'old' }, width: 640, height: 320, mimeType: 'image/png', data: 'fixture' });
    expect(result.reason).toBe('stale-or-invalid-screenshot');
    expect(calls).toBe(2);
  });
  it('accepts reordered classifier scores only with a complete unique unit mapping', async () => {
    let invalid = false;
    const provider = new QwenRerankerProvider({ url: 'http://localhost:8084', classifier: true, fetch: async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 123 }, results: invalid ? [
        { index: 0, relevance_score: .9 }, { index: 0, relevance_score: .8 }] : [
        { index: 1, relevance_score: .02 }, { index: 0, relevance_score: .9 }] })) });
    const units = [{ id: 'a', keys: ['a'], nodes: view.elements }, { id: 'b', keys: [], nodes: [] }];
    expect(await provider.projectState('task', view, units)).toEqual(['a']);
    expect(provider.metrics.inputTokens).toBe(123);
    invalid = true;
    await expect(provider.projectState('task', view, units)).rejects.toThrow();
  });
  it('reuses exact content scores across fresh identities while remapping misses and invalidating changed tasks', async () => {
    const batches: string[][] = [];
    const cache = { maxEntries: 2, modelRevision: 'pinned-q8' };
    const provider = new QwenRerankerProvider({ url: 'http://localhost:8084', classifier: true, scoreCache: cache, fetch: async (_url, init) => {
      const documents = JSON.parse(init!.body as string).documents as string[]; batches.push(documents);
      return new Response(JSON.stringify({ usage: { prompt_tokens: 10 }, results: documents.map((doc,index) =>
        ({ index, relevance_score: doc.includes('Distractor') ? .02 : .9 })).reverse() }));
    } });
    const a = { id: 'old-a', keys: ['a'], nodes: view.elements };
    const b = { id: 'old-b', keys: ['b'], nodes: [{ k: 'b', kq: 'strong' as const, role: 'paragraph', name: 'Distractor' }] };
    expect(await provider.projectState('task', view, [a,b])).toEqual(['old-a']);
    const fresh = [{ ...b, id: 'new-b' }, { ...a, id: 'new-a' }];
    expect(await provider.projectState('task', { ...view, source: { ...view.source, id: 's2' } }, fresh)).toEqual(['new-a']);
    expect(batches).toHaveLength(1);
    const changed = [{ ...fresh[0], nodes: [{ ...b.nodes[0], name: 'Changed useful evidence' }] }, fresh[1]];
    expect(await provider.projectState('task', view, changed)).toEqual(['new-b','new-a']);
    expect(batches[1]).toHaveLength(1); // Server index 0 maps to the miss, not the cached second unit.
    await provider.projectState('different task', view, changed);
    expect(batches[2]).toHaveLength(2);
    // Caller mutation cannot bypass validated bounds or change the pinned model.
    cache.modelRevision = ''; cache.maxEntries = -1;
    await provider.projectState('different task', view, changed);
    expect(batches).toHaveLength(3);
    expect(provider.metrics.cacheHits).toBe(5);
  });
  it('never caches malformed batches or enables unbounded/unversioned caching', async () => {
    let valid = false;
    const provider = new QwenRerankerProvider({ url: 'http://localhost:8084', classifier: true,
      scoreCache: { maxEntries: 1, modelRevision: 'pinned' }, fetch: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 10 },
        results: [{ index: 0, relevance_score: valid ? .02 : 5 }] })) });
    const units = [{ id: 'a', keys: ['a'], nodes: view.elements }];
    await expect(provider.projectState('task', view, units)).rejects.toThrow();
    valid = true;
    expect(await provider.projectState('task', view, units)).toEqual([]);
    expect(provider.metrics.calls).toBe(2);
    for (const scoreCache of [{ maxEntries: 0, modelRevision: 'pinned' }, { maxEntries: 2049, modelRevision: 'pinned' }, { maxEntries: 1, modelRevision: '' }]) {
      expect(() => new QwenRerankerProvider({ url: 'http://localhost:8084', classifier: true, scoreCache })).toThrow('LOCAL_INVALID_CACHE');
    }
  });
});
