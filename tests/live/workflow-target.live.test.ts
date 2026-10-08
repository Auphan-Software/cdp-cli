import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveChrome, startFixture, CdpSession, waitFor, type LiveFixture, type CdpPage } from './harness.js';

const exec = promisify(execFile);
let chrome: LiveChrome, app: LiveFixture, root: string;
async function cli(operation: string, page: string, args: string[] = []) {
  const { stdout } = await exec(process.execPath, [resolve('build/index.js'), 'workflow', operation, page,
    '--task', 'inspect controls', '--cdp-url', chrome.cdpUrl, '--stability-ms', '20', ...args], {
    env: { ...process.env, CDP_STATE_ROOT: root, CDP_SESSION: '', CDP_DAEMON_URL: '', CDP_RERANK_URL: 'off', CDP_WORKFLOW_CLOCK_SELECTORS: '[]' },
    maxBuffer: 8 * 1024 * 1024
  }).catch(error => ({ stdout: (error as { stdout: string }).stdout }));
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
}
async function evaluate(page: CdpPage, expression: string) {
  const socket = await CdpSession.connect(page.webSocketDebuggerUrl);
  try { return (await socket.command('Runtime.evaluate', { expression, returnByValue: true })).result.value; }
  finally { socket.close(); }
}
const act = (page: string, source: any, key: string, action = 'click', extra: string[] = []) => cli('act', page,
  ['--source', source.value.view.source.id, '--action', action, '--target-key', key, ...extra]);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-workflow-target-'));
  app = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url?.startsWith('/frame')) {
      res.end('<button id="inside" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>');
      return;
    }
    res.end(`<!doctype html><title>Key controls</title><h1>Controls</h1>
      <section id="rows"><div data-row-key="A"><button onclick="this.textContent='A clicked'">Same</button></div>
      <div data-row-key="B"><button onclick="this.textContent='B clicked'">Same</button></div></section>
      <input id="name" value="old"><select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <button id="duplicate" onclick="this.textContent='bad'">Duplicate</button><button id="duplicate">Duplicate</button>
      <button data-testid="duplicate-test">Test duplicate</button><button data-testid="duplicate-test">Test duplicate</button>
      <button id="disabled" disabled>Disabled</button><button id="hidden" hidden>Hidden</button>
      <div class="depth1"><div><div><div><div><div><div><div><button id="deep" onclick="this.textContent='delivered'">Deep</button></div></div></div></div></div></div></div></div>
      <iframe id="embedded" src="/frame"></iframe><div id="shadow"></div>
      <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow button</button>';</script>`);
  });
  chrome = await LiveChrome.launch();
}, 30000);
afterAll(async () => {
  await chrome?.close(); await app?.close();
  if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
}, 30000);

