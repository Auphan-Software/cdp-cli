/**
 * Comparing the build identity of the cdp-cli that answered different callers.
 *
 * On Windows `C:\Program Files\nodejs\` holds `cdp-cli`, `.cmd`, `.ps1` and a
 * standalone `.exe` under one stem, and PATHEXT resolves `.EXE` before `.CMD`.
 * Git Bash runs the extensionless shell shim (node + build/index.js) while
 * cmd.exe, PHP `exec()`, batch files and CI run the exe. Both return
 * well-formed JSON, so a stale one is invisible until behaviour diverges --
 * which already cost an hour on mako2#4796.
 *
 * The invariant is deliberately NOT "every caller runs the same artifact".
 * The exe is ~2x faster to start and is worth keeping, so callers are expected
 * to differ in `runtime`. What must never differ is the SOURCE they were built
 * from. Comparing `commit` allows the exe to exist while making drift fail.
 */

export interface BuildIdentity {
  /** Label for the caller this identity came from, e.g. "cmd.exe". */
  caller: string;
  version: string;
  /** Full commit SHA the artifact was built from, or 'unknown'. */
  commit: string;
  /** Tracked files were modified at build time. */
  dirty: boolean;
  build: string;
  runtime: 'exe' | 'npm';
}

export interface IdentityComparison {
  agree: boolean;
  /** Human-readable explanation; empty when they agree. */
  reason: string;
  /** Distinct commits seen, in first-seen order. */
  commits: string[];
}

/**
 * Decide whether a set of callers is running the same source.
 *
 * An `unknown` commit cannot prove agreement, so it is treated as a failure
 * rather than quietly passing -- a check that cannot see is not a check.
 */
export function compareIdentities(identities: BuildIdentity[]): IdentityComparison {
  if (identities.length === 0) {
    return { agree: false, reason: 'No callers were probed.', commits: [] };
  }

  const commits: string[] = [];
  for (const id of identities) {
    if (!commits.includes(id.commit)) commits.push(id.commit);
  }

  const unknown = identities.filter(id => id.commit === 'unknown');
  if (unknown.length > 0) {
    return {
      agree: false,
      reason:
        `Build identity is unknown for: ${unknown.map(u => u.caller).join(', ')}. ` +
        `Rebuild so the commit is stamped in (npm run build), then re-check.`,
      commits,
    };
  }

  if (commits.length > 1) {
    const detail = identities
      .map(id => `${id.caller} -> ${id.runtime} ${id.version} ${id.commit.slice(0, 12)}${id.dirty ? '-dirty' : ''} (built ${id.build})`)
      .join('\n  ');
    return {
      agree: false,
      reason:
        `Callers resolve cdp-cli builds from DIFFERENT commits:\n  ${detail}\n` +
        `Fix with: npm run install:exe (rebuilds and installs over every cdp-cli.exe on PATH).`,
      commits,
    };
  }

  const dirtyCallers = identities.filter(id => id.dirty);
  if (dirtyCallers.length > 0 && dirtyCallers.length !== identities.length) {
    return {
      agree: false,
      reason:
        `Same commit, but only some callers were built from a modified tree: ` +
        `${dirtyCallers.map(d => d.caller).join(', ')}. Rebuild both paths.`,
      commits,
    };
  }

  return { agree: true, reason: '', commits };
}

/**
 * Pull a BuildIdentity out of one line of `cdp-cli status` NDJSON.
 *
 * Parsing `status` rather than `--version`: the human string carries a build
 * suffix that makes PHP's `version_compare` read an equal version as older.
 */
export function parseStatusIdentity(caller: string, stdout: string): BuildIdentity {
  const line = stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.startsWith('{') && l.includes('"cli"'));

  if (!line) {
    throw new Error(`${caller}: no status JSON with a "cli" field in output: ${stdout.slice(0, 200)}`);
  }

  const cli = (JSON.parse(line) as { cli?: Partial<BuildIdentity> }).cli;
  if (!cli || typeof cli.version !== 'string') {
    throw new Error(`${caller}: status JSON has no usable cli block: ${line.slice(0, 200)}`);
  }

  return {
    caller,
    version: cli.version,
    commit: typeof cli.commit === 'string' ? cli.commit : 'unknown',
    dirty: cli.dirty === true,
    build: typeof cli.build === 'string' ? cli.build : 'unknown',
    runtime: cli.runtime === 'exe' ? 'exe' : 'npm',
  };
}
