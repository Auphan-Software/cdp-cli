import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/workflow.js', () => ({ runCli: mocks.run }));
import { callWorkflowTool, createWorkflowBudget } from '../../src/workflow-mcp.js';

const args = { task: 'click once', source: 'source', action: 'click', targetKey: 'top|id:save' };
const first = (result: any) => JSON.parse(result.content[0].text);
const status = (result: any) => result.content.filter((block: any) => block.type === 'text')
  .map((block: any) => { try { return JSON.parse(block.text); } catch { return {}; } })
  .find((row: any) => row.type === 'workflow-execution-budget').value;

beforeEach(() => {
  vi.stubEnv('CDP_PAGE', 'owned-page'); vi.stubEnv('CDP_SESSION', 'owned-session');
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ ok: true, rows: [{ success: true, value: { view: { source: { id: 'fresh' } }, action: { commandSucceeded: true, deliveryUnknown: false } } }] });
});
afterEach(() => vi.unstubAllEnvs());

describe('per-bridge execution budgets', () => {
  it.each(['', ' ', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992'])('rejects invalid configuration %j', value => {
    for (const name of ['CDP_WORKFLOW_MAX_ACTIONS', 'CDP_WORKFLOW_DEADLINE_MS']) {
      expect(() => createWorkflowBudget({ [name]: value })).toThrow(`WORKFLOW_INVALID_BUDGET_CONFIGURATION: ${name}`);
    }
  });
  it('is opt-in and permits zero-valued limits to deny all actions', async () => {
    const disabled = createWorkflowBudget({}, () => 0);
    expect(disabled.snapshot()).toMatchObject({ enabled: false, maxActions: null, deadlineMs: null });
    const unlimited: any = await callWorkflowTool('act', args, disabled);
    expect(unlimited.content).toHaveLength(1);
    for (const [name, code] of [['CDP_WORKFLOW_MAX_ACTIONS', 'ACTION_BUDGET_EXHAUSTED'], ['CDP_WORKFLOW_DEADLINE_MS', 'DEADLINE_EXCEEDED']]) {
      const budget = createWorkflowBudget({ [name]: '0' }, () => 0);
      const denied: any = await callWorkflowTool('act', args, budget);
      expect(first(denied).value.action).toMatchObject({ code: `WORKFLOW_${code}`, actionDelivered: false, deliveryUnknown: false });
      expect(status(denied).actionsUsed).toBe(0);
    }
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it('enforces the cap before spawning another action while retaining receipts and recovery tools', async () => {
    const budget = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1', CDP_WORKFLOW_DEADLINE_MS: '100' }, () => 0);
    const receipt = { success: true, value: { action: { commandSucceeded: true, deliveryUnknown: false, evidence: [{ data: { clickDelivered: true } }] }, view: { source: { id: 'completed' } } } };
    mocks.run.mockResolvedValue({ ok: true, rows: [receipt] });
    const completed: any = await callWorkflowTool('act', args, budget);
    expect(first(completed)).toEqual(receipt);
    expect(status(completed)).toMatchObject({ actionsUsed: 1, actionsRemaining: 0, exhausted: true });
    const denied: any = await callWorkflowTool('act', args, budget);
    expect(denied.isError).toBe(true);
    expect(first(denied).value.action).toMatchObject({ code: 'WORKFLOW_ACTION_BUDGET_EXHAUSTED', actionDelivered: false });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await callWorkflowTool('observe', { task: 'recover' }, budget);
    await callWorkflowTool('expand', { task: 'inspect', source: 'completed' }, budget);
    expect(mocks.run).toHaveBeenCalledTimes(3);
    expect(budget.snapshot().actionsUsed).toBe(1);
  });
  it('counts failed, stale and unknown-delivery admissions without refunding them', async () => {
    for (const receipt of [
      { success: false, value: { action: { actionDelivered: false, code: 'WORKFLOW_STALE_SOURCE' } } },
      { success: false, value: { action: { commandSucceeded: false, deliveryUnknown: false } } },
      { success: false, value: { action: { commandSucceeded: null, deliveryUnknown: true } } }
    ]) {
      const budget = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1' }, () => 0);
      mocks.run.mockResolvedValue({ ok: false, rows: [receipt] });
      const result: any = await callWorkflowTool('act', args, budget);
      expect(first(result)).toEqual(receipt);
      expect(result.isError).toBe(true);
      expect(status(result).actionsUsed).toBe(1);
      expect(first(await callWorkflowTool('act', args, budget)).value.action.code).toBe('WORKFLOW_ACTION_BUDGET_EXHAUSTED');
    }
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });
  it('keeps unknown delivery and spent budget on a child transport failure', async () => {
    const budget = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1' }, () => 0);
    mocks.run.mockRejectedValue(new Error('WORKFLOW_COMMAND_TIMEOUT'));
    const result: any = await callWorkflowTool('act', args, budget);
    expect(first(result).value.action).toMatchObject({ commandSucceeded: null, deliveryUnknown: true });
    expect(status(result).actionsRemaining).toBe(0);
    expect(first(await callWorkflowTool('act', args, budget)).value.action.actionDelivered).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it('uses bridge-start elapsed time, rejects actions at the deadline and allows recovery after it', async () => {
    let time = 1000;
    const budget = createWorkflowBudget({ CDP_WORKFLOW_DEADLINE_MS: '50' }, () => time);
    time = 1049.5;
    expect(budget.snapshot()).toMatchObject({ remainingMs: 1, exhausted: false });
    const allowed: any = await callWorkflowTool('act', args, budget);
    expect(status(allowed)).toMatchObject({ actionsUsed: 1, deadlineMs: 50 });
    time = 1050;
    const denied: any = await callWorkflowTool('act', args, budget);
    expect(first(denied).value.action.code).toBe('WORKFLOW_DEADLINE_EXCEEDED');
    expect(status(denied)).toMatchObject({ elapsedMs: 50, remainingMs: 0, exhausted: true, actionsUsed: 1 });
    await callWorkflowTool('observe', { task: 'recover' }, budget);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('retains an already-admitted action result when its deadline expires during execution', async () => {
    let time = 0;
    const budget = createWorkflowBudget({ CDP_WORKFLOW_DEADLINE_MS: '50' }, () => time);
    const receipt = { success: true, value: { action: { commandSucceeded: true, deliveryUnknown: false } } };
    mocks.run.mockImplementation(async () => { time = 60; return { ok: true, rows: [receipt] }; });
    const result: any = await callWorkflowTool('act', args, budget);
    expect(first(result)).toEqual(receipt);
    expect(result.isError).not.toBe(true);
    expect(status(result)).toMatchObject({ remainingMs: 0, exhausted: true });
  });
  it('does not spend a budget on invalid MCP arguments and isolates different bridge policies', async () => {
    const budget = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1' }, () => 0);
    await expect(callWorkflowTool('act', { ...args, action: 'invented' }, budget)).rejects.toThrow('Invalid option');
    await expect(callWorkflowTool('act', { ...args, source: '' }, budget)).rejects.toThrow('Missing');
    await expect(callWorkflowTool('act', { ...args, waitFor: ' ' }, budget)).rejects.toThrow('empty wait');
    expect(budget.snapshot().actionsUsed).toBe(0);
    const other = createWorkflowBudget({ CDP_WORKFLOW_MAX_ACTIONS: '1' }, () => 0);
    await Promise.all([callWorkflowTool('act', args, budget), callWorkflowTool('act', args, budget)]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await callWorkflowTool('act', args, other);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(other.snapshot().actionsUsed).toBe(1);
  });
});
