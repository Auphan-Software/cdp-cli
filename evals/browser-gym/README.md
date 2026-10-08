# Mako2 browser gym: optimize verified completion cost

Status: accounting, evidence contracts, readiness validation and seven-case catalog implemented;
**local cash fixture and independent SQL/RQ/bill adapter are implemented; one Haiku cash pilot
passed all seven independent checks. Remaining six fixture adapters and controlled ablations
still need measured results**.
Tracked by `cdp-cli-8n1`. The accounting commands do not launch a model or mutate a Mako2 database.

See [official Anthropic research and its implementation implications](anthropic-haiku-guidance.md)
for browser tool contracts, effort, steering, compaction and cache behavior.

## What the existing measurements establish

On 2026-10-08, exact Haiku 5.5 at medium effort completed the owned local cash-pepsi journey
on product `e7197b53d508068efabf28a45156697b1f21d048` using tool build
`0e70cc0c7014`, reranker off, current 24k output and a supported 250k compaction window.
Invoice 150376 has one accepted RFER/ARG/FAC transaction, one $5 cash payment, $0.87 change,
no pending request, and independently reviewed bill lines/taxes matching the payload.
The original qualification invoice 150375 still has a retained failed pending request; it
does not count as this passing pilot or disappear from setup evidence.

| Attempt | Outcome | Browser calls | Recorded assistant tokens | Compactions | Cost evidence |
|---|---|---:|---:|---:|---|
| 80k launch | Claude Code rejected configuration before model startup | 0 | 0 | 0 | no model run |
| 100k window | stopped by compaction-thrashing guard before journey | 0 | 336,066 | 3 | assistant subtotal $0.03066541; native session report $0.047647615 |
| 250k window | independently verified cash pilot, 7/7 checks | 3 observe + 5 act | 2,778,059 | 0 | assistant estimate $0.23496009; native session report $0.24548669 |

These are Claude Max runs; amounts are API-equivalent estimates/native reports, not actual bills.
The successful run took 142 seconds across recorded assistant requests, peaked at 188,938
request input tokens and crossed Haiku's 100k pricing tier on 13 of 21 requests. Source chaining
had zero mismatches. The worker correctly avoided repeating a delivered item after a failed wait
and a delivered payment during an unfinished transition. It made one extra setup preflight
attempt before initializing the ledger, which remains counted.

Native session usage exceeds recorded assistant usage in both attempts. Failed-run compaction
generation is absent from assistant iterations, so a full independently priced failed-run total
is unavailable. The sum of native reports for the two model attempts is $0.293134305 for one
verified completion, excluding Codex supervision and fixture qualification. Do not use the
successful assistant subtotal alone as whole-experiment cost. Native reports remain supplemental.
This proves a bounded Haiku success and a compression failure; it does not establish savings
against a matched model/tool baseline or reliability on the six hard cases.

Raw native snapshots, controller proof, bill review and score remain in
`Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/`; they are not committed as training data.

The 2.2.3 formatter replay reduced two saved Add/Done responses from 124,815 to 47,732 UTF-8
bytes (61.76%), retaining current controls, source and delivery metadata. That proves transport
reduction, not lower model cost or better task completion. The later Sonnet smoke successfully
reused a returned stale recovery source but failed login, searched outside scope and was stopped.
Its child peaked at 63,911 input tokens per request and recorded **zero native compaction boundaries**.
It therefore says nothing about whether Claude conversation compaction works or helps a long journey.

Three different mechanisms must be measured separately:

1. Canonical DOM capture: default 2,000 elements, coverage preserved. Keep constant across arms.
2. Tool-view projection and transport packing: task pruning/reranking, diff and 24,000-byte output.
3. Conversation compaction: Claude/harness summary and context renewal. Count actual compact_boundary
   records and verify retained obligations after renewal; a configured threshold is not proof of use.

The installed workflow skills drifted back to the old main-checkout version on 2026-10-07 while
the browser-QA profile retained the 2.2.3 loop. Readiness rejects differing skill hashes. Pin binary,
MCP schema, instruction digest and product candidate before an arm. Do not overwrite another
agent's live build or silently switch its model.

## Economics and experiment order

