/**
 * Shared window and signal handling for passive event monitors
 * (`list-network`, `list-console`).
 *
 * These commands only enable a CDP domain and print the events Chrome pushes.
 * They must never stream forever by accident: a bare invocation collects a
 * bounded window, and unbounded streaming requires the explicit `--follow`
 * opt-in. They also must not hold the exclusive workspace operation lease,
 * so a force-killed monitor cannot wedge ordinary commands until the lease
 * TTL expires.
 */

import { outputLine } from '../output.js';

/** Bounded default window for a bare `list-network` / `list-console` call. */
export const DEFAULT_STREAM_DURATION_SECONDS = 30;

/** Upper bound for a bounded window; longer runs must opt into `--follow`. */
export const MAX_STREAM_DURATION_SECONDS = 3600;

export interface StreamWindowOptions {
  duration?: number;
  follow?: boolean;
}

export type StreamWindow =
  | { follow: true }
  | { follow: false; durationSeconds: number };

export type StreamStopReason =
  | 'duration'
  | 'interrupted'
  | 'disconnected'
  | 'ownership-revoked';

/** Total wall-clock bound for connecting before the collection window starts. */
export const SETUP_DEADLINE_SECONDS = 30;

/** How often a running monitor re-checks that its session still owns the page. */
export const OWNERSHIP_RECHECK_INTERVAL_MS = 10_000;

/** Minimal view of the monitor's socket; keeps this module free of a ws import. */
export interface MonitorSocket {
  on(event: 'close' | 'error', listener: () => void): unknown;
  off(event: 'close' | 'error', listener: () => void): unknown;
}

export interface StreamStopSignals {
  /** Settle when Chrome closes the target or the connection breaks. */
  socket?: MonitorSocket;
  /** Re-assert that the named session still owns the page while monitoring. */
  revalidate?: () => Promise<void>;
  revalidateIntervalMs?: number;
}

export class StreamMonitorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StreamMonitorError';
    this.code = code;
  }
}

/**
 * Bound the connection phase too. Without this, a hung fetch or WebSocket
 * handshake would leave a "bounded" invocation running indefinitely before the
 * collection window ever starts.
 */
export async function withSetupDeadline<T>(
  operation: Promise<T>,
  command: string,
  seconds: number = SETUP_DEADLINE_SECONDS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new StreamMonitorError(
              'STREAM_SETUP_TIMEOUT',
              `${command}: timed out after ${seconds}s while connecting to the page.`
            )
          );
        }, seconds * 1000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class StreamOptionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StreamOptionError';
    this.code = code;
  }
}

/**
 * Resolve the requested collection window.
 *
 * `--duration 0` used to mean "stream until interrupted". That implicit
 * forever behavior is gone: it is now a hard error that names `--follow`.
 */
export function resolveStreamWindow(
  options: StreamWindowOptions,
  command: string
): StreamWindow {
  const follow = options.follow === true;
  const durationProvided = options.duration !== undefined;

  if (follow && durationProvided) {
    throw new StreamOptionError(
      'STREAM_OPTIONS_CONFLICT',
      `${command}: --follow and --duration are mutually exclusive. ` +
        'Use --duration for a bounded window, or --follow to stream until interrupted.'
    );
  }

  if (follow) {
    return { follow: true };
  }

  if (!durationProvided) {
    return { follow: false, durationSeconds: DEFAULT_STREAM_DURATION_SECONDS };
  }

  const duration = options.duration as number;
  if (!Number.isFinite(duration)) {
    throw new StreamOptionError(
      'STREAM_DURATION_INVALID',
      `${command}: --duration must be a number of seconds.`
    );
  }
  if (duration <= 0) {
    throw new StreamOptionError(
      'STREAM_DURATION_INVALID',
      `${command}: --duration must be greater than 0. ` +
        'Unbounded streaming now requires --follow, and buffered history is available ' +
        'from the daemon with `cdp-cli logs network` / `cdp-cli logs console`.'
    );
  }
  if (duration > MAX_STREAM_DURATION_SECONDS) {
    throw new StreamOptionError(
      'STREAM_DURATION_INVALID',
      `${command}: --duration must be at most ${MAX_STREAM_DURATION_SECONDS} seconds. ` +
        'Use --follow for an unbounded stream.'
    );
  }

  return { follow: false, durationSeconds: duration };
}

/**
 * Wait for the collection window to close.
 *
 * Resolves when the bounded window elapses, or when SIGINT/SIGTERM arrives.
 * Signal handlers are always removed so the process exits normally and the
 * caller's `finally` block runs its cleanup.
 */
export function awaitStreamWindow(
  window: StreamWindow,
  signals: StreamStopSignals = {}
): Promise<StreamStopReason> {
  return new Promise<StreamStopReason>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let recheck: NodeJS.Timeout | undefined;
    let settled = false;

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      if (recheck) clearInterval(recheck);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      signals.socket?.off('close', onDisconnect);
      signals.socket?.off('error', onDisconnect);
    }

    function stop(reason: StreamStopReason, exitCode?: number): void {
      if (settled) return;
      settled = true;
      if (exitCode !== undefined) process.exitCode = exitCode;
      cleanup();
      resolve(reason);
    }

    function onSigint(): void {
      stop('interrupted', 130);
    }

    function onSigterm(): void {
      stop('interrupted', 143);
    }

    // Chrome closing the target, or a broken connection, must end the monitor
    // rather than leave a --follow process waiting forever on a dead socket.
    function onDisconnect(): void {
      stop('disconnected');
    }

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    signals.socket?.on('close', onDisconnect);
    signals.socket?.on('error', onDisconnect);

    // A monitor holds no lease, so ownership can be revoked underneath it
    // (session remove/reset, or a page adopted by another session).
    if (signals.revalidate) {
      const revalidate = signals.revalidate;
      recheck = setInterval(() => {
        void revalidate().catch(() => {
          stop('ownership-revoked', 1);
        });
      }, signals.revalidateIntervalMs ?? OWNERSHIP_RECHECK_INTERVAL_MS);
      recheck.unref?.();
    }

    if (!window.follow) {
      timer = setTimeout(() => {
        stop('duration');
      }, window.durationSeconds * 1000);
    }
  });
}

/** Emit the terminating NDJSON line so callers can tell a clean stop from a kill. */
export function outputStreamStopped(
  command: string,
  window: StreamWindow,
  reason: StreamStopReason
): void {
  outputLine({
    event: 'monitor-stopped',
    command,
    reason,
    follow: window.follow,
    ...(window.follow ? {} : { durationSeconds: window.durationSeconds })
  });
}

/**
 * Command descriptions. Kept here so the help text that routes agents to the
 * daemon-backed queries is a tested constant rather than a loose string.
 */
export const LIST_NETWORK_DESCRIPTION =
  'Stream live network events for a bounded window (default 30s). ' +
  'Use `logs network` to query buffered requests; --follow streams until interrupted.';

export const LIST_CONSOLE_DESCRIPTION =
  'Stream live console messages for a bounded window (default 30s). ' +
  'Use `logs console` to query buffered logs; --follow streams until interrupted.';
