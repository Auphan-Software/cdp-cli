import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, type LiveFixture } from './harness.js';

const exec = promisify(execFile);
let chrome: LiveChrome, app: LiveFixture, root: string;

async function cli(args: string[]): Promise<{ code: number; rows: any[]; stderr: string }> {
  const r = await exec(process.execPath, [resolve('build/index.js'), ...args, '--cdp-url', chrome.cdpUrl], {
    env: { ...process.env, CDP_SESSION: '', CDP_DAEMON_URL: '' }, maxBuffer: 8 * 1024 * 1024, timeout: 120_000
  }).then(ok => ({ ...ok, code: 0 })).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }));
  const rows = String(r.stdout).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return { code: r.code as number, rows, stderr: String(r.stderr) };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-video-live-'));
  app = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Loyalty</title><body style="font:20px sans-serif;padding:40px">
      <input id="name" placeholder="Customer"><button id="earn" onclick="out.textContent=document.getElementById('name').value+': 10 points added'">Earn points</button>
      <p id="out"></p><button id="late" style="margin-top:300px" onclick="out.textContent='History open'">Next page</button></body>`);
  });
  chrome = await LiveChrome.launch();
}, 30000);
afterAll(async () => {
  await chrome?.close(); await app?.close();
  if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
}, 30000);

describe('video replay and record through the built CLI', () => {
  it('replays a step file to a WebM whose own check sees the pointer at every click', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const steps = join(root, 'demo.json');
    await writeFile(steps, JSON.stringify({ steps: [
      { do: 'caption', text: 'Earn points for a customer' },
      { do: 'type', selector: '#name', value: 'Ada' },
      { do: 'click', text: 'Earn points' },
      { do: 'assert-visible', text: 'Ada: 10 points added' },
      { do: 'click', text: 'Next page', caption: 'Open the history' },
      { do: 'wait', text: 'History open' }
    ] }));
    const out = join(root, 'demo.webm');
    const r = await cli(['video', 'replay', steps, page.id, '--out', out, '--glide-ms', '150']);
    const result = r.rows.at(-1);
    expect(r.code, JSON.stringify(result) + r.stderr).toBe(0);
    expect(result).toMatchObject({ success: true, type: 'video', file: out, overlay: { checked: 3, ok: 3, missing: [] } });
    expect(r.stderr).toContain('overlay: pointer seen at 3/3 click steps');
    expect(existsSync(`${out}.frames`)).toBe(false);
    const index = JSON.parse(await readFile(join(root, 'demo.steps.json'), 'utf8'));
    expect(index.steps.map((s: any) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', out], { encoding: 'utf8' });
    if (probe.status === 0) {
      const info = JSON.parse(probe.stdout);
      expect(['vp9', 'vp8']).toContain(info.streams[0].codec_name);
      expect(Number(info.format.duration)).toBeGreaterThan(1);
    }
    // the overlay is removed from the page afterwards
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      expect((await session.command('Runtime.evaluate', { expression: "!!document.getElementById('__bv')", returnByValue: true })).result.value).toBe(false);
    } finally { session.close(); }
  }, 120000);

  it('stops at a failing step, names it and still writes the video so far', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const steps = join(root, 'fail.json');
    await writeFile(steps, JSON.stringify([{ do: 'click', text: 'Earn points' }, { do: 'click', selector: '#missing', timeout: 1 }]));
    const out = join(root, 'fail.webm');
    const r = await cli(['video', 'replay', steps, page.id, '--out', out, '--glide-ms', '0']);
    expect(r.code).toBe(1);
    expect(r.rows.at(-1)).toMatchObject({ success: false, failedStep: 2 });
    expect(r.stderr).toMatch(/replay failed at step 2 \(click "#missing"\): not clickable within 1s: not found/);
    expect(existsSync(out)).toBe(true);
  }, 120000);

  it('records real mouse input with the pointer following it and a checked ring per press', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const out = join(root, 'record.webm');
    const running = cli(['video', 'record', page.id, '--out', out, '--seconds', '4']);
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      await new Promise(r => setTimeout(r, 1500));
      for (const [x, y] of [[120, 60], [200, 70], [260, 75]]) {
        await session.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
        await new Promise(r => setTimeout(r, 60));
      }
      await session.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 260, y: 75, button: 'left', buttons: 1, clickCount: 1 });
      await session.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 260, y: 75, button: 'left', buttons: 0, clickCount: 1 });
    } finally { session.close(); }
    const r = await running;
    expect(r.code, JSON.stringify(r.rows) + r.stderr).toBe(0);
    expect(r.rows.at(-1)).toMatchObject({ success: true, clicks: 1, stopped: 'duration', overlay: { checked: 1, ok: 1 } });
    expect(r.stderr).toContain('overlay: pointer seen at 1/1 click steps');
  }, 120000);
});
