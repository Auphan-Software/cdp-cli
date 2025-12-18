/**
 * Tests for CircularBuffer
 */

import { describe, it, expect } from 'vitest';
import { CircularBuffer } from '../../../src/daemon/circular-buffer.js';

describe('CircularBuffer', () => {
  it('should store items up to capacity', () => {
    const buffer = new CircularBuffer<number>(3);

    buffer.push(1);
    buffer.push(2);
    buffer.push(3);

    expect(buffer.size).toBe(3);
    expect(buffer.getAll()).toEqual([1, 2, 3]);
  });

  it('should evict oldest items when full', () => {
    const buffer = new CircularBuffer<number>(3);

    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4); // Evicts 1
    buffer.push(5); // Evicts 2

    expect(buffer.size).toBe(3);
    expect(buffer.getAll()).toEqual([3, 4, 5]);
  });

  it('should return last N items in reverse chronological order', () => {
    const buffer = new CircularBuffer<number>(5);

    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    buffer.push(5);

    expect(buffer.getLast(2)).toEqual([5, 4]);
    expect(buffer.getLast(3)).toEqual([5, 4, 3]);
  });

  it('should handle getLast when requesting more than available', () => {
    const buffer = new CircularBuffer<number>(5);

    buffer.push(1);
    buffer.push(2);

    expect(buffer.getLast(10)).toEqual([2, 1]);
  });

  it('should clear all items', () => {
    const buffer = new CircularBuffer<number>(3);

    buffer.push(1);
    buffer.push(2);
    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.getAll()).toEqual([]);
  });

  it('should report correct maxSize', () => {
    const buffer = new CircularBuffer<number>(500);
    expect(buffer.maxSize).toBe(500);
  });

  it('should throw on invalid capacity', () => {
    expect(() => new CircularBuffer(0)).toThrow('Capacity must be positive');
    expect(() => new CircularBuffer(-1)).toThrow('Capacity must be positive');
  });

  it('should work with wrap-around after evictions', () => {
    const buffer = new CircularBuffer<number>(3);

    // Fill and overflow multiple times
    for (let i = 1; i <= 10; i++) {
      buffer.push(i);
    }

    expect(buffer.size).toBe(3);
    expect(buffer.getAll()).toEqual([8, 9, 10]);
    expect(buffer.getLast(2)).toEqual([10, 9]);
  });
});
