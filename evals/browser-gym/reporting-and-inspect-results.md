# Compact reporting optimization and inspection formats

Implemented a shared [compact reporting contract](reporting-contract.md): one
compact result write, one compact ledger write and a short final answer. Real
write failures, discovered correctness problems and mandatory checkpoints remain
valid reasons for additional work. Apply the same policy in both benchmark arms.
The generation helper replaces the old reporting paragraph in a new directory;
it does not alter retained inputs or copy an old execution admission.

The [reporting auditor](audit-reporting.mjs) deduplicates streaming messages/tool
calls, uses the existing usage auditor, separates first-to-last browser requests
from setup/reporting, and flags duplicate writes, readback and oversized reports.
Tests cover streaming duplication, compact success, reporting recovery flags,
size overruns, missing browser evidence and incomplete transcript tails.
Historical native03/hybrid03 replays reproduce all previous phase totals and
flag precisely hybrid's result readback/rewrite. No fresh model trial has yet
measured the new policy's savings; historical removal estimates are not results.
The reporting auditor plus existing gym tests passed27/27. The preparation
helper successfully generated a new candidate contract without old reporting
instructions or copied admission. Fresh matched actor testing is tracked in
cdp-cli-2gw. Audits and format measurements are saved in
[reporting-inspect-review](reporting-inspect-review/inspect-metrics.json).

## Formats actually exercised

The recent full hard WebSRM trials exercised MCP concise actionable snapshot,
screenshots and source-chained actions. Earlier observe/profile projection
comparisons remain documented separately. There was no matched hard-task agent
matrix comparing CLI ax, plain text and structured ax JSON. Do not interpret
unit coverage of these formats as E2E token evidence.

The new read-only live probe used the existing owned gym page/session. At probe
time the page was at the login screen, not an authenticated hard journey or a
management iframe. It made no clicks, navigation, payments or fixture changes.
Five formats completed successfully:

| Format | Delivered text bytes | Discovery rows | Suitable use |
|---|---:|---:|---|
| CLI ax, redacted | 2400 | 25 | Concise actionable labels and CSS selectors |
| CLI ax JSON, redacted | 2559 | 25 | Same selectors in machine-readable lines |
| CLI text | 247 | 27 text lines | Visible text checks; no selectors |
| MCP snapshot | 2768 | 25 | Source-bound actionable discovery; aligned, omitted0 |
| MCP observe | 5756 | Not directly comparable | Richer semantic control discovery with source keys |

MCP envelope sizes were2997 and6859 bytes respectively; use text bytes when
comparing model-facing text, rather than counting JSON escaping as model input.
CLI text is document.body.innerText, not a lossless DOM/AX tree. Despite its name,
CLI ax is a DOM actionable-element projection, not the browser's complete native
accessibility tree. JSON changes packaging, not discovery content. Sequential
clock text can change; the probe does not claim atomic DOM identity. No tokens
were inferred from byte counts.

Practical selection: use text for a known visible value when no new target is
needed; ax/snapshot for exact selectors; reduced pixels for visual navigation;
observe only for richer semantic evidence/source keys. Use frame-specific
inspection on management pages. The current five-tool MCP adapter exposes
actionable snapshot, not CLI format:text; these options have not all been made
available to the restricted model actor or proven as an optimal combination.
No claim is made about management-iframe performance from this login probe.

Raw probe outputs and historical reporting audits remain local under
C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/inspect-format-probe-01.
The first diagnostic-helper attempt failed because its imported bridge dispatched
through the helper entry point. The helper was corrected to use the production
CLI entry and the complete probe rerun passed; no product action was involved.

A subsequent [five-format managed Haiku evidence replay](inspection-selection-results.md) completed with independently checked answers and provider token accounting. It qualifies format selection on the captured login task; it does not establish fresh hard-E2E or native parity.
