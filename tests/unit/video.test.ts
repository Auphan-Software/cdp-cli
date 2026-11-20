import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { OUTLINE_PX, OVERLAY_JS, glidePath, pointerSeen, type PixelWindow } from '../../src/video/overlay.js';
import windows from '../fixtures/pointer-windows.json';
import { muxWebm, type EncodedFrame } from '../../src/video/webm.js';
import { readJpegSize } from '../../src/video/capture.js';
import { HELPER_JS } from '../../src/video/encoder.js';
import { childArgs, conditionExpression, describeStep, locateExpression, parseSteps } from '../../src/video/steps.js';
import { frameTimeAt, overlayLine, parseSize, resolveOutput, sameFile, stepsIndexPath } from '../../src/commands/video.js';

type RGB = [number, number, number];

/** A window painted like the overlay: red ring r 10-13, white outline r 13-15.5, content inside/outside. */
function paint(size: number, opts: { ring?: RGB; outline?: RGB | null; bg?: RGB; dx?: number; clipX?: number }): PixelWindow {
  const c = size / 2 + (opts.dx ?? 0);
  return {
    size,
    at: (x, y) => {
      if (opts.clipX !== undefined && x >= opts.clipX) return null;
      const d = Math.hypot(x - c, y - c);
      if (d >= 10 && d < 13) return opts.ring ?? [255, 59, 48];
      if (d >= 13 && d < 15.5 && opts.outline !== null) return opts.outline ?? [255, 255, 255];
      return opts.bg ?? [30, 120, 200];
    }
  };
}

interface Fixture { name: string; note: string; scale: number; size: number; cx: number; cy: number; rgb: string }

/**
 * A window in device pixels like paint(), for a pointer drawn at a fractional device position:
 * a pixel takes the colour at its centre. The click point lies (fx, fy) device px from the middle.
 */
function paintScaled(scale: number, opts: { fx?: number; fy?: number; bg: RGB; outline?: RGB | null; outlineCss?: number; noPointer?: boolean }): PixelWindow {
  const size = 2 * Math.ceil(24 * scale);
  const cx = size / 2 + (opts.fx ?? 0);
  const cy = size / 2 + (opts.fy ?? 0);
  const outer = 13 + (opts.outlineCss ?? OUTLINE_PX);
  return {
    size, cx, cy,
    at: (x, y) => {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / scale; // CSS px from the pointer centre
      if (!opts.noPointer) {
        if (d >= 10 && d < 13) return [255, 59, 48];
        if (d >= 13 && d < outer && opts.outline !== null) return opts.outline ?? [255, 255, 255];
      }
      return opts.bg;
    }
  };
}

