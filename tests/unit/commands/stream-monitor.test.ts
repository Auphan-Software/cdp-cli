/**
 * Regression tests for the passive monitor safety contract.
 *
 * These cover the hazard proven in production: a bare `list-network` streamed
 * forever while holding the exclusive workspace lease, so a force-kill wedged
 * every other command on that page until the 60s TTL expired.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_STREAM_DURATION_SECONDS,
  MAX_STREAM_DURATION_SECONDS,
  awaitStreamWindow,
  resolveStreamWindow,
  StreamOptionError
} from '../../../src/commands/stream-monitor.js';
import * as network from '../../../src/commands/network.js';
import * as debug from '../../../src/commands/debug.js';
import { CDPContext } from '../../../src/context.js';
import { OperationLeaseManager } from '../../../src/sessions/operation-lease-manager.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { captureConsoleOutput, mockProcessExit } from '../../helpers.js';

describe('stream monitor window resolution', () => {
  it('bounds a bare invocation instead of streaming forever', () => {
    expect(resolveStreamWindow({}, 'list-network')).toEqual({
      follow: false,
      durationSeconds: DEFAULT_STREAM_DURATION_SECONDS
    });
  });

  it('rejects the old implicit forever value and names the safe alternatives', () => {
    let thrown: unknown;
    try {
      resolveStreamWindow({ duration: 0 }, 'list-network');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StreamOptionError);
    expect((thrown as StreamOptionError).code).toBe('STREAM_DURATION_INVALID');
    expect((thrown as Error).message).toContain('--follow');
    expect((thrown as Error).message).toContain('logs network');
  });

  it('rejects negative, non-finite, and over-long bounded windows', () => {
    expect(() => resolveStreamWindow({ duration: -1 }, 'list-console')).toThrow(StreamOptionError);
    expect(() => resolveStreamWindow({ duration: Number.NaN }, 'list-console')).toThrow(
      StreamOptionError
    );
    expect(() =>
      resolveStreamWindow({ duration: MAX_STREAM_DURATION_SECONDS + 1 }, 'list-console')
    ).toThrow(StreamOptionError);
  });

  it('accepts an explicit bounded window', () => {
    expect(resolveStreamWindow({ duration: 5 }, 'list-network')).toEqual({
      follow: false,
      durationSeconds: 5
    });
  });

  it('makes unbounded streaming an explicit opt-in', () => {
    expect(resolveStreamWindow({ follow: true }, 'list-network')).toEqual({ follow: true });
  });

  it('refuses a contradictory --follow --duration pair', () => {
    let thrown: unknown;
    try {
      resolveStreamWindow({ follow: true, duration: 5 }, 'list-network');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as StreamOptionError).code).toBe('STREAM_OPTIONS_CONFLICT');
  });
});

describe('stream monitor window completion and signals', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.useRealTimers();
    process.exitCode = originalExitCode;
  });

  it('completes on its own when the bounded window elapses', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const pending = awaitStreamWindow({ follow: false, durationSeconds: 30 }).then((reason) => {
      settled(reason);
      return reason;
    });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe('duration');
  });

  it('never completes on its own in follow mode, and stops on SIGINT', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const pending = awaitStreamWindow({ follow: true }).then((reason) => {
      settled(reason);
      return reason;
    });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).not.toHaveBeenCalled();

    process.emit('SIGINT');
    await expect(pending).resolves.toBe('interrupted');
    expect(process.exitCode).toBe(130);
  });

  it('stops on SIGTERM and removes both signal handlers', async () => {
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');

    const pending = awaitStreamWindow({ follow: true });
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm + 1);

    process.emit('SIGTERM');
    await expect(pending).resolves.toBe('interrupted');
    expect(process.exitCode).toBe(143);
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);
  });
});

describe('passive monitors and the workspace operation lease', () => {
  beforeEach(() => {
    installMockFetch();
  });

  const page = {
    id: 'page1',
    title: 'Example',
    url: 'https://example.com',
    webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page1'
  };

  it('takes no exclusive lease but still enforces target ownership', async () => {
    const context = new CDPContext('http://localhost:9222', {
      workspaceSession: 'disposable-session'
    });
    const access = vi.spyOn(context, 'assertSessionTargetAccess').mockResolvedValue(undefined);
    const lease = vi.spyOn(context, 'beginSessionTargetLease');

    const ws = (await context.connect(page, { lease: false })) as unknown as MockWebSocket;
    ws.close();

    expect(access).toHaveBeenCalledWith('page1');
    expect(lease).not.toHaveBeenCalled();
  });

  it('positive control: an interaction connect still takes the exclusive lease', async () => {
    const context = new CDPContext('http://localhost:9222', {
      workspaceSession: 'disposable-session'
    });
    const release = vi.fn().mockResolvedValue(undefined);
    const lease = vi
      .spyOn(context, 'beginSessionTargetLease')
      .mockResolvedValue({ release });

    const ws = (await context.connect(page)) as unknown as MockWebSocket;
    ws.close();

    expect(lease).toHaveBeenCalledWith('page1');
  });

  it('leaves the page usable by another command while monitoring is active', async () => {
    const leases = new OperationLeaseManager();
    const context = new CDPContext('http://localhost:9222', {
      workspaceSession: 'disposable-session'
    });
    vi.spyOn(context, 'assertSessionTargetAccess').mockResolvedValue(undefined);
    // Stand in for the daemon's lease registry so any lease the monitor takes
    // would be observable here.
    vi.spyOn(context, 'beginSessionTargetLease').mockImplementation(async (targetId: string) => {
      const acquired = leases.acquire(targetId, 'disposable-session');
      return {
        release: async () => leases.release(targetId, 'disposable-session', acquired.leaseId)
      };
    });

    const capture = captureConsoleOutput();
    const monitoring = network.listNetwork(context, { page: 'page1', duration: 0.15 });

    // Another command on the same named page must be able to take the lease
    // while the passive monitor is running.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const concurrent = leases.acquire('page1', 'other-command');
    expect(concurrent.owner).toBe('other-command');

    await monitoring;
    capture.restore();
  });

  it('negative control: an exclusive lease on the page does conflict', () => {
    const leases = new OperationLeaseManager();
    leases.acquire('page1', 'disposable-session');
    expect(() => leases.acquire('page1', 'other-command')).toThrow(
      /leased by disposable-session/
    );
  });
});

describe('list-network and list-console command windows', () => {
  beforeEach(() => {
    installMockFetch();
  });

  it('bare list-network stops on its own and reports why', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const capture = captureConsoleOutput();
    const context = new CDPContext();
    const settled = vi.fn();

    const pending = network
      .listNetwork(context, { page: 'page1' })
      .then(() => settled());

    await vi.advanceTimersByTimeAsync((DEFAULT_STREAM_DURATION_SECONDS - 1) * 1000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    vi.useRealTimers();

    const logs = capture.getLogs();
    capture.restore();
    expect(settled).toHaveBeenCalled();
    const stopped = JSON.parse(logs[logs.length - 1]);
    expect(stopped).toMatchObject({
      event: 'monitor-stopped',
      command: 'list-network',
      reason: 'duration',
      follow: false,
      durationSeconds: DEFAULT_STREAM_DURATION_SECONDS
    });
  });

  it('list-network --duration 0 fails instead of streaming forever', async () => {
    const capture = captureConsoleOutput();
    const exitMock = mockProcessExit();
    const context = new CDPContext();

    try {
      await network.listNetwork(context, { page: 'page1', duration: 0 });
    } catch {
      // mockProcessExit throws to stop execution
    }

    const error = JSON.parse(capture.getLogs()[0]);
    capture.restore();
    exitMock.restore();

    expect(exitMock.exitCode).toBe(1);
    expect(error.error).toBe(true);
    expect(error.code).toBe('STREAM_DURATION_INVALID');
  });

  it('list-console --duration 0 fails instead of streaming forever', async () => {
    const capture = captureConsoleOutput();
    const exitMock = mockProcessExit();
    const context = new CDPContext();

    try {
      await debug.listConsole(context, { page: 'page1', duration: 0 });
    } catch {
      // mockProcessExit throws to stop execution
    }

    const error = JSON.parse(capture.getLogs()[0]);
    capture.restore();
    exitMock.restore();

    expect(exitMock.exitCode).toBe(1);
    expect(error.code).toBe('STREAM_DURATION_INVALID');
  });

  it('list-console --follow stops on SIGINT and releases its WebSocket', async () => {
    const capture = captureConsoleOutput();
    const context = new CDPContext();
    let closed = false;

    const originalConnect = context.connect.bind(context);
    context.connect = async (page, options) => {
      const ws = (await originalConnect(page, options)) as unknown as MockWebSocket;
      const originalClose = ws.close.bind(ws);
      ws.close = () => {
        closed = true;
        originalClose();
      };
      return ws as never;
    };

    const pending = debug.listConsole(context, { page: 'page1', follow: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.emit('SIGINT');
    await pending;

    const logs = capture.getLogs();
    capture.restore();
    process.exitCode = 0;

    expect(closed).toBe(true);
    const stopped = JSON.parse(logs[logs.length - 1]);
    expect(stopped).toMatchObject({
      event: 'monitor-stopped',
      command: 'list-console',
      reason: 'interrupted',
      follow: true
    });
  });
});
