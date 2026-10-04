// Operational cancellation probe. Requires an owned SSH loopback forward to worker8126.
import { writeFile } from 'node:fs/promises';
const [gateway, worker, output] = process.argv.slice(2);
if (!gateway || !worker || !output) throw new Error('Usage: office-cancel.mjs GATEWAY FORWARDED_WORKER OUTPUT');
const controller = new AbortController();
const started = performance.now();
const pending = fetch(new URL('/rerank', gateway), { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: `Save the order cancellation probe ${Date.now()}`, documents: Array.from({length:16}, (_, i) => `row ${i} | ` + 'button Save order evidence '.repeat(140)) }), signal: controller.signal }).catch(error => ({ aborted: error.name }));
let processingSeen = false;
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const slots = await (await fetch(new URL('/slots', worker), { signal: AbortSignal.timeout(500) })).json();
    if (Array.isArray(slots) && slots.some(slot => slot.is_processing)) { processingSeen = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  controller.abort(); await pending;
  const cancelledAtMs = performance.now() - started;
  let idle = false; let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    const slots = await (await fetch(new URL('/slots', worker), { signal: AbortSignal.timeout(500) })).json();
    health = await (await fetch(new URL('/health', gateway))).json();
    if (slots.every(slot => !slot.is_processing) && !health.busy) { idle = true; break; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const result = { processingSeen, idle, cancelledAtMs, idleAtMs: performance.now() - started, health,
    warning: 'Proves actual worker processing was seen and cancelled work drained before gateway admission reopened. Does not measure simultaneous transcription latency.' };
  await writeFile(output, JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
  if (!processingSeen || !idle) process.exitCode = 1;
} finally { controller.abort(); }
