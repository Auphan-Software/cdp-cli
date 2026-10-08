import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, waitFor, type LiveFixture } from './harness.js';
import { WorkspaceSessionService, defaultWorkspaceSessionStorePath } from '../../src/sessions/workspace-session-service.js';
import { CDPDaemon } from '../../src/daemon/daemon.js';
import { DaemonClient } from '../../src/daemon/client.js';

let chrome: LiveChrome, app: LiveFixture, root: string;
let daemon: CDPDaemon;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-workflow-budget-'));
  app = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<button id="increment" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>');
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

const first = (response: any) => JSON.parse(response.content[0].text);
const budget = (response: any) => response.content.filter((block: any) => block.type === 'text')
  .map((block: any) => JSON.parse(block.text)).find((row: any) => row.type === 'workflow-execution-budget').value;

describe('execution budget enforcement in the real stdio bridge', () => {
  it.each([
    { label: 'action cap', actions: '1', deadline: '60000', expected: 1, code: 'WORKFLOW_ACTION_BUDGET_EXHAUSTED' },
    { label: 'expired startup deadline', actions: '10', deadline: '0', expected: 0, code: 'WORKFLOW_DEADLINE_EXCEEDED' }
  ])('denies further mutation at the $label while observations and expansion remain available', async policy => {
    const name = `budget-${policy.expected}`;
    const service = await WorkspaceSessionService.open(chrome.cdpUrl);
    let page: string;
    try { page = (await service.createSession(name, { url: app.baseUrl })).pageIds[0]; }
    finally { service.close(); }
    const daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
    const client = new DaemonClient({ daemonUrl, cdpUrl: chrome.cdpUrl });
    await waitFor(async () => { if (!(await client.listSessions()).some(session => session.pageId === page)) throw new Error('Registering owned page'); }, 10000);
    const child = spawn(process.execPath, [resolve('build/index.js'), 'workflow-mcp'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        CDP_SESSION: name, CDP_PAGE: page, CDP_URL: chrome.cdpUrl, CDP_DAEMON_URL: daemonUrl, CDP_STATE_ROOT: root,
        CDP_RERANK_URL: 'off', CDP_WORKFLOW_CLOCK_SELECTORS: '[]',
        CDP_WORKFLOW_MAX_ACTIONS: policy.actions, CDP_WORKFLOW_DEADLINE_MS: policy.deadline }
    });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    let id = 0;
    const request = async (method: string, params: any = {}) => {
      const response = once(lines, 'line');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
      return JSON.parse((await response)[0]).result;
    };
    try {
      await request('initialize');
      const invalid = await request('tools/call', { name: 'observe', arguments: {} });
      expect(invalid.isError).not.toBe(true);
      expect(first(invalid)).toMatchObject({ success: false, type: 'workflow-input-rejection', value: {
        rejection: { commandDispatched: false }, output: { profile: 'current-24k' }
      } });
      expect(budget(invalid).actionsUsed).toBe(0);
      const observed = await request('tools/call', { name: 'observe', arguments: { task: 'increment once', stabilityMs: 20 } });
      expect(observed.isError, JSON.stringify(observed)).not.toBe(true);
      expect(budget(observed)).toMatchObject({ actionsUsed: 0, maxActions: Number(policy.actions), deadlineMs: Number(policy.deadline) });
      let source = first(observed).value.view.source.id;
      if (policy.expected === 1) {
        const completed = await request('tools/call', { name: 'act', arguments: { task: 'increment once', source, action: 'click', targetKey: 'top|id:increment', stabilityMs: 20 } });
        expect(completed.isError, JSON.stringify(completed)).not.toBe(true);
        expect(first(completed).value.action.commandSucceeded).toBe(true);
        expect(first(completed).value.action.evidence[0].data.clickDelivered).toBe(true);
        expect(budget(completed).actionsUsed).toBe(1);
        source = first(completed).value.view.source.id;
      }
      const denied = await request('tools/call', { name: 'act', arguments: { task: 'increment again', source, action: 'click', targetKey: 'top|id:increment' } });
      expect(denied.isError).not.toBe(true);
      expect(first(denied).value.action).toMatchObject({ code: policy.code, actionDelivered: false, deliveryUnknown: false });
      expect(budget(denied)).toMatchObject({ exhausted: true, actionsUsed: policy.expected });
      const recovered = await request('tools/call', { name: 'observe', arguments: { task: 'recover evidence', stabilityMs: 20 } });
      expect(recovered.isError).not.toBe(true);
      expect(first(recovered).value.view.elements.find((element: any) => element.k === 'top|id:increment').name).toBe(String(policy.expected));
      expect(budget(recovered).actionsUsed).toBe(policy.expected);
      const expanded = await request('tools/call', { name: 'expand', arguments: { task: 'inspect evidence', source: first(recovered).value.view.source.id } });
      expect(expanded.isError).not.toBe(true);
      expect(first(expanded).value.historical).toBe(true);
      const pageInfo = (await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as any[]).find(item => item.id === page);
      const read = await CdpSession.connect(pageInfo.webSocketDebuggerUrl);
      try { expect((await read.command('Runtime.evaluate', { expression: "document.querySelector('#increment').textContent", returnByValue: true })).result.value).toBe(String(policy.expected)); }
      finally { read.close(); }
    } finally {
      const exited = once(child, 'exit'); child.stdin.end(); await exited; lines.close();
    }
  }, 30000);
});
