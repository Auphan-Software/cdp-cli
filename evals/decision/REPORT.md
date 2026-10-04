# Decision-provider evaluation — 2026-10-03

Adopt deterministic compact views and explicit semantic effect verification first.
Keep Jev optional. These experiments show that the proposed boundaries can work,
but do **not** show that Jev filtering or action selection earns its latency/cost.
No key was available through the project/environment secret mechanism, so the
endpoint was contract-tested with mock HTTP; no credential-backed requests ran.

## Measured results

Real private Chrome, 12 controlled tasks, three repeats, randomized arm order.
396 executions; 36 runs per arm/granularity. The same scripted downstream selector
and exact DOM executor are used throughout. These are fixture decision/verdict
scores, **not** LLM browser-agent completion rates. Repeats are deterministic and
are not 36 independent examples. Raw paired records are in `results/synthetic.json`.

| Arm | Mean view bytes | Paired reduction | Next action | Fixture verdict | Mock calls/run |
|---|---:|---:|---:|---:|---:|
| Full contextual view | 31,135 | — | 36/36 | 36/36 | 0 |
| Deterministic pruning | 21,273 | 31.68% | 36/36 | 36/36 | 0 |
| Mock filtering: nodes | 2,160 | 93.06% | 33/36 | 30/36 | 22 |
| Mock filtering: chunks | 2,772 | 91.10% | 36/36 | 36/36 | 2 |
| Mock filtering: regions | 13,142 | 57.83% | 36/36 | 36/36 | 1 |
| Mock filtering: hybrid | 2,160 | 93.06% | 33/36 | 30/36 | 13.83 |
| Mock action selection only | 31,135 | 0% | 36/36 | 36/36 | 1 |

The unaugmented captured PageState averages 26,962 bytes. Deterministic views are
about 21% smaller than that raw capture; the table's 31.68% comparison includes
the same contextual hints in both agent views so selection receives equal evidence.

Filtering plus action selection has the same view size, next-action accuracy and
verdict accuracy as filtering alone, with one additional mock call per run.
Node/hybrid filtering hides important evidence in 6/36 runs: three missing
synonym targets plus three missing diagnostic clues. There are zero wrong-target
clicks across the 396 executions; missing targets produce a safe handoff, but
the hidden diagnostic clue would allow an incomplete QA verdict.

Chunks and regions preserve those clues **incidentally** because the deliberately
weak lexical provider keeps nearby “Orderbook” text. Change layout or wording and
that protection may disappear. This is a granularity stress test, not evidence
that chunks are a generally safe Jev default. The region arm retains a whole
inventory region because of one matching line; the hybrid second pass recovers
compression but also recovers the node-level false negatives.

Local projection p95 in the reference run is roughly 1.3–3.9 ms depending on arm.
These are local transformation/mock times, excluding capture, network latency,
endpoint inference and agent reasoning. Node filtering simulates ~22 batched calls
per task versus one for region filtering. Six questions per request is this
adapter's batching policy, not a claimed first-party API limit; larger batches
are another unmeasured ablation. Actual Jev latency/cost, calibrated
thresholds, provider tokens, downstream LLM calls/tokens, and total agent steps are
unmeasured. Bytes/4 estimates in the raw records are not billed tokens. The
coarse-view result cannot answer the total-token question because the provider
must itself receive evidence, and expansion can add turns/context re-reading.

## What worked

- Deterministic pruning retained all fixture targets/clues while removing ~32%
  of the contextual view. Repeated “Edit” buttons remain distinct by row context.
- Hostile all-drop providers cannot remove the unit tests' changed/removed
  evidence, errors, dialogs, live messages, focus, values, selections, known
  targets, task matches or represented ancestor context.
- Invalid selections, a malformed later batch and provider failures restore the
  deterministic view; call/time budgets bound the optional Jev adapter.
- Expansion retrieves omitted nodes from the original snapshot without mutating
  it. Snapshot/session mismatches and unknown expansion keys are rejected.
- Real Chrome stale-key recovery succeeds after renaming Beta's control. A second
  equally matching candidate produces an ambiguous handoff. Weak identities,
  changed same-key semantics, wrong frames and incomplete coverage are rejected.
- The 11 actionable cases per repeat deliver clicks successfully. Semantic effect
  verification passes nine and rejects the delivered no-op and pre-existing
  “Saved” control. One ambiguous case hands off without execution. This measures
  the experimental helpers, not a new end-to-end actions/1 replay implementation.

