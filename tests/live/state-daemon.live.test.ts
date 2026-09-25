import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CDPDaemon } from '../../src/daemon/daemon.js';
import { DaemonClient } from '../../src/daemon/client.js';
import { CdpSession, LiveChrome, startFixture, waitFor, type LiveFixture } from './harness.js';

const execFileAsync = promisify(execFile);
let chrome: LiveChrome;
let app: LiveFixture;
let daemon: CDPDaemon;
let daemonUrl: string;
let root: string;

async function cli(...args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath,
    [resolve('build/index.js'), 'state', ...args, '--cdp-url', chrome.cdpUrl],
    { env: { ...process.env, CDP_DAEMON_URL: daemonUrl, CDP_STATE_ROOT: root }, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-state-daemon-'));
  app = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url?.startsWith('/frame')) { res.end('<p id="inside">Old panel</p>'); return; }
    res.end('<!doctype html><p id="status">Ready</p><iframe id="panel" src="/frame"></iframe>');
  });
  chrome = await LiveChrome.launch();
  daemon = new CDPDaemon({ port: 0, cdpUrl: chrome.cdpUrl, healthCheckIntervalMs: 1000 });
  await daemon.start();
  daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
}, 30_000);

afterAll(async () => {
  await daemon?.stop();
  await chrome?.close();
  await app?.close();
  if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
}, 30_000);

it('captures same-origin frame changes and a blocking alert through the daemon', async () => {
  const page = await chrome.createPage(app.baseUrl);
  const client = new DaemonClient({ daemonUrl, cdpUrl: chrome.cdpUrl });
  await waitFor(async () => {
    if (!(await client.listSessions()).some((session) => session.pageId === page.id)) throw new Error('Daemon page not registered');
    return true;
  }, 10_000);
  const before = await cli('capture', page.id, '--name', 'daemon-before', '--stability-ms=0');
  expect(before.success).toBe(true);
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    await session.command('Runtime.evaluate', {
      expression: `document.querySelector('#panel').contentDocument.querySelector('#inside').textContent='New panel'`,
      returnByValue: true
    });
    await cli('capture', page.id, '--name', 'daemon-after', '--stability-ms=0');
    const frameDiff = await cli('diff', 'daemon-before', 'daemon-after', page.id);
    expect(frameDiff.value.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: expect.stringContaining('id:inside'), field: 'text', to: 'New panel' })
    ]));
    await session.command('Runtime.evaluate', { expression: `setTimeout(() => alert('hello'), 0)`, returnByValue: true });
    await waitFor(async () => {
      const status = await client.getDialogStatus(page.id);
      if (!status.open) throw new Error('Alert not yet observed');
      return true;
    }, 10_000);
    const blocked = await cli('capture', page.id, '--name', 'daemon-blocked', '--stability-ms=0');
    expect(blocked.value.coverage.blockedByDialog).toBe(true);
    const blockedDiff = await cli('diff', 'daemon-after', 'daemon-blocked', page.id);
    expect(blockedDiff.value.changed).toBeNull();
    expect(blockedDiff.value.changes).toEqual([expect.objectContaining({ kind: 'dialog', key: '@dialog' })]);
  } finally {
    try { await session.command('Page.handleJavaScriptDialog', { accept: true }); } catch { /* alert may have closed */ }
    session.close();
  }
}, 40_000);
