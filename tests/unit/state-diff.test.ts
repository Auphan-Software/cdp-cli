import { describe, expect, it } from 'vitest';
import { diffStates, expectState } from '../../src/state/diff.js';
import type { PageState, StateElement } from '../../src/state/types.js';

const element = (k: string, extra: Partial<StateElement> = {}): StateElement => ({
  k, kq: 'strong', role: 'button', state: { vis: true, en: true }, ...extra
});
const state = (seq: number, elements: StateElement[] = [], extra: Partial<PageState> = {}): PageState => ({
  schema: 'cdp-cli.page-state/1', id: `id-${seq}`, seq, capturedAt: '2026-09-25T00:00:00Z',
  targetId: 'target', captureProfile: 'default', url: 'http://fixture/', title: 'Fixture', readyState: 'complete',
  bodyTextHash: 'same', nodeCount: 10, elements,
  coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false }, digest: `digest-${seq}`,
  ...extra
});

describe('page state diff', () => {
  it('reports a no-op as unchanged', () => {
    expect(diffStates(state(1, [element('save')]), state(2, [element('save')])).changed).toBe(false);
  });

  it('reports exact control field changes', () => {
    const delta = diffStates(state(1, [element('save', { state: { vis: true, en: false } })]),
      state(2, [element('save')]));
    expect(delta.changes).toContainEqual({ kind: 'field', key: 'save', field: 'state.en', from: false, to: true });
    expect(delta.changed).toBe(true);
  });

  it('detects plain text changes outside controls', () => {
    const delta = diffStates(state(1, [], { bodyTextHash: 'old' }), state(2, [], { bodyTextHash: 'new' }));
    expect(delta.changes).toContainEqual({ kind: 'text-unmodelled', field: 'bodyTextHash', from: 'old', to: 'new' });
  });

  it('includes added element meaning without a duplicate body-text line', () => {
    const delta = diffStates(state(1, [], { bodyTextHash: 'old' }),
      state(2, [element('menu', { role: 'menuitem', name: 'English' })], { bodyTextHash: 'new' }));
    expect(delta.changes).toEqual([{ kind: 'added', key: 'menu',
      to: { role: 'menuitem', name: 'English', text: undefined, state: { vis: true, en: true } } }]);
  });

  it('does not claim unchanged with unreachable frames', () => {
    const delta = diffStates(state(1), state(2, [], { coverage: { truncated: false, unreachableFrames: ['frame:x'], blockedByDialog: false } }));
    expect(delta.changed).toBeNull();
    expect(expectState(delta, { mustNotChange: [{ key: 'save' }] }).outcome).toBe('UNKNOWN');
  });

  it('evaluates expected and forbidden transitions', () => {
    const delta = diffStates(state(1, [element('save', { state: { vis: true, en: false } })]), state(2, [element('save')]));
    expect(expectState(delta, { mustChange: [{ key: 'save', field: 'state.en', from: false, to: true }] }).outcome).toBe('PASSED');
    expect(expectState(delta, { mustNotChange: [{ key: 'save', field: 'state.en' }] }).outcome).toBe('FAILED');
  });

  it('does not pass an invariant whose key was absent in both captures', () => {
    const before = state(1, [element('save')]);
    const after = state(2, [element('save')]);
    expect(expectState(diffStates(before, after), { mustNotChange: [{ key: 'missing-total' }] }, before, after).outcome).toBe('UNKNOWN');
  });

  it('does not turn a dialog-blocked capture into removals or navigation', () => {
    const before = state(1, [element('save')]);
    const after = state(2, [], { url: '', dialog: { type: 'alert', messageLength: 5 },
      coverage: { truncated: false, unreachableFrames: [], blockedByDialog: true } });
    const delta = diffStates(before, after);
    expect(delta.changed).toBeNull();
    expect(delta.changes).toEqual([{ kind: 'dialog', key: '@dialog', from: undefined,
      to: { type: 'alert', messageLength: 5 } }]);
    expect(expectState(delta, { mustChange: [{ key: '@dialog', kind: 'dialog' }] }, before, after).outcome).toBe('UNKNOWN');
  });

  it('refuses reversed captures and different targets', () => {
    expect(() => diffStates(state(2), state(1))).toThrow('STATE_REVERSED');
    expect(() => diffStates(state(1), state(2, [], { targetId: 'other' }))).toThrow('STATE_TARGET_MISMATCH');
    expect(() => diffStates(state(1), state(2, [], { captureProfile: 'different' }))).toThrow('STATE_CAPTURE_OPTIONS_MISMATCH');
  });

  it('does not exact-match ambiguous keys', () => {
    const before = state(1, [element('edit', { kq: 'ambiguous', name: 'First' })]);
    const after = state(2, [element('edit', { kq: 'ambiguous', name: 'Second' })]);
    expect(diffStates(before, after).changes).toEqual([]);
  });
});
