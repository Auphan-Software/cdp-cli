/**
 * Encode captured screencast frames to WebM with the browser's own WebCodecs
 * (VP9, else VP8) in a short-lived helper tab, then read the written video back
 * in that tab to prove the pointer is on screen at each click. No ffmpeg and no
 * npm dependency; MP4 is an optional ffmpeg transcode of the WebM.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { WebSocket } from 'ws';
import type { CDPContext } from '../context.js';
import { muxWebm, type EncodedFrame } from './webm.js';
import { pointerSeen } from './overlay.js';

export interface CapturedFrame { file: string; t: number }
/**
 * A click to find the pointer at: `t` is the video time of the frame on screen at the click and `alt`
 * (optional) the first frame after it. Chrome's screencast frame can trail the page by a few glide steps,
 * so the pointer may be a few px short of the click point in the frame before the click and settled in the next.
 */
export interface ClickMark { n: number; at: [number, number]; t: number; alt?: number }
export interface OverlayResult { checked: number; ok: number; missing: number[] }

const KEY_INTERVAL_MS = 2000;

/** An extra bar under the page in the video (the `outside` caption): its height and font in video px, and the caption at a frame's time. */
export interface CaptionBar { height: number; fontPx: number; at: (t: number) => string; changes?: number[] }

export const HELPER_JS = String.raw`window.__enc={q:[],err:null,bar:0,font:20,
 b64(u){let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)},
 bytes(b){return Uint8Array.from(atob(b),c=>c.charCodeAt(0))},
 async start(w,h,bar,font){ this.bar=bar||0; this.font=font||20; this.ih=h-this.bar; if(!window.VideoEncoder) throw new Error('this browser has no WebCodecs VideoEncoder');
  for(const [codec,id] of [['vp09.00.10.08','V_VP9'],['vp8','V_VP8']]){
   const cfg={codec,width:w,height:h,bitrate:Math.min(8e6,Math.max(1e6,w*h*4)),framerate:25};
   const s=await VideoEncoder.isConfigSupported(cfg).catch(()=>({supported:false})); if(!s.supported) continue;
   this.cv=new OffscreenCanvas(w,h); this.cx=this.cv.getContext('2d');
   this.enc=new VideoEncoder({output:c=>{const b=new Uint8Array(c.byteLength);c.copyTo(b);this.q.push([c.timestamp/1000,c.type==='key',b])},error:e=>{this.err=String(e)}});
   this.enc.configure(cfg); return id; }
  throw new Error('no VP9 or VP8 encoder in this browser'); },
 async add(b,ms,key,cap){ const bm=await createImageBitmap(new Blob([this.bytes(b)],{type:'image/jpeg'}));
  this.cx.drawImage(bm,0,0,this.cv.width,this.ih); bm.close(); if(this.bar) this.drawBar(cap||'');
  const f=new VideoFrame(this.cv,{timestamp:Math.round(ms*1000)}); this.enc.encode(f,{keyFrame:key}); f.close();
  while(this.enc.encodeQueueSize>4) await new Promise(r=>this.enc.addEventListener('dequeue',r,{once:true})); return this.drain(); },
 drawBar(text){ const c=this.cx,w=this.cv.width,y=this.ih,pad=this.font; c.fillStyle='#000'; c.fillRect(0,y,w,this.bar);
  if(!text) return; c.fillStyle='#fff'; c.textAlign='center'; c.textBaseline='middle'; let f=this.font;
  const lines=t=>{const out=[];let l='';for(const word of t.split(/\s+/)){const n=l?l+' '+word:word;if(l&&c.measureText(n).width>w-2*pad){out.push(l);l=word}else l=n}out.push(l);return out};
  let ls; for(;;){c.font='600 '+f+'px system-ui,sans-serif'; ls=lines(text); if(ls.length*f*1.25<=this.bar-8||f<=10) break; f-=1}
  ls.slice(0,Math.max(1,Math.floor((this.bar-8)/(f*1.25)))).forEach((l,i,a)=>c.fillText(l,w/2,y+this.bar/2+(i-(a.length-1)/2)*f*1.25)) },
 drain(){ if(this.err) throw new Error(this.err); return this.q.splice(0).map(([t,k,b])=>[t,k,this.b64(b)]); },
 async finish(){ await this.enc.flush(); const r=this.drain(); this.enc.close(); return r; },
 parts:[], part(b){this.parts.push(this.bytes(b));return this.parts.length},
 async open(mime){ const v=document.createElement('video'); v.muted=true; v.preload='auto';
  v.src=URL.createObjectURL(new Blob(this.parts,{type:mime})); this.parts=[];
  await new Promise((ok,no)=>{v.onloadeddata=ok;v.onerror=()=>no(new Error('the written video does not play: '+(v.error&&v.error.message)))});
  this.v=v; this.vc=new OffscreenCanvas(v.videoWidth,v.videoHeight).getContext('2d',{willReadFrequently:true}); return [v.videoWidth,v.videoHeight]; },
 async frameAt(t){ const v=this.v;
  await new Promise(r=>{v.onseeked=r;v.currentTime=Math.max(0,t-0.15)});
  return new Promise(done=>{ let h,off=false; const end=ok=>{ if(off) return; off=true; clearTimeout(stop); v.cancelVideoFrameCallback(h); v.pause(); done(ok) };
   const stop=setTimeout(()=>end(false),2000);
   const cb=(_,m)=>{ if(off) return; if(m.mediaTime<t-0.002) h=v.requestVideoFrameCallback(cb); else { if(m.mediaTime<=t+0.05) this.vc.drawImage(v,0,0); end(m.mediaTime<=t+0.05) } };
   h=v.requestVideoFrameCallback(cb); v.play().catch(()=>end(false)) }) },
 async win(t,x,y,half){
  // A paused video that has only been seeked can still show a frame 0.1 s old (drawImage paints what the decoder last handed over), so
  // play up to t and draw from the frame callback of the first frame at or after t (not more than 50 ms after: that frame was dropped); try 3 times.
  for(let i=0;!await this.frameAt(t);i++) if(i>1) throw new Error('the written video did not show its frame at '+t+' s');
  return this.b64(new Uint8Array(this.vc.getImageData(Math.round(x)-half,Math.round(y)-half,2*half,2*half).data.buffer)); }};`;

