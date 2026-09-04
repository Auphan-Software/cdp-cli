/**
 * Tests for output formatting (NDJSON)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  outputLine,
  outputLines,
  outputError,
  outputSuccess,
  outputRaw,
  outputCommandError
} from '../../src/output.js';
import { SessionFoundationError } from '../../src/sessions/errors.js';
import { captureConsoleOutput } from '../helpers.js';

describe('Output Formatting', () => {
  let capture: ReturnType<typeof captureConsoleOutput>;

  beforeEach(() => {
    capture = captureConsoleOutput();
  });

  afterEach(() => {
    capture.restore();
  });

  describe('outputLine', () => {
    it('should output single JSON object', () => {
      outputLine({ foo: 'bar', num: 42 });

      const logs = capture.getLogs();
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0])).toEqual({ foo: 'bar', num: 42 });
    });

    it('should output compact JSON by default', () => {
      outputLine({ foo: 'bar' });

      const logs = capture.getLogs();
      expect(logs[0]).toBe('{"foo":"bar"}');
    });

    it('should output pretty JSON when requested', () => {
      outputLine({ foo: 'bar' }, { pretty: true });

      const logs = capture.getLogs();
      expect(logs[0]).toContain('\n');
      expect(logs[0]).toContain('  "foo"');
    });
  });

  describe('outputLines', () => {
    it('should output multiple NDJSON lines', () => {
      outputLines([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' }
      ]);

      const logs = capture.getLogs();
      expect(logs).toHaveLength(2);
      expect(JSON.parse(logs[0])).toEqual({ id: 1, name: 'Alice' });
      expect(JSON.parse(logs[1])).toEqual({ id: 2, name: 'Bob' });
    });

    it('should handle empty array', () => {
      outputLines([]);

      const logs = capture.getLogs();
      expect(logs).toHaveLength(0);
    });
  });

  describe('outputError', () => {
    it('should output error with message and code', () => {
      outputError('Something went wrong', 'ERROR_CODE', { detail: 'info' });

      const logs = capture.getLogs();
      expect(logs).toHaveLength(1);

      const error = JSON.parse(logs[0]);
      expect(error.error).toBe(true);
      expect(error.message).toBe('Something went wrong');
      expect(error.code).toBe('ERROR_CODE');
      expect(error.details).toEqual({ detail: 'info' });
    });

    it('should work without extra data', () => {
      outputError('Failed', 'FAIL');

      const logs = capture.getLogs();
      const error = JSON.parse(logs[0]);
      expect(error.error).toBe(true);
      expect(error.message).toBe('Failed');
      expect(error.code).toBe('FAIL');
    });
  });

  describe('outputSuccess', () => {
    it('should output success message with data', () => {
      outputSuccess('Operation completed', { id: '123', count: 5 });

      const logs = capture.getLogs();
      expect(logs).toHaveLength(1);

      const success = JSON.parse(logs[0]);
      expect(success.success).toBe(true);
      expect(success.message).toBe('Operation completed');
      expect(success.data).toEqual({ id: '123', count: 5 });
    });
  });

  describe('outputRaw', () => {
    it('should output raw string without JSON formatting', () => {
      outputRaw('Plain text output');

      const logs = capture.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toBe('Plain text output');
    });

    it('should preserve whitespace and formatting', () => {
      outputRaw('Line 1\nLine 2\n  Indented');

      const logs = capture.getLogs();
      expect(logs[0]).toBe('Line 1\nLine 2\n  Indented');
    });
  });

  describe('outputCommandError', () => {
    it('keeps the wrapper code and nests the structured cause under details', () => {
      const error = new SessionFoundationError('PAGE_NOT_OWNED', 'Page p1 is not owned by session a', {
        sessionName: 'a',
        pageId: 'p1',
        actualOwner: 'b'
      });

      outputCommandError(error, 'EVAL_FAILED', { expression: '1 + 1' });

      expect(JSON.parse(capture.getLogs()[0])).toEqual({
        error: true,
        message: 'Page p1 is not owned by session a',
        code: 'EVAL_FAILED',
        details: {
          expression: '1 + 1',
          cause: {
            code: 'PAGE_NOT_OWNED',
            message: 'Page p1 is not owned by session a',
            details: { sessionName: 'a', pageId: 'p1', actualOwner: 'b' }
          }
        }
      });
    });

    it('serializes a native cause chain with system error codes', () => {
      const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9223'), { code: 'ECONNREFUSED' });
      const error = new TypeError('fetch failed', { cause: inner });

      outputCommandError(error, 'GET_CONSOLE_LOGS_FAILED');

      expect(JSON.parse(capture.getLogs()[0])).toEqual({
        error: true,
        message: 'fetch failed',
        code: 'GET_CONSOLE_LOGS_FAILED',
        details: {
          cause: {
            message: 'fetch failed',
            cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9223' }
          }
        }
      });
    });

    it('never throws on cyclic, throwing, or oversized details', () => {
      const details: Record<string, unknown> = { big: 'x'.repeat(5000), list: Array.from({ length: 60 }, (_, i) => i) };
      details.self = details;
      Object.defineProperty(details, 'boom', { enumerable: true, get() { throw new Error('getter'); } });
      let deep: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 10; i++) deep = { deep };
      details.deep = deep;
      const error = Object.assign(new Error('failed'), { code: 'SOME_CODE', details });

      outputCommandError(error, 'EVAL_FAILED');

      const [line] = capture.getLogs();
      expect(line.length).toBeLessThan(4000);
      const parsed = JSON.parse(line);
      expect(parsed.code).toBe('EVAL_FAILED');
      const cause = parsed.details.cause;
      expect(cause.code).toBe('SOME_CODE');
      expect(cause.details.self).toBe('[Circular]');
      expect(cause.details.boom).toBe('[Unserializable]');
      expect(cause.details.big).toMatch(/\.\.\.\[truncated 3000 chars\]$/);
      expect(cause.details.list).toHaveLength(51);
      expect(JSON.stringify(cause.details.deep)).toContain('[Truncated]');
    });

    it('omits an empty cause for a plain error and stringifies non-errors', () => {
      outputCommandError(new Error('plain'), 'SNAPSHOT_FAILED');
      outputCommandError('raw failure', 'SNAPSHOT_FAILED', { page: 'p1' });

      const [plain, raw] = capture.getLogs().map((line) => JSON.parse(line));
      expect(plain).toEqual({ error: true, message: 'plain', code: 'SNAPSHOT_FAILED' });
      expect(raw).toEqual({
        error: true,
        message: 'raw failure',
        code: 'SNAPSHOT_FAILED',
        details: { page: 'p1' }
      });
    });
  });
});
