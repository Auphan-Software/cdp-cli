/** Optional provider configuration. Browser capture and canonical state stay local. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { QwenRerankerProvider } from './experimental/qwen-reranker.js';
import type { DecisionProvider } from './experimental/decision.js';

const instances = new Map<string, DecisionProvider>();
export function workflowProjectionProvider(env: NodeJS.ProcessEnv = process.env): DecisionProvider | undefined {
  if (env.CDP_RERANK_URL === 'off') return undefined;
  let config: { url?: string; timeoutMs?: number; modelRevision?: string; runtimeRevision?: string } = {};
  try {
    if (!env.CDP_RERANK_URL) {
      const path = env.CDP_RERANK_CONFIG ?? join(env.LOCALAPPDATA ?? join(homedir(), '.config'), 'cdp-cli', 'reranker.json');
      try { config = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if (!env.CDP_RERANK_CONFIG && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }
    config = { ...config, ...(env.CDP_RERANK_URL ? { url: env.CDP_RERANK_URL } : {}),
      ...(env.CDP_RERANK_TIMEOUT_MS ? { timeoutMs: Number(env.CDP_RERANK_TIMEOUT_MS) } : {}),
      ...(env.CDP_RERANK_MODEL_REVISION ? { modelRevision: env.CDP_RERANK_MODEL_REVISION } : {}) };
    const timeoutMs = config.timeoutMs ?? 2500;
    if (!config.url || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000 ||
      (config.modelRevision !== undefined && !/^[a-f0-9]{64}$/.test(config.modelRevision)) ||
      (config.runtimeRevision !== undefined && !/^[a-f0-9]{40}$/.test(config.runtimeRevision))) throw new Error('INVALID_PROJECTION_CONFIG');
    const key = JSON.stringify(config);
    const cached = instances.get(key);
    if (cached) return cached;
    const provider = new QwenRerankerProvider({ url: config.url, classifier: true, timeoutMs, threshold: .1,
      expectedModelRevision: config.modelRevision, expectedRuntimeRevision: config.runtimeRevision });
    if (instances.size >= 4) instances.clear();
    instances.set(key, provider);
    return provider;
  } catch {
    // An invalid optional deployment must still return the full deterministic view.
    return { projectState: async () => { throw new Error('PROJECTION_CONFIGURATION_UNAVAILABLE'); },
      decideNext: async () => { throw new Error('RERANKER_HAS_NO_ACTION_HEAD'); } };
  }
}
