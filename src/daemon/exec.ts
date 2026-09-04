/**
 * Command execution helper - routes through daemon when available
 * Falls back to direct WebSocket connection when daemon is not running
 */

import { CDPContext, Page, dialogBlockerError } from '../context.js';
import { DaemonClient } from './client.js';
import { SessionFoundationError } from '../sessions/errors.js';
import { WebSocket } from 'ws';

/**
 * Daemon use is opportunistic for anonymous commands (fall back to a direct
 * WebSocket), but a workspace session needs the daemon for its operation lease,
 * so a missing daemon configuration must surface instead of being treated as
 * "daemon not running".
 */
function rethrowDaemonConfigError(context: CDPContext, error: unknown): void {
  if (
    context.workspaceSessionName
    && error instanceof SessionFoundationError
    && error.code === 'DAEMON_URL_REQUIRED'
  ) {
    throw error;
  }
}

export interface DaemonPageInfo {
  pageId: string;
  connected: boolean;
}

export interface ExecSession {
  /** Page ID for daemon routing */
  pageId: string;
  /** WebSocket for direct connection (null if using daemon) */
  ws: WebSocket | null;
  /** Whether using daemon for execution */
  useDaemon: boolean;
  /** Execute a CDP command */
  exec: (method: string, params?: any) => Promise<any>;
  /** Check if DevTools is attached and throw if so */
  assertNoDevTools: () => Promise<void>;
  /** Check if a JavaScript dialog is blocking the page */
  assertNoDialog: () => Promise<void>;
  /** Close the session */
  close: () => void | Promise<void>;
}

/**
 * Find a page via daemon sessions (faster than Chrome REST API)
 * Returns null if daemon not running or page not found
 */
export async function findPageViaDaemon(
  context: CDPContext,
  idOrTitle: string
): Promise<DaemonPageInfo | null> {
  const daemon = new DaemonClient({ cdpUrl: context.cdpUrl });

  try {
    if (!await daemon.isRunning()) {
      return null;
    }

    const sessions = await daemon.listSessions();
    if (sessions.length === 0) {
      return null;
    }

    // Exact ID match
    const byId = sessions.find(s => s.pageId === idOrTitle);
    if (byId) {
      return { pageId: byId.pageId, connected: byId.connected };
    }

    // For title matching, we'd need page info from daemon
    // For now, return null to fall back to context.findPage
    return null;
  } catch {
    return null;
  }
}

/**
 * Create an execution session for a page
 * Automatically uses daemon if available, otherwise creates direct WebSocket
 */
export async function createExecSession(
  context: CDPContext,
  page: Page
): Promise<ExecSession> {
  const daemon = new DaemonClient({ cdpUrl: context.cdpUrl });

  // Check if daemon has a connected session for this page
  try {
    const sessions = await daemon.listSessions();
    const session = sessions.find(s => s.pageId === page.id && s.connected);
    if (session) {
      await context.assertSessionTargetAccess(page.id);
      const workspaceLease = await acquireDaemonOperationLease(
        daemon,
        context.workspaceSessionName,
        page.id
      );
      return {
        pageId: page.id,
        ws: null,
        useDaemon: true,
        exec: (method: string, params?: any) => daemon.execCommand(
          page.id,
          method,
          params,
          workspaceLease?.workspace
        ),
        assertNoDevTools: async () => {}, // Daemon handles its own connection - no check needed
        assertNoDialog: async () => {
          const status = await daemon.getDialogStatus(page.id, context.workspaceSessionName);
          if (status.open && status.dialog) throw dialogBlockerError(status.dialog);
        },
        close: () => workspaceLease?.release()
      };
    }
  } catch (error) {
    rethrowDaemonConfigError(context, error);
    // Daemon not running, fall through to direct connection
  }

  // Fall back to direct WebSocket connection
  const ws = await context.connect(page);

  // Check if daemon has a session for this page - if so, skip DevTools check
  let daemonConnectedToPage = false;
  try {
    const sessions = await daemon.listSessions();
    daemonConnectedToPage = sessions.some(s => s.pageId === page.id && s.connected);
  } catch (error) {
    rethrowDaemonConfigError(context, error);
    // Daemon not running
  }

  return {
    pageId: page.id,
    ws,
    useDaemon: false,
    exec: (method: string, params?: any) => context.sendCommand(ws, method, params),
    assertNoDevTools: daemonConnectedToPage
      ? async () => {}
      : () => context.assertNoDevTools(page.id),
    assertNoDialog: () => context.assertNoDialog(ws),
    close: () => ws.close()
  };
}

