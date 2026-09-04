import { SessionFoundationError, structuredError, type StructuredSessionError } from './errors.js';
import {
  isValidSessionName,
  systemClock,
  type Clock,
  type PersistedSession,
  type SessionMetadata,
  type SessionRegistration,
  type TargetIdentity
} from './types.js';

export type PageAccessResult =
  | { ok: true; pageId: string; owner: string; rootTargetId: string }
  | { ok: false; error: StructuredSessionError };

export interface ReconciliationResult {
  droppedPageIds: string[];
  inheritedPageIds: string[];
}

interface MutableSession extends Omit<PersistedSession, 'pageIds'> {
  pageIds: Set<string>;
}

/**
 * In-memory authority for named workspaces and target ownership.
 *
 * Ownership inheritance is identity-only. A target can inherit from exact CDP
 * parent/opener/frame IDs or an unambiguous browser-context ID. Human-readable
 * target metadata is intentionally absent from this API.
 */
export class WorkspaceSessionRegistry {
  private readonly clock: Clock;
  private sessions = new Map<string, MutableSession>();
  private targetOwners = new Map<string, string>();
  private targetRoots = new Map<string, string>();
  private rootOwners = new Map<string, string>();
  private targets = new Map<string, TargetIdentity>();
  private frameTargets = new Map<string, string>();

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  createSession(registration: SessionRegistration): SessionMetadata {
    validateRegistration(registration);
    if (this.sessions.has(registration.name)) {
      throw new SessionFoundationError(
        'SESSION_ALREADY_EXISTS',
        `Session already exists: ${registration.name}`,
        { sessionName: registration.name }
      );
    }

    const isolation = registration.isolation ?? 'isolated';
    if (isolation === 'isolated') {
      const contextOwner = [...this.sessions.values()].find(
        (session) =>
          session.isolation === 'isolated' &&
          session.browserContextId === registration.browserContextId
      );
      if (contextOwner) {
        throw new SessionFoundationError(
          'OWNERSHIP_CONFLICT',
          `Isolated browser context is already owned by session ${contextOwner.name}`,
          {
            browserContextId: registration.browserContextId,
            requestedOwner: registration.name,
            currentOwner: contextOwner.name
          }
        );
      }
    }

    const now = this.clock.now();
    const createdAt = registration.createdAt ?? now;
    const updatedAt = registration.updatedAt ?? createdAt;
    validateTimestamps(createdAt, updatedAt);
    const session: MutableSession = {
      version: 1,
      name: registration.name,
      browserInstanceId: registration.browserInstanceId,
      browserContextId: registration.browserContextId,
      isolation,
      createdAt,
      updatedAt,
      pageIds: new Set()
    };
    this.sessions.set(session.name, session);

    try {
      if (registration.pageIds) {
        for (const pageId of registration.pageIds) {
          this.claimExactTarget(session.name, pageId, pageId);
        }
      }
    } catch (error) {
      this.removeSession(session.name);
      throw error;
    }
    return toMetadata(session);
  }

  getSession(name: string): SessionMetadata | undefined {
    const session = this.sessions.get(name);
    return session ? toMetadata(session) : undefined;
  }

