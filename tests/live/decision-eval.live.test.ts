/** Controlled substrate eval: mock outputs are NOT Jev or LLM performance. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LiveChrome, startFixture, CdpSession, type LiveFixture } from './harness.js';
import { captureExpression } from '../../src/state/page-script.js';
import { diffStates } from '../../src/state/diff.js';
import type { PageState } from '../../src/state/types.js';
import { projectState, decideNext, expandState, type AgentView, type DecisionProvider, type Evidence, type Granularity, type RelevanceUnit, type AllowedAction } from '../../src/experimental/decision.js';
import { JevProvider } from '../../src/experimental/jev.js';
import { QwenRerankerProvider } from '../../src/experimental/qwen-reranker.js';
import { lunaSelect } from './luna-selector.js';
import { describeTarget, relocateTarget, verifyReplayEffect } from '../../src/experimental/replay.js';

const tasks = [
  { name: 'save', task: 'Save the order', target: 'save', mode: 'normal' },
  { name: 'synonym', task: 'Commit the order', target: 'save', mode: 'normal' },
  { name: 'row-alpha', task: 'Edit Alpha account', target: 'alpha-edit', mode: 'normal' },
  { name: 'row-beta', task: 'Edit Beta account', target: 'beta-edit', mode: 'normal' },
  { name: 'ambiguous', task: 'Edit account', target: null, mode: 'normal' },
  { name: 'error', task: 'Save the order', target: 'save', mode: 'error' },
  { name: 'focus', task: 'Save the order', target: 'save', mode: 'focus' },
  { name: 'dialog', task: 'Dismiss dialog', target: 'dismiss', mode: 'dialog' },
  { name: 'noop', task: 'Save the order', target: 'save', mode: 'noop' },
  { name: 'preexisting', task: 'Save the order', target: 'save', mode: 'preexisting' },
  { name: 'unmatched-clue', task: 'Remove the order', target: 'remove', mode: 'normal', clue: 'top|id:clue' },
  { name: 'reports', task: 'Open Reports', target: 'reports', mode: 'normal' }
];
const repeats = Number(process.env.CDP_DECISION_REPEATS ?? 3);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('INVALID_EVAL_REPEATS');
if (process.env.CDP_DECISION_GRANULARITY && !['node','chunk','region','hybrid'].includes(process.env.CDP_DECISION_GRANULARITY)) throw new Error('INVALID_EVAL_GRANULARITY');
const arms = (process.env.CDP_DECISION_ARMS ? process.env.CDP_DECISION_ARMS.split(',') : process.env.CDP_DECISION_LOCAL_URL ? ['baseline', 'deterministic', 'filter'] :
  ['baseline', 'deterministic', 'filter', 'action', 'filter-action']) as Array<'baseline' | 'deterministic' | 'filter' | 'action' | 'filter-action'>;
if (!arms.length || arms.some(a => !['baseline','deterministic','filter','action','filter-action'].includes(a))) throw new Error('INVALID_EVAL_ARMS');
const rows: any[] = [];
const dataset: any[] = [];
let chrome: LiveChrome;
let fixture: LiveFixture;
let session: CdpSession;

async function evaluate(expression: string): Promise<any> {
  const result = await session.command('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error('FIXTURE_EVALUATION_FAILED');
  return result.result.value;
}
async function capture(seq: number): Promise<{ state: PageState; hints: Evidence['hints'] }> {
  const raw = await evaluate(captureExpression({ ignore: [], maxElements: 2000, experimentalHints: true }));
  const elements = raw.elements.map(({ rawValue, ...e }: any) => ({ ...e, ...(rawValue !== undefined ? {
    value: { len: rawValue.length, h: createHash('sha256').update(rawValue).digest('hex').slice(0, 16) } } : {}) }));
  return { hints: raw.hints, state: { schema: 'cdp-cli.page-state/1', id: `s${seq}`, seq, capturedAt: '', targetId: 'fixture',
    captureProfile: 'fixture', url: 'http://fixture/workbench', title: raw.title, readyState: raw.readyState,
    focus: raw.focus, bodyTextHash: raw.bodyTextHash, nodeCount: raw.nodeCount, elements, coverage: raw.coverage,
    digest: createHash('sha256').update(JSON.stringify(elements)).digest('hex') } };
}

function pick(task: string, view: AgentView, actions: AllowedAction[]): string {
  const text = task.toLowerCase();
  const wanted = text.includes('commit') || text.includes('save') ? 'Save' : text.includes('remove') ? 'Remove' :
    text.includes('dismiss') ? 'Dismiss' : text.includes('reports') ? 'Reports' : 'Edit';
  const candidates = actions.filter(a => a.target && view.elements.some(e => e.k === a.target && e.name === wanted &&
    e.state?.vis !== false && (!text.includes('alpha') || e.context?.includes('Alpha')) && (!text.includes('beta') || e.context?.includes('Beta'))));
  return candidates.length === 1 ? candidates[0].id : 'escalate';
}
class MockProvider implements DecisionProvider {
  calls = 0; units = 0;
  async projectState(task: string, _view: AgentView, units: RelevanceUnit[]): Promise<string[]> {
    this.calls += Math.ceil(units.length / 6); this.units += units.length;
    const words = task.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    return units.filter(u => u.nodes.some(n => words.some(w => [n.k, n.name, n.text].join(' ').toLowerCase().includes(w)))).map(u => u.id);
  }
  async decideNext(task: string, view: AgentView, actions: AllowedAction[]) {
    this.calls++;
    return { actionId: pick(task, view, actions), confidence: .99, margin: .98 };
  }
}

beforeAll(async () => {
  const html = await readFile(resolve('evals/decision/fixtures/workbench.html'), 'utf8');
  fixture = await startFixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  chrome = await LiveChrome.launch();
  const page = await chrome.createPage(`${fixture.baseUrl}/workbench`);
  session = await CdpSession.connect(page.webSocketDebuggerUrl);
  await session.command('Runtime.enable');
}, 30_000);
afterAll(async () => {
  session?.close(); await chrome?.close(); await fixture?.close();
  if (process.env.CDP_DECISION_DATASET) await writeFile(process.env.CDP_DECISION_DATASET, `[\n${dataset.map(d=>JSON.stringify(d)).join(',\n')}\n]\n`);
  const path = process.env.CDP_DECISION_EVAL_METRICS;
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    const groups = [...new Set(rows.map(r => `${r.arm}/${r.granularity}`))];
    const byArm = Object.fromEntries(groups.map(group => {
      const subset = rows.filter(r => `${r.arm}/${r.granularity}` === group);
      const mean = (key: string) => +(subset.reduce((s, r) => s + r[key], 0) / subset.length).toFixed(3);
      const percentile = (p: number) => [...subset.map(r => r.projectionMs)].sort((a,b) => a-b)[Math.ceil(p*subset.length)-1];
      return [group, { runs: subset.length, meanBytes: Math.round(mean('bytes')),
        nextActionCorrect: subset.filter(r => r.correct).length, fixtureVerdictCorrect: subset.filter(r => r.verdictCorrect).length,
        wrongTargets: subset.filter(r => r.wrongTarget).length,
        semanticPasses: subset.filter(r => r.effect === 'PASSED').length, semanticFailures: subset.filter(r => r.effect === 'FAILED').length,
        escalations: subset.filter(r => r.escalate).length, hiddenClues: subset.filter(r => r.hiddenClue).length,
        falseNegativeTasks: subset.filter(r => r.falseNegative).length,
        missingSafeguards: subset.reduce((s,r) => s+r.missingSafeguards,0),
        mockCalls: subset.reduce((s, r) => s + r.mockCalls, 0), jevCalls: subset.reduce((s, r) => s + r.jevCalls, 0),
        localCalls: subset.reduce((s,r) => s+(r.localMetrics?.calls ?? 0),0),
        applied: subset.filter(r => r.providerStatus === 'applied').length, fallbacks: subset.filter(r => r.providerStatus === 'fallback').length,
        meanProviderCalls: mean('mockCalls') + mean('jevCalls') + subset.reduce((s,r) => s+(r.localMetrics?.calls ?? 0),0)/subset.length,
        projectionP50Ms: percentile(.5), projectionP95Ms: percentile(.95),
        meanPairedByteReductionPct: +(subset.reduce((s,r) => s + (1-r.bytes/rows.find(b => b.task===r.task && b.arm==='baseline').bytes)*100,0)/subset.length).toFixed(2),
        downstreamLLMCalls: process.env.CDP_DECISION_LUNA==='1' ? subset.filter(r=>r.lunaUsage).length : null,
        downstreamInputTokens: process.env.CDP_DECISION_LUNA==='1' ? subset.reduce((s,r)=>s+(r.lunaUsage?.input_tokens ?? 0),0) : null,
        downstreamOutputTokens: process.env.CDP_DECISION_LUNA==='1' ? subset.reduce((s,r)=>s+(r.lunaUsage?.output_tokens ?? 0),0) : null,
        providerModelTokens: process.env.CDP_DECISION_LOCAL_URL ? subset.reduce((s,r) => s+(r.localMetrics?.inputTokens ?? 0),0) :
          process.env.CDP_DECISION_REAL_JEV === '1' && subset.every(r=>r.modelTokens!==null) ? subset.reduce((s, r) => s + r.modelTokens, 0) : null }];
    }));
    const header = JSON.stringify({ schema: 1, provider: process.env.CDP_DECISION_LOCAL_URL ? 'qwen3-reranker-0.6b' : process.env.CDP_DECISION_REAL_JEV === '1' ? 'jev-1.13.0' : 'mock-lexical',
      downstream: process.env.CDP_DECISION_LUNA==='1' ? 'gpt-6-luna/Codex CLI bounded selector' : 'scripted',
      warning: 'Controlled synthetic substrate eval. Single-step fixture outcomes; not multi-step browser-agent task completion or cost evidence.',
      byArm }, null, 2);
    await writeFile(path, `${header.slice(0, -2)},\n  "rows": [\n${rows.map(r => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`);
  }
}, 30_000);

describe('decision projection controlled browser eval', () => {
  for (const task of tasks) it(task.name, async () => {
    for (let repeat = 0; repeat < repeats; repeat++) {
    await evaluate(`window.resetFixture(${JSON.stringify(task.mode)})`);
    const initial = await capture(1);
    // A changed non-task clue plus a removed node is protected independently of lexical relevance.
    const previous: PageState = { ...initial.state, id: 's0', seq: 0,
      elements: [...initial.state.elements.map(e => e.k === 'top|id:clue' ? { ...e, text: 'Old account state' } : e),
        { k: 'top|id:gone', kq: 'strong', role: 'text', text: 'Pending authorization' }] };
    const evidence: Evidence = { hints: initial.hints,
      ...(task.name === 'error' ? { diff: diffStates(previous, initial.state), errors: [{ source: 'console', message: 'Fixture error' }] } : {}) };
    if (repeat===0) dataset.push({ task, state: initial.state, evidence });
    const actions: AllowedAction[] = initial.state.elements.filter(e => e.role === 'button' && e.state?.vis !== false)
      .map(e => ({ id: e.k, kind: 'click', target: e.k, description: e.name ?? e.k }));
    actions.push({ id: 'escalate', kind: 'escalate', description: 'Ambiguous or insufficient evidence' });
    const orderedArms = [...arms].sort((a,b) => createHash('sha256').update(`${task.name}/${repeat}/${a}`).digest('hex')
      .localeCompare(createHash('sha256').update(`${task.name}/${repeat}/${b}`).digest('hex')));
    for (const arm of orderedArms) for (const granularity of (arm.includes('filter') ?
      (process.env.CDP_DECISION_GRANULARITY ? [process.env.CDP_DECISION_GRANULARITY] : ['node', 'chunk', 'region', 'hybrid']) : ['node']) as Granularity[]) {
      await evaluate(`window.resetFixture(${JSON.stringify(task.mode)})`);
      const mock = new MockProvider();
      const real = process.env.CDP_DECISION_REAL_JEV === '1' ? new JevProvider() : undefined;
      const local = process.env.CDP_DECISION_LOCAL_URL ? new QwenRerankerProvider({ url: process.env.CDP_DECISION_LOCAL_URL,
        timeoutMs: Number(process.env.CDP_DECISION_LOCAL_TIMEOUT ?? 5000), classifier: process.env.CDP_DECISION_CLASSIFIER === '1' }) : undefined;
      const provider = local ?? real ?? mock;
      const start = performance.now();
      const canonicalCopy = JSON.stringify(initial.state);
      const view = await projectState(task.task, initial.state, { ...evidence, prune: arm !== 'baseline' && arm !== 'action',
        provider: arm.includes('filter') ? provider : undefined, granularity });
      const projectionMs = performance.now() - start;
      const filtered = arm.includes('filter');
      const hiddenClue = Boolean(task.clue && !view.elements.some(e => e.k === task.clue));
      const protectedGold = ['top|id:reference','top|id:approved','top|id:method','top|id:result','top|id:warning','top|id:modal'];
      const missingSafeguards = protectedGold.filter(k => !view.elements.some(e => e.k===k)).length;
      let decision;
      let luna;
      const actionStart = performance.now();
      if (arm.includes('action')) decision = await decideNext(task.task, view, actions, provider);
      else {
        luna = process.env.CDP_DECISION_LUNA==='1' ? await lunaSelect(task.task, view, actions) : undefined;
        const id = luna?.id ?? pick(task.task, view, actions);
        const candidate = actions.find(a => a.id===id);
        const node = candidate?.target ? view.elements.find(e => e.k===candidate.target) : undefined;
        const unavailable = candidate?.target && (!node || node.kq!=='strong' || node.state?.vis===false || node.state?.en===false);
        decision = { action: unavailable ? undefined : candidate, escalate: Boolean(unavailable) || id === 'escalate' };
      }
      const actionMs = performance.now() - actionStart;
      const actualId = decision.action?.target?.split('id:').at(-1)?.split('>').at(0) ?? null;
      const correct = actualId === task.target;
      const expectedTargetKey = initial.state.elements.find(e => e.k.endsWith(`id:${task.target}`))?.k;
      const falseNegative = hiddenClue || Boolean(expectedTargetKey && !view.elements.some(e => e.k===expectedTargetKey));
      const relevantGold = [...new Set([...protectedGold, ...(expectedTargetKey ? [expectedTargetKey] : []), ...(task.clue ? [task.clue] : [])])];
      // Execute only an exact, unique DOM id in the controlled fixture. Production input remains untouched.
      if (actualId) await evaluate(`(() => { const nodes=document.querySelectorAll('#'+CSS.escape(${JSON.stringify(actualId)}));
        if(nodes.length!==1)throw Error('AMBIGUOUS');nodes[0].click(); })()`);
      const after = await capture(2);
      const effect = decision.escalate ? 'UNKNOWN' : verifyReplayEffect(initial.state, after.state,
        { mustChange: [{ key: 'top|id:result', field: 'name' }] }).outcome;
      const oracle = await evaluate('({clicked:window.clicked,effectCount:window.effectCount})');
      const wrongTarget = oracle.clicked !== null && oracle.clicked !== task.target;
      const verdictCorrect = correct && !hiddenClue && (decision.escalate ? task.target === null :
        effect === (task.mode === 'noop' || task.mode === 'preexisting' ? 'FAILED' : 'PASSED'));
      const bytes = Buffer.byteLength(JSON.stringify(view));
      rows.push({ task: task.name, repeat, arm, granularity, bytes, estimatedTextTokens: Math.ceil(bytes / 4),
        stateLines: view.elements.length, canonicalLines: initial.state.elements.length,
        relevantNodes: relevantGold.length, relevantNodesRetained: relevantGold.filter(k => view.elements.some(e => e.k===k)).length,
        canonicalBytes: Buffer.byteLength(canonicalCopy), correct, verdictCorrect, wrongTarget, escalate: decision.escalate, effect, oracle,
        hiddenClue, falseNegative, missingSafeguards, omitted: view.omitted.count,
        projectionMs: +projectionMs.toFixed(3), actionMs: +actionMs.toFixed(3), decisionPathMs: +(projectionMs + actionMs).toFixed(3),
        lunaUsage: luna?.usage ?? null,
        mockCalls: real || local ? 0 : mock.calls, jevCalls: real?.metrics.calls ?? 0, localMetrics: local?.metrics,
        modelTokens: real && !real.metrics.missingUsageCalls ? real.metrics.inputTokens + real.metrics.outputTokens : null,
        providerStatus: view.providerStatus, oracleExpansionRequests: hiddenClue ? 1 : 0 });
      expect(JSON.stringify(initial.state)).toBe(canonicalCopy);
      if (!luna) expect(wrongTarget).toBe(false);
      expect(missingSafeguards).toBe(0);
      if (!real && !filtered && !luna) expect(correct).toBe(true);
      if (task.mode === 'noop' || task.mode === 'preexisting') expect(effect).not.toBe('PASSED');
      if (task.name === 'error') {
        expect(view.elements.some(e => e.k === 'top|id:clue')).toBe(true);
        expect(view.diff!.changes.some(c => c.key === 'top|id:gone')).toBe(true);
        expect(view.errors).toHaveLength(1);
      }
      if (filtered && !real && !local && task.clue) expect(expandState(view, initial.state, [task.clue])).toHaveLength(1);
    }
    }
  }, Number(process.env.CDP_DECISION_TASK_TIMEOUT ?? 60_000));
  it('stale same-session recovery and ambiguous relocation', async () => {
    await evaluate('window.resetFixture("normal")');
    const { state, hints } = await capture(1);
    const e = state.elements.find(e => e.k === 'top|row:Beta>id:beta-edit')!;
    expect(e).toBeDefined();
    const target = describeTarget(e, hints?.[e.k]?.context);
    await evaluate('document.querySelector("#beta-edit").id="beta-replacement"');
    const fresh = await capture(2);
    const context = Object.fromEntries(Object.entries(fresh.hints ?? {}).map(([k, v]) => [k, v.context ?? []]));
    expect(relocateTarget(target, fresh.state, context).stage).toBe('semantic');
    const replacement = fresh.state.elements.find(e => e.k.includes('beta-replacement'))!;
    expect(relocateTarget(target, { ...fresh.state, elements: [...fresh.state.elements, { ...replacement, k: 'top|duplicate' }] },
      { ...context, 'top|duplicate': hints?.[e.k]?.context ?? [] }).reason).toBe('ambiguous');
  });
});
