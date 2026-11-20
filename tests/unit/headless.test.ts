import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KEEP_ALIVE_FLAGS, chromeLaunchArgs, headlessReachLines, resolveHeadlessTarget } from '../../src/commands/lifecycle.js';
import { MINIMISED_MESSAGE, VideoCapture } from '../../src/video/capture.js';

describe('chromeLaunchArgs', () => {
  it('always carries the four keep-alive flags, visible or headless', () => {
    for (const headless of [false, true]) {
      const args = chromeLaunchArgs('/p', 9222, headless);
      for (const flag of [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-features=CalculateNativeWinOcclusion',
      ]) expect(args).toContain(flag);
    }
    expect(KEEP_ALIVE_FLAGS).toHaveLength(4);
  });

  it('adds --headless=new only on request, keeps the port and profile', () => {
    expect(chromeLaunchArgs('/p', 9222, false).some((a) => a.startsWith('--headless'))).toBe(false);
    const args = chromeLaunchArgs('/my profile', 9333, true);
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-port=9333');
    expect(args).toContain('--user-data-dir=/my profile');
  });
});

describe('headless target', () => {
  const saved = process.env.CDP_DAEMON_URL;
  afterEach(() => { if (saved === undefined) delete process.env.CDP_DAEMON_URL; else process.env.CDP_DAEMON_URL = saved; });

  it('gets its own port, daemon and profile, apart from the visible Chrome', () => {
    delete process.env.CDP_DAEMON_URL;
    const t = resolveHeadlessTarget({ cdpUrl: 'http://localhost:9222' });
    expect(t).toEqual({ port: 9333, profile: join(homedir(), 'cdp-cli-headless-profile'),
      cdpUrl: 'http://127.0.0.1:9333', daemonUrl: 'http://127.0.0.1:9334' });
    expect(process.env.CDP_DAEMON_URL).toBe('http://127.0.0.1:9334');
    expect(headlessReachLines(t).join('\n')).toContain('CDP_DAEMON_URL=http://127.0.0.1:9334');
  });

  it('keeps an explicit port and profile, and ignores a CDP_DAEMON_URL meant for another browser', () => {
    process.env.CDP_DAEMON_URL = 'http://127.0.0.1:9500';
    const t = resolveHeadlessTarget({ port: 9400, profile: '/x', cdpUrl: 'http://127.0.0.1:9400' });
    expect(t).toEqual({ port: 9400, profile: '/x', cdpUrl: 'http://127.0.0.1:9400', daemonUrl: 'http://127.0.0.1:9401' });
    expect(process.env.CDP_DAEMON_URL).toBe('http://127.0.0.1:9401');
  });
});

describe('minimised recording window', () => {
  function capture(state: string, evaluateFails = false) {
    const ws = { on: vi.fn(), close: vi.fn() };
    const sendCommand = vi.fn(async (_ws: unknown, method: string) => {
      if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: { windowState: state } };
      if (method === 'Runtime.evaluate' && evaluateFails) throw new Error('timed out');
      return {};
    });
    const context = { connect: vi.fn(async () => ws), sendCommand } as any;
    return { cap: new VideoCapture(context, { id: 'T1' } as any, '/tmp/never-used-frames'), sendCommand, ws };
  }

  it('fails fast with a plain message instead of waiting for frames', async () => {
    const { cap, sendCommand, ws } = capture('minimized');
    await expect(cap.start()).rejects.toThrow(MINIMISED_MESSAGE);
    expect(MINIMISED_MESSAGE).toContain('minimised');
    expect(MINIMISED_MESSAGE).toContain('--headless');
    expect(sendCommand).not.toHaveBeenCalledWith(expect.anything(), 'Page.startScreencast', expect.anything());
    expect(ws.close).toHaveBeenCalled();
  });

  it('names the minimised window when a page script times out', async () => {
    const { cap } = capture('normal', true);
    await cap.start().catch(() => undefined); // start's own evaluate fails on the mock; ws is set by then
    (cap as any).context.sendCommand.mockImplementation(async (_w: unknown, method: string) => {
      if (method === 'Browser.getWindowForTarget') return { bounds: { windowState: 'minimized' } };
      throw new Error('Runtime.evaluate timed out');
    });
    await expect(cap.evaluate('1')).rejects.toThrow(MINIMISED_MESSAGE);
  });

  it('is not minimised when normal, maximized, or the state is unavailable', async () => {
    for (const state of ['normal', 'maximized', 'fullscreen']) {
      const { cap } = capture(state);
      await cap.start().catch(() => undefined);
      expect(await cap.isMinimised()).toBe(false);
    }
  });
});
