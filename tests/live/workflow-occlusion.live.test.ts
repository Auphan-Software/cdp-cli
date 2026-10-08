import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, type LiveFixture, type CdpPage } from './harness.js';

const exec = promisify(execFile);
let chrome: LiveChrome, app: LiveFixture, root: string;
async function cli(args: string[]) {
  const { stdout } = await exec(process.execPath, [resolve('build/index.js'), ...args, '--cdp-url', chrome.cdpUrl], {
    env: { ...process.env, CDP_STATE_ROOT: root, CDP_SESSION: '', CDP_DAEMON_URL: '', CDP_RERANK_URL: 'off', CDP_WORKFLOW_CLOCK_SELECTORS: '[]' },
    maxBuffer: 8 * 1024 * 1024
  }).catch(error => ({ stdout: (error as { stdout: string }).stdout }));
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
}
async function evaluate(page: CdpPage, expression: string) {
  const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
  try { return (await socket.command('Runtime.evaluate', { expression, returnByValue: true })).result.value; }
  finally { socket.close(); }
}
const observe = (page: CdpPage) => cli(['workflow','observe',page.id,'--task','click exposed control once','--full','--stability-ms','20']);
const act = (page: CdpPage, source: any, id: string, extra: string[] = []) => cli(['workflow','act',page.id,
  '--task','click exposed control once','--source',source.value.view.source.id,'--action','click','--target-key',`top|id:${id}`,'--stability-ms','20',...extra]);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(),'cdp-workflow-occlusion-'));
  app = await startFixture((_req,res) => {
    res.writeHead(200,{'content-type':'text/html'});
    res.end(`<!doctype html><style>
      button{position:fixed;padding:0;border:0;width:63px;height:60px;left:100px}
      #partial{top:50px}#covered{top:150px}#ordinary{top:250px}
      .overlay{position:fixed;z-index:10;background:transparent;left:128px;width:35px;height:35px}
      #partial-overlay{top:50px}#full-overlay{left:100px;top:150px;width:63px;height:60px}
      #clipped{left:-90px;top:350px;width:100px}
      #shadow{position:fixed;left:250px;top:50px;width:63px;height:60px}
      #shadow-overlay{left:278px;top:50px}
    </style>
    <button id="partial">More</button><div id="partial-overlay" class="overlay"></div>
    <button id="covered">Covered</button><div id="full-overlay" class="overlay"></div>
    <button id="ordinary">Ordinary</button><button id="clipped">Clipped</button>
    <div id="shadow"></div><div id="shadow-overlay" class="overlay"></div>
    <script>
      window.events=[];
      document.addEventListener('mousedown',e=>window.events.push({type:e.type,id:e.target.id,x:e.clientX,y:e.clientY,trusted:e.isTrusted}));
      document.addEventListener('touchstart',e=>{window.events.push({type:e.type,id:e.target.id,x:e.touches[0].clientX,y:e.touches[0].clientY,trusted:e.isTrusted});e.preventDefault();},{passive:false});
      document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="inside" style="width:100%;height:100%;padding:0;border:0">Shadow</button>';
    </script>`);
  });
  chrome = await LiveChrome.launch();
},30000);
afterAll(async () => {
  await chrome?.close(); await app?.close();
  if (root?.startsWith(tmpdir())) await rm(root,{recursive:true,force:true});
},30000);

describe('exposed click points through the built CLI', () => {
  it('delivers one trusted mouse and touch event to the exposed More control, never its center overlay',async () => {
    const page = await chrome.createPage(app.baseUrl);
    const result = await act(page,await observe(page),'partial');
    expect(result.value?.action.commandSucceeded,JSON.stringify(result)).toBe(true);
    expect(result.value.action.evidence[0].data.clickDelivered).toBe(true);
    // Touch is a direct-input option, not part of the workflow act schema.
    const touch = await cli(['click','#partial',page.id,'--touch']);
    expect(touch.success,JSON.stringify(touch)).toBe(true);
    expect(touch.data.clickDelivered).toBe(true);
    const events = await evaluate(page,'window.events');
    expect(events.filter((e:any)=>e.type==='mousedown')).toHaveLength(1);
    expect(events.filter((e:any)=>e.type==='touchstart')).toHaveLength(1);
    expect(events.every((e:any)=>e.id==='partial' && e.trusted && e.x<128)).toBe(true);
  },30000);
  it('refuses fully covered controls without events and preserves explicit force at the original center',async () => {
    const page = await chrome.createPage(app.baseUrl);
    const result = await act(page,await observe(page),'covered');
    expect(result.value.action.commandSucceeded,JSON.stringify(result)).toBe(false);
    expect(result.value.action.evidence[0].code).toBe('CLICK_OCCLUDED');
    expect(await evaluate(page,'window.events')).toEqual([]);
    const forced = await cli(['click','#covered',page.id,'--force']);
    // Force admits dispatch, while the independent delivery witness still
    // reports that the overlay received it rather than claiming success.
    expect(forced.code,JSON.stringify(forced)).toBe('CLICK_NOT_DELIVERED');
    expect(await evaluate(page,'window.events')).toEqual([{type:'mousedown',id:'full-overlay',x:131,y:180,trusted:true}]);
  },30000);
  it('retains the ordinary center, reaches a viewport-clipped control and accepts exposed shadow descendants',async () => {
    const page = await chrome.createPage(app.baseUrl);
    for (const id of ['ordinary','clipped','shadow']) {
      const result = await cli(['click',`#${id}`,page.id]);
      expect(result.success,JSON.stringify(result)).toBe(true);
      expect(result.data.clickDelivered).toBe(true);
    }
    const events = await evaluate(page,'window.events');
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({id:'ordinary',x:131,y:280});
    expect(events[1]).toMatchObject({id:'clipped'});
    expect(events[1].x).toBeGreaterThanOrEqual(0);
    expect(events[2]).toMatchObject({id:'shadow'});
    expect(events[2].x).toBeLessThan(278);
  },30000);
  it('keeps drag center-based when destination scrolling exposes only the edge of its source',async () => {
    const page = await chrome.createPage(app.baseUrl);
    await evaluate(page, `document.body.innerHTML='<div style="position:fixed;left:0;top:0;width:200px;height:100px;overflow:auto"><div style="position:relative;height:400px"><div id="from" style="position:absolute;left:0;top:0;width:200px;height:300px;background:gray"></div><div id="to" style="position:absolute;left:0;top:300px;width:200px;height:30px;background:blue"></div></div></div>'`);
    const result = await cli(['drag','#from','#to',page.id]);
    expect(result.code,JSON.stringify(result)).toBe('DRAG_OFFSCREEN');
    const geometry = await evaluate(page, `({rect:document.querySelector('#from').getBoundingClientRect().toJSON(),events:window.events})`);
    expect(geometry.rect.bottom).toBeGreaterThan(0);
    expect(geometry.rect.y + geometry.rect.height/2).toBeLessThan(0);
    expect(geometry.events).toEqual([]);
  },30000);
});