Use exact `claude-haiku-5-5`, initially medium effort. High is the second Haiku arm for difficult
cases; Sonnet 5.5 medium is the quality control. Model IDs, effort and actual runtime must be proven.
Do not infer a model from the `haiku` alias. Keep a deterministic supervisor where possible; a
large Sonnet parent repeatedly reading context can erase much of the cheap worker's advantage.
Include supervisor, setup, failed attempts, verifier, recovery and compaction costs in reports.

Primary score: total estimated API cost of all attempts / independently verified successes.
Report pass rate, false passes, elapsed p50/p95, intervention count, request peak, tool failures,
source-chain violations, expansions and bill-evidence completeness. With no successes, cost per
success is unavailable, not zero. Claude Max runs have API-equivalent estimates, not actual bills.

Current rates, USD/M tokens, checked 2026-10-07:

| Model/request input | Fresh input | 5m write | Cache read | Output |
|---|---:|---:|---:|---:|
| Haiku 5.5 <=100k | .10 | .125 | .01 | .50 |
| Haiku 5.5 >100k | .50 | .625 | .05 | 2.50 |
| Sonnet 5.5 | 2.00 | 2.50 | .10 | 10.00 |

One-hour writes use 2x the corresponding base input rate. The 100k Haiku tier applies to each
request's total input, including cached tokens; 1M context capacity is not a 1M cheap tier.
The auditor handles per-request pricing, native stream deduplication and cache TTL categories.
It counts `usage.iterations` for compaction even when top-level counters are zero, without adding
the top-level totals again. Multi-phase or unattributed cache usage makes price unavailable until
verified billing attribution exists; it is never silently priced as free.
Unknown TTL is explicitly estimated as 5m; unknown models make cost unavailable. Refresh rates
when launching a later benchmark. Cost alone never overrides false-pass or evidence failures.

Run stages, rather than a giant Cartesian matrix:

- **Fixture qualification, no model:** provision a dedicated Jarvis-managed Mako2 worktree and
  seeded local database; pin candidate and fingerprint. Prove the exact cashier login in a fresh
  cookie context, correct role, SPA runtime, RQ DEV certificate, receipt sink and verifier. An
  employee ID is not a password. Retain source backup/seed contract without storing secrets.
  Missing fixture evidence blocks model launch. The original `rq-03201-websrm-correction` worktree
  was absent when this scaffold was created; never reuse its stale URL/DB assumptions.
- **First pilot:** cash-pepsi, Haiku medium, current-24k. One completed run must satisfy DB, RQ,
  printed-bill pixels and line/tax parity. A QR JPEG is not a bill. Stabilize harness before trials.
- **State-view ablation:** current-24k versus a proposed richer semantic view (e.g. 64k transport)
  with explicit source-bound targets, labels/parents, modal state, amounts and local effect evidence.
  `CDP_WORKFLOW_VIEW_PROFILE=rich-64k` enables the experimental 64k transport with a 48k
  reservation for protected current state. Default `current-24k` retains its 16k reservation.
  Only transport packing changes; source capture, action delivery and canonical evidence stay
  the same. Both fitting and bounded results report their profile and maximum bytes. Preserve
  delivery uncertainty, coverage, capture cap and complete artifacts identically. Compare with
  reranker off first; test reranker separately after finding a useful view.
- **Context ablation:** selected view, same model/effort; compare supported context renewal
  versus no renewal on a long Web-SRM journey. Native request peaks drive the budget, including
  shared tool/system instructions. Record compaction generation and cache rebuild cost. Check
  retained cashier, invoice/txn IDs, delivered-payment state, certificate alterations, pending
  obligations and cleanup after compaction. Never repeat payment because its history was summarized.
  The existing 250k Jarvis default can cross Haiku's expensive tier before compaction.
  Installed Claude Code 2.1.294 rejects an 80k threshold and accepts a minimum of 100k. The
  100k pilot compacted three times before browser work; the 250k pilot completed cash, but
  crossed the expensive tier. Neither establishes an optimal threshold. An 80k API/on-demand arm needs a separately implemented
  controller; a Jarvis field accepting the value does not establish runtime support.
