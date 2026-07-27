#!/usr/bin/env node
/**
 * Unified entry point for standalone exe.
 *
 * When the exe is invoked with --__daemon as the first arg,
 * it runs the daemon. Otherwise, it runs the normal CLI.
 *
 * This allows the daemon to be spawned by re-invoking the same exe:
 *   spawn(process.execPath, ['--__daemon', '--cdp-url', ...])
 */

// Check for daemon mode BEFORE importing anything heavy
const isDaemon = process.argv.includes('--__daemon');

if (isDaemon) {
  // Remove --__daemon from argv so daemon arg parser doesn't see it
  process.argv = process.argv.filter(a => a !== '--__daemon');

  // Run daemon
  import('./daemon/daemon-entry.js');
} else {
  // Run normal CLI
  import('./index.js');
}
