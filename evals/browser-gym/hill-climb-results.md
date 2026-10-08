# Haiku CDP hill climbing against the native extension cash baseline

The first compact serializer regressed despite a61.6% reconstructed byte reduction. Focused queries and retained low-resolution model pixels substantially improved whole-journey cost. Keep these experimental: defaults remain current24k, full-resolution screenshots and existing freshness/delivery guards.

All runs use fresh tracked Claude Code Haiku5.5/medium contexts,250k compaction setting, the dedicated Mako fixture at product e7197b53d508068efabf28a45156697b1f21d048, and one Pepsi/$5 cash acceptance contract. CDP uses the owned headed Chrome152 page, strict MCP/Read/Write/ToolSearch and no subagents/native extension/shell. The saved native comparator uses the Claude browser extension in Edge. This is an extension-versus-MCP comparison, not a same-API browser_toolset comparison.

| Run | Candidate | Invoice/proof | Browser calls | Processed tokens | Assistant API-equivalent USD |
|---|---|---|---:|---:|---:|
| Native baseline | extension1.0.99 |150386;7/7|22|362,720|0.01320533|
| Original CDP |fc8b0cb current24k|150387;7/7|13|1,189,603|0.11693520|
| Trial1 |f6ed9e5 compact8k|150388;6/7, missing full cashier UI proof|27|2,524,484|0.17020699|
| Trial2 |a8ead425 focused query|setup stopped; no new invoice|2|123,985|0.00726562|
| Trial3 |a8ead425 focused query|150389;7/7|15|815,370|0.02782804|
| Trial4 |51bb275 retained originals/scale|150390;7/7|11|554,682|0.02119633|
| Trial5 |51bb275 initial orientation policy|150391;7/7|7|403,089|0.01670980|
| Trial6 |ac74c4a history/image metadata reduction; rejected|150392;7/7|9|383,953|0.01771837|

Trial4 is81.9% cheaper than original CDP, but60.5% more expensive than native. Its two model images are617x338 PNG, with2468x1352 originals from the same captures and an unchanged1234x676 CSS coordinate frame. Native supplied617x338 JPEG. Pixel dimensions are normalized; codecs/tool instructions/browsers/order remain confounders.

Trial1 expanded historical canonical elements repeatedly:14 expansions inflated context and cost. Its successful payment does not override the failed cashier proof. Trial2 correctly stopped after the controller mistakenly copied completed ledger rows; retain its cost, credit no success. Later ledgers were independently authored empty. Trial3's actor reported14calls; the transcript records15, which is authoritative. It made three dispatched-but-unwitnessed Counter clicks, one9-alternative invalid query and an intermediate screenshot. Trial4 preserved click errors in the compact receipt, needed no expansions or invalid-query recovery, but still made three unwitnessed clicks before an image and a different Counter target.

Controller independently read SQL/RQ/pending/config and actually reviewed printed and UI pixels. Trial3 bill20261008134356.png transaction06HE-02TS-01TQ-01DR and trial4 bill20261008135723.png transaction078S-002K-00VS-05GA match their accepted payloads. Both have exactly one cash payment, one Pepsi,3.59subtotal/.18TPS/.36TVQ/4.13total,5.00tender/.87change, no pending request and unchanged test certificate/config. No refunds/reprints/fixture rewinds are claimed.

All six experimental attempts consumed4,805,563 processed assistant tokens and USD0.26092515, including the setup failure and rejected candidates. This excludes controller/setup/Codex supervision and earlier baselines. These are priced assistant transcript estimates, not subscription charges. All six had zero compactions; they establish no compression savings. Trial1 peak input142,702 versus trial3 74,056, trial4 61,112, trial5 50,981 and trial6 52,889 helps explain leaving the long-context pricing tier. One sequential easy cash comparison cannot establish general superiority or reliability on difficult WebSRM flows.

Trial5 passed all seven independently checked business/visual assertions. Initial model-charged pixels and the visible Counter target removed the repeated input-recovery loop: one observe, five acts and one final screenshot, with no expansion or invalid-query recovery. Actual transcript images number four (initial, Drinks-act, Pay-act, final), all617x338 with same-capture2468x1352 originals. The worker listed only initial/final images; transcript counts are authoritative. Initial alignment was unstable and was not used for final proof; final alignment was stable. Bill20261008140816.png transaction05MY-01H2-07GK-03C7 and final UI pixels were independently reviewed. Cost is85.7% below original CDP but26.5% above native. A Counter action had unknown delivery with the invoice effect observed; it was not repeated.

