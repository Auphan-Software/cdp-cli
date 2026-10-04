/** Experimental, opt-in projections. Never use these views as canonical snapshots. */
import type { PageState, StateDiff, StateElement } from '../state/types.js';

export type Granularity = 'node' | 'chunk' | 'region' | 'hybrid';
export interface ElementHint { region?: string; parents?: string[]; context?: string[]; live?: boolean; editable?: boolean }
export interface Evidence {
  diff?: StateDiff;
  targets?: string[];
  hints?: Record<string, ElementHint>;
  errors?: Array<{ source: 'browser' | 'console' | 'network'; message: string }>;
}
export interface AgentNode { k: string; kq: StateElement['kq']; role: string; name?: string; text?: string; value?: StateElement['value']; state?: StateElement['state']; context?: string[] }
export interface AgentView {
  source: { id: string; digest: string; targetId: string; session?: string };
  url: string; title: string; coverage: PageState['coverage']; focus?: string; dialog?: PageState['dialog'];
  elements: AgentNode[]; diff?: StateDiff; errors: NonNullable<Evidence['errors']>;
  omitted: { count: number; expand: { sourceId: string; sourceDigest: string } };
  providerStatus: 'unused' | 'applied' | 'fallback';
}
export interface RelevanceUnit { id: string; keys: string[]; nodes: AgentNode[] }
export interface AllowedAction { id: string; kind: 'click' | 'type' | 'select' | 'scroll' | 'back' | 'continue' | 'retry' | 'escalate'; target?: string; description: string }
export interface Decision { actionId: string; confidence: number; margin: number; executionQualified?: boolean }
export interface DecisionScreenshot {
  source: AgentView['source']; width: number; height: number; mimeType: 'image/png'; data: string;
}
/** Providers propose; deterministic code validates. Neither method executes browser actions. */
export interface DecisionProvider {
  projectState(task: string, state: AgentView, units: RelevanceUnit[]): Promise<string[]>;
  decideNext(task: string, state: AgentView, allowedActions: AllowedAction[], screenshot?: DecisionScreenshot): Promise<Decision>;
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'please', 'click', 'verify', 'check', 'open']);
export function mustKeep(task: string, state: PageState, evidence: Evidence = {}): Set<string> {
  const terms = words(task).filter(w => !stop.has(w));
  const keep = new Set([...(evidence.targets ?? []), ...(state.focus ? [state.focus] : []),
    ...(evidence.diff?.changes.flatMap(c => c.key ? [c.key] : []) ?? [])]);
  for (const e of state.elements) {
    const s = e.state ?? {};
    const hint = evidence.hints?.[e.k];
    const text = [e.k, e.name, e.text, ...(hint?.context ?? [])].join(' ').toLowerCase();
    if (/^(alert|status|log|dialog|alertdialog|textbox|combobox|searchbox|spinbutton)$/.test(e.role) ||
      /\b(error|failed|failure|invalid|denied|unavailable)\b/i.test(text) || hint?.live || hint?.editable ||
      e.value !== undefined || s.focused === true || s.invalid === true || s.checked !== undefined || s.selected !== undefined ||
      s.ariaChecked !== undefined || s.pressed !== undefined || s.current !== undefined ||
      terms.some(term => words(text).includes(term))) keep.add(e.k);
  }
  // Parent closure protects disambiguating context even if the provider rejects it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...keep]) for (const parent of evidence.hints?.[key]?.parents ?? []) {
      if (!keep.has(parent)) { keep.add(parent); changed = true; }
    }
  }
  return keep;
}

function compact(e: StateElement, hint?: ElementHint): AgentNode {
  const state = Object.fromEntries(Object.entries(e.state ?? {}).filter(([k, v]) =>
    !((k === 'vis' || k === 'en') && v === true) && k !== 'focused'));
  return { k: e.k, kq: e.kq, role: e.role, ...(e.name ? { name: e.name } : {}),
    ...(e.text && e.text !== e.name ? { text: e.text } : {}), ...(e.value ? { value: e.value } : {}),
    ...(Object.keys(state).length ? { state } : {}), ...(hint?.context?.length ? { context: [...hint.context] } : {}) };
}

export function relevanceUnits(nodes: AgentNode[], hints: Evidence['hints'], granularity: Granularity): RelevanceUnit[] {
  const groups = new Map<string, AgentNode[]>();
  nodes.forEach((node, i) => {
    // Missing region metadata is isolated rather than guessed from position/labels.
    const id = granularity === 'node' ? `node:${i}` : granularity === 'chunk' ? `chunk:${Math.floor(i / 12)}` :
      hints?.[node.k]?.region ?? `unclassified:${i}`;
    groups.set(id, [...(groups.get(id) ?? []), node]);
  });
  return [...groups].map(([id, group]) => ({ id, keys: group.map(n => n.k), nodes: group }));
}

