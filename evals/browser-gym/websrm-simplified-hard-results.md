# Simplified installed CDP: hard WebSRM long-modifier retest

2026-10-08: completed one fresh managed Haiku5.5/medium attempt on installed runtime `46cbcdf8c8189a33566d8c006bb1813cc85358b9`, build2026-10-09T00:06:41Z. **Full acceptance failed,6/8 checks. Native token parity is not met on this hard journey.** No tool or product implementation changed during the run.

| Metric | Retained native | Retained old CDP | Simplified installed CDP |
|---|---:|---:|---:|
| Invoice |150393|150394|150395|
| Independent checks |6/8 FAIL|6/8 FAIL|6/8 FAIL|
| Processed assistant tokens |981,860|1,941,352|1,770,193|
| Assistant API-equivalent USD |0.02699815|0.12916246|0.11863878|
| Browser calls |25|23|21|
| All tools / model requests |34 /30|32 /29|30 /27|
| Peak input tokens |52,477|131,389|128,826|
| Requests above100k |0|7|6|
| Transcript seconds |137.886|200.544|239.996|
| Context compactions |0|0|0|
| Historical element expansions |0|4|3|

The new attempt consumed8.8% fewer tokens and8.1% less estimated cost than old CDP. It still consumed80.3% more tokens and4.39times estimated cost than retained native. This is cost per failed attempt, not cost per successful completion. Processed tokens include fresh input54, cache creation127,110, cache read1,625,376 and output17,653. Auditor pricing is pinned as-of2026-10-07; these are estimates, not subscription charges. All worker discovery, recovery, rejected calls, images and reporting are included; controller setup, supervision and independent verification are excluded. No compression saving was measured.

## What worked and failed

Independent read-only snapshots captured invoice150395 open/unpaid before payment and closed afterward. One ordinary Pepsi3640, subtotal3.59,TPS.18,TVQ.36,total4.13; one Cash5 payment, change.87; current ARG WebSRM transaction34 accepted with no pending requests. Actual printed bill `C:/autoprint/20261008172521.png` shows invoice150395, transaction `00I6-05R3-07IV-025Z`, cash/payment received and matching totals/precision. Full Michel Untel role and original fixture/configuration/certificate are preserved. Six checks pass: boot-role, bill-image, fixture-cleanup, rq-accepted-arg, invoice-payment-totals, bill-payload-parity.

The note must be141characters (`Note: ` +121a + ` boundary tail`), with a space at index127 so the RQ precision trims to127characters. The actor read the assigned file but supplied148characters, containing128a. **The actual fill argument equals the persisted database note.** CDP did not truncate or alter it. The accepted RQ precision is128characters (`Note: ` +122a), and actual printed pixels show Note:, ten rows of12a, then two. The two failures are modifier-boundary-fixture and rq-description-no-trailing-space. This does not demonstrate a product trailing-space regression: the agent failed to construct the intended boundary fixture. Native and old CDP also failed exact transcription in their retained attempts.

The actor reported char count148 and unverified exact repetition, yet marked UI-item-note verified in its ledger. Controller grading supersedes that label; the original ledger is preserved separately. It wrote the ledger at the end, another retained protocol deviation. No corrective note, retry benchmark, refund or reprint was performed to turn this attempt into a pass.

## Workflow evidence

Configured bridge is the installed build with haiku-compact, source-bound evidence,60admitted-act/600000ms limits, no native Chrome tools, no shell/SQL/subagents. Every18 returned workflow views reports provider unused/reason retired; zero query arguments. Removing query and reranking works operationally, but has not removed the hard-flow efficiency gap.

Actual calls:6observe,10act,3expand,2screenshot. Ten admitted acts include a stale Pay rejection with actionDelivered=false; one fresh-source retry delivered it once. Three historical expansions searched modal/textbox evidence. Captured top-document boxes were emitted, but their presence alone did not avoid these expansions. Eighteen bounded workflow envelopes and three expansions returned172,959text bytes in total; expansions were8,071/8,150/8,081bytes. Protected-evidence omission notices/canonical recovery remained active. Twelve actual model image blocks: eleven617x338 PNGs and one2000x1096 JPEG for final readability; original large capture2468x1352. Small screenshots were insufficient for note/payment text. These repeated state/images accumulate context; this single run does not isolate their separate cost contributions.

## Contract and limits

Shared business contract/operator/note are byte-identical to the retained hard pair; contract SHA256 `b5a75bd8908e0e68981a86a0b2f697645deef0520bc1a169319c9f6a85910c15`. Fresh Claude Code context used exact Haiku5.5/medium,250k autocompact, Read/Write/ToolSearch, strict CDP-only MCP. Live launch/runtime identities were checked. Product remains `e7197b53d508068efabf28a45156697b1f21d048`, dedicated database mako2_haiku_websrm_gym, station1, declared migration446, DEV WebSRM, unchanged tax/certificate/printNotes fixture. Existing generated-template changes were retained; no product/config edits.

Controller setup encountered missing full cashier on127.0.0.1; ordinary employee-ID Login was rejected, and read-only dev PIN was empty. Explicit test-auth POST returned logged_in:true; navigating the same owned page through localhost restored full Michel. Cause is not established. The measured actor started on localhost with bench=simplified-hard-boot03; it retained/reported that deviation instead of navigating to the old contract entry. Controller recovery/setup costs are excluded and qualification artifacts retain them. Neither product auth nor certificate settings were changed.

This is one new CDP attempt versus historical native/old-CDP references, not a fresh randomized paired comparison. Adapters/runtime, host/setup and image resolution/encoding differ. Native used its own Edge setup; CDP was controller-preallocated/activated Chrome. Thus the deltas are observational, not causal estimates of removing reranking. The small Notes success does not establish parity on WebSRM or management iframes. Only this long-modifier hard case ran; zero-total netting, no-printable-item and invalid-tax-identity were not rerun on this build.

## Retained evidence and follow-up

Raw transcript, effective launch, controller qualification/boot, tool calls/results, worker result/original ledger/corrected ledger, usage accounting, before/after/cleanup snapshots, independent proof and bill review are retained under `C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/websrm-simplified-hard-01`. Moderate summary artifacts are versioned in [websrm-simplified-hard](websrm-simplified-hard). Identity preserves the pre-localhost adapter hash and actual final adapter hash. Actual bill SHA256 `a6ecb20b429c9fbadc23ab4aa264a1b3eb16dbfb7db1a29ae42e763bb7107bae`.

Track exact artifact-backed fill/verification under cdp-cli-kxp, remaining discoverability/state recovery under cdp-cli-15b, formal same-API comparison under cdp-cli-8dl. This run is sufficient to reject a hard-flow token-parity claim; no additional optimization or benchmark dispatched. Eleven existing hard-verifier tests passed during qualification. Documentation/evidence only; installed runtime remains46cbcdf. Completed worker is stopped; owned browser, worktree/database, sale and printed proof are retained.
