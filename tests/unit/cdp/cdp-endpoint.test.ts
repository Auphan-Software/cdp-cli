import { describe, expect, it } from 'vitest';
import { canonicalCdpEndpoint } from '../../../src/cdp/cdp-endpoint.js';

describe('canonicalCdpEndpoint', () => {
  it('treats localhost, 127.0.0.1 and [::1] as the same endpoint (wi:7468)', () => {
    const forms = [
      'http://localhost:9333',
      'http://127.0.0.1:9333',
      'http://[::1]:9333',
      'http://LOCALHOST:9333',
      'http://localhost:9333/',
      'http://localhost:9333///'
    ];
    const canonical = forms.map(canonicalCdpEndpoint);
    expect(new Set(canonical).size).toBe(1);
    // 127.0.0.1 is canonical, not localhost: every already-deployed session
    // store was hashed from the raw `http://127.0.0.1:<port>` string, so
    // folding toward any other spelling would orphan every existing store on
    // upgrade (wi:7469 A10).
    expect(canonical[0]).toBe('http://127.0.0.1:9333');
  });

  it('does not collapse distinct ports or distinct non-loopback hosts', () => {
    expect(canonicalCdpEndpoint('http://localhost:9333'))
      .not.toBe(canonicalCdpEndpoint('http://localhost:9334'));
    expect(canonicalCdpEndpoint('http://chrome-host:9222'))
      .not.toBe(canonicalCdpEndpoint('http://other-host:9222'));
  });

  it('fills in the scheme default port', () => {
    expect(canonicalCdpEndpoint('http://localhost')).toBe('http://127.0.0.1:80');
    expect(canonicalCdpEndpoint('https://localhost')).toBe('https://127.0.0.1:443');
  });

  it('proves the existing live session-store hash is unchanged (wi:7469 A10)', () => {
    // The already-deployed store for the fleet's default endpoint is keyed by
    // sha256("http://127.0.0.1:9333"). Every loopback spelling of that same
    // endpoint MUST canonicalize to that exact string, or upgrading orphans
    // every live session store on the first daemon restart.
    for (const spelling of ['http://127.0.0.1:9333', 'http://localhost:9333', 'http://[::1]:9333']) {
      expect(canonicalCdpEndpoint(spelling)).toBe('http://127.0.0.1:9333');
    }
  });

  it('returns undefined for an unparseable URL', () => {
    expect(canonicalCdpEndpoint('not a url')).toBeUndefined();
  });
});
