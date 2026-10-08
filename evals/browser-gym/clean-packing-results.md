# Clean Haiku packing comparison

Decision checked 2026-10-08: keep current-24k as the default; retain rich-64k as opt-in.
Both arms passed all seven independent cash checks and complete transport qualification.
In this pair, current processed 19.2% fewer recorded tokens and its native API-equivalent
report was 17.7% lower. This is one end-to-end pair, not a general savings guarantee.

| Measurement | current-24k | rich-64k |
|---|---:|---:|
| Independent cash checks | 7/7 | 7/7 |
| Complete source/profile attestation | yes | yes |
| Recorded processed tokens | 2,126,747 | 2,632,918 |
| Recorded assistant API estimate, USD | 0.18146647 | 0.23901872 |
| Supplemental complete native API report, USD | 0.20573212 | 0.25005732 |
| All tool calls / workflow calls | 26 / 7 | 29 / 8 |
| Native epochs / native compactions | 1 / 0 | 1 / 0 |
| Peak request input | 176,246 | 197,780 |
| Assistant request span, seconds | 136.496 | 140.426 |
| Preserved host offloads | 0 | 1 |
| Missing/truncated receipts / source mismatches | 0 / 0 | 0 / 0 |

## Comparable inputs and independent proof

Randomized order was rich first, then current. Both used the clean build from
`fc8b0cb1f668bfaf4af2049073426b2237db98e1`, product candidate
`e7197b53d508068efabf28a45156697b1f21d048`, exact `claude-haiku-5-5`, medium effort,
250k compaction configuration, 30-action/10-minute budget, reranker off, the same cashier
and station, and equivalent fixture/config snapshots. No database rewind was performed.
Native process arguments and transcript model identity were checked, rather than trusting
the agent database label. Project/canonical skill hashes matched before launch and after
the pair. Operator prompt SHA-256:
`c098f1498cce3b146ad524c09aa49e213426788cd1306840d06b6c02209f69d1`.
Every workflow call used the same task: `Complete one fresh Pepsi cash invoice and preserve evidence`.

Managed workers 2057/rich and 2058/current each delivered five business actions. Unique
invoices 150384/rich and 150385/current have one Pepsi, total 4.13, cash 5.00, change 0.87,
one accepted current RQ transaction and no pending request. Controller SQL/payload checks,
matching bill pixels and exact fixture restoration established completion independently.
The actor stopped after its final MCP screenshot; controller qualification costs are excluded.

Current included one failed text wait after successful item delivery, without repeating the
item or payment. Rich included an additional observation during the payment transition and
one fully preserved host offload with extraction handling. Startup and wait choices differed.
All worker tools, extraction, failures and reporting remain counted; neither arm renewed.

## Accounting limits and retained evidence

Amounts are worker-only API-equivalent estimates/reports for Claude Max runs, not subscription
invoices. Native totals are supplemental, separate from independently priced assistant records.
The native-minus-assistant gaps differ: approximately 0.02427/current and 0.01104/rich. Token
totals include fresh, cache creation, cache reads and output across recorded requests; they are
not unique prompt length. This pair isolates the intended view setting while retaining actual
agent behavior, so it is not a pure byte-size causal estimate or a reliability sample.

Evidence root: `Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/clean-packing-pair-01/`.
`comparison.json`, `pair-score.json`, `order.json`, `instruction-identity.json` and each arm's
launch gate, native transcript, proof, bill review, run manifest and accounting summary are retained.
Rich's original offload and copied receipt are hash-attested in its manifest. Earlier confounded
results and failed attempts remain in [matched-cash-results.md](matched-cash-results.md).

No additional full gym matrix is needed solely to select the view default. Seven business
journeys have evidence, but the historical zero-netting transcript still lacks two transport
receipts. Its two actual compactions establish retained business state, not compaction savings.
Effort/model comparisons and lean managed startup are separate follow-ups.
