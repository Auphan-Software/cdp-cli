# Changelog

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

### Known gaps

- **No JS-predicate wait** (`cdp-cli-3p5`). `--wait-for` takes a CSS selector and
  `--wait-for-text` takes body text; a caller waiting on anything else — a flag
  on a frame's `window`, say — has to poll from outside with repeated `eval`.
  A `--wait-for-expression` would close it. Deferred deliberately rather than
  added mid-flight.

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
