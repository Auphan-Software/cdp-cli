/** Opt-in transport only. Canonical capture and executor signatures stay unchanged. */
import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StateStore } from './state/store.js';
import { retainActionWitnesses, boundWorkflowResult, type WorkflowViewProfile } from './workflow-output.js';
import type { PageState } from './state/types.js';

export function saveWorkflowArtifact(path: string, result: unknown): boolean {
  try {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 }); renameSync(temporary, path);
    return true;
  } catch { return false; }
}

export function workflowQueryTerms(query: string): string[] {
  const terms = query.normalize('NFC').split('|').map(term => term.trim().toLowerCase());
  if (query.length > 1000 || terms.length > 8 || terms.some(term => !term || term.length > 120)) throw new Error('WORKFLOW_INVALID_QUERY');
  return terms;
}

/** Explicit scoped read, never a relevance guess. Preserve global safety signals. */
export function scopedWorkflowView(view: any, query: string, hints: PageState['hints'] = {}, targets: string[] = [], boxes: Record<string, number[]> = {}): void {
  const terms = workflowQueryTerms(query);
  const matched = new Set<string>(view.elements.filter((node: any) => terms.some(term =>
    [node.name, node.text, ...(hints[node.k]?.context ?? [])].join(' ').normalize('NFC').toLowerCase().includes(term))).map((node: any) => node.k));
  const included = new Set(matched);
  // Keep nearby text on the same rendered row: a Total label alone is not its amount.
  // This only broadens the read; it never infers a locator or changes action identity.
  for (const key of matched) {
    const box = boxes[key];
    if (!box || box[2] > 800 || box[3] > 80) continue;
    for (const node of view.elements) {
      const other = boxes[node.k];
      if (node.role !== 'text' || node.state?.vis === false || !other || other[3] > 80) continue;
      if (Math.abs((box[1] + box[3] / 2) - (other[1] + other[3] / 2)) <= Math.max(4, Math.min(box[3], other[3]) / 2) &&
        Math.abs(box[0] - other[0]) <= 600) included.add(node.k);
    }
  }
  // A labeled clickable tile may contain a separate child button that actually creates a record.
  for (const node of view.elements) if (matched.has(hints[node.k]?.parents?.[0] ?? '')) included.add(node.k);
  for (const node of view.elements) if (/^(alert|status|log|dialog|alertdialog)$/.test(node.role) || hints[node.k]?.live ||
    node.state?.invalid === true || node.state?.busy === true || node.state?.selected === true || node.state?.checked === true || node.state?.ariaChecked === true ||
    node.k === view.focus || targets.includes(node.k)) included.add(node.k);
  for (const key of [...included]) for (const parent of hints[key]?.parents ?? []) included.add(parent);
  const excludedElements = view.elements.filter((node: any) => !included.has(node.k)).length;
  view.elements = view.elements.filter((node: any) => included.has(node.k));
  let excludedChanges = 0;
  if (view.diff) view.diff.changes = view.diff.changes.filter((change: any) => {
    const keep = included.has(change.key) || ['navigation', 'text-unmodelled', 'dialog'].includes(change.kind) ||
      /^(alert|status|log|dialog|alertdialog)$/.test(change.from?.role ?? change.to?.role ?? '');
    if (!keep) excludedChanges++;
    return keep;
  });
  view.scope = { query, matched: matched.size, excludedElements, excludedChanges,
    instruction: 'Scoped read; excluded business facts are not verified. Query needed labels, observe without query for broader context, or expand historical evidence.' };
  view.omitted.count += excludedElements;
}

