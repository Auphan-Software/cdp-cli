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
    expect(result.value.evidence).toMatchObject({ errors: 1, omittedErrors: 2, incomplete: false, detailsOmitted: true });
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
    expect(result.value.details).toMatchObject({ source: 'fresh', available: true, historical: true });
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
});
