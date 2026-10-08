/** Bound transport, never the canonical capture. Whole records remain recoverable. */
import { writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentView } from './experimental/decision.js';

export const WORKFLOW_TEXT_BYTES = 24_000;
export interface WorkflowViewProfile { profile: 'current-24k' | 'rich-64k' | 'haiku-compact'; maxBytes: number; protectedStateBytes: number; errorBytes: number }
/** Resolve before dispatch; profile affects transport only, never source capture. */
export function workflowViewProfile(env: NodeJS.ProcessEnv = process.env): WorkflowViewProfile {
  const profile = env.CDP_WORKFLOW_VIEW_PROFILE ?? 'current-24k';
  if (profile === 'current-24k') return { profile, maxBytes: WORKFLOW_TEXT_BYTES, protectedStateBytes: 16000, errorBytes: 6000 };
  if (profile === 'rich-64k') return { profile, maxBytes: 64000, protectedStateBytes: 48000, errorBytes: 16000 };
  if (profile === 'haiku-compact') return { profile, maxBytes: 8000, protectedStateBytes: 6000, errorBytes: 2500 };
  throw new Error('WORKFLOW_INVALID_VIEW_PROFILE: expected current-24k, rich-64k or haiku-compact; no action dispatched');
}
export function boundWorkflowResult(result: any, artifactPath: string, protectedKeys = new Set<string>(), profile = workflowViewProfile(), canonicalResult = result, artifactSaved = false): any {
  const maxBytes = profile.maxBytes;
  const fitting = { ...result, value: { ...result.value, output: { bounded: false, profile: profile.profile, maxBytes } } };
  if (Buffer.byteLength(JSON.stringify(fitting)) <= maxBytes) return fitting;
  // Preserve action receipts and diagnostics too, not just the state snapshot.
  let artifactAvailable = true;
  try {
    if (!artifactSaved) {
      const temporary = `${artifactPath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(canonicalResult, null, 2), { mode: 0o600 });
      renameSync(temporary, artifactPath);
    }
  }
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
  if (value.action) {
    value.action.witness ??= (value.action.evidence ?? []).flatMap((row: any) => row.data && ('clickDelivered' in row.data || 'witnessedEvent' in row.data) ?
      [{ clickDelivered: row.data.clickDelivered, witnessedEvent: row.data.witnessedEvent, frameReached: row.data.frameReached }] : []);
    value.action.evidenceOmitted = (value.action.evidenceOmitted ?? 0) + (value.action.evidence ?? []).length;
    value.action.evidence = [];
  }
  if (value.screenshot) { value.screenshot.evidenceOmitted = (value.screenshot.evidence ?? []).length; value.screenshot.evidence = []; }
  value.output = { bounded: true, profile: profile.profile, maxBytes, ...(artifactAvailable ? { fullPath: artifactPath } : {}), fullArtifactAvailable: artifactAvailable,
    omittedElements: elements.length, omittedChanges: changes.length, omittedErrors: errors.length,
    protectedEvidenceOmitted: true,
    instruction: artifactAvailable ? 'Partial transport view: inspect omitted evidence in fullPath or expand the canonical source before conclusions. Do not repeat a delivered action.' :
      'Partial transport view; full workflow artifact could not be saved. Canonical state may still be expanded, but omitted action/diagnostic evidence is unavailable. Do not repeat a delivered action.' };
  // Long URLs/coverage keys can themselves overflow. Keep the full coverage in
  // the artifact and explicitly mark unavailable transport detail rather than slice it.
  if (Buffer.byteLength(JSON.stringify(bounded)) > maxBytes) {
    value.view = view ? { source: view.source, coverage: { detailOmitted: true },
      omitted: view.omitted, elements: [], errors: [] } : undefined;
    value.diagnostics = { detailOmitted: true };
    value.output.omittedMetadata = true;
  }
  const fits = (budget: number) => Buffer.byteLength(JSON.stringify(bounded)) <= budget;
  // Reserve current actionable state before historical diff detail. Records are indivisible.
  const pack = (items: any[], destination: any[], field: string, budget = maxBytes - 128) => {
    for (const item of items) {
      destination.push(item);
      if (!fits(budget)) destination.pop(); else value.output[field]--;
    }
  };
  if (value.view) {
    const errorBudget = profile.profile === 'haiku-compact' ? Math.min(maxBytes - 128, Buffer.byteLength(JSON.stringify(bounded)) + profile.errorBytes) : profile.errorBytes;
    pack(errors, value.view.errors, 'omittedErrors', errorBudget);
    const changed = new Set(changes.map(c => c.key));
    const priority = (n: any) => protectedKeys.has(n.k) || changed.has(n.k) || n.k === view?.focus || n.value ||
      /^(alert|status|dialog|alertdialog|textbox|combobox)$/.test(n.role);
    const score = (n: any) => n.state?.vis === false ? 0 :
      /^(button|link|tab|menuitem|textbox|combobox|checkbox|radio|alert|status|dialog|alertdialog)$/.test(n.role) ? 2 : 1;
    const protectedNodes = elements.filter(priority).sort((a, b) => score(b) - score(a));
    pack(protectedNodes, value.view.elements, 'omittedElements', profile.protectedStateBytes);
    if (value.view.diff) pack(changes, value.view.diff.changes, 'omittedChanges');
    // Complete leftover nodes without duplicating those already packed.
    const packed = new Set(value.view.elements.map((n: any) => n.k));
    pack([...protectedNodes, ...elements.filter(n => !priority(n))].filter(n => !packed.has(n.k)), value.view.elements, 'omittedElements');
    if (value.view.omitted) value.view.omitted.count += value.output.omittedElements;
  }
  const included = new Set((value.view?.elements ?? []).map((n: any) => n.k));
  value.output.protectedEvidenceOmitted = elements.some((n: any) => protectedKeys.has(n.k) && !included.has(n.k)) ||
    value.output.omittedErrors > 0 || value.output.omittedChanges > 0 || value.output.omittedMetadata === true || (value.action?.evidenceOmitted ?? 0) > 0 ||
    (value.screenshot?.evidenceOmitted ?? 0) > 0;
  return bounded;
}
