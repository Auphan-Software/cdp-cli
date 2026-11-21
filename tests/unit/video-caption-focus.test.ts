import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises'; // the suite's setup mocks fs.writeFileSync
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { OVERLAY_JS, CAPTION_BAR_PX } from '../../src/video/overlay.js';
import { checkClicks, encodeWebm, secureDocument } from '../../src/video/encoder.js';
import { parseSteps } from '../../src/video/steps.js';
import { captionBar, parseCaptionPosition } from '../../src/commands/video.js';

/** A context that records every CDP command; the helper page answers the encoder's calls with one tiny key frame. */
function fakeContext(failVideo = false) {
  const commands: Array<{ method: string; params: any }> = [];
  const context: any = {
    createPage: async () => ({ id: 'helper' }),
    connect: async () => Object.assign(new EventEmitter(), { close() {} }),
    closePage: async () => undefined,
    sendCommand: async (_ws: unknown, method: string, params: any) => {
      commands.push({ method, params });
      if (method !== 'Runtime.evaluate') return {};
      const e: string = params.expression;
      if (e.includes('__enc.start(')) return { result: { value: 'V_VP8' } };
      if (e.includes('__enc.add(')) return { result: { value: [] } };
      if (e.includes('__enc.finish()')) return { result: { value: [[0, true, Buffer.from('frame').toString('base64')]] } };
      if (failVideo && e.includes('__enc.open')) return { exceptionDetails: { exception: { description: 'Error: the written video did not show its frame' } } };
      return { result: { value: undefined } };
    }
  };
  return { context, commands, methods: () => commands.map((c) => c.method) };
}

