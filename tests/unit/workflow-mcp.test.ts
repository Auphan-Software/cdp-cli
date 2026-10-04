import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn() }));
vi.mock('../../src/workflow.js', () => ({ runCli: mocks.run }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read }));
import { callWorkflowTool } from '../../src/workflow-mcp.js';

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