export async function projectState(task: string, state: PageState, options: Evidence & {
  provider?: DecisionProvider; granularity?: Granularity; prune?: boolean;
} = {}): Promise<AgentView> {
  if (options.diff && (options.diff.to.id !== state.id || options.diff.to.seq !== state.seq)) throw new Error('PROJECTION_DIFF_MISMATCH');
  if (new Set(state.elements.map(e => e.k)).size !== state.elements.length) throw new Error('PROJECTION_DUPLICATE_KEYS');
  const keep = mustKeep(task, state, options);
  // Only hidden, unprotected elements can be removed without a relevance decision.
  // Repeated labels/text across rows must never be deduplicated by string equality.
  let nodes = structuredClone(state.elements).filter(e => options.prune === false || keep.has(e.k) || e.state?.vis !== false)
    .map(e => options.prune === false ? { ...e, ...(options.hints?.[e.k]?.context ? { context: [...options.hints[e.k].context!] } : {}) } : compact(e, options.hints?.[e.k]));
  const view = (): AgentView => ({ source: { id: state.id, digest: state.digest, targetId: state.targetId, session: state.session },
    url: state.url, title: state.title, coverage: structuredClone(state.coverage), focus: state.focus,
    dialog: state.dialog ? structuredClone(state.dialog) : undefined, elements: nodes,
    diff: options.diff ? structuredClone(options.diff) : undefined, errors: structuredClone(options.errors ?? []),
    omitted: { count: state.elements.length - nodes.length, expand: { sourceId: state.id, sourceDigest: state.digest } }, providerStatus: 'unused' });
  let status: AgentView['providerStatus'] = 'unused';
  if (options.provider) {
    const original = nodes;
    try {
      const granularity = options.granularity ?? 'region';
      const units = relevanceUnits(nodes.filter(n => !keep.has(n.k)), options.hints, granularity);
      const selected = await options.provider.projectState(task, structuredClone(view()), structuredClone(units));
      const validate = (ids: string[], valid: RelevanceUnit[]) => {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !valid.some(u => u.id === id))) throw new Error('PROVIDER_INVALID_SELECTION');
        return new Set(valid.filter(u => ids.includes(u.id)).flatMap(u => u.keys));
      };
      let keys = validate(selected, units);
      if (granularity === 'hybrid') {
        const child = relevanceUnits(nodes.filter(n => keys.has(n.k)), options.hints, 'node');
        keys = validate(await options.provider.projectState(task, structuredClone(view()), structuredClone(child)), child);
      }
      for (const key of keep) keys.add(key);
      const pending = [...keys];
      while (pending.length) {
        const key = pending.pop()!;
        for (const parent of options.hints?.[key]?.parents ?? []) {
          if (!keys.has(parent)) { keys.add(parent); pending.push(parent); }
        }
      }
      // Restore parents removed by hidden pruning from the original snapshot.
      nodes = state.elements.filter(e => keys.has(e.k)).map(e => compact(structuredClone(e), options.hints?.[e.k]));
      status = 'applied';
    } catch { nodes = original; status = 'fallback'; }
  }
  return { ...view(), providerStatus: status };
}

/** Load canonical state via sourceId; expansion is bound to the original digest. */
export function expandState(view: AgentView, canonical: PageState, keys?: string[]): StateElement[] {
  if (view.source.id !== canonical.id || view.source.digest !== canonical.digest ||
    view.source.targetId !== canonical.targetId || view.source.session !== canonical.session) throw new Error('PROJECTION_STALE_SOURCE');
  if (keys?.some(k => !canonical.elements.some(e => e.k === k))) throw new Error('PROJECTION_UNKNOWN_KEY');
  return structuredClone(canonical.elements.filter(e => !keys || keys.includes(e.k)));
}

export async function decideNext(task: string, state: AgentView, allowedActions: AllowedAction[], provider: DecisionProvider,
  thresholds = { confidence: 0.9, margin: 0.2 }, screenshot?: DecisionScreenshot): Promise<{ action?: AllowedAction; escalate: boolean; reason: string }> {
  if (screenshot && (screenshot.source.id !== state.source.id || screenshot.source.digest !== state.source.digest ||
    screenshot.source.targetId !== state.source.targetId || screenshot.source.session !== state.source.session ||
    screenshot.mimeType !== 'image/png' || !Number.isSafeInteger(screenshot.width) || !Number.isSafeInteger(screenshot.height) ||
    screenshot.width < 1 || screenshot.height < 1 || !screenshot.data)) return { escalate: true, reason: 'stale-or-invalid-screenshot' };
  const ids = new Set(allowedActions.map(a => a.id));
  if (!Number.isFinite(thresholds.confidence) || !Number.isFinite(thresholds.margin) ||
    thresholds.confidence < 0 || thresholds.confidence > 1 || thresholds.margin < 0 || thresholds.margin > 1) {
    return { escalate: true, reason: 'invalid-thresholds' };
  }
  if (ids.size !== allowedActions.length || !allowedActions.length || new Set(state.elements.map(e => e.k)).size !== state.elements.length ||
    allowedActions.some(a => !a.id || (['click', 'type', 'select'].includes(a.kind) && !a.target))) {
    return { escalate: true, reason: 'invalid-candidates' };
  }
  if (state.coverage.truncated || state.coverage.unstable || state.coverage.blockedByDialog || state.coverage.dialogProbeUnavailable ||
    state.coverage.actionUnverified || state.coverage.unreachableFrames.length || state.coverage.ambiguousKeys?.length) {
    return { escalate: true, reason: 'incomplete-coverage' };
  }
  try {
    const result = await provider.decideNext(task, structuredClone(state), structuredClone(allowedActions), screenshot ? structuredClone(screenshot) : undefined);
    const action = allowedActions.find(a => a.id === result.actionId);
    if (!action || result.executionQualified === false || !Number.isFinite(result.confidence) || !Number.isFinite(result.margin) ||
      result.confidence > 1 || result.margin > 1 || result.confidence < thresholds.confidence || result.margin < thresholds.margin) {
      return { escalate: true, reason: 'uncertain-or-invalid-decision' };
    }
    if (action.target) {
      const target = state.elements.find(e => e.k === action.target);
      if (!target || target.kq !== 'strong' || target.state?.vis === false || target.state?.en === false) return { escalate: true, reason: 'target-unavailable' };
    }
    return { action: structuredClone(action), escalate: action.kind === 'escalate', reason: 'bounded-decision' };
  } catch { return { escalate: true, reason: 'provider-failed' }; }
}
