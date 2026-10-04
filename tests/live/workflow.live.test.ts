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
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
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
    expect(rejected.error).toBe(true); expect(rejected.message).toContain('STALE_SOURCE');
    const current = await cli('observe',page.id);
    expect(current.value.view.elements).toEqual(expect.arrayContaining([expect.objectContaining({k:'top|id:result',text:'External change'})]));
  });
  it('serves owned actions, diagnostics and actual image blocks through stdio MCP', async () => {
    const service = await WorkspaceSessionService.open(chrome.cdpUrl);
    let page: string;
    try { page = (await service.createSession('workflow-owned-live',{url:app.baseUrl})).pageIds[0]; }
    finally { service.close(); }
    daemon = new CDPDaemon({port:0,cdpUrl:chrome.cdpUrl,healthCheckIntervalMs:1000}); await daemon.start();
    const daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
    const client = new DaemonClient({daemonUrl,cdpUrl:chrome.cdpUrl});
    await waitFor(async()=>{if(!(await client.listSessions()).some(s=>s.pageId===page))throw new Error('Registering');return true;},10000);
    const binary = process.env.CDP_WORKFLOW_TEST_BIN;
    const child = spawn(binary ?? process.execPath,[...(binary ? [] : [resolve('build/index.js')]),'workflow-mcp'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CDP_SESSION:'workflow-owned-live',CDP_PAGE:page,CDP_URL:chrome.cdpUrl,CDP_DAEMON_URL:daemonUrl,CDP_STATE_ROOT:root}});
    child.stderr.resume();
    const lines = createInterface({input:child.stdout}); let id = 0;
    const request = async(method:string,params:any={})=>{const response=once(lines,'line');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})+'\n');return JSON.parse((await response)[0]).result;};
    try {
      const init = await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
      expect(init.capabilities.tools).toEqual({});
      expect((await request('tools/list')).tools.map((t:any)=>t.name)).toEqual(['observe','act','expand','screenshot']);
      const observed = await request('tools/call',{name:'observe',arguments:{task:'reproduce Save',stabilityMs:20}});
      expect(observed.isError,JSON.stringify(observed)).not.toBe(true);
      const state = JSON.parse(observed.content[0].text);
      expect(state.value.diagnostics.console).toBe('available');
      const changed = await request('tools/call',{name:'act',arguments:{task:'reproduce Save',source:state.value.view.source.id,action:'click',selector:'#save',screenshot:true,stabilityMs:20}});
      expect(changed.isError,JSON.stringify(changed.content.filter((c:any)=>c.type==='text'))).not.toBe(true);
      const result = JSON.parse(changed.content[0].text);
      expect(result.value.action.commandSucceeded).toBe(true);
      expect(result.value.view.diff.changed).toBe(true);
      const image = changed.content.find((c:any)=>c.type==='image');
      expect(Buffer.from(image.data,'base64').subarray(1,4).toString()).toBe('PNG');
      expect(changed.content.filter((c:any)=>c.type==='text').some((c:any)=>c.text.includes(image.data))).toBe(false);
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
});
