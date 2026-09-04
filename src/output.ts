/**
 * NDJSON output formatter for LLM-friendly CLI output
 * Each line is a complete JSON object for easy parsing and grep compatibility
 */

export interface OutputOptions {
  pretty?: boolean;
}

/**
 * Output a single line of NDJSON
 */
export function outputLine(data: any, options: OutputOptions = {}): void {
  const json = options.pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);

  console.log(json);
}

/**
 * Output multiple lines of NDJSON (one JSON object per line)
 */
export function outputLines(data: any[], options: OutputOptions = {}): void {
  for (const item of data) {
    outputLine(item, options);
  }
}

/**
 * Output an error in NDJSON format
 */
export function outputError(message: string, code?: string, details?: any): void {
  const errorObj: any = {
    error: true,
    message,
    code: code || 'ERROR'
  };
  if (details) {
    errorObj.details = details;
  }
  console.log(JSON.stringify(errorObj));
}

/** Serializable view of a thrown error and its `cause` chain. */
export interface ErrorCause {
  code?: string;
  message: string;
  details?: unknown;
  cause?: ErrorCause;
}

const MAX_CAUSE_DEPTH = 3;
const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_ENTRIES = 50;
const MAX_DETAIL_STRING = 2000;

/**
 * Copy arbitrary error `details` into a bounded, cycle-safe, JSON-safe value so
 * that reporting a failure can never itself throw or flood the NDJSON stream.
 */
export function sanitizeDetails(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_DETAIL_STRING
        ? `${value.slice(0, MAX_DETAIL_STRING)}...[truncated ${value.length - MAX_DETAIL_STRING} chars]`
        : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(value);
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) return '[Circular]';
  if (depth >= MAX_DETAIL_DEPTH) return '[Truncated]';
  seen.add(object);
  try {
    if (object instanceof Error) {
      return describeErrorCause(object, MAX_CAUSE_DEPTH);
    }
    if (Array.isArray(object)) {
      const items = object.slice(0, MAX_DETAIL_ENTRIES).map((item) => sanitizeDetails(item, depth + 1, seen));
      if (object.length > MAX_DETAIL_ENTRIES) items.push(`...[${object.length - MAX_DETAIL_ENTRIES} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(object);
    for (const key of keys.slice(0, MAX_DETAIL_ENTRIES)) {
      let entry: unknown;
      try {
        entry = (object as Record<string, unknown>)[key];
      } catch {
        entry = '[Unserializable]';
      }
      if (entry === undefined) continue;
      out[key] = sanitizeDetails(entry, depth + 1, seen);
    }
    if (keys.length > MAX_DETAIL_ENTRIES) out['...'] = `[${keys.length - MAX_DETAIL_ENTRIES} more keys]`;
    return out;
  } finally {
    seen.delete(object);
  }
}

/**
 * Describe an error for NDJSON output, keeping any structured `code`,
 * `details`, and nested `cause` (for example a SessionFoundationError from the
 * daemon, or the ECONNREFUSED under a "fetch failed" TypeError).
 */
export function describeErrorCause(error: unknown, depth = 0): ErrorCause | undefined {
  if (error === undefined || error === null) return undefined;
  if (!(error instanceof Error)) return { message: String(error) };
  const { code, details } = error as { code?: unknown; details?: unknown };
  const { cause } = error as { cause?: unknown };
  const nested = depth < MAX_CAUSE_DEPTH ? describeErrorCause(cause, depth + 1) : undefined;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    message: error.message,
    ...(details === undefined ? {} : { details: sanitizeDetails(details) }),
    ...(nested === undefined ? {} : { cause: nested })
  };
}

/**
 * Output a command-level failure that wraps a thrown error. The top-level
 * `code` stays the command's wrapper code so callers keyed on it keep working,
 * while `details.cause` retains the actionable underlying code and details.
 */
export function outputCommandError(
  error: unknown,
  code: string,
  details?: Record<string, unknown>
): void {
  const cause = describeErrorCause(error);
  const actionable = cause !== undefined
    && (cause.code !== undefined || cause.details !== undefined || cause.cause !== undefined);
  const merged = { ...details, ...(actionable ? { cause } : {}) };
  outputError(
    error instanceof Error ? error.message : String(error),
    code,
    Object.keys(merged).length > 0 ? merged : undefined
  );
}

/**
 * Output a success message in NDJSON format
 */
export function outputSuccess(message: string, data?: any): void {
  outputLine({
    success: true,
    message,
    ...(data && { data })
  });
}

/**
 * Output raw text (not NDJSON) - used for screenshots, snapshots, etc.
 */
export function outputRaw(text: string): void {
  console.log(text);
}