describe('pointer overlay check', () => {
  it('sees the overlay pointer: red ring hugged by a white outline', () => {
    expect(pointerSeen(paint(48, {}))).toBe(true);
  });

  it('rejects red page content without the white outline', () => {
    expect(pointerSeen(paint(48, { outline: null, bg: [255, 59, 48] }))).toBe(false);
    expect(pointerSeen(paint(48, { outline: null }))).toBe(false);
  });

  it('rejects a pointer that is elsewhere than the click point', () => {
    expect(pointerSeen(paint(48, { dx: 9 }))).toBe(false);
  });

  it('accepts a pointer half clipped by the frame edge, not one fully outside', () => {
    expect(pointerSeen(paint(48, { clipX: 26 }))).toBe(true);
    expect(pointerSeen({ size: 48, at: () => null })).toBe(false);
  });

  it('scales the ring radii to device pixels', () => {
    const scaled: PixelWindow = { size: 96, at: (x, y) => { const p = paint(48, {}).at(Math.floor(x / 2), Math.floor(y / 2)); return p; } };
    expect(pointerSeen(scaled, 2)).toBe(true);
  });

  it('draws a white outline wide enough to survive 4:2:0 chroma', () => {
    expect(OUTLINE_PX).toBe(4);
    expect(OVERLAY_JS).toContain("outline:'4px solid #fff'");
  });

  it('sees a pointer whose white outline has lost its blue to a yellow page (chroma bleed)', () => {
    const bled = paint(48, { bg: [255, 214, 10], outline: [255, 240, 160] });
    expect(pointerSeen(bled)).toBe(true);
    expect(pointerSeen(paint(48, { bg: [255, 214, 10], outline: [250, 238, 150], ring: [236, 96, 50] }))).toBe(true);
  });

  it('does not take a bright yellow page for the outline', () => {
    expect(pointerSeen(paint(48, { bg: [255, 255, 0], outline: [255, 255, 0] }))).toBe(false);
    expect(pointerSeen(paint(48, { bg: [255, 214, 10], outline: [255, 214, 10] }))).toBe(false);
  });

  it('does not take pale yellow page content (#ffff80) behind a red disc for pointer and outline', () => {
    // a 24 px red disc on a pale yellow page, no pointer: the page's own pixels are as bright as a bled outline
    const disc = (scale: number): PixelWindow => ({
      size: 2 * Math.ceil(24 * scale),
      at: (x, y) => (Math.hypot(x + 0.5 - Math.ceil(24 * scale), y + 0.5 - Math.ceil(24 * scale)) / scale < 12 ? [255, 59, 48] : [255, 255, 128])
    });
    expect(pointerSeen(disc(1))).toBe(false);
    expect(pointerSeen(disc(1.25), 1.25)).toBe(false);
    // and a pointer with a plain white outline on that page is still seen
    expect(pointerSeen(paint(48, { bg: [255, 255, 128], outline: [255, 255, 255] }))).toBe(true);
  });

  it('sees the pointer at DPR 1.25 whatever the fraction of the click point, and misses it when absent', () => {
    for (const [fx, fy] of [[0, 0], [0.5, 0], [0.25, 0.75], [-0.4, 0.3]]) {
      const win = paintScaled(1.25, { fx, fy, bg: [255, 214, 10], outline: [255, 238, 170], outlineCss: 2 });
      expect(pointerSeen(win, 1.25), `fraction ${fx},${fy}`).toBe(true);
      expect(pointerSeen({ ...win, cx: undefined, cy: undefined }, 1.25), `no fraction ${fx},${fy}`).toBe(true);
    }
    expect(pointerSeen(paintScaled(1.25, { bg: [255, 214, 10], noPointer: true }), 1.25)).toBe(false);
    expect(pointerSeen(paintScaled(1.25, { bg: [255, 59, 48], noPointer: true }), 1.25)).toBe(false);
    expect(pointerSeen(paintScaled(1.25, { bg: [255, 214, 10], outline: null }), 1.25)).toBe(false);
  });

  describe('real frames from a live VP9 recording (CT106 headless Chrome 153)', () => {
    /** The frame as sampled; `wipe` paints the pointer out with the frame's corner colour, `shift` slides it right by CSS px. */
    const rgbWindow = (f: Fixture, wipe = false, shift = 0): PixelWindow => {
      const rgb = Buffer.from(f.rgb, 'base64');
      const corner: RGB = [rgb[0], rgb[1], rgb[2]];
      const dx = Math.round(shift * f.scale);
      return {
        size: f.size, cx: f.cx, cy: f.cy,
        at: (x, y) => {
          const sx = x - dx;
          if (x < 0 || y < 0 || x >= f.size || y >= f.size || sx < 0 || sx >= f.size) return null;
          if (wipe && Math.hypot(sx + 0.5 - f.cx, y + 0.5 - f.cy) <= 20 * f.scale) return corner;
          const o = (y * f.size + sx) * 3;
          return [rgb[o], rgb[o + 1], rgb[o + 2]];
        }
      };
    };

    for (const f of windows as Fixture[]) {
      it(`${f.name}: the pointer is seen`, () => {
        expect(pointerSeen(rgbWindow(f), f.scale)).toBe(true);
      });
    }

    it('a pointer that is absent is still reported, on every frame', () => {
      for (const f of windows as Fixture[]) expect(pointerSeen(rgbWindow(f, true), f.scale), f.name).toBe(false);
    });

    it('a pointer 9 CSS px from the click point is still reported', () => {
      for (const f of windows as Fixture[]) expect(pointerSeen(rgbWindow(f, false, 9), f.scale), f.name).toBe(false);
    });
  });

  it('glides on an ease-in-out path ending on the target, or jumps with 0 ms', () => {
    const path = glidePath([0, 0], [100, 50], 160);
    expect(path).toHaveLength(10);
    expect(path[path.length - 1]).toEqual([100, 50]);
    expect(path[1][0] - path[0][0]).toBeLessThan(path[5][0] - path[4][0]);
    expect(glidePath([0, 0], [7, 8], 0)).toEqual([[7, 8]]);
  });

  it('page scripts parse and the overlay reports followed presses through the binding', () => {
    for (const js of [OVERLAY_JS, HELPER_JS, locateExpression({ text: 'Save' }), locateExpression({ selector: '#a' }),
      conditionExpression({ do: 'wait', text: 'Done', gone: true })]) {
      expect(() => new Function(js)).not.toThrow();
    }
    expect(OVERLAY_JS).toContain('__cdpVideoClick');
    expect(OVERLAY_JS).not.toMatch(/innerHTML|<style/);
  });
});

