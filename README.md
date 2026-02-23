# Chrome DevTools CLI

Command-line interface for Chrome DevTools Protocol (CDP), optimized for LLM agents with NDJSON output format.

## Overview

`cdp-cli` provides CLI access to all Chrome DevTools Protocol features, making it easy to automate browser interactions, debug web applications, and inspect network traffic - all from the command line with grep/tail-friendly output.

> **Distribution note**
> This scoped build (`@auphansoftware/cdp-cli`) is published for Auphan Software internal use, remains under the MIT license, and bundles the upstream work originally authored by [@myers](https://github.com/myers) at [github.com/myers/cdp-cli](https://github.com/myers/cdp-cli).

## Installation

```bash
# Local installation
cd chrome-devtools-cli
npm install
npm run build

# Global installation
npm install -g @auphansoftware/cdp-cli

# Verify the CLI is available, regardless of platform shims (.cmd/.ps1)
cdp-cli --help
```

## Prerequisites

- Node.js 18 or newer
  - The CLI bundles a `fetch` polyfill for older 18.x builds.
- Google Chrome started with remote debugging enabled:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
chrome.exe --remote-debugging-port=9222
```

## Quick Start

```bash
# Start the daemon (enables automatic logging for all new pages)
cdp-cli daemon start

# Create a new page (auto-registers with daemon for logging)
cdp-cli new-page "https://example.com"

# Take a screenshot at 50% scale (token friendly)
cdp-cli screenshot "example" --output screenshot.png --scale 0.5

# Query the last 20 console messages
cdp-cli logs console "example" --last 20

# Query network requests
cdp-cli logs network "example" --last 10

# Evaluate JavaScript
cdp-cli eval "document.title" "example"
```

## Output Format: NDJSON

All list commands output **newline-delimited JSON (NDJSON)** - one complete JSON object per line. This format is:
- **LLM-friendly**: Easy to parse programmatically
- **Grep-compatible**: Filter with standard Unix tools
- **Streamable**: Handle large datasets incrementally

### Example NDJSON Output

```bash
$ cdp-cli list-pages
{"id":"A1B2C3","title":"GitHub","url":"https://github.com","type":"page"}
{"id":"D4E5F6","title":"Google","url":"https://google.com","type":"page"}

$ cdp-cli logs console "example" --last 2
{"id":41,"type":"log","timestamp":1698234567890,"text":"Page loaded","source":"console-api"}
{"id":42,"type":"error","timestamp":1698234568123,"text":"TypeError: Cannot read...","source":"exception"}

$ cdp-cli logs network "example" --filter xhr
{"id":"123.1","method":"POST","url":"https://api.example.com/data","type":"XHR","timestamp":65897097}
```

## Commands

### Page Management

**list-pages** - List all open browser pages
```bash
cdp-cli list-pages
```

**new-page** - Create a new page/tab
```bash
cdp-cli new-page "https://example.com"
cdp-cli new-page  # Empty page
```

**navigate** - Navigate page (URL, back, forward, reload)
```bash
cdp-cli navigate "https://github.com" "example"
cdp-cli navigate back "example"
cdp-cli navigate forward "example"
cdp-cli navigate reload "example"

# Wait for content after navigation
cdp-cli navigate "https://example.com" "example" --wait-for "#content"
cdp-cli navigate "https://example.com" "example" --wait-for-text "Welcome"
cdp-cli navigate "https://example.com" "example" --wait-for-idle

# Wait for content inside an iframe
cdp-cli navigate "https://example.com" "example" --wait-for "#form" --wait-for-frame "#myframe"
```

Options:
- `--wait-for <selector>`: Wait for CSS selector to appear after navigation
- `--wait-for-text <text>`: Wait for text to appear in page body
- `--wait-for-idle`: Wait for network idle and document ready
- `--wait-for-frame <spec>`: Target iframe for wait checks (by selector or index)
- `--timeout <ms>`: Timeout for wait operations (default: 10000)

**close-page** - Close a page
```bash
cdp-cli close-page "example"
cdp-cli close-page A1B2C3
```

**resize-window** - Resize the Chrome window for a page
```bash
cdp-cli resize-window "example" 1024 768
cdp-cli resize-window "example" 0 0 --state maximized
cdp-cli resize-window "example" 0 0 --state fullscreen
```

Optional flags:
- `--state`: Window state: `normal`, `maximized`, `minimized`, `fullscreen`

### Daemon (Recommended for LLM Agents)

The daemon runs in the background and automatically captures console and network logs for all pages. Logs are stored in a circular buffer (last 500 entries per page) and can be queried at any time.

**daemon start** - Start the background daemon
```bash
cdp-cli daemon start                    # Start with defaults
cdp-cli daemon start --buffer-size 1000 # Custom buffer size
```

**daemon stop** - Stop the daemon
```bash
cdp-cli daemon stop
```

**daemon status** - Check daemon status and list active sessions
```bash
cdp-cli daemon status
```

Features:
- **Auto-discovery**: Automatically detects and registers ALL pages (including popups from `window.open`)
- **Persistent**: Logs survive across CLI invocations (until daemon stops)
- **Chrome restart handling**: Automatically reconnects and re-registers pages
- **Idempotent**: Safe to call `daemon start` multiple times

**status** - Check daemon and Chrome connection status
```bash
cdp-cli status
```

Output shows daemon state (running/stopped, session count) and Chrome state (running/stopped, version, page count).

**ready** - Launch Chrome + start daemon + return pages (all-in-one)
```bash
cdp-cli ready                                    # Uses defaults
cdp-cli ready --port 9333                        # Custom CDP port
cdp-cli ready --profile ~/my-chrome-profile     # Custom profile dir
```

This command:
1. Launches Chrome with remote debugging if not already running
2. Starts the daemon if not already running
3. Returns list of open pages

### Log Queries

Query console and network logs from the daemon's buffer. Requires daemon to be running.

**logs console** - Get console messages
```bash
cdp-cli logs console "example"              # Last 20 messages (default)
cdp-cli logs console "example" --last 50    # Last 50 messages
cdp-cli logs console "example" --last 0     # All buffered messages
cdp-cli logs console "example" --filter error  # Only errors
```

**logs network** - Get network requests
```bash
cdp-cli logs network "example"              # Last 20 requests (default)
cdp-cli logs network "example" --last 50    # Last 50 requests
cdp-cli logs network "example" --last 0     # All buffered requests
cdp-cli logs network "example" --filter xhr # Only XHR requests
```

**logs clear** - Clear logs for a page
```bash
cdp-cli logs clear "example"
```

**logs-detail** - Get full console message with stack trace
```bash
cdp-cli logs-detail 5 "example"    # Get message ID 5 with stack trace
```

### Debugging

**list-console** - Stream console messages (real-time)
> For querying buffered logs, use `logs console` with the daemon instead.
```bash
# Stream messages continuously until interrupted
cdp-cli list-console "example"

# Collect for duration 2 seconds and quit
cdp-cli list-console "example" --duration 2

# Filter by type
cdp-cli list-console "example" --type error
```

**snapshot** - Get page content snapshot
```bash
# Actionable elements for click/fill (default)
cdp-cli snapshot "example"

# Plain text content
cdp-cli snapshot "example" --format text

# Target an iframe
cdp-cli snapshot "example" --frame "#myframe"
cdp-cli snapshot "example" --frame 1  # First iframe by index
```

Options:
- `--format <ax|text>`: Output format (default: ax)
- `--frame <spec>`: Target iframe by selector or index

The default `ax` format returns one line per actionable element:
```
[button] "Submit" → #form > button
[select] value="1" options=["Yes","No"] → select[name="confirm"]
[input:text] name=email placeholder="Enter email" → #email
[link] "Sign up" → #nav > a:nth-of-type(2)
```

Each line shows: `[role] "label" state → selector`

**eval** - Evaluate JavaScript expression
```bash
cdp-cli eval "document.title" "example"
cdp-cli eval "window.location.href" "example"
cdp-cli eval "Array.from(document.querySelectorAll('h1')).map(h => h.textContent)" "example"

# Async evaluation (wraps in async IIFE)
cdp-cli eval --async "await fetch('/api').then(r => r.json())" "example"

# File-based evaluation (avoids shell escaping issues)
cdp-cli eval _ "example" --file script.js
cdp-cli eval _ "example" --file script.js --async  # Combined

# Evaluate inside an iframe
cdp-cli eval "document.querySelector('select')?.id" "example" --frame "#myframe"
```

Optional flags:
- `--async, -a`: Wrap code in async IIFE for await support
- `--file, -f`: Read JavaScript from file (expression argument ignored)
- `--stdin`: Read JavaScript from stdin instead of expression argument
- `--frame`: Target iframe by selector or index

**screenshot** - Take a screenshot
```bash
# Save to file
cdp-cli screenshot "example" --output screenshot.jpg

# Different formats
cdp-cli screenshot "example" --output screenshot.png --format png

# Downscale before saving (50% size)
cdp-cli screenshot "example" --output screenshot.png --scale 0.5

# Output base64 (NDJSON)
cdp-cli screenshot "example"
```

Optional flags:
- `--output, -o`: Save to file instead of emitting base64
- `--format, -f`: Choose `jpeg`, `png`, or `webp`
- `--quality, -q`: JPEG quality (0-100)
- `--scale, -s`: Downscale width and height by the factor (`0 < scale <= 1`)

**dialog** - Check for and handle JavaScript dialogs (alert/confirm/prompt)
```bash
# Check if a dialog is blocking the page
cdp-cli dialog "example"

# Dismiss (cancel) the dialog
cdp-cli dialog "example" --dismiss

# Accept (OK) the dialog
cdp-cli dialog "example" --accept

# Accept a prompt dialog with text
cdp-cli dialog "example" --accept --prompt-text "my answer"
```

When a dialog is blocking, commands like `screenshot`, `eval`, `click`, etc. will fail with an error message indicating a dialog is present and how to dismiss it.

### Network Inspection

**list-network** - Stream network requests (real-time)
> For querying buffered logs, use `logs network` with the daemon instead.
```bash
# Stream requests continuously until interrupted
cdp-cli list-network "example"

# Collect for duration (5 seconds and quit)
cdp-cli list-network "example" --duration 5

# Filter by type
cdp-cli list-network "example" --type fetch
cdp-cli list-network "example" --type xhr
```

### Input Automation

**click** - Click an element by CSS selector or visible text
Supports `--text`, `--match exact|contains|regex`, `--case-sensitive`, `--nth` for multi-match disambiguation, `--within` to scope the search to a container, and `--frame` to target elements inside iframes. Use `--longpress <seconds>` to hold the primary button before release (defaults to 1 second when the flag is provided without a value; not compatible with `--double`). Use `--touch` for touch events instead of mouse events (not compatible with `--double`). When multiple elements match, the CLI reports each candidate (including bounding boxes) so an LLM can choose the right target with `--nth`. Supports `--wait-for`, `--wait-for-text`, `--wait-for-idle`, and `--wait-for-frame` to wait for DOM changes after clicking.
```bash
# CSS selector (default behaviour)
cdp-cli click "button#submit" "example"
cdp-cli click "a.link" "example" --double
cdp-cli click "li.menu-item" "example" --longpress 0.75
cdp-cli click "li.menu-item" "example" --longpress        # defaults to 1 second

# Touch events (for mobile testing)
cdp-cli click "button#submit" "example" --touch
cdp-cli click "button#submit" "example" --touch --longpress 0.5

# Visible text (exact match, case-insensitive by default)
cdp-cli click --text "Submit" "example"          # single match
cdp-cli click --text "Submit" --nth 2 "example"  # choose the 2nd match

# Alternative text matching strategies
cdp-cli click --text "enter" --match contains "example"
cdp-cli click --text "^\d+$" --match regex --case-sensitive "example"

# Scoped search within a container
cdp-cli click --text "Pickles" --within "#modifier-pad" "example"
cdp-cli click "button.add" --within ".cart-section" "example"

# Click inside an iframe (coordinates auto-translated)
cdp-cli click "#submit-btn" "example" --frame "#myframe"
cdp-cli click --text "Save" "example" --frame "#myframe"

# Wait for DOM changes after click
cdp-cli click --text "Submit" "example" --wait-for "#success-message"
cdp-cli click --text "Submit" "example" --wait-for-text "Order confirmed"
cdp-cli click "#load-more" "example" --wait-for-idle
cdp-cli click "#tab2" "example" --wait-for ".tab-content" --wait-for-frame "#myframe"
```

Wait options (shared with navigate):
- `--wait-for <selector>`: Wait for CSS selector to appear after action
- `--wait-for-text <text>`: Wait for text to appear in page body
- `--wait-for-idle`: Wait for network idle and document ready
- `--wait-for-frame <spec>`: Target iframe for wait checks (by selector or index)
- `--timeout <ms>`: Timeout for wait operations (default: 10000)

**drag** - Drag from one element/position to another
Supports both mouse and touch drag operations. Use `--longpress` before drag for mobile-style drag-and-drop. Targets can be CSS selectors, text matches, or `x,y` coordinates. Use `--frame` to drag within an iframe.
```bash
# Mouse drag (default)
cdp-cli drag "#item" "#dropzone" "example"
cdp-cli drag ".draggable" ".target" "example" --steps 20 --duration 500

# Touch drag
cdp-cli drag "#item" "#dropzone" "example" --touch

# Touch drag with longpress (mobile drag-and-drop pattern)
cdp-cli drag "#item" "#dropzone" "example" --touch --longpress 0.5

# Coordinate-based drag
cdp-cli drag "100,200" "300,400" "example"
cdp-cli drag "#slider-handle" "250,100" "example"

# Text-based targeting
cdp-cli drag --text "Item 1" "#dropzone" "example"
cdp-cli drag "#source" --to-text "Drop Here" "example"

# Drag within an iframe (applies to both source and destination)
cdp-cli drag "#sortable-item" "#new-position" "example" --frame "#myframe"
```

Options:
- `--touch`: Use touch events instead of mouse
- `--longpress <seconds>`: Hold at start position before dragging
- `--steps <n>`: Number of intermediate move events (default: 10)
- `--duration <ms>`: Total drag duration in milliseconds (default: 300)
- `--text` / `--to-text`: Match source/destination by visible text
- `--nth` / `--to-nth`: Select Nth match for source/destination
- `--within` / `--to-within`: Scope source/destination search to container
- `--frame`: Target iframe (applies to both source and destination)

**fill** - Fill an input element
Supports `--nth` for multi-match disambiguation, `--within` to scope the search to a container, and `--frame` to target inputs inside iframes. Supports `--wait-for`, `--wait-for-text`, `--wait-for-idle`, and `--wait-for-frame` to wait for DOM changes after filling.
```bash
cdp-cli fill "input#email" "user@example.com" "example"
cdp-cli fill "input[name='password']" "secret123" "example"

# Scoped search within a container
cdp-cli fill "input[type='text']" "value" "example" --within "#login-form"

# Fill input inside an iframe
cdp-cli fill "#username" "testuser" "example" --frame "#myframe"

# Wait for DOM changes after fill (e.g. filtered search results)
cdp-cli fill "#searchBox" "cash discounting" "example" --wait-for-text "Brandy"
cdp-cli fill "#filter" "active" "example" --wait-for ".results-loaded"
```

Wait options (shared with navigate):
- `--wait-for <selector>`: Wait for CSS selector to appear after action
- `--wait-for-text <text>`: Wait for text to appear in page body
- `--wait-for-idle`: Wait for network idle and document ready
- `--wait-for-frame <spec>`: Target iframe for wait checks (by selector or index)
- `--timeout <ms>`: Timeout for wait operations (default: 10000)

**dismiss-overlays** - Auto-dismiss toasts, notifications, and modal overlays
```bash
cdp-cli dismiss-overlays "example"
cdp-cli dismiss-overlays "example" --frame "#myframe"
```

Clicks common dismiss buttons (`.toast-close`, `.notify-hide`, `.notification-dismiss`, etc.) to clear the viewport for screenshots.

Optional flags:
- `--frame`: Target iframe by selector or index

**press-key** - Press a keyboard key
```bash
cdp-cli press-key enter "example"
cdp-cli press-key tab "example"
cdp-cli press-key escape "example"
```

## LLM Usage Patterns

### Pattern 1: Inspect and Interact

```bash
# 1. List pages to find target
cdp-cli list-pages | grep "example"

# 2. Always resize window when debugging to save tokens when screenshotting.
cdp-cli resize-window "example" 1024 728

# 3. Get actionable elements snapshot
cdp-cli snapshot "example"
# Output: [button] "Submit" → #form > button
# Use selector directly or text matching

# 4. Interact with elements
cdp-cli fill "input#search" "query" "example"
cdp-cli click --text "Submit" "example"

# 5. Capture result in lower resolution to save tokens
cdp-cli screenshot "example" --output result.png --scale 0.5
```

### Pattern 2: Debug Web Application

```bash
# 1. Start daemon (once per session)
cdp-cli daemon start

# 2. Create page (auto-registers with daemon for logging)
cdp-cli new-page "https://localhost:3000/"

# 3. Interact with the page...
cdp-cli click "button#submit" "localhost"

# 4. Query console for errors
cdp-cli logs console "localhost" --last 50 --filter error

# 5. Query network requests
cdp-cli logs network "localhost" --last 20

# 6. Close page when done (auto-cleans up daemon session)
cdp-cli close-page "localhost"
```

### Pattern 3: Automated Testing

```bash
# Chain commands with && (stops on first failure)
cdp-cli click --text "9" "PAGEID" && \
cdp-cli click --text "9" "PAGEID" && \
cdp-cli click --text "Management" "PAGEID" && \
sleep 2 && \
cdp-cli screenshot "PAGEID" --output result.png --scale 0.5

# Fill form and submit
cdp-cli fill "input#username" "testuser" "PAGEID" && \
cdp-cli fill "input#password" "testpass" "PAGEID" && \
cdp-cli click "button#login" "PAGEID" && \
sleep 2 && \
cdp-cli screenshot "PAGEID" --output login-result.png --scale 0.5
```

### Pattern 4: Data Extraction

```bash
# 1. Navigate to page
cdp-cli navigate "https://example.com/data" "example"

# 2. Extract data via JavaScript
cdp-cli eval "Array.from(document.querySelectorAll('.item')).map(el => ({
  title: el.querySelector('.title').textContent,
  price: el.querySelector('.price').textContent
}))" "example"
```

## Global Options

- `--cdp-url <url>` - Chrome DevTools Protocol URL (default: `http://localhost:9222`)
- `--help` - Show help
- `--version` - Show version

