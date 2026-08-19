import { randomUUID } from 'node:crypto';
import { SessionFoundationError } from './errors.js';
import { systemClock, type Clock } from './types.js';

export interface OperationLease {
  leaseId: string;
  rootTargetId: string;
  owner: string;
  acquiredAt: number;
  lastHeartbeatAt: number;
  ttlMs: number;
}

export interface OperationLeaseHandle {
  readonly lease: OperationLease;
  heartbeat(): OperationLease;
}

export interface OperationLeaseManagerOptions {
  clock?: Clock;
  leaseId?: () => string;
  defaultTtlMs?: number;
}

/** Serializes complete multi-command operations independently per root target. */
export class OperationLeaseManager {
  private readonly clock: Clock;
  private readonly leaseId: () => string;
  private readonly defaultTtlMs: number;
  private readonly leases = new Map<string, OperationLease>();

  constructor(options: OperationLeaseManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.leaseId = options.leaseId ?? randomUUID;
    this.defaultTtlMs = options.defaultTtlMs ?? 30_000;
    validateTtl(this.defaultTtlMs);
  }

  acquire(rootTargetId: string, owner: string, ttlMs = this.defaultTtlMs): OperationLease {
    validateTtl(ttlMs);
    const now = this.clock.now();
    const current = this.leases.get(rootTargetId);
    if (current && !this.isStale(current, now)) {
      throw new SessionFoundationError(
        'LEASE_CONFLICT',
        `Root target ${rootTargetId} is leased by ${current.owner}`,
        {
          rootTargetId,
          requestedOwner: owner,
          currentOwner: current.owner,
          lastHeartbeatAt: current.lastHeartbeatAt,
          ttlMs: current.ttlMs
        }
      );
    }

    const lease: OperationLease = {
      leaseId: this.leaseId(),
      rootTargetId,
      owner,
      acquiredAt: now,
      lastHeartbeatAt: now,
      ttlMs
    };
    this.leases.set(rootTargetId, lease);
    return cloneLease(lease);
  }

  heartbeat(rootTargetId: string, owner: string, leaseId: string): OperationLease {
    const lease = this.requireOwnedLease(rootTargetId, owner, leaseId);
    const now = this.clock.now();
    if (this.isStale(lease, now)) {
      this.leases.delete(rootTargetId);
      throw new SessionFoundationError('LEASE_NOT_FOUND', 'Operation lease has expired', {
        rootTargetId,
        owner,
        leaseId
      });
    }
    lease.lastHeartbeatAt = now;
    return cloneLease(lease);
  }

  release(rootTargetId: string, owner: string, leaseId: string): void {
    this.requireOwnedLease(rootTargetId, owner, leaseId);
    this.leases.delete(rootTargetId);
  }

  /** Prevents a non-owner from closing or otherwise tearing down a leased root. */
  assertMayTeardown(rootTargetId: string, owner: string): void {
    const lease = this.leases.get(rootTargetId);
    if (!lease) return;
    if (this.isStale(lease, this.clock.now())) {
      this.leases.delete(rootTargetId);
      return;
    }
    if (lease.owner !== owner) {
      throw new SessionFoundationError(
        'LEASE_NOT_OWNED',
        `Only ${lease.owner} may tear down root target ${rootTargetId}`,
        { rootTargetId, requestedOwner: owner, currentOwner: lease.owner }
      );
    }
  }

  inspect(rootTargetId: string): OperationLease | undefined {
    const lease = this.leases.get(rootTargetId);
    if (!lease) return undefined;
    if (this.isStale(lease, this.clock.now())) {
      this.leases.delete(rootTargetId);
      return undefined;
    }
    return cloneLease(lease);
  }

  async withLease<T>(
    rootTargetId: string,
    owner: string,
    operation: (handle: OperationLeaseHandle) => Promise<T>,
    ttlMs = this.defaultTtlMs
  ): Promise<T> {
    const initial = this.acquire(rootTargetId, owner, ttlMs);
    let current = initial;
    const handle: OperationLeaseHandle = {
      get lease() {
        return cloneLease(current);
      },
      heartbeat: () => {
        current = this.heartbeat(rootTargetId, owner, initial.leaseId);
        return cloneLease(current);
      }
    };

    try {
      return await operation(handle);
    } finally {
      const active = this.leases.get(rootTargetId);
      if (active?.leaseId === initial.leaseId && active.owner === owner) {
        this.leases.delete(rootTargetId);
      }
    }
  }

  private requireOwnedLease(rootTargetId: string, owner: string, leaseId: string): OperationLease {
    const lease = this.leases.get(rootTargetId);
    if (!lease || lease.leaseId !== leaseId) {
      throw new SessionFoundationError('LEASE_NOT_FOUND', 'Operation lease not found', {
        rootTargetId,
        owner,
        leaseId
      });
    }
    if (lease.owner !== owner) {
      throw new SessionFoundationError('LEASE_NOT_OWNED', 'Operation lease belongs to another owner', {
        rootTargetId,
        requestedOwner: owner,
        currentOwner: lease.owner
      });
    }
    return lease;
  }

  private isStale(lease: OperationLease, now: number): boolean {
    return now - lease.lastHeartbeatAt >= lease.ttlMs;
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new SessionFoundationError('INVALID_LEASE_TTL', 'Lease TTL must be a positive number', {
      ttlMs
    });
  }
}

function cloneLease(lease: OperationLease): OperationLease {
  return { ...lease };
}

