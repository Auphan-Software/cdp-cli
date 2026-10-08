import { describe, it, expect, vi } from 'vitest';
vi.unmock('fs');
const mocks = vi.hoisted(() => ({ capture: vi.fn(), exec: vi.fn() }));
vi.mock('../../src/commands/state.js', () => ({ capture: mocks.capture }));
vi.mock('node:child_process', async original => ({ ...(await original() as object), execFile: mocks.exec }));
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { workflow } from '../../src/workflow.js';
import type { CDPContext } from '../../src/context.js';
import type { PageState } from '../../src/state/types.js';

describe('post-delivery observation recovery', () => {
  it('captures fresh state for a hidden canonical target without dispatching an action', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-hidden-'));
    vi.stubEnv('CDP_STATE_ROOT', root); vi.stubEnv('CDP_WORKFLOW_CLOCK_SELECTORS', '[]');
    mocks.exec.mockClear();
    try {
      const context = { cdpUrl: 'http://owned.test', workspaceSessionName: 'owner', findPage: async () => ({ id: 'page' }) } as unknown as CDPContext;
      const store = new StateStore(context.cdpUrl, 'owner', 'page', root);
      const canonical = { schema: 'cdp-cli.page-state/1', capturedAt: '', targetId: 'page', session: 'owner', captureProfile: 'profile', url: 'http://owned.test', title: 'Owned', readyState: 'complete', bodyTextHash: 'same', nodeCount: 1,
        elements: [{ k: 'top|id:hidden', kq: 'strong', role: 'button', name: 'Hidden', locator: '#hidden', state: { vis: false, en: true } }],
        coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false } } as Omit<PageState,'id'|'seq'|'digest'>;
      const source = store.save(canonical);
      mocks.capture.mockImplementationOnce(async (_context, options) => { options.onCaptured(store.save(canonical)); return true; });
      const result: any = await workflow(context, 'act', { page: 'page', task: 'hidden click', source: source.id, action: 'click', targetKey: 'top|id:hidden' });
      expect(result.success).toBe(false);
      expect(result.type).toBe('workflow-target-rejection');
      expect(result.value.action).toMatchObject({ code: 'WORKFLOW_TARGET_KEY_UNAVAILABLE', actionDelivered: false, commandSucceeded: false, deliveryUnknown: false });
      expect(result.value.view.source.id).not.toBe(source.id);
      expect(result.value.output.profile).toBe('current-24k');
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
  it('bounds a large delivered-command receipt even when subsequent capture fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-recovery-'));
    vi.stubEnv('CDP_STATE_ROOT', root); vi.stubEnv('CDP_WORKFLOW_CLOCK_SELECTORS', '[]');
    try {
      const context = { cdpUrl: 'http://owned.test', workspaceSessionName: 'owner', findPage: async () => ({ id: 'page' }) } as unknown as CDPContext;
      const store = new StateStore(context.cdpUrl, 'owner', 'page', root);
      const canonical = { schema: 'cdp-cli.page-state/1', capturedAt: '', targetId: 'page', session: 'owner', captureProfile: 'profile', url: 'http://owned.test', title: 'Owned', readyState: 'complete', bodyTextHash: 'same', nodeCount: 0, elements: [], coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false } } as Omit<PageState,'id'|'seq'|'digest'>;
      const source = store.save(canonical);
      mocks.capture.mockImplementationOnce(async (_context, options) => { options.onCaptured(store.save(canonical)); return true; }).mockResolvedValueOnce(false);
      mocks.exec.mockImplementation((_file, _args, _options, callback) => callback(null, { stdout: JSON.stringify({ success: true, receipt: 'x'.repeat(60000) }) }));
      const result = await workflow(context, 'act', { page: 'page', task: 'click once', source: source.id, action: 'click', selector: '#save' }) as any;
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
      expect(result.value.action.commandSucceeded).toBe(true);
      expect(result.value.action.deliveryUnknown).toBe(false);
      expect(result.value.observationUnavailable).toBe(true);
      expect(JSON.parse(readFileSync(result.value.output.fullPath, 'utf8')).value.action.evidence[0].receipt).toHaveLength(60000);
      expect(mocks.exec).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
  it('retains explicit unknown click delivery when the command completed but the witness could not verify it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-click-unknown-'));
    vi.stubEnv('CDP_STATE_ROOT', root); vi.stubEnv('CDP_WORKFLOW_CLOCK_SELECTORS', '[]');
    try {
      const context = { cdpUrl: 'http://owned.test', workspaceSessionName: 'owner', findPage: async () => ({ id: 'page' }) } as unknown as CDPContext;
      const store = new StateStore(context.cdpUrl, 'owner', 'page', root);
      const canonical = { schema: 'cdp-cli.page-state/1', capturedAt: '', targetId: 'page', session: 'owner', captureProfile: 'profile', url: 'http://owned.test', title: 'Owned', readyState: 'complete', bodyTextHash: 'same', nodeCount: 0, elements: [], coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false } } as Omit<PageState,'id'|'seq'|'digest'>;
      const source = store.save(canonical);
      mocks.capture.mockImplementationOnce(async (_context, options) => { options.onCaptured(store.save(canonical)); return true; }).mockResolvedValueOnce(false);
      mocks.exec.mockImplementation((_file, _args, _options, callback) => callback(null, { stdout: JSON.stringify({ success: true, data: { clickDelivered: null, frameReached: null } }) }));
      const result = await workflow(context, 'act', { page: 'page', task: 'click once', source: source.id, action: 'click', selector: '#save' }) as any;
      expect(result.value.action.commandSucceeded).toBe(true);
      expect(result.value.action.deliveryUnknown).toBe(true);
      expect(result.value.action.evidence[0].data.clickDelivered).toBe(null);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
});
