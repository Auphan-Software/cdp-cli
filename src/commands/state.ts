import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CDPContext } from '../context.js';
import { click as clickElement } from './input.js';
import { DaemonClient } from '../daemon/client.js';
import { createExecSessionByPageRef } from '../daemon/exec.js';
import { outputCommandError, outputLine } from '../output.js';
import { captureExpression } from '../state/page-script.js';
import { diffStates, expectState, type StateExpectation } from '../state/diff.js';
import { StateStore } from '../state/store.js';
import type { PageState, StateDiff, StateElement } from '../state/types.js';

interface RawElement extends Omit<StateElement, 'value'> { rawValue?: string }
interface RawCapture {
  url: string;
  title: string;
  readyState: string;
  bodyTextHash: string;
  nodeCount: number;
  elements: RawElement[];
  coverage: PageState['coverage'];
}

function readExpectationSpec(path: string): StateExpectation {
  const spec = JSON.parse(readFileSync(path, 'utf8')) as StateExpectation;
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.mustChange ?? []) ||
    !Array.isArray(spec.mustNotChange ?? [])) throw new Error('STATE_INVALID_SPEC');
  if ((spec.mustChange?.length ?? 0) + (spec.mustNotChange?.length ?? 0) === 0) throw new Error('STATE_EMPTY_SPEC');
  for (const item of [...(spec.mustChange ?? []), ...(spec.mustNotChange ?? [])]) {
    if (!item || typeof item.key !== 'string' || !item.key ||
      (item.field !== undefined && typeof item.field !== 'string')) throw new Error('STATE_INVALID_SPEC');
  }
  return spec;
}

function storeFor(context: CDPContext, pageId: string): StateStore {
  const configured = process.env.CDP_STATE_MAX_CAPTURES;
  const max = configured === undefined ? 200 : Number(configured);
  if (!Number.isSafeInteger(max) || max < 0) throw new Error('STATE_INVALID_MAX_CAPTURES');
  return new StateStore(context.cdpUrl, context.workspaceSessionName, pageId, process.env.CDP_STATE_ROOT, max);
}

async function withPage<T>(context: CDPContext, page: string, work: (pageId: string, store: StateStore, exec: Awaited<ReturnType<typeof createExecSessionByPageRef>>) => Promise<T>): Promise<T> {
  const exec = await createExecSessionByPageRef(context, page);
  try {
    return await work(exec.pageId, storeFor(context, exec.pageId), exec);
  } finally {
    await exec.close();
  }
}

function normalize(raw: RawCapture, store: StateStore): Omit<PageState, 'id' | 'seq' | 'digest' | 'schema' | 'name' | 'capturedAt' | 'targetId' | 'session' | 'captureProfile'> {
  const elements: StateElement[] = raw.elements.map(({ rawValue, ...element }) => ({
    ...element,
    ...(rawValue !== undefined ? { value: store.mask(rawValue) } : {})
  }));
  return { url: raw.url, title: raw.title, readyState: raw.readyState, bodyTextHash: raw.bodyTextHash,
    nodeCount: raw.nodeCount, elements, coverage: raw.coverage };
}

