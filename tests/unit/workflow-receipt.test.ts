import { describe, it, expect } from 'vitest';
import { workflowReceipt } from '../../src/workflow-receipt.js';

const original = () => ({ success: true, type: 'workflow-observation', value: {
  action: { kind: 'click', commandSucceeded: true, deliveryUnknown: false,
    evidence: [{ data: { clickDelivered: true, frameReached: false } }], instruction: 'Not task proof.' },
  view: { source: { id: 'fresh', digest: 'hash', session: 'owned' }, readiness: 'ready',
    coverage: { truncated: false, unreachableFrames: [] }, geometrySpace: 'CSS viewport',
    elements: [{ k: 'ref', role: 'button', name: 'Save', box: [1, 2, 3, 4] }],
    diff: { changed: true, changes: [{ kind: 'removed', key: 'noise'.repeat(2000) }] },
    errors: [{ message: 'diagnostic'.repeat(2000) }], omitted: { count: 4 } },
  output: { fullArtifactAvailable: true, omittedErrors: 2, protectedEvidenceOmitted: true },
  recovery: { fullArtifactAvailable: true }, diagnostics: { console: 'available', network: 'unavailable' },
  screenshot: { available: true, path: 'shot.png', semanticStable: false, scale: .5,
    pixelWidth: 600, pixelHeight: 400, originalPath: 'original.png', coordinateFrame: { width: 1200, height: 800 },
    source: { id: 'fresh' }, evidence: [{ data: 'repeated'.repeat(2000) }] }
} });

