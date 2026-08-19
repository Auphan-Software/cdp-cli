/** State derived from Target and Runtime events on a browser connection. */

export interface ProtocolTargetInfo {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  attached?: boolean;
  parentId?: string;
  parentFrameId?: string;
  openerId?: string;
  openerFrameId?: string;
  browserContextId?: string;
  subtype?: string;
}

/**
 * Safe target metadata. Raw target URLs are redacted before entering the
 * registry, so query strings and fragments cannot escape through later logs.
 */
export interface TargetRecord {
  targetId: string;
  sessionId?: string;
  parentSessionId?: string;
  parentTargetId?: string;
  parentFrameId?: string;
  browserContextId?: string;
  openerTargetId?: string;
  openerFrameId?: string;
  type: string;
  subtype?: string;
  title: string;
  url: string;
  attached: boolean;
}

export interface TargetSessionRecord {
  sessionId: string;
  targetId: string;
  parentSessionId?: string;
}

export interface TargetExecutionContext {
  sessionId: string;
  targetId: string;
  id: number;
  uniqueId?: string;
  frameId?: string;
  isDefault: boolean;
  type?: string;
}

interface MutableTargetRecord extends TargetRecord {}

/** Indexes targets by all identifiers needed to reconstruct OOPIF topology. */
export class TargetRegistry {
  private readonly targetsById = new Map<string, MutableTargetRecord>();
  private readonly sessionsById = new Map<string, TargetSessionRecord>();
  private readonly targetIdsByParentFrameId = new Map<string, Set<string>>();
  private readonly targetIdsByBrowserContextId = new Map<string, Set<string>>();
  private readonly contextsBySessionId = new Map<string, Map<number, TargetExecutionContext>>();

  upsertTarget(info: ProtocolTargetInfo): TargetRecord {
    if (!info || typeof info.targetId !== 'string' || !info.targetId) {
      throw new Error('Chrome supplied target metadata without a targetId');
    }

    const previous = this.targetsById.get(info.targetId);
    if (previous) this.removeFromSecondaryIndexes(previous);

    const parentTargetId = nonEmpty(info.parentId) ?? previous?.parentTargetId;
    const next: MutableTargetRecord = {
      targetId: info.targetId,
      ...(previous?.sessionId ? { sessionId: previous.sessionId } : {}),
      ...(previous?.parentSessionId ? { parentSessionId: previous.parentSessionId } : {}),
      ...(parentTargetId ? { parentTargetId } : {}),
      ...(nonEmpty(info.parentFrameId) ?? previous?.parentFrameId
        ? { parentFrameId: nonEmpty(info.parentFrameId) ?? previous?.parentFrameId }
        : {}),
      ...(nonEmpty(info.browserContextId) ?? previous?.browserContextId
        ? { browserContextId: nonEmpty(info.browserContextId) ?? previous?.browserContextId }
        : {}),
      ...(nonEmpty(info.openerId) ?? previous?.openerTargetId
        ? { openerTargetId: nonEmpty(info.openerId) ?? previous?.openerTargetId }
        : {}),
      ...(nonEmpty(info.openerFrameId) ?? previous?.openerFrameId
        ? { openerFrameId: nonEmpty(info.openerFrameId) ?? previous?.openerFrameId }
        : {}),
      type: nonEmpty(info.type) ?? previous?.type ?? 'unknown',
      ...(nonEmpty(info.subtype) ?? previous?.subtype
        ? { subtype: nonEmpty(info.subtype) ?? previous?.subtype }
        : {}),
      title: redactUrlsInText(typeof info.title === 'string' ? info.title : previous?.title ?? ''),
      url: typeof info.url === 'string' ? redactTargetUrl(info.url) : previous?.url ?? '',
      attached: typeof info.attached === 'boolean' ? info.attached : previous?.attached ?? false
    };

    this.targetsById.set(next.targetId, next);
    this.addToSecondaryIndexes(next);
    return cloneTarget(next);
  }

