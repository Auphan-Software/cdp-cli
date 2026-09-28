/** Opt-in successful action journal and bounded deterministic replay. */
import { appendFileSync, closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { outputCommandError, outputLine } from './output.js';
import { describeCliPath } from './path.js';

const SCHEMA = 'cdp-cli.actions/1';
const ACTIONS = new Set(['click', 'fill', 'select', 'press-key', 'navigate', 'state']);
const MAX_STEPS = 200;
const exeMode = typeof CDP_CLI_EXE_MODE !== 'undefined' && CDP_CLI_EXE_MODE === true;

export interface RecordedAction {
  schema: typeof SCHEMA;
  seq: number;
  at: string;
  argv: string[];
  frame?: string;
  verification: 'command' | 'expectation';
}

function readActions(file: string): RecordedAction[] {
  let contents: string;
  try { contents = readFileSync(file, 'utf8'); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const lines = contents.split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_STEPS) throw new Error(`Recording exceeds ${MAX_STEPS} steps`);
  return lines.map((line, index) => {
    const step = JSON.parse(line) as RecordedAction;
    if (step.schema !== SCHEMA || step.seq !== index + 1 || !Array.isArray(step.argv) ||
      step.argv.some(arg => typeof arg !== 'string') || !ACTIONS.has(step.argv[0]) ||
      (step.argv[0] === 'state' && step.argv[1] !== 'click') ||
      !step.argv.includes('{{page}}') ||
      (step.verification !== 'command' && step.verification !== 'expectation') ||
      step.argv.some(arg => arg === '--cdp-url' || arg.startsWith('--cdp-url=') ||
        arg === '--session' || arg.startsWith('--session='))) {
      throw new Error(`Invalid recording at step ${index + 1}`);
    }
    return step;
  });
}

function removeGlobalOption(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) { i++; continue; }
    if (args[i].startsWith(`${name}=`)) continue;
    result.push(args[i]);
  }
  return result;
}

