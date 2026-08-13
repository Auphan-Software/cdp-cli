/**
 * Build identity, shared by `--version`, `status` and `doctor`.
 *
 * On Windows several shims share the `cdp-cli` name and PATHEXT resolves `.EXE`
 * before `.CMD`, so a stale standalone exe can answer cmd.exe/PHP exec()/CI as
 * an older tool while a POSIX shell reports the fresh build. Reporting which
 * build answered, when it was produced, and WHICH COMMIT it came from is what
 * makes that visible.
 *
 * The commit is the load-bearing field. A build timestamp only says when a file
 * was written -- it is rewritten by copying and by `git checkout`, and it cannot
 * distinguish "same source, rebuilt" from "different source". Two artifacts are
 * interchangeable when their commits match, whatever their timestamps say.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);

export const isExeBuild = typeof CDP_CLI_BUILD !== 'undefined';

/**
 * Written next to the compiled entry by scripts/stamp-build.mjs. Absent when
 * running from source (vitest), which is why every read below has a fallback.
 */
interface BuildInfo {
  version?: string;
  commit?: string;
  dirty?: boolean;
  built?: string;
}

const buildInfo: BuildInfo = (() => {
  if (isExeBuild) return {};
  try {
    // Resolved through the module system rather than read off disk: this runs
    // at import time, and a bare fs read here fails the whole process (and any
    // test suite that stubs fs) before a single command can run.
    return createRequire(here)('./build-info.json') as BuildInfo;
  } catch {
    return {};
  }
})();

export const version: string = (() => {
  if (typeof CDP_CLI_VERSION !== 'undefined') return CDP_CLI_VERSION;
  if (buildInfo.version) return buildInfo.version;
  try {
    return createRequire(here)('../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

export const commit: string = (() => {
  if (typeof CDP_CLI_COMMIT !== 'undefined') return CDP_CLI_COMMIT;
  return buildInfo.commit ?? 'unknown';
})();

export const dirty: boolean = (() => {
  if (typeof CDP_CLI_DIRTY !== 'undefined') return CDP_CLI_DIRTY;
  return buildInfo.dirty === true;
})();

export const build: string = (() => {
  if (isExeBuild) return CDP_CLI_BUILD as string;
  if (buildInfo.built) return buildInfo.built;
  try {
    // Last resort for an install predating the stamp. Kept because reporting a
    // weak answer beats reporting none, but it is not a source identity.
    return createRequire(here)('node:fs').statSync(here).mtime.toISOString().replace(/\.\d+Z$/, 'Z');
  } catch {
    return 'unknown';
  }
})();

export const runtime: 'exe' | 'npm' = isExeBuild ? 'exe' : 'npm';

/** Short commit for display, with a marker when the tree was modified. */
export const shortCommit: string =
  commit === 'unknown' ? 'unknown' : `${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`;

/**
 * Human-facing `--version` output.
 *
 * Scripts should NOT parse this: `status` carries the same facts as discrete
 * JSON fields, and `doctor` compares them across callers. PHP's version_compare
 * in particular treats the trailing build text as a pre-release suffix, so
 * comparing this string against a bare semver reports an equal version as older.
 *
 * The bare semver stays first: scripts/install-exe.mjs asserts the reported
 * string starts with package.json's version.
 */
export const versionString = `${version} (${runtime} build ${build}, commit ${shortCommit})`;
