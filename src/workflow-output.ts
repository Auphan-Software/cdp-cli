/** Bound transport, never the canonical capture. Whole records remain recoverable. */
import { writeFileSync } from 'node:fs';
import type { AgentView } from './experimental/decision.js';

export const WORKFLOW_TEXT_BYTES = 24_000;
export function boundWorkflowResult(result: any, artifactPath: string, protectedKeys = new Set<string>()): any {
  const raw = JSON.stringify(result);
  if (Buffer.byteLength(raw) <= WORKFLOW_TEXT_BYTES) return result;
  // Preserve action receipts and diagnostics too, not just the state snapshot.
  let artifactAvailable = true;
  try { writeFileSync(artifactPath, JSON.stringify(result, null, 2), { mode: 0o600 }); }
  catch { artifactAvailable = false; } // Never lose delivery status after a completed action.
  const bounded = structuredClone(result);
  const value = bounded.value;
  const view: AgentView | undefined = value?.view;
  const elements = view?.elements ?? [];
  const changes = view?.diff?.changes ?? [];
  const errors = view?.errors ?? [];
  if (view) {
    view.elements = [];
    if (view.diff) view.diff.changes = [];
    view.errors = [];
  }
  if (value.action) value.action.evidence = [];
  if (value.screenshot) value.screenshot.evidence = [];
  value.output = { bounded: true, maxBytes: WORKFLOW_TEXT_BYTES, ...(artifactAvailable ? { fullPath: artifactPath } : {}), fullArtifactAvailable: artifactAvailable,
    omittedElements: elements.length, omittedChanges: changes.length, omittedErrors: errors.length,
    protectedEvidenceOmitted: true,
    instruction: artifactAvailable ? 'Partial transport view: inspect omitted evidence in fullPath or expand the canonical source before conclusions. Do not repeat a delivered action.' :
      'Partial transport view; full workflow artifact could not be saved. Canonical state may still be expanded, but omitted action/diagnostic evidence is unavailable. Do not repeat a delivered action.' };
  // Long URLs/coverage keys can themselves overflow. Keep the full coverage in
  // the artifact and explicitly mark unavailable transport detail rather than slice it.
  if (Buffer.byteLength(JSON.stringify(bounded)) > WORKFLOW_TEXT_BYTES) {
    value.view = view ? { source: view.source, coverage: { detailOmitted: true },
      omitted: view.omitted, elements: [], errors: [] } : undefined;
    value.diagnostics = { detailOmitted: true };
    value.output.omittedMetadata = true;
  }
  const fits = () => Buffer.byteLength(JSON.stringify(bounded)) <= WORKFLOW_TEXT_BYTES - 128;
  // Diagnostics and diffs precede background content. Records are indivisible.
  const pack = (items: any[], destination: any[], field: string) => {
    for (const item of items) {
      destination.push(item);
      if (!fits()) destination.pop(); else value.output[field]--;
    }
  };
  if (value.view) {
    pack(errors, value.view.errors, 'omittedErrors');
    if (value.view.diff) pack(changes, value.view.diff.changes, 'omittedChanges');
    const changed = new Set(changes.map(c => c.key));
    const priority = (n: any) => protectedKeys.has(n.k) || changed.has(n.k) || n.k === view?.focus || n.value ||
      /^(alert|status|dialog|alertdialog|textbox|combobox)$/.test(n.role);
    pack([...elements.filter(priority), ...elements.filter(n => !priority(n))], value.view.elements, 'omittedElements');
    if (value.view.omitted) value.view.omitted.count += value.output.omittedElements;
  }
  return bounded;
}
