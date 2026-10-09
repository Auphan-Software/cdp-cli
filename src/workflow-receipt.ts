/** Model-facing presentation only. Execution and canonical evidence are unchanged. */
import { actionWitnesses } from './workflow-output.js';

export function workflowReceipt(row: any, operation: string, full = false, imageDelivered = false): any {
  if (full || operation === 'expand' || !row?.value?.view) return row;
  if (row.success === false && !row.value.action) return row;
  const value = row.value, view = value.view;
  // Never discard the only copy of evidence when canonical persistence failed.
  if (value.recovery?.fullArtifactAvailable !== true && value.output?.fullArtifactAvailable !== true) return row;
  const source = view.source?.id;
  const receipt: any = { success: row.success, type: row.type, value: {
    view: { source: { id: source }, readiness: view.readiness,
      coverage: Object.fromEntries(Object.entries(view.coverage ?? {}).filter(([key, status]) =>
        !(['truncated', 'blockedByDialog'].includes(key) && status === false) &&
        !(['unreachableFrames', 'ambiguousKeys'].includes(key) && Array.isArray(status) && !status.length))),
      ...(operation === 'observe' && view.geometrySpace ? { geometrySpace: view.geometrySpace } : {}) },
    ...(value.recovery?.receiptId ? { details: { receiptId: value.recovery.receiptId } } : {}),
    ...(value.observationUnavailable ? { observationUnavailable: true } : {})
  } };
  const diagnostics = Object.fromEntries(Object.entries(value.diagnostics ?? {}).filter(([key, status]) =>
    key !== 'boundedLast' && status !== 'available' && status !== false));
  if (Object.keys(diagnostics).length) receipt.value.diagnostics = diagnostics;
  if (value.action) {
    // Retain all delivery/witness/refusal fields; only recoverable raw evidence is externalized.
    const { evidence, instruction, kind: _kind, targetKey: _target, evidenceOmitted: _omitted, ...action } = value.action;
    const witnesses = action.witness ?? actionWitnesses(evidence ?? []);
    receipt.value.action = { ...action, witness: witnesses.slice(0, 8).map((witness: any) => {
      if (witness.clickDelivered !== true || witness.frameReached === false || witness.witnessedEvent?.targetMatches === false) return witness;
      const { x: _x, y: _y, target: _target, ...event } = witness.witnessedEvent ?? {};
      return { ...witness, ...(witness.witnessedEvent ? { witnessedEvent: event } : {}) };
    }),
      ...(witnesses.length > 8 ? { witnessOmitted: witnesses.length - 8 } : {}) };
    if (row.success === false || action.commandSucceeded !== true || action.deliveryUnknown) receipt.value.action.instruction = instruction;
  }
  // Observation is deliberate discovery. Actions and screenshots return no unsolicited element/diff dump.
  if (operation === 'observe') {
    receipt.value.view.url = view.url;
    receipt.value.view.elements = view.elements;
    receipt.value.view.focus = view.focus;
    if (view.omitted?.count) receipt.value.view.omitted = { count: view.omitted.count };
  }
  if (operation === 'snapshot' && value.actionable) receipt.value.actionable = value.actionable;
  const errors = view.errors?.length ?? 0;
  const omittedErrors = value.output?.omittedErrors ?? 0;
  if (errors || omittedErrors) receipt.value.evidence = { ...(errors ? { errors } : {}), ...(omittedErrors ? { omittedErrors } : {}) };
  const alerts = (view.elements ?? []).filter((n: any) => /^(alert|status|dialog|alertdialog)$/.test(n.role));
  if (operation !== 'observe' && alerts.length) receipt.value.alerts = alerts;
  if (value.screenshot) {
    const { evidence: _evidence, source: _source, coordinateSpace: _space, pointGuard: _guard, ...shot } = value.screenshot;
    if (imageDelivered) {
      for (const key of ['path', 'originalPath', 'originalPixelWidth', 'originalPixelHeight', 'evidenceOmitted']) delete shot[key];
    }
    receipt.value.screenshot = shot;
  }
  return receipt;
}
