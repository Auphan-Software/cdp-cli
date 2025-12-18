/**
 * Log query commands - retrieve logs from daemon
 */

import { DaemonClient } from '../daemon/client.js';
import { CDPContext } from '../context.js';
import { outputLines, outputError, outputSuccess } from '../output.js';

/**
 * Get console logs from daemon
 */
export async function getConsoleLogs(
  context: CDPContext,
  options: {
    page: string;
    last?: number;
    type?: string;
  }
): Promise<void> {
  const client = new DaemonClient();

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      process.exit(1);
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Get logs from daemon (0 means all)
    const logs = await client.getConsoleLogs(page.id, {
      last: options.last === 0 ? undefined : options.last,
      type: options.type
    });

    if (logs.length === 0) {
      outputSuccess('No console logs', { page: page.id });
    } else {
      outputLines(logs.map(log => ({
        id: log.id,
        type: log.type,
        text: log.text,
        timestamp: log.timestamp,
        source: log.source,
        ...(log.line !== undefined && { line: log.line }),
        ...(log.url && { url: log.url })
      })));
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'GET_CONSOLE_LOGS_FAILED',
      { page: options.page }
    );
    process.exit(1);
  }
}

/**
 * Get network logs from daemon
 */
export async function getNetworkLogs(
  context: CDPContext,
  options: {
    page: string;
    last?: number;
    type?: string;
  }
): Promise<void> {
  const client = new DaemonClient();

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      process.exit(1);
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Get logs from daemon (0 means all)
    const logs = await client.getNetworkLogs(page.id, {
      last: options.last === 0 ? undefined : options.last,
      type: options.type
    });

    if (logs.length === 0) {
      outputSuccess('No network logs', { page: page.id });
    } else {
      outputLines(logs.map(log => ({
        id: log.id,
        method: log.method,
        url: log.url,
        status: log.status,
        type: log.type,
        size: log.size,
        timestamp: log.timestamp
      })));
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'GET_NETWORK_LOGS_FAILED',
      { page: options.page }
    );
    process.exit(1);
  }
}

/**
 * Get detailed console message with stack trace
 */
export async function getConsoleDetail(
  context: CDPContext,
  options: {
    page: string;
    messageId: number;
  }
): Promise<void> {
  const client = new DaemonClient();

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      process.exit(1);
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Get message detail from daemon
    const message = await client.getConsoleMessageDetail(page.id, options.messageId);

    if (!message) {
      outputError(
        `Message ${options.messageId} not found`,
        'MESSAGE_NOT_FOUND',
        { page: page.id, messageId: options.messageId }
      );
      process.exit(1);
    }

    // Output full message with stack trace
    outputLines([{
      id: message.id,
      type: message.type,
      text: message.text,
      timestamp: message.timestamp,
      source: message.source,
      ...(message.line !== undefined && { line: message.line }),
      ...(message.url && { url: message.url }),
      ...(message.stackTrace && { stackTrace: message.stackTrace }),
      ...(message.args && { args: message.args })
    }]);
  } catch (error) {
    outputError(
      (error as Error).message,
      'GET_CONSOLE_DETAIL_FAILED',
      { page: options.page, messageId: options.messageId }
    );
    process.exit(1);
  }
}

/**
 * Clear logs for a page
 */
export async function clearLogs(
  context: CDPContext,
  options: { page: string }
): Promise<void> {
  const client = new DaemonClient();

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      process.exit(1);
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Clear logs
    const cleared = await client.clearLogs(page.id);

    if (cleared) {
      outputSuccess('Logs cleared', { page: page.id });
    } else {
      outputError(
        'Failed to clear logs - session may not exist',
        'CLEAR_LOGS_FAILED',
        { page: page.id }
      );
      process.exit(1);
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'CLEAR_LOGS_FAILED',
      { page: options.page }
    );
    process.exit(1);
  }
}
