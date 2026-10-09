# Control discovery: native baseline and reviewed optimization plan

Reviewed 2026-10-08 by an independent engineering critic and a fresh, managed Claude Opus 5.5 critic (Jarvis item 8508, session 2067). This is a design review and recorded-data replay. No runtime behavior or installed build changed.

## What native actually did

The retained completed native attempt made 25 browser calls: 10 screenshots, 9 coordinate clicks, 1 type, 1 JavaScript execution, and 4 setup calls. It used neither `find` nor `read_page`. Its baseline is screen-guided targeting, not a compact semantic control list. See [exact action counts](control-discovery-review/native-workflow-baseline.json).

The current CDP attempt made 22 browser calls, including 10 observations and 11 actions. Those observations delivered 438 records. Fewer browser calls did not mean fewer model requests or smaller accumulated context. Both completed attempts failed the exact-note requirement (6/8); the fresh native attempt was blocked before completion. These traces diagnose discovery overhead; they do not establish successful-task parity or a causal token reduction.

## Verified findings

1. **The output cap runs on the wrong representation.** Rich compact results are bounded to 8 KB before the MCP receipt discards metadata. Canonical-artifact comparisons confirmed budget omissions, including 9 visible button records across three observations. A combined omission count reaches the model, but it does not separate budget omissions from projection pruning. All ten observations still reported ready. Readiness must not be interpreted as exhaustive discovery. See [capture comparison](control-discovery-review/canonical-discovery-coverage.json).
2. **Fresh keys force rediscovery after actions.** Action receipts return a new source without new controls. Keys are scoped to their original source. Reusing a key with the new source is rejected; using its old source is stale. This protects against wrong actions, but prompts another observation even when a control is already visible and recognizable. Two attempts to avoid observing failed. We must preserve the protection while providing a cheaper targeting path.
3. **Lossless representation changes are measurable but secondary.** A replay of the delivered observations changes the 8-byte namespace from hex to base64url and declares weak key quality once, retaining explicit strong exceptions. It preserves every record's evidence and round-trips all 438 references. Observation JSON falls from 43,118 to 36,584 bytes: 6,534 bytes, or 15.15%. Against all 57,783 browser-text bytes this is 11.31%. This is neither measured model tokens nor the full production pipeline: removing upstream overhead may refill the budget with additional controls rather than shrink responses. See [replay](control-discovery-review/representation-replay.json) and `replay-discovery-representation.mjs`.
4. **Context and masked values are not the main waste.** Context arrays total 799 bytes; state objects 1,507; masked values 1,325. Preserve useful context, state, privacy, and value-equality evidence. Do not remove them wholesale.
5. **Existing text targeting needs scope fixes before workflow exposure.** The CLI supports deterministic text clicks, but `within` picks the first matching container, and the top-document ancestor promotion can escape that container. Exact text means trimmed descendant text, not accessible-name matching. Frame, shadow, hidden, disabled, and unnamed-control behavior must be documented and tested explicitly.

## Implementation order

### 1. Correct the presentation budget and disclose coverage

Keep the full canonical capture and rich diagnostic artifact. Bound the representation actually delivered to the model, rather than discarded metadata. Separate `budgetDropped`, projection pruning, and any future scope exclusion. Include a concise incompleteness signal; preserve frame warnings, uncertainty, and global blockers. Do not turn readiness into a coverage guarantee or expand action receipts automatically.

Replay all ten canonical captures through the complete projection/format/bound/receipt pipeline. Verify essential controls, deterministic ordering, final byte limits, omission accounting, unchanged execution evidence, and existing full/expand behavior. Measure delivered rows and bytes before claiming savings.

### 2. Remove redundant representation safely

Use equal-entropy base64url namespaces and a versioned weak-quality default with explicit exceptions. Keep the namespace on every reference. Propagate representation/default declarations through the receipt; retain old reference compatibility and unambiguous decoding. Test stale references, cross-source references, expired/restarted state, and shifted ordinals. Never replace references with bare ordinals or reduce namespace entropy to a short live-only nonce.

Evaluate default role/envelope compression on recorded captures before adding another serialization syntax. A byte reduction is only a candidate: Haiku's targeting accuracy and total model usage decide whether it stays.

### 3. Reduce the need to enumerate again

Evaluate two explicit paths separately:

- **Deterministic exact-label click:** expose the existing text executor through the workflow only after requiring exactly one scope container and rejecting ancestor targets outside it. Require exactly one selector, reference, or text target. Preserve ownership, current-source validation, hit testing, disabled/hidden refusal, and dispatch uncertainty. No semantic query, reranker, regex, fuzzy match, forced click, or arbitrary first match. Unknown or unnamed controls fall back to discovery.
- **Opt-in next controls:** allow an action to request a small, explicit follow-up discovery result using its fresh source. Preserve the full canonical capture and disclose excluded controls. This can remove a model round trip without restoring the old automatic state dump. Do not rely on ARIA dialog roles: this application's overlays did not provide them in this trace.

Test duplicate labels, missing/duplicate containers, ancestor escape, disabled/occluded targets, frames/shadow roots, source mismatch, unnamed controls, and post-dispatch wait failure. Compare exact-label and next-controls variants against the corrected compact baseline independently; avoid bundling changes that hide which one helps.

### 4. Benchmark successful journeys, then hard Web-SRM

First use a matched discovery journey with known visible text, icon-only confirmation, overlay navigation, and management iframe navigation. Use fresh Haiku contexts, identical task contracts, fixtures, limits, model/effort, and installation verification. Independently verify effects and refused actions. Then run the hard Web-SRM contract with exact artifact text handled by the separately tracked text-integrity work (`cdp-cli-kxp`). Do not silently weaken the original task to make a discovery result pass.

Report total model input/output/cache usage, estimated cost, requests, browser calls, text bytes, images, recovery requests, completion, and target correctness. Retain failed attempts. Repeat paired runs before asserting parity. One added recovery request can erase a substantial output reduction; bytes alone are insufficient.

## Deferred proposals and critique reconciliation

Do not initially implement cross-source key carry-forward, history-dependent deltas, or coordinate execution. Matching role/name/geometry is not proof of the same physical control after DOM reordering; frame and screenshot alignment also need stronger evidence. Region scoping remains a presentation experiment, not a reason to weaken canonical capture or executor checks.

The Opus report is preserved verbatim in [claude-critic.md](control-discovery-review/claude-critic.md). Its approximate shares and token-saving estimates are hypotheses, not measurements. Primary verification corrected its native click count to 9, confirmed source equality between installed and HEAD, and confirmed budget omissions. Its description of truncation as "silent" is too strong: a mixed omission count is present, while the budget-specific distinction is absent. Its proposed shorter low-entropy nonce is not adopted. The independent critic's findings and follow-up are summarized in [independent-critic.md](control-discovery-review/independent-critic.md).

## Reproduction and lifecycle

Run `node evals/browser-gym/replay-discovery-representation.mjs <retained-parsed-tool-results.json> [output.json]`. Input is the parsed tool results from `lean-receipt-pair-01/cdp`, not raw transcript lines. The script performs no browser actions and explicitly labels model tokens unmeasured and runtime unimplemented.

The Opus critic completed its report and its exact owned worker was stopped. Its tracked terminal, transcript, worktree, and browser fixtures remain preserved. No new payment, refund, reprint, or application configuration mutation occurred during this review.
