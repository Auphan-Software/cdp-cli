#!/usr/bin/env node
/**
 * Install the standalone exe over the one on PATH, then verify it through
 * cmd.exe rather than a POSIX shell.
 *
 * Why this exists: on Windows the npm global install leaves four entries with
 * the same stem (cdp-cli, .cmd, .ps1, .exe) and PATHEXT resolves `.EXE` before
 * `.CMD`. Git Bash picks the extensionless shell script and reports the freshly
 * built version, while cmd.exe, PHP exec(), batch files, Makefiles and most CI
 * runners pick the exe. The exe does not track source, so once it falls behind
 * it answers every one of those callers as an older tool -- returning
 * well-formed JSON the whole time, with no warning.
 *
 * A bash-only smoke test cannot see that, which is precisely how it went
 * unnoticed. So the check here runs through cmd.
 */
import { execFileSync, execSync } from 'child_process';
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const built = join(root, 'bundle', 'cdp-cli.exe');

if (process.platform !== 'win32') {
  console.log('Not Windows - the standalone exe shim does not apply here.');
  process.exit(0);
}

if (!existsSync(built)) {
  console.error(`No built exe at ${built}. Run: node scripts/build-exe.mjs`);
  process.exit(1);
}

// Find every cdp-cli on PATH the way cmd.exe resolves it.
let where = '';
try {
  where = execSync('where cdp-cli', { encoding: 'utf-8' });
} catch {
  console.error('cdp-cli is not on PATH; nothing to install over.');
  process.exit(1);
}

const targets = where
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l.toLowerCase().endsWith('.exe'));

if (targets.length === 0) {
  console.log('No cdp-cli.exe on PATH - the .cmd shim already wins, nothing to do.');
  process.exit(0);
}

for (const target of targets) {
  console.log(`Installing ${built} -> ${target}`);
  try {
    copyFileSync(built, target);
  } catch (err) {
    console.error(`Failed to write ${target}: ${err.message}`);
    console.error('It may be running, or need an elevated shell.');
    process.exit(1);
  }
}

// Verify through cmd.exe, not this process's shell.
const reported = execFileSync('cmd', ['/c', 'cdp-cli --version'], { encoding: 'utf-8' }).trim();
console.log(`cmd.exe resolves cdp-cli --version -> ${reported}`);

if (!reported.startsWith(pkg.version)) {
  console.error(`MISMATCH: package.json is ${pkg.version} but cmd.exe reports ${reported}.`);
  console.error('Something else on PATH is still shadowing the install.');
  process.exit(1);
}

console.log('OK - cmd.exe, and therefore PHP exec()/batch/CI, now resolve the current build.');
