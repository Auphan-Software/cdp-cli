/** Harmless headed fixture: distinguish renderer geometry, screenshot and input witnesses. */
import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LiveChrome, CdpSession, startFixture } from './harness.js';
const exec = promisify(execFile);
it('records one independent effect and trusted events across viewport/readiness arms', async () => {
  const app = await startFixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html>
    <div role="button" style="position:absolute;left:385px;top:280px;width:151px;height:75px">COUNTER
    <button id="add" style="position:absolute;left:0;bottom:0;width:151px;height:20px" onclick="window.count++">+</button></div>
    <script>window.count=0;window.events=[];for(const [label,target] of [['window',window],['document',document]])
    for(const type of ['pointerdown','mousedown','mouseup','click'])target.addEventListener(type,e=>events.push({label,type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,target:e.target.id}),true);</script>`); });
  const chrome = await LiveChrome.launch({ headful: true });
  const report: any[] = [];
  try {
    for (const arm of ['none', 'desktop', 'desktop-metrics', 'desktop-screenshot', 'desktop-wait', 'mobile']) {
      const page = await chrome.createPage(app.baseUrl);
      let session = await CdpSession.connect(page.webSocketDebuggerUrl);
      try {
        if (arm !== 'none') await session.command('Emulation.setDeviceMetricsOverride', { width:1234, height:676, deviceScaleFactor:2, mobile:arm==='mobile' });
        await session.command('Page.bringToFront');
        // Equal setup duration; only the synchronization operation differs.
        if (arm === 'desktop-metrics') await session.command('Page.getLayoutMetrics');
        if (arm === 'desktop-screenshot') await session.command('Page.captureScreenshot', { format:'png' });
        await new Promise(resolve => setTimeout(resolve, 300));
      } finally { session.close(); }
      let stdout: string;
      try { ({ stdout } = await exec(process.execPath, ['build/index.js','click','#add',page.id,'--cdp-url',chrome.cdpUrl],
        { env:{...process.env,CDP_SESSION:'',CDP_DAEMON_URL:''},maxBuffer:200000 })); }
      catch (error) { stdout=(error as any).stdout ?? ''; }
      const rows=stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      session=await CdpSession.connect(page.webSocketDebuggerUrl);
      try {
        await new Promise(resolve=>setTimeout(resolve,200));
        const snapshot=(await session.command('Runtime.evaluate',{expression:`({count,events,visible:document.visibilityState,focus:document.hasFocus(),dpr:devicePixelRatio,
          viewport:{width:innerWidth,height:innerHeight,scale:visualViewport.scale},rect:document.getElementById('add').getBoundingClientRect().toJSON()})`,returnByValue:true})).result.value;
        report.push({arm,receipt:rows.at(-1),snapshot});
        const success=rows.some(row=>row.data?.clickDelivered===true);
        expect(snapshot.count,JSON.stringify(report.at(-1))).toBe(success?1:0);
        if(success)expect(snapshot.events.some((event:any)=>event.type==='mousedown'&&event.trusted&&event.target==='add')).toBe(true);
      } finally { session.close(); }
    }
    console.log('INPUT_ROUTING_REPORT '+JSON.stringify(report));
  } finally { await chrome.close(); await app.close(); }
},90000);
