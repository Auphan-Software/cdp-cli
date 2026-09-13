/**
 * Shared error type and validation for the CDP command round-trip timeout.
 * Used by both the direct (context.ts) and daemon (page-session.ts) send paths
 * so callers can distinguish "command timed out" from any other failure.
 */

export class CommandTimeoutError extends Error {
  readonly code = 'COMMAND_TIMEOUT';
  readonly method: string;
  readonly timeoutMs: number;
  /** Which phase consumed the cap. Command-round-trip timeouts (the only
   * thing this class currently models) are always 'command'; kept as an
   * explicit field so callers/tests can name the phase without guessing it
   * from context, and so a future connect-phase timeout type can reuse the
   * same shape. */
  readonly phase = 'command' as const;
  /** Surfaced by `describeErrorCause` (src/output.ts) into every command's
   * `outputCommandError(...)` cause payload, so ANY command that routes its
   * catch block through outputCommandError automatically reports the cap and
   * phase under `cause.details` instead of losing them behind a generic
   * top-level failure code. */
  readonly details: { method: string; timeoutMs: number; phase: 'command' };

  constructor(method: string, timeoutMs: number) {
    // Message text must stay exactly this: existing tests assert on it.
    super(`Command timeout: ${method}`);
    this.name = 'CommandTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.details = { method, timeoutMs, phase: this.phase };
  }
}

export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Validate a caller-supplied `--timeout` value.
 * Returns null when valid, otherwise a human-readable reason it was refused.
 */
export function validateCommandTimeout(value: unknown): string | null {
  if (
    typeof value !== 'number'
    || Number.isNaN(value)
    || !Number.isInteger(value)
    || value <= 0
    || value > MAX_COMMAND_TIMEOUT_MS
  ) {
    return `--timeout must be a whole number of milliseconds between 1 and ${MAX_COMMAND_TIMEOUT_MS} (got: ${value})`;
  }
  return null;
}
