import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// API-equivalent estimates, not Claude Max invoices. Rates checked 2026-10-07.
const rates = {
  'claude-haiku-5-5': { input: 0.10, write: 0.125, read: 0.01, output: 0.50 },
  'claude-sonnet-5-5': { input: 2, write: 2.50, read: 0.10, output: 10 },
};
const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const count = (object, key) => { object[key] = (object[key] || 0) + 1; };

export function auditNative(text) {
  const messages = new Map(), tools = new Map(), results = new Map(), boundaries = new Set();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const row = JSON.parse(line); // Truncated/corrupt records must not silently reduce cost.
    if (row.subtype === 'compact_boundary') boundaries.add(row.uuid || row.timestamp || line);
    const message = row.message;
    if (!message || typeof message !== 'object') continue;
    if (row.type === 'assistant' && message.usage) {
      const id = message.id || row.uuid;
      if (!id) throw new Error('Assistant usage lacks a deduplication ID');
      const prior = messages.get(id) || { model: message.model, usage: {}, cache: {}, time: row.timestamp, iterations: [] };
      if (prior.model !== message.model) throw new Error('Model changed within one assistant message');
      for (const field of fields) {
        const value = message.usage[field] || 0;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid usage: ${field}`);
        prior.usage[field] = Math.max(prior.usage[field] || 0, value);
      }
      for (const field of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
        prior.cache[field] = Math.max(prior.cache[field] || 0, message.usage.cache_creation?.[field] || 0);
      }
      if (message.usage.iterations) {
        if (!Array.isArray(message.usage.iterations)) throw new Error('Invalid usage iterations');
        message.usage.iterations.forEach((iteration, index) => {
          const saved = prior.iterations[index] || { type: iteration.type, usage: {} };
          if (saved.type !== iteration.type) throw new Error('Usage iteration type changed');
          for (const field of fields) {
            const value = iteration[field] || 0;
            if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid iteration usage: ${field}`);
            saved.usage[field] = Math.max(saved.usage[field] || 0, value);
          }
          prior.iterations[index] = saved;
        });
      }
      messages.set(id, prior);
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') tools.set(block.id, { name: block.name, input: block.input });
      if (block.type === 'tool_result') results.set(block.tool_use_id, block);
    }
  }
  const usage = Object.fromEntries(fields.map(field => [field, 0]));
  const models = {}, toolNames = {}, warnings = new Set();
  let estimatedApiUsd = 0, peakInputTokens = 0, longContextRequests = 0, unknownPrice = false, compactionIterations = 0;
  for (const message of messages.values()) {
    const iterations = message.iterations;
    compactionIterations += iterations.filter(i => i.type === 'compaction').length;
    const u = iterations.length ? Object.fromEntries(fields.map(field =>
      [field, iterations.reduce((sum, i) => sum + i.usage[field], 0)])) : message.usage;
    for (const field of fields) usage[field] += u[field];
    count(models, message.model || 'unknown');
    const inputSize = iterations.length ? Math.max(...iterations.map(i =>
      i.usage.input_tokens + i.usage.cache_creation_input_tokens + i.usage.cache_read_input_tokens)) :
      u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    peakInputTokens = Math.max(peakInputTokens, inputSize);
    const model = Object.keys(rates).find(key => message.model === key || message.model?.startsWith(`${key}-`));
    if (!model) { unknownPrice = true; warnings.add(`Unknown pricing: ${message.model}`); continue; }
    const long = model === 'claude-haiku-5-5' && inputSize > 100_000;
    if (long) longContextRequests++;
    // Do not fabricate per-iteration pricing when a threshold request spans multiple
    // billing phases or exports omit cache attribution. Keep usage, mark cost unknown.
    if (iterations.length > 1 || (iterations.length &&
      (message.usage.cache_creation_input_tokens > u.cache_creation_input_tokens ||
       message.usage.cache_read_input_tokens > u.cache_read_input_tokens))) {
      unknownPrice = true;
      warnings.add('Iteration usage counted; multi-phase/cache-attribution pricing requires verified API billing data');
      continue;
    }
    const multiplier = long ? 5 : 1, rate = rates[model];
    const hour = message.cache.ephemeral_1h_input_tokens || 0;
    const minute = message.cache.ephemeral_5m_input_tokens || 0;
    if (hour + minute > u.cache_creation_input_tokens) throw new Error('Cache TTL subtotals exceed cache creation');
    const unclassified = u.cache_creation_input_tokens - hour - minute;
    if (unclassified) warnings.add('Unclassified cache writes estimated at 5-minute rate');
    estimatedApiUsd += multiplier * (u.input_tokens * rate.input + (minute + unclassified) * rate.write +
      hour * rate.input * 2 + u.cache_read_input_tokens * rate.read + u.output_tokens * rate.output) / 1e6;
  }
  const workflow = [];
  let latestSource, chainMismatches = 0, capOverrides = 0;
  for (const [id, tool] of tools) {
    count(toolNames, tool.name);
    if (!tool.name?.includes('cdp-workflow')) continue;
    const result = results.get(id), content = result?.content;
    const texts = typeof content === 'string' ? [content] : (content || []).filter(x => x.type === 'text').map(x => x.text);
    let returned;
    for (const text of texts) { try { returned = JSON.parse(text); } catch { /* Non-JSON image metadata. */ } }
    const kind = tool.name.split('__').at(-1), action = returned?.value?.action;
    if (kind === 'act' && (!tool.input?.source || !latestSource || tool.input.source !== latestSource)) chainMismatches++;
    if (Object.hasOwn(tool.input || {}, 'maxElements')) capOverrides++;
    const source = returned?.value?.view?.source?.id;
    workflow.push({ kind, inputSource: tool.input?.source, returnedSource: source,
      textBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      code: action?.code, commandSucceeded: action?.commandSucceeded, actionDelivered: action?.actionDelivered,
      deliveryUnknown: action?.deliveryUnknown, omissions: returned?.value?.output,
      observationUnavailable: returned?.value?.observationUnavailable });
    if (source) latestSource = source;
  }
  const times = [...messages.values()].map(m => Date.parse(m.time)).filter(Number.isFinite);
  return { usage, processedTokens: Object.values(usage).reduce((a, b) => a + b, 0), models,
    estimatedApiUsd: unknownPrice ? null : estimatedApiUsd, pricingAsOf: '2026-10-07', warnings: [...warnings],
    peakInputTokens, longContextRequests, compactionBoundaries: boundaries.size, compactionIterations,
    elapsedSeconds: times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : null,
    toolCalls: tools.size, toolNames, toolErrors: [...results.values()].filter(r => r.is_error).length,
    chainMismatches, capOverrides, workflow };
}

