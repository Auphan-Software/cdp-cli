import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OVERLAY_JS, glidePath, pointerSeen, type PixelWindow } from '../../src/video/overlay.js';
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
