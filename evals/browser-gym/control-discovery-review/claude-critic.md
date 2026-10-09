# Control-discovery optimization critique (claude-critic)

Work item 8508 / session 2067. Read-only review. Only this file written.

## Verdict

**Accept with required corrections.** Per item:

| Provisional item | Verdict | Why |
|---|---|---|
| 1. Trim kq/context/default-false | Accept, retarget | Named targets ≈12% of text; `context` ≈1.4%. Bigger lossless targets are unnamed (envelope ≈21%, JSON syntax/role default, key namespace). |
| 2. "Native-like" scoped discovery | **Rework** | Native baseline does zero control discovery. App exposes no dialog role and almost no container handle. Needs a different scope handle and presentation-only scoping. |
| 3. Avoid forced rediscovery | Accept, **promote to first** | "Need evidence before design" is outdated: the trace already proves the mechanism and its cost. |
| Key shared-prefix encoding | Accept short per-source nonce only; **reject** bare ordinals / split prefix | Trace proves the namespace is the only thing stopping a wrong-control click. |
| (not in direction) Silent budget truncation | **Required fix before any trim** | Trims on a truncated observe refill with elements instead of saving bytes, and the model is not told. |

## SCOPE-CHECK

| Item | Status |
|---|---|
| Repo `Q:/apps/cdp-cli-haiku-gym` (worktree of `Q:/apps/cdp-cli`) | Verified |
| Branch `codex/haiku-browser-gym` | Verified (worktree `HEAD` ref) |
| HEAD `58c042517aac…` | Verified (ref file) |
| Installed `01591444297d…`, v2.2.3, dirty=false | Verified (`lean-receipt-pair-01/cdp/build-info.json`) |
| HEAD vs installed | HEAD is 2 commits ahead; both titled "Record …" (reflog). **Inference** that `src/` is identical; not diff-verified (no shell). |
| Migration | None |
| Not done | No tests, git, browser, build. Raw JSONL not read; only `grep -o` of usage fields and action names. |
| Evidence base | n=1 CDP run, n=1 retained native run. Everything quantitative below is one trace. |

Byte figures marked "est." are computed from pretty-printed `tool-results.json` by counting occurrences × minified field width; expect ±20%.

## Reconstructed discovery behavior (verified from source)

- `observe` → full-page canonical capture (`src/state/page-script.ts:112-189`), `projectState` prune (`src/experimental/decision.ts:93`), compact + 8000-byte bound (`src/workflow-compact.ts:17-96`, `src/workflow-output.ts:29,32-105`), then model-facing receipt (`src/workflow-receipt.ts:36-41`).
- Keys printed to the model are `r<16 hex>.<base36 ordinal>`, minted per **source** (`workflow-compact.ts:33` passes `captureProfile/source.id`; `src/state/store.ts:44-47`).
- `act` resolves the key only under the `source` passed (`src/workflow.ts:122-125`), refuses if the live page signature differs from that source (`workflow.ts:186-192`), and returns a **new** source with no elements (`workflow-receipt.ts:35-41`).
- Consequence: after any effective act, the model holds a source id with zero usable keys. Old source + old key → stale refusal. New source + old key → `WORKFLOW_REFERENCE_UNKNOWN` (`store.ts:58`). The only observe-free path is a CSS selector the model cannot derive, because canonical keys/locators are hidden.

## Measured baseline (verified unless marked)

Per-request context growth, from `cache_creation_input_tokens` in both transcripts (sums reconcile to 73,128 and to native peak 52,477):

| | CDP lean | Retained native |
|---|---:|---:|
| Context before first browser result | ≈22–23k | ≈21–22k |
| Final context | 73.1k | 52.5k |
| Model requests | 31 | 30 |
| Discovery turn growth | observe ≈ +3.1–3.6k | screenshot ≈ +1.64k |
| Action turn growth | act+image ≈ +1.2–1.4k; act alone ≈ +0.54–0.66k | click ≈ +0.59–0.68k |
| Discovery calls | 10 observe | 0 (`computer`: 10 screenshot, 9 left_click, 1 type; 1 `javascript_tool`) |
| Output tokens | 18,440 | 11,264 |

- Mapping of growth increments to call kinds is **inference** (by size and order, not joined on tool_use id).
- Pre-loop context is at parity. The whole token gap accrues inside the browser loop.
- Observe text costs ≈0.5–0.6 tokens/byte (**inference**: 5.0–5.6 KB → ≈3k tokens). Hex keys and JSON punctuation tokenize badly. Bytes understate cost.
- One model request ≈41k processed tokens on average (1,267,101 / 31), ≈65k+ late in the run.

Observe payload composition (10 observes, 46,643 B, 438 elements):