## Tips for LLM Agents

1. **Start the daemon first**: Always run `cdp-cli daemon start` at the beginning of your session. This enables automatic log capture for all pages.
   ```bash
   cdp-cli daemon start
   ```

2. **Use NDJSON parsing**: Each line is a complete JSON object
   ```javascript
   const lines = output.split('\n').filter(l => l.trim());
   const objects = lines.map(l => JSON.parse(l));
   ```

3. **Query logs instead of streaming**: Use `logs console` and `logs network` to query buffered logs instead of running background streaming processes.
   ```bash
   cdp-cli logs console "example" --last 20
   cdp-cli logs network "example" --filter xhr
   ```

4. **Use scaled screenshots to reduced token consumption**:
   ```bash
   cdp-cli screenshot "test" --output test-result.png --scale 0.5
   ```

5. **Use --text and --nth flag to target elements**:
   ```bash
   cdp-cli click --text "OK" --nth 1 "test"
   ```

6. **Use snapshot for element discovery**:
   ```bash
   cdp-cli snapshot "example"
   # Output: [button] "Login" → #header > button:nth-of-type(2)
   # Use the selector directly: cdp-cli click "#header > button:nth-of-type(2)" "example"
   # Or use text matching: cdp-cli click --text "Login" "example"
   ```

