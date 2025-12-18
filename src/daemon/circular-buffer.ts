/**
 * Fixed-size circular buffer for log entries
 * Automatically evicts oldest entries when full
 */
export class CircularBuffer<T> {
  private buffer: T[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('Capacity must be positive');
    }
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /**
   * Add an item to the buffer
   * If full, overwrites the oldest item
   */
  push(item: T): void {
    const index = (this.head + this.count) % this.capacity;
    this.buffer[index] = item;

    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Buffer full, advance head (oldest item evicted)
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /**
   * Get the last N items (most recent first)
   */
  getLast(n: number): T[] {
    const count = Math.min(n, this.count);
    const result: T[] = [];

    for (let i = 0; i < count; i++) {
      // Start from most recent and go backwards
      const index = (this.head + this.count - 1 - i) % this.capacity;
      result.push(this.buffer[index]);
    }

    return result;
  }

  /**
   * Get all items in chronological order (oldest first)
   */
  getAll(): T[] {
    const result: T[] = [];

    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.capacity;
      result.push(this.buffer[index]);
    }

    return result;
  }

  /**
   * Clear all items
   */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Current number of items in buffer
   */
  get size(): number {
    return this.count;
  }

  /**
   * Maximum capacity
   */
  get maxSize(): number {
    return this.capacity;
  }
}