async function evaluate(context: CDPContext, ws: WebSocket, expression: string, timeoutMs = 60_000): Promise<any> {
  const r = await context.sendCommand(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'helper script failed');
  }
  return r.result?.value;
}

/**
 * WebCodecs exists only in a secure context and about:blank is not one in
 * headless Chrome. Serve an empty page for a https origin from the tab itself
 * (Fetch.fulfillRequest), so nothing leaves the browser and no file or port is needed. The tab is
 * brought to the front only with `front` (--bring-to-front): that raises the browser window and steals
 * the desktop's focus, and a tab Chrome just opened is already the visible one in its window.
 */
export async function secureDocument(context: CDPContext, ws: WebSocket, front = false): Promise<void> {
  const url = 'https://cdp-cli-video.invalid/';
  const onMessage = (data: Buffer): void => {
    const text = data.toString();
    if (!text.includes('Fetch.requestPaused')) return;
    const message = JSON.parse(text);
    if (message.method !== 'Fetch.requestPaused') return;
    context.sendCommand(ws, 'Fetch.fulfillRequest', {
      requestId: message.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from('<!doctype html><title>cdp-cli video</title>').toString('base64')
    }).catch(() => undefined);
  };
  ws.on('message', onMessage);
  try {
    await context.sendCommand(ws, 'Fetch.enable', { patterns: [{ urlPattern: `${url}*` }] });
    await context.sendCommand(ws, 'Page.enable');
    const nav = await context.sendCommand(ws, 'Page.navigate', { url });
    if (nav?.errorText) throw new Error(`helper page did not load: ${nav.errorText}`);
    await context.sendCommand(ws, 'Fetch.disable');
    // A tab hidden behind another window defers media loading and the read-back never finishes: the opt-in for that case.
    if (front) await context.sendCommand(ws, 'Page.bringToFront');
  } finally {
    ws.off('message', onMessage);
  }
}

/** Run fn against a fresh secure-context helper tab of this session, closed afterwards. */
async function withHelper<T>(context: CDPContext, front: boolean, fn: (ws: WebSocket) => Promise<T>): Promise<T> {
  const page = await context.createPage('about:blank');
  const ws = await context.connect(page, { lease: false });
  try {
    await secureDocument(context, ws, front);
    await evaluate(context, ws, HELPER_JS);
    return await fn(ws);
  } catch (error) {
    if (!front && /written video|does not play|Command timeout/.test((error as Error).message)) {
      (error as Error).message += ' (the helper tab may be hidden behind another window: run again with --bring-to-front)';
    }
    throw error;
  } finally {
    ws.close();
    await context.closePage(page).catch(() => undefined);
  }
}

/**
 * Encode frames (t in seconds on the video clock) to WebM; the last frame is
 * repeated at endSec so the video lasts as long as the recording. Width and
 * height are the first frame's, rounded down to even.
 */
