# Matched Haiku cash trial, 2026-10-08

Same product candidate `e7197b53d508068efabf28a45156697b1f21d048`, tool build
`0be2dd235c7f7dbae7eb1e4884832fd02924b89a`, cashier, DEV fixture seed and operator prompt
SHA256 `863c0a502886e8a358f6bd0f7c6eaef24ba15d9b63afe49de4647ba5374e0ae3`.
Both actual workers used `claude-haiku-5-5`, medium effort and the 250k CLI window.
Each created a unique invoice and external RQ transaction; the database was not rewound
between arms. This is one sequential pair, not a randomized reliability estimate.

| Measurement | current-24k, agent2046 | rich-64k, agent2047 |
| --- | ---: | ---: |
| Controller business checks | 7/7 | 7/7 |
| Invoice | 150377 | 150378 |
| Recorded assistant tokens, all native epochs | 3,057,684 | 2,568,832 |
| Independently priced recorded assistant usage, USD | 0.245744 | 0.236421 |
| Native session report, API-equivalent USD | 0.258686 | 0.247006 |
| All tool calls | 38 | 29 |
| Admitted workflow actions | 6 | 5 |
| Context epochs | 2 | 1 |
| Native compaction boundaries | 0 | 0 |
| Peak input request | 204,754 | 188,441 |
| Host offloaded MCP results | 0 | 1 |
| Host truncated MCP results | 1 | 0 |
| Complete transport/profile audit | unavailable | verified |

Both bills contain one Pepsi, subtotal3.59, TPS0.18, TVQ0.36, total4.13 and accepted RQ identity.
Persisted cash tender5.00, change0.87, closed invoice, one accepted ARG transaction and no
pending request were independently checked. Bills do not print tender/change; payment parity
uses persisted payment rather than inventing absent bill text.

The rich arm used 16.0% fewer recorded tokens and approximately3.8% less recorded-assistant
API-equivalent cost in this pair. Those differences are descriptive, not validated savings:
the current arm had an unrelated Jarvis clear/reseed before bill review and an incomplete
transport receipt. Both current native epochs are included. Rich's first counter action returned
about74,433 host-formatted characters, exceeding the inline tool limit; the model made three
file extraction calls. This arm measures that actual mechanism, not uninterrupted inline64k use.

The current arm's stale response was a structured, explicit no-delivery refusal within24k.
Claude's error handler kept first/last5000 characters and inserted a truncation marker. Full JSON
was lost with no saved host artifact. The audit records one unavailable receipt/source transition;
it cannot infer profile/source from fragments. The subsequent payment was not duplicated.
The bridge fix returns narrowly recognized stale refusals as normal MCP text with `success:false`;
unexpected and ambiguous failures remain MCP errors. A clean paired rerun remains required.

An earlier aborted setup attempt, agent2045, made no workflow calls and consumed555,373
recorded tokens, USD0.017580 recorded-assistant estimate /0.017811 native report. It is retained
as setup cost and excluded from this pair's descriptive comparison, not silently discarded.
Neither price column includes Codex controller/qualification costs or measures a Claude Max bill.
Native reports are supplemental because exported assistant usage does not explain every session charge.

Raw source: `Q:/apps/jarvis/logs/investigations/haiku-websrm-gym/matched-score.json`, per-arm
`run.json`, native JSONL snapshots, controller `proof.json`, SQL evidence, boot and bill reviews.
Rich's offloaded result is preserved with its original path and SHA256 in its run manifest.

Next: verify the stale fix through Claude, run qualified hard cases, then repeat promising views
from equivalent snapshots. Reduce launch/tool-schema context and test renewal separately before
promoting a cheaper view or claiming compression caused the observed difference.
