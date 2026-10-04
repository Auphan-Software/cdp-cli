// LAN gateway for a pinned llama.cpp classifier. No UI text is logged or retained.
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { readFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setPriority, constants } from 'node:os';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
export function validateRequest(value) {
  if (!value || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 8000 ||
      !Array.isArray(value.documents) || !value.documents.length || value.documents.length > 128 ||
      value.documents.some(d => typeof d !== 'string' || d.length > 12000) ||
      value.documents.reduce((n, d) => n + d.length, value.query.length) > 128000) throw new Error('REQUEST_LIMIT');
  return { query: value.query, documents: value.documents };
}

export function transcriptionIdle(status) {
  return status?.status === 'ok' && status.transcription_service_enabled === true &&
    status.transcription_device === 'cuda' && Number.isSafeInteger(status.active_transcription_jobs) &&
    status.active_transcription_jobs === 0;
}

function transcriptionStatus(url) {
  // The existing transcription service uses a self-signed certificate. This exception
  // is restricted to host-local monitoring; never forwarded to browser or LAN requests.
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== '127.0.0.1') throw new Error('LOOPBACK_MONITOR_REQUIRED');
  return new Promise((resolve, reject) => {
    const request = httpsGet(target, { rejectUnauthorized: false, timeout: 350 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 16000) request.destroy(new Error('STATUS_LIMIT')); });
      response.on('end', () => { try { if (response.statusCode !== 200) throw new Error('STATUS_FAILED'); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('STATUS_TIMEOUT')));
    request.on('error', reject);
  });
}

export function createGateway({ config, gate, rank, ready, drain = async () => {} }) {
  let busy = false;
  const counters = { accepted: 0, rejected: 0, failed: 0, cacheHits: 0 };
  const scoreCache = new Map();
  const reply = (response, status, value) => { if (!response.destroyed) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value)); };
  return createServer(async (request, response) => {
    request.setTimeout(2500, () => request.destroy());
    if (request.method === 'GET' && request.url === '/health') {
      const capacity = await gate().catch(() => ({ available: false, reason: 'monitor-unavailable' }));
      const workerReady = await ready().catch(() => false);
      return reply(response, workerReady ? 200 : 503, { status: workerReady ? 'ok' : 'loading', modelRevision: config.modelRevision,
        runtimeRevision: config.runtimeRevision, capacity: { ...capacity, available: capacity.available && !busy && workerReady }, busy, counters });
    }
    if (request.method !== 'POST' || request.url !== '/rerank') return reply(response, 404, { error: 'NOT_FOUND' });
    if (busy) { counters.rejected++; return reply(response, 503, { error: 'BUSY' }); }
    // Claim admission before async body/monitor work. Do not queue behind another agent.
    busy = true;
    let dispatched = false;
    try {
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return reply(response, 415, { error: 'JSON_REQUIRED' });
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 192000) throw new Error('REQUEST_LIMIT'); chunks.push(chunk); }
      const value = validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const deadline = Date.now() + (config.requestBudgetMs ?? 2000);
      const results = []; let promptTokens = 0;
      const cacheKeys = value.documents.map(document => createHash('sha256').update(JSON.stringify([config.modelRevision, config.runtimeRevision, value.query, document])).digest('hex'));
      const missing = [];
      cacheKeys.forEach((key, index) => {
        if (scoreCache.has(key)) {
          const score = scoreCache.get(key); scoreCache.delete(key); scoreCache.set(key, score);
          results.push({ index, relevance_score: score }); counters.cacheHits++;
        } else missing.push(index);
      });
      for (let start = 0; start < missing.length;) {
        if (response.destroyed) throw new Error('CLIENT_DISCONNECTED');
        const capacity = await gate({ inFlight: start > 0 });
        if (!capacity.available) { counters.rejected++; return reply(response, 503, { error: 'CAPACITY_UNAVAILABLE', reason: capacity.reason }); }
        const documents = []; let characters = 0;
        while (start + documents.length < missing.length && documents.length < 8) {
          const document = value.documents[missing[start + documents.length]];
          if (documents.length && characters + document.length + value.query.length > 24000) break;
          documents.push(document); characters += document.length + value.query.length;
        }
        const remaining = deadline - Date.now();
        if (remaining < 50) throw new Error('DEADLINE');
        dispatched = true;
        const data = await rank({ query: value.query, documents }, remaining);
        if (!Array.isArray(data.results) || data.results.length !== documents.length ||
            new Set(data.results.map(r => r.index)).size !== documents.length ||
            data.results.some(r => !Number.isSafeInteger(r.index) || r.index < 0 || r.index >= documents.length ||
              !Number.isFinite(r.relevance_score) || r.relevance_score < 0 || r.relevance_score > 1) ||
            !Number.isSafeInteger(data.usage?.prompt_tokens) || data.usage.prompt_tokens < 0) throw new Error('INVALID_SCORE');
        results.push(...data.results.map(r => ({ index: missing[start + r.index], relevance_score: r.relevance_score })));
        promptTokens += data.usage.prompt_tokens; start += documents.length;
      }
      for (const row of results) {
        scoreCache.delete(cacheKeys[row.index]); scoreCache.set(cacheKeys[row.index], row.relevance_score);
        while (scoreCache.size > 512) scoreCache.delete(scoreCache.keys().next().value);
      }
      counters.accepted++;
      reply(response, 200, { results, usage: { prompt_tokens: promptTokens }, modelRevision: config.modelRevision, runtimeRevision: config.runtimeRevision });
    } catch (error) {
      counters.failed++;
      reply(response, /REQUEST_LIMIT|JSON/.test(error.message) || error instanceof SyntaxError ? 400 : 503, { error: 'RANKING_UNAVAILABLE' });
    } finally { if (dispatched) await drain().catch(() => {}); busy = false; }
  });
}

