import { describe, expect, it } from 'vitest';
import { PageRegistrationTracker } from '../../../src/daemon/page-registration-tracker.js';

describe('PageRegistrationTracker', () => {
  const trackerAt = (clock: { now: number }) => new PageRegistrationTracker({
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
    maxAttempts: 4,
    now: () => clock.now
  });

  it('backs off exponentially and caps the delay', () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      tracker.recordFailure('page', new Error('wedged'));
      const [record] = tracker.list();
      delays.push(record.nextAttemptAt! - clock.now);
      clock.now = record.nextAttemptAt!;
    }

    // 1s, 2s, 4s - the third is already at the cap, not 4s-then-8s.
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it('refuses an attempt until the backoff is due', () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);

    expect(tracker.shouldAttempt('page')).toBe(true);
    tracker.recordFailure('page', new Error('wedged'));

    expect(tracker.shouldAttempt('page')).toBe(false);
    clock.now = 999;
    expect(tracker.shouldAttempt('page')).toBe(false);
    clock.now = 1_000;
    expect(tracker.shouldAttempt('page')).toBe(true);
  });

  it('gives up after the attempt limit and records why, with no next attempt', () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      clock.now += 10_000;
      tracker.recordFailure('page', new Error('renderer is wedged'));
    }

    expect(tracker.list()).toEqual([
      expect.objectContaining({
        pageId: 'page',
        attempts: 4,
        gaveUp: true,
        nextAttemptAt: null,
        reason: 'renderer is wedged'
      })
    ]);
    expect(tracker.abandonedCount).toBe(1);
    // The whole point of giving up: it stops being attempted.
    expect(tracker.shouldAttempt('page')).toBe(false);
  });

  it('clears the streak on success so a recovered page is not judged by old failures', () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);

    tracker.recordFailure('page', new Error('transient'));
    tracker.recordFailure('page', new Error('transient'));
    tracker.recordSuccess('page');

    expect(tracker.list()).toEqual([]);
    expect(tracker.shouldAttempt('page')).toBe(true);
  });

  it('forgets a page explicitly, which is the escape hatch from a give-up', () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);

    for (let attempt = 0; attempt < 4; attempt += 1) tracker.recordFailure('page', new Error('x'));
    expect(tracker.shouldAttempt('page')).toBe(false);

    tracker.forget('page');
    expect(tracker.shouldAttempt('page')).toBe(true);
    expect(tracker.abandonedCount).toBe(0);
  });

  it('drops records for pages that no longer exist', () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);

    tracker.recordFailure('gone', new Error('x'));
    tracker.recordFailure('still-here', new Error('x'));

    tracker.retainOnly(new Set(['still-here']));

    expect(tracker.list().map((page) => page.pageId)).toEqual(['still-here']);
    // A page id that comes back is a new page, judged on its own record.
    expect(tracker.shouldAttempt('gone')).toBe(true);
  });
});
