# Why fewer CDP calls consumed more tokens

2026-10-08 forensic comparison of retained native invoice150393 versus installed simplified CDP invoice150395. No additional model benchmark was run. Deduplicated assistant-message usage and tool-result blocks reconcile to both previous totals.

**The main cause is verbose state returned to the model, accumulated and read again on later requests.** Native returns small action receipts and requests screenshots separately. CDP returns an approximately8KB JSON state envelope after virtually every browser operation, including observe, action, expansion and screenshot. The MCP bridge serializes the complete bounded rows, then adds image blocks and an execution-budget block (`src/workflow-mcp.ts`). Reducing call count did not reduce that per-call payload enough.

| Direct transcript measurement | Native | Simplified CDP |
|---|---:|---:|
| Browser calls |25|21|
| Model requests |30|27|
| Browser tool-result text bytes, including joined blocks |18,171|172,992|
| Average browser result text bytes |727|8,238|
| Actual image blocks |10|12|
| Average input tokens per model request |32,353.2|64,908.9|
| Total input tokens, including cache writes/reads |970,596|1,752,540|
| Output tokens |11,264|17,653|
| Total processed tokens |981,860|1,770,193|
| Final/peak request input |52,477|128,826|

The identity is exact: total input is the sum of each request's fresh input + cache creation + cache read. Native30×32,353.2 =970,596; CDP27×64,908.9 =1,752,540. CDP's782k additional input accounts for99.2% of the788,333 total-token difference. Fewer requests help, but twice the average context dominates. These totals do not mean1.77million unique tokens were generated or newly supplied.

## The growth is visible without images

Native non-image browser turns typically add600–900tokens to the next request. CDP's nine non-image browser-result turns add4,435–5,014tokens each. These measured deltas include the preceding assistant reasoning/tool argument, tool output and framing, so they are not exact per-output token counts. They establish that image transport is not necessary for the large growth. Native image turns usually add about1,638tokens; CDP small-image turns commonly add approximately5,000tokens. CDP's final larger image turn adds8,093tokens; that recovery contributes, but cannot explain the much earlier no-image growth.

Tool definitions/system prompt are not the main cause: immediately after ToolSearch native input is21,029tokens versus CDP14,636. CDP begins the browser journey6,393tokens smaller. Both local-read groups are similarly sized (7,118 versus7,268bytes). No model change, compaction, textual base64 leak or usage double-counting explains the gap. MCP images are image content blocks; bridge text serializes JSON rows, not encoded image data. No exported record proves hidden native history compression; native's visible small receipts already explain its slower context growth.

CDP18 state-bearing envelopes repeat49,468bytes of elements,22,487bytes of diffs,13,392bytes of console/network errors,11,658bytes of screenshot metadata,9,406bytes of output notices,7,936bytes of recovery guidance, plus source identifiers, long paths, coverage and action receipts. The three historical expansions add24,305bytes. These component byte counts exclude punctuation and independent budget blocks and are **not token attributions**. The first envelope alone includes2,356bytes of diff,744bytes of repeated WebSocket/Maps/favicon diagnostics,992bytes of screenshot metadata, and966bytes of recovery/output notices. It also references the owned daemon's preceding historical capture; fresh model context does not mean the allocated daemon has no prior capture.

The8KB setting is a maximum serialized-response size, not an economical target or8,000tokens. JSON structure, identifiers, paths, state values and repeated evidence remain visible. Protected-evidence omission notices instruct canonical recovery; the actor still performs three expansions and six observations. Our current representation pays for both screenshots and substantial structured state. Two screenshot calls alone also return16,691bytes of state-bearing text. Native's20computer calls combined return15,316bytes of text. This is a concrete representation/design problem, not evidence of a broken reranker: all18CDP views report provider unused/retired, query0.

## Caching works; the pricing cliff amplifies the mistake

Native input is93.67% cache reads; CDP92.74%. Both use1-hour cache writes in this audit. Cache reduces the price of history, but cached input still appears in usage and occupies context; it does not replace history with a summary. No context compaction occurred with the250k setting. Deterministic DOM pruning and byte bounding are distinct from conversation compression.

Anthropic's current [pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing) lists Haiku5.5 rates five times higher for prompts over100,000tokens. Native has0such requests, CDP6. Recomputing recorded usage at the standard tier versus actual applicable tier gives:

| API-equivalent estimate | Native | CDP |
|---|---:|---:|
| Cost if all requests stayed at base rates |$0.02699815|$0.05050766|
| Extra from requests exceeding100k |$0|$0.06813112|
| Applicable-tier total |$0.02699815|$0.11863878|

Even without the cliff CDP costs1.87times native. The cliff raises it to4.39times. Cached input/output rates also change above the threshold, so this is not merely a surcharge on the extra28k tokens. These are assistant API-equivalent estimates, not subscription invoices. [Anthropic caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes cache reads as reused prompt input at reduced rates, not context compression.

## What should change next

The first fix should be the **model-facing MCP representation**, not another reranker or more aggressive blanket DOM deletion. Keep full canonical state and source/action-delivery evidence server-side; make ordinary action results short: delivery/witness status, new source, relevant changed controls, material warnings and requested pixels. Avoid resending the full state, historical removed-node lists, unchanged console errors, multiple path/source copies and repeated recovery prose on every call. Screenshot responses should primarily deliver pixels plus essential alignment/source metadata. Full state remains available through explicit observation/expansion; stale/uncertain delivery must stay explicit.

Then change the operator to use returned action effects rather than routine follow-up observations. Exact literal copying is a separate artifact-backed fill/verification problem and must be fixed before scoring successful task cost. Do not lower the compaction threshold as the first remedy: that would obscure the oversized tool outputs and add compaction work. A smaller response budget alone may also cause extra expansions; the needed change is useful, concise output, not silent evidence loss.

This is a diagnosis and proposed direction, not a newly implemented fix or benchmark win. Provider-exported per-content-block tokenization and hidden request serialization are unavailable, so an exact percentage for each JSON field versus reasoning/images cannot be claimed. The per-request input growth, result bytes, cache usage and tier-cost decomposition are directly measurable. Historical arm/setup/image differences still limit a causal estimate of individual fixes.

Evidence: `websrm-simplified-hard/turn-cost-analysis.json`, raw transcripts under the retained local benchmark directories, and local `explain-cost.mjs`. Track representation/discoverability under cdp-cli-15b and exact text under cdp-cli-kxp. Previous result reports remain unchanged.
