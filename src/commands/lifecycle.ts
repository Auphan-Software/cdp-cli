/**
 * Lifecycle commands: ready (launch Chrome + daemon)
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { fetch as undiciFetch } from 'undici';
import { DaemonClient } from '../daemon/client.js';
import { outputLine, outputError, outputSuccess } from '../output.js';

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

/**
 * Launch Chrome with debugging enabled
 */
function launchChrome(chromePath: string, profile: string, port: number, headless: boolean): ChildProcess {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1024,728',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--disable-extensions',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: headless,
  });

  child.unref();
  return child;
}

/**
 * Ready command - Launch Chrome + start daemon + return pages
 */
export async function ready(options: {
  profile: string;
  port: number;
  cdpUrl: string;
  headless?: boolean;
}): Promise<void> {
  const { profile, port, cdpUrl, headless = false } = options;

  try {
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
    const client = new DaemonClient();
    let daemonStarted = false;
    if (!await client.isRunning()) {
      await client.startDaemon({ cdpUrl });
      daemonStarted = true;
    }

    // Get pages
    const pages = await getPages(port);

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
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'READY_FAILED',
      {}
    );
    process.exit(1);
  }
}
