import { describe, it, expect, vi } from 'vitest';
vi.unmock('fs');
import { mkdtempSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { compactWorkflowResult, expandWorkflowEvidence, scopedWorkflowView, workflowQueryTerms } from '../../src/workflow-compact.js';
import { workflowViewProfile, boundWorkflowResult } from '../../src/workflow-output.js';
import { resolveWorkflowTarget } from '../../src/workflow.js';

const root = () => mkdtempSync(join(tmpdir(), 'compact-contract-'));
const state = (store: StateStore, elements: any[]) => store.save({ schema: 'cdp-cli.page-state/1', targetId: 'page', session: 'owned',
  capturedAt: 'now', captureProfile: 'profile', url: 'http://fixture/', title: 'Invoice', readyState: 'complete', bodyTextHash: 'hash',
  nodeCount: elements.length, elements, coverage: { truncated: false, blockedByDialog: false, unreachableFrames: [] } });
const result = (s: any) => ({ success: true, value: { view: { source: { id: s.id, digest: s.digest }, coverage: s.coverage,
  elements: s.elements, errors: [{ source: 'network', message: 'payment rejected' }], omitted: { count: 0 } },
  action: { commandSucceeded: true, deliveryUnknown: true, evidence: [{ data: { clickDelivered: null, witnessedEvent: 'click' } }] },
  diagnostics: { network: 'available', networkAtLimit: true } } });

describe('compact transport contracts', () => {
  it('keeps separate label/amount text on the rendered row, with no guessed target identity', () => {
    const view: any = { elements: [{ k: 'total', role: 'text', text: 'Total' }, { k: 'amount', role: 'text', text: '$4.13' },
      { k: 'other', role: 'text', text: 'Different row' }], omitted: { count: 0 } };
    scopedWorkflowView(view, 'Total', {}, [], { total: [500, 100, 50, 20], amount: [800, 100, 50, 20], other: [800, 200, 50, 20] });
    expect(view.elements.map((n: any) => n.k)).toEqual(['total', 'amount']);
  });
  it('does not discard an unchanged explicit text query during action compaction', () => {
    const dir = root();
    try {
      const store = new StateStore('http://cdp', 'owned', 'page', dir);
      const s = state(store, [{ k: 'cashier', role: 'text', text: 'Cashier: Michel Untel' }]);
      const out = compactWorkflowResult(result(s), store, s.captureProfile, 'act', new Set(),
        workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact' }), { query: 'Cashier', task: 'buy' });
      expect(out.value.view.elements[0].text).toBe('Cashier: Michel Untel');
      expect(out.value.view.scope.matched).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('scopes literal labels while keeping child actions and global out-of-vocabulary safety state', () => {
    const view: any = { elements: [
      { k: 'counter', role: 'button', name: 'COUNTER +' }, { k: 'plus', role: 'button', name: '+' },
      { k: 'alert', role: 'alert', name: 'Account frozen' }, { k: 'invalid', role: 'textbox', state: { invalid: true } },
      { k: 'live', role: 'text', name: 'System unavailable' }, { k: 'selected', role: 'option', state: { selected: true } },
      { k: 'other', role: 'button', name: 'Refund' }
    ], diff: { changes: [{ key: 'other', kind: 'added', to: { role: 'button' } }, { key: 'oldAlert', kind: 'removed', from: { role: 'alert', name: 'Frozen' } }] }, omitted: { count: 0 } };
    scopedWorkflowView(view, 'counter', { plus: { parents: ['counter'] }, live: { live: true } });
    expect(view.elements.map((n: any) => n.k)).toEqual(['counter', 'plus', 'alert', 'invalid', 'live', 'selected']);
    expect(view.diff.changes).toHaveLength(1);
    expect(view.scope.excludedElements).toBe(1);
    expect(view.scope.excludedChanges).toBe(1);
    expect(() => workflowQueryTerms('a||b')).toThrow('INVALID_QUERY');
    expect(workflowQueryTerms('TPS|TVQ')).toEqual(['tps', 'tvq']);
  });
  it('expires reference namespaces with captures without reusing their refs', () => {
    const dir = root();
    try {
      const store = new StateStore('http://cdp', 'owned', 'page', dir, 1);
      const a = state(store, [{ k: 'same', role: 'button', name: 'Cash' }]);
      const ref = store.references(`${a.captureProfile}/${a.id}`, ['same']).same;
      const b = state(store, [{ k: 'same', role: 'button', name: 'Card' }]);
      expect(() => store.load(a.id)).toThrow('STATE_NOT_FOUND');
      expect(() => store.resolveReference(`${a.captureProfile}/${a.id}`, ref)).toThrow('REFERENCE_UNKNOWN');
      expect(store.references(`${b.captureProfile}/${b.id}`, ['same']).same).not.toBe(ref);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('binds refs to capture even when a reused structural key changes from Cash to Card', () => {
    const dir = root();
    try {
      const store = new StateStore('http://cdp', 'owned', 'page', dir);
      const a = state(store, [{ k: 'top|path:button:1', role: 'button', name: 'Cash', locator: '#cash' }]);
      const b = state(store, [{ k: 'top|path:button:1', role: 'button', name: 'Card', locator: '#card' }]);
      const profile = workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact' });
      const old = compactWorkflowResult(result(a), store, a.captureProfile, 'observe', new Set(), profile).value.view.elements[0].k;
      const fresh = compactWorkflowResult(result(b), store, b.captureProfile, 'observe', new Set(), profile).value.view.elements[0].k;
      expect(fresh).not.toBe(old);
      expect(() => store.resolveReference(`${b.captureProfile}/${b.id}`, old)).toThrow('REFERENCE_UNKNOWN');
      expect(store.resolveReference(`${b.captureProfile}/${b.id}`, fresh)).toBe('top|path:button:1');
      store.remove(a.id);
      expect(() => store.resolveReference(`${b.captureProfile}/${b.id}`, old)).toThrow('REFERENCE_UNKNOWN');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps witnesses through overflow and falls back truthfully after reference storage failure', () => {
    const dir = root();
    try {
      const store = new StateStore('http://cdp', 'owned', 'page', dir);
      const s = state(store, Array.from({ length: 200 }, (_, i) => ({ k: `button${i}`, role: 'button', name: '界'.repeat(100) })));
      const input = result(s), keys = new Set(s.elements.map(n => n.k));
      const profile = workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact' });
      const out = compactWorkflowResult(input, store, s.captureProfile, 'screenshot', keys, profile);
      expect(out.value.output.bounded).toBe(true);
      expect(out.value.action.witness).toEqual([{ clickDelivered: null, witnessedEvent: 'click', frameReached: undefined }]);
      expect(out.value.action.evidenceOmitted).toBe(1);
      expect(out.value.action.deliveryUnknown).toBe(true);
      expect(out.value.view.elements.length).toBeGreaterThan(0);
      expect(out.value.output.fullArtifactAvailable).toBe(true);
      vi.spyOn(store, 'references').mockImplementation(() => { throw new Error('reference disk failure'); });
      const fallback = compactWorkflowResult(input, store, s.captureProfile, 'act', keys, profile);
      expect(fallback.value.action.deliveryUnknown).toBe(true);
      expect(fallback.value.action.witness).toEqual(out.value.action.witness);
      expect(fallback.value.view.source).toEqual(input.value.view.source);
      expect(fallback.value.compactFormat.reason).toBe('reference-storage-failed');
      expect(fallback.value.view.elements[0].k).toMatch(/^button/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('never rebinds an old reference to another target across sources, reordering, profiles or restart', () => {
    const dir = root();
    try {
      const store = new StateStore('http://cdp', 'owned', 'page', dir);
      const a = state(store, [{ k: 'cash', role: 'button', locator: '#cash' }]);
      const old = store.references('profile', ['cash']).cash;
      const b = state(store, [{ k: 'card', role: 'button', locator: '#card' }, { k: 'cash', role: 'button', locator: '#cash' }]);
      const refs = store.references('profile', ['card', 'cash']);
      expect(refs.cash).toBe(old); expect(refs.card).not.toBe(old);
      expect(resolveWorkflowTarget(b, { page: 'page', task: 'pay', action: 'click', targetKey: store.resolveReference(b.captureProfile, old) })).toBe('#cash');
      const removed = state(store, [{ k: 'card', role: 'button', locator: '#card' }]);
      expect(() => resolveWorkflowTarget(removed, { page: 'page', task: 'pay', action: 'click', targetKey: store.resolveReference('profile', old) })).toThrow('UNKNOWN_OR_AMBIGUOUS');
      expect(() => store.resolveReference('other-profile', old)).toThrow('REFERENCE_UNKNOWN');
      expect(new StateStore('http://cdp', 'owned', 'page', dir).references('profile', ['cash']).cash).toBe(old);
      unlinkSync(join(store.dir, 'references.json'));
      expect(store.references('profile', ['card']).card).not.toBe(old);
      expect(() => store.resolveReference('profile', old)).toThrow('REFERENCE_UNKNOWN');
      expect(a.digest).toBe(store.load(a.id).digest);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves witness uncertainty and supplies historical receipt/errors without file tools', () => {
    const dir = root();
    try {
      const store = new StateStore('http://cdp', 'owned', 'page', dir), s = state(store, [{ k: 'cash', role: 'button', name: 'Cash' }]);
      const input = result(s), before = JSON.stringify(input);
      const out = compactWorkflowResult(input, store, 'profile', 'act', new Set(['cash']), workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact' }));
      expect(out.value.action.deliveryUnknown).toBe(true);
      expect(out.value.action.witness).toEqual([{ clickDelivered: null, witnessedEvent: 'click', frameReached: undefined }]);
      expect(out.value.view.elements[0].k).toMatch(/^r[a-f0-9]{16}\./);
      expect(JSON.stringify(input)).toBe(before);
      expect(JSON.parse(readFileSync(join(store.dir, `${s.id}-workflow.json`), 'utf8'))).toEqual(input);
      expect(expandWorkflowEvidence(store, s.id, 'receipt', 0, 10, 8000).value.records[0].action).toEqual(input.value.action);
      expect(expandWorkflowEvidence(store, s.id, 'errors', 0, 10, 8000).value.records).toEqual(input.value.view.errors);
      const pieces: string[] = []; let offset: number | null = 0;
      while (offset !== null) {
        const fragment = expandWorkflowEvidence(store, s.id, 'artifact', offset, 37, 8000);
        pieces.push(fragment.value.text); offset = fragment.value.pagination.nextOffset;
      }
      expect(JSON.parse(pieces.join(''))).toEqual(input);
      expect(() => expandWorkflowEvidence(store, '../escape', 'receipt', 0, 1, 8000)).toThrow('STATE_NOT_FOUND');
      unlinkSync(join(store.dir, `${s.id}-workflow.json`));
      expect(expandWorkflowEvidence(store, s.id, 'receipt', 0, 1, 8000).value.available).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains selected/changed options, out-of-vocabulary alerts and visible unchecked controls', () => {
    const dir = root();
    try {
      const store = new StateStore('http://cdp', 'owned', 'page', dir);
      const s = state(store, [
        { k: 'irrelevant-option', role: 'option', name: '2023', state: { vis: false, selected: false } },
        { k: 'selected', role: 'option', name: '2026', state: { vis: false, selected: true } },
        { k: 'changed', role: 'option', name: 'New business option', state: { vis: false, selected: false } },
        { k: 'check', role: 'checkbox', name: 'Consent', state: { checked: false } },
        { k: 'alert', role: 'alert', name: 'Account frozen' }
      ]);
      const input: any = result(s); input.value.view.diff = { changes: [{ kind: 'field', key: 'changed', field: 'name', to: 'New business option' }] };
      const out = compactWorkflowResult(input, store, 'profile', 'act', new Set(['check', 'selected']), workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact' }));
      expect(out.value.view.elements.map((n: any) => n.name)).toEqual(['2026', 'New business option', 'Consent', 'Account frozen']);
      expect(out.value.recovery.excluded.hiddenOptions).toBe(0);
      expect(store.load(s.id).elements).toHaveLength(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('recomputes protected omissions and bounds UTF8 without dropping diagnostic obligations silently', () => {
    const dir = root();
    try {
      const profile = workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact' });
      const base = { success: true, value: { view: { elements: [{ k: 'keep', role: 'button', name: 'Buy' }],
        errors: [], omitted: { count: 0 }, diff: { changes: [{ key: 'old', from: '界'.repeat(4000) }] } } } };
      const out = boundWorkflowResult(base, join(dir, 'original.json'), new Set(['keep']), profile);
      expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(8000);
      expect(out.value.view.elements[0].k).toBe('keep');
      expect(out.value.output.omittedChanges).toBe(1);
      expect(out.value.output.protectedEvidenceOmitted).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
