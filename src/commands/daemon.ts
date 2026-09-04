/**
 * Daemon management commands
 */

import { DaemonClient } from '../daemon/client.js';
import { outputSuccess, outputCommandError, outputLines } from '../output.js';

/**
 * Start the daemon
 */
export async function startDaemon(options: {
  cdpUrl?: string;
  bufferSize?: number;
}): Promise<void> {
  const client = new DaemonClient({ cdpUrl: options.cdpUrl });

  try {
    const result = await client.startDaemon(options);

    if (result.started) {
      outputSuccess('Daemon started', { pid: result.pid });
    } else {
      outputSuccess('Daemon already running');
    }
  } catch (error) {
    outputCommandError(
      error,
      'DAEMON_START_FAILED',
      {}
    );
    process.exit(1);
  }
}

/**
 * Stop the daemon
 */
export async function stopDaemon(options: { cdpUrl?: string } = {}): Promise<void> {
  const client = new DaemonClient({ cdpUrl: options.cdpUrl });

  try {
    const stopped = await client.stopDaemon();

    if (stopped) {
      outputSuccess('Daemon stopped');
    } else {
      outputSuccess('Daemon not running');
    }
  } catch (error) {
    outputCommandError(
      error,
      'DAEMON_STOP_FAILED',
      {}
    );
    process.exit(1);
  }
}

/**
 * Get daemon status
 */
export async function daemonStatus(options: { cdpUrl?: string } = {}): Promise<void> {
  const client = new DaemonClient({ cdpUrl: options.cdpUrl });

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
    outputCommandError(
      error,
      'DAEMON_STATUS_FAILED',
      {}
    );
    process.exit(1);
  }
}
