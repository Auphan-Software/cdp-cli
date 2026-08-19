import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { SessionFoundationError } from './errors.js';
import {
  isValidSessionName,
  type PersistedSession,
  type SessionStoreDocument
} from './types.js';

const syncFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const nodeFs = syncFs.promises;

export interface SessionFileSystem {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag: 'wx' }
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface SessionStoreOptions {
  fileSystem?: SessionFileSystem;
  temporaryId?: () => string;
  locking?: boolean;
}

export interface SessionStoreLock {
  release(): void;
}

const nodeFileSystem: SessionFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path)
};

/**
 * Strict JSON persistence for named sessions. Corrupt and browser-stale state
 * is rejected rather than silently replaced with an empty registry.
 */
export class SessionStore {
  private readonly fileSystem: SessionFileSystem;
  private readonly temporaryId: () => string;
  private readonly locking: boolean;
  private activeLock: SessionStoreLock | undefined;
  private loadedContentHash: string | null | undefined;

  constructor(
    readonly path: string,
    options: SessionStoreOptions = {}
  ) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.temporaryId = options.temporaryId ?? randomUUID;
    this.locking = options.locking ?? options.fileSystem === undefined;
  }

  async load(expectedBrowserInstanceId: string): Promise<SessionStoreDocument> {
    let serialized: string;
    try {
      serialized = await this.fileSystem.readFile(this.path, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        this.loadedContentHash = null;
        return { version: 1, sessions: [] };
      }
      throw error;
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(serialized);
    } catch (error) {
      throw new SessionFoundationError(
        'SESSION_STORE_CORRUPT',
        `Session store is not valid JSON: ${this.path}`,
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }

    const document = validateSessionStoreDocument(candidate);
    const stale = document.sessions.filter(
      (session) => session.browserInstanceId !== expectedBrowserInstanceId
    );
    if (stale.length > 0) {
      throw new SessionFoundationError(
        'SESSION_STORE_STALE',
        'Persisted sessions belong to a different browser instance',
        {
          expectedBrowserInstanceId,
          persistedBrowserInstanceIds: [
            ...new Set(stale.map((session) => session.browserInstanceId))
          ].sort()
        }
      );
    }
    this.loadedContentHash = contentHash(serialized);
    return cloneDocument(document);
  }

  /**
   * Writes a sibling temporary file exclusively, then atomically renames only
   * that exact file over the configured store path.
   */
  async save(document: SessionStoreDocument): Promise<void> {
    if (this.locking && !this.activeLock) {
      const lock = await this.acquireExclusiveLock();
      try {
        await this.saveUnlocked(document);
      } finally {
        lock.release();
      }
      return;
    }
    await this.saveUnlocked(document);
  }

  async acquireExclusiveLock(timeoutMs = 10_000): Promise<SessionStoreLock> {
    if (!this.locking) return { release: () => undefined };
    if (this.activeLock) {
      throw new SessionFoundationError('SESSION_STORE_BUSY', 'Session store lock is already held');
    }
    syncFs.mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const mutationGuardPath = `${lockPath}.guard`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let mutationGuard: SessionStoreLock | undefined;
      try {
        mutationGuard = acquireSynchronousGuard(mutationGuardPath, deadline);
        const fd = syncFs.openSync(lockPath, 'wx', 0o600);
        const lockToken = randomUUID();
        syncFs.writeSync(fd, JSON.stringify({ token: lockToken, pid: process.pid }));
        mutationGuard.release();
        mutationGuard = undefined;
        let released = false;
        const lock: SessionStoreLock = {
          release: () => {
            if (released) return;
            released = true;
            try { syncFs.closeSync(fd); } catch { /* already closed */ }
            const releaseGuard = acquireSynchronousGuard(
              mutationGuardPath,
              Date.now() + 1_000
            );
            try {
              // All create/reclaim/release mutations are serialized through
              // the short-lived guard, making token-check + delete atomic
              // with respect to a successor lock owner.
              if (readLockMetadata(lockPath)?.token === lockToken) {
                syncFs.unlinkSync(lockPath);
              }
            } catch (error) {
              if (!hasErrorCode(error, 'ENOENT')) throw error;
            } finally {
              releaseGuard.release();
            }
            if (this.activeLock === lock) this.activeLock = undefined;
          }
        };
        this.activeLock = lock;
        return lock;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          mutationGuard?.release();
          throw error;
        }
        try {
          const metadata = readLockMetadata(lockPath);
          // The store is local to this machine. Reclaim only when the owning
          // process is provably gone; elapsed time alone can misclassify a
          // live process whose event loop was paused.
          if (metadata && !processIsAlive(metadata.pid)) {
            syncFs.unlinkSync(lockPath);
            mutationGuard?.release();
            continue;
          }
        } catch (statError) {
          if (hasErrorCode(statError, 'ENOENT')) {
            mutationGuard?.release();
            continue;
          }
          mutationGuard?.release();
          throw statError;
        }
        mutationGuard?.release();
        if (Date.now() >= deadline) {
          throw new SessionFoundationError(
            'SESSION_STORE_BUSY',
            'Timed out waiting for another session-store writer',
            { path: this.path, timeoutMs }
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  async reset(options: { force?: boolean }): Promise<void> {
    if (options?.force !== true) {
      throw new SessionFoundationError(
        'SESSION_RESET_NOT_CONFIRMED',
        'Resetting persisted sessions requires force: true'
      );
    }
    this.loadedContentHash = undefined;
    await this.save({ version: 1, sessions: [] });
  }

  private async saveUnlocked(document: SessionStoreDocument): Promise<void> {
    const validated = validateSessionStoreDocument(document);
    await this.assertStoreUnchanged();
    const directory = dirname(this.path);
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${this.temporaryId()}.tmp`
    );
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;

    await this.fileSystem.mkdir(directory, { recursive: true });
    let temporaryCreated = false;
    try {
      await this.fileSystem.writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        flag: 'wx'
      });
      temporaryCreated = true;
      await this.fileSystem.rename(temporaryPath, this.path);
      temporaryCreated = false;
      this.loadedContentHash = contentHash(serialized);
    } finally {
      if (temporaryCreated) {
        try {
          await this.fileSystem.unlink(temporaryPath);
        } catch (error) {
          if (!hasErrorCode(error, 'ENOENT')) throw error;
        }
      }
    }
  }

  private async assertStoreUnchanged(): Promise<void> {
    if (this.loadedContentHash === undefined) return;
    let currentHash: string | null;
    try {
      currentHash = contentHash(await this.fileSystem.readFile(this.path, 'utf8'));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) currentHash = null;
      else throw error;
    }
    if (currentHash !== this.loadedContentHash) {
      throw new SessionFoundationError(
        'SESSION_STORE_CONFLICT',
        'Session store changed after it was loaded; reload and retry',
        { path: this.path }
      );
    }
  }
}

function readLockMetadata(path: string): { token: string; pid: number } | undefined {
  try {
    const parsed = JSON.parse(syncFs.readFileSync(path, 'utf8')) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as { token?: unknown }).token === 'string' &&
      Number.isInteger((parsed as { pid?: unknown }).pid) &&
      ((parsed as { pid: number }).pid > 0)
    ) {
      return parsed as { token: string; pid: number };
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) throw error;
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

/**
 * Serialize the tiny pathname-mutation critical section. The guard is never
 * reclaimed automatically: a process crash during these few synchronous
 * operations fails closed instead of risking two writers.
 */
function acquireSynchronousGuard(path: string, deadline: number): SessionStoreLock {
  for (;;) {
    try {
      const fd = syncFs.openSync(path, 'wx', 0o600);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try { syncFs.closeSync(fd); } catch { /* already closed */ }
          try { syncFs.unlinkSync(path); } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
          }
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      if (Date.now() >= deadline) {
        throw new SessionFoundationError(
          'SESSION_STORE_BUSY',
          'Timed out waiting for the session-store mutation guard. If its owner crashed, first confirm no cdp-cli process is using this session store, then remove this exact .guard file and retry.',
          { guardPath: path, automaticRecovery: false }
        );
      }
      // Synchronous because SessionStoreLock.release() is intentionally sync;
      // the guard is held only around a few filesystem syscalls.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

export function validateSessionStoreDocument(candidate: unknown): SessionStoreDocument {
  if (!isPlainObject(candidate) || !hasExactKeys(candidate, ['version', 'sessions'])) {
    throw corrupt('Session store must contain only version and sessions');
  }
  if (candidate.version !== 1 || !Array.isArray(candidate.sessions)) {
    throw corrupt('Unsupported session store schema');
  }

  const names = new Set<string>();
  const ownedPages = new Set<string>();
  const isolatedContexts = new Set<string>();
  const sessions = candidate.sessions.map((entry, index) => {
    const session = validatePersistedSession(entry, index);
    if (names.has(session.name)) throw corrupt(`Duplicate session name: ${session.name}`);
    names.add(session.name);
    if (session.isolation === 'isolated') {
      const contextId = session.browserContextId as string;
      if (isolatedContexts.has(contextId)) {
        throw corrupt(`Isolated browser context has multiple owners: ${contextId}`);
      }
      isolatedContexts.add(contextId);
    }
    for (const pageId of session.pageIds) {
      if (ownedPages.has(pageId)) throw corrupt(`Page has multiple owners: ${pageId}`);
      ownedPages.add(pageId);
    }
    return session;
  });

  return { version: 1, sessions };
}

function validatePersistedSession(candidate: unknown, index: number): PersistedSession {
  const keys = [
    'version',
    'name',
    'browserInstanceId',
    'browserContextId',
    'isolation',
    'createdAt',
    'updatedAt',
    'pageIds'
  ];
  if (!isPlainObject(candidate) || !hasExactKeys(candidate, keys)) {
    throw corrupt(`Session at index ${index} has unknown or missing fields`);
  }

  if (
    candidate.version !== 1 ||
    typeof candidate.name !== 'string' ||
    !isValidSessionName(candidate.name) ||
    typeof candidate.browserInstanceId !== 'string' ||
    candidate.browserInstanceId.length === 0 ||
    !(
      candidate.browserContextId === null ||
      (typeof candidate.browserContextId === 'string' && candidate.browserContextId.length > 0)
    ) ||
    !(candidate.isolation === 'isolated' || candidate.isolation === 'shared') ||
    !isTimestamp(candidate.createdAt) ||
    !isTimestamp(candidate.updatedAt) ||
    candidate.updatedAt < candidate.createdAt ||
    !Array.isArray(candidate.pageIds) ||
    !candidate.pageIds.every((pageId) => typeof pageId === 'string' && pageId.length > 0) ||
    new Set(candidate.pageIds).size !== candidate.pageIds.length
  ) {
    throw corrupt(`Invalid session at index ${index}`);
  }
  if (candidate.isolation === 'isolated' && candidate.browserContextId === null) {
    throw corrupt(`Isolated session at index ${index} has no browser context`);
  }

  return {
    version: 1,
    name: candidate.name,
    browserInstanceId: candidate.browserInstanceId,
    browserContextId: candidate.browserContextId,
    isolation: candidate.isolation,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    pageIds: [...candidate.pageIds]
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function cloneDocument(document: SessionStoreDocument): SessionStoreDocument {
  return {
    version: 1,
    sessions: document.sessions.map((session) => ({
      ...session,
      pageIds: [...session.pageIds]
    }))
  };
}

function corrupt(message: string): SessionFoundationError {
  return new SessionFoundationError('SESSION_STORE_CORRUPT', message);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
