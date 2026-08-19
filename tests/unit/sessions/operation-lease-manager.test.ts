import { describe, expect, it } from 'vitest';
import {
  OperationLeaseManager,
  type Clock
} from '../../../src/sessions/index.js';

class ManualClock implements Clock {
  nowValue = 0;
  now(): number { return this.nowValue; }
  advance(ms: number): void { this.nowValue += ms; }
}

describe('OperationLeaseManager', () => {
  it('serializes complete operations per root but not across roots', () => {
    const clock = new ManualClock();
    let id = 0;
    const leases = new OperationLeaseManager({ clock, leaseId: () => `lease-${++id}` });
    const first = leases.acquire('root-a', 'alpha', 100);
    expect(leases.acquire('root-b', 'beta', 100).owner).toBe('beta');
    expect(() => leases.acquire('root-a', 'beta', 100)).toThrowError(
      expect.objectContaining({ code: 'LEASE_CONFLICT' })
    );
    leases.release('root-a', 'alpha', first.leaseId);
    expect(leases.acquire('root-a', 'beta', 100).owner).toBe('beta');
  });

  it('judges staleness from the latest heartbeat, not acquisition age', () => {
    const clock = new ManualClock();
    const leases = new OperationLeaseManager({ clock, leaseId: () => 'lease' });
    const lease = leases.acquire('root', 'alpha', 100);
    clock.advance(90);
    leases.heartbeat('root', 'alpha', lease.leaseId);
    clock.advance(90);

    expect(leases.inspect('root')?.owner).toBe('alpha');
    clock.advance(10);
    expect(leases.inspect('root')).toBeUndefined();
    expect(leases.acquire('root', 'beta', 100).owner).toBe('beta');
  });

  it('prevents heartbeat, release, and teardown by a non-owner', () => {
    const leases = new OperationLeaseManager({ leaseId: () => 'lease' });
    const lease = leases.acquire('root', 'alpha');
    expect(() => leases.heartbeat('root', 'beta', lease.leaseId)).toThrowError(
      expect.objectContaining({ code: 'LEASE_NOT_OWNED' })
    );
    expect(() => leases.release('root', 'beta', lease.leaseId)).toThrowError(
      expect.objectContaining({ code: 'LEASE_NOT_OWNED' })
    );
    expect(() => leases.assertMayTeardown('root', 'beta')).toThrowError(
      expect.objectContaining({ code: 'LEASE_NOT_OWNED' })
    );
    expect(leases.inspect('root')?.owner).toBe('alpha');
  });

  it('holds the lease for the entire async callback and releases it on failure', async () => {
    const leases = new OperationLeaseManager({ leaseId: () => 'lease' });
    await expect(leases.withLease('root', 'alpha', async (handle) => {
      expect(leases.inspect('root')?.leaseId).toBe(handle.lease.leaseId);
      expect(() => leases.acquire('root', 'beta')).toThrowError(
        expect.objectContaining({ code: 'LEASE_CONFLICT' })
      );
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect(leases.inspect('root')).toBeUndefined();
  });
});

