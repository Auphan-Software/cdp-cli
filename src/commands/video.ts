/**
 * `video replay` and `video record`: a WebM (or MP4) of one page with the
 * pointer drawn and a ring at each click, ending with the video's own check
 * `overlay: pointer seen at N/N click steps` (the Jarvis browser-video contract).
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { CDPContext } from '../context.js';
import { DaemonClient } from '../daemon/client.js';
import { outputCommandError, outputLine } from '../output.js';
import { describeCliPath } from '../path.js';
import { runCli } from '../workflow.js';
import { glidePath } from '../video/overlay.js';
import { VideoCapture } from '../video/capture.js';
import { checkClicks, encodeWebm, findFfmpeg, transcodeMp4, type CapturedFrame, type ClickMark, type OverlayResult } from '../video/encoder.js';
import { childArgs, conditionExpression, describeStep, locateExpression, parseSteps, type VideoStep } from '../video/steps.js';

export const DEFAULT_RECORD_SECONDS = 60;
export const MAX_RECORD_SECONDS = 3600;
const DEFAULT_GLIDE_MS = 450;
const DEFAULT_STEP_TIMEOUT_S = 5;

export interface VideoOptions { page: string; out?: string; size?: string; keepFrames?: boolean }
interface StepMark { n: number; do: string; caption: string; start: number; end: number; status: 'ok' | 'fail'; note?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Output path and format; MP4 needs an ffmpeg already on this machine, checked before recording. */
export function resolveOutput(out: string | undefined, now = new Date()): { file: string; mp4: boolean } {
  const file = describeCliPath(out ?? `cdp-video-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.webm`).resolvedPath;
  const ext = extname(file).toLowerCase();
  if (ext !== '.webm' && ext !== '.mp4') throw new Error('VIDEO_INVALID_OUTPUT: --out must end in .webm or .mp4');
  return { file, mp4: ext === '.mp4' };
}

/** Where `replay` writes the timing index of a video: `<name>.steps.json` beside it. */
export function stepsIndexPath(videoFile: string): string {
  return videoFile.replace(/\.(webm|mp4)$/i, '.steps.json');
}