async function main() {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!/^127\.0\.0\.1$/.test(new URL(config.workerUrl).hostname) || !config.modelRevision || !config.runtimeRevision) throw new Error('INVALID_CONFIG');
  let worker; let restarts = []; let stopping = false;
  async function startWorker() {
    if (stopping) return;
    const capacity = await gate({ startup: true }).catch(() => ({ available: false }));
    if (stopping) return;
    if (!capacity.available) { setTimeout(startWorker, 15000); return; }
    restarts = restarts.filter(time => time > Date.now() - 300000);
    if (restarts.length >= 3) { console.error('Worker restart limit reached; gateway will fall back until service restart.'); return; }
    restarts.push(Date.now());
    worker = spawn(config.executable, config.args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { setPriority(worker.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { console.error('Worker priority could not be lowered.'); }
    // Keep runtime/offload proof, but suppress inference logs and all request text.
    worker.stderr.on('data', chunk => { for (const line of chunk.toString().split('\n')) if (/offloaded.*layers|CUDA.*device|buffer size|error.*CUDA/i.test(line)) console.error(line); });
    worker.on('error', () => console.error('Worker could not start.'));
    worker.on('exit', () => { if (!stopping) setTimeout(startWorker, 5000); });
  }
  let gpu; let gpuAt = 0;
  const gate = async ({ inFlight = false, startup = false } = {}) => {
    const status = await transcriptionStatus(config.transcriptionUrl);
    if (!transcriptionIdle(status)) return { available: false, reason: 'transcription-active' };
    if (Date.now() - gpuAt > 1000) {
      const { stdout } = await exec('nvidia-smi', ['--query-gpu=memory.free,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 1000, windowsHide: true });
      const values = stdout.trim().split(',').map(Number);
      if (values.length !== 2 || values.some(v => !Number.isFinite(v))) throw new Error('GPU_MONITOR_UNAVAILABLE');
      gpu = { freeMiB: values[0], utilization: values[1] }; gpuAt = Date.now();
    }
    return { available: gpu.freeMiB >= (startup ? 4096 : (config.minFreeMiB ?? 2048)) && (inFlight || gpu.utilization < 25), reason: 'gpu-headroom', ...gpu };
  };
  startWorker();
  const server = createGateway({ config, gate,
    ready: async () => (await fetch(new URL('/health', config.workerUrl), { signal: AbortSignal.timeout(500) })).ok,
    drain: async () => {
      // A disconnected HTTP client is not proof of CUDA cancellation. Hold admission
      // until the worker reports idle; terminate only this owned worker if wedged.
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const response = await fetch(new URL('/slots', config.workerUrl), { signal: AbortSignal.timeout(300) });
          if (response.ok) { const slots = await response.json(); if (Array.isArray(slots) && slots.length && slots.every(slot => slot.is_processing === false)) return; }
        } catch { /* Keep admission closed until idle or owned-worker termination. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      worker?.kill();
    },
    rank: async (body, remaining) => {
      const response = await fetch(new URL('/rerank', config.workerUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(remaining) });
      if (!response.ok) throw new Error('WORKER_FAILED'); return response.json();
    } });
  server.maxConnections = 16; server.headersTimeout = 3000; server.requestTimeout = 3000;
  server.listen(config.port, config.host, () => console.log(`CDP reranker gateway listening on ${config.host}:${config.port}`));
  const stop = () => { stopping = true; worker?.kill(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('CDP reranker startup failed.'); process.exitCode = 1; });
