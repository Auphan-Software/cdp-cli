/**
 * Parameter validation helpers for detecting common mistakes
 */

// Page ID pattern: typically a hex string like "7C23D8F0E1B94F52A3D2E6C9"
const PAGE_ID_PATTERN = /^[0-9A-F]{20,}$/i;

// URL patterns
const URL_PATTERN = /^(https?:\/\/|www\.|localhost|[a-z0-9-]+\.(com|org|net|io|dev|co|app))/i;

// Navigation action keywords
const NAV_ACTIONS = ['back', 'forward', 'reload'];

// Log types
const LOG_TYPES = ['console', 'network', 'clear'];

// Daemon actions
const DAEMON_ACTIONS = ['start', 'stop', 'status'];

/**
 * Check if value looks like a page ID
 */
export function looksLikePageId(value: string): boolean {
  return PAGE_ID_PATTERN.test(value);
}

/**
 * Check if value looks like a URL
 */
export function looksLikeUrl(value: string): boolean {
  return URL_PATTERN.test(value);
}

/**
 * Check if value is a navigation action
 */
export function isNavAction(value: string): boolean {
  return NAV_ACTIONS.includes(value.toLowerCase());
}

/**
 * Check if value is a log type
 */
export function isLogType(value: string): boolean {
  return LOG_TYPES.includes(value.toLowerCase());
}

/**
 * Check if value is a daemon action
 */
export function isDaemonAction(value: string): boolean {
  return DAEMON_ACTIONS.includes(value.toLowerCase());
}

export interface ValidationHint {
  likely: boolean;
  hint?: string;
  suggestion?: string;
}

/**
 * Detect if params might be swapped for navigate command
 * navigate <action> <page> - user might put page first
 */
export function validateNavigateParams(action: string, page: string): ValidationHint {
  // If "action" looks like a page ID and "page" looks like a URL/action
  if (looksLikePageId(action) && (looksLikeUrl(page) || isNavAction(page))) {
    return {
      likely: true,
      hint: `Parameters appear to be swapped. Expected: navigate <url|action> <page>`,
      suggestion: `cdp-cli navigate ${page} ${action}`
    };
  }
  return { likely: false };
}

/**
 * Detect if params might be swapped for eval command
 * eval <expression> <page> - user might put page first
 */
export function validateEvalParams(expression: string, page: string): ValidationHint {
  // If "expression" looks like a page ID
  if (looksLikePageId(expression) && !looksLikePageId(page)) {
    return {
      likely: true,
      hint: `Parameters appear to be swapped. Expected: eval <expression> <page>`,
      suggestion: `cdp-cli eval "${page}" ${expression}`
    };
  }
  return { likely: false };
}

/**
 * Detect if params might be swapped for logs command
 * logs <type> <page> - user might put page first
 */
export function validateLogsParams(type: string, page: string): ValidationHint {
  // If "type" looks like a page ID and "page" looks like a log type
  if (looksLikePageId(type) && isLogType(page)) {
    return {
      likely: true,
      hint: `Parameters appear to be swapped. Expected: logs <type> <page>`,
      suggestion: `cdp-cli logs ${page} ${type}`
    };
  }
  return { likely: false };
}

/**
 * Detect if params might be swapped for press-key command
 * press-key <key> <page> - user might put page first
 */
export function validatePressKeyParams(key: string, page: string): ValidationHint {
  // If "key" looks like a page ID
  if (looksLikePageId(key) && !looksLikePageId(page)) {
    return {
      likely: true,
      hint: `Parameters appear to be swapped. Expected: press-key <key> <page>`,
      suggestion: `cdp-cli press-key ${page} ${key}`
    };
  }
  return { likely: false };
}

/**
 * Detect if params might be swapped for fill command
 * fill <selector> <value> <page>
 */
export function validateFillParams(selector: string, value: string, page: string): ValidationHint {
  // If first param looks like a page ID
  if (looksLikePageId(selector)) {
    return {
      likely: true,
      hint: `First parameter looks like a page ID. Expected: fill <selector> <value> <page>`,
      suggestion: `cdp-cli fill <selector> <value> ${selector}`
    };
  }
  return { likely: false };
}

/**
 * Detect if params might be swapped for logs-detail command
 * logs-detail <messageId> <page>
 */
export function validateLogsDetailParams(messageId: string | number, page: string): ValidationHint {
  const msgIdStr = String(messageId);
  // If "messageId" looks like a page ID (hex string) instead of a number
  if (looksLikePageId(msgIdStr) && !isNaN(Number(page))) {
    return {
      likely: true,
      hint: `Parameters appear to be swapped. Expected: logs-detail <messageId> <page>`,
      suggestion: `cdp-cli logs-detail ${page} ${msgIdStr}`
    };
  }
  return { likely: false };
}

/**
 * Build an error message with optional hint
 */
export function buildErrorWithHint(baseMessage: string, hint?: ValidationHint): string {
  if (!hint?.likely || !hint.hint) {
    return baseMessage;
  }

  let message = `${baseMessage}\n\nHint: ${hint.hint}`;
  if (hint.suggestion) {
    message += `\nTry: ${hint.suggestion}`;
  }
  return message;
}

/**
 * Provide a helpful error message when page lookup fails
 */
export function getPageNotFoundHint(searchValue: string): string | undefined {
  if (looksLikeUrl(searchValue)) {
    return `"${searchValue}" looks like a URL, not a page ID. Did you swap the parameter order?`;
  }
  if (isNavAction(searchValue)) {
    return `"${searchValue}" is a navigation action, not a page ID. Did you swap the parameter order?`;
  }
  if (isLogType(searchValue)) {
    return `"${searchValue}" is a log type, not a page ID. Did you swap the parameter order?`;
  }
  return undefined;
}
