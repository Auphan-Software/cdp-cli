/** Pure semantic helpers. This is not a replacement for the action journal. */
import { diffStates, expectState, type StateExpectation } from '../state/diff.js';
import type { PageState, StateElement } from '../state/types.js';
import type { AgentView, AllowedAction } from './decision.js';

export interface SemanticTarget { key: string; role: string; name?: string; context?: string[]; frame: string }
const frame = (key: string) => key.split('|')[0];
export function describeTarget(element: StateElement, context?: string[]): SemanticTarget {
  return { key: element.k, role: element.role, name: element.name, context: context ? [...context] : undefined, frame: frame(element.k) };
}
export function relocateTarget(target: SemanticTarget, state: PageState, contexts: Record<string, string[]> = {}): {
  stage: 'exact' | 'semantic' | 'escalate'; key?: string; reason?: string;
} {
  if (state.coverage.truncated || state.coverage.unstable || state.coverage.blockedByDialog ||
    state.coverage.dialogProbeUnavailable || state.coverage.actionUnverified ||
    state.coverage.unreachableFrames.length || state.coverage.ambiguousKeys?.length) return { stage: 'escalate', reason: 'incomplete-coverage' };
  const matches = state.elements.filter(e => e.kq === 'strong' && e.state?.vis !== false && e.state?.en !== false &&
    e.role === target.role && e.name === target.name && frame(e.k) === target.frame &&
    (!target.context?.length || JSON.stringify(contexts[e.k]) === JSON.stringify(target.context)));
  const exact = matches.find(e => e.k === target.key);
  if (exact) return { stage: 'exact', key: exact.k };
  // No fuzzy string matching or ordinal fallback, including same-session stale nodes.
  if (matches.length === 1 && target.name && target.context?.length) return { stage: 'semantic', key: matches[0].k };
  return { stage: 'escalate', reason: matches.length > 1 ? 'ambiguous' : 'missing-or-insufficient-descriptor' };
}
export function verifyReplayEffect(before: PageState, after: PageState, spec: StateExpectation) {
  if (!spec.mustChange?.length) return { outcome: 'UNKNOWN' as const, reason: 'transition-required' };
  if (before.coverage.actionUnverified || after.coverage.actionUnverified) return { outcome: 'UNKNOWN' as const, reason: 'action-unverified' };
  return expectState(diffStates(before, after), spec, before, after);
}

/** Revalidate every proposed target against a fresh capture before execution. */
export function resolveProposedTarget(view: AgentView, action: AllowedAction, fresh: PageState,
  contexts: Record<string, string[]> = {}) {
  if (view.source.targetId !== fresh.targetId || view.source.session !== fresh.session) {
    return { stage: 'escalate' as const, reason: 'target-session-mismatch' };
  }
  const old = view.elements.find(e => e.k === action.target);
  if (!old || old.kq !== 'strong') return { stage: 'escalate' as const, reason: 'missing-or-weak-proposal' };
  return relocateTarget(describeTarget(old, old.context), fresh, contexts);
}