7. **Error handling**: All errors output NDJSON with `"error": true`
   ```json
   {"error":true,"message":"Page not found: example","code":"PAGE_NOT_FOUND"}
   ```

8. **Target elements inside iframes with --frame**:
   ```bash
   # Most commands support --frame to target iframe content
   cdp-cli snapshot "example" --frame "#myframe"
   cdp-cli eval "document.title" "example" --frame "#myframe"
   cdp-cli click "#submit" "example" --frame "#myframe"
   cdp-cli fill "#input" "value" "example" --frame "#myframe"
   cdp-cli drag "#a" "#b" "example" --frame "#myframe"

   # Wait for content inside iframe after navigation
   cdp-cli navigate "https://example.com" "test" --wait-for "#content" --wait-for-frame "#myframe"
   ```

## Architecture

Built with:
- **TypeScript** - Type-safe code
- **yargs** - CLI argument parsing
- **ws** - WebSocket for CDP communication
- **NDJSON** - LLM-friendly output format

Reuses battle-tested CDP logic from [chrome-devtools-mcp](../chrome-devtools-mcp).

## Testing

This project includes a comprehensive test suite using Vitest.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests with interactive UI
npm run test:ui
```

### Test Structure

```
tests/
├── fixtures/          # Sample CDP responses and test data
│   └── cdp-responses.ts
├── mocks/             # Mock implementations
│   ├── websocket.mock.ts   # WebSocket mock for CDP
│   └── fetch.mock.ts       # Fetch mock for REST API
├── helpers.ts         # Test utilities
├── setup.ts           # Test environment setup
└── unit/              # Unit tests
    ├── output.test.ts       # Output formatting tests
    ├── context.test.ts      # CDPContext tests
    └── commands/            # Command tests
        ├── pages.test.ts
        ├── debug.test.ts
        ├── network.test.ts
        └── input.test.ts
```

### Test Coverage

Current coverage:
- **Output formatting**: 100% (10 tests)
- **CDPContext**: ~95% (23 tests)
- **Pages commands**: ~90% (11 tests)
- **Overall**: 80%+ lines, functions, and statements

### Writing New Tests

Tests use mocked WebSocket and fetch, so **no running Chrome instance is required**:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { CDPContext } from '../src/context.js';
import { installMockFetch } from './mocks/fetch.mock.js';

describe('My Test', () => {
  beforeEach(() => {
    installMockFetch(); // Mock CDP REST API
  });

  it('should test something', async () => {
    const context = new CDPContext();
    const pages = await context.getPages();
    expect(pages).toHaveLength(3);
  });
});
```

### Continuous Integration

Tests run automatically on every commit and pull request (if CI is configured).

## License

MIT

## Related Projects

- [chrome-devtools-mcp](../chrome-devtools-mcp) - MCP server for Chrome DevTools
- [quest-devtools.mjs](../quest-devtools.mjs) - Simple CDP CLI prototype

---

**Built for LLM agents** - Every command outputs structured, parseable, grep-friendly data.
