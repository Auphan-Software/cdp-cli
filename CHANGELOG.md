# Changelog

## 2.0.0

### A command can no longer silently talk to the wrong daemon (breaking)

An agent running against a dedicated Chrome (for example `CDP_URL` on 9333
with its own daemon on 9334) that forgot to export `CDP_DAEMON_URL` had every
daemon-backed command fall back to the stock daemon on 9223. That daemon serves
a different Chrome, so it did not know the named session and answered
**`PAGE_NOT_OWNED`** - a false report that the agent had lost its page, when in
fact it was asking the wrong daemon. `eval` then collapsed that structured
answer into a bare `EVAL_FAILED` message, so the real cause was unrecoverable
from the output.

- The default daemon on 9223 is now assumed only for the default Chrome
  endpoint (`http://localhost:9222`, or 127.0.0.1 / [::1] on port 9222). Any
  other `--cdp-url` / `CDP_URL` without an explicit `CDP_DAEMON_URL` fails
  before any daemon is contacted with **`DAEMON_URL_REQUIRED`**; the details
  name the endpoint, the default that would have been guessed, and the
  variable to set. This applies to every daemon-backed command, including
  `daemon start|stop|status`, `logs`, `ready`, session leases, and `close-page`.
  Interaction commands (`eval`, `click`, ...) fall back to a direct connection
  only when no `--session` / `CDP_SESSION` is set; with a session they need the
  daemon for the operation lease and now fail with `DAEMON_URL_REQUIRED` instead
  of silently bypassing it. `ready` checks the daemon configuration before
  launching Chrome, and `new-page` / `close-page` treat daemon registration and
  cleanup as best effort after the page has already been created or closed.
- The log endpoints (`logs console|network|detail|clear`) and batch execution
  keep the daemon's structured error (`SESSION_NOT_FOUND`, `PAGE_NOT_OWNED`,
  ...) instead of flattening it to a bare message.
- A daemon (or the local session registry) that does not know the supplied
  session now answers **`SESSION_NOT_FOUND`** (`details.sessionName`,
  `details.pageId`) instead of `PAGE_NOT_OWNED`. `PAGE_NOT_OWNED` is reserved
  for a known session that does not own the page and still carries
  `details.actualOwner` when another session owns it.
- Command-level failures (`EVAL_FAILED`, `CLICK_FAILED`, `READY_FAILED`,
  `GET_CONSOLE_LOGS_FAILED`, ...) keep their top-level `code` but now retain
  the underlying error under `details.cause` as `{code, message, details,
  cause}`. A `SessionFoundationError` from the daemon keeps its code and
  details there; a network failure keeps the nested system code such as
  `ECONNREFUSED`. Arbitrary `details` are copied through a bounded,
  cycle-safe serializer so that reporting a failure can never itself throw.

**Migration:** anyone pointing `--cdp-url` / `CDP_URL` at a non-default Chrome
must also export `CDP_DAEMON_URL` (use `http://127.0.0.1:9223` to keep using
the stock daemon deliberately). Scripts that matched `PAGE_NOT_OWNED` to mean
"wrong daemon or missing session" should match `SESSION_NOT_FOUND` /
`DAEMON_URL_REQUIRED`, reading them from `details.cause.code` under a wrapped
command failure.

### Live monitors are bounded by default (breaking)

`list-network` and `list-console` previously defaulted `--duration` to `0`,
which meant "stream until interrupted". A bare `cdp-cli list-network PAGE`
therefore never returned, and the top-level help ("List network requests") read
like a bounded query. An agent that force-killed such a process left the page
unusable, because the stream held the named session's exclusive operation lease
and a hard kill skips graceful release.

- A bare invocation now collects a bounded 30-second window and exits.
- `--duration 0` is rejected with **`STREAM_DURATION_INVALID`**; the message
  names `--follow` and the buffered `logs network` / `logs console` queries.
  `--duration` accepts 0 < seconds <= 3600.
- Unbounded streaming requires the explicit `--follow` opt-in. `--follow` and
  `--duration` together fail with **`STREAM_OPTIONS_CONFLICT`**.
- Both commands end with a terminating
  `{"event":"monitor-stopped","command":...,"reason":"duration"|"interrupted"}`
  line, so a clean stop is distinguishable from a killed process.
- Help text for both commands now routes callers to `logs network` /
  `logs console` for buffered queries.

**Migration:** replace `list-network PAGE` with `logs network PAGE` for queries,
`list-network PAGE --duration N` for a bounded capture, and
`list-network PAGE --follow` where a script genuinely relied on the old
stream-forever behavior. `--duration 0` must be changed; it no longer runs.

