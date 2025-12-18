/**
 * Daemon management commands
 */

import { DaemonClient } from '../daemon/client.js';
import { outputSuccess, outputError, outputLines } from '../output.js';

/**
 * Start the daemon
 */
export async function startDaemon(options: {
  cdpUrl?: string;
  bufferSize?: number;
}): Promise<void> {
  const client = new DaemonClient();

  try {
    const result = await client.startDaemon(options);

    if (result.started) {
      outputSuccess('Daemon started', { pid: result.pid });
    } else {
      outputSuccess('Daemon already running');
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'DAEMON_START_FAILED',
      {}
    );
    process.exit(1);
  }
}

/**
 * Stop the daemon
 */
export async function stopDaemon(): Promise<void> {
  const client = new DaemonClient();

  try {
    const stopped = await client.stopDaemon();

    if (stopped) {
      outputSuccess('Daemon stopped');
    } else {
      outputSuccess('Daemon not running');
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'DAEMON_STOP_FAILED',
      {}
    );
    process.exit(1);
  }
}

/**
 * Get daemon status
 */
export async function daemonStatus(): Promise<void> {
  const client = new DaemonClient();

  try {
    const status = await client.getStatus();

    if (status.running) {
      const sessions = await client.listSessions();
      outputSuccess('Daemon running', {
        sessions: sessions.length,
        details: sessions
      });
    } else {
      outputSuccess('Daemon not running');
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'DAEMON_STATUS_FAILED',
      {}
    );
    process.exit(1);
  }
}
