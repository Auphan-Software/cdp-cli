/**
 * `cdp-cli doctor` -- prove every caller resolves the same source.
 *
 * The one command a human or an agent runs to answer "is the cdp-cli that my
 * PHP test harness invokes the same one I just built?". Git Bash gets the
 * extensionless npm shim, cmd.exe/PHP exec()/CI get cdp-cli.exe via PATHEXT,
 * and both answer in well-formed JSON, so the mismatch is silent by default.
 */

import { execFileSync } from 'child_process';
import { outputLine, outputError } from '../output.js';
import {
  BuildIdentity,
  compareIdentities,
  parseStatusIdentity,
} from '../build-identity.js';

interface Probe {
  caller: string;
  /** Why this caller matters, shown when it is the one that disagrees. */
  stands_for: string;
  run: () => string;
}

function runner(file: string, args: string[]): () => string {
  return () =>
    execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
}

export function probes(): Probe[] {
  const list: Probe[] = [];

  if (process.platform === 'win32') {
    list.push({
      caller: 'cmd.exe',
      stands_for: 'PHP exec(), batch files, CI runners -- PATHEXT picks .EXE here',
      run: runner('cmd', ['/c', 'cdp-cli status']),
    });
  }

  list.push({
    caller: 'sh',
    stands_for: 'Git Bash and anything POSIX -- picks the extensionless npm shim',
    run: runner('sh', ['-c', 'cdp-cli status']),
  });

  list.push({
    caller: 'php exec()',
    stands_for: 'the browser test harness that shells out to cdp-cli',
    run: runner('php', ['-r', 'exec("cdp-cli status 2>&1", $o); echo implode("\\n", $o);']),
  });

  return list;
}

/**
 * Where each `cdp-cli` on PATH actually lives, in the order cmd.exe resolves.
 * Reported unconditionally: when the check fails this is the first thing anyone
 * asks for, and it is the evidence that a second artifact exists at all.
 */
function resolvedPaths(): string[] {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const args = process.platform === 'win32' ? ['cdp-cli'] : ['-a', 'cdp-cli'];
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function doctor(): Promise<void> {
  const identities: BuildIdentity[] = [];
  const skipped: { caller: string; reason: string }[] = [];

  for (const probe of probes()) {
    let stdout: string;
    try {
      stdout = probe.run();
    } catch (error) {
      // A caller that is not installed on this machine (no php, no sh) is not
      // a drift failure -- but a caller that IS installed and blew up is.
      const err = error as NodeJS.ErrnoException & { stdout?: string };
      const missing = err.code === 'ENOENT';
      skipped.push({
        caller: probe.caller,
        reason: missing ? 'not installed on this machine' : (err.message || 'probe failed'),
      });
      continue;
    }

    try {
      identities.push(parseStatusIdentity(probe.caller, stdout));
    } catch (error) {
      skipped.push({ caller: probe.caller, reason: (error as Error).message });
    }
  }

  const result = compareIdentities(identities);

  outputLine({
    type: 'doctor',
    agree: result.agree,
    callers: identities.map(id => ({
      caller: id.caller,
      runtime: id.runtime,
      version: id.version,
      commit: id.commit,
      dirty: id.dirty,
      build: id.build,
    })),
    skipped,
    paths: resolvedPaths(),
    ...(result.agree ? {} : { reason: result.reason }),
  });

  if (!result.agree) {
    outputError(
      result.reason,
      'BUILD_IDENTITY_MISMATCH',
      { commits: result.commits }
    );
    process.exit(1);
  }
}
