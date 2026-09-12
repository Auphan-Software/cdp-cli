import { describe, expect, it } from 'vitest';
import {
  CommandTimeoutError,
  MAX_COMMAND_TIMEOUT_MS,
  validateCommandTimeout
} from '../../../src/cdp/command-timeout.js';

describe('validateCommandTimeout', () => {
  const refused: Array<[string, unknown]> = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['above the ceiling', MAX_COMMAND_TIMEOUT_MS + 1],
    ['a numeric string', '5000'],
    ['undefined', undefined],
    ['Infinity', Number.POSITIVE_INFINITY]
  ];

  for (const [label, value] of refused) {
    it(`refuses ${label} with a reason instead of coercing it`, () => {
      const reason = validateCommandTimeout(value);
      expect(reason).toBeTypeOf('string');
      expect(reason).toContain('--timeout must be a whole number of milliseconds');
      expect(reason).toContain(String(MAX_COMMAND_TIMEOUT_MS));
    });
  }

  for (const value of [1, 10_000, MAX_COMMAND_TIMEOUT_MS]) {
    it(`accepts ${value}ms`, () => {
      expect(validateCommandTimeout(value)).toBeNull();
    });
  }
});

describe('CommandTimeoutError', () => {
  it('keeps the legacy message text and carries the cap it exceeded', () => {
    const error = new CommandTimeoutError('Runtime.evaluate', 12_345);
    expect(error.message).toBe('Command timeout: Runtime.evaluate');
    expect(error.code).toBe('COMMAND_TIMEOUT');
    expect(error.method).toBe('Runtime.evaluate');
    expect(error.timeoutMs).toBe(12_345);
    expect(error).toBeInstanceOf(Error);
  });
});
