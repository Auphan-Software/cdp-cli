import type { PageState, StateChange, StateDiff, StateElement } from './types.js';

function fields(element: StateElement): Record<string, unknown> {
  const result: Record<string, unknown> = { role: element.role, name: element.name, text: element.text, value: element.value };
  for (const [key, value] of Object.entries(element.state ?? {})) result[`state.${key}`] = value;
  return result;
}

function complete(state: PageState): boolean {
  return !state.coverage.truncated && !state.coverage.blockedByDialog && state.coverage.unreachableFrames.length === 0 &&
    (state.coverage.ambiguousKeys?.length ?? 0) === 0 && !state.coverage.unstable && !state.coverage.dialogProbeUnavailable;
}

export function diffStates(before: PageState, after: PageState, options: { layout?: boolean } = {}): StateDiff {
  if (before.schema !== after.schema) throw new Error('STATE_SCHEMA_MISMATCH');
  if (before.targetId !== after.targetId || before.session !== after.session) throw new Error('STATE_TARGET_MISMATCH');
  if (!before.captureProfile || before.captureProfile !== after.captureProfile) throw new Error('STATE_CAPTURE_OPTIONS_MISMATCH');
  if (before.seq >= after.seq) throw new Error('STATE_REVERSED');

  const volatile = new Set([...(before.coverage.volatileKeys ?? []), ...(after.coverage.volatileKeys ?? [])]);
  const coverage = {
    truncated: before.coverage.truncated || after.coverage.truncated,
    unreachableFrames: [...new Set([...before.coverage.unreachableFrames, ...after.coverage.unreachableFrames])],
    blockedByDialog: before.coverage.blockedByDialog || after.coverage.blockedByDialog,
    dialogProbeUnavailable: !!before.coverage.dialogProbeUnavailable || !!after.coverage.dialogProbeUnavailable,
    ambiguousKeys: [...new Set([...(before.coverage.ambiguousKeys ?? []), ...(after.coverage.ambiguousKeys ?? [])])],
    unstable: !!before.coverage.unstable || !!after.coverage.unstable,
    volatileKeys: [...volatile]
  };
  const fromRef = { id: before.id, seq: before.seq, name: before.name };
  const toRef = { id: after.id, seq: after.seq, name: after.name };
  if (coverage.blockedByDialog) {
    const changes: StateChange[] = JSON.stringify(before.dialog) === JSON.stringify(after.dialog) ? [] :
      [{ kind: 'dialog', key: '@dialog', from: before.dialog, to: after.dialog }];
    return { from: fromRef, to: toRef, changed: null, coverage,
      counts: { added: 0, removed: 0, changed: changes.length }, changes };
  }
  const changes: StateChange[] = [];
  const b = new Map(before.elements.filter((e) => e.kq !== 'ambiguous' && !volatile.has(e.k)).map((e) => [e.k, e]));
  const a = new Map(after.elements.filter((e) => e.kq !== 'ambiguous' && !volatile.has(e.k)).map((e) => [e.k, e]));
  if (before.url !== after.url) changes.push({ kind: 'navigation', field: 'url', from: before.url, to: after.url });
  if (JSON.stringify(before.dialog) !== JSON.stringify(after.dialog)) changes.push({ kind: 'dialog', key: '@dialog', from: before.dialog, to: after.dialog });
  for (const [key, oldElement] of b) {
    const newElement = a.get(key);
    if (!newElement) {
      changes.push({ kind: 'removed', key, from: { role: oldElement.role, name: oldElement.name,
        text: oldElement.text, state: oldElement.state } });
      continue;
    }
    const oldFields = fields(oldElement);
    const newFields = fields(newElement);
    if (options.layout) {
      oldFields.box = oldElement.box;
      newFields.box = newElement.box;
    }
    for (const field of new Set([...Object.keys(oldFields), ...Object.keys(newFields)])) {
      const from = oldFields[field];
      const to = newFields[field];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ kind: 'field', key, field, from, to });
    }
  }
  for (const [key, element] of a) if (!b.has(key)) changes.push({ kind: 'added', key,
    to: { role: element.role, name: element.name, text: element.text, state: element.state } });
  const textExplained = changes.some((change) => change.kind === 'added' || change.kind === 'removed' ||
    (change.kind === 'field' && ['name', 'text'].includes(change.field ?? '')));
  if (before.bodyTextHash !== after.bodyTextHash && volatile.size === 0 && !textExplained) {
    changes.push({ kind: 'text-unmodelled', field: 'bodyTextHash', from: before.bodyTextHash, to: after.bodyTextHash });
  }
  return {
    from: fromRef,
    to: toRef,
    changed: changes.length > 0 ? true : complete(before) && complete(after) ? false : null,
    coverage,
    counts: {
      added: changes.filter((c) => c.kind === 'added').length,
      removed: changes.filter((c) => c.kind === 'removed').length,
      changed: changes.filter((c) => !['added', 'removed'].includes(c.kind)).length
    },
    changes
  };
}