| Component | Count | Est. bytes | Share of all text (57.8 KB) |
|---|---:|---:|---:|
| Key namespace `r<16hex>.` | 438 | 7.9 KB | 14% |
| `"kq":"weak"` | 426 (97% of elements) | 5.1 KB | 9% |
| `"role":"button"` (defaultable) | ≈340 | ≈5 KB | 9% |
| `vis:false` nodes (unactionable) | ≈25 | ≈2.7 KB | 5% |
| Default-false state fields | ≈60 | ≈1.2 KB | 2% |
| `context` arrays | 35 (8% of elements) | 0.8 KB | 1.4% |
| Budget block, every call | 22 × ≈250 B | 5.5 KB | 9.5% |
| URL repeated per observe | 10 × ≈230 B | 2.3 KB | 4% |
| Screenshot metadata | 12 × ≈185 B | 2.2 KB | 4% |
| `diagnostics` + `evidence` constants | 20 × ≈85 B | 1.7 KB | 3% |
| `geometrySpace` string | ≈9 × 95 B | 0.9 KB | 1.5% |

- A plain act receipt is 692 B, of which the budget block is ≈250 B (36%).
- ≈29 of ≈44 controls per invoice-screen observe are the same persistent toolbar/category/quantity chrome (verified by name lists in three consecutive observes; ≈50% of observe bytes, est.).

## Findings, ranked

### F1 — Observes are silently budget-truncated; the bound runs before the receipt projection
Severity high. Confidence: mechanism high, run impact medium.

- **Verified (code):** the 8000-byte bound is applied to the pre-receipt result, which still carries diff changes, recovery text, canonical path and coverage (`workflow.ts:284-289`, `workflow-compact.ts:92`). The receipt then discards those and also discards `value.output` (`workflow-receipt.ts:11-19`), so `bounded`, `omittedElements` and `protectedEvidenceOmitted` never reach the model. Only `omitted.count` survives, merged with hidden-pruned count (`workflow-output.ts:98`).
- **Verified (evidence):** zero occurrences of `bounded|omittedElements|protectedEvidenceOmitted` in all 22 delivered results.
- **Inference (strong):** observes were bounded. Element order is non-monotonic in ordinal and grouped buttons → text → hidden, which only `boundWorkflowResult` produces (`workflow-output.ts:90-97`). Example: source `573df4fb…` and the payment-screen observe (`…2g, 1t, 1v, 4, 5, 2a, 2b, 2i, 2j, 1`). Month option "Jan" appears once in the whole run with no other month.
- **Trigger:** any page whose pre-receipt result exceeds 8 KB. Delivered observes cluster at 5.0–5.6 KB, i.e. ≈2.4–3 KB of the cap went to content the model never sees.
- **Impact:** (a) visible controls can be dropped with no distinguishable signal on a larger page; (b) item 1's "savings" on a bounded observe become more elements, not fewer bytes; (c) byte-only before/after comparisons are invalid.
- **Unknown:** which elements were dropped in this run (needs the `<source>-workflow.json` artifacts). First-observe diff base may be a stale controller-preboot observation (`workflow.ts:133-136, 233`).
- `tests/unit/workflow-receipt.test.ts:12,41` codifies dropping `protectedEvidenceOmitted`.

### F2 — Rediscovery is structurally forced; this is the main lever and the evidence already exists
Severity high. Confidence high.

- **Verified:** 10 observes for 11 acts. The only two acts not preceded by an observe both failed: a guessed selector (`#invoice_modify, button:has-text("Modify")`, 568 B error) and a cross-source key (source `5c6185b3…` + `r01ee4db56884bbbf.2g`, 381 B error). Each cost a failed request plus a recovery observe.
- **Inference:** 3 of 10 observes (after the failed selector, after fill, "locate Pay") re-fetched controls the model had already been shown (`Modify`, the confirm button, `Pay`) on a page where those controls persisted.
- **Impact:** each avoidable observe is ≈3.2k tokens re-read by every later request, plus one or two whole requests. Rough upper bound for removing those three episodes: 150–250k processed tokens, i.e. most of the 285k gap. Assumes the model exploits the mechanism.
- The adapter's advice "known stable CSS selectors can chain acts" is unusable here: 97% of keys are path-derived and no selector is ever shown.

### F3 — Shared-prefix or shortened keys can turn a safe rejection into a wrong-control click
Severity high. Confidence high.

- **Verified:** ordinals are not stable across sources. Source `8e20462c…`: Notes textbox `.2e`, buttons `.2f` [1040,20,80,40] and `.2g` [1128,20,80,40]. Source `573df4fb…`: Notes textbox `.2g`, same two buttons `.2h` and `.2i`.
- **Verified:** the model did send an old-namespace `.2g` with a newer source. Today it is rejected with no delivery only because the namespace differs.
- **Trigger:** any encoding where the executor can match on ordinal alone, or where the model must concatenate a header prefix and gets it wrong or omits it.
- **Impact:** `.2g` would have resolved to the textbox instead of the confirm control. On a payment screen the same slip is a wrong payment button.
- Also coupled: `workflow.ts:122` hard-codes `^r[a-f0-9]{16}\.`; a non-matching string falls through as a canonical key.