### Passive monitoring no longer takes the exclusive page lease

`context.connect()` unconditionally acquired the named-workspace operation lease
and heartbeat it every 20 seconds against a 60-second TTL, so a live monitor
held the page for as long as it ran. `list-network` and `list-console` only
enable a CDP domain and print events, so they now connect with `{ lease: false }`:
they still assert that the named session owns the target, but they take no
exclusive lease. Other commands can use the same page while a monitor runs, and
a force-killed monitor no longer wedges that page for the lease TTL. Interaction
commands are unchanged and still serialize through the exclusive lease.

Normal completion and SIGINT/SIGTERM both close the WebSocket before exiting
(130 for SIGINT, 143 for SIGTERM). A passive monitor holds no lease of its own,
so it never releases leases another operation on the same context still holds.

A monitor also stops on its own when the work is over or ownership changes, and
the `monitor-stopped` line names the reason:

- `duration` - the bounded window elapsed.
- `interrupted` - SIGINT/SIGTERM.
- `disconnected` - the page or browser went away (the CDP socket closed), so a
  monitor no longer waits on a dead target.
- `ownership-revoked` - the named session lost the target (for example
  `session reset`/`session remove`); the monitor stops and exits 1.

Connection setup is bounded too: if the connect/enable phase has not completed
within 30 seconds the command fails with **`STREAM_SETUP_TIMEOUT`** rather than
hanging before the window starts. Monitors also no longer retain the events they
print, so a long `--follow` run does not grow the heap.

## 1.13.0

### Headless, idempotent named sessions for unattended agents

`cdp-cli ready --headless` launches a hidden Chrome, while `CDP_URL`,
`CDP_DAEMON_URL`, and `CDP_SESSION` provide explicit per-agent endpoint and
session defaults. `session ensure NAME` is idempotent: repeated calls return the
same primary page rather than multiplying tabs, and created targets remain in
the background.

### Named reset now disposes the named browser context

`session reset NAME --force` previously ignored `NAME`, erased all persisted
session metadata, and left the corresponding Chrome contexts and pages alive.
Repeated recovery attempts therefore accumulated invisible pages and Chrome
processes. Reset now acquires or replaces only the named session's own leases,
disposes that isolated context, and creates one fresh `about:blank` page without
touching other sessions. Shared-context sessions fail closed because their
pages cannot be disposed independently.

The old metadata-only recovery behavior is now the explicit
`session metadata-reset --force --metadata-only` command. It is intended only
after the dedicated Chrome and daemon are stopped. If Chrome disposes the old
context but replacement creation fails, reset reports
`SESSION_RESET_INCOMPLETE` instead of claiming an atomic success.

### Failed commands release browser and operation sessions

Snapshot, evaluation, query, styles, emulation, and overlay failures close their
CDP sessions before exiting. Daemon endpoint selection now honors
`CDP_DAEMON_URL`, including lifecycle and debugger-attachment checks, so agents
using separate browser endpoints do not accidentally coordinate through the
default daemon.

## 1.12.0

### Actions and waits now report what the browser actually did

`click` verifies that an ordinary target document received the pointer event,
rather than treating a successful CDP dispatch as proof of delivery. It fails
with **`CLICK_NOT_DELIVERED`** when that postcondition is disproven. The
existing iframe-delivery check remains in place for clicks whose point lands on
a frame.

`fill` resolves the live field again after typing. Its result says whether the
original element remained connected, whether a reactive renderer replaced it,
the live value length, and whether the requested value was applied. Raw input
values are redacted by default and require explicit `--show-value` output.
If a non-empty requested value is demonstrably lost, it fails with
**`FILL_VALUE_NOT_APPLIED`** rather than claiming success.

A differing but non-empty live value is observable rather than automatically
wrong: field masks and normalizers are common. Use `fill --expect-value` or
`target-fill --expect-value` when the caller needs strict exact equality.

### Pre-armed waits cover the events that used to be missed

`--wait-for-idle` is armed before `navigate`, `click`, `fill`, `select`, or
`press-key` sends its triggering action. It tracks request IDs, including
redirects and failures, so an immediately-started fetch cannot finish before
the listener exists.

The same commands gain:

```bash
# A truthy JavaScript predicate; async expressions are supported
cdp-cli click "#save" PAGE --wait-for-expression "window.saved === true"

# Keep JavaScript out of a shell command line
cdp-cli click "#save" PAGE --wait-for-expression-file waits/saved.js
Get-Content waits/saved.js | cdp-cli click "#save" PAGE --wait-for-expression-stdin

# Wait for a particular observed response, optionally constrained further
cdp-cli click "#save" PAGE --wait-for-response "/api/order" --wait-for-status 201
cdp-cli click "#save" PAGE --wait-for-response "/api/order" --wait-for-body-text '"ok":true'
```

Response URL matching is a literal substring, status is exact, and body
matching reads at most 64 KiB internally. Response bodies are never emitted by
the wait or included in its timeout message. Exactly one expression source may
be supplied. `--wait-for-status` and `--wait-for-body-text` require
`--wait-for-response`.

`wait PAGE` exposes the same checks without first dispatching an action. It
uses `--expression` (or file/stdin) and retains the existing `--wait-for*`
spellings for selector, text, idle, frame, and response checks. Expression
timeouts report the last bounded value or exception.

### Network history retains lifecycle, redirects, and failures

Daemon network records are updated in place as Chrome reports response,
completion, redirect, or failure events. A failed request therefore stays
failed in later log queries instead of looking like an unfinished request.

```bash
cdp-cli logs network PAGE --url /api/ --method POST --status 500
cdp-cli logs network PAGE --failed --since 1787059200000
cdp-cli network-detail REQUEST_ID PAGE
cdp-cli network-detail REQUEST_ID PAGE --body --max-body-bytes 32768
```

`network-detail` emits the complete retained redirect/lifecycle chain and
redacts sensitive request/response headers. Response-body output is explicit
and bounded; use it only where that data is permitted.

### Focus and failure evidence are deliberate, bounded, and redacted

`page-health PAGE` reports focus, visibility, viewport, active element, and
available browser-window state without activating the page. `activate-page
PAGE` performs foreground activation only when a workflow explicitly needs it;
ordinary inspection no longer steals focus.

`diagnose PAGE [--output-dir DIR]` collects a bounded diagnostic bundle:
redacted URL/frame state, dialog state, page health, a small DOM summary, and
recent console/network failures when the daemon is running. With `--output-dir`
it writes `manifest.json` and a screenshot without deleting existing contents,
and refuses to overwrite either artifact if it already exists. Diagnostic
bundles can still contain page-derived data and should be reviewed before sharing.

### Windows shell paths preserve intent and provenance

File-taking commands recognize Git Bash `/q/...` and WSL `/mnt/q/...` path
forms when the CLI runs as a Windows executable. Results and errors retain the
requested, normalized, and resolved path so an agent can distinguish a shell
translation problem from a missing file. Native Windows paths and ordinary
rooted paths keep their previous meaning.

### Real-browser contract tests

`npm run test:live` launches an isolated Chrome profile and verifies the
high-risk browser contracts: reactive field replacement, immediate network
activity, request success/failure capture, and same- and cross-origin iframe
discovery. `npm run test:live:headful` additionally exercises focus behavior
when explicitly enabled on Windows.

### Exact OOPIF target operations

`targets` lists page and out-of-process iframe targets; `target-frame` maps an
iframe selector in a known parent target through Chrome's exact frame ID.
`target`, `target-eval`, `target-query`, `target-fill`, and
`target-press-key` then operate only on a literal target ID. This avoids the
old ambiguity where a page-target connection had no execution context in an
OOPIF. Target-local selectors must match exactly one element; the initial set
intentionally provides no mouse-coordinate click primitive. Topology URLs omit
credentials, query strings, and fragments.
`target-query` and `target-fill` redact raw values by default while retaining
lengths and verification state; `--show-value` is an explicit opt-in.

### Named sessions isolate agent work and make ownership explicit

`session create`, `session list`, `session adopt`, `session remove --force`,
and `session reset --force`
manage named workspace sessions. New sessions get an isolated Chrome
`BrowserContext` by default; `--shared` is an explicit compatibility mode.
`--session NAME` scopes page/target work to exact IDs owned by that session, so
title/URL lookup is deliberately unavailable and cross-owner access yields
**`PAGE_NOT_OWNED`**.

The internal session layer provides per-root operation leases, durable
validation of metadata, and fail-closed browser-instance checks. Persisted
state holds IDs and session metadata only—not titles, URLs, logs, credentials,
or storage. Context disposal requires explicit `--force`, and a shared
compatibility context cannot be disposed by a session. BrowserContext is
accident isolation, not a security boundary.

Lock creation, dead-owner recovery, and release are serialized so a stale
holder cannot delete a successor's lock. A crash inside that tiny mutation
guard fails closed and reports the exact guard path for deliberate manual
recovery; `session reset --force` never guesses that a guard is abandoned.

