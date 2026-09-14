/**
 * Retry accounting for pages the daemon cannot register.
 *
 * The health check re-registers every page that is not in `sessions`, and a
 * page whose registration failed is by definition never in `sessions`. Without
 * this, a page that cannot be registered is retried every 5 seconds forever:
 * it burns CPU, it repeatedly attaches to a renderer that is already sick, and
 * the real condition is invisible because nothing ever records it.
 *
 * So: back off, then give up - and make the give-up VISIBLE. A daemon that
 * silently stops trying is just a quieter version of the same defect, which is
 * why `list()` is served on `/sessions` and the count on `/health`.
 */

export interface UnregisterablePage {
  pageId: string;
  /** Consecutive failed registration attempts. */
  attempts: number;
  /** Message from the last failure - why this page cannot be registered. */
  reason: string;
  firstFailureAt: number;
  lastFailureAt: number;
  /** When the next attempt becomes due; null once the daemon has given up. */
  nextAttemptAt: number | null;
  gaveUp: boolean;
}

export interface PageRegistrationTrackerOptions {
  /** Delay before the first retry; doubles per attempt. */
  baseDelayMs?: number;
  /** Ceiling on the backoff delay. */
  maxDelayMs?: number;
  /** Consecutive failures after which the page is abandoned. */
  maxAttempts?: number;
  /** Test seam. */
  now?: () => number;
}

const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

interface FailureRecord {
  attempts: number;
  reason: string;
  firstFailureAt: number;
  lastFailureAt: number;
  nextAttemptAt: number | null;
  gaveUp: boolean;
}

export class PageRegistrationTracker {
  private readonly failures = new Map<string, FailureRecord>();
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: PageRegistrationTrackerOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? (() => Date.now());
  }

  /** True when this page may be attempted on this tick. */
  shouldAttempt(pageId: string): boolean {
    const record = this.failures.get(pageId);
    if (!record) return true;
    if (record.gaveUp) return false;
    return record.nextAttemptAt === null || this.now() >= record.nextAttemptAt;
  }

  recordFailure(pageId: string, error: unknown): void {
    const at = this.now();
    const existing = this.failures.get(pageId);
    const attempts = (existing?.attempts ?? 0) + 1;
    const gaveUp = attempts >= this.maxAttempts;
    this.failures.set(pageId, {
      attempts,
      reason: describe(error),
      firstFailureAt: existing?.firstFailureAt ?? at,
      lastFailureAt: at,
      // Exponential from the first retry: 5s, 10s, 20s, 40s, capped. A page
      // that has been abandoned has no next attempt at all.
      nextAttemptAt: gaveUp
        ? null
        : at + Math.min(this.baseDelayMs * 2 ** (attempts - 1), this.maxDelayMs),
      gaveUp
    });
  }

  /** A page that registered is no longer failing; start its next streak clean. */
  recordSuccess(pageId: string): void {
    this.failures.delete(pageId);
  }

  /**
   * Clear the record for one page - the escape hatch for a give-up.
   *
   * An explicit registration request is a caller asserting the page is worth
   * trying again, so it must not be answered out of a stale give-up.
   */
  forget(pageId: string): void {
    this.failures.delete(pageId);
  }

  /**
   * Drop records for pages that no longer exist, so a closed-and-reopened page
   * is never judged by the previous occupant's failures and the map cannot
   * grow without bound across a long-lived daemon.
   */
  retainOnly(livePageIds: ReadonlySet<string>): void {
    for (const pageId of [...this.failures.keys()]) {
      if (!livePageIds.has(pageId)) this.failures.delete(pageId);
    }
  }

  /** Pages currently failing to register, abandoned ones included. */
  list(): UnregisterablePage[] {
    return [...this.failures.entries()].map(([pageId, record]) => ({
      pageId,
      attempts: record.attempts,
      reason: record.reason,
      firstFailureAt: record.firstFailureAt,
      lastFailureAt: record.lastFailureAt,
      nextAttemptAt: record.nextAttemptAt,
      gaveUp: record.gaveUp
    }));
  }

  /** How many pages the daemon has stopped retrying. */
  get abandonedCount(): number {
    let count = 0;
    for (const record of this.failures.values()) if (record.gaveUp) count += 1;
    return count;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