/**
 * Create an execution session by page ID or title
 * Optimized path: uses daemon for both page lookup and command execution when available
 */
export async function createExecSessionByPageRef(
  context: CDPContext,
  pageIdOrTitle: string
): Promise<ExecSession> {
  const daemon = new DaemonClient({ cdpUrl: context.cdpUrl });

  await context.assertSessionTargetAccess(pageIdOrTitle);

  // Try daemon path first (single HTTP call for both lookup and session)
  try {
    const sessions = await daemon.listSessions();
    // Exact ID match only. Falling back to "the only session" would silently
    // run the command against a page the caller never named - including when
    // the caller simply mistyped an id.
    const session = sessions.find(s => s.pageId === pageIdOrTitle && s.connected);

    if (session) {
      const sessionPageId = session.pageId;
      const workspaceLease = await acquireDaemonOperationLease(
        daemon,
        context.workspaceSessionName,
        sessionPageId
      );
      return {
        pageId: sessionPageId,
        ws: null,
        useDaemon: true,
        exec: (method: string, params?: any) => daemon.execCommand(
          sessionPageId,
          method,
          params,
          workspaceLease?.workspace
        ),
        assertNoDevTools: async () => {}, // Daemon handles its own connection - no check needed
        assertNoDialog: async () => {
          const status = await daemon.getDialogStatus(sessionPageId, context.workspaceSessionName);
          if (status.open && status.dialog) throw dialogBlockerError(status.dialog);
        },
        close: () => workspaceLease?.release()
      };
    }
  } catch (error) {
    rethrowDaemonConfigError(context, error);
    // Daemon not running
  }

  // Fall back to traditional path: findPage + direct WebSocket
  const page = await context.findPage(pageIdOrTitle);
  const ws = await context.connect(page);

  // Check if daemon has a session for this page - if so, skip DevTools check
  // (daemon's connection shows as attached but doesn't block commands)
  let daemonConnectedToPage = false;
  try {
    const sessions = await daemon.listSessions();
    daemonConnectedToPage = sessions.some(s => s.pageId === page.id && s.connected);
  } catch (error) {
    rethrowDaemonConfigError(context, error);
    // Daemon not running
  }

  return {
    pageId: page.id,
    ws,
    useDaemon: false,
    exec: (method: string, params?: any) => context.sendCommand(ws, method, params),
    assertNoDevTools: daemonConnectedToPage
      ? async () => {} // Daemon connected - skip check
      : () => context.assertNoDevTools(page.id),
    assertNoDialog: () => context.assertNoDialog(ws),
    close: () => ws.close()
  };
}

/**
 * Execute a batch of commands through daemon
 * Returns null if daemon not available
 */
export async function execBatch(
  context: CDPContext,
  pageId: string,
  commands: Array<{ method: string; params?: any }>
): Promise<any[] | null> {
  const daemon = new DaemonClient({ cdpUrl: context.cdpUrl });

  try {
    if (!await daemon.isRunning()) {
      return null;
    }
    return await daemon.execBatch(pageId, commands);
  } catch {
    return null;
  }
}

async function acquireDaemonOperationLease(
  daemon: DaemonClient,
  sessionName: string | undefined,
  pageId: string
): Promise<{
  workspace: { sessionName: string; leaseId: string };
  release(): Promise<void>;
} | undefined> {
  if (!sessionName) return undefined;
  const lease = await daemon.acquireWorkspaceLease(sessionName, pageId);
  const heartbeat = setInterval(() => {
    void daemon.heartbeatWorkspaceLease(
      sessionName,
      pageId,
      lease.leaseId,
      lease.rootTargetId
    ).catch(() => {
      clearInterval(heartbeat);
    });
  }, 20_000);
  heartbeat.unref();
  let released = false;
  return {
    workspace: { sessionName, leaseId: lease.leaseId },
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      clearInterval(heartbeat);
      return daemon.releaseWorkspaceLease(
        sessionName,
        pageId,
        lease.leaseId,
        lease.rootTargetId
      );
    }
  };
}
