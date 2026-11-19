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
export interface ClickMark { n: number; at: [number, number]; t: number }
export interface OverlayResult { checked: number; ok: number; missing: number[] }

const KEY_INTERVAL_MS = 2000;

export const HELPER_JS = String.raw`window.__enc={q:[],err:null,
 b64(u){let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)},
 bytes(b){return Uint8Array.from(atob(b),c=>c.charCodeAt(0))},
 async start(w,h){ if(!window.VideoEncoder) throw new Error('this browser has no WebCodecs VideoEncoder');
  for(const [codec,id] of [['vp09.00.10.08','V_VP9'],['vp8','V_VP8']]){
   const cfg={codec,width:w,height:h,bitrate:Math.min(8e6,Math.max(1e6,w*h*4)),framerate:25};
   const s=await VideoEncoder.isConfigSupported(cfg).catch(()=>({supported:false})); if(!s.supported) continue;
   this.cv=new OffscreenCanvas(w,h); this.cx=this.cv.getContext('2d');
   this.enc=new VideoEncoder({output:c=>{const b=new Uint8Array(c.byteLength);c.copyTo(b);this.q.push([c.timestamp/1000,c.type==='key',b])},error:e=>{this.err=String(e)}});
   this.enc.configure(cfg); return id; }
  throw new Error('no VP9 or VP8 encoder in this browser'); },
 async add(b,ms,key){ const bm=await createImageBitmap(new Blob([this.bytes(b)],{type:'image/jpeg'}));
  this.cx.drawImage(bm,0,0,this.cv.width,this.cv.height); bm.close();
  const f=new VideoFrame(this.cv,{timestamp:Math.round(ms*1000)}); this.enc.encode(f,{keyFrame:key}); f.close();
  while(this.enc.encodeQueueSize>4) await new Promise(r=>this.enc.addEventListener('dequeue',r,{once:true})); return this.drain(); },
 drain(){ if(this.err) throw new Error(this.err); return this.q.splice(0).map(([t,k,b])=>[t,k,this.b64(b)]); },
 async finish(){ await this.enc.flush(); const r=this.drain(); this.enc.close(); return r; },
 parts:[], part(b){this.parts.push(this.bytes(b));return this.parts.length},
 async open(mime){ const v=document.createElement('video'); v.muted=true; v.preload='auto';
  v.src=URL.createObjectURL(new Blob(this.parts,{type:mime})); this.parts=[];
  await new Promise((ok,no)=>{v.onloadeddata=ok;v.onerror=()=>no(new Error('the written video does not play: '+(v.error&&v.error.message)))});
  this.v=v; this.vc=new OffscreenCanvas(v.videoWidth,v.videoHeight).getContext('2d',{willReadFrequently:true}); return [v.videoWidth,v.videoHeight]; },
 async win(t,x,y,half){ const v=this.v; await new Promise(r=>{v.onseeked=r;v.currentTime=t}); this.vc.drawImage(v,0,0);
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
 * (Fetch.fulfillRequest), so nothing leaves the browser and no file or port is needed; the tab
 * is brought to the front because a hidden one never loads the video it must read back.
 */
async function secureDocument(context: CDPContext, ws: WebSocket): Promise<void> {
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
    // A hidden tab defers media loading, so reading the written video back would never finish.
    await context.sendCommand(ws, 'Page.bringToFront');
  } finally {
    ws.off('message', onMessage);
  }
}

/** Run fn against a fresh secure-context helper tab of this session, closed afterwards. */
async function withHelper<T>(context: CDPContext, fn: (ws: WebSocket) => Promise<T>): Promise<T> {
  const page = await context.createPage('about:blank');
  const ws = await context.connect(page, { lease: false });
  try {
    await secureDocument(context, ws);
    await evaluate(context, ws, HELPER_JS);
    return await fn(ws);
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
  size: { width: number; height: number }): Promise<Buffer> {
  if (!frames.length) throw new Error('no frames were captured');
  const width = Math.max(2, size.width - (size.width % 2));
  const height = Math.max(2, size.height - (size.height % 2));
  return withHelper(context, async (ws) => {
    const codec = await evaluate(context, ws, `__enc.start(${width},${height})`) as 'V_VP8' | 'V_VP9';
    const out: EncodedFrame[] = [];
    const take = (rows: Array<[number, boolean, string]>): void => {
      for (const [timeMs, key, b64] of rows) out.push({ timeMs, key, data: Buffer.from(b64, 'base64') });
    };
    let lastKey = -Infinity;
    const list = [...frames, { ...frames[frames.length - 1], t: Math.max(endSec, frames[frames.length - 1].t) }];
    for (const frame of list) {
      const ms = Math.round(frame.t * 1000);
      const key = ms - lastKey >= KEY_INTERVAL_MS;
      if (key) lastKey = ms;
      const b64 = readFileSync(frame.file).toString('base64');
      take(await evaluate(context, ws, `__enc.add(${JSON.stringify(b64)},${ms},${key})`));
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
  scale: number): Promise<OverlayResult> {
  if (!clicks.length) return { checked: 0, ok: 0, missing: [] };
  return withHelper(context, async (ws) => {
    const bytes = readFileSync(file);
    for (let i = 0; i < bytes.length; i += 4 << 20) {
      await evaluate(context, ws, `__enc.part(${JSON.stringify(bytes.subarray(i, i + (4 << 20)).toString('base64'))})`);
    }
    await evaluate(context, ws, `__enc.open(${JSON.stringify(mime)})`);
    const half = Math.ceil(24 * scale);
    const missing: number[] = [];
    for (const click of clicks) {
      const rgba = Buffer.from(await evaluate(context, ws,
        `__enc.win(${click.t + 0.001},${click.at[0] * scale},${click.at[1] * scale},${half})`) as string, 'base64');
      const size = 2 * half;
      const seen = pointerSeen({
        size,
        at: (x, y) => {
          if (x < 0 || y < 0 || x >= size || y >= size) return null;
          const o = (y * size + x) * 4;
          return rgba[o + 3] === 0 ? null : [rgba[o], rgba[o + 1], rgba[o + 2]];
        }
      }, scale);
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
