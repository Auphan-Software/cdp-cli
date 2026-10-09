import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, waitFor, type LiveFixture } from './harness.js';
import { CDPDaemon } from '../../src/daemon/daemon.js';
import { DaemonClient } from '../../src/daemon/client.js';
import { WorkspaceSessionService, defaultWorkspaceSessionStorePath } from '../../src/sessions/workspace-session-service.js';
const exec = promisify(execFile);
let chrome: LiveChrome, app: LiveFixture, root: string;
let daemon: CDPDaemon | undefined;
async function cli(operation: string, page: string, args: string[] = []) {
  const options = { env: { ...process.env, CDP_STATE_ROOT: root, CDP_SESSION: '', CDP_DAEMON_URL: daemon ? `http://127.0.0.1:${daemon.listeningPort}` : '' }, maxBuffer: 8*1024*1024 };
  const binary = process.env.CDP_WORKFLOW_TEST_BIN;
  const call = [...(binary ? [] : [resolve('build/index.js')]), 'workflow', operation, page, '--task', 'reproduce Save behavior', '--cdp-url', chrome.cdpUrl, '--stability-ms', '20', ...args];
  let stdout: string;
  try { ({stdout} = await exec(binary ?? process.execPath, call, options)); }
  catch(error) { stdout = (error as {stdout:string}).stdout; }
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  if (result.error) result.commandRows = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (process.env.CDP_WORKFLOW_REQUIRE_RERANK === '1' && result.success && result.value?.view) expect(result.value.view.providerStatus).toBe('applied');
  return result;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-workflow-live-'));
  app = await startFixture((_req,res) => { res.writeHead(200, {'content-type':'text/html'}); res.end(`<!doctype html><title>Workflow</title><h1>Evidence</h1><button id="save" onclick="document.querySelector('#result').textContent='Saved';document.querySelector('#secret').setAttribute('aria-expanded','true')">Save</button><p id="result">Waiting</p><button id="secret" hidden aria-expanded="false">Hidden clutter</button><input id="name" value="private-user-value"><select id="choice"><option value="a">A</option><option value="private-option-value">B</option></select>`); });
  chrome = await LiveChrome.launch();
},30000);
afterAll(async () => { await daemon?.stop(); await chrome?.close(); await app?.close(); if(chrome)await rm(defaultWorkspaceSessionStorePath(chrome.cdpUrl),{force:true}); if(root?.startsWith(tmpdir()))await rm(root,{recursive:true,force:true}); },30000);
describe('deployed deterministic browser workflow', () => {
  it('fuses real click/fill/select with protected fresh diffs, expansion and screenshot artifacts', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const observed = await cli('observe',page.id);
    expect(observed.success, JSON.stringify(observed)).toBe(true);
    expect(observed.value.view.elements.some((n:any)=>n.k==='top|id:secret')).toBe(false);
    expect(JSON.stringify(observed)).not.toContain('private-user-value');
    expect(observed.value.diagnostics.console).toBe('unavailable');
    const clicked = await cli('act',page.id,['--source',observed.value.view.source.id,'--action','click','--selector','#save','--screenshot']);
    expect(clicked.value.action.commandSucceeded).toBe(true);
    expect(clicked.value.view.diff.changes).toEqual(expect.arrayContaining([expect.objectContaining({key:'top|id:result',to:'Saved'})]));
    expect(clicked.value.view.elements).toEqual(expect.arrayContaining([expect.objectContaining({k:'top|id:secret',state:expect.objectContaining({expanded:true})})]));
    expect(clicked.value.screenshot.available).toBe(true);
    expect(clicked.value.screenshot.semanticStable).toBe(true);
    expect((await readFile(clicked.value.screenshot.path)).subarray(1,4).toString()).toBe('PNG');
    const expanded = await cli('expand',page.id,['--source',clicked.value.view.source.id]);
    expect(expanded.value.historical).toBe(true);
    expect(expanded.value.state.elements.some((n:any)=>n.k==='top|id:secret')).toBe(true);
    const filled = await cli('act',page.id,['--source',clicked.value.view.source.id,'--action','fill','--selector','#name','--value','replacement']);
    expect(filled.value.action.commandSucceeded).toBe(true);
    expect(JSON.stringify(filled)).not.toContain('"replacement"');
    const selected = await cli('act',page.id,['--source',filled.value.view.source.id,'--action','select','--selector','#choice','--value','private-option-value']);
    expect(selected.value.action.commandSucceeded).toBe(true);
    expect(selected.value.view.diff.changed).toBe(true);
    expect(JSON.stringify(selected)).not.toContain('private-option-value');
  },30000);
  it('rejects stale state without delivering a click', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const observed = await cli('observe',page.id);
    expect(observed.success, JSON.stringify(observed)).toBe(true);
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try { await session.command('Runtime.evaluate',{expression:"document.querySelector('#result').textContent='External change'"}); } finally { session.close(); }
    const rejected = await cli('act',page.id,['--source',observed.value.view.source.id,'--action','click','--selector','#save']);
    expect(rejected.success).toBe(false);
    expect(rejected.value.action.code).toBe('WORKFLOW_STALE_SOURCE');
    expect(rejected.value.action.actionDelivered).toBe(false);
    expect(rejected.value.view.elements).toEqual(expect.arrayContaining([expect.objectContaining({k: 'top|id:result', text: 'External change'})]));
    const current = await cli('observe',page.id);
    expect(current.value.view.diff.from.id).toBe(observed.value.view.source.id);
    expect(current.value.view.diff.changes).toEqual(expect.arrayContaining([expect.objectContaining({key:'top|id:result',to:'External change'})]));
    expect(current.value.view.elements).toEqual(expect.arrayContaining([expect.objectContaining({k:'top|id:result',text:'External change'})]));
  });
  it('inherits nondefault capture caps and rejects explicit profile changes before delivery', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const observed = await cli('observe', page.id, ['--max-elements', '1500']);
    const mismatched = await cli('act', page.id, ['--source', observed.value.view.source.id, '--max-elements', '60', '--action', 'click', '--selector', '#save']);
    expect(mismatched.message).toContain('CAPTURE_PROFILE_MISMATCH');
    const clicked = await cli('act', page.id, ['--source', observed.value.view.source.id, '--action', 'click', '--selector', '#save']);
    expect(clicked.value.action.commandSucceeded).toBe(true);
    const canonical = JSON.parse(await readFile(clicked.value.canonicalPath, 'utf8'));
    expect(canonical.captureOptions.maxElements).toBe(1500);
  }, 20000);
  it('distinguishes an explicit top-frame request from omitted frame inheritance', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
    try { await socket.command('Runtime.evaluate', { expression: `const f=document.createElement('iframe');f.id='embedded';f.srcdoc='<button id="inside" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>';document.body.append(f)`, returnByValue:true }); }
    finally { socket.close(); }
    const observed = await cli('observe', page.id, ['--frame', '#embedded']);
    expect(observed.success, JSON.stringify(observed)).toBe(true);
    const rejected = await cli('act', page.id, ['--source', observed.value.view.source.id, '--frame', '0', '--action', 'click', '--selector', '#inside']);
    expect(rejected.message).toContain('CAPTURE_PROFILE_MISMATCH');
    const matching = await cli('act', page.id, ['--source', observed.value.view.source.id, '--frame', '#embedded', '--action', 'click', '--selector', '#inside']);
    expect(matching.value.action.commandSucceeded).toBe(true);
    const inherited = await cli('act', page.id, ['--source', matching.value.view.source.id, '--action', 'click', '--selector', '#inside']);
    expect(inherited.value.action.commandSucceeded).toBe(true);
    expect(inherited.value.view.elements.some((n:any)=>n.name==='2')).toBe(true);
  }, 20000);
  it('tolerates only configured leaf clock text and rejects simultaneous unmodelled business changes', async () => {
    const saved = process.env.CDP_WORKFLOW_CLOCK_SELECTORS;
    process.env.CDP_WORKFLOW_CLOCK_SELECTORS = '[".nav-clock"]';
    const page = await chrome.createPage(app.baseUrl);
    const evaluate = async (expression: string) => {
      const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
      try { return await socket.command('Runtime.evaluate', { expression, returnByValue: true }); } finally { socket.close(); }
    };
    try {
      await evaluate(`document.body.insertAdjacentHTML('beforeend','<div class="nav-clock">Oct 07, 26 9:22 am</div><section id="unmodelled">Total $4.13</section>')`);
      const observed = await cli('observe', page.id);
      expect(observed.success, JSON.stringify(observed)).toBe(true);
      await evaluate(`document.querySelector('.nav-clock').textContent='Oct 07, 26 9:23 am'`);
      const clicked = await cli('act', page.id, ['--source', observed.value.view.source.id, '--action', 'click', '--selector', '#save']);
      expect(clicked.value.action.commandSucceeded).toBe(true);
      expect(JSON.parse(await readFile(clicked.value.canonicalPath, 'utf8')).elements.some((e:any)=>e.cosmeticClock && e.text.includes('9:23'))).toBe(true);
      await evaluate(`document.querySelector('.nav-clock').textContent='Oct 07, 26 9:24 am';document.querySelector('#unmodelled').textContent='Total $999'`);
      const rejected = await cli('act', page.id, ['--source', clicked.value.view.source.id, '--action', 'fill', '--selector', '#name', '--value', 'must-not-deliver']);
      expect(rejected.value.action.actionDelivered).toBe(false);
      expect((await evaluate(`document.querySelector('#name').value`)).result.value).toBe('private-user-value');
      // Recovery source is immediately consumable; no standalone observe needed.
      const recovered = await cli('act', page.id, ['--source', rejected.value.view.source.id, '--action', 'fill', '--selector', '#name', '--value', 'safe-new-value']);
      expect(recovered.value.action.commandSucceeded).toBe(true);
      for (const change of [
        `document.querySelector('.nav-clock').textContent='Offline'`,
        `document.querySelector('.nav-clock').textContent='$999'`,
        `document.querySelector('.nav-clock').setAttribute('role','alert')`,
        `document.querySelector('#save').disabled=true`,
        `document.querySelector('#save').textContent='Different account'`,
        `document.body.insertAdjacentHTML('beforeend','<div role="dialog">New modal</div>')`
      ]) {
        const source = await cli('observe', page.id);
        await evaluate(change);
        const blocked = await cli('act', page.id, ['--source', source.value.view.source.id, '--action', 'fill', '--selector', '#name', '--value', 'must-not-deliver']);
        expect(blocked.value.action.actionDelivered, change).toBe(false);
        expect((await evaluate(`document.querySelector('#name').value`)).result.value).toBe('safe-new-value');
      }
    } finally { if(saved === undefined) delete process.env.CDP_WORKFLOW_CLOCK_SELECTORS; else process.env.CDP_WORKFLOW_CLOCK_SELECTORS = saved; }
  }, 50000);
  it('serves owned actions, diagnostics and actual image blocks through stdio MCP', async () => {
    const service = await WorkspaceSessionService.open(chrome.cdpUrl);
    let page: string;
    try { page = (await service.createSession('workflow-owned-live',{url:app.baseUrl})).pageIds[0]; }
    finally { service.close(); }
    daemon = new CDPDaemon({port:0,cdpUrl:chrome.cdpUrl,healthCheckIntervalMs:1000}); await daemon.start();
    const daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
    const client = new DaemonClient({daemonUrl,cdpUrl:chrome.cdpUrl});
    await waitFor(async()=>{if(!(await client.listSessions()).some(s=>s.pageId===page))throw new Error('Registering');return true;},10000);
    const socket = (await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as any[]).find(p=>p.id===page);
    const largeSession = await CdpSession.connect(socket.webSocketDebuggerUrl);
    try { await largeSession.command('Runtime.evaluate', { expression: `for(let i=0;i<800;i++){const el=document.createElement('button');el.id='clutter'+i;el.textContent='Background item '+i;document.body.append(el)}` }); }
    finally { largeSession.close(); }
    const binary = process.env.CDP_WORKFLOW_TEST_BIN;
    const child = spawn(binary ?? process.execPath,[...(binary ? [] : [resolve('build/index.js')]),'workflow-mcp'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CDP_SESSION:'workflow-owned-live',CDP_PAGE:page,CDP_URL:chrome.cdpUrl,CDP_DAEMON_URL:daemonUrl,CDP_STATE_ROOT:root}});
    child.stderr.resume();
    const lines = createInterface({input:child.stdout}); let id = 0;
    const request = async(method:string,params:any={})=>{const response=once(lines,'line');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})+'\n');return JSON.parse((await response)[0]).result;};
    try {
      const init = await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
      expect(init.capabilities.tools).toEqual({});
      expect((await request('tools/list')).tools.map((t:any)=>t.name)).toEqual(['observe','act','expand','screenshot','snapshot']);
      const observed = await request('tools/call',{name:'observe',arguments:{task:'reproduce Save',stabilityMs:20,full:true}});
      expect(observed.isError,JSON.stringify(observed)).not.toBe(true);
      const state = JSON.parse(observed.content[0].text);
      expect(Buffer.byteLength(observed.content[0].text)).toBeLessThanOrEqual(24000);
      expect(state.value.output.bounded).toBe(true);
      const full = JSON.parse(await readFile(state.value.output.fullPath, 'utf8'));
      expect(full.value.view.elements.length).toBeGreaterThan(state.value.view.elements.length);
      expect(state.value.view.providerStatus).toBe('unused');
      expect(state.value.diagnostics.console).toBe('available');
      const saveControl = state.value.view.elements.find((node:any)=>node.name==='Save');
      expect(saveControl).toBeDefined();
      const changed = await request('tools/call',{name:'act',arguments:{task:'reproduce Save',source:state.value.view.source.id,action:'click',targetKey:saveControl.k,screenshot:true,stabilityMs:20,full:true}});
      expect(changed.isError,JSON.stringify(changed.content.filter((c:any)=>c.type==='text'))).not.toBe(true);
      const result = JSON.parse(changed.content[0].text);
      expect(Buffer.byteLength(changed.content[0].text)).toBeLessThanOrEqual(24000);
      expect(result.value.action.commandSucceeded).toBe(true);
      expect(result.value.view.diff.changed).toBe(true);
      const image = changed.content.find((c:any)=>c.type==='image');
      expect(Buffer.from(image.data,'base64').subarray(1,4).toString()).toBe('PNG');
      expect(changed.content.filter((c:any)=>c.type==='text').some((c:any)=>c.text.includes(image.data))).toBe(false);
      const expanded = await request('tools/call', { name: 'expand', arguments: { task: 'inspect historical evidence', source: result.value.view.source.id, limit: 1000 } });
      expect(Buffer.byteLength(expanded.content[0].text)).toBeLessThanOrEqual(24000);
      const expansion = JSON.parse(expanded.content[0].text);
      expect(expansion.value.historical).toBe(true);
      expect(expansion.value.pagination.nextOffset).toBeGreaterThan(0);
      const next = await request('tools/call', { name: 'expand', arguments: { task: 'inspect historical evidence', source: result.value.view.source.id, offset: expansion.value.pagination.nextOffset } });
      expect(JSON.parse(next.content[0].text).value.state.elements[0].k).not.toBe(expansion.value.state.elements[0].k);
      const foreign = await request('tools/call',{name:'observe',arguments:{task:'read',page:'unowned'}});
      expect(foreign.isError).toBe(true);
    } finally { const exited=once(child,'exit');child.stdin.end();await exited;lines.close(); }
  },40000);
  it('recovers changed state when an action is delivered but its wait fails', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const observed = await cli('observe',page.id);
    expect(observed.success,JSON.stringify(observed)).toBe(true);
    const result = await cli('act',page.id,['--source',observed.value.view.source.id,'--action','click','--selector','#save','--wait-for','#does-not-exist']);
    expect(result.success).toBe(true);
    expect(result.value.action.commandSucceeded).toBe(false);
    expect(result.value.action.instruction).toContain('do not repeat the action blindly');
    expect(result.value.view.elements).toEqual(expect.arrayContaining([expect.objectContaining({k:'top|id:result',text:'Saved'})]));
  },20000);
  it('completes a real action with deterministic evidence when the optional service is unreachable', async () => {
    const saved = { url: process.env.CDP_RERANK_URL, timeout: process.env.CDP_RERANK_TIMEOUT_MS, required: process.env.CDP_WORKFLOW_REQUIRE_RERANK };
    process.env.CDP_RERANK_URL = 'http://127.0.0.1:1'; process.env.CDP_RERANK_TIMEOUT_MS = '50'; delete process.env.CDP_WORKFLOW_REQUIRE_RERANK;
    try {
      const page = await chrome.createPage(app.baseUrl);
      const observed = await cli('observe', page.id);
      expect(observed.value.view.providerStatus).toBe('unused');
      const clicked = await cli('act', page.id, ['--source', observed.value.view.source.id, '--action', 'click', '--selector', '#save']);
      expect(clicked.value.action.commandSucceeded).toBe(true);
      expect(clicked.value.view.elements).toEqual(expect.arrayContaining([expect.objectContaining({k:'top|id:result',text:'Saved'})]));
    } finally {
      for (const [key, value] of [['CDP_RERANK_URL',saved.url],['CDP_RERANK_TIMEOUT_MS',saved.timeout],['CDP_WORKFLOW_REQUIRE_RERANK',saved.required]]) {
        if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
      }
    }
  },20000);
});
