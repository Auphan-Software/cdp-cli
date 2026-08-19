export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type SessionIsolation = 'isolated' | 'shared';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now()
};

/**
 * Identity-only target metadata used for ownership decisions. Deliberately
 * excludes titles and URLs: neither is a stable identity or trust signal.
 */
export interface TargetIdentity {
  targetId: string;
  browserContextId?: string;
  parentId?: string;
  parentFrameId?: string;
  openerId?: string;
  frameId?: string;
}

/** The complete, intentionally small on-disk session schema. */
export interface PersistedSession {
  version: 1;
  name: string;
  browserInstanceId: string;
  browserContextId: string | null;
  isolation: SessionIsolation;
  createdAt: number;
  updatedAt: number;
  pageIds: string[];
}

export interface SessionStoreDocument {
  version: 1;
  sessions: PersistedSession[];
}

export interface SessionRegistration {
  name: string;
  browserInstanceId: string;
  browserContextId: string | null;
  isolation?: SessionIsolation;
  createdAt?: number;
  updatedAt?: number;
  pageIds?: readonly string[];
}

export interface SessionMetadata extends PersistedSession {}

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name);
}