describe('lean agent receipts preserve execution and recoverable evidence', () => {
  it('keeps source, frame delivery failure, incomplete evidence and pixel alignment without automatic state dumps', () => {
    const row = original(), result = workflowReceipt(row, 'act');
    expect(result.value.action.witness).toEqual([{ clickDelivered: true, frameReached: false }]);
    expect(result.value.view.source).toEqual({ id: 'fresh' });
    expect(result.value.view).not.toHaveProperty('elements');
    expect(result.value.view).not.toHaveProperty('diff');
    expect(result.value.evidence).toEqual({ errors: 1, omittedErrors: 2 });
    expect(result.value.screenshot).toMatchObject({ semanticStable: false, originalPath: 'original.png', coordinateFrame: { width: 1200, height: 800 } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1200);
    expect(row.value.view.diff.changes).toHaveLength(1); // canonical object is untouched
  });
  it('retains readable stale/no-dispatch and uncertain-delivery semantics', () => {
    const row: any = original(); row.success = false;
    Object.assign(row.value.action, { code: 'WORKFLOW_STALE_SOURCE', actionDelivered: false, commandSucceeded: false });
    expect(workflowReceipt(row, 'act').value.action).toMatchObject({ code: 'WORKFLOW_STALE_SOURCE', actionDelivered: false, instruction: 'Not task proof.' });
    row.value.action.deliveryUnknown = true;
    expect(workflowReceipt(row, 'act').value.action.deliveryUnknown).toBe(true);
  });
  it('keeps explicit control discovery and geometry but separates diagnostic details', () => {
    const row = original(), result = workflowReceipt(row, 'observe');
    expect(result.value.view.elements).toEqual(row.value.view.elements);
    expect(result.value.view.omitted).toEqual({ count: 4 });
    expect(result.value.view).not.toHaveProperty('diff');
    expect(result.value).not.toHaveProperty('details');
  });
  it('preserves full/expand output and the only evidence copy on storage failure', () => {
    const row = original();
    expect(workflowReceipt(row, 'act', true)).toBe(row);
    expect(workflowReceipt(row, 'expand')).toBe(row);
    row.value.recovery.fullArtifactAvailable = false; row.value.output.fullArtifactAvailable = false;
    expect(workflowReceipt(row, 'act')).toBe(row);
  });
  it('does not hide current alerts or replace screenshot uncertainty with success', () => {
    const row = original(); row.value.view.elements.push({ k: 'alert', role: 'alert', name: 'Account frozen', box: [1, 2, 3, 4] });
    const result = workflowReceipt(row, 'screenshot');
    expect(result.value.alerts[0].name).toBe('Account frozen');
    expect(result.value.screenshot.semanticStable).toBe(false);
    expect(result.value.view).not.toHaveProperty('elements');
  });
  it('retains raw failed-click evidence through the existing failure-witness formatter', () => {
    const row: any = original();
    row.value.action.commandSucceeded = false;
    row.value.action.evidence = [{ error: true, code: 'CLICK_FRAME_DELIVERY_UNCONFIRMED', message: 'Frame did not receive click',
      details: { witnessedEvent: { type: 'click', trusted: true, targetMatches: false } } }];
    expect(workflowReceipt(row, 'act').value.action.witness[0]).toMatchObject({ code: 'CLICK_FRAME_DELIVERY_UNCONFIRMED',
      message: 'Frame did not receive click', witnessedEvent: { targetMatches: false } });
  });
  it('cuts healthy defaults and repeated input but preserves unknown coverage and diagnostic warnings', () => {
    const row: any = original();
    row.value.view.coverage = { truncated: false, unreachableFrames: [], blockedByDialog: false, ambiguousKeys: [], dialogProbeUnavailable: true, unstable: null };
    row.value.view.readiness = 'incomplete';
    row.value.diagnostics = { boundedLast: 100, console: 'available', network: 'unavailable', consoleAtLimit: false, networkAtLimit: true };
    row.value.action.targetKey = 'ref'; row.value.action.evidenceOmitted = 9;
    const result = workflowReceipt(row, 'act');
    expect(result.value.view).toMatchObject({ readiness: 'incomplete', coverage: { dialogProbeUnavailable: true, unstable: null } });
    expect(result.value.diagnostics).toEqual({ network: 'unavailable', networkAtLimit: true });
    expect(result.value.action).not.toHaveProperty('targetKey');
    expect(result.value.action).not.toHaveProperty('kind');
    expect(result.value.action).not.toHaveProperty('evidenceOmitted');
  });
  it('retains matched trusted delivery without echoing successful pointer coordinates', () => {
    const row: any = original();
    row.value.action.evidence = [{ data: { clickDelivered: true, frameReached: null,
      witnessedEvent: { type: 'click', trusted: true, targetMatches: true, x: 10, y: 20, target: 'button' } } }];
    expect(workflowReceipt(row, 'act').value.action.witness[0]).toEqual({ clickDelivered: true, frameReached: null,
      witnessedEvent: { type: 'click', trusted: true, targetMatches: true } });
    row.value.action.evidence[0].data.witnessedEvent.targetMatches = false;
    expect(workflowReceipt(row, 'act').value.action.witness[0].witnessedEvent).toMatchObject({ x: 10, y: 20, targetMatches: false });
  });
  it('omits paths only when pixels actually reached the transport; preserves recovery and alignment', () => {
    const row: any = original(); row.value.recovery.receiptId = 'recover';
    const result = workflowReceipt(row, 'screenshot', false, true);
    expect(result.value.screenshot).not.toHaveProperty('path');
    expect(result.value.screenshot).not.toHaveProperty('originalPath');
    expect(result.value.screenshot).toMatchObject({ semanticStable: false, pixelWidth: 600, scale: .5, coordinateFrame: { width: 1200, height: 800 } });
    expect(result.value.details).toEqual({ receiptId: 'recover' });
    expect(workflowReceipt(row, 'screenshot').value.screenshot.originalPath).toBe('original.png');
    expect(workflowReceipt(row, 'screenshot', true, true)).toBe(row);
  });
  it('does not fabricate error evidence when there are no reported errors', () => {
    const row: any = original(); row.value.view.errors = []; row.value.output.omittedErrors = 0;
    expect(workflowReceipt(row, 'act').value).not.toHaveProperty('evidence');
    row.value.output.omittedErrors = 3;
    expect(workflowReceipt(row, 'act').value.evidence).toEqual({ omittedErrors: 3 });
  });
});
