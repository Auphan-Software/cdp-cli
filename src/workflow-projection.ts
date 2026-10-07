/** Optional provider configuration. Browser capture and canonical state stay local. */
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { QwenRerankerProvider } from './experimental/qwen-reranker.js';
import type { DecisionProvider } from './experimental/decision.js';

const instances = new Map<string, DecisionProvider>();
export interface ProjectionConfig { url?: string; timeoutMs?: number; modelRevision?: string; runtimeRevision?: string }
export interface ProjectionConfiguration {
  reason: 'configured' | 'disabled' | 'not-configured' | 'invalid-config';
  config: ProjectionConfig; path?: string; searched: string[];
}
/** Explicit overrides and user configuration win; shared config avoids MSIX-private AppData. */
export function workflowProjectionConfiguration(env: NodeJS.ProcessEnv = process.env): ProjectionConfiguration {
  if (env.CDP_RERANK_URL?.trim().toLowerCase() === 'off') return { reason: 'disabled', config: {}, searched: [] };
  let config: ProjectionConfig = {};
  let path: string | undefined;
  const searched: string[] = [];
  try {
    if (!env.CDP_RERANK_URL) {
      const root = (...candidates: Array<string | undefined>) => candidates.find(value => value?.trim() && isAbsolute(value));
      const paths = env.CDP_RERANK_CONFIG ? [env.CDP_RERANK_CONFIG] : [
        join(root(env.LOCALAPPDATA, env.XDG_CONFIG_HOME) ?? join(homedir(), '.config'), 'cdp-cli', 'reranker.json'),
        ...(root(env.ProgramData, env.PROGRAMDATA) || process.platform === 'win32' ?
          [join(root(env.ProgramData, env.PROGRAMDATA) ?? 'C:\\ProgramData', 'cdp-cli', 'reranker.json')] :
          ['/etc/cdp-cli/reranker.json']),
      ];
      for (const candidate of paths) {
        searched.push(candidate);
        try { config = JSON.parse(readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')); path = candidate; break; }
        catch (error) {
          if (!env.CDP_RERANK_CONFIG && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      if (!path) return { reason: 'not-configured', config: {}, searched };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('INVALID_PROJECTION_CONFIG');
    config = { ...config, ...(env.CDP_RERANK_URL ? { url: env.CDP_RERANK_URL } : {}),
      ...(env.CDP_RERANK_TIMEOUT_MS ? { timeoutMs: Number(env.CDP_RERANK_TIMEOUT_MS) } : {}),
      ...(env.CDP_RERANK_MODEL_REVISION ? { modelRevision: env.CDP_RERANK_MODEL_REVISION } : {}),
      ...(env.CDP_RERANK_RUNTIME_REVISION ? { runtimeRevision: env.CDP_RERANK_RUNTIME_REVISION } : {}) };
    const timeoutMs = config.timeoutMs ?? 2500;
    if (!config.url || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000 ||
      (config.modelRevision !== undefined && !/^[a-f0-9]{64}$/.test(config.modelRevision)) ||
      (config.runtimeRevision !== undefined && !/^[a-f0-9]{40}$/.test(config.runtimeRevision))) throw new Error('INVALID_PROJECTION_CONFIG');
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('INVALID_PROJECTION_CONFIG');
    return { reason: 'configured', config, path, searched };
  } catch { return { reason: 'invalid-config', config: {}, path, searched }; }
}

export function workflowProjectionProvider(env: NodeJS.ProcessEnv = process.env): DecisionProvider | undefined {
  const resolution = workflowProjectionConfiguration(env);
  if (resolution.reason === 'disabled' || resolution.reason === 'not-configured') return undefined;
  try {
    if (resolution.reason !== 'configured') throw new Error('INVALID_PROJECTION_CONFIG');
    const config = resolution.config;
    const key = JSON.stringify(config);
    const cached = instances.get(key);
    if (cached) return cached;
    const provider = new QwenRerankerProvider({ url: config.url!, classifier: true, timeoutMs: config.timeoutMs ?? 2500, threshold: .1,
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

export function projectionReason(blocked: string | undefined, configuration: ProjectionConfiguration['reason'],
  status: 'unused' | 'applied' | 'fallback'): string {
  return blocked ?? (configuration !== 'configured' ? configuration :
    status === 'fallback' ? 'request-failed' : status === 'applied' ? 'applied' : 'no-candidates');
}
