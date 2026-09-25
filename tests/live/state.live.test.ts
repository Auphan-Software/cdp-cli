import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CdpSession, LiveChrome, startFixture, type LiveFixture } from './harness.js';
import { StateStore } from '../../src/state/store.js';

const execFileAsync = promisify(execFile);
let chrome: LiveChrome;
let app: LiveFixture;
let cross: LiveFixture;
let root: string;

async function cli(...args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [resolve('build/index.js'), 'state', ...args, '--cdp-url', chrome.cdpUrl], {
    env: { ...process.env, CDP_STATE_ROOT: root, CDP_DAEMON_URL: '' }, maxBuffer: 1024 * 1024
  }).catch((error: { message?: string; stdout?: string; stderr?: string }) => {
    throw new Error(`${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
}

async function evaluate(pageUrl: string, expression: string): Promise<void> {
  const pages = await (await fetch(`${chrome.cdpUrl}/json`)).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
  const page = pages.find((p) => p.id === pageUrl)!;
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try { await session.command('Runtime.evaluate', { expression, returnByValue: true }); }
  finally { session.close(); }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-state-live-'));
  cross = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>cross</title><p>Cross origin</p>');
  }, '127.0.0.2');
  app = await startFixture((req, res) => {
    if (req.url?.startsWith('/delayed')) {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }, 1800);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url?.startsWith('/frame')) {
      res.end('<!doctype html><p id="inside">Frame old</p>');
      return;
    }
    res.end(`<!doctype html><title>State fixture</title>
      <input name="email" aria-label="Email" value="">
      <input name="price" aria-label="Price" value="4.50">
      <button data-testid="save" onclick="document.querySelector('#result').textContent='Saved 5.00'">Save</button>
      <p id="result">Saved 4.50</p>
      <button id="slow" onclick="fetch('/delayed').then(()=>document.querySelector('#slow-status').textContent='Done')">Slow</button>
      <p id="slow-status">Waiting</p>
      <div id="switch" role="switch" aria-checked="false">Toggle</div>
      <input id="action-input" type="button" value="Go">
      <div id="edit" contenteditable aria-label="Note">old private note</div>
      <div id="rich-edit" contenteditable aria-label="Rich note"><p>old nested private note</p></div>
      <details id="detail"><summary>More</summary><p>Detail body</p></details>
      <input type="radio" name="choice" value="a"><input type="radio" name="choice" value="b">
      <input type="radio" name="unvalued"><input type="radio" name="unvalued">
      <div id="shadow-host"></div><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<p id="shadow">Old shadow</p>'</script>
      <table><tr data-row-key="r1"><td><button data-testid="edit">Edit</button></td></tr>
        <tr data-row-key="r2"><td><button data-testid="edit">Edit</button></td></tr></table>
      <iframe id="same" src="/frame"></iframe><iframe id="cross" src="${cross.baseUrl}/cross"></iframe>`);
  });
  chrome = await LiveChrome.launch();
}, 30_000);

afterAll(async () => {
  await chrome?.close();
  await app?.close();
  await cross?.close();
  if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
}, 30_000);

describe('page state live Chrome', () => {
  it('captures, diffs, and evaluates text and masked input transitions', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const before = await cli('capture', page.id, '--name', 'before');
    expect(before.success).toBe(true);
    expect(before.value.elements).toBeGreaterThan(3);
    await evaluate(page.id, `document.querySelector('[name=email]').value='customer@example.test';document.querySelector('[name=price]').value='5.00';document.querySelector('[data-testid=save]').click()`);
    const after = await cli('capture', page.id, '--name', 'after');
    expect(after.success).toBe(true);
    const diff = await cli('diff', 'before', 'after', page.id);
    expect(diff.value.changed).toBe(true);
    expect(diff.value.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'field', key: 'top|id:result', field: 'text', from: 'Saved 4.50', to: 'Saved 5.00' }),
      expect.objectContaining({ kind: 'field', key: 'top|name:price', field: 'value' })
    ]));
    const captureJson = await readFile(after.value.path, 'utf8');
    expect(captureJson).not.toContain('customer@example.test');
    const spec = join(root, 'expect.json');
    await writeFile(spec, JSON.stringify({ mustChange: [{ key: 'top|id:result', field: 'text' }], mustNotChange: [{ key: 'top|testid:save', field: 'state.en' }] }));
    const verdict = await cli('expect', 'before', 'after', page.id, '--spec', spec);
    expect(verdict.value.outcome).toBe('UNKNOWN'); // cross-origin frame is explicit incomplete coverage
  });

  it('reports complete no-op and same-origin iframe changes when cross-origin frame is ignored', async () => {
    const page = await chrome.createPage(app.baseUrl);
    await cli('capture', page.id, '--name', 'first', '--ignore', '#cross');
    await cli('capture', page.id, '--name', 'second', '--ignore', '#cross');
    expect((await cli('diff', 'first', 'second', page.id)).value.changed).toBe(false);
    await evaluate(page.id, `document.querySelector('#same').contentDocument.querySelector('#inside').textContent='Frame new'`);
    await cli('capture', page.id, '--name', 'third', '--ignore', '#cross');
    const diff = await cli('diff', 'second', 'third', page.id);
    expect(diff.value.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'field', key: expect.stringContaining('id:inside'), field: 'text' })
    ]));
  });

  it('invalidates a name before a failed replacement capture', async () => {
    const page = await chrome.createPage(app.baseUrl);
    await cli('capture', page.id, '--name', 'stale');
    await expect(cli('capture', page.id, '--name', 'stale', '--frame', '#missing')).rejects.toThrow();
    await expect(cli('diff', 'stale', 'stale', page.id)).rejects.toThrow();
  });

  it('rejects an invalid ignore selector instead of silently hiding nothing', async () => {
    const page = await chrome.createPage(app.baseUrl);
    await expect(cli('capture', page.id, '--ignore', '[')).rejects.toThrow();
  });

  it('returns a useful diff from one click command', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const result = await cli('click', '[data-testid=save]', page.id, '--ignore=#cross', '--stability-ms=0');
    expect(result.type).toBe('state-diff');
    expect(result.value.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'field', key: 'top|id:result', field: 'text', to: 'Saved 5.00' })
    ]));
  });

  it('checks click specs before acting on the page', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const missing = join(root, 'missing-spec.json');
    await expect(cli('click', '[data-testid=save]', page.id, '--ignore=#cross', '--stability-ms=0', '--spec', missing)).rejects.toThrow();
    await expect(cli('click', '[data-testid=save]', page.id, '--ignore=#cross', '--stability-ms=0', '--exit-on-fail')).rejects.toThrow();
    const capture = await cli('capture', page.id, '--name', 'not-clicked', '--ignore=#cross', '--stability-ms=0');
    const saved = JSON.parse(await readFile(capture.value.path, 'utf8'));
    expect(saved.elements.find((element: { k: string }) => element.k === 'top|id:result')?.text).toBe('Saved 4.50');
  });

  it('checks literal input expectations without storing the raw value', async () => {
    const page = await chrome.createPage(app.baseUrl);
    await cli('capture', page.id, '--name', 'raw-before', '--ignore', '#cross', '--stability-ms=0');
    await evaluate(page.id, `document.querySelector('[name=price]').value='5.00'`);
    const after = await cli('capture', page.id, '--name', 'raw-after', '--ignore', '#cross', '--stability-ms=0');
    const spec = join(root, 'literal-expect.json');
    await writeFile(spec, JSON.stringify({ mustChange: [{ key: 'top|name:price', field: 'value', from: '4.50', to: '5.00' }] }));
    const verdict = await cli('expect', 'raw-before', 'raw-after', page.id, '--spec', spec);
    expect(verdict.value.outcome).toBe('PASSED');
    expect(await readFile(after.value.path, 'utf8')).not.toContain('5.00');
  });

  it('keeps sequences and aliases intact across parallel store processes', async () => {
    const moduleUrl = pathToFileURL(resolve('build/state/store.js')).href;
    const worker = `import { StateStore } from ${JSON.stringify(moduleUrl)};
      const store = new StateStore('http://fixture', undefined, 'parallel-target', process.env.CDP_STATE_ROOT);
      const name = 'parallel-' + process.argv[1];
      const state = { schema:'cdp-cli.page-state/1', name, capturedAt:new Date().toISOString(),
        targetId:'parallel-target', captureProfile:'test', url:'http://fixture', title:'Fixture', readyState:'complete',
        bodyTextHash:'same', nodeCount:0, elements:[], coverage:{truncated:false,unreachableFrames:[],blockedByDialog:false} };
      process.stdout.write(String(store.save(state).seq));`;
    const captures = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      execFileAsync(process.execPath, ['--input-type=module', '-e', worker, String(i)],
        { env: { ...process.env, CDP_STATE_ROOT: root } })));
    const seqs = captures.map(({ stdout }) => Number(stdout));
    expect(new Set(seqs).size).toBe(8);
    const listed = new StateStore('http://fixture', undefined, 'parallel-target', root).list();
    for (let i = 0; i < 8; i++) expect(listed.some((capture) => capture.name === `parallel-${i}`)).toBe(true);
  }, 30_000);

  it('bounds persisted captures and removes expired aliases', () => {
    const store = new StateStore('http://fixture', undefined, 'retention-target', root, 2);
    for (let i = 0; i < 3; i++) store.save({ schema: 'cdp-cli.page-state/1', name: `retained-${i}`,
      capturedAt: new Date().toISOString(), targetId: 'retention-target', captureProfile: 'test', url: 'http://fixture',
      title: 'Fixture', readyState: 'complete', bodyTextHash: 'same', nodeCount: 0, elements: [],
      coverage: { truncated: false, unreachableFrames: [], blockedByDialog: false } });
    expect(store.list().map((capture) => capture.name)).toEqual(['retained-1', 'retained-2']);
    expect(() => store.load('retained-0')).toThrow('STATE_NOT_FOUND');
  });

  it('captures custom, native, radio, shadow, and editable state without raw note text', async () => {
    const page = await chrome.createPage(app.baseUrl);
    await cli('capture', page.id, '--name', 'controls-before', '--ignore', '#cross', '--stability-ms=0');
    await evaluate(page.id, `document.querySelector('#switch').setAttribute('aria-checked','true');
      document.querySelector('#action-input').value='Proceed';
      document.querySelector('#edit').innerText='new private note';
      document.querySelector('#rich-edit p').innerText='new nested private note';
      document.querySelector('#detail').open=true;
      document.querySelector('[name=choice][value=a]').checked=true;
      document.querySelectorAll('[name=unvalued]')[1].checked=true;
      document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow').textContent='New shadow'`);
    const after = await cli('capture', page.id, '--name', 'controls-after', '--ignore', '#cross', '--stability-ms=0');
    const delta = await cli('diff', 'controls-before', 'controls-after', page.id);
    const changes = delta.value.changes;
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'top|id:switch', field: 'state.ariaChecked', from: false, to: true }),
      expect.objectContaining({ key: 'top|id:action-input', field: 'name', from: 'Go', to: 'Proceed' }),
      expect.objectContaining({ key: 'top|id:edit', field: 'value' }),
      expect.objectContaining({ key: 'top|id:detail', field: 'state.open', from: false, to: true }),
      expect.objectContaining({ key: expect.stringContaining('id:shadow'), field: 'text', to: 'New shadow' }),
      expect.objectContaining({ key: 'top|name:choice>radio:a', field: 'state.checked', from: false, to: true })
    ]));
    expect(after.value.coverage.ambiguousKeys).toEqual([]);
    const persisted = await readFile(after.value.path, 'utf8');
    expect(persisted).not.toContain('new private note');
    expect(persisted).not.toContain('new nested private note');
    expect(changes.some((change: { field?: string; key?: string }) =>
      change.field === 'state.checked' && change.key?.includes('name:unvalued>radio:'))).toBe(true);
  });

  it('waits for an in-flight action before deciding the resulting state', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const delta = await cli('click', '#slow', page.id, '--ignore=#cross', '--stability-ms=0');
    expect(delta.value.action.clickDelivered).toBe(true);
    expect(delta.value.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'top|id:slow-status', field: 'text', from: 'Waiting', to: 'Done' })
    ]));
  }, 20_000);

  it('lets a one-call expectation fail a shell gate while keeping the final verdict line', async () => {
    const page = await chrome.createPage(app.baseUrl);
    const spec = join(root, 'click-fail.json');
    await writeFile(spec, JSON.stringify({ mustChange: [{ key: 'top|id:result', field: 'text', to: 'Never' }] }));
    let failure: { stdout?: string } | undefined;
    try {
      await execFileAsync(process.execPath, [resolve('build/index.js'), 'state', 'click', '[data-testid=save]', page.id,
        '--ignore=#cross', '--stability-ms=0', '--spec', spec, '--exit-on-fail', '--cdp-url', chrome.cdpUrl],
      { env: { ...process.env, CDP_STATE_ROOT: root, CDP_DAEMON_URL: '' }, maxBuffer: 1024 * 1024 });
    } catch (error) { failure = error as { stdout?: string }; }
    expect(failure).toBeDefined();
    const lines = failure!.stdout!.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).value.outcome).toBe('FAILED');
  }, 20_000);
});