## 1.11.0

### A click into a frame is now confirmed, not assumed

`click` used to report success whenever it dispatched the events. When the
click point resolves to an `<iframe>`, dispatching says nothing about delivery:
Chrome routes the event into that frame from the browser process, and while
that routing is still coming up the event goes to the top frame instead and
does nothing at all.

Measured on a live Bambora card field (Chrome 151.0.7922.138): a click up to
~500ms after the card iframe mounted was swallowed — `document.activeElement`
stayed `BODY`, the field stayed empty — while the identical click from ~1s on
landed. `click` reported `{"success":true, "occludedBy":null}` for both.

`click` now checks, when and only when the click point is a frame, that the
frame took the click, and fails with **`CLICK_FRAME_NOT_REACHED`** when it did
not — the same contract as `CLICK_OCCLUDED`, which already refuses to pretend a
swallowed click happened. `--force` dispatches and reports anyway.

The evidence is the event turning up **outside** the frame. Events do not cross
a frame boundary, so the document around the frame sees the mousedown only when
the frame did not get it; `details.deliveredTo` names what received it instead.
Focus moving to the frame element is used too, but only to conclude success
early — it arrives in 15-40ms, and a frame whose own content calls
`preventDefault` on mousedown takes the click without ever taking focus, so
focus alone would fail clicks that worked (measured, both ways).

A click that navigates or tears down the page takes the check's execution
context with it. That reports `frameReached: null` — unverifiable, not failed.

Successful clicks gained `frameReached` (`null` when the click point was not a
frame, or could not be verified) and `hitFrame`. `details.frameSrc` is trimmed
to origin and path, because hosted-field iframe URLs carry session tokens.

This is **not** "cross-origin iframes are unreachable": clicks into cross-origin
and out-of-process frames work, including the Bambora fields, once the frame is
routable. Only a click that provably did not arrive now fails.

### `install:exe` shipped the exe from a stale `build/`

```
"install:exe": "node scripts/build-exe.mjs && node scripts/install-exe.mjs"   # before
"install:exe": "npm run build:exe && node scripts/install-exe.mjs"            # after
```

`build-exe.mjs` bundles `build/exe-entry.js`; it does not compile TypeScript.
Run without a build in front of it, it produced an exe from whatever output was
already on disk and installed it over the one on PATH. That is the mechanism
behind the observed split: on 2026-08-12 the exe was cut at 18:25:59Z and
`build/` was recompiled at 18:31:26Z, leaving cmd.exe/PHP `exec()` on one build
and Git Bash on another, both reporting `1.10.0`.

`build-exe.mjs` now refuses to run when `build/build-info.json` is absent, so
calling it directly cannot silently ship a mystery binary either.

### Artifacts carry their source commit

`status.cli` gained `commit` and `dirty`; `--version` shows the short commit:

```
1.10.0 (npm build 2026-08-13T21:27:17Z, commit d13bea3aab86-dirty)
```

The npm path previously reported its own file mtime as the build time. A mtime
is rewritten by copying and by `git checkout`, and cannot distinguish a rebuild
of the same source from a build of different source. `scripts/stamp-build.mjs`
now writes `build/build-info.json` at build time, and the exe gets the same
fields through esbuild `define`.

**Gate on `commit`, not `build`,** when asking whether two callers run the same
tool.

### New: `cdp-cli doctor`

Runs `status` through cmd.exe, a POSIX shell and PHP `exec()`, then compares the
source commit. Exit 1 names the caller that is stale.

The check deliberately allows `runtime` to differ — the exe starts ~2x faster
and is meant to coexist with the shims. Only the commit must match. An `unknown`
commit (an artifact built before this stamp existed) fails rather than passes: a
check that cannot see must not report clean.

`npm run install:exe` now ends by running `doctor`, so a version match alone can
no longer be mistaken for a verified install.

## 1.10.0

### `status` reports the CLI version as machine-readable fields

```json
{"cli":{"version":"1.10.0","build":"2026-08-12T18:25:59Z","runtime":"exe"}, "daemon":{...}, "chrome":{...}}
```

**Scripts should gate on `status.cli.version`, not on `--version`.** The
`--version` string carries a build suffix (`1.10.0 (exe build ...)`), and PHP's
`version_compare` treats trailing text as a pre-release marker — so comparing
the raw string against a bare semver reports an *equal* version as older:

```php
version_compare("1.10.0 (exe build ...)", "1.10.0", "<")   // TRUE - rejects a correct build
version_compare($status["cli"]["version"], "1.10.0", "<")  // false - correct
```

