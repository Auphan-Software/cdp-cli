import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, waitFor, type LiveFixture } from './harness.js';
import { WorkspaceSessionService, defaultWorkspaceSessionStorePath } from '../../src/sessions/workspace-session-service.js';
import { CDPDaemon } from '../../src/daemon/daemon.js';
import { DaemonClient } from '../../src/daemon/client.js';

let chrome: LiveChrome, app: LiveFixture, root: string, daemon: CDPDaemon;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-workflow-stale-mcp-'));
  app = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<script>window.targetClicks=0</script>' +
      '<button id="increment" onclick="window.targetClicks++;this.textContent=String(window.targetClicks)">0</button>' +
      '<div id="total" role="status">Invoice total 4.13</div>' +
      Array.from({ length: 180 }, (_, i) => `<button id="control${i}">Buy item ${i} ${'label '.repeat(16)}</button>`).join(''));
  });
  chrome = await LiveChrome.launch();
  daemon = new CDPDaemon({ port: 0, cdpUrl: chrome.cdpUrl, healthCheckIntervalMs: 1000 });
  await daemon.start();
}, 30000);
afterAll(async () => {
  await daemon?.stop(); await chrome?.close(); await app?.close();
  if (chrome) await rm(defaultWorkspaceSessionStorePath(chrome.cdpUrl), { force: true });
  if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
}, 30000);

const receipt = (response: any) => JSON.parse(response.content[0].text);
const budget = (response: any) => response.content.filter((block: any) => block.type === 'text')
  .flatMap((block: any) => { try { return [JSON.parse(block.text)]; } catch { return []; } })
  .find((row: any) => row.type === 'workflow-execution-budget').value;

describe('recoverable stale receipts in the real stdio MCP bridge', () => {
  it('preserves large JSON recovery state without MCP error classification and never delivers the stale action', async () => {
    const name = 'stale-mcp';
    const service = await WorkspaceSessionService.open(chrome.cdpUrl);
    let page: string;
    try { page = (await service.createSession(name, { url: app.baseUrl })).pageIds[0]; }
    finally { service.close(); }
    const daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
    const client = new DaemonClient({ daemonUrl, cdpUrl: chrome.cdpUrl });
    await waitFor(async () => { if (!(await client.listSessions()).some(session => session.pageId === page)) throw new Error('Registering owned page'); }, 10000);
    const bridge = (profile: string) => {
      const child = spawn(process.execPath, [resolve('build/index.js'), 'workflow-mcp'], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
          CDP_SESSION: name, CDP_PAGE: page, CDP_URL: chrome.cdpUrl, CDP_DAEMON_URL: daemonUrl, CDP_STATE_ROOT: root,
          CDP_RERANK_URL: 'off', CDP_WORKFLOW_CLOCK_SELECTORS: '[]', CDP_WORKFLOW_VIEW_PROFILE: profile,
          CDP_WORKFLOW_MAX_ACTIONS: '10', CDP_WORKFLOW_DEADLINE_MS: '60000' }
      });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      let id = 0;
      return {
        request: async (method: string, params: any = {}) => {
          const response = once(lines, 'line');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
          const envelope = JSON.parse((await response)[0]);
          expect(envelope.id).toBe(id);
          expect(envelope.error).toBeUndefined();
          return envelope.result;
        },
        close: async () => { const exited = once(child, 'exit'); child.stdin.end(); await exited; lines.close(); }
      };
    };
    const valid = bridge('current-24k'), invalid = bridge('unsupported');
    const pageInfo = (await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as any[]).find(item => item.id === page);
    const fixture = await CdpSession.connect(pageInfo.webSocketDebuggerUrl);
    const evaluate = async (expression: string) => (await fixture.command('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    try {
      await valid.request('initialize'); await invalid.request('initialize');
      const observed = await valid.request('tools/call', { name: 'observe', arguments: {
        task: 'increment once and retain invoice evidence', full: true, maxElements: 500, stabilityMs: 20 }
      });
      expect(observed.isError).not.toBe(true);
      const oldSource = receipt(observed).value.view.source.id;
      expect(budget(observed).actionsUsed).toBe(0);
      expect(await evaluate("document.querySelector('#total').textContent='Invoice total 9.99';window.targetClicks")).toBe(0);
      const act = (source: string) => ({ name: 'act', arguments: {
        task: 'increment once and retain invoice evidence', source, action: 'click', targetKey: 'top|id:increment', full: true, stabilityMs: 20 }
      });
      const stale = await valid.request('tools/call', act(oldSource));
      expect(stale.isError).not.toBe(true);
      // Larger than Claude's error truncation threshold: retain complete parseable
      // state and typed no-delivery evidence, not merely its first/last fragments.
      expect(stale.content[0].text.length).toBeGreaterThan(10000);
      expect(Buffer.byteLength(stale.content[0].text)).toBeLessThanOrEqual(24000);
      for (const block of stale.content) if (block.type === 'text') expect(() => JSON.parse(block.text)).not.toThrow();
      const recovered = receipt(stale);
      expect(recovered).toMatchObject({ success: false, type: 'workflow-stale', value: {
        action: { code: 'WORKFLOW_STALE_SOURCE', actionDelivered: false, commandSucceeded: false, deliveryUnknown: false },
        output: { profile: 'current-24k', maxBytes: 24000 }
      } });
      expect(recovered.value.view.source.id).not.toBe(oldSource);
      expect(recovered.value.view.elements.find((node: any) => node.k === 'top|id:total').name).toContain('9.99');
      expect(budget(stale).actionsUsed).toBe(1);
      expect(await evaluate('window.targetClicks')).toBe(0);
      const done = await valid.request('tools/call', act(recovered.value.view.source.id));
      expect(done.isError, JSON.stringify(done)).not.toBe(true);
      expect(receipt(done).value.action).toMatchObject({ commandSucceeded: true, deliveryUnknown: false });
      const completed = receipt(done);
      const delivery = completed.value.output?.bounded ? JSON.parse(await readFile(completed.value.output.fullPath, 'utf8')) : completed;
      expect(delivery.value.action.evidence[0].data.clickDelivered).toBe(true);
      expect(budget(done).actionsUsed).toBe(2);
      expect(await evaluate('window.targetClicks')).toBe(1);
      const currentSource = receipt(done).value.view.source.id;
      const malformed = await valid.request('tools/call', { ...act(currentSource), arguments: { ...act(currentSource).arguments, maxElements: 1 } });
      expect(malformed.isError).toBe(true);
      expect(malformed.content[0].text).toContain('Unknown option for act');
      expect(budget(malformed).actionsUsed).toBe(2);
      const badProfile = await invalid.request('tools/call', act(currentSource));
      expect(badProfile.isError).toBe(true);
      expect(badProfile.content[0].text).toContain('WORKFLOW_INVALID_VIEW_PROFILE');
      expect(budget(badProfile).actionsUsed).toBe(0);
      expect(await evaluate('window.targetClicks')).toBe(1);
    } finally { fixture.close(); await valid.close(); await invalid.close(); }
  }, 45000);
});