describe('end of recording: the helper tab does not take the desktop focus (wi-14879)', () => {
  it('encoding and the pointer check never call Page.bringToFront by default, and the helper tab is closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-focus-'));
    try {
      const jpg = join(dir, 'f.jpg');
      await writeFile(jpg, 'x');
      const enc = fakeContext();
      const webm = await encodeWebm(enc.context, [{ file: jpg, t: 0 }], 1, { width: 8, height: 8 });
      expect(webm.length).toBeGreaterThan(0);
      expect(enc.methods()).toContain('Page.navigate');
      expect(enc.methods()).not.toContain('Page.bringToFront');
      const video = join(dir, 'v.webm');
      await writeFile(video, webm);
      const check = fakeContext();
      await checkClicks(check.context, video, 'video/webm', [{ n: 1, at: [1, 1], t: 0 }], 1).catch(() => undefined);
      expect(check.methods()).toContain('Page.navigate');
      expect(check.methods()).not.toContain('Page.bringToFront');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('brings the helper tab to the front only when asked, after the page loaded', async () => {
    const asked = fakeContext();
    await secureDocument(asked.context, new EventEmitter() as any, true);
    expect(asked.methods()).toContain('Page.bringToFront');
    expect(asked.methods().indexOf('Page.bringToFront')).toBeGreaterThan(asked.methods().indexOf('Page.navigate'));
    const dflt = fakeContext();
    await secureDocument(dflt.context, new EventEmitter() as any);
    expect(dflt.methods()).not.toContain('Page.bringToFront');
    const dir = mkdtempSync(join(tmpdir(), 'cdp-focus-'));
    try {
      const jpg = join(dir, 'f.jpg');
      await writeFile(jpg, 'x');
      const front = fakeContext();
      await encodeWebm(front.context, [{ file: jpg, t: 0 }], 1, { width: 8, height: 8 }, { front: true });
      expect(front.methods()).toContain('Page.bringToFront');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a read-back failure without the front tab points at --bring-to-front, and with it does not repeat itself', async () => {
    const video = join(mkdtempSync(join(tmpdir(), 'cdp-focus-')), 'v.webm');
    try {
      await writeFile(video, 'x');
      const hint = /--bring-to-front/;
      await expect(checkClicks(fakeContext(true).context, video, 'video/webm', [{ n: 1, at: [1, 1], t: 0 }], 1)).rejects.toThrow(hint);
      await expect(checkClicks(fakeContext(true).context, video, 'video/webm', [{ n: 1, at: [1, 1], t: 0 }], 1, { front: true })).rejects.not.toThrow(hint);
    } finally { rmSync(join(video, '..'), { recursive: true, force: true }); }
  });
});

describe('caption position', () => {
  it('reads caption_position from the step file and the --caption-position value', () => {
    expect(parseSteps('{"caption_position":"outside","steps":[{"do":"wait","ms":1}]}').captionPosition).toBe('outside');
    expect(parseSteps('{"steps":[{"do":"wait","ms":1}]}').captionPosition).toBeUndefined();
    expect(() => parseSteps('{"caption_position":"middle","steps":[{"do":"wait","ms":1}]}')).toThrow(/caption_position must be one of bottom, top, outside/);
    expect(parseCaptionPosition(undefined)).toBeUndefined();
    expect(parseCaptionPosition('top')).toBe('top');
    expect(() => parseCaptionPosition('left')).toThrow(/VIDEO_INVALID_CAPTION_POSITION/);
  });

  /** Just enough DOM to run the overlay and read where its caption box is placed. */
  function overlay() {
    const els: Record<string, any> = {};
    const mk = (tag: string): any => ({ tag, id: '', style: { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; } },
      children: [] as any[], append(...c: any[]) { this.children.push(...c); }, appendChild(c: any) { this.children.push(c); },
      isConnected: false, getAnimations: () => [], animate: () => undefined, getBoundingClientRect: () => ({ left: 0, top: 0, width: 26, height: 26 }), textContent: '' });
    const document: any = { documentElement: mk('html'), createElement: (t: string) => { const e = mk(t); const proto = e; return new Proxy(proto, { set(o, k, v) { o[k] = v; if (k === 'id') els[v] = o; return true; } }); },
      addEventListener() {} };
    document.documentElement.appendChild = (c: any) => { c.isConnected = true; document.documentElement.children.push(c); };
    const sandbox: any = { document, window: {}, sessionStorage: { getItem: () => null, setItem() {} }, performance: { timeOrigin: 0, now: () => 0 }, addEventListener() {}, JSON, Object };
    sandbox.window = sandbox;
    vm.runInNewContext(OVERLAY_JS, sandbox);
    return { bv: sandbox.__bv, box: () => els.__bv_caption.style.props };
  }

  it('the caption sits at the bottom by default, at the top on request, and is hidden in the page for outside', () => {
    const dflt = overlay();
    dflt.bv.caption('Hello');
    expect(dflt.box()).toMatchObject({ bottom: '28px', top: 'auto', display: 'block' });
    const top = overlay();
    top.bv.captionPosition('top');
    top.bv.caption('Hello');
    expect(top.box()).toMatchObject({ top: '28px', bottom: 'auto', display: 'block' });
    const outside = overlay();
    outside.bv.captionPosition('outside');
    outside.bv.caption('Hello');
    expect(outside.box().display).toBe('none');
  });

  it('the outside bar is a strip under the page; each frame carries the caption in force at its time', () => {
    const bar = captionBar([[100, 'First'], [102, 'Second']], 99, 2);
    expect(bar.height).toBe(CAPTION_BAR_PX * 2);
    expect([0.5, 1.0, 1.5, 3.5, 9].map(bar.at)).toEqual(['', 'First', 'First', 'Second', 'Second']);
  });

  it('encoding with a bar makes the video taller by the bar and sends the caption of each frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-bar-'));
    try {
      const jpg = join(dir, 'f.jpg');
      await writeFile(jpg, 'x');
      const ctx = fakeContext();
      await encodeWebm(ctx.context, [{ file: jpg, t: 0.5 }], 1, { width: 800, height: 600 },
        { bar: { height: 64, fontPx: 22, at: (t) => (t >= 0.5 ? 'Press Save' : '') } });
      const expressions = ctx.commands.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.params.expression as string);
      expect(expressions.find((e) => e.startsWith('__enc.start('))).toBe('__enc.start(800,664,64,22)');
      expect(expressions.filter((e) => e.startsWith('__enc.add(')).every((e) => e.includes('"Press Save"'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('review fixes (round 1)', () => {
  it('a caption change on a static page still gets its own encoded frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-bar-'));
    try {
      const jpg = join(dir, 'f.jpg');
      await writeFile(jpg, 'x');
      const ctx = fakeContext();
      const bar = captionBar([[100, 'A'], [105, 'B']], 100, 1);
      await encodeWebm(ctx.context, [{ file: jpg, t: 0 }], 12, { width: 8, height: 8 }, { bar });
      const adds = ctx.commands.map((c) => c.params?.expression as string).filter((e) => e?.startsWith('__enc.add('));
      expect(adds.map((e) => /,(\d+),(?:true|false),"(.*)"\)$/.exec(e)!.slice(1, 3).join(':'))).toEqual(['0:A', '5000:B', '12000:B']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses a non-string swipe selector at parse time', () => {
    expect(() => parseSteps('[{"do":"swipe","selector":17,"direction":"up","distance":20}]')).toThrow(/selector must be a non-empty string/);
    expect(() => parseSteps('[{"do":"swipe","selector":"","from":[1,1],"to":[2,2]}]')).toThrow(/selector must be/);
  });
});
