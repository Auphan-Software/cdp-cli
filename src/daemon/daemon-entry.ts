#!/usr/bin/env node
/**
 * Daemon entry point - spawned as background process
 */

import { runDaemon } from './daemon.js';

// Parse command line args
const args = process.argv.slice(2);
const config: { cdpUrl?: string; port?: number; bufferSize?: number } = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cdp-url' && args[i + 1]) {
    config.cdpUrl = args[++i];
  } else if (args[i] === '--port' && args[i + 1]) {
    config.port = parseInt(args[++i], 10);
  } else if (args[i] === '--buffer-size' && args[i + 1]) {
    config.bufferSize = parseInt(args[++i], 10);
  }
}

runDaemon(config).catch((err) => {
  console.error('Daemon error:', err.message);
  process.exit(1);
});
