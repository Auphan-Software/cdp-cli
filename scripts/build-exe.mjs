#!/usr/bin/env node
/**
 * Build standalone cdp-cli.exe using bun compile
 *
 * Strategy:
 * 1. esbuild bundles everything into a single CJS file (exe-entry.js)
 * 2. The exe-entry checks for --__daemon flag to route to daemon vs CLI
 * 3. bun build --compile produces the final .exe
 *
 * The daemon spawn in client.ts is patched at bundle time via esbuild define/inject
 * to use process.execPath + ['--__daemon', ...args] instead of [daemonScript].
 */
import * as esbuild from 'esbuild';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

// Plugin: Replace 'ws' imports with Bun's native WebSocket
// The ws library doesn't work in Bun runtime (101 handshake errors)
const wsShimPlugin = {
  name: 'ws-bun-shim',
  setup(build) {
    build.onResolve({ filter: /^ws$/ }, () => ({
      path: 'ws',
      namespace: 'ws-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'ws-shim' }, () => ({
      contents: `export { WebSocket } from "globalThis"; export default globalThis.WebSocket;`,
      loader: 'js',
    }));
  }
};

async function buildExe() {
  console.log(`Building cdp-cli.exe v${pkg.version}...`);

  // Step 1: Bundle into single ESM file with exe-entry wrapper
  console.log('Step 1: Bundling with esbuild...');

  // Use ws shim that wraps Bun's native WebSocket with Node ws-compatible API
  const wsShimPath = join(root, 'scripts/ws-bun-shim.mjs');

  await esbuild.build({
    entryPoints: [join(root, 'build/exe-entry.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: join(root, 'bundle/cdp-cli-exe.mjs'),
    external: [],  // Bundle everything — no externals for exe
    minify: false,
    sourcemap: false,
    define: {
      'CDP_CLI_VERSION': JSON.stringify(pkg.version),
      'CDP_CLI_EXE_MODE': 'true',
      // Baked in so `--version` can expose which build an install is running.
      // The exe does not track source, and on Windows PATHEXT resolves it ahead
      // of the .cmd shim, so a stale one silently shadows a fresh npm build.
      'CDP_CLI_BUILD': JSON.stringify(new Date().toISOString().replace(/\.\d+Z$/, 'Z')),
    },
    alias: {
      'ws': wsShimPath,
    },
    banner: {
      js: '// cdp-cli standalone exe bundle\n'
    },
  });

  console.log('  -> bundle/cdp-cli-exe.mjs created');

  // Step 2: Compile with bun
  console.log('Step 2: Compiling with bun...');

  const outExe = join(root, 'bundle/cdp-cli.exe');

  try {
    execSync(
      `bun build --compile --target=bun-windows-x64 "${join(root, 'bundle/cdp-cli-exe.mjs')}" --outfile "${outExe}"`,
      { stdio: 'inherit', cwd: root }
    );
    console.log(`  -> ${outExe} created`);
  } catch (err) {
    console.error('bun compile failed:', err.message);
    process.exit(1);
  }

  console.log('\nDone! Test with:');
  console.log('  bundle/cdp-cli.exe ready');
  console.log('  bundle/cdp-cli.exe list-pages');
}

buildExe().catch(err => {
  console.error(err);
  process.exit(1);
});
