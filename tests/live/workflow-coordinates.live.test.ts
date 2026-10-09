import { beforeAll, afterAll, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, type LiveFixture } from './harness.js';
import { WorkspaceSessionService, defaultWorkspaceSessionStorePath } from '../../src/sessions/workspace-session-service.js';
import { CDPDaemon } from '../../src/daemon/daemon.js';

const exec = promisify(execFile);
let chrome: LiveChrome, app: LiveFixture, root: string, daemon: CDPDaemon;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-coordinate-live-'));
  app = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/frame') return res.end('<button style="position:absolute;left:20px;top:20px;width:100px;height:40px" onclick="parent.frameClicks++">Frame action</button>');
    res.end('<script>window.clicks=0;window.frameClicks=0</script><button id="hit" style="position:absolute;left:100px;top:100px;width:100px;height:40px" onclick="window.clicks++">Hit</button>' +
      '<button disabled style="position:absolute;left:250px;top:100px;width:100px;height:40px">Disabled</button>' +
      '<iframe src="/frame" style="position:absolute;left:100px;top:250px;width:300px;height:150px;border:0"></iframe>' +
      '<input id="secret" value="private-input-value"><textarea id="private-note">private-textarea-value</textarea>');
  });
  chrome = await LiveChrome.launch();
  daemon = new CDPDaemon({ port: 0, cdpUrl: chrome.cdpUrl }); await daemon.start();
}, 30000);
afterAll(async () => {
  await daemon?.stop(); await chrome?.close(); await app?.close();
  if (chrome) await rm(defaultWorkspaceSessionStorePath(chrome.cdpUrl), { force: true });
  if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
}, 30000);

it('maps reduced screenshot points, witnesses top/frame clicks and refuses stale layout/disabled targets', async () => {
  const owner = await WorkspaceSessionService.open(chrome.cdpUrl);
  let page: string;
  try { page = (await owner.createSession('coordinate-live', { url: app.baseUrl })).pageIds[0]; } finally { owner.close(); }
  const info = (await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as any[]).find(p => p.id === page);
  const fixture = await CdpSession.connect(info.webSocketDebuggerUrl);
  const evaluate = async (expression: string) => (await fixture.command('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const cli = async (args: string[], profile = 'haiku-compact') => {
    let stdout: string;
    try { ({ stdout } = await exec(process.execPath, [resolve('build/index.js'), ...args, '--session', 'coordinate-live', '--cdp-url', chrome.cdpUrl],
      { windowsHide: true, env: { ...process.env, CDP_DAEMON_URL: `http://127.0.0.1:${daemon.listeningPort}`, CDP_STATE_ROOT: root,
        CDP_WORKFLOW_VIEW_PROFILE: profile, CDP_WORKFLOW_CLOCK_SELECTORS: '[]' } })); }
    catch (e) { stdout = (e as { stdout: string }).stdout; }
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
  };
  const shot = () => cli(['workflow', 'screenshot', page, '--task', 'click visible targets', '--screenshot-viewport-scale', '0.5']);
  const click = (source: string, x: number, y: number) => cli(['workflow', 'act', page, '--task', 'click once', '--source', source, '--action', 'click', '--x', String(x), '--y', String(y)]);
  try {
    await new Promise(r => setTimeout(r, 1200));
    const first = await shot();
    expect(first.value.screenshot.coordinateAligned).toBe(true);
    const s = first.value.screenshot;
    expect(s.pixelWidth).toBe(Math.round(s.coordinateFrame.width * 0.5));
    expect(s.pixelHeight).toBe(Math.round(s.coordinateFrame.height * 0.5));
    const acted = await click(first.value.view.source.id, 75, 60);
    expect(acted.value.action.commandSucceeded).toBe(true);
    expect(await evaluate('window.clicks')).toBe(1);
    const second = await shot();
    await evaluate("document.querySelector('#hit').style.left='400px'");
    const stale = await click(second.value.view.source.id, 75, 60);
    expect(stale.error).toBe(true);
    expect(stale.message).toContain('COORDINATE_IMAGE_CHANGED');
    expect(await evaluate('window.clicks')).toBe(1);
    const third = await shot();
    const disabled = await click(third.value.view.source.id, 150, 60);
    expect(disabled.value.action.commandSucceeded).toBe(false);
    expect(await evaluate('window.clicks')).toBe(1);
    const fourth = await shot();
    const framed = await click(fourth.value.view.source.id, 85, 145);
    expect(framed.value.action.commandSucceeded).toBe(true);
    expect(await evaluate('window.frameClicks')).toBe(1);
    const snapshot = await cli(['workflow', 'snapshot', page, '--task', 'find actionable controls']);
    expect(snapshot.value.actionable.aligned).toBe(true);
    expect(snapshot.value.actionable.lines.some((line: string) => line.includes('Hit') && line.includes('#hit'))).toBe(true);
    expect(JSON.stringify(snapshot.value.actionable)).not.toContain('private-input-value');
    expect(JSON.stringify(snapshot.value.actionable)).not.toContain('private-textarea-value');
    const fifth = await shot();
    await evaluate("document.body.insertAdjacentHTML('beforeend','<div id=overlay style=\"position:fixed;inset:0;z-index:999\"></div>')");
    expect((await click(fifth.value.view.source.id, 225, 60)).error).toBe(true);
    expect(await evaluate('window.clicks')).toBe(1);
    await evaluate("document.querySelector('#overlay').remove()");
    for (const profile of ['current-24k', 'rich-64k']) {
      const mapped = await cli(['workflow', 'screenshot', page, '--task', 'click visible Hit', '--screenshot-viewport-scale', '0.5'], profile);
      const clicked = await cli(['workflow', 'act', page, '--task', 'click Hit once', '--source', mapped.value.view.source.id,
        '--action', 'click', '--x', '225', '--y', '60'], profile);
      expect(clicked.value.action.commandSucceeded).toBe(true);
    }
    expect(await evaluate('window.clicks')).toBe(3);
  } finally { await fixture.close(); }
}, 60000);