  attachSession(
    sessionId: string,
    info: ProtocolTargetInfo,
    parentSessionId?: string
  ): TargetRecord {
    const target = this.upsertTarget(info) as MutableTargetRecord;
    const inferredParentTargetId = parentSessionId
      ? this.sessionsById.get(parentSessionId)?.targetId
      : undefined;
    const stored = this.targetsById.get(target.targetId)!;
    stored.sessionId = sessionId;
    stored.parentSessionId = parentSessionId;
    stored.parentTargetId = stored.parentTargetId ?? inferredParentTargetId;
    stored.attached = true;
    this.sessionsById.set(sessionId, {
      sessionId,
      targetId: stored.targetId,
      ...(parentSessionId ? { parentSessionId } : {})
    });
    return cloneTarget(stored);
  }

  detachSession(sessionId: string): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    this.sessionsById.delete(sessionId);
    this.contextsBySessionId.delete(sessionId);
    const target = this.targetsById.get(session.targetId);
    if (target?.sessionId === sessionId) {
      delete target.sessionId;
      delete target.parentSessionId;
      target.attached = false;
    }
  }

  removeTarget(targetId: string): void {
    const target = this.targetsById.get(targetId);
    if (!target) return;
    this.removeFromSecondaryIndexes(target);
    if (target.sessionId) this.detachSession(target.sessionId);
    this.targetsById.delete(targetId);
  }

  getByTargetId(targetId: string): TargetRecord | undefined {
    const target = this.targetsById.get(targetId);
    return target ? cloneTarget(target) : undefined;
  }

  getBySessionId(sessionId: string): TargetRecord | undefined {
    const targetId = this.sessionsById.get(sessionId)?.targetId;
    return targetId ? this.getByTargetId(targetId) : undefined;
  }

  getSession(sessionId: string): TargetSessionRecord | undefined {
    const session = this.sessionsById.get(sessionId);
    return session ? { ...session } : undefined;
  }

  getByParentFrameId(parentFrameId: string): TargetRecord[] {
    return this.recordsForIndex(this.targetIdsByParentFrameId.get(parentFrameId));
  }

  getByBrowserContextId(browserContextId: string): TargetRecord[] {
    return this.recordsForIndex(this.targetIdsByBrowserContextId.get(browserContextId));
  }

  childrenOf(parentTargetId: string): TargetRecord[] {
    return this.list().filter((target) => target.parentTargetId === parentTargetId);
  }

  /**
   * Chrome uses the child frame id as the OOPIF target id. Matching that exact
   * identifier is safe; parentFrameId identifies the *owner's* frame and is
   * therefore never used as a fuzzy fallback.
   */
  findTargetForFrame(frameId: string, parentTargetId?: string): TargetRecord | undefined {
    const target = this.targetsById.get(frameId);
    if (!target || target.type !== 'iframe') return undefined;
    if (parentTargetId && target.parentTargetId && target.parentTargetId !== parentTargetId) {
      return undefined;
    }
    return cloneTarget(target);
  }

  list(): TargetRecord[] {
    return [...this.targetsById.values()]
      .map(cloneTarget)
      .sort((left, right) => {
        const typeOrder = targetTypeOrder(left.type) - targetTypeOrder(right.type);
        return typeOrder || left.targetId.localeCompare(right.targetId);
      });
  }

  recordExecutionContext(sessionId: string, raw: any): void {
    const targetId = this.sessionsById.get(sessionId)?.targetId;
    if (!targetId || typeof raw?.id !== 'number') return;
    const aux = raw.auxData && typeof raw.auxData === 'object' ? raw.auxData : {};
    const context: TargetExecutionContext = {
      sessionId,
      targetId,
      id: raw.id,
      ...(nonEmpty(raw.uniqueId) ? { uniqueId: raw.uniqueId } : {}),
      ...(nonEmpty(aux.frameId) ? { frameId: aux.frameId } : {}),
      isDefault: aux.isDefault === true,
      ...(nonEmpty(aux.type) ? { type: aux.type } : {})
    };
    let contexts = this.contextsBySessionId.get(sessionId);
    if (!contexts) {
      contexts = new Map();
      this.contextsBySessionId.set(sessionId, contexts);
    }
    contexts.set(context.id, context);
  }

  removeExecutionContext(sessionId: string, id?: number, uniqueId?: string): void {
    const contexts = this.contextsBySessionId.get(sessionId);
    if (!contexts) return;
    for (const [contextId, context] of contexts) {
      if (contextId === id || (uniqueId && context.uniqueId === uniqueId)) {
        contexts.delete(contextId);
      }
    }
  }

  clearExecutionContexts(sessionId: string): void {
    this.contextsBySessionId.delete(sessionId);
  }

  /** Selects only the default world belonging to the target's own frame. */
  getDefaultExecutionContext(sessionId: string): TargetExecutionContext | undefined {
    const target = this.getBySessionId(sessionId);
    if (!target) return undefined;
    const defaults = [...(this.contextsBySessionId.get(sessionId)?.values() ?? [])]
      .filter((context) => context.isDefault && (!context.type || context.type === 'default'));
    const exact = defaults.filter((context) => context.frameId === target.targetId);
    if (exact.length === 1) return { ...exact[0] };

    // Old protocol versions may omit auxData.frameId. Accept one unambiguous
    // default world, but never guess among several same-process frames.
    const withoutFrame = defaults.filter((context) => !context.frameId);
    return defaults.length === 1 && withoutFrame.length === 1
      ? { ...withoutFrame[0] }
      : undefined;
  }

  private recordsForIndex(targetIds?: Set<string>): TargetRecord[] {
    if (!targetIds) return [];
    return [...targetIds]
      .map((targetId) => this.targetsById.get(targetId))
      .filter((target): target is MutableTargetRecord => Boolean(target))
      .map(cloneTarget);
  }

  private addToSecondaryIndexes(target: TargetRecord): void {
    addIndex(this.targetIdsByParentFrameId, target.parentFrameId, target.targetId);
    addIndex(this.targetIdsByBrowserContextId, target.browserContextId, target.targetId);
  }

  private removeFromSecondaryIndexes(target: TargetRecord): void {
    removeIndex(this.targetIdsByParentFrameId, target.parentFrameId, target.targetId);
    removeIndex(this.targetIdsByBrowserContextId, target.browserContextId, target.targetId);
  }
}

