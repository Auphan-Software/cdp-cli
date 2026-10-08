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
  The wider profile is **not implemented**; mark profileImplemented=false until it exists. Preserve
  delivery uncertainty, coverage, capture cap and complete artifacts identically. Compare with
  reranker off first; test reranker separately after finding a useful view.
- **Context ablation:** selected view, same model/effort; compare supported context renewal
  versus no renewal on a long Web-SRM journey. Native request peaks drive the budget, including
  shared tool/system instructions. Record compaction generation and cache rebuild cost. Check
  retained cashier, invoice/txn IDs, delivered-payment state, certificate alterations, pending
  obligations and cleanup after compaction. Never repeat payment because its history was summarized.
  The existing 250k Jarvis default can cross Haiku's expensive tier before compaction.
  Installed Claude Code 2.1.294 rejects an 80k threshold and accepts a minimum of 100k. The
  managed pilot therefore uses 100k. An 80k API/on-demand arm needs a separately implemented
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
role labels alone are not a security boundary. Other case adapters remain unimplemented.

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

Sources: [Haiku launch and rates](https://www.anthropic.com/claude-haiku-5-5),
[Haiku prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5),
[Haiku changes](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5).
