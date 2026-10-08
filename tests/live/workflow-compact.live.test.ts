import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, type LiveFixture } from './harness.js';
const exec = promisify(execFile);
let chrome: LiveChrome, app: LiveFixture, root: string;
const call = async (operation: string, page: string, args: string[] = []) => {
  const command = [resolve('build/index.js'), 'workflow', operation, page, '--task', 'Complete invoice', '--cdp-url', chrome.cdpUrl, '--stability-ms', '20', ...args];
  let stdout: string;
  try { ({ stdout } = await exec(process.execPath, command, { env: { ...process.env, CDP_STATE_ROOT: root,
    CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact', CDP_WORKFLOW_CLOCK_SELECTORS: '[".clock"]', CDP_RERANK_URL: 'off', CDP_DAEMON_URL: '', CDP_SESSION: '' }, maxBuffer: 2e6 })); }
  catch (e) { stdout = (e as any).stdout; }
  const rows = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const result = rows.at(-1);
  if (result.error) result.commandRows = rows.slice(0, -1);
  return result;
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'compact-live-'));
  app = await startFixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>Invoice</title>
    <div class="clock">Thursday, Oct 08, 26 12:02 pm</div><button id="cash" onclick="window.dispatches=(window.dispatches||0)+1; document.getElementById('result').textContent='Paid';">Cash</button>
    <button id="card">Card</button><p id="result">Waiting</p><input value="private-value"><div role="alert">Account frozen</div>`); });
  chrome = await LiveChrome.launch();
}, 30000);
afterAll(async () => { await chrome?.close(); await app?.close(); if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true }); }, 30000);
describe('compact live execution', () => {
  it('retains DOM-owned icon-only sibling controls in a focused editor view and dispatches once', async () => {
    const page = await chrome.createPage(app.baseUrl);
    let socket = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const markup = `<div id="note-editor"><input placeholder="Notes"><button id="note-cancel"></button><button id="note-confirm" onclick="window.noteDispatches=(window.noteDispatches||0)+1;document.getElementById('result').textContent='Notes confirmed'"></button></div><div id="note-editor"><input placeholder="Customer"><button>Other editor</button></div>`;
      const setup = await socket.command('Runtime.evaluate', { expression: `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(markup)})` });
      expect(setup.exceptionDetails).toBeUndefined();
      socket.close();
      const seen = await call('observe', page.id, ['--query', 'Notes']);
      expect(seen.success, JSON.stringify(seen)).toBe(true);
      expect(seen.value.view.scope.editorControlsRetained).toBe(2);
      const controls = seen.value.view.elements.filter((n: any) => n.role === 'button');
      expect(controls).toHaveLength(2);
      expect(controls.every((n: any) => !n.name)).toBe(true);
      expect(seen.value.view.elements.some((n: any) => n.name === 'Cash')).toBe(false);
      const confirmed = await call('act', page.id, ['--source', seen.value.view.source.id,
        '--action', 'click', '--target-key', controls[1].k, '--query', 'Notes']);
      expect(confirmed.value.action.commandSucceeded, JSON.stringify(confirmed)).toBe(true);
      socket = await CdpSession.connect(page.webSocketDebuggerUrl);
      expect((await socket.command('Runtime.evaluate', { expression: 'window.noteDispatches', returnByValue: true })).result.value).toBe(1);
      expect((await socket.command('Runtime.evaluate', { expression: 'document.getElementById("result").textContent', returnByValue: true })).result.value).toBe('Notes confirmed');
    } finally { socket.close(); }
  });
  it('retains original same-capture pixels and CSS dimensions while transporting a scaled copy', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const seen = await call('screenshot', page.id, ['--screenshot-scale', '0.25', '--query', 'Cash|Account']);
    const shot = seen.value.screenshot;
    expect(shot.available, JSON.stringify(seen)).toBe(true);
    expect(shot.semanticStable).toBe(true);
    expect(shot.pixelWidth).toBe(Math.round(shot.originalPixelWidth * 0.25));
    expect(shot.pixelHeight).toBe(Math.round(shot.originalPixelHeight * 0.25));
    expect(shot.coordinateFrame.width).toBeGreaterThan(0);
    expect(shot.coordinateFrame.height).toBeGreaterThan(0);
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(shot.originalPath), scaled = await readFile(shot.path);
    expect(original.readUInt32BE(16)).toBe(shot.originalPixelWidth);
    expect(scaled.readUInt32BE(16)).toBe(shot.pixelWidth);
    expect(original.equals(scaled)).toBe(false);
    const invalid = await call('act', page.id, ['--source', seen.value.view.source.id, '--action', 'click', '--selector', '#cash', '--screenshot-scale', '0']);
    expect(invalid.error).toBe(true);
    const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
    try { expect((await socket.command('Runtime.evaluate', { expression: 'window.dispatches||0', returnByValue: true })).result.value).toBe(0); }
    finally { socket.close(); }
  }, 30000);
  it('finds the actual nested child action and scopes post-action state without relaxing canonical freshness', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const evaluate = async (expression: string) => {
      const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
      try {
        const result = await socket.command('Runtime.evaluate', { expression, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      } finally { socket.close(); }
    };
    const markup = `<div id="counter" role="button">COUNTER <button id="add" onclick="window.dispatches=(window.dispatches||0)+1;document.getElementById('result').textContent='Added'">+</button></div>`;
    await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(markup)})`);
    const seen = await call('observe', page.id, ['--query', 'Counter']);
    expect(seen.success, JSON.stringify(seen)).toBe(true);
    const plus = seen.value.view.elements.find((n: any) => n.name === '+');
    expect(plus).toBeDefined();
    expect(seen.value.view.elements.some((n: any) => n.name === 'Card')).toBe(false);
    expect(seen.value.view.elements.some((n: any) => n.name === 'Account frozen')).toBe(true);
    expect(seen.value.view.scope.excludedElements).toBeGreaterThan(0);
    const added = await call('act', page.id, ['--source', seen.value.view.source.id, '--action', 'click', '--target-key', plus.k, '--query', 'Added|Cash']);
    expect(added.value.action.commandSucceeded, JSON.stringify(added)).toBe(true);
    expect(added.value.view.elements.some((n: any) => n.text === 'Added')).toBe(true);
    expect(await evaluate('window.dispatches')).toBe(1);
    // A change outside the requested scope still blocks an action.
    await evaluate(`document.querySelector('#card').textContent='Different account'`);
    const cash = added.value.view.elements.find((n: any) => n.name === 'Cash');
    const refused = await call('act', page.id, ['--source', added.value.view.source.id, '--action', 'click', '--target-key', cash.k, '--query', 'Paid']);
    expect(refused.value.action.actionDelivered).toBe(false);
    expect(await evaluate('window.dispatches')).toBe(1);
  }, 30000);
  it('uses short refs after clock tick, recovers receipts and refuses removed targets without another dispatch', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const evaluate = async (expression: string) => {
      const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
      try { return (await socket.command('Runtime.evaluate', { expression, returnByValue: true })).result.value; } finally { socket.close(); }
    };
    try {
      const seen = await call('observe', page.id);
      expect(seen.success, JSON.stringify(seen)).toBe(true);
      const ref = seen.value.view.elements.find((n: any) => n.name === 'Cash').k;
      expect(seen.value.view.representation).toBe('source-refs/1');
      expect(JSON.stringify(seen)).not.toContain('private-value');
      await evaluate(`document.querySelector('.clock').textContent='Thursday, Oct 08, 26 12:03 pm'`);
      const paid = await call('act', page.id, ['--source', seen.value.view.source.id, '--action', 'click', '--target-key', ref]);
      expect(paid.value.action.commandSucceeded, JSON.stringify(paid)).toBe(true);
      expect(paid.value.view.elements.some((n: any) => n.text === 'Paid')).toBe(true);
      expect(paid.value.view.elements.some((n: any) => n.name === 'Account frozen')).toBe(true);
      const receipt = await call('expand', page.id, ['--source', paid.value.view.source.id, '--section', 'receipt']);
      expect(receipt.value.records[0].action.evidence.length).toBeGreaterThan(0);
      expect(await evaluate('window.dispatches')).toBe(1);
      await evaluate(`document.getElementById('cash').remove()`);
      const fresh = await call('observe', page.id);
      const removed = await call('act', page.id, ['--source', fresh.value.view.source.id, '--action', 'click', '--target-key', ref]);
      expect(removed.error).toBe(true);
      expect(await evaluate('window.dispatches')).toBe(1);
      // Source id alone is not a retained view: a fresh observe restores context.
      const reset = await call('observe', page.id);
      expect(reset.value.view.elements.some((n: any) => n.name === 'Card')).toBe(true);
    } finally { /* The harness owns this page and its cleanup. */ }
  }, 30000);
  it('does not classify countdown/business prefixes, duplicate clocks or editable/live/action ancestry as cosmetic', async () => {
    const page = await chrome.createPage(app.baseUrl);
    try {
      for (const mutation of [
        `document.querySelector('.clock').textContent='Due 12:02'`,
        `document.querySelector('.clock').textContent='ETA 12:02 pm'`,
        `document.querySelector('.clock').textContent='Thursday, Oct 08, 26 12:02 pm';document.querySelector('.clock').setAttribute('aria-live','polite')`,
        `document.querySelector('.clock').removeAttribute('aria-live');document.querySelector('.clock').setAttribute('contenteditable','true')`,
        `document.querySelector('.clock').removeAttribute('contenteditable');document.getElementById('cash').appendChild(document.querySelector('.clock'))`,
        `document.body.appendChild(document.querySelector('.clock'));document.body.insertAdjacentHTML('beforeend','<div class="clock">12:02</div>')`
      ]) {
        const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
        try { await socket.command('Runtime.evaluate', { expression: mutation }); } finally { socket.close(); }
        const capture = await call('observe', page.id);
        expect(capture.success, JSON.stringify(capture)).toBe(true);
        const recovered = await call('expand', page.id, ['--source', capture.value.view.source.id, '--section', 'elements']);
        const { readFile } = await import('node:fs/promises');
        const canonical = JSON.parse(await readFile(recovered.value.canonicalPath, 'utf8'));
        expect(canonical.elements.some((n: any) => n.cosmeticClock), mutation).toBe(false);
      }
    } finally { /* The harness owns this page and its cleanup. */ }
  }, 30000);
});