- **Hard-case pilot:** all seven cases in cases.json, Haiku medium/high plus Sonnet control, initially
  three runs per promising arm in randomized order from equivalent snapshots. Expand trials for
  inconclusive reliability; do not claim statistical certainty from three runs. DEV RQ responses
  are external/non-rewindable: unique txn IDs and record service health. Never replay original IDs.
- **Held-out regression:** reserve an unseen fixture/order and failure variant; don't tune prompts
  against every scored case. Promote only after zero observed false passes and complete fiscal
  evidence on required cases. This is a release gate, not a statistical proof of zero future risk.

## Tool improvements to prioritize

Haiku should receive more useful information per action, not an unexplained stream of terse keys:

- Resolve a returned target key against its exact source server-side; do not ask the model to
  invent nth-child CSS from structural keys. If it cannot be resolved uniquely, reject before delivery.
- Keep meaningful labels, amounts, modal context, current error and the observed postcondition close
  to each action receipt. Avoid ambiguous top-level success after a failed wait; distinguish delivered,
  not delivered and unknown from effect verification.
- Offer a richer view experimentally before changing the production default. Images remain a first
  class option for bills and visual ambiguity; retain canonical expansion for omissions.
- Maintain a small machine-readable journey checkpoint outside the conversation. Store IDs,
  verified milestones, pending evidence, mutations to restore, and latest source; invalidate the
  source after external changes/renewal and reacquire state. Never persist credentials there.
- Enforce wall-clock/action/recovery budgets in the controller. A prompt or queued SendMessage is
  not a kill switch. Cap a blocked login at one documented recovery, then cancel the worker task.
  Grade the unexpected stop and failed attempt rather than excluding it to make costs look better.
- Deliver human steering as actual user input, not embedded tool-result text (Haiku guidance calls
  out this injection-boundary issue). Test stop delivery explicitly before a long run.

## Runnable accounting and readiness

```sh
node --test evals/browser-gym/gym.test.mjs
node evals/browser-gym/gym.mjs preflight evals/browser-gym/fixture.example.json
node evals/browser-gym/gym.mjs audit /absolute/path/to/native-transcript.jsonl
node evals/browser-gym/gym.mjs score /absolute/path/run-a.json /absolute/path/run-b.json
```

The example preflight intentionally exits 2. It validates recorded attestations and local skill
identity; it does not itself log in, query SQL, inspect certificates or prove receipts. A future
fixture adapter must generate the attestations from those checks, not flip flags by assumption.

A scored run has this structure; artifact paths must be absolute, and supervisor/native records
are included separately. Independent proof must come from the verifier, never the browser worker.
The cash adapter below requires a separate controller review of actual bill pixels;
role labels alone are not a security boundary. Negative and hard-case adapters now exist below;
their fixture recipes and UI journeys still require actual qualification.

```json
{
  "model": "claude-haiku-5-5", "profile": "current-24k", "caseId": "cash-pepsi",
  "candidate": "pinned-sha", "fixtureFingerprint": "snapshot-and-seed-hash",
  "workerClaimedPass": false, "blocked": false,
  "transcripts": [
    {"path":"/absolute/worker.jsonl","role":"worker","model":"claude-haiku-5-5"},
    {"path":"/absolute/parent.jsonl","role":"supervisor","model":"claude-sonnet-5-5"}
  ],
  "proof": {
    "verifier":"independent", "caseId":"cash-pepsi", "candidate":"pinned-sha",
    "fixtureFingerprint":"snapshot-and-seed-hash",
    "checks":[{"id":"boot-role","passed":true,"artifacts":["/absolute/boot-role.json"]}]
  }
}
```

Every required check in cases.json needs real artifact paths. The incomplete example cannot pass.
Negative cases are successful tests when the intended refusal/non-mutation is proven. Planned fault
drills include stale UI, failed wait after delivered payment, wrong password and missing bill sink;
the grader must distinguish product failures from fixture/harness failures without hiding either cost.

## Cash fixture verification

`mako-evidence.mjs` reads the dedicated local fixture database and pins the product candidate.
After independently reading the actual bill pixels, the controller records its invoice/transaction,
line items, tax totals and image SHA256 in a bill-review JSON. Supply an independent boot record
and that review to collect persisted payment, all RQ transactions and pending requests:

