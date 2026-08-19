import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  SessionStore,
  WorkspaceSessionRegistry,
  type PersistedSession,
  type SessionFileSystem,
  type SessionStoreDocument
} from '../../../src/sessions/index.js';

class MemoryFileSystem implements SessionFileSystem {
  readonly files = new Map<string, string>();
  readonly operations: string[] = [];

  async readFile(path: string): Promise<string> {
    this.operations.push(`read:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw errorWithCode('ENOENT');
    return value;
  }

  async mkdir(path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`);
  }

  async writeFile(path: string, data: string, options: { flag: 'wx' }): Promise<void> {
    this.operations.push(`write:${path}:${options.flag}`);
    if (this.files.has(path)) throw errorWithCode('EEXIST');
    this.files.set(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push(`rename:${from}:${to}`);
    const value = this.files.get(from);
    if (value === undefined) throw errorWithCode('ENOENT');
    this.files.set(to, value);
    this.files.delete(from);
  }

  async unlink(path: string): Promise<void> {
    this.operations.push(`unlink:${path}`);
    if (!this.files.delete(path)) throw errorWithCode('ENOENT');
  }
}

const session = (overrides: Partial<PersistedSession> = {}): PersistedSession => ({
  version: 1,
  name: 'alpha',
  browserInstanceId: 'browser-1',
  browserContextId: 'context-alpha',
  isolation: 'isolated',
  createdAt: 10,
  updatedAt: 20,
  pageIds: ['page-1'],
  ...overrides
});

describe('SessionStore', () => {
  it('uses an exclusive sibling temporary file followed by atomic rename', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('state/sessions.json', {
      fileSystem: fs,
      temporaryId: () => 'write-1'
    });
    await store.save({ version: 1, sessions: [session()] });

    expect(fs.operations).toEqual([
      'mkdir:state',
      `write:${join('state', '.sessions.json.write-1.tmp')}:wx`,
      `rename:${join('state', '.sessions.json.write-1.tmp')}:state/sessions.json`
    ]);
    expect(JSON.parse(fs.files.get('state/sessions.json')!)).toEqual({
      version: 1,
      sessions: [session()]
    });
  });

  it('persists only the allowlisted identity metadata schema', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('sessions.json', { fileSystem: fs, temporaryId: () => 'id' });
    const unsafe = {
      version: 1,
      sessions: [{ ...session(), title: 'secret', url: 'https://secret', credentials: 'token' }]
    } as unknown as SessionStoreDocument;

    await expect(store.save(unsafe)).rejects.toMatchObject({ code: 'SESSION_STORE_CORRUPT' });
    expect(fs.files.size).toBe(0);
  });

