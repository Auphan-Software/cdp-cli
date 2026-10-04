# Real browser evidence workloads and acceptance metric

The October 3 user requirement is **less total agent token burn for actual bug
reproduction and visual evidence**, with equal verified outcomes and comparable
or better elapsed time. State character reduction is a diagnostic, not the
acceptance metric. A failed or incomplete task cannot count as a token saving.

Two recent Claude sessions were inspected read-only in the local transcript
archive and raw Claude JSONL. No raw customer data, prompts, screenshots, or
credentials are copied into this repository.

| Source | Date / project | Observed workflow |
| --- | --- | --- |
| Claude `251d1ab0-baa2-4541-9c48-f3b00358c8d5` | 2026-09-23 / Mako2 | Age-verification reproduction; product search, keyboard input, repeated navigation and screenshots, DOM probes, independent database assertions |
| Claude `f7cd937e-a3b7-4450-98c0-e58a60974314` | 2026-10-01 / WhiteTip2 | Reservation iframe audit; frame targeting, failed selectors, help lookups, coordinate fallback, console evidence, desktop/mobile screenshots |

Both used `claude-opus-5-5`. Repeated screenshots were often saved by one Bash
call and consumed by a later image Read. A Bash tool call may contain several
CDP commands: command occurrences, agent calls, and inference requests are
different counts. Some recorded commands failed or were retried.

## Historical usage attribution

Deduplicate streamed assistant blocks by `(requestId, message.id)`. All usage
fields agreed across duplicates in these sessions. Never sum usage once per
thinking/text/tool-use block. Keep fresh input, cache creation, cache reads and
output separate; they have different pricing. The cache fields dominate the
recorded token volume, making avoided inference requests a potentially larger
saving than a smaller latest observation.

| Representative analytical window | Unique requests / tool batches | Fresh input | Cache creation | Cache reads | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mako2 active reproduction/evidence, raw JSONL request lines 598–1501 (last tool block 1503) | 54 / 54 | 108 | 41,201 | 7,970,592 | 15,055 |
| WhiteTip2 initial iframe inspection, 542–745 (last tool block 747) | 12 / 12 | 24 | 11,085 | 1,424,872 | 4,159 |
| WhiteTip2 post-change desktop/mobile inspection, 981–1072 (last tool block 1074) | 6 / 6 | 12 | 5,738 | 809,983 | 2,654 |

These windows include the response consuming the final evidence and may include
an adjacent nonbrowser action. They are attribution windows, **not isolated
billing units or counterfactual savings**. Whole-session reported costs were
$4.4174364 and $3.1582204, respectively; those include other work and auxiliary
model usage. They cannot be labeled browser costs or assigned to these windows.
Historical wall-clock spans are request-record timestamps, not exact inference
start/finish times. Do not compare them directly to a fresh fixture stopwatch.

## Sustained agent experiment

`tests/live/claude-workflow.live.test.ts` runs one real Claude CLI conversation
per complete browser task, using the same Opus model and medium effort in all
arms. It controls a fresh private Chrome through a fixture-only MCP bridge.
There is no arbitrary evaluation, shell, database, external navigation, or
production-page tool available to the model.

The controlled journeys exercise history-restoration/cart failure and future
date/age-verification failure. They are transcript-derived surrogates, **not
live Mako2/WhiteTip2 reproductions**. The iframe, scanner and mobile cases remain
separate required real-application follow-up work.

Compare baseline, deterministic projection, deterministic plus Qwen GPU, and
Jev when credentials remain available with identical browser tools. Compare
`deterministic-fused` and `qwen-fused` separately: returning observed state with
each action changes the interaction contract and may eliminate an extra
observe request. Attribute that benefit to fusion, not to Qwen alone.

All structured-tool arms return screenshot pixels in one call. This already
removes the historical screenshot-file/Read split. Therefore this baseline
does not measure that historical overhead; any reported filtering gain is
relative to the same structured-tool baseline.

Success requires the independent action trace, correct final application
effect, final screenshot, console evidence, and a structured report referencing
the matching artifact and actual console error. The agent never receives the
private oracle verdict. Stale source, URL, digest and ambiguous target checks
precede action delivery. Must-keep diff/error/context rules precede filtering.

Record the final CLI aggregate usage once, alongside per-model usage and
reported list-price cost; do not add these overlapping sources together.
Record missing usage and unsuccessful completion explicitly. Count unique
assistant responses, responses containing tool-use blocks, total browser tool
calls, individual tool kinds, retries/expansions, provider calls and latency.
Multiple calls in one response are one tool batch and several calls; execution
is serialized consistently across arms.

Primary comparison: verified successes and total token categories per successful
episode, reported cost per successful episode where available, whole-episode
latency, and actual agent/tool batches. Include failures and timeouts in every
arm's cost totals. Keep startup timing separate. A small controlled pilot informs
further testing; it does not prove savings on the full original coding sessions.