```sh
node --test evals/browser-gym/mako-evidence.test.mjs
node evals/browser-gym/mako-evidence.mjs /absolute/fixture.json INVOICE_ID /absolute/artifacts /absolute/boot.json /absolute/bill-review.json
```

Exactly one accepted transaction and one matching payment are required; a reprint or pending
request cannot quietly qualify as a clean cash run. This adapter does not automate image reading.
MCP opt-in `CDP_WORKFLOW_MAX_ACTIONS` and `CDP_WORKFLOW_DEADLINE_MS` gate mutations before
dispatch; observation/expansion remain available to preserve evidence after exhaustion. A separate
controller watchdog is still required to bound the worker process and its other tools.

## Short worker contract

See worker-prompt.md. Use only inherited observe/act/expand/screenshot plus bounded fixture/verifier
tools once those adapters exist. Keep repository search, service repair and old transcripts out of the
operator toolset, not just out of the prompt. No implementation agent nested under the QA lane.

## Host behavior and matched cash evidence

See [matched-cash-results.md](matched-cash-results.md). Both business journeys passed seven
independent checks. The 24k run's stale receipt was truncated by Claude's MCP-error handling,
so its transport attestation is incomplete; do not promote it to a clean matched baseline.
The 64k run offloaded one result to a file and required three extraction calls. Preserved,
hash-pinned `transcripts[].persistedResults` entries allow the auditor to recover that exact
receipt without guessing truncated state. Missing artifacts remain unavailable.

Expected stale no-dispatch outcomes and execution-budget refusals now use normal MCP text
with explicit `success:false`, delivery fields and recovery instructions. Unexpected errors
remain MCP errors. CLI failure status is unchanged. Agents must inspect the receipt, not
equate a normal MCP transport response with a completed action.

`launch-gate.mjs fixture.json launch.json` checks the clean build, pinned project skill, prompt,
MCP runtime/profile/budgets, product candidate and model/effort/window before Jarvis admission.
Its caller must stop on any nonzero exit; PowerShell does not do that automatically for native commands.

## Remaining case adapters

`mako-negative-evidence.mjs` reads scoped invoice/payment/pending/transaction snapshots and
hashes the complete bill sink. Expiry recipes use compare-and-swap on only the dedicated
station's expiry timestamp. The payment refusal can commit the payment and CLOSE pending row;
do not expect an unchanged unpaid invoice or retry payment. Delete refusal preserves invoice,
sales, payments and pending rows. Controller DOM, pixels, boot and exact restoration are required.

`mako-hard-evidence.mjs` covers zero netting, long modifier truncation, the no-printable-item SOB
fallback and invalid tax identity. It selects the current invoice transaction, requires actual
controller bill/boot review and restored fixture identity, and offers scoped CAS recipes. These
are verifier implementations with unit and read-only SQL checks. Long modifier and expired
deletion additionally passed real managed Haiku qualifications (below); the other four cases are unproven.

## Long modifier qualification

Managed agent2048 on source build1b1530e completed invoice150379 with one Pepsi and the141-character
item note. The controller captured an unpaid baseline before authorizing one cash payment,
then verified all eight checks: persisted note, single matching cash payment, accepted ARG transaction16, exact127-character
trimmed description and printed-bill parity. The bill's repeated a glyphs were counted from pixels
(ten rows of twelve plus one), rather than assumed from SQL. Missing boundary-tail text is expected.

All three native epochs are retained:6,321,400 recorded tokens,72tools,USD0.496206 recorded-assistant
estimate /0.519919 supplemental native report. There were two Jarvis context renewals and zero
native compactions, source mismatches or unavailable receipts. These costs include both phases,
failed wait/input correction, renewals and completion reporting; Codex/qualification costs are excluded.

The first verifier attempt rejected Windows backslash versus forward-slash spellings of the same
image. Absolute path normalization fixed the verifier; regression tests reject unchanged/different
files. Initial5/7 and repaired7/7 outcomes are recorded separately; the strengthened eight-check
contract also passes8/8. Original artifacts and accounting:
`Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/long-modifier-current-01/`.

## Expired deletion attempt and exposed click recovery

