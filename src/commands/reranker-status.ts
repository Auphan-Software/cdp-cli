/** Probe from the actual caller's environment; never touches a browser or takes an action. */
import { workflowProjectionConfiguration } from '../workflow-projection.js';
import { QwenRerankerProvider } from '../experimental/qwen-reranker.js';
import { randomUUID } from 'node:crypto';

export async function rerankerStatus(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const resolved = workflowProjectionConfiguration(env);
  const base = { configuration: resolved.reason, configPath: resolved.path, searched: resolved.searched };
  if (resolved.reason !== 'configured') return { ...base, success: false };
  const { config } = resolved;
  if (!config.modelRevision || !config.runtimeRevision) return { ...base, success: false, reason: 'REVISION_NOT_PINNED' };
  try {
    const response = await fetcher(new URL('/health', config.url), { redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs ?? 2500) });
    if (!response.ok) throw new Error('HEALTH_REQUEST_FAILED');
    const health = await response.json() as any;
    if (health.status !== 'ok') throw new Error('HEALTH_UNAVAILABLE');
    if (config.modelRevision && health.modelRevision !== config.modelRevision) throw new Error('MODEL_REVISION_MISMATCH');
    if (config.runtimeRevision && health.runtimeRevision !== config.runtimeRevision) throw new Error('RUNTIME_REVISION_MISMATCH');
    const provider = new QwenRerankerProvider({ url: config.url!, classifier: true, timeoutMs: config.timeoutMs ?? 2500,
      threshold: .1, expectedModelRevision: config.modelRevision, expectedRuntimeRevision: config.runtimeRevision, fetch: fetcher });
    const selected = await provider.projectState(`Find the checkout button to pay for an order. Connection probe ${randomUUID()}.`, {} as any, [
      { id: 'checkout', keys: ['checkout'], nodes: [{ k: 'checkout', kq: 'strong', role: 'button', name: 'Checkout' }] },
      { id: 'footer', keys: ['footer'], nodes: [{ k: 'footer', kq: 'strong', role: 'text', text: 'Copyright 2020 All rights reserved' }] },
    ]);
    const fresh = provider.metrics.inputTokens > 0;
    const verified = fresh && provider.metrics.calls === 1 && selected.includes('checkout') && !selected.includes('footer');
    return { ...base, success: verified, endpoint: new URL('/rerank', config.url).href, health,
      ranking: { verified, fresh, selected, ...provider.metrics }, ...(verified ? {} : { reason: fresh ? 'RANKING_SELECTION_UNEXPECTED' : 'RANKING_NOT_FRESH' }) };
  } catch (error) {
    return { ...base, success: false, reason: error instanceof Error ? error.message : 'RERANKER_UNAVAILABLE' };
  }
}
