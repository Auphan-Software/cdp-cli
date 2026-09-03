/**
 * Network inspection commands
 */

import { CDPContext, NetworkRequest } from '../context.js';
import { outputLine, outputError } from '../output.js';
import {
  awaitStreamWindow,
  outputStreamStopped,
  resolveStreamWindow,
  type StreamWindowOptions
} from './stream-monitor.js';

/**
 * Stream live network events for a bounded window (or until interrupted with
 * `--follow`). Passive monitor: no exclusive workspace lease is held.
 */
export async function listNetwork(
  context: CDPContext,
  options: { type?: string; page: string } & StreamWindowOptions
): Promise<void> {
  let ws;
  try {
    const window = resolveStreamWindow(options, 'list-network');

    // Get page to monitor
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    // Connect and enable Network domain
    ws = await context.connect(page, { lease: false });

    context.setupNetworkCollection(
      ws,
      (request: NetworkRequest, event) => {
        if (options.type && request.type !== options.type) {
          return;
        }

        outputLine({
          event,
          url: request.url,
          method: request.method,
          ...(request.status !== undefined && { status: request.status }),
          ...(request.type && { type: request.type }),
          ...(request.size !== undefined && { size: request.size }),
          ...(request.failure && { failure: request.failure }),
          timestamp: request.timestamp
        });
      }
    );
    await context.sendCommand(ws, 'Network.enable');

    const reason = await awaitStreamWindow(window);
    outputStreamStopped('list-network', window, reason);
  } catch (error) {
    outputError(
      (error as Error).message,
      (error as { code?: string }).code ?? 'LIST_NETWORK_FAILED'
    );
    if (ws) {
      ws.close();
    }
    await context.releaseSessionLeases();
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
    await context.releaseSessionLeases();
  }
}