export interface StateExpectation {
  mustChange?: Array<{ key: string; field?: string; from?: unknown; to?: unknown; kind?: StateChange['kind'] }>;
  mustNotChange?: Array<{ key: string; field?: string }>;
}

export function expectState(diff: StateDiff, spec: StateExpectation, before?: PageState, after?: PageState): { outcome: 'PASSED' | 'FAILED' | 'UNKNOWN'; passed: number; failed: string[]; unknown: string[] } {
  const failed: string[] = [];
  const unknown: string[] = [];
  let uncertainAssertions = 0;
  const uncertainKey = (key: string) => !!before && !!after &&
    [...before.elements, ...after.elements].some((element) => element.k === key && element.kq !== 'strong');
  if (diff.changed === null || diff.coverage.truncated || diff.coverage.unreachableFrames.length || (diff.coverage.ambiguousKeys?.length ?? 0) > 0 || diff.coverage.unstable || diff.coverage.dialogProbeUnavailable) unknown.push('capture coverage incomplete');
  for (const item of spec.mustChange ?? []) {
    if (uncertainKey(item.key)) {
      unknown.push(`identity is not stable: ${item.key}`);
      uncertainAssertions++;
      continue;
    }
    const matching = diff.changes.filter((c) => c.key === item.key && (!item.field || c.field === item.field) && (!item.kind || c.kind === item.kind));
    if (matching.length === 0) failed.push(`expected change: ${item.key}${item.field ? `.${item.field}` : ''}`);
    else if (!matching.some((c) => (item.from === undefined || JSON.stringify(c.from) === JSON.stringify(item.from)) && (item.to === undefined || JSON.stringify(c.to) === JSON.stringify(item.to)))) {
      failed.push(`wrong transition: ${item.key}${item.field ? `.${item.field}` : ''}`);
    }
  }
  for (const item of spec.mustNotChange ?? []) {
    if (uncertainKey(item.key)) {
      unknown.push(`identity is not stable: ${item.key}`);
      uncertainAssertions++;
      continue;
    }
    if (before && after && !before.elements.some((element) => element.k === item.key) &&
      !after.elements.some((element) => element.k === item.key)) {
      unknown.push(`invariant key absent: ${item.key}`);
      uncertainAssertions++;
      continue;
    }
    if (diff.changes.some((c) => c.key === item.key && (!item.field || c.field === item.field))) {
      failed.push(`unexpected change: ${item.key}${item.field ? `.${item.field}` : ''}`);
    }
  }
  const total = (spec.mustChange?.length ?? 0) + (spec.mustNotChange?.length ?? 0);
  return { outcome: unknown.length ? 'UNKNOWN' : failed.length ? 'FAILED' : 'PASSED',
    passed: Math.max(0, total - failed.length - uncertainAssertions), failed, unknown };
}
