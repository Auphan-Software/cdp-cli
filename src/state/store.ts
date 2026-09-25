import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PageState } from './types.js';

interface Index { seq: number; aliases: Record<string, string>; captures: string[] }

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function atomicWrite(path: string, value: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}

export class StateStore {
  readonly dir: string;
  private readonly key: Buffer;
  constructor(endpoint: string, session: string | undefined, targetId: string,
    root = join(homedir(), '.cdp-cli', 'state'), private readonly maxCaptures = 200) {
    const endpointKey = createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
    this.dir = join(root, endpointKey, safePart(session ?? '_anonymous'), safePart(targetId));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const keyFile = join(root, '.hmac-key');
    if (!existsSync(keyFile)) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      try { writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    this.key = readFileSync(keyFile);
  }
  mask(value: string): { len: number; h: string } {
    return { len: value.length, h: createHmac('sha256', this.key).update(value).digest('hex').slice(0, 24) };
  }
  private indexPath(): string { return join(this.dir, 'index.json'); }
  private withLock<T>(work: () => T): T {
    const path = join(this.dir, 'index.lock');
    const started = Date.now();
    let fd: number;
    while (true) {
      try { fd = openSync(path, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() - started > 5_000) throw new Error('STATE_STORE_BUSY');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try { return work(); }
    finally { closeSync(fd); unlinkSync(path); }
  }
  private index(): Index {
    if (!existsSync(this.indexPath())) return { seq: 0, aliases: {}, captures: [] };
    return JSON.parse(readFileSync(this.indexPath(), 'utf8')) as Index;
  }
  invalidate(name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('STATE_INVALID_NAME');
    this.withLock(() => {
      const index = this.index();
      delete index.aliases[name];
      atomicWrite(this.indexPath(), JSON.stringify(index));
    });
  }
  save(state: Omit<PageState, 'id' | 'seq' | 'digest'>): PageState {
    return this.withLock(() => {
      const index = this.index();
      const id = randomUUID();
      const seq = index.seq + 1;
      const digest = createHash('sha256').update(JSON.stringify({ ...state, id: undefined, seq: undefined, capturedAt: undefined })).digest('hex').slice(0, 24);
      const saved: PageState = { ...state, id, seq, digest };
      atomicWrite(join(this.dir, `${id}.json`), JSON.stringify(saved));
      index.seq = seq;
      index.captures.push(id);
      if (state.name) index.aliases[state.name] = id;
      const expired = this.maxCaptures > 0 && index.captures.length > this.maxCaptures
        ? index.captures.splice(0, index.captures.length - this.maxCaptures) : [];
      for (const [name, captureId] of Object.entries(index.aliases)) {
        if (expired.includes(captureId)) delete index.aliases[name];
      }
      atomicWrite(this.indexPath(), JSON.stringify(index));
      for (const expiredId of expired) {
        try { unlinkSync(join(this.dir, `${expiredId}.json`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return saved;
    });
  }
  load(ref: string): PageState {
    const index = this.index();
    const id = index.aliases[ref] ?? ref;
    if (!/^[a-f0-9-]{36}$/.test(id) || !existsSync(join(this.dir, `${id}.json`))) throw new Error(`STATE_NOT_FOUND: ${ref}`);
    return JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as PageState;
  }
  list(): Array<{ id: string; seq: number; name?: string; capturedAt: string }> {
    return this.withLock(() => {
      const index = this.index();
      const names = new Map(Object.entries(index.aliases).map(([name, id]) => [id, name]));
      return index.captures.map((id) => {
        const state = this.load(id);
        return { id, seq: state.seq, name: names.get(id), capturedAt: state.capturedAt };
      });
    });
  }
  remove(ref: string): void {
    this.withLock(() => {
      const state = this.load(ref);
      const index = this.index();
      for (const [name, id] of Object.entries(index.aliases)) if (id === state.id) delete index.aliases[name];
      index.captures = index.captures.filter((id) => id !== state.id);
      atomicWrite(this.indexPath(), JSON.stringify(index));
      unlinkSync(join(this.dir, `${state.id}.json`));
    });
  }
}