// External verifier proof is required; a worker's self-reported PASS is insufficient.
export function verifiedOutcome(caseContract, proof, artifactExists = existsSync) {
  if (!proof || proof.verifier !== 'independent' || proof.caseId !== caseContract.id ||
      !proof.candidate || !proof.fixtureFingerprint) return false;
  return caseContract.requiredChecks.every(id => {
    const check = proof.checks?.find(c => c.id === id);
    return check?.passed === true && Array.isArray(check.artifacts) && check.artifacts.length > 0 &&
      check.artifacts.every(path => typeof path === 'string' && artifactExists(path));
  });
}

export function readiness(config, artifactExists = existsSync, fileHash = hash) {
  const blockers = [];
  for (const key of ['candidate', 'fixtureFingerprint', 'model', 'toolCommit', 'caseId']) {
    if (!config[key] || /[<>]/.test(config[key])) blockers.push(`Missing concrete ${key}`);
  }
  if (!Object.hasOwn(rates, config.model || '')) blockers.push('Pin a supported exact model ID');
  for (const key of ['fixtureReady', 'loginProven', 'cashierRoleProven', 'spaBootProven',
    'rqDevProven', 'receiptCaptureProven', 'exclusiveBrowserProven', 'verifierReady', 'stopBudgetEnforced']) {
    if (config[key] !== true) blockers.push(`${key} is not proven`);
  }
  const skill = config.skill;
  if (!skill?.canonical || !skill?.installed || !artifactExists(skill.canonical) || !artifactExists(skill.installed)) {
    blockers.push('Workflow skill files unavailable');
  } else if (fileHash(skill.canonical) !== fileHash(skill.installed)) blockers.push('Installed workflow skill differs from canonical');
  if (config.profileImplemented !== true) blockers.push('Requested compression profile is not implemented');
  return { ready: blockers.length === 0, blockers };
}

