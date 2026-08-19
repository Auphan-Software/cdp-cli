import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { findChrome } from '../../src/commands/lifecycle.js';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);

export interface LiveFixture {
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

export interface CdpPage {
  id: string;
  webSocketDebuggerUrl: string;
}

export interface CleanupStatus {
  chromeStopped: boolean;
  profileRemoved: boolean;
}

/** A small real-CDP client. It deliberately has no protocol mocks. */
export class CdpSession {
  readonly ws: WebSocket;
  private nextId = 1;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async connect(url: string): Promise<CdpSession> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new CdpSession(ws);
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.off('message', onMessage);
        reject(new Error(`Timed out waiting for CDP command: ${method}`));
      }, 10_000);
      const onMessage = (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if (message.id !== id) return;
        clearTimeout(timeout);
        this.ws.off('message', onMessage);
        if (message.error) reject(new Error(message.error.message ?? method));
        else resolve(message.result);
      };
      this.ws.on('message', onMessage);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

export class LiveChrome {
  readonly port: number;
  readonly profileDir: string;
  readonly cdpUrl: string;
  readonly process: ChildProcess;
  private cleanupStatus: CleanupStatus = { chromeStopped: false, profileRemoved: false };

  private constructor(port: number, profileDir: string, process: ChildProcess) {
    this.port = port;
    this.profileDir = profileDir;
    this.cdpUrl = `http://127.0.0.1:${port}`;
    this.process = process;
  }

  static async launch(options: { headful?: boolean } = {}): Promise<LiveChrome> {
    const chromePath = findChrome();
    if (!chromePath) {
      throw new Error('Google Chrome was not found by src/commands/lifecycle.findChrome()');
    }

    const port = await getFreePort();
    const profileDir = await mkdtemp(join(tmpdir(), 'cdp-cli-live-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--site-per-process',
      '--window-size=1024,728',
      ...(options.headful ? [] : ['--headless=new']),
      'about:blank'
    ];
    const child = spawn(chromePath, args, {
      detached: process.platform === 'win32',
      stdio: 'ignore',
      windowsHide: true
    });
    const chrome = new LiveChrome(port, profileDir, child);
    try {
      await waitFor(async () => {
        await chrome.assertOwnsDebugPort();
        const response = await fetch(`${chrome.cdpUrl}/json/version`);
        if (!response.ok) throw new Error(`Chrome returned ${response.status}`);
        return response;
      }, 15_000);
      return chrome;
    } catch (error) {
      await chrome.close();
      throw error;
    }
  }

  async browserSession(): Promise<CdpSession> {
    const version = await (await fetch(`${this.cdpUrl}/json/version`)).json() as { webSocketDebuggerUrl: string };
    return CdpSession.connect(version.webSocketDebuggerUrl);
  }

  /**
   * On Windows, make ownership an explicit precondition before even reading
   * the CDP endpoint. A rare free-port race must fail this suite rather than
   * turn it into an attachment to a developer's existing Chrome.
   */
  private async assertOwnsDebugPort(): Promise<void> {
    if (process.platform !== 'win32') return;
    if (!this.process.pid) throw new Error('Launched Chrome did not expose a process ID');
    const script = [
      `$listener = Get-NetTCPConnection -LocalPort ${this.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`,
      'if (-not $listener) { exit 2 }',
      `$expected = ${this.process.pid}`,
      '$seen = @{}',
      'while ($listener -and -not $seen.ContainsKey($listener)) {',
      '  if ($listener -eq $expected) { exit 0 }',
      '  $seen[$listener] = $true',
      '  $processInfo = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $listener) -ErrorAction SilentlyContinue',
      '  $listener = if ($processInfo) { $processInfo.ParentProcessId } else { $null }',
      '}',
      'exit 1'
    ].join('\n');
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    } catch {
      throw new Error('The CDP port is not owned by this test Chrome process');
    }
  }

  async createPage(url: string): Promise<CdpPage> {
    const browser = await this.browserSession();
    try {
      const created = await browser.command('Target.createTarget', { url });
      const targetId = created.targetId as string;
      return await waitFor(async () => {
        const pages = await (await fetch(`${this.cdpUrl}/json`)).json() as CdpPage[];
        const page = pages.find((candidate) => candidate.id === targetId);
        if (!page?.webSocketDebuggerUrl) throw new Error('New target is not ready yet');
        const session = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
          const ready = await session.command('Runtime.evaluate', {
            expression: 'document.readyState !== "loading"',
            returnByValue: true
          });
          if (ready.result?.value !== true) throw new Error('New target is still loading');
        } finally {
          session.close();
        }
        return page;
      }, 10_000);
    } finally {
      browser.close();
    }
  }

  status(): CleanupStatus {
    return { ...this.cleanupStatus };
  }

  async close(): Promise<void> {
    // The PID is the exact process launched above. On Windows taskkill /T is
    // necessary because Chrome's browser process owns several child processes;
    // it cannot affect a user Chrome outside that process tree.
    if (!this.process.killed && this.process.pid) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(this.process.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          });
          killer.once('exit', () => resolve());
          killer.once('error', () => resolve());
        });
      } else {
        this.process.kill('SIGTERM');
      }
    }

    await waitForPortToClose(this.cdpUrl, 10_000);
    this.cleanupStatus.chromeStopped = true;
    await rm(this.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    try {
      await access(this.profileDir);
      throw new Error(`Test Chrome profile still exists: ${this.profileDir}`);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.cleanupStatus.profileRemoved = true;
    }
  }
}

export async function startFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  host = '127.0.0.1'
): Promise<LiveFixture> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '/');
    handler(request, response);
  });
  await listen(server, host);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  return {
    baseUrl: `http://${host}:${address.port}`,
    requests,
    close: () => closeServer(server)
  };
}

export async function getFreePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  return address.port;
}

export async function waitFor<T>(probe: () => Promise<T> | T, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await probe();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for live browser fixture');
}

function listen(server: Server, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForPortToClose(cdpUrl: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    try {
      await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    throw new Error('Launched Chrome still accepts CDP connections');
  }, timeoutMs);
}
