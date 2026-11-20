/**
 * Lifecycle commands: ready (launch Chrome + daemon)
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { fetch as undiciFetch } from 'undici';
import { DaemonClient, isDefaultCdpUrl, resolveDaemonUrl } from '../daemon/client.js';
import { outputLine, outputCommandError, outputSuccess } from '../output.js';

/**
 * Find Chrome executable path
 */
export function findChrome(): string | null {
  const os = platform();

  if (os === 'win32') {
    const paths = [
      join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['LocalAppData'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  } else if (os === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(macPath)) return macPath;
  } else {
    // Linux - assume in PATH
    return 'google-chrome';
  }

  return null;
}

/**
 * Check if Chrome is already running on the given port
 */
async function isChromeRunning(port: number): Promise<boolean> {
  try {
    const res = await (globalThis.fetch ?? undiciFetch)(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(1000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get pages from Chrome
 */
async function getPages(port: number): Promise<any[]> {
  const res = await (globalThis.fetch ?? undiciFetch)(`http://localhost:${port}/json`);
  if (!res.ok) throw new Error('Failed to get pages');
  const pages = await res.json() as any[];
  return pages.filter((p: any) => p.type === 'page');
}

/** Where a `--headless` browser lives unless told otherwise: its own port, daemon port and profile, apart from the visible Chrome on 9222. */
const DEFAULT_PORT = 9222;
export const HEADLESS_PORT = 9333;
export const HEADLESS_PROFILE_NAME = 'cdp-cli-headless-profile';

/**
 * Chrome stops painting and timing a window that is covered or minimised, which starves
 * screencast frames and times out Runtime.evaluate. These four keep a covered window live
 * (a minimised one stays idle: use `--headless`). Harmless on Linux and macOS.
 */
export const KEEP_ALIVE_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
];

/** The command line `ready` starts Chrome with. */
export function chromeLaunchArgs(profile: string, port: number, headless: boolean): string[] {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1024,728',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--disable-extensions',
    ...KEEP_ALIVE_FLAGS,
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  return args;
}

/**
 * Launch Chrome with debugging enabled
 */
function launchChrome(chromePath: string, profile: string, port: number, headless: boolean): ChildProcess {
  const child = spawn(chromePath, chromeLaunchArgs(profile, port, headless), {
    detached: true,
    stdio: 'ignore',
    windowsHide: headless,
  });

  child.unref();
  return child;
}

export interface HeadlessTarget { port: number; profile: string; cdpUrl: string; daemonUrl: string }

/**
 * The own browser a `--headless` run uses: port 9333, profile ~/cdp-cli-headless-profile and the
 * daemon one port above, unless given. An explicit --cdp-url wins. A CDP_DAEMON_URL already in the
 * shell is ignored (it serves another browser); this sets it for this process and the commands it
 * runs, so they reach the daemon of this browser.
 */
export function resolveHeadlessTarget(options: { port?: number; profile?: string; cdpUrl?: string }): HeadlessTarget {
  const port = options.port ?? HEADLESS_PORT;
  const profile = options.profile ?? join(homedir(), HEADLESS_PROFILE_NAME);
  const cdpUrl = options.cdpUrl && !isDefaultCdpUrl(options.cdpUrl) ? options.cdpUrl : `http://127.0.0.1:${port}`;
  const daemonUrl = `http://127.0.0.1:${port + 1}`;
  process.env.CDP_DAEMON_URL = daemonUrl;
  return { port, profile, cdpUrl, daemonUrl };
}

/** How to reach a headless browser from another shell, as shell lines. */
export function headlessReachLines(target: HeadlessTarget): string[] {
  return [
    `headless Chrome (own profile ${target.profile}) at ${target.cdpUrl}, daemon at ${target.daemonUrl}`,
    `to use it from another shell: set CDP_URL=${target.cdpUrl} and CDP_DAEMON_URL=${target.daemonUrl}`,
  ];
}

/** Start Chrome (when nothing answers on the port) and the daemon (when not running); return the open pages. */
export async function ensureBrowser(options: {
  profile: string;
  port: number;
  cdpUrl: string;
  headless: boolean;
}): Promise<{ chromeStarted: boolean; daemonStarted: boolean; pages: any[] }> {
  const { profile, port, cdpUrl, headless } = options;
  let chromeStarted = false;

  // Check if Chrome already running
  if (!await isChromeRunning(port)) {
    const chromePath = findChrome();
    if (!chromePath) {
      throw new Error('Chrome not found. Install Chrome or specify path.');
    }

    launchChrome(chromePath, profile, port, headless);
    chromeStarted = true;

    // Poll for Chrome to be ready
    const maxWait = 10000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (await isChromeRunning(port)) break;
      await new Promise(r => setTimeout(r, 200));
    }

    if (!await isChromeRunning(port)) {
      throw new Error('Chrome failed to start within timeout');
    }
  }

  // Start daemon if not running
  const client = new DaemonClient({ cdpUrl });
  let daemonStarted = false;
  if (!await client.isRunning()) {
    await client.startDaemon({ cdpUrl });
    daemonStarted = true;
  }

  return { chromeStarted, daemonStarted, pages: await getPages(port) };
}

/**
 * Ready command - Launch Chrome + start daemon + return pages
 */
export async function ready(options: {
  /** Default: ~/cdp-cli-profile (--headless: ~/cdp-cli-headless-profile). */
  profile?: string;
  /** Default: 9222 (--headless: 9333). */
  port?: number;
  cdpUrl: string;
  headless?: boolean;
}): Promise<void> {
  const { headless = false } = options;
  let profile = options.profile ?? join(homedir(), 'cdp-cli-profile');
  let port = options.port ?? DEFAULT_PORT;
  let cdpUrl = options.cdpUrl;

  try {
    // `--headless` is its own browser: its own port, profile and daemon, apart from the visible Chrome.
    let target: HeadlessTarget | undefined;
    if (headless) {
      target = resolveHeadlessTarget({ port: options.port, profile: options.profile, cdpUrl });
      ({ profile, port, cdpUrl } = target);
    }

    // `ready` needs the daemon, so refuse a missing daemon configuration
    // before launching a Chrome that would then be left running.
    resolveDaemonUrl({ cdpUrl });

    const { chromeStarted, daemonStarted, pages } = await ensureBrowser({ profile, port, cdpUrl, headless });

    // Output status
    for (const page of pages) {
      outputLine({
        id: page.id,
        title: page.title,
        url: page.url,
      });
    }

    outputSuccess('Ready', {
      chromeStarted,
      daemonStarted,
      headless,
      pages: pages.length,
      ...(target ? { cdpUrl: target.cdpUrl, daemonUrl: target.daemonUrl } : {}),
    });
    if (target) for (const line of headlessReachLines(target)) process.stderr.write(`${line}\n`);
  } catch (error) {
    outputCommandError(
      error,
      'READY_FAILED',
      {}
    );
    process.exit(1);
  }
}

/**
 * Start (or reuse) the own headless browser for `video --headless` and tell the user how to reach it.
 * Returns the browser to record in and its first page.
 */
export async function startHeadlessBrowser(): Promise<{ target: HeadlessTarget; pageId: string }> {
  const target = resolveHeadlessTarget({});
  const { pages } = await ensureBrowser({ profile: target.profile, port: target.port, cdpUrl: target.cdpUrl, headless: true });
  if (!pages.length) throw new Error('the headless Chrome has no page to record');
  for (const line of headlessReachLines(target)) process.stderr.write(`${line}\n`);
  return { target, pageId: pages[0].id };
}