## What did not earn adoption

- Fine-grained relevance filtering can lose a target named “Save” for a “Commit”
  task and an unchanged “Account frozen” clue for a removal task. Deterministic
  must-keeps prevent specified losses, but cannot enumerate every useful clue.
- Node-level decisions multiply calls. Hybrid reduces some calls but adds a
  second pass and does not fix fine-grained evidence loss.
- Mock action selection added a call and no improvement over the same scripted
  selector. Real Jev action quality remains unknown.
- A semantic name transition is only a witness. It does not prove the correct
  business state persisted, the right amount changed, or a visual defect vanished.
- Learned filtering cannot repair the current capture's missing transient alerts,
  event windows, truncated text or inaccessible frames. Keeping all exposed
  console/network errors is supported; collecting them is still separate work.

## Recommended pipeline

1. Deterministic replay with reviewed selectors/parameters and explicit semantic
   transitions; do not call command delivery a verified business outcome.
2. Fresh capture and strong exact semantic identity, then unique contextual
   relocation for a stale identity. Ambiguity never gets a fuzzy/ordinal guess.
3. Deterministic compact view, full diff/error/coverage evidence and recoverable
   canonical snapshot. Batch observations equally across all comparison arms.
4. Optionally try a **bounded** Jev action choice after candidate discovery, only
   after held-out confidence/margin calibration demonstrates a gain. Keep this
   disabled by default. Region filtering is the lower-call experimental starting
   point; learned filtering should not be the default diagnostic observation.
5. Hand off discovery or uncertain lightweight navigation to Luna/a cheap browser
   agent with full protected evidence and an expansion path. Escalate persistent
   semantic mismatches, errors, incomplete coverage, ambiguity, visual-only tasks
   and suspected product bugs to stronger diagnosis/coding with pixels/events/
   persistence evidence as appropriate.

Stages 4–5 are recommendations to evaluate, not measured Jev/Luna/strong-agent
handoff frequencies. The controlled selector needs no provider on these tasks:
11/12 choose a unique action, one hands off; two of the delivered actions fail the
semantic-effect check. Do not extrapolate this rate to restaurant QA journeys.

## Concrete changes and validation

New isolated provider interface, compact agent view, deterministic safeguards,
four relevance granularities, expansion and bounded proposal validation in
`src/experimental/decision.ts`; optional first-party Jev HTTP adapter in `jev.ts`;
semantic descriptor/relocation/fresh-proposal/effect helpers in `replay.ts`.
Only opt-in capture metadata touches shared code. Current CLI defaults and the
actions/1 journal format remain in place.

New focused unit safety/wire tests and a controlled browser eval preserve useful
failure cases even though fine-grained filtering loses. Existing seven-case diff
fixture was also rerun successfully (three repeats each). Build, coverage and full
live-suite results are recorded in the review handoff.

Validation: `npm run build` passed; `npm run test:coverage` passed with 421 tests
and nine skipped (58.26% repository line coverage, 98.61% experimental-module
line coverage). The existing configured coverage floor passes; the repository's
aspirational 80% target remains the pre-existing `cdp-cli-yr7` follow-up. The full
private-Chrome suite passed 40 tests, with two optional cases skipped. The final
396-execution metrics run and 16 focused safety/wire tests passed separately.

## Follow-up experiments

- `cdp-cli-d1p`: credential-backed Jev versus deterministic providers, then equal
  Luna/Sol browser-agent arms on held-out realistic journeys. Measure false passes,
  important-evidence recall, expansions/retries, provider plus downstream tokens,
  cost and end-to-end latency. Calibrate rather than trusting confidence values.
- `cdp-cli-7li`: opt-in versioned journal descriptors and recorded from/to effect
  witnesses, including appeared/gone anchors and reload persistence.
- Existing `cdp-cli-7sz`: complete the real Mako2 agent A/B and capture-cost work;
  `cdp-cli-uck`: action-scoped console/network evidence; `cdp-cli-d96`: capture
  privacy/expiry. These prerequisites should not be hidden by a relevance layer.
- Add held-out randomized wording/layout, long-tail text, closed/cross-origin
  regions, transient alerts, failed fetches, visual-only defects and real multi-step
  expansion behavior. A tiny repeated fixture cannot establish production safety.

The TesterArmy concepts above are evaluated from the supplied requirements.
Its source was not available, so no claims about its actual implementation are made.
