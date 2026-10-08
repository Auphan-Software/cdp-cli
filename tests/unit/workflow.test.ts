import { describe, it, expect, vi } from 'vitest';
import { actionArgs, semanticSignature } from '../../src/workflow.js';
import { callWorkflowTool } from '../../src/workflow-mcp.js';
import type { PageState } from '../../src/state/types.js';

describe('deterministic workflow contracts', () => {
  it('uses argument arrays, permits empty fill, and restricts navigation', () => {
    const common = { page: 'owned', task: 'reproduce' };
    expect(actionArgs({ ...common, action: 'fill', selector: '#x', value: '' })).toEqual(['fill', '#x', '', 'owned', '--expect-value', '--timeout', '10000']);
    expect(actionArgs({ ...common, action: 'click', selector: '#x; $(secret)', frame: '#embedded', waitFor: '#done' })).toEqual(['click', '#x; $(secret)', 'owned', '--frame', '#embedded', '--wait-for', '#done', '--timeout', '10000']);
    expect(() => actionArgs({ ...common, action: 'navigate', url: 'javascript:alert(1)' })).toThrow('HTTP_URL');
    expect(() => actionArgs({ ...common, action: 'eval', value: 'anything' })).toThrow('INVALID_ACTION');
    expect(() => actionArgs({ ...common, action: 'fill', selector: '#x' })).toThrow('REQUIRED_VALUE');
    expect(() => actionArgs({ ...common, action: 'press-key', key: 'Enter', frame: '#embed' })).toThrow('FRAMED_KEY');
  });
  it('ignores capture bookkeeping and layout but rejects changed evidence and ownership', () => {
    const original = { id: 'old', seq: 1, capturedAt: 'old', targetId: 'page', url: 'https://example.test', session: 'a', elements: [{ k: 'top|id:x', text: 'old', box: [1,2,3,4] }], coverage: { truncated: false } } as unknown as PageState;
    const updated = structuredClone(original); updated.id = 'new'; updated.seq++; updated.elements[0].box = [5,6,7,8];
    expect(semanticSignature(updated)).toBe(semanticSignature(original));
    updated.elements[0].text = 'new'; expect(semanticSignature(updated)).not.toBe(semanticSignature(original));
    updated.elements[0].text = 'old'; updated.session = 'b'; expect(semanticSignature(updated)).not.toBe(semanticSignature(original));
    updated.session = 'a'; updated.hints = { 'top|id:x': { context: ['Account B'] } };
    expect(semanticSignature(updated)).not.toBe(semanticSignature(original));
  });
  it('refuses MCP browser access without inherited ownership and rejects injected options', async () => {
    vi.stubEnv('CDP_PAGE', ''); vi.stubEnv('CDP_SESSION', '');
    try {
      await expect(callWorkflowTool('observe', { task: 'read' })).rejects.toThrow('must be inherited');
      vi.stubEnv('CDP_PAGE', 'exact-page'); vi.stubEnv('CDP_SESSION', 'owner');
      await expect(callWorkflowTool('act', { task: 'read', page: 'other-page' })).rejects.toThrow('Unknown option');
      await expect(callWorkflowTool('observe', { task: 'read', maxElements: -1 })).rejects.toThrow('Invalid option');
      const missing: any = await callWorkflowTool('act', { task: 'read', action: 'click' });
      expect(JSON.parse(missing.content[0].text)).toMatchObject({ success: false, type: 'workflow-input-rejection', value: { rejection: { commandDispatched: false } } });
    } finally { vi.unstubAllEnvs(); }
  });
  it('keeps screenshot alignment strict even for tolerated configured clock ticks', () => {
    const before = { targetId: 'page', bodyTextHash: '9:22', actionTextHash: 'same business text', elements: [{ k: 'clock', role: 'text', cosmeticClock: true, text: '9:22' }], coverage: {} } as unknown as PageState;
    const after = { ...before, bodyTextHash: '9:23', elements: [{ ...before.elements[0], text: '9:23' }] };
    expect(semanticSignature(before)).toBe(semanticSignature(after));
    expect(semanticSignature(before, false)).not.toBe(semanticSignature(after, false));
  });
});
