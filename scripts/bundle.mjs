#!/usr/bin/env node
/**
 * Bundle CLI with esbuild for faster startup
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chmod } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

async function bundle() {
  const commonExternal = [
    'sharp',     // native module
    'ws',        // uses dynamic require
    'undici',    // large, keep external
  ];

  // Bundle main CLI (ESM format, no shebang for node execution)
  await esbuild.build({
    entryPoints: [join(root, 'build/index.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: join(root, 'bundle/cdp-cli.mjs'),
    external: commonExternal,
    minify: false,
    sourcemap: false,
  });

  // Bundle daemon entry
  await esbuild.build({
    entryPoints: [join(root, 'build/daemon/daemon-entry.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: join(root, 'bundle/daemon.mjs'),
    external: commonExternal,
    minify: false,
    sourcemap: false,
  });

  // Make executable
  await chmod(join(root, 'bundle/cdp-cli.mjs'), 0o755);
  await chmod(join(root, 'bundle/daemon.mjs'), 0o755);

  console.log('Bundle complete: bundle/cdp-cli.mjs');
}

bundle().catch(err => {
  console.error(err);
  process.exit(1);
});
