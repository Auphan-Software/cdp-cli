---
name: persistent-browser-qa
description: Keep one dedicated browser-QA subagent across iterative UI fixes. Use when verification spans multiple journeys, roles or permission states, fixtures, visual evidence, or repeated fix-and-retest cycles; skip it for one trivial smoke check.
---

# Persistent Browser QA

## Reduce browser investigation turns

Read the `cdp-cli-workflow` skill for reproduction and visual evidence. Prefer
the inherited `mcp__cdp-workflow__observe`, `act`, `expand` and `screenshot` tools.
An action returns fresh compact state and a diff: inspect that result before
asking for another observation. Request screenshot pixels only for visual claims,
and consume the image tool result without a redundant Read. Keep canonical
expansion and the existing agent/CLI fallback for uncertainty, unsupported input
or incomplete coverage. Query filtering and workflow reranking are retired. Omit query; use current
source-bound keys and captured unnamed-control boxes with screenshot pixels.
Track whole-task token categories, tool batches, elapsed time and verified
evidence quality; fewer state characters alone do not establish improvement.
All ownership, preflight, project boot and persisted-state rules below still apply.

Separate browser verification from production implementation without repeating setup after every fix. The implementation owner changes production code. One continuing QA child owns the acceptance matrix, browser state, fixtures, and cumulative evidence for the current UI scope.

If you are already the dedicated browser-QA worker, you are that continuing owner: drive the
browser yourself and never spawn nested browser agents. Only an implementation owner delegates the
single QA lane. This prevents a top-level Sonnet QA worker from recursively creating six more
browser contexts and paying setup costs again.

## Delegate when the setup is worth preserving

Use the `jarvis-browser-qa` child profile when any of these apply:

- More than one journey, role, permission state, viewport, or related page must be checked.
- One or more fix-and-retest cycles are likely.
- Testing needs seeded records, durable fixtures, authentication state, or meaningful cleanup.
- Visual evidence, console/network inspection, or persisted-state verification is required.
- The UI crosses a backend, migration, synchronization, payment, or permission boundary.

Keep a single quick smoke journey in the head when delegation would cost more than the test.
Keep stable deterministic harness rows in the head too when they require no browser judgment or
reusable setup; batch them while the browser lease is free. If a separate operator genuinely saves
coordination time, use `jarvis-browser-rerun` only for an exact known command with structured output.
It returns malformed or unexpected results without diagnosis; route those to the Sonnet QA/head lane.

## Give the child an explicit contract

Provide the exact candidate commit and environment, a compact acceptance matrix, the exact cumulative `*.qa.md` ledger path supplied by the launch prompt, allowed test and evidence paths, and exclusive use of the inherited `CDP_SESSION` and `CDP_PAGE` while the child runs. The matrix must include the original failing path, nearest ordinary happy path, materially different modes, negative controls, and adjacent behavior claimed unchanged.

The child initializes the ledger from `Q:/apps/jarvis/templates/browser-qa-ledger.md` before its first browser action and updates it after every row and before every return. The head reconciles this ledger into its recovery checkpoint before claiming completion.

When a project-specific `feature-qa` or browser skill exists, follow it for navigation, authentication, fixtures, assertions, and screenshots. This skill controls ownership and iteration; it does not replace project-specific browser instructions.

Before the head delegates, the ledger's current state must already carry the candidate, login
recipe, fixture/cleanup plan, persisted-state assertions, and an acceptance matrix, and
`bash Q:/apps/jarvis/scripts/jarvis.sh browser-qa-readiness --preflight` must pass. The runtime hook
refuses a `jarvis-browser-qa` launch until it does; that refusal is a harness blocker, not a lane to
fix by exploring. Before the first browser action, the child runs
`bash Q:/apps/jarvis/scripts/jarvis.sh browser-qa-preflight` and records the candidate commit, database
migration state, exact login recipe, fixture/cleanup plan, inherited session/page identity, and
lease owner in the ledger. If the core preflight fails, report a harness blocker; do not adopt a
random page, create a routine replacement, or reset the named session. Use
`cdp-cli logs console "$CDP_PAGE"` for console evidence. Do not use `list-console` in this workflow.

### A loaded page is not a booted page (wi:7311)

HTTP 200 plus a rendered body proves nothing about the SPA. mako2 management pages are navEngine
PARTIALS: loaded by direct URL (`/management/<page>.php`) they render a shell with `jQuery`
undefined, the `$.getScript` bootstrap never fires, and every assertion against that shell is a
silent false negative (mako2#5026: direct load -> `jq:false gmaps:false`; the same page through the
nav chain -> Google Maps 3.65 and nine tiles). The route was the only difference.

- Reach every non-print mako2 page through the `#s:` chain, never by direct URL:
  `{base_url}?test_scenario=admin#s:login.php?lang_id=1,management/management.php?lang_id=1,management/PAGE.php?lang_id=1`
  (params go on the last segment: `management/PAGE.php?lang_id=1&param=value`). Only the
  `*_print.php` standalone pages listed in the `feature-qa` skill may be loaded directly.
