# Inspection selection replay, 2026-10-09

Five fresh managed Claude Haiku 5.5 conversations ran through current Control on
`laptop-win`, linked to Work item8508. Each received one retained, real login-page
capture and the identical three questions: store number, SRM version, and a
concrete Management target present in the evidence. No tools, browser actions,
files, payments or fixture changes occurred. Missing evidence triggered exactly
the requested capture in a continuation of that conversation. All five final
answers passed independent exact-value/target checks, without guessed selectors.
This is an evidence replay, not a fresh native/CDP WebSRM E2E comparison.

| First format | Requests | Fresh input | Cache creation | Cache reads | Output including thinking | Whole tokens | Follow-up |
|---|---:|---:|---:|---:|---:|---:|---|
| CLI ax |1|2|32989|0|699|33690|None|
| CLI ax JSON |1|2|11860|21558|445|33865|None|
| MCP actionable snapshot |1|2|11447|21558|368|33375|None|
| CLI text |2|4|15383|53474|991|69852|Actionable snapshot|
| MCP observe |2|4|17083|56303|1284|74674|Text|

Text first reduced the initial input context by1089 tokens relative to snapshot,
but lacked a selector. The follow-up processed another37225 tokens including
output. Its whole task used2.09x snapshot's tokens. Observe supplied a valid
source/control-key pair but omitted the two visible labels; adding text resulted
in2.24x snapshot's whole tokens. JSON preserved exactly the actionable answer;
this one sample gives no evidence of an efficiency advantage over ordinary ax.
Do not rank ax against snapshot by their small total difference: thinking varies.

All runs used claude-haiku-5-5, no compactions and zero tool calls. There were
seven distinct model requests. Initial input contexts were31918–34747 tokens;
most of that is the new managed harness, not the captured page. First ax was
cache cold while later arms reused the21558-token shared prefix. Cache categories
are retained, so dollar comparisons would require cache normalization and verified
rates. No prices or billed-cost savings are claimed. Prompt-injected captures,
operator continuations, one page and one sample per format limit extrapolation to
real tool calls and harder journeys. The new harness differs from historical
native03/hybrid03; do not compare their totals as if only inspection changed.

## Accounting

Usage sums each completed provider result.usage once. It agrees with the last
cumulative result.modelUsage and the input categories of assistant message IDs
after deduplicating streamed fragments. Never sum cumulative modelUsage across
continuations. All captures and commands, complete histories, final values and
checks are preserved locally in inspection-policy-experiment-01; the summary is
[inspection-replay-results.json](inspection-replay-results.json).

Control context.spend is shared across the Work item, not per run. Its request
count7 correctly aggregates the five conversations. Its streamed output total29
understates completed provider output3787, including thinking. Filed Work bug8603;
no platform repair attempted. This finding does not by itself invalidate historical
benchmarks, which have a separate native-transcript usage path.

## Provisional operator rules

- If the next step needs a newly discovered control, use actionable snapshot
  first. It supplied both values and targets in one pass on this page.
- Use text for a visible-value check when no new selector is needed. Do not
  select it just because its response is shorter if a control discovery follows.
- Use observe for information the snapshot cannot supply, such as control keys
  or selected/disabled semantics. Here it was unnecessary for named-control
  discovery and insufficient for visible-label checks.
- Use JSON for a parser's packaging requirements; it supplies no additional
  discovery information. Do not infer selected values from redacted hashes.
- Reduced pixels, unlabeled icons and iframe boundaries still require their
  own live tests. Retain existing coordinate source/viewport guards. This replay
  provides no evidence to change screenshot scale or coordinate behavior.

## Live management and native admission

The source-backed engine2 entry wraps child content in #page-engine2-iframe.
Current menu_editor.php selects menu_editor_core.tpl, which differs from the old
three-frame template. System Config's #penny_iframe is a preview, not the settings
form. Discover the actual current frame tree before qualifying a management run;
reach Mako2 through its real #s: SPA route and prove jQuery/top.navAuto boot.

The current managed Host's ClaudeArgs supplies --restricted, --strict-mcp-config
and only its jarvis SDK server. The operator launch schema has no external MCP
or Chrome configuration. The old five-tool CDP/native actor setup cannot be
replayed through that path unchanged. CLI text can be exercised through the
managed shell, but that would change the tool contract and does not admit an
otherwise identical native comparison. The five-tool CDP adapter also lacks
text/value inspection. A managed browser-tool profile and actual live capability
check are required before the next matched live pair. No untracked Claude launch
or retired Jarvis/Blink fallback was used.

The six-task management plan is retained in inspection-policy-experiment-01/
qa-plan.md. Compact result/ledger reporting must still be applied identically to
both live arms. The historical reporting-removal estimate remains unmeasured by
a fresh matched hard run.