Any harness that shells out and compares versions wants the `status` field.
`--version` stays human-facing.

The `status` payload gained the `cli` key; `daemon` and `chrome` are unchanged,
so existing readers of those keep working.

## 1.9.0

### `--version` now reports which build is answering

```
1.9.0 (npm build 2026-08-12T18:06:54Z)   <- the shell/.cmd path, rebuilt by `npm run build`
1.9.0 (exe build 2026-08-12T18:10:32Z)   <- the standalone exe
```

On Windows the global install leaves four entries sharing one stem (`cdp-cli`,
`.cmd`, `.ps1`, `.exe`) and `PATHEXT` resolves `.EXE` **before** `.CMD`. The
standalone exe does not track source, so once it falls behind it answers
cmd.exe, PowerShell, PHP `exec()`, batch files and CI as an older tool — with
well-formed JSON and no warning — while Git Bash picks the shell script and
reports the new version. Two different build stamps under one semver is now the
visible symptom.

New: `npm run install:exe` builds the exe, installs it over every `cdp-cli.exe`
on PATH, and verifies with `cmd /c` rather than the calling shell, failing if
anything still shadows it.

### Fixed
- `--wait-for-navigation` help on all five commands still described a
  main-frame-only wait after the behaviour became frame-aware in 1.8.0.

## 1.8.0

### BREAKING: `--wait-for` and `--wait-for-text` now default to the `--frame` document

Previously these always checked the **top** document, even when the action was
targeted inside an iframe with `--frame`. They now check the frame you were
driving, unless `--wait-for-frame` says otherwise.

**Who this affects:** any script that passes `--frame` *and* `--wait-for` or
`--wait-for-text`, and expects the wait to match against the top document.

**Escape hatch:** pass `--wait-for-frame 0` to force the top frame.

```bash
# Old behaviour, restored explicitly
cdp-cli click "#save" PAGE --frame "#inner" --wait-for-text "Saved" --wait-for-frame 0

# New default: the text is matched inside #inner
cdp-cli click "#save" PAGE --frame "#inner" --wait-for-text "Saved"
```

The old behaviour was the same silent-wrong-target hazard the rest of this
release addresses: acting in a frame and then asserting against a different
document returns a confident success about the wrong DOM.

### `--wait-for-navigation` is frame-aware

A form POST inside an iframe replaces only that frame's document; the main frame
never moves, so a main-frame wait sat there until it timed out. The watched
frame now comes from `--frame`, overridable with `--wait-for-frame`:

```bash
# submit inside an iframe — no extra flag needed
cdp-cli click "input[value='Add']" PAGE --frame "#page-iframe" --wait-for-navigation

# button in the TOP document drives a form in the iframe
cdp-cli click ".nav-save-btn" PAGE --wait-for-navigation --wait-for-frame "#page-iframe"
```

Main-frame waits still reject subframe navigations, so an unrelated iframe
cannot satisfy one — this is an addition, not a loosening. Subframe completion
uses `Page.frameStoppedLoading`/`Page.lifecycleEvent`, since
`Page.loadEventFired` only fires for the main frame. Timeout errors name the
frame, and a main-frame timeout points at `--wait-for-frame`.

## 1.7.0

### `--wait-for-navigation` on `click`, `fill`, `select`, `press-key`, `navigate`

Resolves on a real document replacement, keyed on `loaderId`, armed before the
action. `--wait-for-text` cannot do this job on a post-and-refresh page: every
label is already on the outgoing document, so it returns immediately and the
caller asserts against the old DOM.

Same-document changes (hash routes, `pushState`) deliberately do not satisfy it.

### `select` command

Chrome renders a `<select>`'s options as an OS popup outside the DOM, so
clicking an option reports success and changes nothing. `select` assigns the
value and dispatches the events a real pick produces (`input` then `change`,
bubbling).

```bash
cdp-cli select "select[name='mode']" "range" PAGE
cdp-cli select "select[name='mode']" PAGE --text "Date Range"
cdp-cli select "select[name='mode']" PAGE --index 3
```

Returns the resulting value and label; errors list the available options.

### Fixed
- `new-page` truncated the URL at its first `&` and dropped the fragment. The
  endpoint was built as `/json/new?<url>`, and Chrome parses everything after
  `?` as a query string. Hash-routed SPAs silently got the wrong page.
- `press-key` gained the full wait option set; it previously had none, leaving
  Enter-submits unwaitable.
- `screenshot --output` reports pixel dimensions and an absolute path.
