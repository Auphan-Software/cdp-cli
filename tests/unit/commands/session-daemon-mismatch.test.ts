/**
 * wi:7235/A6 - the `session` command must refuse to touch a workspace-session
 * store keyed by --cdp-url when CDP_DAEMON_URL points at a daemon serving a
 * DIFFERENT browser, instead of silently opening/blaming the wrong store.
 *
 * PR #1 (528c41a) added this guard to context.ts's command surface, but the
 * `session` subcommand in index.ts builds its own WorkspaceSessionService/
 * SessionStore directly and never called it - so `cdp-cli session list` (and
 * create/ensure/adopt/remove/reset/metadata-reset) could silently read or
 * reset the wrong endpoint's store. These spawn the real CLI entrypoint
 * (as `npx tsx` does in production - see AGENTS.md hard limits) against a
 * synthetic daemon so the check is proven end to end, not just unit-mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CDPDaemon } from '../../../src/daemon/daemon.js';

const execFileAsync = promisify(execFile);

let daemon: CDPDaemon;
let daemonUrl: string;

beforeAll(async () => {
  daemon = new CDPDaemon({ port: 0, cdpUrl: 'http://127.0.0.1:1' });
  await daemon.start();
  daemonUrl = `http://127.0.0.1:${daemon.listeningPort}`;
});

afterAll(async () => {
  await daemon.stop();
});

async function runSession(args: string[]) {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['--no-install', 'tsx', 'src/index.ts', 'session', ...args],
      { env: { ...process.env, CDP_DAEMON_URL: daemonUrl }, timeout: 30000, shell: true }
    );
    return { code: 0, stdout };
  } catch (error) {
    const err = error as { code?: number; stdout?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '' };
  }
}

describe('session command refuses a daemon serving the wrong browser (wi:7235/A6)', () => {
  it('session list: exits non-zero with DAEMON_BROWSER_MISMATCH, not a stale/empty store', async () => {
    const { code, stdout } = await runSession(['list', '--cdp-url', 'http://127.0.0.1:2']);
    expect(code).not.toBe(0);
    expect(stdout).toContain('DAEMON_BROWSER_MISMATCH');
  });

  it('session metadata-reset: refuses to reset a store for a browser the daemon does not serve', async () => {
    const { code, stdout } = await runSession([
      'metadata-reset', '--cdp-url', 'http://127.0.0.1:2', '--force', '--metadata-only'
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toContain('DAEMON_BROWSER_MISMATCH');
  });

  it('session list: passes the mismatch guard when --cdp-url agrees with the daemon (negative control)', async () => {
    // No real Chrome listens at 127.0.0.1:1, so WorkspaceSessionService.open
    // itself fails past this point - the point of this control is only that
    // it fails for a DIFFERENT reason, never DAEMON_BROWSER_MISMATCH.
    const { stdout } = await runSession(['list', '--cdp-url', 'http://127.0.0.1:1']);
    expect(stdout).not.toContain('DAEMON_BROWSER_MISMATCH');
  });
}, 60000);