describe('source-bound target keys through the deployed CLI', () => {
  it('clicks the correct repeated weak-key control, fills and selects through returned keys', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const observed = await cli('observe', page.id, ['--full']);
    expect(observed.success, JSON.stringify(observed)).toBe(true);
    expect(JSON.stringify(observed.value.view)).not.toContain('locator');
    const buttons = observed.value.view.elements.filter((element: any) => element.name === 'Same');
    expect(buttons).toHaveLength(2);
    expect(buttons.every((element: any) => element.kq === 'weak')).toBe(true);
    const key = buttons.find((element: any) => element.k.includes('row:B>')).k;
    const canonical = JSON.parse(await readFile(observed.value.canonicalPath, 'utf8'));
    expect(canonical.elements.find((element: any) => element.k === key).locator).toContain('nth-of-type');
    const clicked = await act(page.id, observed, key);
    expect(clicked.value.action.commandSucceeded, JSON.stringify(clicked)).toBe(true);
    expect(clicked.value.action.targetKey).toBe(key);
    expect(await evaluate(page, "[...document.querySelectorAll('#rows button')].map(e=>e.textContent)")).toEqual(['Same', 'B clicked']);
    const filled = await act(page.id, clicked, 'top|id:name', 'fill', ['--value', 'replacement']);
    expect(filled.value.action.commandSucceeded, JSON.stringify(filled)).toBe(true);
    const selected = await act(page.id, filled, 'top|id:choice', 'select', ['--value', 'b']);
    expect(selected.value.action.commandSucceeded, JSON.stringify(selected)).toBe(true);
    expect(await evaluate(page, "({name:document.querySelector('#name').value,choice:document.querySelector('#choice').value})")).toEqual({ name: 'replacement', choice: 'b' });
    const expanded = await cli('expand', page.id, ['--source', selected.value.view.source.id]);
    expect(JSON.stringify(expanded.value.state)).not.toContain('locator');
  }, 30000);

  it('rejects unknown, ambiguous, disabled, hidden and unsupported keys before interaction', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const observed = await cli('observe', page.id, ['--full']);
    const cases: Array<[string, string]> = [ ['missing', 'UNKNOWN_OR_AMBIGUOUS'], ['top|id:disabled', 'UNAVAILABLE'], ['top|id:hidden', 'UNAVAILABLE'] ];
    for (const label of ['Duplicate', 'Test duplicate']) {
      const nodes = observed.value.view.elements.filter((element: any) => element.name === label);
      expect(nodes).toHaveLength(2);
      expect(nodes.every((element: any) => element.kq === 'ambiguous')).toBe(true);
      cases.push([nodes[0].k, 'UNKNOWN_OR_AMBIGUOUS']);
    }
    const nested = observed.value.view.elements.find((element: any) => element.k.includes('/frame:') && element.name === '0');
    const shadow = observed.value.view.elements.find((element: any) => element.name === 'Shadow button');
    expect(nested).toBeDefined(); expect(shadow).toBeDefined();
    cases.push([nested.k, 'UNSUPPORTED'], [shadow.k, 'UNSUPPORTED']);
    for (const [key, code] of cases) {
      const rejected = await act(page.id, observed, key);
      if (code === 'UNAVAILABLE') {
        expect(rejected.success).toBe(false);
        expect(rejected.type).toBe('workflow-target-rejection');
        expect(rejected.value.action).toMatchObject({ code: 'WORKFLOW_TARGET_KEY_UNAVAILABLE', actionDelivered: false, commandSucceeded: false, deliveryUnknown: false });
        expect(rejected.value.view.source.id).not.toBe(observed.value.view.source.id);
        expect(rejected.value.output.profile).toBe('current-24k');
        continue;
      }
      expect(rejected.message, JSON.stringify(rejected)).toContain(`WORKFLOW_TARGET_KEY_${code}`);
      expect(rejected.message).toContain('no action delivered');
    }
    const conflict = await act(page.id, observed, 'top|id:name', 'click', ['--selector', '#name']);
    expect(conflict.message).toContain('TARGET_CONFLICT');
    const unsupportedAction = await act(page.id, observed, 'top|id:name', 'press-key', ['--key', 'Enter']);
    expect(unsupportedAction.message).toContain('ACTION_UNSUPPORTED');
    expect(await evaluate(page, "document.querySelector('#name').value")).toBe('old');
    expect(await evaluate(page, "[...document.querySelectorAll('#rows button')].map(e=>e.textContent)")).toEqual(['Same', 'Same']);
  }, 30000);

  it('rejects locator drift from uncaptured markup, even when target key and body text stay the same', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const observed = await cli('observe', page.id);
    const before = JSON.parse(await readFile(observed.value.canonicalPath, 'utf8'));
    await evaluate(page, "document.querySelector('.depth1').before(document.createElement('div'))");
    const rejected = await act(page.id, observed, 'top|id:deep');
    expect(rejected.value.action.code, JSON.stringify(rejected)).toBe('WORKFLOW_STALE_SOURCE');
    expect(rejected.value.action.actionDelivered).toBe(false);
    const after = JSON.parse(await readFile(rejected.value.canonicalPath, 'utf8'));
    expect(after.bodyTextHash).toBe(before.bodyTextHash);
    expect(after.elements.map((element: any) => element.k)).toEqual(before.elements.map((element: any) => element.k));
    expect(after.elements.find((element: any) => element.k === 'top|id:deep').locator).not.toBe(before.elements.find((element: any) => element.k === 'top|id:deep').locator);
    expect(await evaluate(page, "document.querySelector('#deep').textContent")).toBe('Deep');
    const recovered = await act(page.id, rejected, 'top|id:deep');
    expect(recovered.value.action.commandSucceeded, JSON.stringify(recovered)).toBe(true);
  }, 20000);

  it('inherits an explicitly observed same-origin iframe but rejects an explicit top-frame override', async () => {
    const page = await chrome.createPage(app.baseUrl);
    await waitFor(async () => { if (!await evaluate(page, "!!document.querySelector('#embedded').contentDocument?.querySelector('#inside')")) throw new Error('Frame loading'); }, 5000);
    const observed = await cli('observe', page.id, ['--frame', '#embedded']);
    const key = observed.value.view.elements.find((element: any) => element.name === '0').k;
    const mismatch = await act(page.id, observed, key, 'click', ['--frame', '0']);
    expect(mismatch.message).toContain('CAPTURE_PROFILE_MISMATCH');
    const clicked = await act(page.id, observed, key);
    expect(clicked.value.action.commandSucceeded, JSON.stringify(clicked)).toBe(true);
    expect(await evaluate(page, "document.querySelector('#embedded').contentDocument.querySelector('#inside').textContent")).toBe('1');
    await evaluate(page, "document.querySelector('#embedded').after(document.querySelector('#embedded').cloneNode())");
    const ambiguous = await act(page.id, clicked, key);
    expect(ambiguous.message, JSON.stringify(ambiguous)).toContain('WORKFLOW_OBSERVATION_FAILED');
    expect(await evaluate(page, "document.querySelector('#embedded').contentDocument.querySelector('#inside').textContent")).toBe('1');
  }, 20000);

  it('keeps a delivered fractional-coordinate click when its handler removes the target and navigates the SPA', async () => {
    const page = await chrome.createPage(app.baseUrl);
    await evaluate(page, `document.body.insertAdjacentHTML('beforeend','<button id="counter-plus" style="position:fixed;left:279px;top:315px;width:141px;height:19px;padding:0;border:0">+</button>');
      document.querySelector('#counter-plus').addEventListener('mousedown', () => {
        window.createdInvoices=(window.createdInvoices||0)+1;
        document.querySelector('#counter-plus').remove();
        location.hash='invoice';
      });`);
    const observed = await cli('observe', page.id);
    const clicked = await act(page.id, observed, 'top|id:counter-plus');
    expect(clicked.value.action.commandSucceeded, JSON.stringify(clicked)).toBe(true);
    expect(clicked.value.action.evidence[0].data.clickDelivered).toBe(true);
    expect(await evaluate(page, 'window.createdInvoices')).toBe(1);
    expect(clicked.value.view.url).toContain('#invoice');
  }, 20000);
});
