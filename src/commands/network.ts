/**
 * Network inspection commands
 */

import { CDPContext, NetworkRequest } from '../context.js';
import { outputLine, outputError } from '../output.js';
import {
  awaitStreamWindow,
  outputStreamStopped,
  resolveStreamWindow,
  withSetupDeadline,
  type MonitorSocket,
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
  let ws: Awaited<ReturnType<typeof context.connect>> | undefined;
  let pageId: string | undefined;
  try {
    const window = resolveStreamWindow(options, 'list-network');

    // The bounded window only starts once we are listening, so bound the
    // connection phase too.
    ws = await withSetupDeadline(
      (async () => {
        const page = await context.findPage(options.page);
        pageId = page.id;
        await context.ensureDaemonPageSession(page);
        await context.assertNoDevTools(page.id);

        // Passive monitor: assert ownership, but take no exclusive lease.
        const socket = await context.connect(page, { lease: false });

        context.setupNetworkCollection(
          socket,
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
          },
          { retain: false }
        );
        await context.sendCommand(socket, 'Network.enable');
        return socket;
      })(),
      'list-network'
    );

    const reason = await awaitStreamWindow(window, {
      socket: ws as unknown as MonitorSocket,
      ...(context.workspaceSessionName
        ? { revalidate: () => context.assertSessionTargetAccess(pageId as string) }
        : {})
    });
    outputStreamStopped('list-network', window, reason);
  } catch (error) {
    outputError(
      (error as Error).message,
      (error as { code?: string }).code ?? 'LIST_NETWORK_FAILED'
    );
    if (ws) {
      ws.close();
    }
    process.exit(1);
  } finally {
    // A passive monitor holds no lease of its own, so it must not release
    // leases another operation on this context may still hold.
    if (ws) {
      ws.close();
    }
  }
}
