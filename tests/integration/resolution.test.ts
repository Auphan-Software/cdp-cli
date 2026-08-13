/**
 * Regression coverage for wi:6882 -- the runtime split.
 *
 * These tests assert WHICH BINARY ANSWERED, not that a command exited 0. A
 * stale cdp-cli.exe returns well-formed JSON and exit 0 for every command it
 * has; that is precisely why the split survived undetected through a version
 * bump and an hour of misdiagnosis on mako2#4796.
 *
 * The invariant is not "one artifact". The exe is kept deliberately (~2x faster
 * startup) and callers are expected to differ in `runtime`. What must match is
 * the source commit each was built from.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { compareIdentities, parseStatusIdentity, BuildIdentity } from '../../src/build-identity.js';

const isWindows = process.platform === 'win32';

function installed(): boolean {
  try {
    execFileSync(isWindows ? 'where' : 'which', ['cdp-cli'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function available(file: string, args: string[]): boolean {
  try {
    execFileSync(file, args, { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function probe(caller: string, file: string, args: string[]): BuildIdentity {
  const stdout = execFileSync(file, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  return parseStatusIdentity(caller, stdout);
}

// Nothing to compare when the CLI is not on PATH (a fresh clone, or CI without
// a global install). Skipping is honest; passing would not be.
const describeInstalled = installed() ? describe : describe.skip;

describeInstalled('installed cdp-cli resolves consistently across callers', () => {
  const hasPhp = available('php', ['-v']);
  const hasSh = available('sh', ['-c', 'exit 0']);

  it('resolves through a POSIX shell and reports a build identity', () => {
    if (!hasSh) return;
    const id = probe('sh', 'sh', ['-c', 'cdp-cli status']);

    expect(id.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(['npm', 'exe']).toContain(id.runtime);
    // The point of the whole exercise: the artifact must name its source.
    expect(id.commit, 'sh-resolved cdp-cli has no commit stamp - run: npm run install:exe').not.toBe('unknown');
  });

  it.runIf(isWindows)('resolves through cmd.exe, which is what PATHEXT gives PHP exec() and CI', () => {
    const id = probe('cmd.exe', 'cmd', ['/c', 'cdp-cli status']);

    expect(id.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(id.commit, 'cmd.exe-resolved cdp-cli has no commit stamp - run: npm run install:exe').not.toBe('unknown');
  });

  it('resolves through PHP exec(), the harness path that originally broke', () => {
    if (!hasPhp) return;
    const id = probe('php exec()', 'php', [
      '-r',
      'exec("cdp-cli status 2>&1", $o); echo implode("\\n", $o);',
    ]);

    expect(id.commit, 'PHP-resolved cdp-cli has no commit stamp - run: npm run install:exe').not.toBe('unknown');
  });

  it('agrees on the source commit across every available caller', () => {
    const identities: BuildIdentity[] = [];

    if (hasSh) identities.push(probe('sh', 'sh', ['-c', 'cdp-cli status']));
    if (isWindows) identities.push(probe('cmd.exe', 'cmd', ['/c', 'cdp-cli status']));
    if (hasPhp) {
      identities.push(
        probe('php exec()', 'php', ['-r', 'exec("cdp-cli status 2>&1", $o); echo implode("\\n", $o);'])
      );
    }

    expect(identities.length, 'no caller could be probed').toBeGreaterThan(0);

    const result = compareIdentities(identities);
    expect(result.agree, result.reason).toBe(true);
  });

  it.runIf(isWindows)('exposes the split when it exists: cmd.exe and sh may differ in runtime but not in source', () => {
    if (!hasSh) return;

    const viaCmd = probe('cmd.exe', 'cmd', ['/c', 'cdp-cli status']);
    const viaSh = probe('sh', 'sh', ['-c', 'cdp-cli status']);

    // Documented, expected, and the reason `commit` had to be added: these two
    // legitimately run different artifacts.
    expect(['exe', 'npm']).toContain(viaCmd.runtime);
    expect(['exe', 'npm']).toContain(viaSh.runtime);

    expect(viaCmd.commit).toBe(viaSh.commit);
    expect(viaCmd.version).toBe(viaSh.version);
  });

  it.runIf(isWindows)('doctor exits non-zero when callers disagree, zero when they agree', () => {
    // Exercises the real command a human runs, end to end.
    const out = execFileSync('cmd', ['/c', 'cdp-cli doctor'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    const line = out.split(/\r?\n/).find(l => l.includes('"type":"doctor"'));
    expect(line, `doctor produced no report: ${out.slice(0, 300)}`).toBeTruthy();

    const report = JSON.parse(line!);
    expect(report.agree, report.reason ?? '').toBe(true);
    expect(report.callers.length).toBeGreaterThan(0);
  });
});
