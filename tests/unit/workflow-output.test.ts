import { describe, it, expect, vi } from 'vitest';
vi.unmock('fs');
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundWorkflowResult, WORKFLOW_TEXT_BYTES } from '../../src/workflow-output.js';
import { StateStore } from '../../src/state/store.js';
import type { PageState } from '../../src/state/types.js';

describe('bounded workflow transport', () => {
  it('expires only overflow artifacts associated with an expired canonical source', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-retention-'));
    try {
      const store = new StateStore('http://owned.test', 'owned', 'page', root, 1);
      const canonical = { schema: 'cdp-cli.page-state/1', capturedAt: '', targetId: 'page', captureProfile: 'profile', url: '', title: '', readyState: 'complete', bodyTextHash: '', nodeCount: 0, elements: [], coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false } } as Omit<PageState, 'id'|'seq'|'digest'>;
      const first = store.save(canonical);
      const artifact = join(store.dir, `${first.id}-workflow.json`);
      const unrelated = join(store.dir, 'other-evidence.json');
      writeFileSync(artifact, '{}'); writeFileSync(unrelated, '{}');
      store.save(canonical);
      expect(existsSync(artifact)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps sources/delivery, preserves exact overflow and bounds Unicode records', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-output-'));
    try {
      const result = { success: true, value: {
        action: { commandSucceeded: true, deliveryUnknown: false, evidence: [{ receipt: 'x'.repeat(30000) }] },
        view: { source: { id: 'source', digest: 'digest' }, coverage: { truncated: false },
          elements: Array.from({ length: 1000 }, (_, i) => ({ k: `item${i}`, role: 'text', text: '界'.repeat(80) })),
          diff: { changed: true, counts: { added: 1000 }, changes: [{ key: 'item999', to: 'Changed' }] },
          errors: [{ message: '界'.repeat(10000) }], omitted: { count: 0 } },
        diagnostics: { network: 'unavailable' }, canonicalPath: 'canonical.json' } };
      const original = JSON.stringify(result), path = join(root, 'full.json');
      const output = boundWorkflowResult(result, path);
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(WORKFLOW_TEXT_BYTES);
      expect(output.value.view.source.id).toBe('source');
      expect(output.value.action.commandSucceeded).toBe(true);
      expect(output.value.action.deliveryUnknown).toBe(false);
      expect(output.value.view.elements[0].k).toBe('item999');
      expect(output.value.output.omittedErrors).toBe(1);
      expect(output.value.output.protectedEvidenceOmitted).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(result);
      expect(JSON.stringify(result)).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('bounds huge metadata and preserves screenshot availability and recovery path', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-output-'));
    try {
      const result = { success: false, value: { action: { actionDelivered: false },
        view: { source: { id: 'fresh' }, coverage: { unreachableFrames: ['x'.repeat(30000)] }, elements: [], errors: [], omitted: { count: 0 } },
        screenshot: { available: true, path: 'pixels.png' } } };
      const output = boundWorkflowResult(result, join(root, 'full.json'));
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(WORKFLOW_TEXT_BYTES);
      expect(output.value.view.coverage.detailOmitted).toBe(true);
      expect(output.value.screenshot.path).toBe('pixels.png');
      expect(output.value.action.actionDelivered).toBe(false);
      expect(output.success).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('retains completed delivery even when the overflow artifact cannot be written', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-output-'));
    try {
      const output = boundWorkflowResult({ success: true, value: {
        action: { commandSucceeded: true, deliveryUnknown: false, evidence: ['x'.repeat(30000)] },
        view: { source: { id: 'completed' }, coverage: {}, elements: [], errors: [] } }
      }, join(root, 'missing-directory', 'full.json'));
      expect(output.value.action.commandSucceeded).toBe(true);
      expect(output.value.output.fullArtifactAvailable).toBe(false);
      expect(output.value.output.fullPath).toBeUndefined();
      expect(output.value.output.instruction).toContain('Do not repeat');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
