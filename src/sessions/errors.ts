export type SessionErrorCode =
  | 'INVALID_SESSION_NAME'
  | 'SESSION_ALREADY_EXISTS'
  | 'SESSION_NOT_FOUND'
  | 'DAEMON_URL_REQUIRED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_CONTEXT_MISMATCH'
  | 'OWNERSHIP_CONFLICT'
  | 'PAGE_NOT_OWNED'
  | 'LEASE_CONFLICT'
  | 'LEASE_NOT_FOUND'
  | 'LEASE_NOT_OWNED'
  | 'INVALID_LEASE_TTL'
  | 'SESSION_STORE_CORRUPT'
  | 'SESSION_STORE_STALE'
  | 'SESSION_STORE_BUSY'
  | 'SESSION_STORE_CONFLICT'
  | 'SESSION_RESET_NOT_CONFIRMED'
  | 'SESSION_RESET_INCOMPLETE'
  | 'CONTEXT_ALREADY_EXISTS'
  | 'CONTEXT_NOT_FOUND'
  | 'CONTEXT_DISPOSAL_NOT_CONFIRMED'
  | 'SHARED_CONTEXT_DISPOSAL_FORBIDDEN'
  | 'PROTOCOL_ERROR';

export interface StructuredSessionError {
  code: SessionErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export class SessionFoundationError extends Error implements StructuredSessionError {
  readonly code: SessionErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: SessionErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'SessionFoundationError';
    this.code = code;
    this.details = details;
  }

  toJSON(): StructuredSessionError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

export function structuredError(
  code: SessionErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>
): StructuredSessionError {
  return { code, message, ...(details === undefined ? {} : { details }) };
}
