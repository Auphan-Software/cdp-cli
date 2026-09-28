import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cdpUrl = process.argv[2] ?? 'http://127.0.0.1:9347';
const outRoot = process.argv[3] ?? join(tmpdir(), 'cdp-state-agent-eval');
await mkdir(outRoot, { recursive: true });
const runDir = await mkdtemp(join(outRoot, 'run-'));
const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../build/index.js');
const cases = ['noop', 'total', 'dialog', 'visual', 'clean', 'idempotent', 'frame'];
let base = process.env.CDP_STATE_EVAL_BASE_URL;
let server;
if (!base) {
  const html = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/qa-agent.html'));
  server = createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/?case=`;
}

async function cli(...args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args, '--cdp-url', cdpUrl], {
    env: { ...process.env, CDP_DAEMON_URL: '', CDP_SESSION: '', CDP_PAGE: '', CDP_URL: '' },
    maxBuffer: 1024 * 1024
  });
  const lines = stdout.trim().split(/\r?\n/);
  const last = JSON.parse(lines.at(-1));
  if (last.error || last.success === false) throw new Error(`${args[0]}: ${JSON.stringify(last)}`);
  return last;
}

try {
  const results = [];
  for (const name of cases) {
    const created = await cli('new-page', `${base}${name}`);
    const page = created.data.id;
    if (name === 'visual') await cli('screenshot', page, '--selector', '#visual-panel',
      '--output', join(runDir, 'visual-before.png'));
    const action = await cli('state', 'click', '[data-testid=action]', page, '--stability-ms=0');
    if (name === 'visual') await cli('screenshot', page, '--selector', '#visual-panel',
      '--output', join(runDir, 'visual-after.png'));
    const value = action.value;
    results.push({ case: name, page, changed: value.changed, coverage: value.coverage,
      changes: value.changes, ...(name === 'visual' ? { screenshots: [join(runDir, 'visual-before.png'),
        join(runDir, 'visual-after.png')] } : {}) });
  }
  const output = { schema: 1, cdpUrl, cases: results };
  await writeFile(join(runDir, 'result.json'), JSON.stringify(output, null, 2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