/** Called only after an allowlisted command has returned successfully. */
export function recordSuccessfulAction(page: string, options: { frame?: string; verification?: 'command' | 'expectation' } = {}): void {
  const file = process.env.CDP_RECORD_FILE && describeCliPath(process.env.CDP_RECORD_FILE).normalizedPath;
  if (!file || process.env.CDP_RECORD_REPLAY === '1' || process.exitCode) return;
  try {
    const lockFile = `${file}.lock`;
    const lock = openSync(lockFile, 'wx', 0o600);
    try {
      const steps = readActions(file);
      if (steps.length >= MAX_STEPS) throw new Error(`Recording is full (${MAX_STEPS} steps)`);
      // Bun's compiled executable and Node's script entry have different argv
      // prefixes. Locate the first allowlisted verb after the executable.
      const commandIndex = process.argv.findIndex((arg, index) => index > 0 && ACTIONS.has(arg));
      if (commandIndex < 0) return;
      let args = process.argv.slice(commandIndex);
      args = removeGlobalOption(removeGlobalOption(args, '--cdp-url'), '--session');
      if (!ACTIONS.has(args[0]) || (args[0] === 'state' && args[1] !== 'click')) return;
      const pageIndex = args.lastIndexOf(page);
      if (pageIndex < 0) throw new Error('Page argument was not found in command arguments');
      args[pageIndex] = '{{page}}';
      if (options.frame && /^\d+$/.test(options.frame) && options.frame !== '0') {
        throw new Error('Record a stable iframe selector; frame indexes can change between runs');
      }
      if (args.includes('--force') || args.includes('--show-value') || args.includes('--wait-for-expression') ||
        args.includes('--wait-for-expression-file') || args.includes('--wait-for-expression-stdin') ||
        args.includes('--wait-for-body-text')) throw new Error('Recording this command requires a reviewed action file');
      if (args[0] === 'fill') {
        if (!args.includes('--expect-value')) throw new Error('Record fills with --expect-value so replay checks the applied value');
        if (args.length < 4 || args[2] === '{{page}}') throw new Error('Fill value not found');
        args[2] = `{{value${steps.length + 1}}}`;
      }
      if (args[0] === 'navigate' && /[?#]/.test(args[1] ?? '')) {
        args[1] = `{{url${steps.length + 1}}}`;
      }
      const specIndex = args.indexOf('--spec');
      if (specIndex >= 0 && args[specIndex + 1]) {
        args[specIndex + 1] = describeCliPath(args[specIndex + 1]).resolvedPath;
      }
      const step: RecordedAction = { schema: SCHEMA, seq: steps.length + 1,
        at: new Date().toISOString(), argv: args,
        ...(options.frame ? { frame: options.frame } : {}),
        verification: options.verification ?? 'command' };
      appendFileSync(file, `${JSON.stringify(step)}\n`, { encoding: 'utf8', mode: 0o600 });
    } finally {
      closeSync(lock);
      unlinkSync(lockFile);
    }
  } catch (error) {
    outputCommandError(error, 'ACTION_RECORD_FAILED');
    process.exitCode = 1;
  }
}

export function replayActions(file: string, page: string, options: { paramsFile?: string; cdpUrl: string; session?: string }): void {
  try {
    const steps = readActions(describeCliPath(file).normalizedPath);
    if (steps.length === 0) throw new Error('Recording has no actions');
    const params = options.paramsFile
      ? JSON.parse(readFileSync(describeCliPath(options.paramsFile).normalizedPath, 'utf8')) as Record<string, unknown> : {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Params file must be a JSON object');
    for (const step of steps) {
      const args = step.argv.map(arg => arg.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key: string) => {
        if (key === 'page') return page;
        if (typeof params[key] !== 'string') throw new Error(`Missing string parameter ${key} for step ${step.seq}`);
        return params[key] as string;
      }));
      if (args.some(arg => /\{\{/.test(arg))) throw new Error(`Unresolved placeholder at step ${step.seq}`);
      const child = spawnSync(process.execPath, [...(exeMode ? [] : [resolve(process.argv[1])]), ...args,
        '--cdp-url', options.cdpUrl, ...(options.session ? ['--session', options.session] : [])], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
        env: { ...process.env, CDP_RECORD_FILE: '', CDP_RECORD_REPLAY: '1' }, windowsHide: true
      });
      if (child.error) throw new Error(`Step ${step.seq}: ${child.error.message}`);
      const lines = String(child.stdout ?? '').split(/\r?\n/).filter(Boolean);
      const parsed = lines.map(line => { try { return JSON.parse(line); } catch { return null; } });
      const result = parsed[parsed.length - 1];
      const value = result?.value ?? result?.data;
      const delivered = value?.action ?? value;
      const frameFailure = delivered?.frameReached === false || delivered?.clickDelivered === false;
      const frameUnverified = Boolean(step.frame) && step.verification !== 'expectation' &&
        args[0] === 'click' && delivered?.clickDelivered !== true && delivered?.frameReached !== true;
      const expectationFailure = step.verification === 'expectation' && value?.outcome !== 'PASSED';
      if (child.status !== 0 || result?.success !== true || frameFailure || frameUnverified || expectationFailure) {
        outputLine({ success: false, type: 'action-replay', step: step.seq,
          reason: child.status !== 0 || result?.success !== true ? 'command-failed'
            : frameFailure ? 'frame-or-click-not-delivered'
              : frameUnverified ? 'frame-delivery-unverified' : expectationFailure ? 'expectation-not-passed' : 'command-failed',
          result: result ?? null, stderr: String(child.stderr ?? '').slice(0, 500) });
        process.exitCode = 1;
        return;
      }
    }
    outputLine({ success: true, type: 'action-replay', steps: steps.length, outcome: 'PASSED' });
  } catch (error) {
    outputCommandError(error, 'ACTION_REPLAY_FAILED');
    process.exitCode = 1;
  }
}
