/** Opt-in routing experiment. Produces proposals only; execution/effect verification remain separate. */
import { projectState, decideNext, type AllowedAction, type DecisionProvider, type DecisionScreenshot, type Evidence } from './decision.js';
import { relocateTarget, type SemanticTarget } from './replay.js';
import type { PageState } from '../state/types.js';

export async function routeNext(task: string, state: PageState, allowed: AllowedAction[], options: {
  replay?: { target: SemanticTarget; kind: AllowedAction['kind'] }; evidence?: Evidence;
  projection?: DecisionProvider; localVision?: DecisionProvider; paid?: DecisionProvider; browserAgent?: DecisionProvider;
  needsVision?: boolean; screenshot?: DecisionScreenshot;
} = {}) {
  const trace: Array<{ stage: string; reason: string; ms: number }> = [];
  if (new Set(allowed.map(a=>a.id)).size!==allowed.length || allowed.some(a=>!a.id ||
    (['click','type','select'].includes(a.kind) && !a.target)) || new Set(state.elements.map(e=>e.k)).size!==state.elements.length) {
    return { stage: 'diagnostic', trace: [{ stage: 'candidates', reason: 'invalid-or-duplicate-identity', ms: 0 }] };
  }
  if (options.replay) {
    const started = performance.now();
    const contexts = Object.fromEntries(Object.entries(options.evidence?.hints ?? {}).map(([k,v]) => [k,v.context ?? []]));
    const relocated = relocateTarget(options.replay.target, state, contexts);
    trace.push({ stage: relocated.stage==='exact' ? 'replay' : 'semantic-relocation', reason: relocated.reason ?? relocated.stage, ms: performance.now()-started });
    if (relocated.key) {
      const actions = allowed.filter(a => a.target===relocated.key && a.kind===options.replay!.kind);
      if (actions.length===1) return { stage: relocated.stage==='exact' ? 'replay' : 'semantic-relocation', action: structuredClone(actions[0]), trace };
    }
    if (relocated.reason==='ambiguous' || relocated.reason==='incomplete-coverage') return { stage: 'diagnostic', trace };
  }
  const started = performance.now();
  const view = await projectState(task, state, { ...options.evidence,
    targets: [...(options.evidence?.targets ?? []), ...(options.replay ? [options.replay.target.key] : [])],
    provider: options.projection, granularity: 'region' });
  trace.push({ stage: 'local-projection', reason: view.providerStatus, ms: performance.now()-started });
  const stages: Array<[string, DecisionProvider | undefined]> = [
    ['local-vision', options.needsVision && options.screenshot ? options.localVision : undefined],
    ['paid-decision', options.paid], ['browser-agent', options.browserAgent]
  ];
  for (const [stage, provider] of stages) {
    if (!provider) continue;
    const start = performance.now();
    const result = await decideNext(task, view, allowed, provider, undefined, options.needsVision ? options.screenshot : undefined);
    trace.push({ stage, reason: result.reason, ms: performance.now()-start });
    if (result.action && !result.escalate) return { stage, action: result.action, view, trace };
  }
  return { stage: 'diagnostic', view, trace };
}
