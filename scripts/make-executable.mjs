import { chmodSync } from 'fs';

try {
  chmodSync('build/index.js', 0o755);
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}