export async function encodeWebm(context: CDPContext, frames: CapturedFrame[], endSec: number,
  size: { width: number; height: number }, options: { front?: boolean; bar?: CaptionBar } = {}): Promise<Buffer> {
  if (!frames.length) throw new Error('no frames were captured');
  const width = Math.max(2, size.width - (size.width % 2));
  const pageHeight = Math.max(2, size.height - (size.height % 2));
  const barHeight = options.bar ? Math.max(2, options.bar.height - (options.bar.height % 2)) : 0;
  const height = pageHeight + barHeight;
  return withHelper(context, options.front ?? false, async (ws) => {
    const codec = await evaluate(context, ws, `__enc.start(${width},${height},${barHeight},${options.bar?.fontPx ?? 0})`) as 'V_VP8' | 'V_VP9';
    const out: EncodedFrame[] = [];
    const take = (rows: Array<[number, boolean, string]>): void => {
      for (const [timeMs, key, b64] of rows) out.push({ timeMs, key, data: Buffer.from(b64, 'base64') });
    };
    let lastKey = -Infinity;
    // A caption change hidden from the page need not produce a screencast frame: repeat the latest image at each change.
    const withChanges = [...frames];
    for (const t of options.bar?.changes ?? []) {
      const before = [...frames].sort((a, b) => a.t - b.t).filter((f) => f.t <= t).pop(); // the newest captured image, not a repeat
      if (before && before.t < t && t < endSec) withChanges.push({ ...before, t });
    }
    withChanges.sort((a, b) => a.t - b.t);
    const list = [...withChanges, { ...withChanges[withChanges.length - 1], t: Math.max(endSec, withChanges[withChanges.length - 1].t) }];
    for (const frame of list) {
      const ms = Math.round(frame.t * 1000);
      const key = ms - lastKey >= KEY_INTERVAL_MS;
      if (key) lastKey = ms;
      const b64 = readFileSync(frame.file).toString('base64');
      take(await evaluate(context, ws, `__enc.add(${JSON.stringify(b64)},${ms},${key},${JSON.stringify(options.bar ? options.bar.at(frame.t) : '')})`));
    }
    take(await evaluate(context, ws, '__enc.finish()'));
    out.sort((a, b) => a.timeMs - b.timeMs);
    return muxWebm({ codec, width, height, durationMs: Math.round(Math.max(endSec, list[list.length - 1].t) * 1000) }, out);
  });
}

/**
 * The video's own proof that it shows the clicks: load the written file in the
 * helper tab, seek to each click's time and test the pointer's shape at the
 * click point. scale is video pixels per CSS pixel.
 */
export async function checkClicks(context: CDPContext, file: string, mime: string, clicks: ClickMark[],
  scale: number, options: { front?: boolean } = {}): Promise<OverlayResult> {
  if (!clicks.length) return { checked: 0, ok: 0, missing: [] };
  return withHelper(context, options.front ?? false, async (ws) => {
    const bytes = readFileSync(file);
    for (let i = 0; i < bytes.length; i += 4 << 20) {
      await evaluate(context, ws, `__enc.part(${JSON.stringify(bytes.subarray(i, i + (4 << 20)).toString('base64'))})`);
    }
    await evaluate(context, ws, `__enc.open(${JSON.stringify(mime)})`);
    const half = Math.ceil(24 * scale);
    const missing: number[] = [];
    const size = 2 * half;
    const seenAt = async (click: ClickMark, t: number): Promise<boolean> => {
      const rgba = Buffer.from(await evaluate(context, ws,
        `__enc.win(${t + 0.001},${click.at[0] * scale},${click.at[1] * scale},${half})`) as string, 'base64');
      // The window is cut at the nearest whole pixel; the click point is not (DPR 1.25: 287.5).
      return pointerSeen({
        size,
        cx: half + (click.at[0] * scale - Math.round(click.at[0] * scale)),
        cy: half + (click.at[1] * scale - Math.round(click.at[1] * scale)),
        at: (x, y) => {
          if (x < 0 || y < 0 || x >= size || y >= size) return null;
          const o = (y * size + x) * 4;
          return rgba[o + 3] === 0 ? null : [rgba[o], rgba[o + 1], rgba[o + 2]];
        }
      }, scale);
    };
    for (const click of clicks) {
      const times = click.alt !== undefined && click.alt !== click.t ? [click.t, click.alt] : [click.t];
      let seen = false;
      for (const t of times) {
        if (await seenAt(click, t)) { seen = true; break; }
      }
      if (!seen) missing.push(click.n);
    }
    return { checked: clicks.length, ok: clicks.length - missing.length, missing };
  });
}

/** ffmpeg to use for an MP4: CDP_FFMPEG, else `ffmpeg` on PATH; undefined when neither runs. */
export function findFfmpeg(env = process.env): string | undefined {
  const candidate = env.CDP_FFMPEG || 'ffmpeg';
  const probe = spawnSync(candidate, ['-version'], { windowsHide: true, encoding: 'utf8' });
  return probe.status === 0 ? candidate : undefined;
}

/** Transcode the WebM to an H.264 MP4 (yuv420p, faststart) with an ffmpeg already on this machine. */
export function transcodeMp4(ffmpeg: string, webm: string, mp4: string): void {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', webm, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg could not write the MP4: ${(r.stderr || r.error?.message || '').trim().slice(-300)}`);
}
