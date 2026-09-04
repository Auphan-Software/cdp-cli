import { describe, expect, it } from 'vitest';
import {
  SessionFoundationError,
  WorkspaceSessionRegistry,
  type Clock,
  type PersistedSession,
  type TargetIdentity
} from '../../../src/sessions/index.js';

const fixedClock: Clock = { now: () => 1000 };

function addSession(
  registry: WorkspaceSessionRegistry,
  name: string,
  contextId = `context-${name}`
): void {
  registry.createSession({
    name,
    browserInstanceId: 'browser-1',
    browserContextId: contextId,
    isolation: 'isolated'
  });
}

describe('WorkspaceSessionRegistry', () => {
  it('enforces the exact public session-name grammar', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    for (const name of ['a', 'A-1_test.name', 'x'.repeat(64)]) {
      addSession(registry, name);
    }
    for (const name of ['', '-leading', 'with space', 'x'.repeat(65), 'slash/name']) {
      expect(() => addSession(registry, name)).toThrowError(
        expect.objectContaining({ code: 'INVALID_SESSION_NAME' })
      );
    }
  });

  it('adopts by exact target ID and rejects fuzzy or absent values', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha');
    const targets: TargetIdentity[] = [{ targetId: 'page-123', browserContextId: 'context-alpha' }];

    expect(() => registry.adoptTarget('alpha', 'page', targets)).toThrowError(
      expect.objectContaining({ code: 'TARGET_NOT_FOUND' })
    );
    registry.adoptTarget('alpha', 'page-123', targets);
    expect(registry.getOwner('page-123')).toBe('alpha');
  });

  it('allows only one owner for a root and returns structured PAGE_NOT_OWNED', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha');
    addSession(registry, 'beta');
    const targets: TargetIdentity[] = [{ targetId: 'root' }];
    registry.adoptTarget('alpha', 'root', targets);

    expect(() => registry.adoptTarget('beta', 'root', targets)).toThrowError(
      expect.objectContaining({ code: 'OWNERSHIP_CONFLICT' })
    );
    expect(registry.checkPageAccess('beta', 'root')).toEqual({
      ok: false,
      error: {
        code: 'PAGE_NOT_OWNED',
        message: 'Page root is not owned by session beta',
        details: { sessionName: 'beta', pageId: 'root', actualOwner: 'alpha' }
      }
    });
  });

  it('reserves a structural root when a child is adopted first', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha', 'context-alpha');
    addSession(registry, 'beta', 'context-beta');
    const targets: TargetIdentity[] = [
      { targetId: 'root' },
      { targetId: 'child', parentId: 'root' }
    ];
    registry.adoptTarget('alpha', 'child', targets);

    expect(() => registry.adoptTarget('beta', 'root', targets)).toThrowError(
      expect.objectContaining({ code: 'OWNERSHIP_CONFLICT' })
    );
    expect(registry.observeTargets(targets)).toEqual(['root']);
    expect(registry.getOwner('root')).toBe('alpha');
  });

  it('does not allow two isolated sessions to claim the same browser context', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha', 'same-context');
    expect(() => addSession(registry, 'beta', 'same-context')).toThrowError(
      expect.objectContaining({ code: 'OWNERSHIP_CONFLICT' })
    );
  });

  it('inherits only through exact parent, parent-frame, opener, or context IDs', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha');
    const targets: TargetIdentity[] = [
      { targetId: 'root', frameId: 'frame-root', browserContextId: 'context-alpha' },
      { targetId: 'parent-child', parentId: 'root' },
      { targetId: 'frame-child', parentFrameId: 'frame-root' },
      { targetId: 'popup', openerId: 'root' },
      { targetId: 'context-child', browserContextId: 'context-alpha' },
      { targetId: 'unrelated' }
    ];
    registry.adoptTarget('alpha', 'root', targets);
    expect(registry.observeTargets(targets).sort()).toEqual([
      'context-child',
      'frame-child',
      'parent-child',
      'popup'
    ]);
    expect(registry.getOwner('unrelated')).toBeUndefined();
  });

  it('never infers ownership from target titles or URLs', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha');
    registry.adoptTarget('alpha', 'owned', [{ targetId: 'owned' }]);

    const displayMetadata = [
      { targetId: 'lookalike', title: 'owned', url: 'owned' }
    ] as unknown as TargetIdentity[];
    expect(registry.observeTargets(displayMetadata)).toEqual([]);
    expect(registry.getOwner('lookalike')).toBeUndefined();
  });

  it('fails closed when exact inheritance signals disagree', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha');
    addSession(registry, 'beta');
    const roots: TargetIdentity[] = [{ targetId: 'root-a' }, { targetId: 'root-b' }];
    registry.adoptTarget('alpha', 'root-a', roots);
    registry.adoptTarget('beta', 'root-b', roots);

    expect(() => registry.observeTargets([
      ...roots,
      { targetId: 'ambiguous', parentId: 'root-a', openerId: 'root-b' }
    ])).toThrowError(expect.objectContaining({ code: 'OWNERSHIP_CONFLICT' }));
    expect(registry.getOwner('ambiguous')).toBeUndefined();
  });

  it('restores persisted ownership, drops closed pages, and inherits live children', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    const persisted: PersistedSession[] = [{
      version: 1,
      name: 'alpha',
      browserInstanceId: 'browser-1',
      browserContextId: 'context-alpha',
      isolation: 'isolated',
      createdAt: 10,
      updatedAt: 20,
      pageIds: ['root', 'closed']
    }];
    const result = registry.reconcile(persisted, [
      { targetId: 'root', browserContextId: 'context-alpha' },
      { targetId: 'child', parentId: 'root' }
    ]);

    expect(result).toEqual({ droppedPageIds: ['closed'], inheritedPageIds: ['child'] });
    expect(registry.getSession('alpha')?.pageIds).toEqual(['child', 'root']);
    expect(registry.getOwner('closed')).toBeUndefined();
  });

  it('keeps the prior registry intact when reconciliation conflicts', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'existing');
    const duplicated = (name: string): PersistedSession => ({
      version: 1,
      name,
      browserInstanceId: 'browser-1',
      browserContextId: `context-${name}`,
      isolation: 'isolated',
      createdAt: 1,
      updatedAt: 1,
      pageIds: ['same-root']
    });

    expect(() => registry.reconcile([duplicated('alpha'), duplicated('beta')], [
      { targetId: 'same-root' }
    ])).toThrow(SessionFoundationError);
    expect(registry.getSession('existing')).toBeDefined();
  });

  it('reports SESSION_NOT_FOUND for an unknown session instead of a false ownership loss', () => {
    const registry = new WorkspaceSessionRegistry(fixedClock);
    addSession(registry, 'alpha');
    registry.adoptTarget('alpha', 'root', [{ targetId: 'root' }]);

    expect(registry.checkPageAccess('ghost', 'root')).toEqual({
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found: ghost',
        details: { sessionName: 'ghost', pageId: 'root' }
      }
    });
    expect(() => registry.assertPageAccess('ghost', 'root')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' })
    );
    expect(registry.checkPageAccess('alpha', 'root')).toMatchObject({ ok: true, owner: 'alpha' });
  });
});