describe('reading a frame back from the written video (wi-14877)', () => {
  /**
   * A video element as Chrome's headless build behaves in a helper tab: a seek fires 'seeked' with the decoder
   * still holding a frame 0.15 s older (drawImage paints that one), and only a playing video hands over fresh
   * frames, one every 16 ms, each reported to requestVideoFrameCallback with its mediaTime.
   */
  function helperWithStaleSeek() {
    const FRAME = 0.016;
    const callbacks: Array<(now: number, m: { mediaTime: number }) => void> = [];
    let ticker: ReturnType<typeof setInterval> | undefined;
    const video: any = {
      videoWidth: 8, videoHeight: 8, muted: false, preload: '', error: null, painted: -1, cur: 0,
      set src(_v: string) { setTimeout(() => video.onloadeddata?.(), 0); },
      get currentTime() { return video.cur; },
      set currentTime(t: number) {
        video.cur = t;
        video.painted = Math.max(0, Math.round((t - 0.15) / FRAME) * FRAME);
        setTimeout(() => video.onseeked?.(), 0);
      },
      requestVideoFrameCallback(cb: (now: number, m: { mediaTime: number }) => void) { callbacks.push(cb); },
      play() {
        ticker ??= setInterval(() => {
          video.cur = Math.round((video.cur + FRAME) / FRAME) * FRAME;
          video.painted = video.cur;
          for (const cb of callbacks.splice(0)) cb(0, { mediaTime: video.cur });
        }, 4);
        return Promise.resolve();
      },
      pause() { if (ticker) clearInterval(ticker); ticker = undefined; }
    };
    class FakeCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext() {
        return {
          drawImage: (v: any) => { this.shown = v.painted; },
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4);
            const ms = Math.round(this.shown * 1000);
            data[0] = ms >> 8; data[1] = ms & 255;
            return { data };
          }
        };
      }
      shown = -1;
    }
    const sandbox: any = { document: { createElement: () => video }, URL: { createObjectURL: () => 'blob:x' }, Blob, atob, btoa,
      OffscreenCanvas: FakeCanvas, setTimeout, clearTimeout, Uint8Array, Promise, Math, String, Array };
    sandbox.window = sandbox;
    vm.runInNewContext(HELPER_JS, sandbox);
    return sandbox.window.__enc as { open(mime: string): Promise<unknown>; win(t: number, x: number, y: number, half: number): Promise<string> };
  }

  it('draws the frame at the click time, not the stale one a seek leaves on screen', async () => {
    const enc = helperWithStaleSeek();
    await enc.open('video/webm');
    for (const t of [0.8, 1.2336, 4.3617, 5.742]) {
      const bytes = Buffer.from(await enc.win(t + 0.001, 4, 4, 2), 'base64');
      const frameMs = (bytes[0] << 8) | bytes[1];
      // the first frame at or after t (a 16 ms grid), never one from before it
      expect(frameMs).toBeGreaterThanOrEqual(Math.round(t * 1000) - 2);
      expect(frameMs).toBeLessThanOrEqual(Math.round(t * 1000) + 16);
    }
  });
});