### F4 — Item 1 is aimed at the small targets
Severity medium. Confidence high (counts), medium (bytes).

- kq + context + default-false ≈7.1 KB ≈12% of text. `context` alone is 35 entries; its values are tag names or ids (`section`, `li`, `interactive-container`, `sales_1`), so it is neither large nor much of a disambiguator here.
- Unnamed, larger and equally lossless: per-call envelope constants ≈12.6 KB (21%); key namespace 7.9 KB; default role ≈5 KB; JSON object syntax per element.
- Largest of all is not per-control boilerplate but cross-observe repetition of unchanged chrome (≈50% of observe bytes), which no per-element trim touches.
- Estimated value of item 1 as written: ≈54k processed tokens (≈4% of run, ≈19% of gap) — about one late-run request.

### F5 — "Native-like scoped discovery" mislabels the baseline and has no handle in this app
Severity medium. Confidence high.

- **Verified:** retained native used no `read_page`/`find`. Its efficiency comes from pixels + coordinate clicks at ≈2.3k tokens per step versus ≈4.6k for observe + act.
- **Verified:** 0 elements with role dialog/alertdialog in 438; the modifier-note panel is not an ARIA dialog; 92% of elements carry no `context`. "Focused dialog" never triggers; "selected container" has nothing to select.
- **Verified:** with the note panel open the observe still lists ≈45 background controls for ≈5 relevant ones, so scoping would pay off there if a handle existed.
- **Hazard:** scoping implemented as a scoped *capture* changes `captureProfile`, breaks act source matching (`workflow.ts:126-127`) and blinds the whole-page freshness signature to alerts outside the scope.

### F6 — Byte trims are fragile against request count
Severity medium. Confidence medium.

- A 20% cut of all observe tokens ≈69k processed tokens (est.: 0.6k × 115 later request-reads). One extra late recovery request costs ≈65k.
- Any presentation change that adds one confusion/recovery turn per run nets zero. Previous-vs-new CDP already moved 27 → 31 requests with fewer bytes.

### F7 — Output tokens are +64% and untouched by the direction
Severity medium. Confidence low on attribution.

- **Verified:** 18,440 vs 11,264.
- **Inference:** under conventional price ratios (output 5×, cache read 0.1×, cache write 1.25×) output is roughly 45% of the cost delta. The auditor's pinned table is unknown to me; treat as hypothesis.
- **Unknown:** split between reasoning, tool-call arguments (required `task` on every call, `workflow-mcp.ts:84`; 36-char source id; 20-char key) and the three Writes.

### F8 — Prerequisites for screenshot-driven targeting are not met
Severity low–medium. Confidence medium.

- **Verified:** 5 of 12 screenshots returned `semanticStable:false` (4 of 7 act screenshots). Cause unknown; the check runs without clock tolerance (`workflow.ts:276`) while staleness uses tolerance.
- **Verified:** first click returned `deliveryUnknown:true` (`targetMatches:false`, target `img`) and cost a recovery observe + image. Cause unknown.

### F9 — Low-severity observations
- `task` wording still selects elements via keyword protection (`decision.ts:37,53`). It only adds, but it is residual lexical relevance; do not let it grow into scoping.
- Hidden nodes are delivered though `act` refuses them (`workflow.ts:73`); hidden selected options do carry state.
- `store.ts:39` comment says identities persist across captures; the call site makes them per-source. `references.json` is fully rewritten on every observe and act, including act results whose keys are never shown.
- Text children duplicating their parent button's name are delivered (`Pepsi`, `[NEW] Pepsi Zero Cherry` ×2).

## Simplest credible alternatives

Ordered by value per unit of risk. Token figures are estimates from this one trace.

