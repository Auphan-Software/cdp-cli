# cdp-cli Improvement Plan: SPA Automation Support

## Problem Statement

When testing Single Page Applications (SPAs) like mako2 POS, raw cdp-cli commands struggle with:

1. **Git Bash interop** - stdout is swallowed when calling cdp-cli from Git Bash (not a cdp-cli bug)
2. **SPA navigation** - Hash-based routing breaks with standard `navigate`
3. **Async eval pain** - Must wrap async code in IIFE manually
4. **Quote escaping** - PowerShell/Bash escaping makes complex JS unreadable
5. **No wait-for-element** - Must use manual `sleep` between actions

The mako2 POS has a built-in `navAuto` API that handles these issues, but integrating it with cdp-cli is clunky.

**Note:** cdp-cli error handling is actually excellent when run via PowerShell:
```
$ cdp-cli navigate 'http://example.com' 'INVALID_PAGE_ID'
NAVIGATE_FAILED: Page not found: "INVALID_PAGE_ID"

Available pages:
  - "Page Title" (ACTUAL_PAGE_ID)
$ echo $?
1
```

## Proposed Changes

### 1. `--eval-file` Flag for `eval` Command

Load JavaScript from file instead of inline argument.

```bash
# Current (escaping nightmare)
cdp-cli eval "(async () => { return await top.navAuto.enterArea('99', 'FOH'); })()" "PAGEID"

# Proposed
cdp-cli eval --file cmd.js "PAGEID"
cdp-cli eval -f cmd.js "PAGEID"
```

**Implementation:**
```typescript
// In eval command handler
if (options.file) {
  const code = fs.readFileSync(options.file, 'utf-8');
  return evaluateCode(code, pageId);
}
```

### 2. `--async` Flag for `eval` Command

Auto-wrap code in async IIFE for cleaner async/await usage.

```bash
# Current
cdp-cli eval "(async () => { return await someAsyncFn(); })()" "PAGEID"

# Proposed
cdp-cli eval --async "await someAsyncFn()" "PAGEID"
cdp-cli eval -a "await someAsyncFn()" "PAGEID"
```

**Design Decision: Auto-return last expression**

Matches DevTools console and Node REPL behavior - developers expect `eval("2+2")` to return `4`.

```bash
# Single expression - auto-returned
cdp-cli eval --async "await navAuto.enterArea('99', 'FOH')" "PAGEID"

# Multi-statement - last expression returned
cdp-cli eval --async "const btns = await navAuto.listButtons(); btns.length" "PAGEID"
# Returns: 10

# Explicit return still works
cdp-cli eval --async "const btns = await navAuto.listButtons(); return btns[0]" "PAGEID"
```

**Implementation:**
```typescript
if (options.async) {
  // Wrap in async IIFE with auto-return of last expression
  // Uses indirect eval to get expression result
  code = `(async () => { return eval(${JSON.stringify(code)}); })()`;
}
```

Note: Using `eval()` inside the IIFE naturally returns the last expression's value, matching console behavior.

### 3. `--wait-for` Flag for `navigate` Command

Block until element appears (essential for SPAs).

```bash
# Current (fragile)
cdp-cli navigate "http://app.com/#/dashboard" "PAGEID"
sleep 3  # Hope it's loaded

# Proposed
cdp-cli navigate "http://app.com/#/dashboard" "PAGEID" --wait-for ".dashboard-loaded"
cdp-cli navigate "http://app.com/#/dashboard" "PAGEID" --wait-for-text "Welcome"
```

**Implementation:**
```typescript
if (options.waitFor) {
  await page.waitForSelector(options.waitFor, { timeout: options.timeout || 10000 });
}
if (options.waitForText) {
  await page.waitForFunction(
    (text) => document.body.innerText.includes(text),
    { timeout: options.timeout || 10000 },
    options.waitForText
  );
}
```

### 4. `--wait-for-idle` Flag for `navigate` Command

Wait for network idle + DOM stable.

```bash
cdp-cli navigate "http://app.com/" "PAGEID" --wait-for-idle
```

**Implementation:**
```typescript
if (options.waitForIdle) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.waitForFunction(() => document.readyState === 'complete')
  ]);
}
```

### 5. `status` Command

Health check for daemon, Chrome, and page connections.

```bash
$ cdp-cli status
{
  "daemon": { "running": true, "pid": 12345, "uptime": "2h 15m" },
  "chrome": { "connected": true, "port": 9222, "version": "120.0.6099.109" },
  "pages": 3,
  "logsBuffered": { "console": 142, "network": 89 }
}
```

### 6. `--timeout` Global Flag

Explicit timeout for all blocking operations.

```bash
cdp-cli navigate "http://slow-site.com" "PAGEID" --timeout 30000
cdp-cli eval --async "await longRunningFn()" "PAGEID" --timeout 60000
```

## Priority Order

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| P0 | `--eval-file` flag | Low | High |
| P1 | `--async` flag | Low | Medium |
| P1 | `status` command | Medium | High |
| P2 | `--wait-for` flag | Medium | High |
| P2 | `--wait-for-idle` flag | Medium | Medium |
| P3 | `--timeout` global flag | Low | Medium |

## Testing Plan

1. Unit tests for each new flag
2. Integration test with mako2 SPA:
   - Navigate to hash route
   - Wait for element
   - Eval async code from file
   - Test navAuto integration via `--async` flag

## Compatibility

- All changes are additive (new flags/commands)
- No breaking changes to existing API
- Minimum Node.js version unchanged