/** IVF (ffmpeg -f ivf) frames: 32-byte file header, then 12-byte frame headers. */
function readIvf(buf: Buffer): Array<{ pts: number; data: Buffer }> {
  const frames: Array<{ pts: number; data: Buffer }> = [];
  for (let o = 32; o + 12 <= buf.length;) {
    const size = buf.readUInt32LE(o);
    frames.push({ pts: Number(buf.readBigUInt64LE(o + 4)), data: buf.subarray(o + 12, o + 12 + size) });
    o += 12 + size;
  }
  return frames;
}

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe('WebM writer', () => {
  it('writes the EBML header, one cluster per key frame and a cue per cluster', () => {
    const frames: EncodedFrame[] = [
      { timeMs: 0, key: true, data: Buffer.from([1, 2]) },
      { timeMs: 40, key: false, data: Buffer.from([3]) },
      { timeMs: 2100, key: true, data: Buffer.from([4]) }
    ];
    const out = muxWebm({ codec: 'V_VP9', width: 640, height: 360, durationMs: 2500 }, frames);
    expect(out.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(out.includes(Buffer.from('webm'))).toBe(true);
    expect(out.includes(Buffer.from('V_VP9'))).toBe(true);
    const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
    let clusters = 0;
    for (let i = out.indexOf(clusterId); i >= 0; i = out.indexOf(clusterId, i + 1)) clusters++;
    expect(clusters).toBe(2);
    expect(out.includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]))).toBe(true);
  });

  it('refuses a stream that does not start with a key frame', () => {
    expect(() => muxWebm({ codec: 'V_VP8', width: 2, height: 2, durationMs: 1 }, [{ timeMs: 0, key: false, data: Buffer.from([0]) }]))
      .toThrow(/key frame/);
  });

  it.skipIf(!ffmpegAvailable)('produces a file ffprobe decodes with the right size, frame count and duration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-video-test-'));
    try {
      const ivf = join(dir, 'in.ivf');
      const gen = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '3',
        '-c:v', 'libvpx', '-g', '20', '-f', 'ivf', ivf]);
      expect(gen.status).toBe(0);
      const raw = readIvf(readFileSync(ivf));
      // VP8: bit 0 of the first byte is 0 on a key frame
      const frames = raw.map((f) => ({ timeMs: f.pts * 100, key: (f.data[0] & 1) === 0, data: f.data }));
      const webm = join(dir, 'out.webm');
      // tests/setup.ts mocks fs.writeFileSync for the screenshot tests; this file must reach ffprobe
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      realFs.writeFileSync(webm, muxWebm({ codec: 'V_VP8', width: 160, height: 90, durationMs: 3000 }, frames));
      const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
        'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', webm], { encoding: 'utf8' });
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stderr).toBe('');
      const info = JSON.parse(probe.stdout);
      expect(info.streams[0]).toMatchObject({ codec_name: 'vp8', width: 160, height: 90, nb_read_frames: String(raw.length) });
      expect(Number(info.format.duration)).toBeCloseTo(3, 1);
      const seek = spawnSync('ffmpeg', ['-v', 'error', '-ss', '2.5', '-i', webm, '-frames:v', '1', '-f', 'null', '-']);
      expect(seek.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('JPEG size', () => {
  it('reads width and height from the SOF marker', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0]);
    expect(readJpegSize(jpeg)).toEqual([1280, 720]);
    expect(readJpegSize(Buffer.from([0xff, 0xd8, 0x00]))).toBeUndefined();
  });
});