Managed Haiku2049 created one committed unpaid Pepsi invoice150380, but could not reach the
Customer Failed To Pay guard. A development reload control covers the center of More while
leaving its left/bottom exposed. The original click implementation rejected that center;
three refused More attempts, reload and Escape did not complete deletion. Independent proof
passes five checks but fails the required expiry dialog. This is a failed journey, not a pass.
The controller restored the exact station expiry and retained the unpaid invoice.

All seven native epochs are retained, including the final session missing from stale telemetry:
8,545,115 recorded tokens,105tools,17workflow calls,zero native compactions,USD0.611522 recorded
assistant estimate. Six supplemental native reports totalUSD0.625172; the seventh is absent,
so that subtotal is not a complete native total. Codex/qualification cost is excluded.
Checkpoint successors repeatedly replayed an obsolete handoff action. The operator contract
now removes completed handoff requests and distinguishes browser source IDs from Git commits.

Top-document clicks now test a bounded interior grid after a blocked center and dispatch only
at a point that actually hits the requested target or its descendant. Full occlusion is still
refused. Explicit force, child-frame clicks and drag retain their center behavior; force does
not override the post-dispatch delivery witness. Four new browser controls cover mouse/touch,
full occlusion/force, ordinary/clipped/shadow targets and drag remeasurement. Existing source-key
and contract browser regressions pass. Full unit validation:495passed/9skipped; line coverage
60.55%, below the repository's80%target.

Fresh Haiku2050 on clean sourcee97788e then reached the expired deletion guard in four delivered
clicks on the retained unpaid invoice150380. Independent DOM/pixel/SQL/bill-sink evidence passed
all six checks; the controller restored the exact expiry. One native epoch recorded2,723,726tokens,
30tools,8workflow calls,USD0.211910 assistant estimate /0.222048 complete native report,zero native
compactions/source mismatches/unavailable receipts. Both setup and retry total11,268,841recorded
tokens andUSD0.823432assistant estimate for this verified journey. The retry did not recreate the
invoice and changed both the tool and prompt, so it is not a matched savings experiment.

Raw attempt/proof/accounting: `Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/expired-delete-current-01/`.
Retry and failure-inclusive run: `Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/expired-delete-current-02/`.

Sources: [Haiku launch and rates](https://www.anthropic.com/claude-haiku-5-5),
[Haiku prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5),
[Haiku changes](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5).

## Expired payment and no-printable item on source e97788e

Haiku2053 exercised Pay then Cash $5 on retained invoice150380 with an expired station
certificate. Independent proof passed6/6: visible expiry refusal, no new RQ transaction or
printed bill, preserved sale, expected committed payment/pending CLOSE and exact expiry restore.
One epoch recorded1,506,785tokens,25tools,3workflow calls; assistant API estimate USD0.103973,
complete native report USD0.111555. Shared invoice creation is accounted in2049, not this worker.

Haiku2054 created invoice150381 with Water3651 priced zero and marked non-printing. Five browser
actions closed it without inserting a payment. Independent proof passed6/6: accepted current
RQ AUC transaction17, exactly one SOB fallback item, printed zero-dollar AUCUN PAIEMENT bill,
correct role/boot and exact Water price/print-flag restoration. Actual bill is
C:/autoprint/20261008024248.png, SHA2565b8bc96ba83ddceca1af24a4ca104427839a2b486c5bb292f10faf46e95743f2.
The worker's own bill lookup searched filenames for the invoice ID and found none; timestamps
name these files. Controller manifest comparison and pixel inspection supplied the missing proof.
Its transportProfile field incorrectly described headless browser mode; native receipts independently
confirm current-24k. Two epochs recorded3,586,887tokens,38tools,8workflow calls, USD0.274837assistant
estimate /0.286980complete native report; no source mismatches or unavailable receipts.
The additional new bill20261008024303.png belongs to invoice150380: its prior pending transaction
retried automatically after certificate validity was restored. No manual resend was performed.
Both workers had zero native compaction boundaries. These successes do not establish savings from
conversation compression. Zero-total netting and invalid-tax identity remain unverified.
Raw evidence/accounting: Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/expired-pay-current-01/
and Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/no-print-current-01/.
