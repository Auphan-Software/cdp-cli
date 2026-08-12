/**
 * Build identity, shared by `--version` and the `status` command.
 *
 * On Windows several shims share the `cdp-cli` name and PATHEXT resolves `.EXE`
 * before `.CMD`, so a stale standalone exe can answer cmd.exe/PHP exec()/CI as
 * an older tool while a POSIX shell reports the fresh build. Reporting which
 * build answered, and when it was produced, is what makes that visible.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);

export const isExeBuild = typeof CDP_CLI_BUILD !== 'undefined';

export const version: string = (() => {
  if (typeof CDP_CLI_VERSION !== 'undefined') return CDP_CLI_VERSION;
  try {
    // Resolved through the module system rather than read off disk: this runs
    // at import time, and a bare fs read here fails the whole process (and any
    // test suite that stubs fs) before a single command can run.
    return createRequire(here)('../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

export const build: string = (() => {
  if (isExeBuild) return CDP_CLI_BUILD as string;
  try {
    // The compiled entry's mtime is when this install was last built.
    return createRequire(here)('node:fs').statSync(here).mtime.toISOString().replace(/\.\d+Z$/, 'Z');
  } catch {
    return 'unknown';
  }
})();

export const runtime: 'exe' | 'npm' = isExeBuild ? 'exe' : 'npm';

/**
 * Human-facing `--version` output.
 *
 * Scripts should NOT parse this: `status` carries the same facts as discrete
 * JSON fields. PHP's version_compare in particular treats the trailing build
 * text as a pre-release suffix, so comparing this string against a bare semver
 * reports an equal version as older.
 */
export const versionString = `${version} (${runtime} build ${build})`;
