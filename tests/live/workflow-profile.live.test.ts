import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, waitFor, type LiveFixture } from './harness.js';
import { WorkspaceSessionService, defaultWorkspaceSessionStorePath } from '../../src/sessions/workspace-session-service.js';
import { CDPDaemon } from '../../src/daemon/daemon.js';
import { DaemonClient } from '../../src/daemon/client.js';
import { semanticSignature } from '../../src/workflow.js';

let chrome: LiveChrome, app: LiveFixture, root: string, daemon: CDPDaemon;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-workflow-profile-'));
  app = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<button id="increment" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>` +
      Array.from({ length: 180 }, (_, i) => `<button id="control${i}">Buy ${i} ${'界'.repeat(60)}</button>`).join(''));
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

describe('transport profiles in the deployed real MCP bridge', () => {
  it('retains richer controls with matching canonical state, accepts its target key and rejects invalid config before mutation', async () => {
    const service = await WorkspaceSessionService.open(chrome.cdpUrl);
    let page: string;
    try { page = (await service.createSession('profiles', { url: app.baseUrl })).pageIds[0]; }
    finally { service.close(); }
    const daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
    const client = new DaemonClient({ daemonUrl, cdpUrl: chrome.cdpUrl });
    await waitFor(async () => { if (!(await client.listSessions()).some(session => session.pageId === page)) throw new Error('Registering owned page'); }, 10000);
    const bridge = (profile: string) => {
      const child = spawn(process.execPath, [resolve('build/index.js'), 'workflow-mcp'], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
          CDP_SESSION: 'profiles', CDP_PAGE: page, CDP_URL: chrome.cdpUrl, CDP_DAEMON_URL: daemonUrl, CDP_STATE_ROOT: root,
          CDP_RERANK_URL: 'off', CDP_WORKFLOW_CLOCK_SELECTORS: '[]', CDP_WORKFLOW_VIEW_PROFILE: profile }
      });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      let id = 0;
      return {
        request: async (method: string, params: any = {}) => {
          const response = once(lines, 'line');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
          return JSON.parse((await response)[0]).result;
        },
        close: async () => { const exited = once(child, 'exit'); child.stdin.end(); await exited; lines.close(); }
      };
    };
    const small = bridge('current-24k'), rich = bridge('rich-64k'), invalid = bridge('rich');
    const receipt = (response: any) => JSON.parse(response.content[0].text);
    try {
      for (const session of [small, rich, invalid]) await session.request('initialize');
      const a = await small.request('tools/call', { name: 'observe', arguments: { task: 'buy', stabilityMs: 20, full: true } });
      const b = await rich.request('tools/call', { name: 'observe', arguments: { task: 'buy', stabilityMs: 20, full: true } });
      expect(a.isError, JSON.stringify(a)).not.toBe(true); expect(b.isError, JSON.stringify(b)).not.toBe(true);
      const av = receipt(a).value, bv = receipt(b).value;
      expect(av.output).toMatchObject({ profile: 'current-24k', maxBytes: 24000 });
      expect(bv.output).toMatchObject({ profile: 'rich-64k', maxBytes: 64000 });
      expect(Buffer.byteLength(a.content[0].text)).toBeLessThanOrEqual(24000);
      expect(Buffer.byteLength(b.content[0].text)).toBeLessThanOrEqual(64000);
      expect(bv.view.elements.length).toBeGreaterThan(av.view.elements.length);
      const canonicalA = JSON.parse(await readFile(av.canonicalPath, 'utf8'));
      const canonicalB = JSON.parse(await readFile(bv.canonicalPath, 'utf8'));
      expect(semanticSignature(canonicalA)).toBe(semanticSignature(canonicalB));
      const increment = bv.view.elements.find((element: any) => element.k === 'top|id:increment');
      expect(increment).toBeDefined();
      const acted = await rich.request('tools/call', { name: 'act', arguments: { task: 'increment', source: bv.view.source.id,
        action: 'click', targetKey: increment.k, stabilityMs: 20, full: true } });
      expect(acted.isError, JSON.stringify(acted)).not.toBe(true);
      expect(receipt(acted).value.action).toMatchObject({ commandSucceeded: true, deliveryUnknown: false });
      expect(receipt(acted).value.output.profile).toBe('rich-64k');
      const denied = await invalid.request('tools/call', { name: 'act', arguments: { task: 'increment',
        source: receipt(acted).value.view.source.id, action: 'click', targetKey: increment.k } });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain('WORKFLOW_INVALID_VIEW_PROFILE');
      const pageInfo = (await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as any[]).find(item => item.id === page);
      const read = await CdpSession.connect(pageInfo.webSocketDebuggerUrl);
      try { expect((await read.command('Runtime.evaluate', { expression: "document.querySelector('#increment').textContent", returnByValue: true })).result.value).toBe('1'); }
      finally { read.close(); }
    } finally { await small.close(); await rich.close(); await invalid.close(); }
  }, 30000);
});
