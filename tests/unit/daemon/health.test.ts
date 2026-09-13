import { afterEach, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { createHash } from 'node:crypto';
import { CDPDaemon } from '../../../src/daemon/daemon.js';
import { defaultWorkspaceSessionStorePath } from '../../../src/sessions/index.js';
import { commit, version } from '../../../src/version.js';

let daemon: CDPDaemon | undefined;

afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
});

describe('/health self-report (A3)', () => {
  it('proves the daemon\'s own build identity, normalized endpoint and workspace-store state', async () => {
    daemon = new CDPDaemon({ port: 0, cdpUrl: 'http://localhost:1' });
    await daemon.start();

    const res = await undiciFetch(`http://127.0.0.1:${daemon.listeningPort}/health`);
    const body = await res.json() as any;

    expect(body.status).toBe('ok');
    expect(body.cdpUrl).toBe('http://localhost:1');
    // localhost:1 and 127.0.0.1:1 must self-report the SAME normalized form,
    // and that form is 127.0.0.1 (see the A10 hash-preservation test below).
    expect(body.normalizedCdpUrl).toBe('http://127.0.0.1:1');
    expect(body.daemon).toMatchObject({ version, commit });
    expect(body.workspaceSessions.storePath).toBe(defaultWorkspaceSessionStorePath('http://127.0.0.1:1'));
    // No sessions file has ever been written for this synthetic endpoint, so
    // an absent file must NOT be reported as the loud "empty registry" fault -
    // only an existing, empty file alongside live pages is.
    expect(body.workspaceSessions.count).toBe(0);
    expect(body.errorCode).toBeUndefined();
  });

  it('reports the same normalizedCdpUrl / storePath regardless of loopback spelling', async () => {
    daemon = new CDPDaemon({ port: 0, cdpUrl: 'http://127.0.0.1:1' });
    await daemon.start();
    const res = await undiciFetch(`http://127.0.0.1:${daemon.listeningPort}/health`);
    const body = await res.json() as any;
    expect(body.normalizedCdpUrl).toBe('http://127.0.0.1:1');
    expect(body.workspaceSessions.storePath).toBe(defaultWorkspaceSessionStorePath('http://127.0.0.1:1'));
  });

  it('does not orphan the store already deployed for the fleet default endpoint (A10)', () => {
    const hash = (u: string) => createHash('sha256').update(u).digest('hex').slice(0, 16);
    // This is the literal value already on disk for the live fleet's default
    // endpoint, hashed the OLD way (raw string, no normalization). Every
    // loopback spelling must still resolve to this exact store file after
    // normalization, or upgrading this daemon orphans 16 live agent sessions.
    const deployedHash = hash('http://127.0.0.1:9333');
    for (const spelling of ['http://127.0.0.1:9333', 'http://localhost:9333', 'http://[::1]:9333']) {
      expect(defaultWorkspaceSessionStorePath(spelling)).toContain(deployedHash);
    }
  });
});
