/**
 * Command execution helper - routes through daemon when available
 * Falls back to direct WebSocket connection when daemon is not running
 */

import { CDPContext, Page, dialogGuardError, wedgedRendererError, type DialogObservation } from '../context.js';
import { DaemonClient } from './client.js';
import { SessionFoundationError } from '../sessions/errors.js';
import { WebSocket } from 'ws';
import { CommandTimeoutError } from '../cdp/command-timeout.js';

/**
 * Daemon use is opportunistic for anonymous commands (fall back to a direct
 * WebSocket), but a workspace session needs the daemon for its operation lease,
 * so a missing daemon configuration must surface instead of being treated as
 * "daemon not running".
 */
function rethrowDaemonConfigError(context: CDPContext, error: unknown): void {
  if (!(error instanceof SessionFoundationError)) return;
  // A daemon that serves a DIFFERENT browser is never something to fall back
  // from: falling back silently drives the wrong Chrome, which is the whole
  // defect. It is raised for every command, workspace-scoped or not.
  if (error.code === 'DAEMON_BROWSER_MISMATCH') throw error;
  if (context.workspaceSessionName && error.code === 'DAEMON_URL_REQUIRED') {
    throw error;
  }
}

/**
 * A CDP command that timed out is the only trustworthy evidence that a page is
 * not answering, so the diagnosis is made here rather than guessed from a
 * pre-flight probe. Every other failure is passed through untouched.
 *
 * `observe` is read at failure time, not at construction time, because the
 * dialog check runs between the two. It returns `unknown` whenever no check
 * ran or the check reached no verdict, which is what keeps the message from
 * ruling out a dialog it never actually looked for.
 */
function explainCommandTimeout(
  pageId: string,
  method: string,
  error: unknown,
  observe: () => DialogObservation
): unknown {
  return error instanceof CommandTimeoutError
    ? wedgedRendererError(pageId, method, error, observe())
    : error;
}

/**
 * Both execution routes get the same diagnosis. A command falls back to a
 * direct WebSocket whenever the daemon holds no session for the page - which
 * includes a degraded or mid-restart daemon - and that is exactly when a clear
 * message matters, so the wrapper must not depend on which route was taken.
 */
function diagnosingTimeouts(
  pageId: string,
  exec: (method: string, params?: any, timeoutMs?: number) => Promise<any>,
  observe: () => DialogObservation
): (method: string, params?: any, timeoutMs?: number) => Promise<any> {
  return (method: string, params?: any, timeoutMs?: number) =>
    exec(method, params, timeoutMs).catch((error: unknown) => {
      throw explainCommandTimeout(pageId, method, error, observe);
    });
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
  /** Execute a CDP command. Omitting `timeoutMs` keeps the callee's own default. */
  exec: (method: string, params?: any, timeoutMs?: number) => Promise<any>;
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
  } catch (error) {
    rethrowDaemonConfigError(context, error);
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
      let dialogObservation: DialogObservation = 'unknown';
      return {
        pageId: page.id,
        ws: null,
        useDaemon: true,
        exec: diagnosingTimeouts(
          page.id,
          (method, params, timeoutMs) => daemon.execCommand(
            page.id,
            method,
            params,
            workspaceLease?.workspace,
            timeoutMs
          ),
          () => dialogObservation
        ),
        assertNoDevTools: async () => {}, // Daemon handles its own connection - no check needed
        assertNoDialog: async () => {
          const status = await daemon.getDialogStatus(page.id, context.workspaceSessionName);
          // A probe the daemon could not complete says nothing either way, so
          // it must not be recorded as "no dialog open".
          dialogObservation = status.probeUnavailable === true ? 'unknown' : 'absent';
          const blocked = dialogGuardError(status, page.id);
          if (blocked) throw blocked;
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
    // The direct route keeps `unknown`: `checkForDialog` returns null both for
    // "none open" and for a probe that reached no verdict, so nothing here
    // positively rules a dialog out.
    exec: diagnosingTimeouts(
      page.id,
      (method, params, timeoutMs) => context.sendCommand(ws, method, params, timeoutMs),
      () => 'unknown'
    ),
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
      let dialogObservation: DialogObservation = 'unknown';
      return {
        pageId: sessionPageId,
        ws: null,
        useDaemon: true,
        exec: diagnosingTimeouts(
          sessionPageId,
          (method, params, timeoutMs) => daemon.execCommand(
            sessionPageId,
            method,
            params,
            workspaceLease?.workspace,
            timeoutMs
          ),
          () => dialogObservation
        ),
        assertNoDevTools: async () => {}, // Daemon handles its own connection - no check needed
        assertNoDialog: async () => {
          const status = await daemon.getDialogStatus(sessionPageId, context.workspaceSessionName);
          dialogObservation = status.probeUnavailable === true ? 'unknown' : 'absent';
          const blocked = dialogGuardError(status, sessionPageId);
          if (blocked) throw blocked;
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
    // `unknown` for the same reason as the other direct route: nothing on this
    // path positively rules a dialog out.
    exec: diagnosingTimeouts(
      page.id,
      (method, params, timeoutMs) => context.sendCommand(ws, method, params, timeoutMs),
      () => 'unknown'
    ),
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
  } catch (error) {
    rethrowDaemonConfigError(context, error);
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
