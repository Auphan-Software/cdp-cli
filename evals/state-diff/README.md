# Evals: page-state snapshots and diffs (wi:7792)

The design is recorded in `Q:/apps/jarvis/logs/investigations/wi-7792.md` (Findings §1–§17). These
evals decide whether the feature earns its cost, and whether a prototype is correct enough for agents to
trust. They run in order. Each tier gates the next.

| Tier | Question | Needs the feature? | Status |
|---|---|---|---|
| E1 transcript mining | What does verification cost today, and which failure classes must the diff handle? | no | **implemented** (`mine-transcripts.mjs`) |
| E2 fixture accuracy | Does the diff report exactly the right changes, deterministically? | prototype | spec below |
| E3 real-app replay | Does it stay quiet and useful on real mako2 pages? | prototype | spec below |
| E4 agent A/B | Do agents reach correct verdicts with fewer tokens, calls and screenshots? | Phase 2 | spec below |

## E1 — transcript mining (implemented)

```bash
node evals/state-diff/mine-transcripts.mjs --self-test
node evals/state-diff/mine-transcripts.mjs --transcripts Q:/apps/jarvis/logs/transcripts --out evals/state-diff/out
```

- **Input:** Jarvis Claude transcript exports. Codex exports have no tool calls and are skipped.
- **Episode:** one Bash call containing a cdp-cli action (`click`, `fill`, `select`, `press-key`,
  `drag`, `navigate`, `new-page`, `dismiss-overlays`, `dialog --accept|--dismiss`, or an `eval` that
  clicks, sets values or navigates). It is followed by the observation window: cdp-cli observations
  chained after the action, later observation-only cdp-cli calls, screenshot `Read`s, DB checks and
  sleeps. The window ends at the next action, a user turn, any other tool call, or after 12 calls.
- **Outputs** (gitignored `out/`):
  - `episodes.ndjson`: one line per episode, with provenance `file:line`.
  - `metrics.json`: aggregates and a counterfactual token bound.
  - `sample.md`: a seeded, stratified sample for manual labelling.
- **Labels are heuristics.** `noop-suspected` matches words in the agent's prose, and the spot check
  found a false positive (an intended idempotent save). Before any number drives a decision, fill in
  `sample.md`, which gives a precision per label and two rates: "diff would answer it" and "needs pixels".
- **Token estimates:**
  - Text is estimated as chars/4.
  - Images use the PNG header dimensions when the file still exists (long edge capped at 1568, w·h/750),
    otherwise 1,049 (1024×768).
  - Not measured: context re-read per tool turn, which usually dominates real cost. E4 measures that.

## E2 — fixture accuracy (golden diffs)

Location: `tests/live/state-diff/` (real Chrome through the existing `tests/live/harness.ts`, no
mocks). Each scenario is a static HTML fixture, a scripted action, and a golden expectation file:
`{mustChange[], mustNotChange[], allowedNoise[]}`.

The scenarios come from E1 failure classes, citing the transcript where one exists:

| # | Scenario | Golden result |
|---|---|---|
| 1 | Click that does nothing | `changed:false` |
| 2 | Click opens a jQuery-UI dialog (menupad, `2726b58a…md:6957`) | dialog added, focus moved |
| 3 | Add item updates totals shown as text only (`0a567c1b…md:9350`) | text-region change (`Credit Total`, `Cash Total`) |
| 4 | Validation error on save | alert added, `invalid` 0→1, value unchanged |
| 5 | Checkbox / select / radio toggle | exact `st`/value field change |
| 6 | Delete the middle table row, where rows repeat `data-testid="edit"` | row removal, keys `ambiguous`→qualified, no mismatched pairs |
| 7 | Header clock ticking at 1 Hz | field reported `volatile`, diff empty |
| 8 | Spinner, then content after 800 ms | settled capture shows the content, no spinner change |
| 9 | Toast appears and auto-dismisses before "after" | diff empty. With the Phase 2 alert journal, the toast is reported |
| 10 | SPA route change (`pushState`) | `navigation.kind=same-document` |
| 11 | Full navigation | `navigation.kind=document`, `documentReplaced:true` |
| 12 | Same-origin iframe content change (engine2 shape) | change under `fp` |
| 13 | Cross-origin iframe | `changed:null` with coverage `unreachableFrames` |
| 14 | Click opens `alert()` | `dialog` state, walk skipped, no hang |
| 15 | Action logs a console error and a failed fetch | both attributed to the action window only |
| 16 | Unchanged idempotent save (`8df1f5f3…md:714`) | `mustNotChange` PASSED |
| 17 | Email typed into a customer field | value is `{len,h}` on disk. A grep for the email finds nothing |
| 18 | `after` capture fails, then `diff before after` | `STATE_NOT_FOUND` |

Metrics and pass bar:
- **Recall:** 100% of `mustChange` items reported.
- **Precision:** change lines outside `mustChange ∪ allowedNoise` = 0.
- **Determinism:** 10 repeats give byte-identical diffs.
- **No-op / reload:** empty diff every run.
- **Cost:** capture time p95 < 250 ms, and size < 150 KB at 2,000 elements (a generated stress fixture).

Also run every scenario through `state expect` to cover PASSED, FAILED and UNKNOWN.

## E3 — real-app replay (mako2)

1. From `episodes.ndjson`, pick 10 mako2 journeys labelled `image-viewed`, `dom-dump` or
   `noop-suspected`. Cover a management form, an engine2 iframe page, the POS order screen, and a
   dialog flow.
2. Rebuild each journey as a Jarvis `browser-qa-run.js` action file on a mako2 worktree. Add
   `state capture` before and after every action, next to the original observations. The original
   observations stay the reference.
3. For each action, a judge compares the diff with what the agent concluded in the original transcript
   (quoted from the transcript at `file:line`) and marks: answers / partial / misses / misleading.

Metrics and pass bar:
- ≥ 80% answers-or-partial, with 0 misleading.
- ≤ 1 false-positive change line per action after the mako2 ignore profile.
- Volatile fields discovered, listed for the profile.
- Capture p95 latency and bytes on real pages.
- engine2 reachable through the daemon path, which proves or disproves §17 R1.

## E4 — agent A/B (decides whether to ship Phase 2)

- **Tasks:** 12 mako2 QA tasks. 6 have a planted defect, 6 are clean controls. The defects are:
  - save is a no-op
  - total text is wrong
  - a console error fires on click
  - a dialog fails to open
  - an iframe panel is not refreshed
  - a value is silently not persisted
- The planted defects are patch files applied to a disposable worktree and are never committed to product branches.
- **Arms:** A = current cdp-cli and skills. B = the same plus `state capture|diff|expect`, action
  `--diff`, and a short skill section. Same model and profile (`jarvis-browser-qa`, Sonnet), 3 runs
  per task per arm, randomized order, fresh browser session per run.
- **Metrics** (from transcripts and usage records):
  - verdict accuracy
  - **false-pass rate** (a clean verdict on a planted defect)
  - false-alarm rate
  - total input+output tokens
  - tool calls
  - screenshot views
  - wall time
- **Ship bar for Phase 2:**
  - B's false-pass rate ≤ A's (any increase blocks).
  - B's accuracy ≥ A's.
  - B reduces median tokens or screenshot views by ≥ 30%.
- Re-mine the E4 transcripts with `mine-transcripts.mjs` to compare episode metrics on the same
  scale as E1.

## Decision rules

- If E1's labelled sample shows that "diff answers it" is < 40% of observation windows, or E3
  misses > 20%, stop before Phase 2. The value is not there.
- If E2 precision or determinism fails, fix the capture before any agent-facing work.
