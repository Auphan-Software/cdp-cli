# Chrome DevTools CLI

Command-line interface for Chrome DevTools Protocol (CDP), optimized for LLM agents with NDJSON output format.

## Overview

`cdp-cli` provides CLI access to all Chrome DevTools Protocol features, making it easy to automate browser interactions, debug web applications, and inspect network traffic - all from the command line with grep/tail-friendly output.

> **Distribution note**
> This scoped build (`@auphansoftware/cdp-cli`) is published for Auphan Software internal use, remains under the MIT license, and bundles the upstream work originally authored by [@myers](https://github.com/myers) at [github.com/myers/cdp-cli](https://github.com/myers/cdp-cli).

> **Upgrading to 1.12.0**
> Actions can now wait on a JavaScript predicate or a specific response, and
> `click`/`fill` verify their postconditions instead of treating a dispatched
> CDP event as a completed interaction. Start the daemon before using buffered
> network history or `diagnose`; use `network-detail` only with permission to
> inspect the selected response body.
>
> **The 1.8.0 breaking change remains in effect:**
> `--wait-for` and `--wait-for-text` now default to the document named by
> `--frame`, instead of always checking the top document. This affects any
> script that passes `--frame` together with either flag. Pass
> `--wait-for-frame 0` to restore the old behaviour. See [CHANGELOG.md](CHANGELOG.md).
>
> On Windows, also run `npm run install:exe` after upgrading — a stale
> `cdp-cli.exe` on PATH shadows the npm build for cmd.exe, PHP `exec()`, batch
> and CI. See [Windows: which cdp-cli is actually running](#windows-which-cdp-cli-is-actually-running).

Maintainers: the Git release and the installer executable are separate release
steps. Follow [RELEASING.md](RELEASING.md) to publish and independently verify
the public S3 artifact.

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

# Ask only after the click's request really completes
cdp-cli click "#save" "example" --wait-for-response "/api/order" --wait-for-status 201

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

# Query strings and hash fragments are preserved in full — quote the URL so the
# shell does not split it on '&'.
cdp-cli new-page "http://127.0.0.1/app/?scenario=admin&cb=1#s:login.php?lang_id=1"
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

# Wait for the document to actually be replaced
cdp-cli navigate "https://example.com" "example" --wait-for-navigation
```

Options:
- `--wait-for <selector>`: Wait for CSS selector to appear after navigation
- `--wait-for-text <text>`: Wait for text to appear in page body
- `--wait-for-idle`: Wait for network idle and document ready
- `--wait-for-frame <spec>`: Target iframe for wait checks (by selector or index)
- `--wait-for-navigation`: Wait for a real document replacement (see below)
- `--timeout <ms>`: Timeout for wait operations (default: 10000)

<a name="wait-for-navigation"></a>
#### Waiting for a navigation

`--wait-for-navigation` is available on `navigate`, `click`, `fill`, `select` and
`press-key`. It resolves only when the watched frame **commits a new document and
that document finishes loading**, tracked by CDP `Page.frameNavigated` plus a
completion event, and keyed on the frame's `loaderId`. The watched frame is the
main frame unless `--frame`/`--wait-for-frame` names another — see
[Waiting on an iframe](#waiting-on-an-iframe) below.

Use it for classic post-and-refresh pages, where a form POST re-renders the whole
document. `--wait-for-text` is the wrong tool there: every label you might wait
for is already on the **outgoing** document, so the wait returns immediately and
the assertions that follow run against the old DOM — a silent false result.

```bash
# Correct: returns only after the POST response has loaded
cdp-cli click "#save" "example" --wait-for-navigation

# Combine them: navigation resolves first, so the text is matched on the NEW document
cdp-cli click "#save" "example" --wait-for-navigation --wait-for-text "Saved"
```

Notes:
- Same-document changes (hash routes, `history.pushState`) keep the `loaderId`
  and deliberately do **not** satisfy this wait. Use `--wait-for`/`--wait-for-text`
  for SPA route changes.
- On timeout the command fails with a non-zero exit and states whether the
  document never committed or committed but never finished loading.

<a name="waiting-on-an-iframe"></a>
##### Waiting on an iframe

A form POST inside an iframe replaces **that frame's** document; the main frame
never navigates. A main-frame wait would sit there until it timed out, so name
the frame to watch. The frame comes from `--frame` by default, and
`--wait-for-frame` overrides it:

```bash
# Submit inside an iframe — the wait follows --frame automatically
cdp-cli click "input[value='Add']" "example" --frame "#page-iframe" --wait-for-navigation

# Click in the TOP document, but the iframe is what navigates
# (common when a shell re-parents a page's buttons into its own nav bar)
cdp-cli click ".nav-save-btn" "example" --wait-for-navigation --wait-for-frame "#page-iframe"
```

Main-frame waits still ignore subframe loads entirely, so an unrelated iframe
(an ad, a printer-queue frame) can never satisfy one. Subframe completion is
detected with `Page.frameStoppedLoading` and `Page.lifecycleEvent`, because
`Page.loadEventFired` only ever fires for the main frame.

`--wait-for-frame` also scopes `--wait-for` and `--wait-for-text`, so those are
checked inside the same document you were driving.

> **Changed in 1.8.0:** `--wait-for` and `--wait-for-text` now default to the
> frame given by `--frame` instead of always checking the top document. If you
> were relying on checking the top document while acting inside a frame, pass
> `--wait-for-frame 0` to target the top frame explicitly.

#### Expression and response waits

All action commands that already support post-action waits (`navigate`,
`click`, `fill`, `select`, and `press-key`) also support these precise
conditions:

```bash
# Poll inside the selected wait frame until the expression is truthy.
cdp-cli click "#save" PAGE --wait-for-expression "window.orderSaved === true"

# Source an expression without fragile shell quoting.
cdp-cli click "#save" PAGE --wait-for-expression-file .\waits\order-saved.js
Get-Content .\waits\order-saved.js | cdp-cli click "#save" PAGE --wait-for-expression-stdin

# Observe the request before the click, then resolve only on the matching response.
cdp-cli click "#save" PAGE --wait-for-response "/api/orders" --wait-for-status 201
cdp-cli click "#save" PAGE --wait-for-response "/api/orders" --wait-for-body-text '"saved":true'
```

`--wait-for-expression` accepts synchronous or async JavaScript. Use exactly
one of the inline, `--wait-for-expression-file`, or
`--wait-for-expression-stdin` forms. `--wait-for-response` matches a
literal URL substring, is armed before the triggering action, and can be
combined with exact `--wait-for-status` and literal `--wait-for-body-text`.
The body predicate reads at most 64 KiB and never prints response content.
`--wait-for-status` and `--wait-for-body-text` are invalid without
`--wait-for-response`.

`--wait-for-idle` is also armed before the action. It tracks real request IDs,
redirects, and failed loads, which avoids the old race where fast network work
finished before a post-action wait had attached.

Use the same predicates without triggering an action through `wait PAGE`:

```bash
cdp-cli wait PAGE --expression "window.checkoutReady === true" --wait-for-frame "#content"
cdp-cli wait PAGE --wait-for-response "/api/status" --wait-for-status 200
cdp-cli wait PAGE --wait-for ".complete" --timeout 30000
```

The standalone command uses `--expression` (or `--expression-file` /
`--expression-stdin`) and retains the existing `--wait-for*` spellings for
selector, text, idle, frame, and response checks. Expression timeouts include
the last bounded value or exception to make a failed predicate diagnosable.

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

**status** - Check the CLI build, daemon, and Chrome connection status
```bash
cdp-cli status
{"cli":{"version":"1.10.0","build":"2026-08-12T18:25:59Z","runtime":"exe"},"daemon":{"running":true,"sessions":3},"chrome":{"running":true,"version":"Chrome/150.0.7871.115","pages":3}}
```

- `cli` *(added in 1.10.0)*: which build answered — `version` is a bare semver
  safe to hand to any comparator, `build` is when it was produced, and `runtime`
  is `npm` (the shell/`.cmd` shim) or `exe` (the standalone binary). **A script
  that gates on a version should read `cli.version` here rather than parsing
  `--version`**, whose build suffix breaks PHP's `version_compare`. See
  [Windows: which cdp-cli is actually running](#windows-which-cdp-cli-is-actually-running).
- `daemon`: running/stopped and session count.
- `chrome`: running/stopped, version, page count.

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

### Page Health and Diagnostics

**page-health** - Inspect whether a page is visible, focused, sized, and able
to receive browser input, without changing which page is active:

```bash
cdp-cli page-health "example"
```

**activate-page** - Explicitly bring a page to the foreground when a workflow
really needs it. Normal inspection and actions do not activate pages as a side
effect:

```bash
cdp-cli activate-page "example"
```

**diagnose** - Collect a bounded, redacted failure bundle:

```bash
cdp-cli diagnose "example"
cdp-cli diagnose "example" --output-dir .\artifacts\checkout-failure
```

The emitted bundle contains redacted current/frame URLs, dialog and page-health
state, a compact DOM summary, and recent console/network failures when the
daemon is running. `--output-dir` creates the directory if needed and adds a
`manifest.json` plus `screenshot.png`. It refuses to overwrite either artifact
if it already exists. URL query values and dialog text are redacted; as with
any screenshot or DOM-derived diagnostic, inspect the bundle before sharing it.

### Named Workspace Sessions

Named sessions make ownership explicit when several agents share one Chrome.
Creating a session makes one initial page in an isolated `BrowserContext` by
default:

```bash
cdp-cli session create checkout --url https://example.test/checkout
cdp-cli session list

# Work only with that session's exact owned target IDs.
cdp-cli list-pages --session checkout
cdp-cli new-page https://example.test/receipt --session checkout

# Bring an existing page under a session only by its exact CDP target ID.
cdp-cli session adopt checkout EXACT_TARGET_ID

# This is destructive: it closes the isolated context and its pages.
cdp-cli session remove checkout --force

# Reset one named isolated session. This closes its old context and pages,
# then creates one fresh about:blank page without touching other sessions.
# A forced reset also supersedes a wedged operation lease owned by that same
# session; it never supersedes another session's lease.
cdp-cli session reset checkout --force
```

If Chrome accepts disposal but cannot create the fresh replacement target,
reset fails with `SESSION_RESET_INCOMPLETE`. The old context is already gone;
rerun `session create NAME` or `session ensure NAME` after correcting Chrome.

Within `--session NAME`, page and target references must be exact IDs owned by
that session; title/URL matching is deliberately disabled and cross-owner
access fails with a structured `PAGE_NOT_OWNED` error. Use `session create
NAME --shared` only for compatibility with Chrome's default shared context; it
is never disposed by a session. Session state persists IDs and session metadata
only—never page titles, URLs, logs, credentials, or storage—and fails closed if
it belongs to another browser instance. BrowserContext isolation prevents
accidental interference; it is not a security boundary.

Session-store writes fail closed. If a process crashes during the tiny lock
mutation critical section, the error reports an exact `*.lock.guard` path.
First confirm that no cdp-cli process is using that endpoint's session store,
then remove only that reported guard file and retry. `session reset NAME --force`
does not bypass or delete a guard, because doing so automatically could admit
two writers.

If the persisted session file belongs to a Chrome instance that no longer
exists, first stop the dedicated CDP Chrome and daemon, then use the explicit
metadata-only recovery command. It cannot dispose live contexts and therefore
requires both acknowledgements:

```bash
cdp-cli session metadata-reset --force --metadata-only
```

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

# Apply precise filters before taking the last N matching requests
cdp-cli logs network "example" --url /api/orders --method POST --status 500
cdp-cli logs network "example" --failed --since 1787059200000
```

Network records retain their response status, headers, redirects, terminal
completion, and `failure` details. For a full retained lifecycle, including
redacted request/response headers:

```bash
cdp-cli network-detail REQUEST_ID "example"

# Response bodies are opt-in and bounded; only use where the data is allowed.
cdp-cli network-detail REQUEST_ID "example" --body --max-body-bytes 32768
```

`--url` is a literal substring; `--method` is matched case-insensitively;
`--status`, `--failed`, and `--since` filter the recorded lifecycle. A response
body is never included unless `--body` is explicit, and sensitive standard
headers (for example `Authorization`, `Cookie`, and `X-Api-Key`) are redacted.

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

# Downscale before saving (50% size). Scaling re-encodes as PNG, so the
# format defaults to png and an explicit --format jpeg/webp is rejected.
cdp-cli screenshot "example" --output screenshot.png --scale 0.5

# Clip to one element (scrolled into view first, 10px padding)
cdp-cli screenshot "example" --selector "#invoice-total" --output el.png --format png

# Output base64 (NDJSON)
cdp-cli screenshot "example"
```

Optional flags:
- `--output, -o`: Save to file instead of emitting base64
- `--format, -f`: Choose `jpeg`, `png`, or `webp`
- `--quality, -q`: JPEG quality (0-100)
- `--scale, -s`: Downscale width and height by the factor (`0 < scale <= 1`)

Prefer `--output` in scripted and agent use: without it the image is emitted as
base64 on stdout, which for a full-page capture is hundreds of KB and will flood
a calling process or transcript. With `--output` the command prints only the
resolved absolute path, format, byte size, and pixel dimensions:

```json
{"success":true,"message":"Screenshot saved","data":{"file":"Q:\\web\\shots\\page.png","format":"png","size":47853,"width":2560,"height":1330}}
```

The format is inferred from the output file extension (`.png`, `.jpg`/`.jpeg`,
`.webp`) unless `--format` says otherwise. Paths are resolved natively, so on
Windows use a drive-qualified or project-relative path (`shots/page.png`,
`Q:/web/app/dev/tests/shots/page.png`) — there is no `/tmp` on Windows. The
parent directory must already exist.

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

### Working with iframes

`--frame` takes **either** a CSS selector matched against the top document, or a
1-based frame index:

```bash
cdp-cli click "#save" "example" --frame "#page-iframe"   # CSS selector (recommended)
cdp-cli click "#save" "example" --frame 1                # 1 = first iframe, 0 = top document
```

A selector is worth preferring: index order follows the frame tree, so an
unrelated iframe elsewhere on the page silently shifts what `1` means.

Supported on `click`, `fill`, `select`, `drag`, `eval`, `query`, `styles`,
`snapshot`, and `dismiss-overlays`. Click and drag coordinates are translated
into the frame's own coordinate space automatically.

If the frame cannot be resolved, the command **fails** rather than quietly
running against the top document — so a mistyped selector surfaces as an error
instead of a success against the wrong DOM. A frame that exists but has no
execution context yet reports that it may still be loading.

`press-key` needs no `--frame`: keystrokes go to whatever is focused, so focus
the field first (with `fill`, or `click`) and the keystroke lands in that frame.

**A click does not always get into the frame it points at.** The event is
delivered to the frame by the browser process, and it can miss: a frame that
has just mounted is not routable yet, and a page still settling moves what is
under the point. The click then lands in the surrounding document, and the
keystrokes that follow go wherever focus already was. `click` now fails with
`CLICK_FRAME_NOT_REACHED` instead of reporting success in that case, so for
hosted payment fields (Bambora, Stripe Elements and the like): click, confirm
it reported `frameReached: true`, and only then `press-key`.

Focusing the iframe *element* from the top document — `document.querySelector(sel
+ ' iframe').focus()` — is same-origin and does move focus into the frame, but
which control inside the frame ends up active is the frame's choice, so verify
against the field's own state (the wrapper class a hosted field sets, or the
value after typing) rather than assuming the caret is in the input.

### Out-of-process iframe targets

`--frame` remains the convenient route for normal page frames. Chrome can place
a cross-origin or isolated iframe in a separate target/session (an OOPIF),
however, and an ordinary page-session command cannot evaluate inside that
target. Use the exact-target commands when you need an explicit, auditable
operation against one of those frames:

```bash
# List page and OOPIF targets. Target IDs are opaque and must be copied exactly.
cdp-cli targets

# Resolve a particular iframe element from its parent target.
cdp-cli target-frame PARENT_TARGET_ID "iframe.payment"

# The result has target:null for a same-process iframe; otherwise use its targetId.
cdp-cli target-query "input[name=cardnumber]" IFRAME_TARGET_ID
cdp-cli target-fill "input[name=cardnumber]" "4111111111111111" IFRAME_TARGET_ID --expect-value
cdp-cli target-eval "document.readyState" IFRAME_TARGET_ID
cdp-cli target-press-key tab IFRAME_TARGET_ID --selector "input[name=cardnumber]"
```

`target` accepts only a literal target ID—never a title or URL—and
`target-frame` maps the selected iframe via Chrome's exact frame ID, not a
heuristic URL match. Target-local selectors must match exactly one element.
These primitives currently provide evaluation, inspection, fill/read-back, and
keyboard dispatch; they deliberately do not synthesize mouse-coordinate clicks
inside an OOPIF. Listed topology URLs omit credentials, query strings, and
fragments.

Input values are redacted from `target-query` and `target-fill` output by
default; lengths and verification state remain available. Use `--show-value`
only when returning the raw value is explicitly safe and necessary.

### Input Automation

**click** - Click an element by CSS selector or visible text
Supports `--text`, `--match exact|contains|regex`, `--case-sensitive`, `--nth` for multi-match disambiguation, `--within` to scope the search to a container, and `--frame` to target elements inside iframes. Use `--longpress <seconds>` to hold the primary button before release (defaults to 1 second when the flag is provided without a value; not compatible with `--double`). Use `--touch` for touch events instead of mouse events (not compatible with `--double`). When multiple elements match, the CLI reports each candidate (including bounding boxes) so an LLM can choose the right target with `--nth`. Supports `--wait-for`, `--wait-for-text`, `--wait-for-idle`, `--wait-for-frame`, and `--wait-for-navigation` to wait for DOM changes after clicking.

Clicking an `<option>` inside a `<select>` does **not** work and never can — Chrome draws that list as an OS popup outside the DOM, so the click reports success and the value is unchanged. Use the **select** command instead.

The target is scrolled into view before the click, and the click point is hit-tested first so a click that would be swallowed by an overlay fails loudly instead of reporting a false success:

- `CLICK_OCCLUDED` - another element covers the click point (`details.occludedBy` names it). Pass `--force` to dispatch anyway.
- `CLICK_OFFSCREEN` - the element could not be scrolled into the viewport.
- `CLICK_DETACHED` - the element left the document before the click.
- `CLICK_FRAME_NOT_REACHED` - the click point is inside a frame and the frame never took the click, so nothing happened. Pass `--force` to dispatch and report anyway.

Successful results include `scrolled` (whether the page had to scroll), `occludedBy` (non-null only with `--force`), and `frameReached` — `true`/`false` when the click point was a frame, `null` when it was not, with `hitFrame` naming the frame.

For ordinary (non-frame) clicks, the command also observes the target document
after dispatch. If Chrome accepted the event but no matching mousedown reached
that document, it fails with `CLICK_NOT_DELIVERED`; this is a real failure, not
a reason to blindly retry an action that may already have run elsewhere.

A click whose point lands on an `<iframe>` is handed to *that frame's* document by the browser process, and that routing is not live the moment the frame element appears. A click dispatched into the gap is delivered to the top frame and silently does nothing — which is what a card field reporting "empty" after a clean-looking click means. `click` confirms the frame took it (focus moves to the frame element, which the top document can see even cross-origin) before reporting success, so this fails loudly instead of passing. Give the frame a moment and click again, or `--force` if you only want the events sent.

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

# Click through an overlay that would otherwise intercept the event
cdp-cli click "#submit-btn" "example" --force

# Wait for DOM changes after click
cdp-cli click --text "Submit" "example" --wait-for "#success-message"
cdp-cli click --text "Submit" "example" --wait-for-text "Order confirmed"
cdp-cli click "#load-more" "example" --wait-for-idle
cdp-cli click "#tab2" "example" --wait-for ".tab-content" --wait-for-frame "#myframe"

# Form POST that re-renders the page: wait for the new document, not for text
cdp-cli click "#save" "example" --wait-for-navigation
```

Wait options (shared with navigate):
- `--wait-for <selector>`: Wait for CSS selector to appear after action
- `--wait-for-text <text>`: Wait for text to appear in page body
- `--wait-for-expression <js>`: Wait for a truthy JavaScript expression
- `--wait-for-expression-file <path>` / `--wait-for-expression-stdin`: Read that expression from a file or stdin
- `--wait-for-response <url-substring>`: Wait for an observed response armed before the action
- `--wait-for-status <code>` / `--wait-for-body-text <text>`: Further constrain `--wait-for-response`
- `--wait-for-idle`: Wait for network idle and document ready
- `--wait-for-frame <spec>`: Target iframe for wait checks (by selector or index)
- `--wait-for-navigation`: Wait for a real document replacement ([details](#wait-for-navigation))
- `--timeout <ms>`: Timeout for wait operations (default: 10000)

**drag** - Drag from one element/position to another
Supports both mouse and touch drag operations. Use `--longpress` before drag for mobile-style drag-and-drop. Targets can be CSS selectors, text matches, or `x,y` coordinates. Use `--frame` to drag within an iframe.

Element endpoints are scrolled into view before the drag. Because the events are dispatched at viewport coordinates, both endpoints must be on screen at the same time; if scrolling to one pushes the other out, the command fails with `DRAG_OFFSCREEN` instead of dragging between the wrong points. Coordinate endpoints (`x,y`) are used as given.

`--frame` is verified on `drag`: dragging between two elements inside an iframe
releases inside the destination's own rect, which is what a correct coordinate
translation produces and a wrong frame offset does not.
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
Supports `--nth` for multi-match disambiguation, `--within` to scope the search to a container, `--frame` to target inputs inside iframes, and `--expect-value` when exact read-back is required. Supports `--wait-for`, `--wait-for-text`, `--wait-for-idle`, `--wait-for-frame`, and `--wait-for-navigation` to wait for DOM changes after filling.

Replaces the field's current value (the previous contents come back as `replaced` in the result), types the new value as real key events, then emits `change`.

Because the `change` is emitted explicitly, a page that *also* produces one natively — a widget whose `onkeyup` moves focus to the next field, for instance — can see its `change` handler run twice for one `fill`. That is harmless for the usual idempotent "sync a hidden field" handler, but worth knowing if yours accumulates. Only `<input>`, `<textarea>`, and `contenteditable` elements can be filled - a disabled or read-only field, or a non-field element fails with `FILL_FAILED` rather than reporting a success that did nothing. A `<select>` is rejected too; use the **select** command below.

After typing, `fill` re-resolves the live field. Its result includes value
lengths plus `originalConnected`, `replacementDetected`, and
`valueApplied`/`verification`; raw requested, prior, and actual values are
redacted unless `--show-value` is explicitly supplied. By default, it fails only when a non-empty
requested value is provably lost (the live value becomes empty). A differing
non-empty value is reported as observable—many fields intentionally normalize
or mask input. Add `--expect-value` when the workflow requires exact equality:

```bash
cdp-cli fill "#amount" "12.00" PAGE --expect-value
```

The same rule applies to `target-fill`: it reports a non-empty normalization by
default and only makes exact equality a failure with `--expect-value`. Its raw
values also require `--show-value`.
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
- `--wait-for-expression <js>`: Wait for a truthy JavaScript expression
- `--wait-for-expression-file <path>` / `--wait-for-expression-stdin`: Read that expression from a file or stdin
- `--wait-for-response <url-substring>`: Wait for an observed response armed before the action
- `--wait-for-status <code>` / `--wait-for-body-text <text>`: Further constrain `--wait-for-response`
- `--wait-for-idle`: Wait for network idle and document ready
- `--wait-for-frame <spec>`: Target iframe for wait checks (by selector or index)
- `--wait-for-navigation`: Wait for a real document replacement ([details](#wait-for-navigation))
- `--timeout <ms>`: Timeout for wait operations (default: 10000)

**select** - Set a `<select>` element

Chrome renders the option list as an OS-level popup that is not part of the DOM,
so there is no coordinate a synthetic mouse click can land on: clicking an option
reports success and changes nothing. This command assigns the selection through
the element, focuses it, and dispatches the events a completed user pick produces
(`input` then `change`, both bubbling), so page handlers such as `onchange` fire.

```bash
# By option value (page last, same shape as fill)
cdp-cli select "select[name='mode']" "range" "example"

# By visible label (page is the second argument in this form)
cdp-cli select "select[name='mode']" "example" --text "Date Range"
cdp-cli select "select[name='mode']" "example" --text "date" --match contains

# By position (1-based, same convention as --nth)
cdp-cli select "select[name='mode']" "example" --index 3

# Selects that submit the form on change
cdp-cli select "#store" "example" --text "Downtown" --wait-for-navigation
```

Options:
- `--text <label>`: Match the option by visible label instead of value
- `--index <n>`: Match the Nth option (1-based)
- `--match`: Label matching for `--text`: `exact` (default), `contains`, `regex`
- `--case-sensitive`: Treat `--text` as case-sensitive (default off)
- `--nth <n>`: Choose which `<select>` when the selector matches several
- `--within <selector>` / `--frame <spec>`: Scope the search
- Wait options as above, including `--wait-for-navigation`

The result reports what was actually chosen, so callers can log it:

```json
{"success":true,"message":"Option selected","data":{"selector":"#mode","strategy":"text","value":"range","text":"Date Range","optionIndex":3,"selectedIndex":2,"previousValue":"","previousText":"-- pick --","changed":true,"optionCount":4,"multiple":false}}
```

`optionIndex` is 1-based; `selectedIndex` is the DOM's 0-based value. Selecting a
non-`<select>` element, or a value/label/index that matches no option, fails with
`SELECT_FAILED` and lists the available options.

**dismiss-overlays** - Auto-dismiss toasts, notifications, and modal overlays
```bash
cdp-cli dismiss-overlays "example"
cdp-cli dismiss-overlays "example" --frame "#myframe"
```

Clicks common dismiss buttons (`.toast-close`, `.notify-hide`, `.notification-dismiss`, etc.) to clear the viewport for screenshots.

Optional flags:
- `--frame`: Target iframe by selector or index

**press-key** - Press a keyboard key
Named keys (`enter`, `tab`, `escape`, `backspace`, `delete`, `insert`, `space`, `arrowup`/`down`/`left`/`right`, `home`, `end`, `pageup`, `pagedown`), `F1`-`F12`, and single characters. Aliases: `esc`, `del`, `return`, `up`, `down`, `left`, `right`. An unrecognised name fails instead of dispatching an event the browser ignores.
```bash
cdp-cli press-key enter "example"
cdp-cli press-key tab "example"
cdp-cli press-key escape "example"
cdp-cli press-key arrowdown "example"

# Enter submitting a form: wait for the response document to load
cdp-cli press-key enter "example" --wait-for-navigation
```

Wait options (shared with navigate): `--wait-for`, `--wait-for-text`,
`--wait-for-expression` (or `-file`/`-stdin`), `--wait-for-response`,
`--wait-for-status`, `--wait-for-body-text`, `--wait-for-idle`,
`--wait-for-frame`, `--wait-for-navigation`, `--timeout`.

**emulate** - Emulate a device
Presets `ipad`, `iphone`, and `desktop` (which clears all overrides), or a custom size via `--width`/`--height`/`--scale`/`--ua`/`--touch`.
```bash
cdp-cli emulate ipad "example"
cdp-cli emulate desktop "example"          # reset
cdp-cli emulate custom "example" --width 800 --height 600 --touch
```

Chrome scopes emulation overrides to the CDP session that set them, so the user-agent override is dropped when a short-lived connection closes. The command routes through the daemon when one is running, which keeps the override alive; the result reports `persistent` (whether a daemon session was used) and `uaApplied` (whether the page actually reports the requested UA), plus a warning when it did not stick. Run `cdp-cli daemon start` for UA emulation to hold.

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
- `--session <name>` - Restrict page/target operations to one named workspace session (exact owned IDs only)
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

# Run isolated real-Chrome contract tests
npm run test:live

# Add the opt-in foreground/focus contract
npm run test:live:headful
```

The live suite launches Chrome with a temporary profile and a random debugging
port, owns only that browser process, and cleans it up after the run. The
headful focus check is intentionally opt-in because it affects the visible
desktop.

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

## Windows: which cdp-cli is actually running

### Git Bash and WSL file paths

When a Windows `.exe` receives a path from Git Bash or WSL, it now translates
the drive-shaped forms before opening a file:

```bash
# Git Bash form
cdp-cli screenshot PAGE --output /q/artifacts/page.png

# WSL form
cdp-cli eval _ PAGE --file /mnt/q/scripts/check.js
```

The command records the requested, normalized, and resolved paths in its
success/error details. This makes a shell-path translation visible rather than
silently writing or reading a different location. Only the unambiguous
single-drive forms are translated; ordinary rooted paths such as `/tmp/file`
keep their native Windows interpretation.

An npm global install leaves four entries sharing one stem:

```
cdp-cli        cdp-cli.cmd        cdp-cli.ps1        cdp-cli.exe
```

`PATHEXT` resolves `.EXE` **before** `.CMD`, and the standalone `.exe` does not
track source — it only changes when someone rebuilds it. So:

| Caller | Resolves to | Tracks source? |
|---|---|---|
| Git Bash / WSL | `cdp-cli` (shell script) | yes, via `build/` |
| cmd.exe, PowerShell, PHP `exec()`, batch, Make, most CI | `cdp-cli.exe` | **no** |

A stale exe therefore answers every non-POSIX caller as an older tool, returning
well-formed JSON with no warning, while a bash smoke test reports the new
version. Verifying only from bash cannot detect it.

### `cdp-cli doctor` — the one command that answers it

```bash
cdp-cli doctor
```

It runs `status` through cmd.exe, a POSIX shell and PHP `exec()`, and compares
what answered. Exit 0 means every caller runs the same source; exit 1 prints
which one is stale and what to do about it.

```json
{"type":"doctor","agree":true,"callers":[
  {"caller":"cmd.exe",   "runtime":"exe","version":"1.10.0","commit":"d13bea3aab86...","build":"..."},
  {"caller":"sh",        "runtime":"npm","version":"1.10.0","commit":"d13bea3aab86...","build":"..."},
  {"caller":"php exec()","runtime":"exe","version":"1.10.0","commit":"d13bea3aab86...","build":"..."}]}
```

**The invariant is not "one artifact".** The exe starts about twice as fast and
is meant to stay, so `runtime` legitimately differs between callers. What must
match is `commit` — the source each was built from.

**Compare `commit`, not `build`.** A build timestamp says when a file was
written: copying an install rewrites it, `git checkout` rewrites it, and it
cannot tell a rebuild of the same source from a build of different source. Two
artifacts are interchangeable when their commits match, whatever their
timestamps say. This is what made the split invisible in the first place — both
builds reported version `1.10.0`, five minutes apart, and every version check
agreed.

**If a script needs to gate on the version, read `status`, not `--version`:**

```bash
cdp-cli status
{"cli":{"version":"1.10.0","build":"...","runtime":"exe","commit":"d13bea3aab86...","dirty":false}, ...}
```

`status.cli.version` is a bare semver, safe to hand to any comparator. The
`--version` string is human-facing and carries a build suffix; PHP's
`version_compare` reads that suffix as a pre-release marker and reports an equal
version as *older*, which rejects a correct build.

`dirty` is true when the artifact was built from a tree with modified tracked
files — the commit alone does not identify such a build.

After changing the source, rebuild and install the exe too:

```bash
npm run install:exe    # builds BOTH paths, installs the exe over the one on PATH, then runs doctor
```

`install:exe` runs the full build first. It used to invoke `build-exe.mjs`
directly, which only bundles `build/` and does not compile it — so it shipped an
exe made from whatever stale output happened to be on disk. That is how the exe
fell behind. `build-exe.mjs` now refuses to run against an uncompiled `build/`.

That script deliberately checks with `cmd /c` rather than the current shell, and
fails if anything still shadows the install.

While another process may be calling the CLI, prefer `npx tsc` over
`npm run build` for a redeploy: `build` runs `clean` first, which removes
`build/` and makes every concurrent call fail with `Cannot find module
...build\index.js` until compilation finishes.
