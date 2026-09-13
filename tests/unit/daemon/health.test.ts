import { afterEach, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
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
    // localhost:1 and 127.0.0.1:1 must self-report the SAME normalized form.
    expect(body.normalizedCdpUrl).toBe('http://localhost:1');
    expect(body.daemon).toMatchObject({ version, commit });
    expect(body.workspaceSessions.storePath).toBe(defaultWorkspaceSessionStorePath('http://localhost:1'));
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
    expect(body.normalizedCdpUrl).toBe('http://localhost:1');
    expect(body.workspaceSessions.storePath).toBe(defaultWorkspaceSessionStorePath('http://localhost:1'));
  });
});
