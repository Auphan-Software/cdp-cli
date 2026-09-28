import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LiveChrome, startFixture, type LiveFixture } from './harness.js';

const execFileAsync = promisify(execFile);
const cases = [
  { name: 'noop', changed: false, expected: [] },
  { name: 'total', changed: true, expected: ['top|id:count:text'] },
  { name: 'dialog', changed: false, expected: [] },
  { name: 'visual', changed: false, expected: [] },
  { name: 'clean', changed: true, expected: ['top|id:count:text', 'top|id:total:text'] },
  { name: 'idempotent', changed: true, expected: ['top|id:status:text'] },
  { name: 'frame', changed: false, expected: [] }
];

let chrome: LiveChrome;
let fixture: LiveFixture;
let root: string;
const observations: Array<Record<string, unknown>> = [];

async function cli(...args: string[]): Promise<any> {
  const start = performance.now();
  const { stdout } = await execFileAsync(process.execPath, [resolve('build/index.js'), 'state', ...args, '--cdp-url', chrome.cdpUrl], {
    env: { ...process.env, CDP_STATE_ROOT: root, CDP_DAEMON_URL: '' }, maxBuffer: 1024 * 1024
  });
  const lines = stdout.trim().split(/\r?\n/);
  return { output: JSON.parse(lines.at(-1)!), lines: lines.length,
    bytes: Buffer.byteLength(stdout), ms: Math.round(performance.now() - start) };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cdp-state-eval-'));
  const html = await readFile(resolve('evals/state-diff/fixtures/qa-agent.html'), 'utf8');
  fixture = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  chrome = await LiveChrome.launch();
}, 30_000);

afterAll(async () => {
  const target = process.env.CDP_STATE_EVAL_METRICS;
  if (target) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ schema: 1, cases: observations }, null, 2));
  }
  await chrome?.close();
  await fixture?.close();
  if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
}, 30_000);

describe('state diff QA fixture', () => {
  for (const row of cases) {
    it(`${row.name} has the expected bounded diff across three runs`, async () => {
      const signatures: string[] = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const page = await chrome.createPage(`${fixture.baseUrl}/?case=${row.name}`);
        const run = await cli('click', '[data-testid=action]', page.id, '--stability-ms=0');
        const diff = run.output.value;
        expect(run.output.type).toBe('state-diff');
        expect(run.lines).toBe(1);
        expect(diff.changed).toBe(row.changed);
        expect(diff.coverage.truncated).toBe(false);
        expect(diff.coverage.unreachableFrames).toEqual([]);
        const actual = diff.changes.map((change: any) => `${change.key}:${change.field}`).sort();
        expect(actual).toEqual(row.expected);
        signatures.push(JSON.stringify({ changed: diff.changed, changes: diff.changes }));
        observations.push({ case: row.name, repeat, changed: diff.changed, changes: diff.changes,
          bytes: run.bytes, ms: run.ms });
      }
      expect(new Set(signatures).size).toBe(1);
    }, 45_000);
  }
});
