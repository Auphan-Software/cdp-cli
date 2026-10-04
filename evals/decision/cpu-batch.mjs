// Run only while other benchmark workers are idle. Endpoint must be a pinned classifier-head runtime.
import { writeFile } from 'node:fs/promises';
const [url, output, label] = process.argv.slice(2);
if (!url || !output || !label) throw new Error('Usage: node cpu-batch.mjs URL OUTPUT LABEL');
const rows = [];
const readyDeadline = performance.now()+15000;
while (true) {
  try { if ((await fetch(new URL('/health',url))).ok) break; } catch {}
  if (performance.now()>readyDeadline) throw new Error('Runtime did not become ready');
  await new Promise(r=>setTimeout(r,100));
}
for (const units of [1,6,12,32]) {
  for (let repeat=0; repeat<(units<=6 ? 3 : 1); repeat++) {
    const documents = Array.from({ length: units }, (_,i) => i%2===0 ? 'button | Save' : 'paragraph | Catalog reference 14 Standard item available in warehouse');
    const started = performance.now();
    let data, status = 'ok';
    try {
      const r = await fetch(new URL('/rerank', url), { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Save the order', documents }) });
      if (!r.ok) throw new Error('request');
      data = await r.json();
      if (data.results?.length!==units) throw new Error('shape');
    } catch { status='failed'; }
    rows.push({ units, repeat, status, ms: performance.now()-started, tokens: data?.usage?.prompt_tokens ?? null, scores: data?.results ?? null });
    if (status==='failed') break;
  }
}
await writeFile(output, JSON.stringify({ label, warning: 'Batch endpoint latency, short fixed inputs. This is not full-state task latency.', rows }, null, 2));