The output contract differs: CDP workers read/update a QA ledger and write result.json; the saved native baseline wrote result.json only. Additional prompt and bookkeeping costs are included in CDP accounting. Browser, image codec, tool schema, setup allocation and fixed native-first order also differ. These measurements guide optimization but cannot establish an isolated tooling effect or a fair generalized native victory. A future fresh native arm must use the same acceptance and bookkeeping contract.

## Input-readiness investigation

Explicit activation before trial4 did not prevent failures. A separate headed Chrome fixture tested six harmless one-click arms: no override, desktop1234x676 DPR2, desktop+metrics, desktop+screenshot, an equivalent wait and mobile. All delivered one trusted event/effect. This did not reproduce the Mako failure and does not justify production screenshot priming, automatic focus, coordinate multiplication or retries.

Before trial5, the actual Mako native child button was enabled with pointer-events auto, visual viewport scale1 and document focus true; document visibility was nevertheless hidden after activation. Browser window state was normal. Record this unresolved input-readiness gap under cdp-cli-3p7. The isolated fixture differs from the persistent owned browser context and application handlers.

## Retained changes and rollout gate

The opt-in profile offers source-bound short references,8k byte packing, literal focused queries with nearby amounts/child actions/global safety state, explicit omissions and sectioned historical recovery. Input validation now rejects malformed queries/profile/full combinations or invalid finite scales before command/action admission. Dispatched click failures retain allowlisted code/message/witness summaries; eight-witness ceiling counts omitted detail. It never converts a null event into a no-dispatch result or silently retries.

Optional raster scaling retains original same-capture bytes and distinct original/output/CSS dimensions. Layout metadata is best-effort; absent alignment is not proof. Surviving originals remain discoverable after downstream failure. Guards and default viewport/image size remain unchanged. Unit, real-Chrome source freshness/removed targets/child actions/clock negatives, image preservation and accounting tests passed; whole-repository coverage remains below the documented80% target.

Trial5 tests initial model-charged visual orientation and choosing the visible Counter control rather than requiring its child+. It is a combined prompt/transport policy experiment, not an isolated image-scaling effect. Trial6 used the same orientation policy and ac74c4a, summarizing recoverable ordinary text history and duplicate screenshot metadata while preserving safety transitions, image availability/alignment/failures/dimensions/originals. All seven independent checks passed: bill20261008142549.png transaction010E-03IR-0534-02KB and final pixels were actually reviewed. Three attached617x338 images were all semantically stable. The actor used four observes and five acts; two additional focused reads checked post-Counter controls/identity and post-Pepsi amounts. No expansion or invalid-query recovery occurred; unknown Counter delivery was resolved by the observed invoice effect and not repeated.

Trial6 reduced processed tokens4.7% versus trial5 but increased cost6.0%, with8,521 output tokens and two more calls. Fewer transported bytes did not win full-journey economics. One attempt cannot assign the extra reads causally to the serializer; nevertheless it failed the adoption criterion. Revert ordinary text-history/screenshot metadata/path elision and retain the measured trial5 transport and prompt policy. Keep the screenshot omission-count accumulation correction and harmless input-routing fixture. The pinned rejected commit remains reproducible in Git.

Do not promote defaults from this easy case: next gate is a fresh native/CDP hard WebSRM pair with matching output contracts, independent business/printed proof and all recovery costs, followed by repeated/order-balanced success measurements. Evaluate total completion cost and proof, not response size alone. Trial6's pre-revert514 units/4 live tests passed; retained runtime510 units/4 live tests and59 accounting tests passed. Existing whole-repository line coverage61.8% remains below80% and is tracked under cdp-cli-yr7.

Artifacts: `C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/hill-climb-cdp-01/` through `hill-climb-cdp-06/`. Each model attempt preserves native.jsonl/accounting/summary/config/prompt/runtime evidence; successful trials preserve proof/cash-evidence/bill-review and original UI/printed pixels. Trial4 also preserves input-routing.json/log. Trial6 preserves inspect-cost.mjs to reconcile actual queries/images. Parent tracking: cdp-cli-8dl.