describe('video step file', () => {
  it('reads the Jarvis browser-video format, as an object or a bare list', () => {
    const doc = parseSteps(JSON.stringify({ name: 'demo', pointer: [10, 20], glide_ms: 100, steps: [
      { do: 'goto', url: 'http://127.0.0.1:8080/', caption: 'Open' },
      { do: 'click', text: 'Save' },
      { do: 'type', selector: '#name', value: 'Ada' },
      { do: 'press', key: 'Enter' },
      { do: 'wait', ms: 200 },
      { do: 'wait', text: 'Saving', gone: true, timeout: 10 },
      { do: 'wait', selector: '#name', value: 'Ada' },
      { do: 'caption', text: 'Done' },
      { do: 'assert-visible', selector: '.ok' }
    ] }));
    expect(doc).toMatchObject({ name: 'demo', pointer: [10, 20], glideMs: 100 });
    expect(doc.steps).toHaveLength(9);
    expect(parseSteps('[{"do":"click","selector":"#a"}]').steps).toHaveLength(1);
  });

  it.each([
    ['{"steps":[]}', /no steps/],
    ['[{"do":"hover","selector":"#a"}]', /step 1: unknown do "hover"/],
    ['[{"do":"click"}]', /step 1 \(click\): needs selector or text/],
    ['[{"do":"click","selector":"#a","text":"A"}]', /needs selector or text/],
    ['[{"do":"type","value":"x"}]', /needs selector and value/],
    ['[{"do":"goto","url":"x","wait":1}]', /unknown key wait/],
    ['[{"do":"wait","ms":120000}]', /step 1 \(wait\)/],
    ['[{"do":"press","key":"Enter","timeout":0}]', /timeout/]
  ])('refuses %s', (text, error) => {
    expect(() => parseSteps(text)).toThrow(error);
  });

  it('maps actions to cdp-cli child commands; the recorder handles waits and captions', () => {
    expect(childArgs({ do: 'goto', url: 'https://x/' }, 'P1')).toEqual(['navigate', 'https://x/', 'P1']);
    expect(childArgs({ do: 'click', text: 'Save' }, 'P1', [10.4, 20.6])).toEqual(['click', 'P1', '--x', '10', '--y', '21']);
    expect(childArgs({ do: 'type', selector: '#n', value: 'Ada' }, 'P1', [1, 2])).toEqual(['fill', '#n', 'Ada', 'P1']);
    expect(childArgs({ do: 'press', key: 'Tab' }, 'P1')).toEqual(['press-key', 'Tab', 'P1']);
    expect(childArgs({ do: 'wait', ms: 5 }, 'P1')).toBeUndefined();
    expect(describeStep({ do: 'click', text: 'Save' })).toBe('click "Save"');
  });

  it('builds wait conditions for visible, gone and field value', () => {
    expect(conditionExpression({ do: 'wait', selector: '#a', value: 'x' })).toBe('(document.querySelector("#a")||{}).value==="x"');
    expect(conditionExpression({ do: 'assert-visible', text: 'Saved' })).toContain('innerText.includes("Saved")');
    expect(conditionExpression({ do: 'wait', selector: '#a', gone: true }).startsWith('!')).toBe(true);
  });
});

describe('video command helpers', () => {
  it('defaults to a timestamped WebM and accepts only .webm or .mp4', () => {
    const r = resolveOutput(undefined, new Date('2026-11-18T20:30:05.123Z'));
    expect(r.mp4).toBe(false);
    expect(r.file).toMatch(/cdp-video-20261118T203005Z\.webm$/);
    expect(resolveOutput('demo.MP4').mp4).toBe(true);
    expect(() => resolveOutput('demo.gif')).toThrow(/VIDEO_INVALID_OUTPUT/);
  });

  it('parses --size', () => {
    expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(parseSize(undefined)).toBeUndefined();
    expect(() => parseSize('big')).toThrow(/VIDEO_INVALID_SIZE/);
  });

  it('picks the frame on screen at a click: last at or before, or first after for a real press', () => {
    const frames = [{ file: 'a', t: 0 }, { file: 'b', t: 1 }, { file: 'c', t: 2.5 }];
    expect(frameTimeAt(frames, 100, 101.7)).toBe(1);
    expect(frameTimeAt(frames, 100, 99)).toBe(0);
    expect(frameTimeAt(frames, 100, 101.7, true)).toBe(2.5);
    expect(frameTimeAt(frames, 100, 109, true)).toBe(2.5);
  });

  it('prints the Jarvis overlay line', () => {
    expect(overlayLine({ checked: 3, ok: 3, missing: [] })).toBe('overlay: pointer seen at 3/3 click steps');
    expect(overlayLine({ checked: 3, ok: 1, missing: [2, 3] })).toMatch(/^overlay: pointer NOT seen at click steps 2,3 of 3/);
    expect(overlayLine({ checked: 0, ok: 0, missing: [] })).toBe('overlay: not checked (no click steps)');
  });

  it('names the timing index beside the video, so a step file called <video>.steps.json is detectable', () => {
    expect(stepsIndexPath('/d/demo.webm')).toBe('/d/demo.steps.json');
    expect(stepsIndexPath('/d/demo.MP4')).toBe('/d/demo.steps.json');
  });

  it('compares files by real location, folding case on Windows and macOS only', () => {
    expect(sameFile('/d/Demo.steps.json', '/d/demo.steps.json', 'win32')).toBe(true);
    expect(sameFile('/d/Demo.steps.json', '/d/demo.steps.json', 'linux')).toBe(false);
    expect(sameFile('/d/a.steps.json', '/d/b.steps.json', 'win32')).toBe(false);
  });
});
