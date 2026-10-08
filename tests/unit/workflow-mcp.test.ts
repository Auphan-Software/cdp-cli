import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn() }));
vi.mock('../../src/workflow.js', () => ({ runCli: mocks.run }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read }));
import { callWorkflowTool, createWorkflowBudget } from '../../src/workflow-mcp.js';

describe('readable expected refusals', () => {
  it('retains large stale receipts as structured normal results, but never hides ambiguous delivery or unexpected errors', async () => {
    vi.stubEnv('CDP_PAGE', 'owned-page'); vi.stubEnv('CDP_SESSION', 'owned-session');
    const receipt = { success: false, type: 'workflow-stale', value: {
      action: { code: 'WORKFLOW_STALE_SOURCE', actionDelivered: false, commandSucceeded: false, deliveryUnknown: false },
      view: { source: { id: 'fresh-after-refusal' }, elements: [{ text: 'evidence'.repeat(2500) }] }
    } };
    try {
      for (const mutate of [() => {}, () => { receipt.value.action.deliveryUnknown = true; },
        () => { receipt.value.action.deliveryUnknown = false; receipt.type = 'workflow-command-failed'; }]) {
        mutate();
        mocks.run.mockResolvedValue({ ok: false, rows: [receipt] });
        const result: any = await callWorkflowTool('act', { task: 'once', source: 'old', action: 'click', targetKey: 'top|id:save' }, createWorkflowBudget({}));
        expect(JSON.parse(result.content[0].text)).toEqual(receipt);
        expect(result.content[0].text.length).toBeGreaterThan(10000);
        expect(result.isError === true).toBe(receipt.type !== 'workflow-stale' || receipt.value.action.deliveryUnknown);
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('workflow image evidence recovery', () => {
  it('retains completed action evidence when the saved image becomes unreadable', async () => {
    vi.stubEnv('CDP_PAGE', 'owned-page'); vi.stubEnv('CDP_SESSION', 'owned-session');
    mocks.run.mockResolvedValue({ ok: true, rows: [{ success: true, value: {
      action: { commandSucceeded: true }, view: { source: { id: 'completed' } }, screenshot: { available: true, path: 'gone.png' }
    } }] });
    mocks.read.mockImplementation(() => { throw new Error('ENOENT'); });
    try {
      const result = await callWorkflowTool('screenshot', { task: 'evidence' }) as { content: Array<{type:string;text?:string}>;isError?:boolean };
      expect(JSON.parse(result.content[0].text!).value.action.commandSucceeded).toBe(true);
      expect(result.content[1].text).toContain('without repeating the action');
      expect(result.content.some(block => block.type === 'image')).toBe(false);
      expect(result.isError).not.toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});
