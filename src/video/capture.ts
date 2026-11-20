/**
 * Screencast capture of one page with the pointer overlay. The connection is
 * passive (no exclusive workspace lease): it only reads frames, evaluates the
 * overlay and polls page state, so the cdp-cli commands a replay runs as
 * children keep their own leases and guards.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { CDPContext, Page } from '../context.js';
import { CLICK_BINDING, OVERLAY_JS } from './overlay.js';
import type { CapturedFrame } from './encoder.js';

interface RawFrame { file: string; ts: number }

/** What the user is told when a minimised window cannot be recorded (Chrome paints nothing in it). */
export const MINIMISED_MESSAGE = 'VIDEO_WINDOW_MINIMISED: the recording window is minimised, so Chrome sends no frames: restore the window or use --headless';

export class VideoCapture {
  readonly frames: RawFrame[] = [];
  /** Real presses reported by the overlay in record mode, browser clock seconds. */
  readonly presses: Array<{ x: number; y: number; t: number }> = [];
  width = 0;
  height = 0;
  /** CSS viewport width of the first frame (video pixels per CSS pixel = width / cssWidth). */
  cssWidth = 0;
  closed = false;
  private ws?: WebSocket;

  constructor(private readonly context: CDPContext, private readonly page: Page, private readonly framesDir: string) {}

  async start(options: { follow?: boolean; size?: { width: number; height: number } } = {}): Promise<void> {
    mkdirSync(this.framesDir, { recursive: true });
    const ws = await this.context.connect(this.page, { lease: false });
    this.ws = ws;
    ws.on('close', () => { this.closed = true; });
    // A minimised window sends no frames and makes Runtime.evaluate time out: say so before either happens.
    if (await this.isMinimised()) { ws.close(); throw new Error(MINIMISED_MESSAGE); }
    ws.on('message', (data: Buffer) => {
      const text = data.toString();
      if (!text.includes('"method"')) return;
      const message = JSON.parse(text);
      if (message.method === 'Page.screencastFrame') {
        const { data: jpeg, metadata, sessionId } = message.params;
        const file = join(this.framesDir, `f${String(this.frames.length + 1).padStart(6, '0')}.jpg`);
        const bytes = Buffer.from(jpeg, 'base64');
        writeFileSync(file, bytes);
        if (!this.frames.length) {
          [this.width, this.height] = readJpegSize(bytes) ?? [0, 0];
          this.cssWidth = metadata.deviceWidth ?? 0;
        }
        this.frames.push({ file, ts: metadata.timestamp ?? Date.now() / 1000 });
        this.context.sendCommand(ws, 'Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      } else if (message.method === 'Runtime.bindingCalled' && message.params.name === CLICK_BINDING) {
        try { this.presses.push(JSON.parse(message.params.payload)); } catch { /* not ours */ }
      }
    });
    await this.context.sendCommand(ws, 'Page.enable');
    await this.context.sendCommand(ws, 'Runtime.enable');
    if (options.size) {
      await this.context.sendCommand(ws, 'Emulation.setDeviceMetricsOverride',
        { width: options.size.width, height: options.size.height, deviceScaleFactor: 0, mobile: false });
    }
    if (options.follow) await this.context.sendCommand(ws, 'Runtime.addBinding', { name: CLICK_BINDING });
    await this.context.sendCommand(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY_JS });
    await this.evaluate(OVERLAY_JS);
    if (options.follow) await this.evaluate('__bv.follow()');
    await this.context.sendCommand(ws, 'Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  }

  /** True when the page's browser window is minimised (Browser.getWindowForTarget); false when unknown. */
  async isMinimised(): Promise<boolean> {
    if (!this.ws || this.closed) return false;
    try {
      const info = await this.context.sendCommand(this.ws, 'Browser.getWindowForTarget', { targetId: this.page.id });
      return info?.bounds?.windowState === 'minimized';
    } catch {
      return false; // not every target or browser exposes window metadata
    }
  }

  async evaluate(expression: string): Promise<any> {
    if (!this.ws) throw new Error('capture not started');
    let r: any;
    try {
      r = await this.context.sendCommand(this.ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    } catch (error) {
      if (await this.isMinimised()) throw new Error(MINIMISED_MESSAGE);
      throw error;
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'page script failed');
    return r.result?.value;
  }

  /** The browser's clock in seconds: the clock of the screencast timestamps. */
  async now(): Promise<number> {
    return this.evaluate('(performance.timeOrigin+performance.now())/1000');
  }

  /**
   * Return once a frame painted after the caller's last action has arrived.
   * Chrome sends a frame only when the page changes, so an unchanged page ends
   * the wait at capMs.
   */
  async painted(capMs = 300): Promise<void> {
    const t0 = await this.now();
    await this.evaluate('new Promise(r=>{requestAnimationFrame(()=>requestAnimationFrame(r));setTimeout(r,100)})');
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline && !this.frames.some((f) => f.ts > t0)) {
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Stop the screencast, remove the overlay from the page and return frames on the video clock (seconds). */
  async stop(): Promise<{ frames: CapturedFrame[]; end: number; t0: number }> {
    let stoppedAt = Date.now() / 1000;
    if (this.ws && !this.closed) {
      try {
        stoppedAt = await this.now();
        await this.context.sendCommand(this.ws, 'Page.stopScreencast');
        await new Promise((r) => setTimeout(r, 200));
        await this.evaluate("document.getElementById('__bv')?.remove();try{sessionStorage.removeItem('__bv')}catch(e){};delete window.__bv");
        if (this.presses.length) await this.context.sendCommand(this.ws, 'Runtime.removeBinding', { name: CLICK_BINDING });
      } catch { /* the page may be gone; keep what was captured */ }
      this.ws.close();
    }
    const sorted = [...this.frames].sort((a, b) => a.ts - b.ts); // Chrome can deliver frames out of order
    const t0 = sorted.length ? sorted[0].ts : stoppedAt; // the first frame is 0 s of the video
    const end = Math.max(stoppedAt - t0, sorted.length ? sorted[sorted.length - 1].ts - t0 : 0);
    return { frames: sorted.map((f) => ({ file: f.file, t: f.ts - t0 })), end, t0 };
  }
}

/** Width and height from a JPEG's SOF marker (no image library). */
export function readJpegSize(jpeg: Buffer): [number, number] | undefined {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return undefined;
    const marker = jpeg[i + 1];
    const length = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [jpeg.readUInt16BE(i + 7), jpeg.readUInt16BE(i + 5)];
    }
    i += 2 + length;
  }
  return undefined;
}