- Put that entry URL on the ledger `Login:` line. `browser-qa-preflight` then navigates to it and
  requires the runtime to be live — `jQuery` a function AND `top.navAuto` present — before it
  passes; a dead page is a hard exit 1 with the probe output. Without a `#s:` URL the preflight
  says `SPA boot NOT proven`, and you must run
  `bash Q:/apps/jarvis/scripts/jarvis.sh browser-qa-boot "<entry url>"` yourself before any row.
- Boot is judged per project (wi:7983): the ledger `Project:` line (or `JARVIS_QA_PROJECT`) picks
  a contract in `Q:/apps/jarvis/config/browser-qa-boot-contracts.json`; no line means mako2. The
  mako2 contract is the idle wait + `jQuery` + `top.navAuto` above. whitetip2's storefront never
  reaches network idle and has no navAuto, so `Project: whitetip2` waits for `.product.tile` and
  requires `jQuery` + `navEngine` + that selector; its entry is
  `{base_url}?cb=1#s:menu.php?store_id=STORE_ID`. A named project with no contract is exit 2 —
  add one to the table, never borrow mako2's. whitetip2 ignores `test_scenario=`, but the global
  Blink hook rejects a quoted `cdp-cli navigate` URL containing `mako2` (the dev host is
  `mako2.local.dev`) without it, so add the no-op `test_scenario=guest` to direct navigate URLs.
- After any navigation to a different page, before recording a row, rerun
  `jarvis.sh browser-qa-boot` (no URL: probes the current page). In an action file, give every
  row a `pre` step `{"cdp":["eval","typeof top.navAuto","{{page}}"],"expect":{"match":"object|function"}}`
  so `browser-qa-run` classifies a dead partial as `precondition`, not as a product result.
- A boot failure is a harness/navigation failure. Fix the route; never mark the row proven,
  failed, or "page renders" from a shell.

The QA child may edit only explicitly assigned tests, fixture helpers, screenshots, and QA reports. It reports product failures to the implementation owner and does not repair production behavior itself. The head and other children must not operate the same worker's browser allocation concurrently.

## Explore once, execute many

Once a row's navigation, login, and assertion recipe is stable, write it as a versioned action file
(`{"version":1,"candidate":"<base>..<head>","actions":{...},"rows":{"R1":{"pre":[],"steps":[],"post":[],"evidence":[]}}}`)
and rerun it with `bash Q:/apps/jarvis/scripts/jarvis.sh browser-qa-run <file> --row R1 --row R2`.
One bounded command executes every listed row through cdp-cli with the inherited session and returns
JSON: each row `proven | failed | blocked | untested` with a classification of `precondition`,
`assertion`, `harness`, `shape`, or `evidence`. An unexpected output shape or harness failure stops
and escalates to the Sonnet QA lane; the runner never heals, retries into a different page, or
replaces the browser, service, or MCP. Deterministic reruns of a known action file may go to
`jarvis-browser-rerun` (Haiku). Name the file on the ledger's `Actions:` line.

## Resume instead of respawning

Launch one QA child after the first candidate and acceptance matrix exist. Record the returned child ID in the recovery checkpoint.

After each implementation fix:

1. Identify the new candidate commit precisely.
2. Resume the same child with that commit, the affected acceptance rows, and invalidated fixture assumptions.
3. Rerun failed and affected rows, their negative controls, and the nearest ordinary smoke path.
4. Update the cumulative report without replaying unchanged successful setup.

Do not replace the child merely because it found a bug. Resume it; tool counts are telemetry, and the controller renews it when its context nears the limit. Rotate only when it is unavailable, its context is no longer reliable, or a material scope change creates a new acceptance matrix. Before rotating, require the ledger to contain a compact handoff with the page/session identity, fixtures, proven rows, open failures, evidence paths, cleanup state, and exact next check.

The ledger has two parts. Everything above `## History` is the bounded current state (under 160
lines): one row per acceptance criterion, its latest status, fixtures, open failures, and one compact
handoff. Readiness parses only that part. Superseded rows, analysis, and rotation notes go below
`## History`, newest last, so the next lane never re-reads them.

## Require decisive evidence

Classify every row as `proven`, `harness-only`, `inferred`, or `untested`. A page load does not prove an interaction. The report must include:

- Candidate base/head commit and environment identity.
- Reproduction steps and expected versus observed result.
- Real entry point, role or permission state, and fixture identifiers.
- DOM or persisted-state assertions and relevant console/network errors.
- Before/after evidence for interactions and no more than three reviewer-facing screenshots by default.
- Fixture creation and cleanup status.
- Remaining risk and the exact next check for every row not proven.

Treat a broken browser mechanism as a blocker. Distinguish product failures from selector, delivery, authentication, session, and fixture failures. Do not substitute a direct handler test for an unreachable real journey and call it proven.

The first pass may run the complete matrix. Intermediate passes cover failed and affected rows plus the ordinary smoke path. Run the full required matrix once after the final substantive commit. Tool counts are telemetry, not limits: at a context checkpoint finish the current row, update the ledger, and continue; at a renewal clean temporary fixtures, write the compact handoff, and return so the head can resume you in a fresh context.

Finish only when the required rows point at the final candidate, fixture cleanup is recorded, open risks are explicit, and browser exclusivity can be released. Jarvis teardown owns named-session cleanup; do not close the session manually.
