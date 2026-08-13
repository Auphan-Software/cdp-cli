/**
 * The identity check has to FAIL on a real mismatch, so these tests feed it the
 * exact shapes that went undetected: two builds of the same semver, minutes
 * apart, from different commits (wi:6882), and a 1.5.2 exe shadowing a fresh
 * npm build (mako2#4796, which cost an hour of misdiagnosis).
 */

import { describe, it, expect } from 'vitest';
import {
  BuildIdentity,
  compareIdentities,
  parseStatusIdentity,
} from '../../src/build-identity.js';

function identity(overrides: Partial<BuildIdentity> = {}): BuildIdentity {
  return {
    caller: 'cmd.exe',
    version: '1.10.0',
    commit: 'd13bea3aaaaabbbbbcccccddddd1111122223333',
    dirty: false,
    build: '2026-08-12T18:25:59Z',
    runtime: 'exe',
    ...overrides,
  };
}

describe('compareIdentities', () => {
  it('agrees when callers run different runtimes built from the same commit', () => {
    // The exe is ~2x faster to start and is deliberately kept, so a runtime
    // difference must NOT be reported as drift.
    const result = compareIdentities([
      identity({ caller: 'cmd.exe', runtime: 'exe', build: '2026-08-12T18:25:59Z' }),
      identity({ caller: 'sh', runtime: 'npm', build: '2026-08-12T18:31:26Z' }),
    ]);

    expect(result.agree).toBe(true);
    expect(result.reason).toBe('');
    expect(result.commits).toHaveLength(1);
  });

  it('detects the wi:6882 mismatch: identical semver, different commits', () => {
    const result = compareIdentities([
      identity({ caller: 'cmd.exe', runtime: 'exe', commit: 'aaaaaaaaaaaa1111', build: '2026-08-12T18:25:59Z' }),
      identity({ caller: 'sh', runtime: 'npm', commit: 'bbbbbbbbbbbb2222', build: '2026-08-12T18:31:26Z' }),
    ]);

    expect(result.agree).toBe(false);
    expect(result.reason).toMatch(/DIFFERENT commits/);
    // Both callers named, so the report says which one is stale.
    expect(result.reason).toContain('cmd.exe');
    expect(result.reason).toContain('sh');
    expect(result.commits).toHaveLength(2);
  });

  it('detects a stale exe shadowing a fresh npm build (mako2#4796)', () => {
    const result = compareIdentities([
      identity({ caller: 'php exec()', runtime: 'exe', version: '1.5.2', commit: 'old0old0old0' }),
      identity({ caller: 'sh', runtime: 'npm', version: '1.10.0', commit: 'new0new0new0' }),
    ]);

    expect(result.agree).toBe(false);
    expect(result.reason).toMatch(/npm run install:exe/);
  });

  it('refuses to pass when a commit is unknown', () => {
    // A check that cannot see must not report clean.
    const result = compareIdentities([
      identity({ caller: 'cmd.exe', commit: 'unknown' }),
      identity({ caller: 'sh', runtime: 'npm' }),
    ]);

    expect(result.agree).toBe(false);
    expect(result.reason).toMatch(/unknown/i);
    expect(result.reason).toContain('cmd.exe');
  });

  it('flags a same-commit build made from a modified tree', () => {
    const result = compareIdentities([
      identity({ caller: 'cmd.exe', dirty: true }),
      identity({ caller: 'sh', runtime: 'npm', dirty: false }),
    ]);

    expect(result.agree).toBe(false);
    expect(result.reason).toMatch(/modified tree/);
  });

  it('accepts a dirty tree when every caller was built from it', () => {
    const result = compareIdentities([
      identity({ caller: 'cmd.exe', dirty: true }),
      identity({ caller: 'sh', runtime: 'npm', dirty: true }),
    ]);

    expect(result.agree).toBe(true);
  });

  it('fails when nothing could be probed', () => {
    expect(compareIdentities([]).agree).toBe(false);
  });
});

describe('parseStatusIdentity', () => {
  it('reads the cli block out of status NDJSON', () => {
    const stdout =
      '{"cli":{"version":"1.10.0","build":"2026-08-12T18:25:59Z","runtime":"exe",' +
      '"commit":"d13bea3aaaaa","dirty":false},"daemon":{"running":true,"sessions":17}}';

    const id = parseStatusIdentity('cmd.exe', stdout);

    expect(id).toMatchObject({
      caller: 'cmd.exe',
      version: '1.10.0',
      commit: 'd13bea3aaaaa',
      dirty: false,
      runtime: 'exe',
    });
  });

  it('ignores leading noise and picks the line carrying cli', () => {
    const stdout = 'warning: something\n{"type":"other"}\n{"cli":{"version":"1.10.0","runtime":"npm"}}\n';
    expect(parseStatusIdentity('sh', stdout).version).toBe('1.10.0');
  });

  it('reports commit as unknown for a build predating the stamp', () => {
    // Old artifacts have no commit field. That must degrade to 'unknown' (which
    // compareIdentities rejects), never to a silent pass.
    const stdout = '{"cli":{"version":"1.9.0","build":"2026-08-12T18:10:32Z","runtime":"exe"}}';
    expect(parseStatusIdentity('cmd.exe', stdout).commit).toBe('unknown');
  });

  it('throws when the output carries no cli block at all', () => {
    expect(() => parseStatusIdentity('sh', '{"daemon":{"running":false}}')).toThrow(/no status JSON/);
  });
});
