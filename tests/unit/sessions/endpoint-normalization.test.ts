// wi:7468 — the session-store filename is sha256 of the CDP url. Restarting a daemon with
// `--cdp-url http://localhost:9333` (the string cdp-cli's own --help prints) instead of the
// default `http://127.0.0.1:9333` hashed to a different file: the daemon booted an EMPTY
// registry while 15 pages were attached, every page command failed SESSION_NOT_FOUND, and
// `session list` plus /health reported ok the whole time.
import { describe, it, expect } from 'vitest';
import {
  normalizeCdpEndpoint,
  defaultWorkspaceSessionStorePath
} from '../../../src/sessions/workspace-session-service.js';

describe('CDP endpoint normalization (wi:7468)', () => {
  it('maps every spelling of the loopback endpoint to one store', () => {
    const canonical = defaultWorkspaceSessionStorePath('http://127.0.0.1:9333');
    for (const spelling of [
      'http://localhost:9333',
      'http://LOCALHOST:9333',
      'http://127.0.0.1:9333/',
      'http://[::1]:9333',
      '  http://localhost:9333  '
    ]) {
      expect(defaultWorkspaceSessionStorePath(spelling)).toBe(canonical);
    }
  });

  it('normalizes 127.0.0.1 to itself, so stores already on disk are not orphaned', () => {
    expect(normalizeCdpEndpoint('http://127.0.0.1:9333')).toBe('http://127.0.0.1:9333');
  });

  it('keeps genuinely different endpoints apart', () => {
    const a = defaultWorkspaceSessionStorePath('http://127.0.0.1:9333');
    expect(defaultWorkspaceSessionStorePath('http://127.0.0.1:9222')).not.toBe(a);
    expect(defaultWorkspaceSessionStorePath('http://10.0.0.5:9333')).not.toBe(a);
  });

  it('drops only genuinely default ports', () => {
    expect(normalizeCdpEndpoint('http://localhost:80')).toBe('http://127.0.0.1');
    expect(normalizeCdpEndpoint('https://example.com:443/')).toBe('https://example.com');
    expect(normalizeCdpEndpoint('http://localhost:443')).toBe('http://127.0.0.1:443');
  });
});
