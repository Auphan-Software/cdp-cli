import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn() }));
vi.mock('../../src/workflow.js', () => ({ runCli: mocks.run }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read }));
import { callWorkflowTool, createWorkflowBudget } from '../../src/workflow-mcp.js';

describe('readable expected refusals', () => {
  it('rejects malformed queries/scales before dispatch and admission, preserving current-source recovery', async () => {
    vi.stubEnv('CDP_PAGE', 'owned-page'); vi.stubEnv('CDP_SESSION', 'owned-session');
    vi.stubEnv('CDP_WORKFLOW_VIEW_PROFILE', 'haiku-compact'); mocks.run.mockClear();
    const budget = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1' });
    try {
      for (const options of [{ query: 'a|b|c|d|e|f|g|h|i' }, { query: 'a||b' }, { query: 'x', full: true },
        { screenshotScale: NaN }, { screenshotScale: Infinity }, { screenshotScale: 0 }, { screenshotScale: 1.1 }]) {
        const response: any = await callWorkflowTool('act', { task: 'click once', source: 'current', action: 'click', ...options }, budget);
        const receipt = JSON.parse(response.content[0].text);
        expect(receipt.type).toBe('workflow-input-rejection');
        expect(receipt.value.rejection.commandDispatched).toBe(false);
        expect(response.isError).not.toBe(true);
      }
      expect(mocks.run).not.toHaveBeenCalled(); expect(budget.snapshot().actionsUsed).toBe(0);
      mocks.run.mockResolvedValue({ ok: true, rows: [{ success: true }] });
      await callWorkflowTool('act', { task: 'click once', source: 'current', action: 'click', query: 'x', screenshotScale: 0.25 }, budget);
      expect(budget.snapshot().actionsUsed).toBe(1);
      expect(mocks.run.mock.calls[0][0]).toContain('--screenshot-scale');
    } finally { vi.unstubAllEnvs(); }
  });
  it('returns malformed required arguments with profile and no dispatch or action-budget consumption', async () => {
    vi.stubEnv('CDP_PAGE', 'owned-page'); vi.stubEnv('CDP_SESSION', 'owned-session');
    mocks.run.mockClear();
    const budget = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1' });
    try {
      for (const [name, args] of [['observe', {}], ['act', { task: 'click', action: 'click' }]] as const) {
        const result: any = await callWorkflowTool(name, args, budget);
        const receipt = JSON.parse(result.content[0].text);
        expect(result.isError).not.toBe(true);
        expect(receipt.value.rejection.commandDispatched).toBe(false);
        expect(receipt.value.output.profile).toBe('current-24k');
        expect(receipt.value).not.toHaveProperty('view');
      }
      expect(mocks.run).not.toHaveBeenCalled();
      expect(budget.snapshot().actionsUsed).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });
  it('keeps target refusals readable only with explicit no-delivery and fresh state', async () => {
    vi.stubEnv('CDP_PAGE', 'owned-page'); vi.stubEnv('CDP_SESSION', 'owned-session');
    const receipt = { success: false, type: 'workflow-target-rejection', value: {
      action: { code: 'WORKFLOW_TARGET_KEY_UNAVAILABLE', actionDelivered: false, commandSucceeded: false, deliveryUnknown: false },
      view: { source: { id: 'fresh' } }
    } };
    try {
      mocks.run.mockResolvedValue({ ok: false, rows: [receipt] });
      expect((await callWorkflowTool('act', { task: 'click', source: 'old', action: 'click', targetKey: 'hidden' }) as any).isError).not.toBe(true);
      receipt.value.action.deliveryUnknown = true;
      expect((await callWorkflowTool('act', { task: 'click', source: 'old', action: 'click', targetKey: 'hidden' }) as any).isError).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
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
