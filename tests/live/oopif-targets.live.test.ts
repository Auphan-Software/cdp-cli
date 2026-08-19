import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { LiveChrome, startFixture, type LiveFixture } from './harness.js';

let chrome: LiveChrome;
let app: LiveFixture;
let paymentHost: LiveFixture;
const execFileAsync = promisify(execFile);
const builtCli = resolve(process.cwd(), 'build', 'index.js');

interface CliRun {
  records: any[];
  stdout: string;
}

async function runCli(...args: string[]): Promise<CliRun> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [builtCli, ...args, '--cdp-url', chrome.cdpUrl],
    {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    }
  );
  expect(stderr.trim()).toBe('');
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  expect(lines.length).toBeGreaterThan(0);
  const records = lines.map((line) => {
    const record = JSON.parse(line);
    expect(record).toBeTypeOf('object');
    expect(record).not.toBeNull();
    return record;
  });
  return { records, stdout };
}

function oneSuccess(run: CliRun): any {
  expect(run.records).toHaveLength(1);
  expect(run.records[0]).toMatchObject({ success: true });
  expect(run.records[0].error).not.toBe(true);
  return run.records[0].data;
}

beforeAll(async () => {
  paymentHost = await startFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>hosted field</title>
      <input id="card" autocomplete="cc-number">
      <script>
        document.body.dataset.nonce = 'child-0';
        document.querySelector('#card').addEventListener('input', () => {
          const current = Number(document.body.dataset.nonce.split('-')[1]);
          document.body.dataset.nonce = 'child-' + (current + 1);
        });
      </script>`);
  }, '127.0.0.2');

  app = await startFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>payment checkout</title>
      <input id="card" value="parent-decoy">
      <iframe id="hosted-payment" src="${paymentHost.baseUrl}/field.html?session=child-secret#card"></iframe>
      <script>
        document.body.dataset.nonce = 'parent-0';
        document.querySelector('#card').addEventListener('input', () => {
          document.body.dataset.nonce = 'parent-changed';
        });
      </script>`);
  });
  chrome = await LiveChrome.launch();
}, 30_000);

afterAll(async () => {
  await chrome?.close();
  await Promise.all([app?.close(), paymentHost?.close()]);
  expect(chrome.status()).toEqual({ chromeStopped: true, profileRemoved: true });
}, 30_000);

describe('browser-target OOPIF operations', () => {
  it('drives a hosted field through separate built CLI processes without touching the parent decoy', async () => {
    const page = await chrome.createPage(
      `${app.baseUrl}/checkout.html?session=parent-secret#payment`
    );

    const targetRun = await runCli('targets');
    const targets = targetRun.records;
    const pageTopology = targets.find((target) => target.targetId === page.id);
    const childTopology = targets.find((target) => target.type === 'iframe');
    expect(pageTopology).toBeDefined();
    expect(childTopology).toBeDefined();
    expect(pageTopology?.url).not.toMatch(/[?#]/);
    expect(childTopology?.url).not.toMatch(/[?#]/);
    expect(targetRun.stdout).not.toContain('secret');

    const mapped = oneSuccess(await runCli(
      'target-frame',
      page.id,
      '#hosted-payment'
    ));
    expect(mapped.target).not.toBeNull();
    expect(mapped.target?.targetId).toBe(mapped.frameId);
    expect(mapped.target?.type).toBe('iframe');

    const childTargetId = mapped.target.targetId as string;
    const fillRun = await runCli(
      'target-fill',
      '#card',
      '4242',
      childTargetId
    );
    const filled = oneSuccess(fillRun);
    expect(fillRun.stdout).not.toContain('4242');
    expect(filled).toMatchObject({
      requestedValueLength: 4,
      actualValueLength: 4,
      valueRedacted: true
    });
    expect(filled.valueApplied).toBe(true);
    const queryRun = await runCli('target-query', '#card', childTargetId);
    const queried = oneSuccess(queryRun);
    expect(queryRun.stdout).not.toContain('4242');
    expect(queried).toMatchObject({ value: null, valueLength: 4, valueRedacted: true });

    const childNonce = oneSuccess(await runCli(
      'target-eval',
      'document.body.dataset.nonce',
      childTargetId
    ));
    const parentState = oneSuccess(await runCli(
      'target-eval',
      `({
        value: document.querySelector('#card').value,
        nonce: document.body.dataset.nonce
      })`,
      page.id
    ));
    expect(childNonce.value).not.toBe('child-0');
    expect(parentState.value).toEqual({ value: 'parent-decoy', nonce: 'parent-0' });

    const pressed = oneSuccess(await runCli(
      'target-press-key',
      'backspace',
      childTargetId,
      '--selector',
      '#card'
    ));
    expect(pressed).toMatchObject({
      targetId: childTargetId,
      selector: '#card',
      key: 'Backspace'
    });

    const childAfterKey = oneSuccess(await runCli(
      'target-eval',
      "document.querySelector('#card').value",
      childTargetId
    ));
    const parentAfterKey = oneSuccess(await runCli(
      'target-eval',
      "document.querySelector('#card').value",
      page.id
    ));
    expect(childAfterKey.value).toBe('424');
    expect(parentAfterKey.value).toBe('parent-decoy');

    const finalParentNonce = oneSuccess(await runCli(
      'target-eval',
      'document.body.dataset.nonce',
      page.id
    ));
    expect(finalParentNonce.value).toBe('parent-0');
  });
});