| # | Change | Est. effect | Maintenance cost | Risk |
|---|---|---|---|---|
| A0 | Bound against the receipt form, or project before bounding. Report `budgetDropped` separately from hidden-pruned. | Correctness; unlocks honest measurement | Low. One ordering change, two fields, update receipt tests | Observes may grow where truncation was hiding controls |
| A1 | Envelope diet: budget → `actionsRemaining`/`remainingMs`; drop static fields; minimal act receipt; URL and screenshot frame only when changed | ≈−8–10 KB | Low. Presentation only | "Absent" must never read as "clean": keep error counts and at-limit flags whenever non-zero |
| A2 | Line-oriented element rendering at the MCP boundary with a defaults header (`role=button, kq=weak`), e.g. `2h button "$3.59"`. Canonical JSON and CLI unchanged | Elements ≈35 KB → ≈12–14 KB | Low–medium. One renderer, golden tests, adapter text | Model-facing contract change; needs requalification |
| A2b | Short per-source nonce (4–5 base36, collision-checked across live profiles at mint) | ≈−5 KB, more in tokens | Low. `store.ts:44-47`, regex at `workflow.ts:122` | None to source binding if uniqueness is enforced, not probabilistic |
| A3 | Verified carry-forward: accept a previously presented key against the latest fresh source only if its canonical key is unique there and role/name/text/box-if-unnamed match what was last presented; otherwise refuse without delivery. Echo resolved role/name in the act receipt | −3 observes and −3..5 requests in this trace | Medium. Touches the executor safety boundary; new refusal code; fingerprint store | Path-keyed identity shift. Needs an explicit owner decision that "verified unchanged" is not "stale" |
| A4 | Delta observe `since:<source>`: added/changed controls plus count of unchanged. Requires A3 | ≈−50% of remaining observe bytes on shared-chrome screens | Medium | Model forgetting older keys; mitigated by A3 refusal + receipt echo |
| A5 | Geometric scope `region:[x,y,w,h]` as a presentation filter over the full capture; always include alert/status/dialog/focus; report `outsideRegion` and `frameUnscoped` counts | Large on overlay panels | Low–medium. Boxes already captured for top document | Iframe-local boxes are unmapped (`workflow-compact.ts:49-50`); must be labeled, not guessed |
| A6 | Source-bound point targeting with hit-test and receipt echo | Removes most observes | High. New safety surface | Blocked by F8 until alignment uncertainty is understood |

Recommended sequence: A0 → A1 + A2 + A2b (one requalification) → decide A3 → A4 or A5. Defer A6.

A3 and A5 are alternatives for the same problem. A5 is simpler and keeps per-source keys intact; A3 saves more requests. If the owner will not relax "no stale keys" to "verified unchanged", choose A5.

## Required corrections to the direction

1. Fix F1 first, and add distinct truthful counts: hidden-pruned, budget-dropped, out-of-scope.
2. Measure tokens and requests, not bytes.
3. Retarget item 1 at envelope, syntax, role default and key namespace; treat kq/context/false-fields as part of that, not the headline.
4. Replace item 2's handles (dialog/container) with a geometric or key-anchored handle; scoping must be presentation-only over a full capture.
5. Move item 3 to the front and define "stale" precisely before design.
6. Keys: executor must require a per-source token on every key. No header-prefix + bare-ordinal split.
7. Do not rename this "native parity work" until a fresh completed native run exists.

## Verification that could falsify the savings

1. **Offline replay, no model, no browser.** Re-render the retained per-source artifacts through each candidate presenter. Report tokens (tokenizer count), bytes, elements delivered, budget-dropped. Falsified if: token saving is under the pre-registered figure; or any field of the recorded next target (role, name, state, value mask, box, kq) is not recoverable from the candidate; or a round-trip decode differs from today's element set.
2. **Pre-registered integrated model.** Predicted saving = Σ Δtokens(result i) × requests remaining after i, computed from this trace's request series. Falsified if the live saving is under half the prediction, or requests rise.
3. **Live requalification on the frozen contract.** At least 3 runs per variant, order randomized; n=1 cannot separate effect from run variance. Primary: processed tokens, estimated cost, model requests, observes per act (now 0.91), recovery turns. Guards: same independent checks pass, exactly one payment, zero wrong-target deliveries, zero unlabeled truncation. Falsified if mean requests rise by ≥1, or any guard fails.
4. **Key safety replay.** Re-issue this trace's rejected call (source `5c6185b3…`, key ordinal `2g`) against every candidate encoding; it must still refuse without delivery. Property test: no key minted for source A resolves under source B.
5. **A3 adversarial fixtures.** List reorder under path keys; duplicate labels (this app has `+` ×3, `$4.13 Cash` ×2, `[NEW] Pepsi Zero Cherry` ×2); unnamed icon buttons whose boxes move; iframe/shadow targets; masked value change; alert appearing outside a region. Every identity shift must refuse without delivery. A single wrong-target delivery rejects the design.
6. **Output-token attribution.** Per-request output tokens split by reasoning, tool arguments and writes, both arms. If arguments are a small share, do not spend effort shortening `task`/source ids.

## Unknowns

- Whether `src/` at HEAD equals the installed build byte-for-byte.
- Which elements the byte budget dropped in this run.
- Cause of `semanticStable:false` and of the first click's witness mismatch.
- Run-to-run variance; all ratios are single-trace.
- Auditor price table, hence the true output-token share of cost.
- Whether Haiku will actually reuse carried keys or delta lists without prompting changes.