  listSessions(): SessionMetadata[] {
    return [...this.sessions.values()]
      .map(toMetadata)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  removeSession(name: string): SessionMetadata {
    const session = this.requireSession(name);
    for (const pageId of session.pageIds) {
      this.targetOwners.delete(pageId);
      this.targetRoots.delete(pageId);
    }
    for (const [rootTargetId, owner] of this.rootOwners) {
      if (owner === name) this.rootOwners.delete(rootTargetId);
    }
    this.sessions.delete(name);
    return toMetadata(session);
  }

  /**
   * Explicitly adopts an observed target by exact ID. Callers cannot pass a
   * title, URL, prefix, or fuzzy selector through this contract.
   */
  adoptTarget(
    sessionName: string,
    targetId: string,
    observedTargets: readonly TargetIdentity[]
  ): SessionMetadata {
    this.requireSession(sessionName);
    this.observeIdentities(observedTargets);
    const target = this.targets.get(targetId);
    if (!target) {
      throw new SessionFoundationError('TARGET_NOT_FOUND', `Target not found: ${targetId}`, {
        targetId,
        exactMatchRequired: true
      });
    }

    const candidates = this.inheritanceCandidates(target);
    if (candidates.size > 1 || (candidates.size === 1 && !candidates.has(sessionName))) {
      throw this.ownershipConflict(targetId, sessionName, candidates);
    }

    const rootTargetId = this.structuralRoot(target);
    this.claimExactTarget(sessionName, targetId, rootTargetId);
    return toMetadata(this.requireSession(sessionName));
  }

  /**
   * Records target identities and assigns all targets whose exact relationships
   * yield one unambiguous owner. Conflicting signals fail closed.
   */
  observeTargets(observedTargets: readonly TargetIdentity[]): string[] {
    this.observeIdentities(observedTargets);
    const inherited: string[] = [];
    let progressed = true;

    while (progressed) {
      progressed = false;
      for (const target of this.targets.values()) {
        if (this.targetOwners.has(target.targetId)) continue;
        const candidates = this.inheritanceCandidates(target);
        if (candidates.size > 1) {
          throw this.ownershipConflict(target.targetId, undefined, candidates);
        }
        const [owner] = candidates;
        if (!owner) continue;
        this.claimExactTarget(owner, target.targetId, this.structuralRoot(target));
        inherited.push(target.targetId);
        progressed = true;
      }
    }
    return inherited;
  }

  checkPageAccess(sessionName: string, pageId: string): PageAccessResult {
    if (!this.sessions.has(sessionName)) {
      // An unknown session is a configuration or endpoint problem (for example
      // a daemon serving a different Chrome). Reporting it as PAGE_NOT_OWNED
      // would tell the caller its ownership was lost when it never existed here.
      return {
        ok: false,
        error: structuredError('SESSION_NOT_FOUND', `Session not found: ${sessionName}`, {
          sessionName,
          pageId
        })
      };
    }
    const actualOwner = this.targetOwners.get(pageId);
    if (actualOwner === sessionName) {
      return {
        ok: true,
        pageId,
        owner: sessionName,
        rootTargetId: this.targetRoots.get(pageId) ?? pageId
      };
    }

    return {
      ok: false,
      error: structuredError(
        'PAGE_NOT_OWNED',
        `Page ${pageId} is not owned by session ${sessionName}`,
        {
          sessionName,
          pageId,
          ...(actualOwner === undefined ? {} : { actualOwner })
        }
      )
    };
  }

  assertPageAccess(sessionName: string, pageId: string): Extract<PageAccessResult, { ok: true }> {
    const result = this.checkPageAccess(sessionName, pageId);
    if (!result.ok) {
      throw new SessionFoundationError(
        result.error.code,
        result.error.message,
        result.error.details
      );
    }
    return result;
  }

  getOwner(pageId: string): string | undefined {
    return this.targetOwners.get(pageId);
  }

  /** Atomically replaces registry state from a validated store snapshot. */
  reconcile(
    persistedSessions: readonly PersistedSession[],
    liveTargets: readonly TargetIdentity[]
  ): ReconciliationResult {
    const next = new WorkspaceSessionRegistry(this.clock);
    const liveIds = new Set(liveTargets.map((target) => target.targetId));
    const droppedPageIds: string[] = [];

    for (const session of persistedSessions) {
      next.createSession({
        ...session,
        pageIds: undefined
      });
    }
    next.observeIdentities(liveTargets);

    const persistedLiveIds = new Set<string>();
    for (const session of persistedSessions) {
      for (const pageId of session.pageIds) {
        if (!liveIds.has(pageId)) {
          droppedPageIds.push(pageId);
          continue;
        }
        persistedLiveIds.add(pageId);
        next.adoptTarget(session.name, pageId, liveTargets);
      }
    }

    const inheritedPageIds = next
      .observeTargets(liveTargets)
      .filter((pageId) => !persistedLiveIds.has(pageId));

    this.sessions = next.sessions;
    this.targetOwners = next.targetOwners;
    this.targetRoots = next.targetRoots;
    this.rootOwners = next.rootOwners;
    this.targets = next.targets;
    this.frameTargets = next.frameTargets;

    return {
      droppedPageIds: [...new Set(droppedPageIds)].sort(),
      inheritedPageIds: [...new Set(inheritedPageIds)].sort()
    };
  }

  private observeIdentities(observedTargets: readonly TargetIdentity[]): void {
    for (const target of observedTargets) {
      if (!target.targetId) {
        throw new SessionFoundationError('TARGET_NOT_FOUND', 'Target ID must not be empty');
      }
      this.targets.set(target.targetId, { ...target });
      if (target.frameId) this.frameTargets.set(target.frameId, target.targetId);
    }
  }

  private inheritanceCandidates(target: TargetIdentity): Set<string> {
    const candidates = new Set<string>();
    const rootOwner = this.rootOwners.get(this.structuralRoot(target));
    if (rootOwner) candidates.add(rootOwner);
    for (const relationId of [target.parentId, target.openerId]) {
      if (!relationId) continue;
      const owner = this.targetOwners.get(relationId);
      if (owner) candidates.add(owner);
    }
    if (target.parentFrameId) {
      const parentTargetId = this.frameTargets.get(target.parentFrameId) ?? target.parentFrameId;
      const owner = this.targetOwners.get(parentTargetId);
      if (owner) candidates.add(owner);
    }
    if (target.browserContextId) {
      for (const session of this.sessions.values()) {
        if (session.browserContextId === target.browserContextId) candidates.add(session.name);
      }
    }
    return candidates;
  }

  private structuralRoot(target: TargetIdentity): string {
    let current = target;
    const seen = new Set<string>();
    while (!seen.has(current.targetId)) {
      seen.add(current.targetId);
      const relationId = current.parentId ?? current.openerId ?? (
        current.parentFrameId
          ? this.frameTargets.get(current.parentFrameId) ?? current.parentFrameId
          : undefined
      );
      if (!relationId) break;
      const related = this.targets.get(relationId);
      if (!related) return relationId;
      current = related;
    }
    return current.targetId;
  }

  private claimExactTarget(sessionName: string, targetId: string, rootTargetId: string): void {
    const session = this.requireSession(sessionName);
    const owner = this.targetOwners.get(targetId);
    if (owner && owner !== sessionName) {
      throw this.ownershipConflict(targetId, sessionName, new Set([owner]));
    }

    const rootOwner = this.rootOwners.get(rootTargetId);
    if (rootOwner && rootOwner !== sessionName) {
      throw this.ownershipConflict(rootTargetId, sessionName, new Set([rootOwner]));
    }

    this.targetOwners.set(targetId, sessionName);
    this.targetRoots.set(targetId, rootTargetId);
    this.rootOwners.set(rootTargetId, sessionName);
    session.pageIds.add(targetId);
    session.updatedAt = this.clock.now();
  }

  private requireSession(name: string): MutableSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new SessionFoundationError('SESSION_NOT_FOUND', `Session not found: ${name}`, {
        sessionName: name
      });
    }
    return session;
  }

  private ownershipConflict(
    targetId: string,
    requestedOwner: string | undefined,
    candidates: Set<string>
  ): SessionFoundationError {
    return new SessionFoundationError(
      'OWNERSHIP_CONFLICT',
      `Target ${targetId} has conflicting ownership`,
      {
        targetId,
        ...(requestedOwner === undefined ? {} : { requestedOwner }),
        candidateOwners: [...candidates].sort()
      }
    );
  }
}

function validateRegistration(registration: SessionRegistration): void {
  if (!isValidSessionName(registration.name)) {
    throw new SessionFoundationError(
      'INVALID_SESSION_NAME',
      `Invalid session name: ${registration.name}`,
      { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }
    );
  }
  if (!registration.browserInstanceId) {
    throw new SessionFoundationError('SESSION_STORE_CORRUPT', 'Browser instance ID must not be empty');
  }
  if ((registration.isolation ?? 'isolated') === 'isolated' && !registration.browserContextId) {
    throw new SessionFoundationError(
      'SESSION_STORE_CORRUPT',
      'An isolated session requires a browser context ID'
    );
  }
}

function validateTimestamps(createdAt: number, updatedAt: number): void {
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt) ||
    createdAt < 0 ||
    updatedAt < createdAt
  ) {
    throw new SessionFoundationError(
      'SESSION_STORE_CORRUPT',
      'Session timestamps must be finite, non-negative, and ordered'
    );
  }
}

function toMetadata(session: MutableSession): SessionMetadata {
  return {
    version: 1,
    name: session.name,
    browserInstanceId: session.browserInstanceId,
    browserContextId: session.browserContextId,
    isolation: session.isolation,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pageIds: [...session.pageIds].sort()
  };
}