export function summarizeTrials(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = `${trial.model}/${trial.profile}`;
    const group = groups.get(key) || { key, attempts: 0, successes: 0, falsePasses: 0,
      failures: 0, blocked: 0, estimatedApiUsd: 0, pricingComplete: true, cohorts: {} };
    group.attempts++;
    count(group.cohorts, JSON.stringify([trial.caseId || 'unknown', trial.candidate || 'unknown', trial.fixtureFingerprint || 'unknown']));
    if (trial.verified === true) group.successes++; else group.failures++;
    if (trial.blocked) group.blocked++;
    if (trial.workerClaimedPass && !trial.verified) group.falsePasses++;
    if (Number.isFinite(trial.estimatedApiUsd) && trial.estimatedApiUsd >= 0) group.estimatedApiUsd += trial.estimatedApiUsd;
    else group.pricingComplete = false;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group,
    successRate: group.successes / group.attempts,
    costPerVerifiedSuccess: group.pricingComplete && group.successes ? group.estimatedApiUsd / group.successes : null }));
}

export function scoreRun(run, catalog, read = readFileSync, artifactExists = existsSync) {
  const contract = catalog.cases.find(c => c.id === run.caseId);
  if (!contract) throw new Error(`Unknown case ${run.caseId}`);
  if (!Array.isArray(run.transcripts) || run.transcripts.length === 0) throw new Error('Whole-run native transcripts required');
  if (run.transcripts.some(t => !t.path || !t.model || !['worker', 'supervisor'].includes(t.role))) {
    throw new Error('Each transcript needs path, role and exact expected model');
  }
  if (new Set(run.transcripts.map(t => resolve(t.path))).size !== run.transcripts.length) throw new Error('Duplicate transcript paths');
  const audits = run.transcripts.map(t => ({ ...auditNative(read(t.path, 'utf8')), role: t.role, path: t.path }));
  const identityMatches = run.transcripts.some(t => t.role === 'worker') && audits.every((a, index) => {
    const declared = run.transcripts[index];
    return (declared.role !== 'worker' || declared.model === run.model) && Object.keys(a.models).length > 0 &&
      Object.keys(a.models).every(m => m === declared.model || m.startsWith(`${declared.model}-`));
  });
  const proofMatches = run.proof?.candidate === run.candidate && run.proof?.fixtureFingerprint === run.fixtureFingerprint;
  const verified = identityMatches && proofMatches && verifiedOutcome(contract, run.proof, artifactExists);
  return { model: run.model, profile: run.profile, caseId: run.caseId, candidate: run.candidate,
    fixtureFingerprint: run.fixtureFingerprint, verified, workerClaimedPass: run.workerClaimedPass === true,
    blocked: run.blocked === true, identityMatches,
    estimatedApiUsd: audits.every(a => a.estimatedApiUsd !== null) ? audits.reduce((sum, a) => sum + a.estimatedApiUsd, 0) : null,
    audits };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...paths] = process.argv.slice(2);
    let result;
    if (command === 'audit' && paths.length === 1) result = auditNative(readFileSync(paths[0], 'utf8'));
    else if (command === 'preflight' && paths.length === 1) {
      result = readiness(json(paths[0]));
      if (!result.ready) process.exitCode = 2;
    } else if (command === 'score' && paths.length) {
      const catalog = json(resolve(dirname(fileURLToPath(import.meta.url)), 'cases.json'));
      const trials = paths.map(path => scoreRun(json(path), catalog));
      result = { trials, summary: summarizeTrials(trials) };
    } else throw new Error('Usage: gym.mjs audit transcript.jsonl | preflight fixture.json | score run.json ...');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
