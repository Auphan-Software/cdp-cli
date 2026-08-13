#!/usr/bin/env node
/**
 * Stamp build identity into build/build-info.json after tsc.
 *
 * Why a stamp and not a file mtime: the npm path used to report `statSync` on
 * its own entry, which says when the file was last *written*, not what source
 * produced it. Copying an install rewrites it, `git checkout` rewrites it, and
 * two builds of different commits made a minute apart look like ordinary drift
 * instead of a source difference. The commit is what a human actually needs to
 * answer "is the thing on PATH the thing in my tree".
 *
 * The exe gets the same fields through esbuild `define` in build-exe.mjs, so
 * both artifacts answer in the same shape and can be compared directly.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function gitIdentity(cwd = root) {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // Tracked-file changes only. Untracked scratch files (screenshots, bundles)
    // are normal in this repo and would pin `dirty` on permanently.
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;

    return { commit, dirty };
  } catch {
    // Building from a tarball or an export with no git available. Unknown is a
    // truthful answer; a fabricated SHA would be worse than none.
    return { commit: 'unknown', dirty: false };
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const { commit, dirty } = gitIdentity();

  const info = {
    version: pkg.version,
    commit,
    dirty,
    built: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };

  const out = join(root, 'build', 'build-info.json');
  writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
  console.log(`Stamped ${out}: ${info.version} ${commit.slice(0, 12)}${dirty ? '-dirty' : ''} ${info.built}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
