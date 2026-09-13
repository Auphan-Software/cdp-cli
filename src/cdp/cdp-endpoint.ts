/**
 * Canonical form for comparing/keying two CDP HTTP endpoints. Loopback
 * spellings are interchangeable - Chrome answers on `localhost`, `127.0.0.1`
 * and `[::1]` alike - so only the scheme and the effective port distinguish
 * two endpoints on this host. Shared by the daemon/client endpoint-agreement
 * check and by the workspace-session store path so BOTH derive the same key
 * from any spelling of the same endpoint (see wi:7468 - localhost vs
 * 127.0.0.1 used to hash to different session-store files).
 *
 * The canonical loopback spelling is fixed at `127.0.0.1`, NOT `localhost`:
 * every already-deployed session store was hashed from the raw
 * `http://127.0.0.1:<port>` string (that is cdp-cli's own historical default
 * endpoint), so canonicalizing toward any other spelling would silently
 * orphan every existing store on the first restart after this ships - the
 * exact class of outage this function exists to prevent, just delivered to
 * the whole fleet at once instead of to whoever mis-typed a flag (see wi:7469
 * A10). `localhost` and `[::1]` fold INTO `127.0.0.1`, never the reverse.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function canonicalCdpEndpoint(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const host = LOOPBACK_HOSTS.has(parsed.hostname) ? '127.0.0.1' : parsed.hostname.toLowerCase();
  return `${parsed.protocol}//${host}:${port}`;
}
