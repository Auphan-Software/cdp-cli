import { readFile, writeFile } from 'node:fs/promises';
import { projectState } from '../../build/experimental/decision.js';
import { QwenRerankerProvider } from '../../build/experimental/qwen-reranker.js';
const [url, output] = process.argv.slice(2);
if (!url || !output) throw new Error('Usage: node gpu-workload.mjs URL OUTPUT');
const dataset = JSON.parse(await readFile(new URL('./results/fixture-dataset.json', import.meta.url), 'utf8'));
const rows = [];
for (let repeat=0;repeat<3;repeat++) for (const item of dataset) {
  const provider = new QwenRerankerProvider({ url, classifier: true, timeoutMs: 5000 });
  const started = performance.now();
  const view = await projectState(item.task.task, item.state, { ...item.evidence, provider, granularity: 'region' });
  rows.push({ task: item.task.name, repeat, projectionMs: performance.now()-started, status: view.providerStatus,
    canonicalNodes: item.state.elements.length, retainedNodes: view.elements.length, characters: JSON.stringify(view).length, metrics: provider.metrics });
}
await writeFile(output, JSON.stringify({ warning: 'Same saved CPU fixture states; full projection latency, not sustained agent completion. Three repeats; classifier score threshold unchanged.', rows }, null, 2));
