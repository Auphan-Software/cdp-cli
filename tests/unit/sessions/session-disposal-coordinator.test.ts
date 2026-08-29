import { describe, expect, it } from 'vitest';
import type { DaemonClient } from '../../../src/daemon/client.js';
import { coordinateWorkspaceSessionDisposal } from '../../../src/sessions/session-disposal-coordinator.js';
import type { WorkspaceSessionService } from '../../../src/sessions/workspace-session-service.js';

function fakeService(rootTargetId = 'root-1', pageId = 'page-1') {
  const calls: string[] = [];
  const session = {
    version: 1 as const, name: 'agent-1154', browserInstanceId: 'browser-1',
    browserContextId: 'context-1', isolation: 'isolated' as const,
    createdAt: 1, updatedAt: 1, pageIds: [pageId]
  };
  const service = {
    registry: {
      getSession: (name: string) => name === session.name ? session : undefined,
      removeSession: () => { throw new Error('SESSION_NOT_FOUND'); },
      assertPageAccess: () => ({ rootTargetId })
    },
    async refresh() { calls.push('refresh'); },
    close() { calls.push('close'); },
    async resetSession() { calls.push('reset'); return { session, affectedPageIds: [pageId], replacement: session, pageId }; },
    async removeSession() { calls.push('remove'); return { session, affectedPageIds: [pageId] }; }
  };
  return { service: service as unknown as WorkspaceSessionService, calls };
}

describe('coordinateWorkspaceSessionDisposal', () => {
  it('replaces the owned reset lease and releases it', async () => {
    const initial = fakeService();
    const reopened = fakeService();
    const daemonCalls: string[] = [];
    const daemon = {
      async replaceOwnedWorkspaceLease(_name: string, pageId: string) {
        daemonCalls.push(`replace:${pageId}`);
        return { leaseId: 'lease-1', rootTargetId: 'root-1' };
      },
      async releaseWorkspaceLease(_name: string, pageId: string, leaseId: string) {
        daemonCalls.push(`release:${pageId}:${leaseId}`);
      }
    } as unknown as DaemonClient;

    await coordinateWorkspaceSessionDisposal({
      action: 'reset', name: 'agent-1154', service: initial.service, daemonClient: daemon,
      openService: async () => reopened.service
    });

    expect(daemonCalls).toEqual(['replace:page-1', 'release:page-1:lease-1']);
    expect(reopened.calls).toEqual(['refresh', 'reset', 'close']);
  });
});