export function compactWorkflowResult(result: any, store: StateStore, captureProfile: string, operation: string,
  protectedKeys: Set<string>, profile: WorkflowViewProfile, context: { full?: boolean; task?: string; hints?: PageState['hints']; targets?: string[]; query?: string; boxes?: Record<string, number[]> } = {}): any {
  const original = structuredClone(result);
  const view = original.value.view;
  const path = join(store.dir, `${view.source.id}-workflow.json`);
  const available = saveWorkflowArtifact(path, original);
  // Do not intentionally exclude evidence when its recovery artifact is unavailable.
  if (!available) return boundWorkflowResult(original, path, protectedKeys, profile);
  const compact = structuredClone(original), value = compact.value, current = value.view;
  if (context.query) scopedWorkflowView(current, context.query, context.hints, context.targets, context.boxes);
  const keys = new Set<string>(current.elements.map((n: any) => n.k));
  if (current.focus) keys.add(current.focus);
  for (const change of current.diff?.changes ?? []) if (change.key) keys.add(change.key);
  for (const coverage of [current.coverage, current.diff?.coverage]) {
    for (const key of [...(coverage?.volatileKeys ?? []), ...(coverage?.ambiguousKeys ?? [])]) keys.add(key);
  }
  let refs: Record<string, string>;
  try { refs = store.references(`${captureProfile}/${view.source.id}`, [...keys]); }
  catch {
    original.value.compactFormat = { available: false, reason: 'reference-storage-failed', instruction: 'Original keys retained; delivery is unchanged.' };
    original.value.recovery = { source: view.source.id, fullArtifactAvailable: true, instruction: 'Expand receipt/errors/changes/coverage for historical evidence; observe after context loss.' };
    return boundWorkflowResult(original, path, protectedKeys, profile, original, true);
  }
  const changed = new Set((current.diff?.changes ?? []).map((c: any) => c.key));
  const omitted: Record<string, number> = { hiddenOptions: 0, unchangedText: 0, screenshotState: 0, coverageKeys: 0, actionEvidence: 0, changeDetails: 0, errorDetails: 0 };
  current.elements = current.elements.filter((node: any) => {
    if (context.full) return true;
    // Keep a self-contained action surface plus changes and global status. Full observe restores context.
    if (!context.query && operation === 'act' && !changed.has(node.k) && !protectedKeys.has(node.k) &&
      !/^(alert|status|log|dialog|alertdialog)$/.test(node.role)) { omitted.unchangedText++; return false; }
    return true;
  });
  for (const node of current.elements) {
    node.k = refs[node.k];
    if (node.kq === 'strong') delete node.kq;
  }
  if (current.focus) current.focus = refs[current.focus];
  for (const change of current.diff?.changes ?? []) {
    if (change.key) change.key = refs[change.key];
    if (!context.full && (change.kind === 'added' || change.kind === 'removed')) {
      if (change.from !== undefined || change.to !== undefined) omitted.changeDetails++;
      delete change.from; delete change.to;
    }
  }
  current.errors = current.errors.map((error: any) => {
    if (context.full || error.message.length <= 200) return error;
    omitted.errorDetails++;
    return { ...error, message: error.message.slice(0, 200), detailOmitted: true };
  });
  for (const coverage of [current.coverage, current.diff?.coverage]) if (coverage) {
    for (const field of ['volatileKeys', 'ambiguousKeys']) if (coverage[field]?.length) {
      coverage[`${field}Count`] = coverage[field].length;
      omitted.coverageKeys += coverage[field].length; delete coverage[field];
    }
  }
  if (value.action?.evidence?.length) {
    retainActionWitnesses(value.action);
    omitted.actionEvidence = value.action.evidence.length; value.action.evidence = [];
    value.action.evidenceOmitted = omitted.actionEvidence;
  }
  if (value.action?.targetKey && refs[value.action.targetKey]) value.action.targetKey = refs[value.action.targetKey];
  current.readiness = current.coverage.unstable || current.coverage.truncated || current.coverage.blockedByDialog ||
    current.coverage.dialogProbeUnavailable || current.coverage.unreachableFrames?.length || current.coverage.ambiguousKeysCount ||
    current.coverage.ambiguousKeys?.length ? 'incomplete' : 'ready';
  current.representation = 'source-refs/1';
  current.omitted.count += omitted.hiddenOptions + omitted.unchangedText + omitted.screenshotState;
  value.recovery = { source: current.source.id, fullArtifactAvailable: true, excluded: omitted,
    instruction: 'Use expand section receipt/errors/changes/coverage for omitted evidence, elements for historical state. Observe restores fresh full context. Missing evidence is not a pass; never repeat uncertain delivery.' };
  const bounded = boundWorkflowResult(compact, path, new Set([...protectedKeys].map(k => refs[k]).filter(Boolean)), profile, original, true);
  // The artifact is intentionally written even when the compact result fits its budget.
  bounded.value.output.fullArtifactAvailable ??= true;
  return bounded;
}

/** Source-bound, no browser dispatch. Never accept a caller-supplied filesystem path. */
export function expandWorkflowEvidence(store: StateStore, source: string, section: string, offset: number, limit: number, maxBytes: number, receiptId?: string): any {
  const state = store.load(source);
  if (receiptId && !/^[a-f0-9-]{36}$/.test(receiptId)) throw new Error('WORKFLOW_INVALID_RECEIPT_ID');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('WORKFLOW_INVALID_EXPANSION_RANGE');
  let artifact: any;
  try { artifact = JSON.parse(readFileSync(join(store.dir, `${state.id}-workflow${receiptId ? `-${receiptId}` : ''}.json`), 'utf8')); }
  catch { return { success: false, type: 'workflow-evidence-unavailable', value: { source: state.id, section, available: false,
    instruction: 'Historical workflow evidence unavailable. Do not infer a clean result or repeat a possibly delivered action.' } }; }
  const value = artifact.value;
  if (section === 'artifact') {
    const characters = Array.from(JSON.stringify(artifact));
    if (offset > characters.length) throw new Error('WORKFLOW_INVALID_EXPANSION_RANGE');
    const text = characters.slice(offset, offset + limit).join('');
    return { success: true, type: 'workflow-expand', value: { historical: true, source: state.id, section, encoding: 'json-text/codepoints', text,
      pagination: { offset, total: characters.length, nextOffset: offset + Array.from(text).length < characters.length ? offset + Array.from(text).length : null },
      instruction: 'Source-bound workflow JSON fragment; incomplete fragments are not complete evidence. Observe before acting after context loss.' } };
  }
  const items = section === 'receipt' ? [{ action: value.action, diagnostics: value.diagnostics, screenshot: value.screenshot }] :
    section === 'errors' ? value.view?.errors ?? [] : section === 'changes' ? value.view?.diff?.changes ?? [] :
    section === 'coverage' ? [{ current: value.view?.coverage, historical: value.view?.diff?.coverage }] : undefined;
  if (!items) throw new Error('WORKFLOW_INVALID_EVIDENCE_SECTION');
  const result = { success: true, type: 'workflow-expand', value: { historical: true, source: state.id, section, records: [] as any[],
    pagination: { offset, total: items.length, nextOffset: null as number | null }, instruction: 'Historical evidence. Observe before acting after context loss.' } };
  if (offset > items.length) throw new Error('WORKFLOW_INVALID_EXPANSION_RANGE');
  for (const item of items.slice(offset, offset + limit)) {
    result.value.records.push(item);
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes - 200) { result.value.records.pop(); break; }
  }
  const next = offset + result.value.records.length;
  if (next < items.length) result.value.pagination.nextOffset = next;
  if (next === offset && next < items.length) return { success: false, type: 'workflow-evidence-unavailable', value: {
    source: state.id, section, available: false, reason: 'record-exceeds-budget', instruction: 'Use expand section artifact for paginated JSON fragments, or a larger profile. Do not infer success.' } };
  return result;
}
