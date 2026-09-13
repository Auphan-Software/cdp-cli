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
    expect(canonical[0]).toBe('http://localhost:9333');
  });

  it('does not collapse distinct ports or distinct non-loopback hosts', () => {
    expect(canonicalCdpEndpoint('http://localhost:9333'))
      .not.toBe(canonicalCdpEndpoint('http://localhost:9334'));
    expect(canonicalCdpEndpoint('http://chrome-host:9222'))
      .not.toBe(canonicalCdpEndpoint('http://other-host:9222'));
  });

  it('fills in the scheme default port', () => {
    expect(canonicalCdpEndpoint('http://localhost')).toBe('http://localhost:80');
    expect(canonicalCdpEndpoint('https://localhost')).toBe('https://localhost:443');
  });

  it('returns undefined for an unparseable URL', () => {
    expect(canonicalCdpEndpoint('not a url')).toBeUndefined();
  });
});