/** The same file by its real location: symlinks followed, and case ignored where the filesystem usually ignores it. */
export function sameFile(a: string, b: string, platform = process.platform): boolean {
  const real = (f: string): string => {
    const full = resolve(f);
    try { return existsSync(full) ? realpathSync(full) : join(realpathSync(dirname(full)), basename(full)); } catch { return full; }
  };
  const fold = (f: string): string => (platform === 'win32' || platform === 'darwin' ? f.toLowerCase() : f);
  if (fold(real(a)) === fold(real(b))) return true;
  try { // hard links and other aliases of an existing file share a device and inode
    const x = statSync(a), y = statSync(b);
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch { return false; }
}

export function parseSize(size: string | undefined): { width: number; height: number } | undefined {
  if (!size) return undefined;
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!m) throw new Error('VIDEO_INVALID_SIZE: --size is WIDTHxHEIGHT, e.g. 1280x720');
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** The frame on screen at browser time `at` (seconds): the last frame at or before it, or the first after it with `after`. */
export function frameTimeAt(frames: CapturedFrame[], t0: number, at: number, after = false): number {
  const t = at - t0;
  if (after) return (frames.find((f) => f.t >= t) ?? frames[frames.length - 1]).t;
  const before = frames.filter((f) => f.t <= t);
  return (before.length ? before[before.length - 1] : frames[0]).t;
}

export function overlayLine(overlay: OverlayResult): string {
  if (!overlay.checked) return 'overlay: not checked (no click steps)';
  return overlay.missing.length
    ? `overlay: pointer NOT seen at click step${overlay.missing.length > 1 ? 's' : ''} ${overlay.missing.join(',')} of ${overlay.checked}: do not use this video as proof of where clicks happen`
    : `overlay: pointer seen at ${overlay.ok}/${overlay.checked} click steps`;
}

async function startCapture(context: CDPContext, options: VideoOptions, follow: boolean) {
  const output = resolveOutput(options.out);
  const ffmpeg = output.mp4 ? findFfmpeg() : undefined;
  if (output.mp4 && !ffmpeg) {
    throw new Error('VIDEO_MP4_NEEDS_FFMPEG: no ffmpeg on PATH (or CDP_FFMPEG); use --out <file>.webm, which needs nothing else');
  }
  const page = await context.findPage(options.page);
  // The recorder's own WebSocket counts as an attached debugger to every child command unless
  // the daemon holds a session for the page, so start the daemon when none is running.
  const daemon = new DaemonClient({ cdpUrl: context.cdpUrl });
  if (!await daemon.isRunning()) await daemon.startDaemon({ cdpUrl: context.cdpUrl });
  await context.ensureDaemonPageSession(page);
  await context.assertNoDevTools(page.id);
  // A directory made for this run alone: the cleanup below deletes it recursively.
  const framesDir = mkdtempSync(`${output.file}.frames-`);
  const capture = new VideoCapture(context, page, framesDir);
  try {
    await capture.start({ follow, size: parseSize(options.size) });
  } catch (error) {
    await capture.stop().catch(() => undefined);
    rmSync(framesDir, { recursive: true, force: true });
    throw error;
  }
  return { output, ffmpeg, page, framesDir, capture };
}

/** Stop, encode, write the file, check the pointer at each click and print the result. */
async function finish(context: CDPContext, run: Awaited<ReturnType<typeof startCapture>>, options: VideoOptions,
  clicksAt: (frames: CapturedFrame[], t0: number) => ClickMark[], extra: Record<string, unknown>,
  marks?: StepMark[]): Promise<number> {
  const { capture, output, ffmpeg, framesDir } = run;
  const { frames, end, t0 } = await capture.stop();
  if (!frames.length) throw new Error('VIDEO_NO_FRAMES: the page sent no screencast frames');
  const webm = await encodeWebm(context, frames, end, { width: capture.width, height: capture.height });
  const webmFile = output.mp4 ? join(framesDir, 'video.webm') : output.file;
  writeFileSync(webmFile, webm);
  if (output.mp4) transcodeMp4(ffmpeg as string, webmFile, output.file);
  const clicks = clicksAt(frames, t0);
  const scale = capture.cssWidth ? capture.width / capture.cssWidth : 1;
  const overlay = await checkClicks(context, output.file, output.mp4 ? 'video/mp4' : 'video/webm', clicks, scale);
  let stepsFile: string | undefined;
  if (marks) {
    const clock = (v: number) => Math.round(Math.min(end, Math.max(0, v - t0)) * 1000) / 1000;
    const steps = marks.map((m) => ({ n: m.n, do: m.do, caption: m.caption, start: clock(m.start), end: clock(m.end),
      status: m.status, key_moment: Math.round(frameTimeAt(frames, t0, m.end) * 1000) / 1000, ...(m.note ? { note: m.note } : {}) }));
    stepsFile = stepsIndexPath(output.file);
    writeFileSync(stepsFile, JSON.stringify({ schema: 'browser-video-steps/1', end: Math.round(end * 1000) / 1000, steps }, null, 1));
  }
  if (!options.keepFrames) rmSync(framesDir, { recursive: true, force: true });
  const line = overlayLine(overlay);
  process.stderr.write(`${line}\n`);
  const failed = marks?.some((m) => m.status === 'fail');
  outputLine({ success: !failed && !overlay.missing.length, type: 'video', file: output.file, durationSeconds: Math.round(end * 10) / 10,
    frames: frames.length, ...(stepsFile ? { stepsFile } : {}), ...extra, overlay: { ...overlay, line } });
  return failed ? 1 : overlay.missing.length ? 4 : 0;
}

async function poll<T>(timeoutS: number, probe: () => Promise<T | { wait: string }>, what: string): Promise<T> {
  const deadline = Date.now() + timeoutS * 1000;
  let last = 'not found';
  for (;;) {
    const r = await probe();
    if (!(r && typeof r === 'object' && 'wait' in r)) return r as T;
    last = r.wait;
    if (Date.now() >= deadline) throw new Error(`${what} within ${timeoutS}s: ${last}`);
    await sleep(100);
  }
}

/** Replay a step file on a page while recording it. */
export async function videoReplay(context: CDPContext, file: string,
  options: VideoOptions & { hold?: number; glideMs?: number }): Promise<void> {
  let run: Awaited<ReturnType<typeof startCapture>> | undefined;
  try {
    if (sameFile(stepsIndexPath(resolveOutput(options.out).file), describeCliPath(file).normalizedPath)) {
      throw new Error('VIDEO_STEPS_COLLISION: the timing index would overwrite the step file; name the video differently (--out) or the step file something other than <video>.steps.json');
    }
    const doc = parseSteps(readFileSync(describeCliPath(file).normalizedPath, 'utf8'));
    run = await startCapture(context, options, false);
    const { capture, page } = run;
    const glideMs = options.glideMs ?? doc.glideMs ?? DEFAULT_GLIDE_MS;
    const session = [...['--cdp-url', context.cdpUrl], ...(context.workspaceSessionName ? ['--session', context.workspaceSessionName] : [])];
    let pointer: [number, number] = doc.pointer ?? await capture.evaluate('[innerWidth/2,innerHeight/2]');
    await capture.evaluate(`__bv.move(${pointer[0]},${pointer[1]})`);
    const marks: StepMark[] = [];
    const clicks: Array<{ n: number; at: [number, number]; seen: number }> = [];
    let caption = '';
    for (const [index, step] of doc.steps.entries()) {
      const n = index + 1;
      if (step.caption !== undefined) { caption = step.caption; await capture.evaluate(`__bv.caption(${JSON.stringify(caption)})`); }
      const mark: StepMark = { n, do: describeStep(step), caption, start: await capture.now(), end: 0, status: 'ok' };
      marks.push(mark);
      try {
        await runStep(step, n);
        await capture.painted();
        if (options.hold) await sleep(options.hold * 1000);
      } catch (error) {
        mark.status = 'fail';
        mark.note = (error as Error).message;
      }
      mark.end = await capture.now();
      if (mark.status === 'fail') break;
    }

    async function runStep(step: VideoStep, n: number): Promise<void> {
      const timeoutS = step.timeout ?? DEFAULT_STEP_TIMEOUT_S;
      if (step.do === 'caption') {
        caption = step.text ?? '';
        await capture.evaluate(`__bv.caption(${JSON.stringify(caption)})`);
        marks[marks.length - 1].caption = caption;
        return;
      }
      if (step.do === 'wait' && step.ms !== undefined) { await sleep(step.ms); return; }
      if (step.do === 'wait' || step.do === 'assert-visible') {
        await poll(timeoutS, async () => (await capture.evaluate(conditionExpression(step))) ? true : { wait: 'condition not met' },
          step.do === 'wait' ? 'wait not satisfied' : 'not visible');
        return;
      }
      let point: [number, number] | undefined;
      if (step.do === 'click' || step.do === 'type') {
        const target = await poll<{ x: number; y: number }>(timeoutS, () => capture.evaluate(locateExpression(step)), 'not clickable');
        point = [target.x, target.y];
        for (const [x, y] of glidePath(pointer, point, glideMs)) {
          await capture.evaluate(`__bv.move(${x},${y})`);
          if (glideMs) await sleep(12);
        }
        pointer = point;
        await capture.painted();
        const at = await capture.evaluate('__bv.at()') as [number, number];
        if (Math.abs(at[0] - point[0]) > 2 || Math.abs(at[1] - point[1]) > 2) throw new Error('the pointer overlay is not on the target');
        clicks.push({ n, at: point, seen: await capture.now() });
        await capture.evaluate('__bv.click()');
      }
      const args = childArgs(step, page.id, point);
      const clickArgs = step.do === 'type' ? childArgs({ do: 'click' }, page.id, point) : undefined;
      for (const command of [clickArgs, args]) {
        if (!command) continue;
        const result = await runCli([...command, ...session]);
        if (!result.ok) {
          const row = result.rows.find((r) => r.error === true || r.success === false) ?? result.rows[result.rows.length - 1];
          throw new Error(`${command[0]} failed: ${row?.message ?? row?.code ?? 'unknown error'}`);
        }
      }
    }

    const failed = marks.find((m) => m.status === 'fail');
    if (failed) {
      process.stderr.write(`replay failed at step ${failed.n} (${failed.do}): ${failed.note}\n`);
    }
    const r = run;
    run = undefined; // finish stops the capture itself
    process.exitCode = await finish(context, r, options,
      (frames, t0) => clicks.map((c) => ({ n: c.n, at: c.at, t: frameTimeAt(frames, t0, c.seen) })),
      { steps: doc.steps.length, ...(failed ? { failedStep: failed.n, reason: failed.note } : {}) }, marks);
  } catch (error) {
    outputCommandError(error, 'VIDEO_REPLAY_FAILED');
    process.exitCode = 1;
  } finally {
    if (run) await run.capture.stop().catch(() => undefined);
  }
}

/**
 * Record a page while a person (or another tool) drives it: the pointer follows
 * the real mouse and each real press rings. Bounded: --seconds (default 60,
 * at most 3600); Ctrl+C stops early and still writes the video.
 */
export async function videoRecord(context: CDPContext, options: VideoOptions & { seconds?: number }): Promise<void> {
  let run: Awaited<ReturnType<typeof startCapture>> | undefined;
  const seconds = options.seconds ?? DEFAULT_RECORD_SECONDS;
  let stop = false;
  const onSignal = () => { stop = true; };
  try {
    if (!(seconds > 0 && seconds <= MAX_RECORD_SECONDS)) throw new Error(`VIDEO_INVALID_SECONDS: --seconds must be above 0 and at most ${MAX_RECORD_SECONDS}`);
    run = await startCapture(context, options, true);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const deadline = Date.now() + seconds * 1000;
    while (!stop && !run.capture.closed && Date.now() < deadline) await sleep(100);
    const presses = [...run.capture.presses];
    const r = run;
    run = undefined;
    process.exitCode = await finish(context, r, options,
      (frames, t0) => presses.map((p, i) => ({ n: i + 1, at: [p.x, p.y] as [number, number], t: frameTimeAt(frames, t0, p.t, true) })),
      { clicks: presses.length, stopped: stop ? 'signal' : r.capture.closed ? 'disconnected' : 'duration' });
  } catch (error) {
    outputCommandError(error, 'VIDEO_RECORD_FAILED');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (run) await run.capture.stop().catch(() => undefined);
  }
}
