# Native extension versus current24k CDP cash pair

On2026-10-08, Haiku5.5/medium completed the same one-Pepsi cash journey under Claude
Code2.1.294 with short operator contracts. Native invoice150386 and CDP invoice150387
both passed all seven independent business checks: cashier boot, $4.13 paid/$5 tender/
$0.87 change, accepted ARG WebSRM transaction, pending clear, actual bill pixels, payload
parity and unchanged fixture configuration. No duplicate payment or controller intervention.

| Metric | Native extension | CDP current24k |
|---|---:|---:|
| Business checks |7/7|7/7|
| Elapsed transcript time |133.797s|164.978s|
| Browser tools |22|13|
| All tools |26|16|
| Model requests |17|17|
| Fresh input |34|34|
| Cache creation |37,080|148,365|
| Cache read |320,443|1,034,644|
| Output |5,163|6,560|
| Total recorded tokens |362,720|1,189,603|
| Peak request input |31,364|150,081|
| Requests above100k input |0|5|
| Assistant API-equivalent USD |$0.01320533|$0.1169352|
| Compactions |0|0|

CDP consumed3.28times the recorded tokens and8.86times the estimated API cost, and was
23.3% slower despite fewer browser tools. Equivalently native used69.5% fewer recorded
tokens and88.7% less estimated cost. Rates come from the auditor's2026-10-07 pricing table;
the100k input threshold amplifies the cost difference. These are assistant API equivalents,
not subscription charges or independently verified bills.

The context difference arose after browser responses, rather than startup: first recorded
input was9,718 native versus7,462 CDP. CDP response text often approached the24,000-byte
view ceiling and subsequent request input commonly grew by8k–13k tokens. Bounded/pruned
output worked, but that ceiling still accumulated substantial repeated context. Both arms
made17 model requests. CDP returned two2468x1352 PNG screenshots; native transported
617x338 JPEG screenshots with a1234x676 coordinate frame. Text and image differences
are both retained in usage; this pair does not isolate either component's causal contribution.

Native had two MCP errors (initial internal-tab screenshot and stale reference), plus a
blocked query-string JavaScript receipt; recovered with pathname-only read-only evidence.
CDP had zero is_error receipts but two no-delivery stale rejections and one uncertain-delivery
COUNTER-tile action. The actor observed and used the actual COUNTER plus control, producing
exactly one invoice. Count recoverable receipts separately from MCP errors. The CDP actor
also took an intermediate screenshot beyond the requested final screenshot; its cost remains
included. Some bounded views reported protected omissions and the actor did not expand them.
Business success is independently proven; full workflow evidence/transport compliance is not
established by this seven-check verifier.

Matched: model, effort,250k autocompaction setting, CLI runtime, fresh actor contexts,
Read/Write/ToolSearch tools, no skills/delegation/shell, product candidate
e7197b53d508068efabf28a45156697b1f21d048, same dedicated fixture/cashier/station/tax/certificate,
1234x676 desktop viewport and cash acceptance criteria. CDP buildfc8b0cb1f668bfaf4af2049073426b2237db98e1,
version2.2.3 clean, reranker off. Actor learned no prior result.

Limits: one sequential pair, native first, not randomized; native extension in Edge versus
headed Chrome152 CDP, tool-specific instructions and screenshot transport differ. CDP page
allocation/viewport setup was controller work; native session group allocation was actor work.
Both respected30-browser-call/10-minute prompt limits; CDP additionally enforced30acts/
10minutes before action commands. No DB rewind claimed. Controller/setup and earlier failed
connection costs are excluded for both. Native compaction savings remain untested.

Artifacts:
- `C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/native-chrome-cash-01/`
- `C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/matched-cdp-cash-01/`

Each includes native.jsonl, accounting.json, effective-launch.json, result.json, boot.json,
proof.json, cash-evidence.json, bill-review.json and final UI pixels. CDP includes comparison.json,
compare.mjs, pinned mcp.json, operator prompt, launch script and viewport setup evidence.
Bill transactions visually verified: native05M7-06MU-05E9-05LF and CDP03A3-05SH-00S2-075C.

Follow-up undercdp-cli-8dl: reduce response token growth with a Haiku-oriented view budget,
measure per-receipt tokens, retain omitted protected evidence and fresh target/recovery receipts,
and normalize screenshot delivery. Preserve this failed cost baseline before changing defaults.
Run another bounded pair only after a concrete transport change; do not expand the matrix
to establish a tool winner from this easy cash journey.