export async function capture(context: CDPContext, options: { page: string; name?: string; frame?: string; ignore?: string[]; maxElements?: number; stabilityMs?: number; quiet?: boolean }): Promise<boolean> {
  try {
    if (options.maxElements !== undefined && (!Number.isSafeInteger(options.maxElements) || options.maxElements < 1 || options.maxElements > 10_000)) {
      throw new Error('STATE_INVALID_MAX_ELEMENTS');
    }
    if (options.stabilityMs !== undefined && (!Number.isSafeInteger(options.stabilityMs) || options.stabilityMs < 0 || options.stabilityMs > 5_000)) {
      throw new Error('STATE_INVALID_STABILITY_MS');
    }
    await withPage(context, options.page, async (pageId, store, exec) => {
      if (options.name) store.invalidate(options.name);
      let dialog: PageState['dialog'];
      let dialogProbeUnavailable = false;
      if (exec.useDaemon) {
        const status = await new DaemonClient({ cdpUrl: context.cdpUrl }).getDialogStatus(pageId, context.workspaceSessionName);
        dialogProbeUnavailable = status.probeUnavailable === true;
        if (status.open && status.dialog) dialog = { type: status.dialog.type, messageLength: status.dialog.message.length };
      } else if (exec.ws) {
        const seen = await context.checkForDialog(exec.ws);
        if (seen) dialog = { type: seen.type, messageLength: seen.message.length };
      }
      const started = Date.now();
      const raw: RawCapture = dialog
        ? { url: '', title: '', readyState: 'blocked', bodyTextHash: '', nodeCount: 0, elements: [],
            coverage: { truncated: false, unreachableFrames: [], blockedByDialog: true } }
        : await (async () => {
            await exec.exec('Runtime.enable');
            const read = async (): Promise<RawCapture> => {
              const result = await exec.exec('Runtime.evaluate', {
                expression: captureExpression({ frame: options.frame, ignore: options.ignore ?? [], maxElements: options.maxElements ?? 2000 }),
                returnByValue: true
              });
              if (result.exceptionDetails) throw new Error(`STATE_CAPTURE_SCRIPT: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
              if (!result.result?.value) throw new Error('STATE_CAPTURE_EMPTY');
              return result.result.value as RawCapture;
            };
            const stabilityMs = options.stabilityMs ?? 1200;
            const signature = (value: RawCapture): string => JSON.stringify({ ...value,
              elements: value.elements.map(({ box: _box, ...element }) => element) });
            let previous = await read();
            if (stabilityMs <= 0) return previous;
            await new Promise((resolve) => setTimeout(resolve, stabilityMs));
            let current = await read();
            if (signature(previous) === signature(current)) return current;
            await new Promise((resolve) => setTimeout(resolve, stabilityMs));
            const final = await read();
            if (signature(current) === signature(final)) return final;
            const prior = new Map(current.elements.map((element) => [element.k, JSON.stringify(element)]));
            const latest = new Map(final.elements.map((element) => [element.k, JSON.stringify(element)]));
            final.coverage.unstable = true;
            final.coverage.volatileKeys = [...new Set([...prior.keys(), ...latest.keys()])]
              .filter((key) => prior.get(key) !== latest.get(key));
            return final;
          })();
      const state = store.save({ schema: 'cdp-cli.page-state/1', name: options.name, capturedAt: new Date().toISOString(),
        targetId: pageId, session: context.workspaceSessionName,
        captureProfile: createHash('sha256').update(JSON.stringify({ frame: options.frame === '0' ? undefined : options.frame,
          ignore: [...new Set(options.ignore ?? [])].sort(), maxElements: options.maxElements ?? 2000 })).digest('hex').slice(0, 16),
        ...normalize(raw, store),
        coverage: { ...raw.coverage, ...(dialogProbeUnavailable ? { dialogProbeUnavailable: true } : {}) },
        settle: { waitedMs: Date.now() - started, stable: !raw.coverage.unstable }, ...(dialog ? { dialog } : {}) });
      if (!options.quiet) outputLine({ success: true, type: 'state-capture', value: {
        id: state.id, seq: state.seq, name: state.name, elements: state.elements.length, coverage: state.coverage,
        digest: state.digest, settle: state.settle, path: `${store.dir}/${state.id}.json`
      } });
    });
    return true;
  } catch (error) {
    outputCommandError(error, 'STATE_CAPTURE_FAILED');
    process.exitCode = 1;
    return false;
  }
}

export async function clickWithDiff(context: CDPContext, options: { page: string; selector: string; frame?: string; ignore?: string[];
  maxElements?: number; stabilityMs?: number; waitForIdle?: boolean; spec?: string; exitOnFail?: boolean;
  layout?: boolean; maxChanges?: number }): Promise<void> {
  if (options.exitOnFail && !options.spec) {
    outputCommandError(new Error('--exit-on-fail requires --spec'), 'STATE_INVALID_OPTIONS');
    process.exitCode = 1;
    return;
  }
  let specObject: StateExpectation | undefined;
  if (options.spec) {
    try { specObject = readExpectationSpec(options.spec); }
    catch (error) { outputCommandError(error, 'STATE_INVALID_SPEC'); process.exitCode = 1; return; }
  }
  if (options.frame && /^\d+$/.test(options.frame) && options.frame !== '0') {
    outputCommandError(new Error('Use a stable iframe selector with state click'), 'STATE_FRAME_INDEX_UNSUPPORTED');
    process.exitCode = 1;
    return;
  }
  if (options.maxChanges !== undefined && (!Number.isSafeInteger(options.maxChanges) ||
    options.maxChanges < 0 || options.maxChanges > 200)) {
    outputCommandError(new Error('STATE_INVALID_MAX_CHANGES'), 'STATE_INVALID_OPTIONS');
    process.exitCode = 1;
    return;
  }
  const run = `run-${randomUUID().slice(0, 12)}`;
  const before = `${run}-before`;
  const after = `${run}-after`;
  const frame = options.frame === '0' ? undefined : options.frame;
  const captureOptions = { page: options.page, frame, ignore: options.ignore,
    maxElements: options.maxElements, stabilityMs: options.stabilityMs };
  if (!await capture(context, { ...captureOptions, name: before, quiet: true })) return;
  const clicked = await clickElement(context, options.selector, { page: options.page, frame,
    waitForIdle: options.waitForIdle, quiet: true });
  if (!await capture(context, { ...captureOptions, name: after, quiet: true })) return;
  const action = { kind: 'click' as const, selector: options.selector, ...clicked };
  if (options.spec) await expect(context, { page: options.page, before, after, spec: options.spec,
    specObject, exitOnFail: options.exitOnFail, layout: options.layout, action });
  else await diff(context, { page: options.page, before, after, layout: options.layout,
    maxChanges: options.maxChanges, action });
}

type ActionEvidence = { kind: 'click'; selector: string; clickDelivered: boolean | null; frameReached: boolean | null };

function withAction(result: StateDiff, action?: ActionEvidence): StateDiff {
  if (!action || result.changed !== false || action.clickDelivered === true || action.frameReached === true) return result;
  return { ...result, changed: null, coverage: { ...result.coverage, actionUnverified: true } };
}

export async function diff(context: CDPContext, options: { page: string; before: string; after: string; layout?: boolean; maxChanges?: number; action?: ActionEvidence }): Promise<void> {
  try {
    await withPage(context, options.page, async (_pageId, store) => {
      const result = withAction(diffStates(store.load(options.before), store.load(options.after), { layout: options.layout }), options.action);
      const maxChanges = options.maxChanges ?? 40;
      if (!Number.isSafeInteger(maxChanges) || maxChanges < 0 || maxChanges > 200) throw new Error('STATE_INVALID_MAX_CHANGES');
      outputLine({ success: true, type: 'state-diff', value: {
        ...result, ...(options.action ? { action: options.action } : {}),
        changes: result.changes.slice(0, maxChanges), omittedChanges: Math.max(0, result.changes.length - maxChanges)
      } });
    });
  } catch (error) {
    outputCommandError(error, 'STATE_DIFF_FAILED');
    process.exitCode = 1;
  }
}

export async function expect(context: CDPContext, options: { page: string; before: string; after: string; spec: string;
  specObject?: StateExpectation; exitOnFail?: boolean; layout?: boolean; action?: ActionEvidence }): Promise<void> {
  try {
    await withPage(context, options.page, async (_pageId, store) => {
      const spec = options.specObject ?? readExpectationSpec(options.spec);
      const maskedSpec: StateExpectation = {
        ...spec,
        mustChange: spec.mustChange?.map((item) => item.field === 'value' ? {
          ...item,
          ...(typeof item.from === 'string' ? { from: store.mask(item.from) } : {}),
          ...(typeof item.to === 'string' ? { to: store.mask(item.to) } : {})
        } : item)
      };
      const before = store.load(options.before);
      const after = store.load(options.after);
      const result = withAction(diffStates(before, after, { layout: options.layout }), options.action);
      const verdict = expectState(result, maskedSpec, before, after);
      outputLine({ success: true, type: 'state-expect', value: { ...verdict, from: result.from, to: result.to,
        changed: result.changed, ...(options.action ? { action: options.action } : {}) } });
      if (options.exitOnFail && verdict.outcome !== 'PASSED') process.exitCode = 1;
    });
  } catch (error) {
    outputCommandError(error, 'STATE_EXPECT_FAILED');
    process.exitCode = 1;
  }
}

export async function list(context: CDPContext, page: string): Promise<void> {
  try {
    await withPage(context, page, async (_pageId, store) => {
      outputLine({ success: true, type: 'state-list', value: { captures: store.list() } });
    });
  } catch (error) {
    outputCommandError(error, 'STATE_LIST_FAILED');
    process.exitCode = 1;
  }
}

export async function remove(context: CDPContext, page: string, ref: string): Promise<void> {
  try {
    await withPage(context, page, async (_pageId, store) => {
      store.remove(ref);
      outputLine({ success: true, type: 'state-rm', value: { ref } });
    });
  } catch (error) {
    outputCommandError(error, 'STATE_RM_FAILED');
    process.exitCode = 1;
  }
}
