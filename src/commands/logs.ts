/**
 * Log query commands - retrieve logs from daemon
 */

import { DaemonClient } from '../daemon/client.js';
import { CDPContext } from '../context.js';
import { outputLines, outputError, outputCommandError, outputSuccess } from '../output.js';

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
  const client = new DaemonClient({ cdpUrl: context.cdpUrl });

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      await context.releaseSessionLeases();
      process.exit(1);
      return;
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Get logs from daemon (0 means all)
    const logs = await client.getConsoleLogs(page.id, {
      last: options.last === 0 ? undefined : options.last,
      type: options.type,
      workspaceSession: context.workspaceSessionName
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
    outputCommandError(
      error,
      'GET_CONSOLE_LOGS_FAILED',
      { page: options.page }
    );
    await context.releaseSessionLeases();
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
    url?: string;
    method?: string;
    status?: number;
    failed?: boolean;
    since?: number;
  }
): Promise<void> {
  const client = new DaemonClient({ cdpUrl: context.cdpUrl });

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      await context.releaseSessionLeases();
      process.exit(1);
      return;
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Get logs from daemon (0 means all)
    const hasAdvancedFilter = options.url !== undefined ||
      options.method !== undefined ||
      options.status !== undefined ||
      options.failed !== undefined ||
      options.since !== undefined;
    let logs = await client.getNetworkLogs(page.id, {
      last: hasAdvancedFilter || options.last === 0 ? undefined : options.last,
      type: options.type,
      workspaceSession: context.workspaceSessionName
    });

    if (options.url) {
      logs = logs.filter(log => log.url.includes(options.url!));
    }
    if (options.method) {
      const method = options.method.toUpperCase();
      logs = logs.filter(log => log.method.toUpperCase() === method);
    }
    if (options.status !== undefined) {
      logs = logs.filter(log => log.status === options.status);
    }
    if (options.failed !== undefined) {
      logs = logs.filter(log => options.failed ? log.failure !== undefined : log.failure === undefined);
    }
    if (options.since !== undefined) {
      logs = logs.filter(log => log.timestamp >= options.since!);
    }
    if (hasAdvancedFilter && options.last !== undefined && options.last > 0) {
      logs = logs.slice(-options.last);
    }

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
        timestamp: log.timestamp,
        ...(log.failure && { failure: log.failure })
      })));
    }
  } catch (error) {
    outputCommandError(
      error,
      'GET_NETWORK_LOGS_FAILED',
      { page: options.page }
    );
    await context.releaseSessionLeases();
    process.exit(1);
  }
}

function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;

  const redacted = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key'
  ]);

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      redacted.has(name.toLowerCase()) ? '[REDACTED]' : value
    ])
  );
}

/**
 * Return the complete recorded lifecycle for one request ID. Bodies are
 * deliberately opt-in because application responses can contain customer or
 * payment-adjacent data.
 */
export async function getNetworkDetail(
  context: CDPContext,
  options: {
    page: string;
    requestId: string;
    body?: boolean;
    maxBodyBytes?: number;
  }
): Promise<void> {
  const client = new DaemonClient({ cdpUrl: context.cdpUrl });

  try {
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      await context.releaseSessionLeases();
      process.exit(1);
      return;
    }

    const page = await context.findPage(options.page);
    const matches = (await client.getNetworkLogs(page.id, {
      workspaceSession: context.workspaceSessionName
    })).filter(log => log.id === options.requestId);

    if (matches.length === 0) {
      outputError(
        `Network request ${options.requestId} not found`,
        'NETWORK_REQUEST_NOT_FOUND',
        { page: page.id, requestId: options.requestId }
      );
      await context.releaseSessionLeases();
      process.exit(1);
      return;
    }

    let body: Record<string, unknown> | undefined;
    if (options.body) {
      const result = await client.execCommand(page.id, 'Network.getResponseBody', {
        requestId: options.requestId
      }, context.workspaceSessionName
        ? { sessionName: context.workspaceSessionName }
        : undefined);
      const raw = String(result?.body ?? '');
      const maxBytes = Math.max(1, options.maxBodyBytes ?? 65_536);
      const bytes = Buffer.from(raw, result?.base64Encoded ? 'base64' : 'utf8');
      const truncated = bytes.length > maxBytes;
      const slice = bytes.subarray(0, maxBytes);
      body = {
        value: result?.base64Encoded ? slice.toString('base64') : slice.toString('utf8'),
        base64Encoded: result?.base64Encoded === true,
        bytes: bytes.length,
        truncated,
        maxBytes
      };
    }

    outputLines(matches.map((match, index) => ({
      id: match.id,
      hop: index + 1,
      hops: matches.length,
      method: match.method,
      url: match.url,
      status: match.status,
      type: match.type,
      size: match.size,
      timestamp: match.timestamp,
      requestHeaders: redactHeaders(match.requestHeaders),
      responseHeaders: redactHeaders(match.responseHeaders),
      failure: match.failure,
      ...(body && index === matches.length - 1 && { body })
    })));
  } catch (error) {
    outputCommandError(
      error,
      'GET_NETWORK_DETAIL_FAILED',
      { page: options.page, requestId: options.requestId }
    );
    await context.releaseSessionLeases();
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
  const client = new DaemonClient({ cdpUrl: context.cdpUrl });

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      await context.releaseSessionLeases();
      process.exit(1);
      return;
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Get message detail from daemon
    const message = await client.getConsoleMessageDetail(
      page.id,
      options.messageId,
      context.workspaceSessionName
    );

    if (!message) {
      outputError(
        `Message ${options.messageId} not found`,
        'MESSAGE_NOT_FOUND',
        { page: page.id, messageId: options.messageId }
      );
      await context.releaseSessionLeases();
      process.exit(1);
      return;
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
    outputCommandError(
      error,
      'GET_CONSOLE_DETAIL_FAILED',
      { page: options.page, messageId: options.messageId }
    );
    await context.releaseSessionLeases();
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
  const client = new DaemonClient({ cdpUrl: context.cdpUrl });

  try {
    // Check if daemon is running
    if (!await client.isRunning()) {
      outputError(
        'Daemon not running. Start it with: cdp-cli daemon start',
        'DAEMON_NOT_RUNNING',
        {}
      );
      await context.releaseSessionLeases();
      process.exit(1);
      return;
    }

    // Find the page to get its ID
    const page = await context.findPage(options.page);

    // Clear logs
    const cleared = await client.clearLogs(page.id, context.workspaceSessionName);

    if (cleared) {
      outputSuccess('Logs cleared', { page: page.id });
    } else {
      outputError(
        'Failed to clear logs - session may not exist',
        'CLEAR_LOGS_FAILED',
        { page: page.id }
      );
      await context.releaseSessionLeases();
      process.exit(1);
    }
  } catch (error) {
    outputCommandError(
      error,
      'CLEAR_LOGS_FAILED',
      { page: options.page }
    );
    await context.releaseSessionLeases();
    process.exit(1);
  }
}