/** Strip credentials, query strings, and fragments from a target URL. */
export function redactTargetUrl(raw: string): string {
  if (!raw) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === 'data' || scheme === 'javascript') return `${scheme}:[redacted]`;
  if (scheme === 'blob') return `blob:${redactTargetUrl(raw.slice(5))}`;

  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

/** Redact URL-shaped substrings which a page may place in its title. */
export function redactUrlsInText(text: string): string {
  return text.replace(/(?:https?|file|blob):\/\/[^\s<>'"]+/gi, (candidate) => {
    const trailing = /[),.;]+$/.exec(candidate)?.[0] ?? '';
    const body = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${redactTargetUrl(body)}${trailing}`;
  });
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cloneTarget(target: TargetRecord): TargetRecord {
  return { ...target };
}

function addIndex(index: Map<string, Set<string>>, key: string | undefined, targetId: string): void {
  if (!key) return;
  let values = index.get(key);
  if (!values) {
    values = new Set();
    index.set(key, values);
  }
  values.add(targetId);
}

function removeIndex(index: Map<string, Set<string>>, key: string | undefined, targetId: string): void {
  if (!key) return;
  const values = index.get(key);
  if (!values) return;
  values.delete(targetId);
  if (values.size === 0) index.delete(key);
}

function targetTypeOrder(type: string): number {
  if (type === 'page') return 0;
  if (type === 'iframe') return 1;
  return 2;
}
