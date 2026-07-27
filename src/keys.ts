/**
 * Key descriptors for Input.dispatchKeyEvent
 *
 * Chrome's renderer needs a virtual key code to turn a synthetic key event
 * into a functional one. Sending only `key` produces an event with
 * keyCode/which of 0, which the browser delivers to listeners but never acts
 * on: Enter will not submit a form, arrows will not scroll, Escape will not
 * close a dialog.
 */

export interface KeyDescriptor {
  key: string;
  code: string;
  /** Windows virtual key code, also used as the native code. */
  keyCode: number;
  /** Text the key inserts, when it inserts any. */
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDescriptor> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
};

// Aliases for names an agent is likely to reach for.
const ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  spacebar: 'space',
  ' ': 'space'
};

const SHIFTED_SYMBOLS: Record<string, { code: string; keyCode: number }> = {
  '!': { code: 'Digit1', keyCode: 49 },
  '@': { code: 'Digit2', keyCode: 50 },
  '#': { code: 'Digit3', keyCode: 51 },
  $: { code: 'Digit4', keyCode: 52 },
  '%': { code: 'Digit5', keyCode: 53 },
  '^': { code: 'Digit6', keyCode: 54 },
  '&': { code: 'Digit7', keyCode: 55 },
  '*': { code: 'Digit8', keyCode: 56 },
  '(': { code: 'Digit9', keyCode: 57 },
  ')': { code: 'Digit0', keyCode: 48 },
  _: { code: 'Minus', keyCode: 189 },
  '+': { code: 'Equal', keyCode: 187 },
  '{': { code: 'BracketLeft', keyCode: 219 },
  '}': { code: 'BracketRight', keyCode: 221 },
  '|': { code: 'Backslash', keyCode: 220 },
  ':': { code: 'Semicolon', keyCode: 186 },
  '"': { code: 'Quote', keyCode: 222 },
  '<': { code: 'Comma', keyCode: 188 },
  '>': { code: 'Period', keyCode: 190 },
  '?': { code: 'Slash', keyCode: 191 },
  '~': { code: 'Backquote', keyCode: 192 }
};

const UNSHIFTED_SYMBOLS: Record<string, { code: string; keyCode: number }> = {
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 }
};

/**
 * Describe a single printable character as a key event.
 */
export function describeChar(char: string): KeyDescriptor {
  if (char === '\n' || char === '\r') {
    return NAMED_KEYS.enter;
  }
  if (char === '\t') {
    return NAMED_KEYS.tab;
  }
  if (char === ' ') {
    return NAMED_KEYS.space;
  }

  if (/^[a-z]$/.test(char)) {
    return {
      key: char,
      code: `Key${char.toUpperCase()}`,
      keyCode: char.toUpperCase().charCodeAt(0),
      text: char
    };
  }

  if (/^[A-Z]$/.test(char)) {
    return {
      key: char,
      code: `Key${char}`,
      keyCode: char.charCodeAt(0),
      text: char
    };
  }

  if (/^[0-9]$/.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      keyCode: char.charCodeAt(0),
      text: char
    };
  }

  const symbol = SHIFTED_SYMBOLS[char] ?? UNSHIFTED_SYMBOLS[char];
  if (symbol) {
    return { key: char, code: symbol.code, keyCode: symbol.keyCode, text: char };
  }

  // Anything else (accented letters, CJK, emoji) still inserts its text; there
  // is no meaningful virtual key code for it on a US layout.
  return { key: char, code: '', keyCode: 0, text: char };
}

/**
 * Describe a named key ("enter", "ArrowUp", "F5") or a single character.
 */
export function describeKey(name: string): KeyDescriptor {
  const lower = name.toLowerCase();
  const resolved = ALIASES[lower] ?? lower;

  const named = NAMED_KEYS[resolved];
  if (named) {
    return named;
  }

  const functionKey = /^f([1-9]|1[0-2])$/.exec(resolved);
  if (functionKey) {
    const number = Number(functionKey[1]);
    return { key: `F${number}`, code: `F${number}`, keyCode: 111 + number };
  }

  if (name.length === 1) {
    return describeChar(name);
  }

  throw new Error(
    `Unknown key: ${name}. Use a single character, a named key (${Object.keys(NAMED_KEYS).join(', ')}), or F1-F12.`
  );
}
