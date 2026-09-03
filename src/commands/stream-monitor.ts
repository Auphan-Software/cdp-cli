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

export type StreamStopReason = 'duration' | 'interrupted';

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
export function awaitStreamWindow(window: StreamWindow): Promise<StreamStopReason> {
  return new Promise<StreamStopReason>((resolve) => {
    let timer: NodeJS.Timeout | undefined;

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }

    function onSigint(): void {
      process.exitCode = 130;
      cleanup();
      resolve('interrupted');
    }

    function onSigterm(): void {
      process.exitCode = 143;
      cleanup();
      resolve('interrupted');
    }

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    if (!window.follow) {
      timer = setTimeout(() => {
        cleanup();
        resolve('duration');
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
