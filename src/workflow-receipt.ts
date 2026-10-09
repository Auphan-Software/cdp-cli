/** Model-facing presentation only. Execution and canonical evidence are unchanged. */
import { actionWitnesses } from './workflow-output.js';

export function workflowReceipt(row: any, operation: string, full = false): any {
  if (full || operation === 'expand' || !row?.value?.view) return row;
  if (row.success === false && !row.value.action) return row;
  const value = row.value, view = value.view;
  // Never discard the only copy of evidence when canonical persistence failed.
  if (value.recovery?.fullArtifactAvailable !== true && value.output?.fullArtifactAvailable !== true) return row;
  const source = view.source?.id;
  const receipt: any = { success: row.success, type: row.type, value: {
    view: { source: { id: source }, readiness: view.readiness,
      coverage: view.coverage, ...(view.geometrySpace ? { geometrySpace: view.geometrySpace } : {}) },
    details: { available: true, source, historical: true, ...(value.recovery?.receiptId ? { receiptId: value.recovery.receiptId } : {}) },
    diagnostics: value.diagnostics,
    ...(value.observationUnavailable ? { observationUnavailable: true } : {})
  } };
  if (value.action) {
    // Retain all delivery/witness/refusal fields; only recoverable raw evidence is externalized.
    const { evidence, instruction, ...action } = value.action;
    const witnesses = action.witness ?? actionWitnesses(evidence ?? []);
    receipt.value.action = { ...action, witness: witnesses.slice(0, 8),
      ...(witnesses.length > 8 ? { witnessOmitted: witnesses.length - 8 } : {}) };
    if (row.success === false || action.commandSucceeded !== true || action.deliveryUnknown) receipt.value.action.instruction = instruction;
  }
  // Observation is deliberate discovery. Actions and screenshots return no unsolicited element/diff dump.
  if (operation === 'observe') {
    receipt.value.view.url = view.url;
    receipt.value.view.elements = view.elements;
    receipt.value.view.focus = view.focus;
    receipt.value.view.omitted = view.omitted;
  }
  const errors = view.errors?.length ?? 0;
  receipt.value.evidence = { stateRequested: operation === 'observe', changed: view.diff?.changed,
    errors, omittedErrors: value.output?.omittedErrors ?? 0,
    omittedElements: value.output?.omittedElements ?? 0,
    incomplete: view.readiness === 'incomplete', detailsOmitted: value.output?.protectedEvidenceOmitted === true };
  const alerts = (view.elements ?? []).filter((n: any) => /^(alert|status|dialog|alertdialog)$/.test(n.role));
  if (operation !== 'observe' && alerts.length) receipt.value.alerts = alerts;
  if (value.screenshot) {
    const { evidence: _evidence, source: _source, coordinateSpace: _space, ...shot } = value.screenshot;
    receipt.value.screenshot = shot;
  }
  return receipt;
}
