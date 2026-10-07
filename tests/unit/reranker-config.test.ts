import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { workflowProjectionConfiguration, projectionReason } from '../../src/workflow-projection.js';
import { rerankerStatus } from '../../src/commands/reranker-status.js';
import { projectState } from '../../src/experimental/decision.js';
import keypad from '../fixtures/mako-login-keypad.json';
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

describe('reranker deployment visibility and diagnostics', () => {
  it('falls back to shared config when unpackaged user AppData is missing; preserves user and explicit overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'reranker-config-'));
    const user = join(root, 'user'); const shared = join(root, 'shared');
    try {
      mkdirSync(join(shared, 'cdp-cli'), { recursive: true });
      const machinePath = join(shared, 'cdp-cli', 'reranker.json');
      writeFileSync(machinePath, JSON.stringify({ url: 'http://machine:8125' }));
      const env = { LOCALAPPDATA: user, ProgramData: shared };
      expect(workflowProjectionConfiguration(env)).toMatchObject({ reason: 'configured', path: machinePath, config: { url: 'http://machine:8125' } });
      mkdirSync(join(user, 'cdp-cli'), { recursive: true });
      const userPath = join(user, 'cdp-cli', 'reranker.json');
      writeFileSync(userPath, JSON.stringify({ url: 'http://user:8125' }));
      expect(workflowProjectionConfiguration(env).config.url).toBe('http://user:8125');
      expect(workflowProjectionConfiguration({ ...env, CDP_RERANK_CONFIG: machinePath }).config.url).toBe('http://machine:8125');
      expect(workflowProjectionConfiguration({ ...env, CDP_RERANK_CONFIG: '/missing-explicit-file' }).reason).toBe('invalid-config');
      expect(workflowProjectionConfiguration({ ...env, CDP_RERANK_URL: 'off' }).reason).toBe('disabled');
      expect(workflowProjectionConfiguration({ ...env, CDP_RERANK_URL: 'http://override:8125' }).config.url).toBe('http://override:8125');
      writeFileSync(userPath, '{bad');
      expect(workflowProjectionConfiguration(env).reason).toBe('invalid-config');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('requires a real ranking request with selected checkout, rejected footer and pinned revisions', async () => {
    const env = { CDP_RERANK_URL: 'http://office:8125', CDP_RERANK_MODEL_REVISION: 'a'.repeat(64), CDP_RERANK_RUNTIME_REVISION: 'b'.repeat(40) };
    const requests: string[] = [];
    const fetcher = async (url: any) => {
      requests.push(String(url));
      return { ok: true, json: async () => String(url).endsWith('/health') ? { status: 'ok', modelRevision: 'a'.repeat(64), runtimeRevision: 'b'.repeat(40) } :
        { modelRevision: 'a'.repeat(64), runtimeRevision: 'b'.repeat(40), results: [{ index: 0, relevance_score: .99 }, { index: 1, relevance_score: .01 }], usage: { prompt_tokens: 60 } } } as any;
    };
    expect(await rerankerStatus(env, fetcher as any)).toMatchObject({ success: true, ranking: { verified: true, calls: 1, selected: ['checkout'] } });
    expect(requests).toEqual(['http://office:8125/health', 'http://office:8125/rerank']);
    expect(await rerankerStatus(env, (async () => ({ ok: true, json: async () => ({ status: 'ok', modelRevision: 'wrong' }) })) as any))
      .toMatchObject({ success: false, reason: 'MODEL_REVISION_MISMATCH' });
    expect(await rerankerStatus(env, (async () => { throw new Error('unreachable'); }) as any)).toMatchObject({ success: false, reason: 'unreachable' });
    expect(await rerankerStatus({ CDP_RERANK_URL: 'off' }, fetcher as any)).toMatchObject({ success: false, configuration: 'disabled' });
    expect(await rerankerStatus({ CDP_RERANK_URL: env.CDP_RERANK_URL }, fetcher as any)).toMatchObject({ success: false, reason: 'REVISION_NOT_PINNED' });
    for (const [phase, field, value, expected] of [
      ['health', 'runtimeRevision', 'wrong', 'RUNTIME_REVISION_MISMATCH'],
      ['rank', 'runtimeRevision', 'wrong', 'LOCAL_RUNTIME_REVISION_MISMATCH'],
      ['rank', 'modelRevision', 'wrong', 'LOCAL_MODEL_REVISION_MISMATCH'],
      ['rank', 'usage', { prompt_tokens: 0 }, 'RANKING_NOT_FRESH'],
    ] as const) {
      const altered = async (url: any) => {
        const response = await fetcher(url);
        const data = await response.json();
        if ((String(url).endsWith('/health') ? 'health' : 'rank') === phase) data[field] = value;
        return { ok: true, json: async () => data } as any;
      };
      expect(await rerankerStatus(env, altered as any)).toMatchObject({ success: false, reason: expected });
    }
  });
  it('does not search relative configuration roots even when environment variables are empty or relative', () => {
    const resolution = workflowProjectionConfiguration({ LOCALAPPDATA: '', XDG_CONFIG_HOME: 'relative', ProgramData: '' });
    expect(resolution.searched.every(isAbsolute)).toBe(true);
  });
  it.each([
    [undefined, 'not-configured', 'unused', 'not-configured'],
    [undefined, 'disabled', 'unused', 'disabled'],
    [undefined, 'invalid-config', 'fallback', 'invalid-config'],
    [undefined, 'configured', 'unused', 'no-candidates'],
    [undefined, 'configured', 'applied', 'applied'],
    [undefined, 'configured', 'fallback', 'request-failed'],
    ...['full-view','history-unavailable','profile-mismatch','unsafe-coverage'].map(reason => [reason, 'configured', 'unused', reason]),
  ])('reports projection reason for %s / %s / %s', (blocked, config, status, expected) => {
    expect(projectionReason(blocked, config as any, status as any)).toBe(expected);
  });
  it('does not report an applied provider when every node is protected', async () => {
    const project = vi.fn();
    const state = { id: 'source', digest: 'digest', targetId: 'owned', elements: [
      { k: 'alert', kq: 'strong', role: 'alert', text: 'Offline' },
    ], coverage: {} } as any;
    const view = await projectState('inspect', state, { provider: { projectState: project, decideNext: vi.fn() } });
    expect(view.providerStatus).toBe('unused');
    expect(view.elements[0].text).toBe('Offline');
    expect(project).not.toHaveBeenCalled();
  });
  it('preserves the actual Mako login keypad even when the relevance provider rejects all candidates', async () => {
    const view = await projectState('Find the PIN keypad and the Login button on the POS login screen', keypad as any,
      { provider: { projectState: async () => [], decideNext: vi.fn() } });
    expect(view.elements.filter(e => e.role === 'button').map(e => e.name).sort())
      .toEqual(['0','1','2','3','4','5','6','7','8','9','Clear','Login'].sort());
    expect(view.elements.some(e => e.role === 'textbox' && e.k === 'top|path:div:3>div:2>div:2>div:1>div:1>input:1')).toBe(true);
  });
});
