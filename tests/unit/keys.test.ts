/**
 * Tests for key descriptors
 */

import { describe, it, expect } from 'vitest';
import { describeChar, describeKey } from '../../src/keys.js';

describe('keys', () => {
  describe('describeKey', () => {
    it('should give named keys a virtual key code', () => {
      // Without windowsVirtualKeyCode Chrome delivers the event but never acts
      // on it, so Enter has to carry 13.
      expect(describeKey('enter')).toEqual({
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        text: '\r'
      });
      expect(describeKey('tab').keyCode).toBe(9);
      expect(describeKey('escape').keyCode).toBe(27);
      expect(describeKey('arrowdown').keyCode).toBe(40);
      expect(describeKey('backspace').keyCode).toBe(8);
    });

    it('should not give text to keys that insert nothing', () => {
      expect(describeKey('tab').text).toBeUndefined();
      expect(describeKey('escape').text).toBeUndefined();
      expect(describeKey('arrowup').text).toBeUndefined();
    });

    it('should be case insensitive', () => {
      expect(describeKey('ENTER')).toEqual(describeKey('enter'));
      expect(describeKey('ArrowLeft').keyCode).toBe(37);
    });

    it('should accept aliases', () => {
      expect(describeKey('esc')).toEqual(describeKey('escape'));
      expect(describeKey('return')).toEqual(describeKey('enter'));
      expect(describeKey('up')).toEqual(describeKey('arrowup'));
    });

    it('should map function keys', () => {
      expect(describeKey('F1')).toEqual({ key: 'F1', code: 'F1', keyCode: 112 });
      expect(describeKey('f12').keyCode).toBe(123);
    });

    it('should treat a single character as that character', () => {
      expect(describeKey('a')).toEqual({
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        text: 'a'
      });
    });

    it('should throw on an unknown key name rather than sending a dead event', () => {
      expect(() => describeKey('nonsense')).toThrow(/Unknown key/);
    });
  });

  describe('describeChar', () => {
    it('should map letters, digits and symbols to codes', () => {
      expect(describeChar('q')).toEqual({ key: 'q', code: 'KeyQ', keyCode: 81, text: 'q' });
      expect(describeChar('Q')).toEqual({ key: 'Q', code: 'KeyQ', keyCode: 81, text: 'Q' });
      expect(describeChar('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
      expect(describeChar('@')).toEqual({ key: '@', code: 'Digit2', keyCode: 50, text: '@' });
      expect(describeChar('.')).toEqual({ key: '.', code: 'Period', keyCode: 190, text: '.' });
    });

    it('should map whitespace to its named key', () => {
      expect(describeChar(' ').code).toBe('Space');
      expect(describeChar('\n').key).toBe('Enter');
      expect(describeChar('\t').key).toBe('Tab');
    });

    it('should still carry text for characters with no US key code', () => {
      const emoji = describeChar('é');
      expect(emoji.text).toBe('é');
      expect(emoji.keyCode).toBe(0);
    });
  });
});
