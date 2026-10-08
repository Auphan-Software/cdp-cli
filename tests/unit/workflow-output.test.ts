import { describe, it, expect, vi } from 'vitest';
vi.unmock('fs');
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundWorkflowResult, WORKFLOW_TEXT_BYTES, workflowViewProfile } from '../../src/workflow-output.js';
import { workflow } from '../../src/workflow.js';
import { callWorkflowTool, createWorkflowBudget } from '../../src/workflow-mcp.js';
import { StateStore } from '../../src/state/store.js';
import type { PageState } from '../../src/state/types.js';

describe('bounded workflow transport', () => {
  it('defaults to 24k and reports profile metadata even for fitting output without changing its evidence', () => {
    const result = { success: true, value: { view: { source: { id: 'source' }, elements: [{ k: 'next', name: 'Add' }] } } };
    const before = JSON.stringify(result);
    const output = boundWorkflowResult(result, 'unused.json', new Set(), workflowViewProfile({}));
    expect(output.value.output).toEqual({ bounded: false, profile: 'current-24k', maxBytes: 24000 });
    expect(output.value.view).toEqual(result.value.view);
    expect(JSON.stringify(result)).toBe(before);
    expect(workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'current-24k' })).toEqual(workflowViewProfile({}));
  });
  it('reserves richer current controls ahead of historical diffs, using UTF8 bytes and identical canonical artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-rich-'));
    try {
      const controls = Array.from({ length: 160 }, (_, i) => ({ k: `control${i}`, role: 'button', name: `Buy ${i} ${'界'.repeat(60)}`, state: { vis: true, en: true } }));
      const result = { success: true, value: { action: { commandSucceeded: true, deliveryUnknown: false },
        view: { source: { id: 'same-source' }, coverage: {}, errors: [], omitted: { count: 0 }, elements: controls,
          diff: { changes: Array.from({ length: 600 }, (_, i) => ({ kind: 'removed', key: `old${i}`, from: { text: '界'.repeat(80) } })) } } } };
      const protectedKeys = new Set(controls.map(n => n.k));
      const small = boundWorkflowResult(result, join(root, 'small.json'), protectedKeys, workflowViewProfile({}));
      const rich = boundWorkflowResult(result, join(root, 'rich.json'), protectedKeys, workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'rich-64k' }));
      expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(24000);
      expect(Buffer.byteLength(JSON.stringify(rich))).toBeLessThanOrEqual(64000);
      expect(rich.value.view.elements.length).toBeGreaterThan(small.value.view.elements.length);
      expect(rich.value.view.elements.length).toBe(controls.length);
      expect(rich.value.output.profile).toBe('rich-64k');
      expect(rich.value.output.omittedElements).toBe(0);
      expect(rich.value.output.omittedChanges).toBeGreaterThan(0);
      expect(rich.value.view.source).toEqual(small.value.view.source);
      expect(rich.value.action).toEqual(small.value.action);
      expect(JSON.parse(readFileSync(join(root, 'rich.json'), 'utf8'))).toEqual(result);
      expect(readFileSync(join(root, 'rich.json'), 'utf8')).toBe(readFileSync(join(root, 'small.json'), 'utf8'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects invalid profiles before workflow page access or MCP action admission/dispatch', async () => {
    const findPage = vi.fn(), budget = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1' });
    for (const invalid of ['', 'rich', '64000', ' rich-64k']) {
      vi.stubEnv('CDP_WORKFLOW_VIEW_PROFILE', invalid);
      try {
        await expect(workflow({ findPage } as any, 'act', { page: 'owned', task: 'buy', source: 'source', action: 'click', selector: '#buy' })).rejects.toThrow('WORKFLOW_INVALID_VIEW_PROFILE');
        await expect(callWorkflowTool('act', { task: 'buy', source: 'source', action: 'click', selector: '#buy' }, budget)).rejects.toThrow('WORKFLOW_INVALID_VIEW_PROFILE');
        expect(findPage).not.toHaveBeenCalled();
        expect(budget.snapshot().actionsUsed).toBe(0);
      } finally { vi.unstubAllEnvs(); }
    }
  });
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
  it('does not let a large historical diff starve the current next-action controls', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-next-control-'));
    try {
      const output = boundWorkflowResult({ success: true, value: {
        view: { source: { id: 'fresh' }, coverage: {}, errors: [], omitted: { count: 0 },
          elements: [{ k: 'next', role: 'button', name: 'Drinks' }],
          diff: { changed: true, changes: Array.from({ length: 500 }, (_, i) => ({ kind: 'removed', key: `old${i}`, from: { text: 'x'.repeat(120) } })) } }
      } }, join(root, 'full.json'), new Set(['next']));
      expect(output.value.view.elements).toEqual([{ k: 'next', role: 'button', name: 'Drinks' }]);
      expect(output.value.output.omittedChanges).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(WORKFLOW_TEXT_BYTES);
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
