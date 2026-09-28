import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDPContext } from '../../src/context.js';
import type { RecordedAction } from '../../src/recording.js';
import { fill } from '../../src/commands/input.js';
import { armNetworkIdleWatcher } from '../../src/commands/wait.js';
import { CdpSession, LiveChrome, startFixture, waitFor, type LiveFixture } from './harness.js';

let chrome: LiveChrome;
let app: LiveFixture;
let crossOrigin: LiveFixture;

beforeAll(async () => {
  crossOrigin = await startFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>cross frame</title><p id="cross-frame">cross origin</p>');
  }, '127.0.0.2');
  app = await startFixture((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    if (url.pathname === '/replace.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>replacement</title>
        <input id="replace" aria-label="replacement field">
        <script>
          document.querySelector('#replace').addEventListener('input', function replaceOnInput() {
            if (!this.value) return;
            const next = document.createElement('input');
            next.id = 'replace';
            next.value = 'live-replacement:' + this.value;
            this.replaceWith(next);
          });
        </script>`);
      return;
    }
    if (url.pathname === '/delayed.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>delayed click</title>
        <button id="delayed-fetch" onclick="fetch('/delayed-response').then(() => window.fetchFinished = Date.now())">Fetch slowly</button>`);
      return;
    }
    if (url.pathname === '/delayed-response') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }, 850);
      return;
    }
    if (url.pathname === '/frames.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>frames</title>
        <iframe id="same-origin-frame" name="same-origin-frame" src="/same-frame.html"></iframe>
        <iframe id="cross-origin-frame" name="cross-origin-frame" src="${crossOrigin.baseUrl}/cross-frame.html"></iframe>`);
      return;
    }
    if (url.pathname === '/duplicate-frames.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>duplicate frames</title><iframe id="first" src="/same-frame.html"></iframe><iframe id="second" src="/same-frame.html"></iframe>');
      return;
    }
    if (url.pathname === '/same-frame.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>same frame</title><p id="same-frame">same origin</p><button id="in-frame" onclick="document.querySelector(\'#same-frame\').textContent=\'done\'">Go</button>');
      return;
    }
    if (url.pathname === '/network.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>network lifecycle</title><script>
        window.runNetwork = async () => {
          const result = {};
          try { result.ok = await (await fetch('/network-ok')).text(); } catch (error) { result.ok = String(error); }
          try { await fetch('/network-abort'); result.failed = 'unexpected success'; } catch (error) { result.failed = 'rejected'; }
          window.networkResult = result;
        };
      </script>`);
      return;
    }
    if (url.pathname === '/network-ok') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('success');
      return;
    }
    if (url.pathname === '/network-abort') {
      // A destroyed response is a browser-level transport failure, not merely
      // an HTTP error or a CORS rejection.
      response.socket?.destroy();
      return;
    }
    response.writeHead(404);
    response.end('missing');
  });
  chrome = await LiveChrome.launch({ headful: process.env.CDP_LIVE_HEADFUL === '1' });
}, 30_000);

afterAll(async () => {
  await chrome?.close();
  await Promise.all([app?.close(), crossOrigin?.close()]);
  expect(chrome.status()).toEqual({ chromeStopped: true, profileRemoved: true });
}, 30_000);

