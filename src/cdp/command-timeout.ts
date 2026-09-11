/**
 * Shared error type and validation for the CDP command round-trip timeout.
 * Used by both the direct (context.ts) and daemon (page-session.ts) send paths
 * so callers can distinguish "command timed out" from any other failure.
 */

export class CommandTimeoutError extends Error {
  readonly code = 'COMMAND_TIMEOUT';
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    // Message text must stay exactly this: existing tests assert on it.
    super(`Command timeout: ${method}`);
    this.name = 'CommandTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
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
