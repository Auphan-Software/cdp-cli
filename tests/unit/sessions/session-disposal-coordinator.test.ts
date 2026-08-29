import { describe, expect, it } from 'vitest';
import type { DaemonClient } from '../../../src/daemon/client.js';
import {
  coordinateWorkspaceSessionDisposal
} from '../../../src/sessions/session-disposal-coordinator.js';
import type { WorkspaceSessionService } from '../../../src/sessions/workspace-session-service.js';

interface FakeServiceOptions {
  rootTargetId?: string;
  pageId?: string;
}

function fakeService(options: FakeServiceOptions = {}) {
  const rootTargetId = options.rootTargetId ?? 'root-1';
  const pageId = options.pageId ?? 'page-1';
  const calls: string[] = [];
  const session = {
    version: 1 as const,
    name: 'agent-1154',
    browserInstanceId: 'browser-1',
    browserContextId: 'context-1',
    isolation: 'isolated' as const,
    createdAt: 1,
    updatedAt: 1,
    pageIds: [pageId]
  };
  const service = {
    registry: {
      getSession(name: string) { return name === session.name ? session : undefined; },
      removeSession() { throw new Error('SESSION_NOT_FOUND'); },
      assertPageAccess() { return { rootTargetId }; }
    },
    async refresh() { calls.push('refresh'); },
    close() { calls.push('close'); },
    async resetSession() {
      calls.push('reset');
      return { session, affectedPageIds: [pageId], replacement: session, pageId };
    },
    async removeSession() {
      calls.push('remove');
      return { session, affectedPageIds: [pageId] };
    }
  };
  return { service: service as unknown as WorkspaceSessionService, calls };
}

function fakeDaemon() {
  const calls: string[] = [];
  const daemon = {
    async acquireWorkspaceLease(_name: string, pageId: string) {
      calls.push(`acquire:${pageId}`);
      return { leaseId: 'lease-acquired', owner: 'agent-1154', rootTargetId: 'root-1', expiresAt: 2 };
    },
    async replaceOwnedWorkspaceLease(_name: string, pageId: string) {
      calls.push(`replace:${pageId}`);
      return { leaseId: 'lease-replaced', owner: 'agent-1154', rootTargetId: 'root-1', expiresAt: 2 };
    },
    async releaseWorkspaceLease(_name: string, pageId: string, leaseId: string) {
      calls.push(`release:${pageId}:${leaseId}`);
    }
  };
  return { daemon: daemon as unknown as DaemonClient, calls };
}

describe('coordinateWorkspaceSessionDisposal', () => {
  it('uses an owned-lease replacement for reset and releases it afterward', async () => {
    const initial = fakeService();
    const reopened = fakeService();
    const daemon = fakeDaemon();

    const result = await coordinateWorkspaceSessionDisposal({
      action: 'reset',
      name: 'agent-1154',
      service: initial.service,
      daemonClient: daemon.daemon,
      openService: async () => reopened.service
    });

    expect(result.affectedPageIds).toEqual(['page-1']);
    expect(daemon.calls).toEqual([
      'replace:page-1',
      'release:page-1:lease-replaced'
    ]);
    expect(initial.calls).toEqual(['refresh', 'close']);
    expect(reopened.calls).toEqual(['refresh', 'reset', 'close']);
  });

  it('retries when the session root changes between lock snapshots', async () => {
    const initial = fakeService({ rootTargetId: 'root-1', pageId: 'page-1' });
    const changed = fakeService({ rootTargetId: 'root-2', pageId: 'page-2' });
    const stable = fakeService({ rootTargetId: 'root-2', pageId: 'page-2' });
    const daemon = fakeDaemon();
    const services = [changed.service, stable.service];

    await coordinateWorkspaceSessionDisposal({
      action: 'remove',
      name: 'agent-1154',
      service: initial.service,
      daemonClient: daemon.daemon,
      openService: async () => services.shift()!
    });

    expect(daemon.calls).toEqual([
      'acquire:page-1',
      'release:page-1:lease-acquired',
      'acquire:page-2',
      'release:page-2:lease-acquired'
    ]);
    expect(changed.calls).toEqual(['refresh', 'refresh', 'close']);
    expect(stable.calls).toEqual(['refresh', 'remove', 'close']);
  });
});