describe('live Chrome contracts', () => {
  it('observes the replacement input value after typing into a reactive field', async () => {
    const page = await chrome.createPage(`${app.baseUrl}/replace.html`);
    const context = new CDPContext(chrome.cdpUrl);

    await fill(context, '#replace', 'agent', { page: page.id });

    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const result = await session.command('Runtime.evaluate', {
        expression: 'document.querySelector("#replace").value',
        returnByValue: true
      });
      // The browser DOM, not a protocol-acknowledgement, proves the retained
      // field was replaced on its first input event.
      expect(result.result.value).toBe('live-replacement:a');
    } finally {
      session.close();
    }
  });

  it('keeps a pre-armed network-idle watcher pending for a delayed click fetch', async () => {
    const page = await chrome.createPage(`${app.baseUrl}/delayed.html`);
    const context = new CDPContext(chrome.cdpUrl);
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const idle = await armNetworkIdleWatcher(context, session.ws);
    const startedAt = Date.now();
    try {
      const rect = await session.command('Runtime.evaluate', {
        expression: `(() => { const r = document.querySelector('#delayed-fetch').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        returnByValue: true
      });
      const { x, y } = rect.result.value;
      await session.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await session.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await idle.wait(8_000);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_150);
      const observed = await session.command('Runtime.evaluate', { expression: 'typeof window.fetchFinished === "number"', returnByValue: true });
      expect(observed.result.value).toBe(true);
    } finally {
      idle.dispose();
      session.close();
    }
  });

  it('discovers both frame documents and the site-isolated cross-origin iframe target', async () => {
    const page = await chrome.createPage(`${app.baseUrl}/frames.html`);
    const pageSession = await CdpSession.connect(page.webSocketDebuggerUrl);
    const browser = await chrome.browserSession();
    try {
      await browser.command('Target.setDiscoverTargets', { discover: true });
      const sameOriginFrames = await waitFor(async () => {
        const tree = await pageSession.command('Page.getFrameTree');
        const childFrames = tree.frameTree.childFrames ?? [];
        if (childFrames.length < 1) throw new Error('Same-origin iframe document is still loading');
        return childFrames.map((child: any) => child.frame.url);
      });
      expect(sameOriginFrames).toContain(`${app.baseUrl}/same-frame.html`);

      const targets = await waitFor(async () => {
        const result = await browser.command('Target.getTargets');
        const iframeTarget = result.targetInfos.find((target: any) =>
          target.type === 'iframe' && target.url.includes('/cross-frame.html')
        );
        if (!iframeTarget) throw new Error('The site-isolated iframe target is not published yet');
        return iframeTarget;
      });
      expect(targets.url).toContain('127.0.0.2');
    } finally {
      pageSession.close();
      browser.close();
    }
  });

  it('resolves an iframe by its DOM owner when two frames share the same URL', async () => {
    const page = await chrome.createPage(`${app.baseUrl}/duplicate-frames.html`);
    const context = new CDPContext(chrome.cdpUrl);
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      await waitFor(async () => {
        const result = await context.evaluateInFrame(session.ws,
          'window.frameElement.id', '#second', { returnByValue: true });
        if (result.result?.value !== 'second') throw new Error('Second frame context is not ready');
      });
      await expect(context.resolveFrameId(session.ws, 'iframe')).rejects.toThrow('exactly one iframe');
    } finally {
      session.close();
    }
  });

  it('records and replays a verified action in the selected iframe', async () => {
    const page = await chrome.createPage(`${app.baseUrl}/duplicate-frames.html`);
    const dir = mkdtempSync(join(tmpdir(), 'cdp-frame-replay-'));
    const file = join(dir, 'actions.ndjson');
    const cli = join(process.cwd(), 'build', 'index.js');
    const env = { ...process.env, CDP_RECORD_FILE: file, CDP_SESSION: '' };
    const run = (...args: string[]) => spawnSync(process.execPath,
      [cli, ...args, '--cdp-url', chrome.cdpUrl],
      { encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
    try {
      await waitFor(async () => {
        const session = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
          const ready = await session.command('Runtime.evaluate', {
            expression: 'document.querySelector("#second")?.contentDocument?.querySelector("#in-frame") != null',
            returnByValue: true
          });
          if (!ready.result.value) throw new Error('Frame not loaded');
        } finally { session.close(); }
      });
      await new Promise(resolve => setTimeout(resolve, 750));
      const first = run('click', '#in-frame', page.id, '--frame', '#second', '--wait-for-text', 'done');
      const probe = await CdpSession.connect(page.webSocketDebuggerUrl);
      let observed = '';
      try {
        const read = await probe.command('Runtime.evaluate', { expression: 'document.querySelector("#second").contentDocument.querySelector("#same-frame").textContent', returnByValue: true });
        observed = String(read.result.value);
      } finally { probe.close(); }
      expect(first.status, first.stdout + first.stderr + ` observed=${observed}`).toBe(0);
      const recorded = JSON.parse(readFileSync(file, 'utf8').trim()) as RecordedAction;
      expect(recorded.argv).toContain('{{page}}');
      expect(recorded.frame).toBe('#second');
      const session = await CdpSession.connect(page.webSocketDebuggerUrl);
      try {
        await session.command('Runtime.evaluate', {
          expression: 'document.querySelector("#second").contentDocument.querySelector("#same-frame").textContent = "same origin"'
        });
      } finally { session.close(); }
      const replay = run('record', 'replay', file, page.id);
      expect(replay.status, replay.stdout + replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout.trim()).outcome).toBe('PASSED');
      if (process.env.CDP_LIVE_EXE) {
        const reset = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
          await reset.command('Runtime.evaluate', {
            expression: 'document.querySelector("#second").contentDocument.querySelector("#same-frame").textContent = "same origin"'
          });
        } finally { reset.close(); }
        const exeReplay = spawnSync(process.env.CDP_LIVE_EXE,
          ['record', 'replay', file, page.id, '--cdp-url', chrome.cdpUrl],
          { encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
        expect(exeReplay.status, exeReplay.stdout + exeReplay.stderr).toBe(0);
        expect(JSON.parse(exeReplay.stdout.trim()).outcome).toBe('PASSED');
        const exeFile = join(dir, 'exe-actions.ndjson');
        const again = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
          await again.command('Runtime.evaluate', {
            expression: 'document.querySelector("#second").contentDocument.querySelector("#same-frame").textContent = "same origin"'
          });
        } finally { again.close(); }
        const exeRecord = spawnSync(process.env.CDP_LIVE_EXE,
          ['click', '#in-frame', page.id, '--frame', '#second', '--wait-for-text', 'done', '--cdp-url', chrome.cdpUrl],
          { encoding: 'utf8', env: { ...env, CDP_RECORD_FILE: exeFile }, timeout: 30_000, windowsHide: true });
        expect(exeRecord.status, exeRecord.stdout + exeRecord.stderr).toBe(0);
        expect((JSON.parse(readFileSync(exeFile, 'utf8').trim()) as RecordedAction).argv).toContain('{{page}}');
        unlinkSync(exeFile);
      }
    } finally {
      try { unlinkSync(file); } catch { /* no journal */ }
      try { unlinkSync(join(dir, 'exe-actions.ndjson')); } catch { /* no exe journal */ }
      rmdirSync(dir);
    }
  }, 60_000);

  it('reports successful and failed fetches through their real CDP lifecycle events', async () => {
    const page = await chrome.createPage(`${app.baseUrl}/network.html`);
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const events: any[] = [];
    const collect = (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.method?.startsWith('Network.')) events.push(message);
    };
    session.ws.on('message', collect);
    try {
      await session.command('Network.enable');
      await session.command('Runtime.evaluate', { expression: 'runNetwork()', awaitPromise: true, returnByValue: true });
      await waitFor(() => {
        const sawOkFinish = events.some((event) => event.method === 'Network.loadingFinished' && event.params.requestId);
        const sawAbort = events.some((event) => event.method === 'Network.loadingFailed' && event.params.errorText);
        if (!sawOkFinish || !sawAbort) throw new Error('Network lifecycle has not completed');
      });
      const observed = await session.command('Runtime.evaluate', { expression: 'window.networkResult', returnByValue: true });
      expect(observed.result.value).toEqual({ ok: 'success', failed: 'rejected' });

      const requestedUrls = new Map<string, string>();
      for (const event of events.filter((entry) => entry.method === 'Network.requestWillBeSent')) {
        requestedUrls.set(event.params.requestId, event.params.request.url);
      }
      const successId = [...requestedUrls].find(([, url]) => url.endsWith('/network-ok'))?.[0];
      const failedId = [...requestedUrls].find(([, url]) => url.endsWith('/network-abort'))?.[0];
      expect(events.some((event) => event.method === 'Network.responseReceived' && event.params.requestId === successId)).toBe(true);
      expect(events.some((event) => event.method === 'Network.loadingFinished' && event.params.requestId === successId)).toBe(true);
      expect(events.some((event) => event.method === 'Network.loadingFailed' && event.params.requestId === failedId)).toBe(true);
    } finally {
      session.ws.off('message', collect);
      session.close();
    }
  });
});
