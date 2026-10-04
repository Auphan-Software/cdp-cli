import { readFile, writeFile } from 'node:fs/promises';
import { projectState } from '../../build/experimental/decision.js';
import { QwenRerankerProvider } from '../../build/experimental/qwen-reranker.js';
const [url, output] = process.argv.slice(2);
if (!url || !output) throw new Error('Usage: node office-workload.mjs URL OUTPUT');
const revision = '18f099b292864fde542713d7c41aa4464860e11bc07b045b51543e9e59e6e7e7';
const runtime = '11fe02151f79c41d0d4af7da708755d73b9c0da6';
const dataset = JSON.parse(await readFile(new URL('./results/fixture-dataset.json', import.meta.url), 'utf8'));
const batchRows = [], projectionRows = [];
for (const units of [1, 6, 12, 32]) {
  const body = { query: `Save the order (capacity batch ${units})`, documents: Array.from({ length: units }, (_, i) => `${i % 2 ? 'Weather forecast, unrelated sidebar' : 'button Save, checkout order'} | benchmark identity ${i}`) };
  for (let repeat = 0; repeat < 3; repeat++) {
    const started = performance.now();
    const response = await fetch(new URL('/rerank', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    batchRows.push({ units, repeat, status: response.status, latencyMs: performance.now() - started, promptTokens: data.usage?.prompt_tokens, resultCount: data.results?.length });
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
for (let repeat = 0; repeat < 3; repeat++) for (const item of dataset) {
  const baseline = await projectState(item.task.task, item.state, { ...item.evidence, prune: false });
  const deterministic = await projectState(item.task.task, item.state, item.evidence);
  const provider = new QwenRerankerProvider({ url, classifier: true, timeoutMs: 2500, expectedModelRevision: revision, expectedRuntimeRevision: runtime });
  const started = performance.now();
  const view = await projectState(item.task.task, item.state, { ...item.evidence, provider, granularity: 'region' });
  const gold = [...(item.task.target ? [`top|id:${item.task.target}`] : []), ...(item.task.clue ? [item.task.clue] : [])];
  projectionRows.push({ task: item.task.name, repeat, projectionMs: performance.now() - started, status: view.providerStatus,
    baselineNodes: baseline.elements.length, deterministicNodes: deterministic.elements.length, retainedNodes: view.elements.length,
    baselineCharacters: JSON.stringify(baseline).length, deterministicCharacters: JSON.stringify(deterministic).length,
    projectedCharacters: JSON.stringify(view).length, goldNodes: gold.length, missingGold: gold.filter(key => !view.elements.some(node => node.k === key)), metrics: provider.metrics });
  await new Promise(resolve => setTimeout(resolve, 150));
}
const health = await (await fetch(new URL('/health', url))).json();
await writeFile(output, JSON.stringify({ warning: 'Office LAN HTTP batch and saved-fixture projection measurements. Not live Mako2/WhiteTip2 full-agent effectiveness or transcription peak-load qualification. Repeat0 may include shared cache from prior tasks; tokens0 establishes a score-cache hit.', batchRows, projectionRows, health }, null, 2));
console.log(JSON.stringify({ output, batches: batchRows.length, projections: projectionRows.length, fallback: projectionRows.filter(row => row.status !== 'applied').length, missingGold: projectionRows.flatMap(row => row.missingGold), health }, null, 2));
