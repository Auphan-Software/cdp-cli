import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CdpSession, LiveChrome, waitFor } from './harness.js';

const execFileAsync = promisify(execFile);
const base = process.env.CDP_MAKO2_EVAL_URL;
let chrome: LiveChrome;
let stateRoot: string;

async function run(page: string, ...args: string[]): Promise<{ output: any; bytes: number; ms: number }> {
  const start = performance.now();
  const [operation, ...rest] = args;
  const command = operation === 'diff' || operation === 'expect'
    ? ['state', operation, rest[0], rest[1], page, ...rest.slice(2)]
    : ['state', operation, page, ...rest];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [resolve('build/index.js'), ...command, '--cdp-url', chrome.cdpUrl], {
      env: { ...process.env, CDP_STATE_ROOT: stateRoot, CDP_DAEMON_URL: '' }, maxBuffer: 1024 * 1024
    }));
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${(error as { stdout?: string }).stdout ?? ''}`);
  }
  return { output: JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!), bytes: Buffer.byteLength(stdout),
    ms: Math.round(performance.now() - start) };
}

beforeAll(async () => {
  if (!base) return;
  stateRoot = await mkdtemp(join(tmpdir(), 'cdp-mako2-state-'));
  chrome = await LiveChrome.launch();
}, 30_000);

afterAll(async () => {
  await chrome?.close();
  if (stateRoot?.startsWith(tmpdir())) await rm(stateRoot, { recursive: true, force: true });
}, 30_000);

it.skipIf(!base)('captures quiet, booted Mako2 pages in a disposable worktree', async () => {
  const metrics: unknown[] = [];
  const journeys = [
    ['spa', 'management/preset_notes.php?lang_id=1'],
    ['engine2', 'management/engine2.php?lang_id=1&title=customer_programs&url=mgmt.customers'],
    ['foh', 'tables.php']
  ];
  for (const [name, route] of journeys) {
    const url = `${base}index.php?test_scenario=admin&_cb=${Date.now()}#s:login.php?lang_id=1,${route}`;
    const page = await chrome.createPage(url);
    await waitFor(async () => {
      const session = await CdpSession.connect(page.webSocketDebuggerUrl);
      try {
        const probe = await session.command('Runtime.evaluate', {
          expression: `({jquery:typeof window.jQuery === 'function',nav:typeof top.navAuto !== 'undefined',frame:!!document.querySelector('#page-engine2-iframe')})`,
          returnByValue: true
        });
        const value = probe.result.value;
        if (!value.jquery || !value.nav || (name === 'engine2' && !value.frame)) throw new Error(`SPA not booted: ${JSON.stringify(value)}`);
        return value;
      } finally { session.close(); }
    }, 25_000);
    const ignore = ['--ignore=#nav-disconnected', '--ignore=#nav-gateway-expired', '--ignore=.nav-clock'];
    let before = await run(page.id, 'capture', '--name', `${name}-before`, ...ignore);
    let after = await run(page.id, 'capture', '--name', `${name}-after`, ...ignore);
    let delta = await run(page.id, 'diff', `${name}-before`, `${name}-after`, '--max-changes=200');
    // A booted SPA can still be painting. An incomplete no-op is an honest
    // UNKNOWN; take a fresh pair after it settles instead of treating it as quiet.
    const firstChanged = delta.output.value.changed;
    if (firstChanged === null) {
      before = await run(page.id, 'capture', '--name', `${name}-before-retry`, ...ignore);
      after = await run(page.id, 'capture', '--name', `${name}-after-retry`, ...ignore);
      delta = await run(page.id, 'diff', `${name}-before-retry`, `${name}-after-retry`, '--max-changes=200');
    }
    const snapshot = await execFileAsync(process.execPath,
      [resolve('build/index.js'), 'snapshot', page.id, '--format', 'text', '--cdp-url', chrome.cdpUrl],
      { env: { ...process.env, CDP_DAEMON_URL: '' }, maxBuffer: 10 * 1024 * 1024 });
    const frameSnapshot = name === 'engine2' ? await execFileAsync(process.execPath,
      [resolve('build/index.js'), 'snapshot', page.id, '--format', 'text', '--frame', '#page-engine2-iframe', '--cdp-url', chrome.cdpUrl],
      { env: { ...process.env, CDP_DAEMON_URL: '' }, maxBuffer: 10 * 1024 * 1024 }) : undefined;
    metrics.push({ name, beforeMs: before.ms, afterMs: after.ms, elements: after.output.value.elements,
      captureBytes: statSync(after.output.value.path).size, captureOutputBytes: after.bytes,
      diffOutputBytes: delta.bytes, snapshotTextBytes: Buffer.byteLength(snapshot.stdout),
      frameSnapshotTextBytes: frameSnapshot ? Buffer.byteLength(frameSnapshot.stdout) : undefined,
      coverage: after.output.value.coverage, firstChanged, changed: delta.output.value.changed, changes: delta.output.value.changes });
    expect(before.output.success).toBe(true);
    expect(after.output.success).toBe(true);
    expect(after.output.value.elements).toBeGreaterThan(name === 'foh' ? 30 : 100);
    expect(delta.output.value.changed, `${name} no-op should produce an empty diff: ${JSON.stringify(delta.output.value)}`).toBe(false);
  }
  if (process.env.CDP_MAKO2_METRICS) writeFileSync(process.env.CDP_MAKO2_METRICS, JSON.stringify(metrics, null, 2));
}, 120_000);
