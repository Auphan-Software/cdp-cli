# Fresh lean-receipt WebSRM benchmark

2026-10-08: ran fresh managed Claude Code contexts, Haiku5.5/medium, CDP then
Anthropic Claude-in-Chrome native. **CDP is materially cheaper than its previous
hard run, but native token parity is not established.** The fresh native attempt
stopped before note/payment, so its short run is not a completed-flow efficiency
baseline. The retained native completed-flow reference remains the comparison.

| Metric | Previous CDP | New lean CDP | Retained completed native |
|---|---:|---:|---:|
| Independent acceptance |6/8 FAIL|6/8 FAIL|6/8 FAIL|
| Processed assistant tokens |1,770,193|1,267,101|981,860|
| Estimated API-equivalent USD |0.11863878|0.03560651|0.02699815|
| Peak request input |128,826|73,130|52,477|
| Requests above100k input |6|0|0|
| Browser calls |21|22|25|
| Model requests |27|31|30|
| Browser response text bytes |172,959|57,783|18,171|
| Historical expansions |3|0|0|
| Actual image blocks |12|12|10|
| Transcript seconds |239.996|229.696|137.886|
| Context compactions |0|0|0|

New CDP consumes28.4% fewer tokens and70.0% less estimated cost than previous
CDP. Response text fell66.6%; it eliminated above100k requests and their pricing
multiplier. There was no context compaction. Compared with retained completed
native, CDP still uses29.1% more tokens and31.9% more estimated cost, despite12%
fewer browser calls. These are costs per failed attempt, not per successful task.
Processed tokens include fresh input, cache creation/read and output; cached tokens
remain part of usage. Pricing is the same pinned2026-10-07 auditor estimate, not
subscription billing. Every actor tool/read/write/discovery/recovery is included;
controller boot, monitoring and independent proof are excluded.

## CDP result and remaining overhead

Installed clean runtime01591444297d9ac5cba83aa2641649d12fc90337 ran the MCP
lean receipt boundary, with no native tools, query, reranker, shell or subagents.
Actual22 browser calls:10observe,11act,1screenshot,0expand. Observations return
usable controls; action/screenshot results omit automatic state dumps. Observations
account for46,643 bytes (80.7% of text), acts10,119 and screenshot1,021. Their
remaining labels/values/source keys are the next efficiency question; shorter
action receipts alone do not remove the cost of rediscovering the next control.
Twelve delivered image blocks still accumulate in history. Additional instruction
reads and recoveries also count;31 model requests vs retained native30.

Counter click delivery was uncertain; the agent recovered one actual invoice
instead of repeating it. A bad Modify selector failed; a stale key was rejected
without delivery. Both recoveries count. Controller independently captured
invoice150396 open/unpaid, then closed with exactly one Pepsi, cash5/change.87,
totals3.59/.18/.36/4.13, accepted ARG WebSRM transaction35, no pending requests,
unchanged fixture/configuration and actual printed-bill parity.

The two failed checks are exact modifier boundary and expected trimmed RQ
description. The agent supplied140 characters instead of141:120a instead of121.
Its actual fill argument exactly equals the persisted note; **no tool truncation**.
Actual printed pixels show Note:, ten rows of12a, then b; accepted precision is
`Note: `+120a+` b`, rather than expected `Note: `+121a. Worker ledger originally
called the UI journey passed with caveats; independent6/8 grading supersedes it.
Original ledger is retained. Printed bill: C:/autoprint/20261008191744.png,
SHA25662f14ee4aa78e379d54810dc671780aa1af1a0300709e2f01d730a7417e1393f.

## Fresh native attempt: blocked, not an efficiency win

Fresh native used the same contract/note bytes, product candidate, DEV database,
cashier, viewport target and Haiku5.5/medium. Effective launch used --chrome and
empty strict MCP config; no CDP workflow tools were exposed. It created its own
Edge tab, reached item Modify, then cancelled without typing a note or paying.
It reported it could not verify the exact repeated-a transcription through its
available Read/browser tools and deliberately stopped before sending payment.

Native used444,831 processed tokens, estimatedUSD0.01916203,15 browser calls,
16 model requests, peak43,232 input,10,884 response text bytes,6 image blocks and
105.941 seconds, with no compaction or above100k request. These numbers are
**partial-attempt cost only**; no CDP/native completion ratio is calculated.
Controller confirms invoice150397 remains open with one Pepsi, an empty note,
no payment/transaction/pending request, no new printed bill and preserved fixture.
The completed-invoice verifier qualifies only fixture preservation (1/8); remaining
checks are unqualified because the journey stopped. Full cashier is visible in
actual native pixels, but its optional jQuery/navAuto read-only JS checks were not
run, so no such technical boot assertion is invented. This is an exact-value
verification limitation/model decision, not evidence that native could not find
the management controls. No follow-up prompt overrode the stop or hid its cost.

## Contract, evidence and limits

One sequential attempt per arm, not randomized statistical proof. Both used fresh
Claude Code contexts, --autocompact250k, Read/Write/ToolSearch, no agents/shell,60
browser calls/10minutes. CDP budgets are enforced by its bridge; native stop
contract is prompt-enforced. CDP was controller-prebooted in owned Chrome; native
performed its own Edge tab/navigation/resize, all counted. Image scales/encoding
and tool schemas differ. Both contracts use localhost/lean-receipt-pair01 instead
of the retained pair's127.0.0.1 URL; their ledger template still named the older
entry, which both workers reported. Business acceptance and141-character note are
unchanged. A normal CDP controller navigation restored full test cashier before
launch, with no auth/config/product patch. No fixtures were changed, refunded or
reprinted. Product candidate remains e7197b53d508068efabf28a45156697b1f21d048.

Raw transcripts, effective launches, bounded budgets, instructions, call/results,
original/corrected ledgers, controller before/after/cleanup, bill review and proof
are retained under C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/lean-receipt-pair-01
in separate cdp/native directories. Moderate metrics/identities/proofs are versioned
in lean-receipt-pair. All11 hard-verifier regression checks pass. Both completed
workers are stopped; tracked Blink terminal413dcf58/session2067/work-item8508,
owned browsers, worktree/database, paid CDP sale and unpaid native fixture remain.

The trim works: smaller delivered responses reduce real full-attempt token/cost
usage without removing cash/RQ/printed-proof behavior. It has not solved exact
literal entry or shown native parity. Keep cdp-cli-kxp for artifact-backed exact
fill/readback and cdp-cli-15b for efficient next-control discovery. A fresh native
completed-flow comparison remains required before asserting paired parity; do not
compare the blocked arm's444k usage with the completed CDP sale as a speedup.
