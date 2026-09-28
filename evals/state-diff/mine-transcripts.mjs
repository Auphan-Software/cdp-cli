#!/usr/bin/env node
/**
 * E1 — transcript mining baseline for the page-state snapshot/diff proposal (wi:7792).
 *
 * Reads exported Claude transcripts (Jarvis `logs/transcripts/*.md`), rebuilds every browser
 * "episode" (one cdp-cli action followed by the observations the agent used to judge it), and
 * measures what verification costs today and which failure classes a structured state diff would
 * have to handle. It never contacts a browser and never writes outside --out.
 *
 * Usage:
 *   node evals/state-diff/mine-transcripts.mjs --transcripts Q:/apps/jarvis/logs/transcripts --out evals/state-diff/out
 *   node evals/state-diff/mine-transcripts.mjs --self-test
 *
 * Transcript shape (Jarvis exporter): YAML front matter (date, project, session_id), `## User` /
 * `## Claude` sections, `<tool-call tool="X">{json}</tool-call>` and an optional following
 * `<tool-result>…</tool-result>`. Image reads have no result block. Codex exports carry no tool
 * calls and are skipped.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ACTION_VERBS = new Set([
  'click', 'fill', 'select', 'press-key', 'drag', 'navigate', 'new-page', 'dismiss-overlays',
  'target-fill', 'target-press-key', 'dialog'
]);
const OBSERVE_VERBS = new Set([
  'eval', 'query', 'snapshot', 'screenshot', 'logs', 'list-console', 'list-network', 'styles',
  'page-health', 'wait', 'network-detail', 'logs-detail', 'target-query', 'target-eval', 'diagnose'
]);
// eval/target-eval expressions that change the page are actions, not observations.
const EVAL_ACTION = /\.click\(\)|\.value\s*=[^=]|dispatchEvent|\.submit\(\)|location\.(reload|assign|replace)|location\.href\s*=[^=]|\.checked\s*=[^=]|\.selectedIndex\s*=[^=]/;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const DB_CHECK = /\bpsql\b|store-api\.sh\s+query|\bmysql\b/;
const NOOP_TEXT = /nothing (happened|changed)|didn'?t (change|do anything|work|open|respond|navigate|fire|trigger)|did not (open|change|navigate|respond|fire|trigger)|no (visible |observable )?(change|effect|response)|still (shows|showing|on the same|the same|displays)|unchanged/i;
const DIALOG = /"code":"[A-Z_]*DIALOG[A-Z_]*"|JavaScript dialog|beforeunload/;
const MAX_WINDOW_CALLS = 12;
const CHARS_PER_TOKEN = 4;
const DEFAULT_IMAGE_TOKENS = 1049; // 1024x768 / 750

// ---------------------------------------------------------------- parsing

export function parseTranscript(text, file = '(inline)') {
  const front = {};
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) front[m[1]] = m[2].replace(/^"|"$/g, '');
    }
  }
  const events = [];
  const re = /<tool-call tool="([^"]+)">\r?\n([\s\S]*?)\r?\n<\/tool-call>|<tool-result>\r?\n?([\s\S]*?)<\/tool-result>|^## (User|Claude)\s*$/gm;
  let m;
  let lastProseEnd = 0;
  const lineAt = buildLineIndex(text);
  while ((m = re.exec(text)) !== null) {
    const prose = text.slice(lastProseEnd, m.index);
    lastProseEnd = re.lastIndex;
    if (m[4]) {
      events.push({ kind: 'turn', role: m[4], line: lineAt(m.index) });
      continue;
    }
    if (prose.trim()) events.push({ kind: 'prose', text: prose, line: lineAt(m.index) });
    if (m[1] !== undefined) {
      events.push({ kind: 'call', tool: m[1], input: parseInput(m[2]), line: lineAt(m.index) });
    } else {
      const prev = events[events.length - 1];
      if (prev && prev.kind === 'call' && prev.result === undefined) prev.result = m[3];
      else events.push({ kind: 'orphan-result', text: m[3], line: lineAt(m.index) });
    }
  }
  return { file, front, events };
}

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

function parseInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // The exporter truncates very long inputs; recover the fields we need.
    const out = {};
    const cmd = raw.match(/"command":\s*"((?:[^"\\]|\\.)*)/);
    if (cmd) out.command = cmd[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const fp = raw.match(/"file_path":\s*"((?:[^"\\]|\\.)*)"/);
    if (fp) out.file_path = fp[1].replace(/\\\\/g, '\\');
    out._truncated = true;
    return out;
  }
}

/** Split one shell command into its cdp-cli invocations: [{verb, args, isAction}]. */
export function cdpInvocations(command) {
  if (typeof command !== 'string') return [];
  const out = [];
  const re = /(?:^|[\s(`$])(?:npx\s+(?:--no-install\s+)?)?cdp-cli(?:\.exe|\.cmd)?\s+([a-z][a-z-]*)([\s\S]*)/;
  for (const segment of shellSegments(command)) {
    const m = segment.match(re);
    if (!m) continue;
    const verb = m[1];
    const args = m[2];
    let isAction = ACTION_VERBS.has(verb);
    if ((verb === 'eval' || verb === 'target-eval') && EVAL_ACTION.test(args)) isAction = true;
    if (verb === 'dialog' && !/--(accept|dismiss)/.test(args)) isAction = false;
    if (!isAction && !OBSERVE_VERBS.has(verb)) continue; // lifecycle/status/etc.
    out.push({ verb, args: args.trim(), isAction });
  }
  return out;
}

/** Split on unquoted `;`, `&&`, `||`, `|` and newlines so quoted JS expressions stay whole. */
export function shellSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { cur += ch + command[++i]; continue; }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      if (ch === '&' || (ch === '|' && command[i + 1] === '|')) i++;
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- classification

function classifyCall(ev) {
  if (ev.kind !== 'call') return null;
  if (ev.tool === 'Read' && IMAGE_FILE.test(ev.input?.file_path ?? '')) {
    return { type: 'image', path: ev.input.file_path };
  }
  if (ev.tool !== 'Bash' && ev.tool !== 'PowerShell') return { type: 'other' };
  const cmd = ev.input?.command ?? '';
  const inv = cdpInvocations(cmd);
  const db = DB_CHECK.test(cmd);
  const sleep = /(?:^|[\s;&])sleep\s+\d|Start-Sleep/.test(cmd);
  const runner = /browser-qa-run/.test(cmd);
  if (inv.length === 0) {
    if (db) return { type: 'db', sleep };
    if (runner) return { type: 'runner' };
    if (sleep && cmd.replace(/sleep\s+[\d.]+/g, '').trim().length < 4) return { type: 'sleep' };
    return { type: 'other' };
  }
  return { type: 'cdp', inv, db, sleep, cmd };
}

/** Walk events into action→observation episodes. */
export function episodes(parsed) {
  const out = [];
  const ev = parsed.events;
  for (let i = 0; i < ev.length; i++) {
    const c = classifyCall(ev[i]);
    if (!c || c.type !== 'cdp') continue;
    const lastAction = findLastIndex(c.inv, x => x.isAction);
    if (lastAction === -1) continue;

    const ep = {
      file: basename(parsed.file),
      session: parsed.front.session_id ?? null,
      project: parsed.front.project ?? null,
      date: parsed.front.date ?? null,
      line: ev[i].line,
      actions: c.inv.filter(x => x.isAction).map(x => x.verb),
      actionArgs: c.inv.filter(x => x.isAction).map(x => x.args.slice(0, 160)),
      waitFlags: /--wait-for/.test(c.cmd),
      errors: errorCodes(ev[i].result),
      obs: {},
      obsCalls: 0,
      obsChars: 0,
      images: 0,
      imageTokens: 0,
      dbChecks: 0,
      sleeps: c.sleep ? 1 : 0,
      frame: /--frame/.test(c.cmd),
      prose: '',
      labels: []
    };
    // Observations chained in the same call after the last action.
    const sameCall = c.inv.slice(lastAction + 1).filter(x => !x.isAction);
    for (const o of sameCall) addObs(ep, o, 0);
    if (sameCall.length) ep.obsChars += (ev[i].result ?? '').length; // shared result: attribute to observation
    if (c.db) ep.dbChecks++;

    let calls = 0;
    let j = i + 1;
    for (; j < ev.length && calls < MAX_WINDOW_CALLS; j++) {
      const e = ev[j];
      if (e.kind === 'turn' && e.role === 'User') break;
      if (e.kind === 'prose') { ep.prose += e.text; continue; }
      if (e.kind !== 'call') continue;
      const k = classifyCall(e);
      if (k.type === 'cdp') {
        if (k.inv.some(x => x.isAction)) break;
        calls++;
        ep.obsCalls++;
        for (const o of k.inv) addObs(ep, o, 0);
        ep.obsChars += (e.result ?? '').length;
        if (k.sleep) ep.sleeps++;
        if (k.db) ep.dbChecks++;
        if (/--frame/.test(k.cmd)) ep.frame = true;
        ep.errors.push(...errorCodes(e.result));
      } else if (k.type === 'image') {
        calls++;
        ep.obsCalls++;
        ep.images++;
        ep.imageTokens += imageTokens(k.path);
      } else if (k.type === 'db') {
        calls++;
        ep.dbChecks++;
        if (k.sleep) ep.sleeps++;
      } else if (k.type === 'sleep') {
        calls++;
        ep.sleeps++;
      } else {
        break; // agent left the browser (edit, grep, git…): verification window over
      }
    }
    ep.windowEndLine = j < ev.length ? ev[j].line : null;
    label(ep, ev[i]);
    ep.prose = ep.prose.replace(/\s+/g, ' ').trim().slice(0, 400);
    out.push(ep);
  }
  return out;
}

function addObs(ep, o) {
  ep.obs[o.verb] = (ep.obs[o.verb] ?? 0) + 1;
  if (o.verb === 'eval' && /JSON\.stringify|innerText|innerHTML|textContent|querySelectorAll/.test(o.args)) {
    ep.obs['eval:dom-dump'] = (ep.obs['eval:dom-dump'] ?? 0) + 1;
  }
}

function errorCodes(result) {
  if (!result) return [];
  return [...result.matchAll(/"code":"([A-Z_]+)"/g)].map(m => m[1]);
}

function findLastIndex(arr, fn) {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i;
  return -1;
}

function label(ep, actionEvent) {
  const L = new Set();
  for (const code of ep.errors) if (/^(CLICK|FILL|SELECT|DRAG|PRESS)_/.test(code)) L.add(`action-error:${code}`);
  if (ep.errors.some(c => /DIALOG/.test(c)) || DIALOG.test(actionEvent.result ?? '')) L.add('dialog');
  if (NOOP_TEXT.test(ep.prose)) L.add('noop-suspected');
  if (ep.frame) L.add('frame');
  if (ep.sleeps > 0) L.add('sleep-wait');
  if (ep.obs.logs || ep.obs['list-console']) L.add('console-check');
  if (ep.obs['list-network'] || ep.obs['network-detail']) L.add('network-check');
  if (ep.obs['eval:dom-dump']) L.add('dom-dump');
  if (ep.dbChecks) L.add('db-check');
  const obsKinds = Object.keys(ep.obs).filter(k => !k.includes(':'));
  if (ep.images && obsKinds.every(k => k === 'screenshot')) L.add('screenshot-only');
  if (ep.images) L.add('image-viewed');
  if (ep.obsCalls >= 3) L.add('reobserve-3plus');
  if (ep.obsCalls === 0 && Object.keys(ep.obs).length === 0 && !ep.dbChecks) L.add('unverified');
  ep.labels = [...L];
}

// PNG IHDR → Claude image token estimate (long edge capped at 1568 px, tokens ≈ w*h/750).
function imageTokens(path) {
  try {
    const p = path.replace(/\\/g, '/');
    if (!existsSync(p) || !/\.png$/i.test(p)) return DEFAULT_IMAGE_TOKENS;
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(24);
    readSync(fd, buf, 0, 24, 0);
    closeSync(fd);
    let w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const scale = Math.min(1, 1568 / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    return Math.min(1600, Math.ceil((w * h) / 750));
  } catch {
    return DEFAULT_IMAGE_TOKENS;
  }
}

// ---------------------------------------------------------------- aggregation

export function aggregate(eps) {
  const n = eps.length;
  const sum = (f) => eps.reduce((a, e) => a + f(e), 0);
  const pct = (x) => (n ? +(100 * x / n).toFixed(1) : 0);
  const labelCounts = {};
  for (const e of eps) for (const l of e.labels) labelCounts[l] = (labelCounts[l] ?? 0) + 1;
  const obsVerbs = {};
  for (const e of eps) for (const [k, v] of Object.entries(e.obs)) obsVerbs[k] = (obsVerbs[k] ?? 0) + v;
  const obsTextTokens = sum(e => e.obsChars / CHARS_PER_TOKEN);
  const imgTokens = sum(e => e.imageTokens);
  const byProject = {};
  for (const e of eps) {
    const p = (byProject[e.project] ??= { episodes: 0, obsCalls: 0, images: 0 });
    p.episodes++; p.obsCalls += e.obsCalls; p.images += e.images;
  }
  // Counterfactual: a diff summary + a few change lines ≈ DIFF_TOKENS, and the observation calls it
  // replaces collapse into the action call. Lower bound replaces only DOM-dump evals and repeats
  // beyond the first observation; upper bound replaces every DOM/eval/query/snapshot/screenshot
  // observation except DB checks. Neither counts the per-turn context re-read, which dominates real
  // cost and is proportional to obsCalls.
  const DIFF_TOKENS = 400;
  const upperSaved = sum(e => Math.max(0, e.obsChars / CHARS_PER_TOKEN + e.imageTokens - (e.obsCalls ? DIFF_TOKENS : 0)));
  const lowerSaved = sum(e => {
    const extra = Math.max(0, e.obsCalls - 1);
    const perCall = e.obsCalls ? (e.obsChars / CHARS_PER_TOKEN) / e.obsCalls : 0;
    return (e.labels.includes('dom-dump') ? perCall : 0) + extra * perCall;
  });
  return {
    episodes: n,
    sessions: new Set(eps.map(e => e.session)).size,
    actionVerbs: countBy(eps.flatMap(e => e.actions)),
    observation: {
      callsPerEpisodeMean: +(sum(e => e.obsCalls) / (n || 1)).toFixed(2),
      callsPerEpisodeP90: percentile(eps.map(e => e.obsCalls), 90),
      verbs: obsVerbs,
      textTokensTotal: Math.round(obsTextTokens),
      textTokensPerEpisodeMean: Math.round(obsTextTokens / (n || 1)),
      imageViews: sum(e => e.images),
      imageTokensTotal: imgTokens,
      episodesWithImagePct: pct(eps.filter(e => e.images).length)
    },
    labels: Object.fromEntries(Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { count: v, pct: pct(v) }])),
    counterfactual: {
      assumedDiffTokens: DIFF_TOKENS,
      tokensSavedLowerBound: Math.round(lowerSaved),
      tokensSavedUpperBound: Math.round(upperSaved),
      observationCallsRemovableUpperBound: sum(e => Math.max(0, e.obsCalls - e.dbChecks))
    },
    byProject
  };
}

function countBy(xs) {
  const o = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
}

function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// Deterministic stratified sample for manual labelling: up to `per` episodes per label.
export function sample(eps, per = 4, seed = 7792) {
  let x = seed;
  const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const chosen = new Map();
  const labels = [...new Set(eps.flatMap(e => e.labels))].sort();
  for (const l of labels) {
    const pool = eps.filter(e => e.labels.includes(l));
    for (let k = 0; k < per && pool.length; k++) {
      const e = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      chosen.set(`${e.file}:${e.line}`, { ...e, sampledFor: l });
    }
  }
  return [...chosen.values()];
}

function sampleMarkdown(rows, transcriptsDir) {
  const lines = [
    '# E1 manual-label sample (wi:7792)',
    '',
    'For each episode open the transcript at the line and fill the three judgement columns:',
    '- **diff answers?** would a `state diff` (controls, text regions, dialogs, console, network) have told the agent what it needed? y/n/partial',
    '- **needs pixels?** did the judgement genuinely need a screenshot (layout, colour, canvas, visual evidence)? y/n',
    '- **label ok?** is the heuristic label correct? y/n',
    '',
    '| # | sampled for | transcript:line | actions | obs calls | images | labels | diff answers? | needs pixels? | label ok? |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ];
  rows.forEach((e, i) => {
    lines.push(`| ${i + 1} | ${e.sampledFor} | ${join(transcriptsDir, e.file).replace(/\\/g, '/')}:${e.line} | ${e.actions.join(',')} | ${e.obsCalls} | ${e.images} | ${e.labels.join(' ')} |  |  |  |`);
  });
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const args = Object.fromEntries(argv.reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []));
  if (args['self-test']) return selfTest();
  if (!args.transcripts || !args.out) {
    throw new Error('Usage: mine-transcripts.mjs --transcripts <dir> --out <dir> [--since YYYY-MM-DD]');
  }
  const files = readdirSync(args.transcripts).filter(f => f.endsWith('.md') && !f.startsWith('codex-'));
  const all = [];
  let scanned = 0;
  for (const f of files) {
    const text = readFileSync(join(args.transcripts, f), 'utf8');
    if (!text.includes('cdp-cli')) continue;
    scanned++;
    all.push(...episodes(parseTranscript(text, f)));
  }
  if (all.length === 0) throw new Error(`No episodes found in ${args.transcripts}: parser or corpus is broken`);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'episodes.ndjson'), all.map(e => JSON.stringify(e)).join('\n') + '\n');
  const metrics = { generatedAt: new Date().toISOString(), transcriptsDir: args.transcripts, filesWithCdp: scanned, ...aggregate(all) };
  writeFileSync(join(args.out, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  writeFileSync(join(args.out, 'sample.md'), sampleMarkdown(sample(all), args.transcripts));
  console.log(JSON.stringify({ success: true, filesWithCdp: scanned, episodes: all.length, out: args.out }));
}

function selfTest() {
  const fixture = readFileSync(join(HERE, 'fixtures', 'transcript-cert-interstitial.md'), 'utf8');
  const eps = episodes(parseTranscript(fixture, 'fixture.md'));
  const fail = (msg) => { throw new Error(`self-test: ${msg}\n${JSON.stringify(eps, null, 2)}`); };
  if (eps.length !== 4) fail(`expected 4 episodes, got ${eps.length}`);
  if (!eps[0].labels.includes('action-error:CLICK_NOT_FOUND')) fail('episode 1 must carry CLICK_NOT_FOUND');
  if (!eps[1].labels.includes('action-error:CLICK_NO_HITBOX')) fail('episode 2 must carry CLICK_NO_HITBOX');
  if (!eps[2].labels.includes('sleep-wait')) fail('episode 3 must carry sleep-wait');
  if (eps[2].actions.join(',') !== 'click,eval') fail(`episode 3 actions: ${eps[2].actions}`);
  if (!eps[3].labels.includes('image-viewed') || eps[3].images !== 1) fail('episode 4 must count one image view');
  if (!eps[3].labels.includes('noop-suspected')) fail('episode 4 prose says nothing changed');
  if (cdpInvocations("cdp-cli eval 'document.title' P").some(x => x.isAction)) fail('read-only eval classified as action');
  if (!cdpInvocations("cdp-cli eval \"b.click()\" P")[0].isAction) fail('eval .click() must be an action');
  console.log(JSON.stringify({ success: true, selfTest: 'passed', episodes: eps.length }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\//g, process.platform === 'win32' ? '\\' : '/')) {
  main(process.argv.slice(2));
}
