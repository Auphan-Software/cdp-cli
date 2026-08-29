import type { DaemonClient } from '../daemon/client.js';
import { SessionFoundationError } from './errors.js';
import type {
  RemoveWorkspaceSessionResult,
  ResetWorkspaceSessionResult,
  WorkspaceSessionService
} from './workspace-session-service.js';

export type WorkspaceSessionDisposalAction = 'remove' | 'reset';
type DisposalResult = RemoveWorkspaceSessionResult | ResetWorkspaceSessionResult;

export interface WorkspaceSessionDisposalOptions {
  action: WorkspaceSessionDisposalAction;
  name: string;
  service: WorkspaceSessionService;
  daemonClient: DaemonClient;
  openService(): Promise<WorkspaceSessionService>;
  maxAttempts?: number;
}

export async function coordinateWorkspaceSessionDisposal(
  options: WorkspaceSessionDisposalOptions
): Promise<DisposalResult> {
  let service: WorkspaceSessionService | undefined = options.service;
  const maxAttempts = options.maxAttempts ?? 3;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await service.refresh();
      const session = service.registry.getSession(options.name);
      if (!session) service.registry.removeSession(options.name);
      const snapshot = sessionRoots(service, options.name, session!.pageIds);
      service.close();
      service = undefined;
      const held: Array<{ pageId: string; leaseId: string; rootTargetId: string }> = [];
      try {
        for (const pageId of snapshot.values()) {
          const lease = options.action === 'reset'
            ? await options.daemonClient.replaceOwnedWorkspaceLease(options.name, pageId)
            : await options.daemonClient.acquireWorkspaceLease(options.name, pageId);
          held.push({ pageId, leaseId: lease.leaseId, rootTargetId: lease.rootTargetId });
        }
        service = await options.openService();
        await service.refresh();
        const current = service.registry.getSession(options.name);
        if (!current) service.registry.removeSession(options.name);
        const currentRoots = sessionRoots(service, options.name, current!.pageIds);
        if (!sameRootSnapshot(snapshot, currentRoots)) continue;
        return options.action === 'reset'
          ? await service.resetSession(options.name, { force: true })
          : await service.removeSession(options.name, { force: true });
      } finally {
        await Promise.allSettled(held.map((lease) =>
          options.daemonClient.releaseWorkspaceLease(
            options.name, lease.pageId, lease.leaseId, lease.rootTargetId
          )
        ));
      }
    }
    throw new SessionFoundationError(
      'SESSION_STORE_CONFLICT',
      `Workspace session ${options.name} changed repeatedly during ${options.action}; retry the command`
    );
  } finally {
    service?.close();
  }
}

function sessionRoots(
  service: WorkspaceSessionService,
  sessionName: string,
  pageIds: readonly string[]
): Map<string, string> {
  const roots = new Map<string, string>();
  for (const pageId of pageIds) {
    const access = service.registry.assertPageAccess(sessionName, pageId);
    roots.set(access.rootTargetId, pageId);
  }
  return roots;
}

function sameRootSnapshot(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  if (left.size !== right.size) return false;
  for (const [rootTargetId, pageId] of left) {
    if (right.get(rootTargetId) !== pageId) return false;
  }
  return true;
}
