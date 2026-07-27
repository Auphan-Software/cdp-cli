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
    'ws',        // uses dynamic require
    'undici',    // large, keep external
  ];

  // pngjs is CommonJS and requires node builtins at load time. In an ESM
  // bundle esbuild's __require shim cannot resolve those, so the output throws
  // 'Dynamic require of "util" is not supported' on startup. Restoring a real
  // require for the bundle fixes it.
  // Only `require` is injected: the sources already derive their own
  // __filename/__dirname from import.meta.url, and redeclaring them here is a
  // syntax error in the bundled output.
  const esmRequireBanner = {
    js: [
      `import { createRequire as __cdpCreateRequire } from 'node:module';`,
      `const require = __cdpCreateRequire(import.meta.url);`
    ].join('\n')
  };

  // Bundle main CLI (ESM format, no shebang for node execution)
  await esbuild.build({
    entryPoints: [join(root, 'build/index.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: join(root, 'bundle/cdp-cli.mjs'),
    external: commonExternal,
    banner: esmRequireBanner,
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
    banner: esmRequireBanner,
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