  it('fails closed for malformed, unknown-field, and duplicate-owner stores', async () => {
    const invalidDocuments: unknown[] = [
      '{not json',
      { version: 1, sessions: [{ ...session(), logs: [] }] },
      {
        version: 1,
        sessions: [session(), session({ name: 'beta', browserContextId: 'context-beta' })]
      },
      {
        version: 1,
        sessions: [
          session(),
          session({ name: 'beta', browserContextId: 'context-alpha', pageIds: ['page-2'] })
        ]
      }
    ];

    for (const [index, invalid] of invalidDocuments.entries()) {
      const fs = new MemoryFileSystem();
      fs.files.set('sessions.json', typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
      const store = new SessionStore('sessions.json', { fileSystem: fs });
      await expect(store.load('browser-1'), `case ${index}`).rejects.toMatchObject({
        code: 'SESSION_STORE_CORRUPT'
      });
    }
  });

  it('rejects state from a stale browser instance rather than adopting its pages', async () => {
    const fs = new MemoryFileSystem();
    fs.files.set('sessions.json', JSON.stringify({ version: 1, sessions: [session()] }));
    const store = new SessionStore('sessions.json', { fileSystem: fs });

    await expect(store.load('browser-2')).rejects.toMatchObject({
      code: 'SESSION_STORE_STALE',
      details: { expectedBrowserInstanceId: 'browser-2' }
    });
  });

  it('supports restart load plus live-target reconciliation without stale page claims', async () => {
    const fs = new MemoryFileSystem();
    const store = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => 'id'
    });
    await store.save({
      version: 1,
      sessions: [session({ pageIds: ['page-1', 'closed-page'] })]
    });

    const restarted = new WorkspaceSessionRegistry({ now: () => 30 });
    const loaded = await store.load('browser-1');
    const result = restarted.reconcile(loaded.sessions, [
      { targetId: 'page-1', browserContextId: 'context-alpha' },
      { targetId: 'child', parentId: 'page-1' }
    ]);

    expect(result).toEqual({ droppedPageIds: ['closed-page'], inheritedPageIds: ['child'] });
    expect(restarted.getSession('alpha')?.pageIds).toEqual(['child', 'page-1']);
  });

  it('treats a missing store as a first-run empty document', async () => {
    const store = new SessionStore('missing.json', { fileSystem: new MemoryFileSystem() });
    await expect(store.load('browser-1')).resolves.toEqual({ version: 1, sessions: [] });
  });

  it('fails loudly instead of overwriting a snapshot changed by another writer', async () => {
    const fs = new MemoryFileSystem();
    fs.files.set('sessions.json', JSON.stringify({ version: 1, sessions: [] }));
    const first = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => 'first'
    });
    const second = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => 'second'
    });
    await first.load('browser-1');
    await second.load('browser-1');

    await first.save({ version: 1, sessions: [session()] });
    await expect(second.save({
      version: 1,
      sessions: [session({ name: 'beta', browserContextId: 'context-beta', pageIds: ['page-2'] })]
    })).rejects.toMatchObject({ code: 'SESSION_STORE_CONFLICT' });
    expect(JSON.parse(fs.files.get('sessions.json')!)).toEqual({
      version: 1,
      sessions: [session()]
    });
  });

  it('creates the lock parent safely on a first-ever write', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'cdp-cli-session-store-'));
    const path = join(temporaryRoot, 'missing', '.cdp-cli', 'sessions.json');
    try {
      const store = new SessionStore(path, { temporaryId: () => 'first' });
      await store.save({ version: 1, sessions: [] });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, sessions: [] });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('does not unlink a successor lock when an expired holder releases late', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'cdp-cli-session-store-'));
    const path = join(temporaryRoot, 'sessions.json');
    const lockPath = `${path}.lock`;
    try {
      const store = new SessionStore(path);
      const oldLock = await store.acquireExclusiveLock();
      await unlink(lockPath);
      await writeFile(lockPath, 'successor-token', { encoding: 'utf8', flag: 'wx' });

      oldLock.release();

      await expect(readFile(lockPath, 'utf8')).resolves.toBe('successor-token');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('reclaims a lock only when its owning process is provably gone', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'cdp-cli-session-store-'));
    const path = join(temporaryRoot, 'sessions.json');
    const lockPath = `${path}.lock`;
    try {
      await writeFile(lockPath, JSON.stringify({
        token: 'crashed-owner',
        pid: 2_147_483_647
      }), { encoding: 'utf8', flag: 'wx' });
      const store = new SessionStore(path);
      const recovered = await store.acquireExclusiveLock(1_000);
      recovered.release();
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('requires explicit force to reset stale browser metadata', async () => {
    const fs = new MemoryFileSystem();
    fs.files.set('sessions.json', JSON.stringify({ version: 1, sessions: [session()] }));
    const store = new SessionStore('sessions.json', {
      fileSystem: fs,
      temporaryId: () => 'reset'
    });
    await expect(store.load('browser-2')).rejects.toMatchObject({ code: 'SESSION_STORE_STALE' });
    await expect(store.reset({})).rejects.toMatchObject({
      code: 'SESSION_RESET_NOT_CONFIRMED'
    });
    await store.reset({ force: true });
    await expect(store.load('browser-2')).resolves.toEqual({ version: 1, sessions: [] });
  });
});

function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
