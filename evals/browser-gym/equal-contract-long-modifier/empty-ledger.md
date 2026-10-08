# Browser QA Ledger

Candidate: 0de851742533a92b4cbe4220fff080993f069a05; product e7197b53d508068efabf28a45156697b1f21d048
Environment: Q:/web/mako2-haiku-websrm-gym; mako2_haiku_websrm_gym; dedicated DEV WebSRM
Project: mako2
Session: assigned owned browser allocation in tool-adapter.md; exclusive UI lane
Owner: tracked benchmark operator2067, work item8508
Migration: 446; unchanged fixture/certificate/taxes; print_receipt_notes=1
Login: http://127.0.0.1/mako2-haiku-websrm-gym/?test_scenario=1441700010&bench=equal-longmodifier01#s:login.php?lang_id=1,tables.php?lang_id=1&table_id=&invoice_id= ; full Michel Untel1441700010 station1
Assertions: exact item note from modifier-note.txt; one Pepsi;3.59+.18+.36=4.13; cash5/change.87; closed; readable pixels; independent accepted RQ/bill parity
Actions: one autonomous fresh long-modifier sale; no invoice yet
State: active; no previous pass applies
Budget: 0/60 browser calls;0ms of600000ms
Updated: 2026-10-08; fresh empty ledger

## Acceptance rows

| Row | Status | Commit at proof | Evidence | Next action |
|---|---|---|---|---|
| UI-boot | untested | none | none | Full cashier, live POS, initial pixels |
| UI-item-note | untested | none | none | One Pepsi and exact saved item note |
| UI-totals | untested | none | none | Quantity/subtotal/taxes/total/fresh ID |
| UI-payment-pixels | untested | none | none | Cash5 once, closed/change.87 and final pixels |
| SQL-RQ-bill | untested | none | controller-owned | Independent persisted/boundary/payload/printed parity |

## Fixtures and cleanup

- Created: none
- Temporary files: this directory; preserve owned tab/worktree/DB
- Cleanup: no fixture edits/refunds/reprints; controller checks unchanged configuration

## Open failures

- None yet

## Compact handoff

- Last completed row: none
- Current state: awaiting worker discovery/boot verification
- Invalidated assumptions: prior sale proofs do not qualify this invoice
- Exact next check: shared contract initial identity/pixels

## History

- Fresh contract and ledger; all setup/discovery/recovery calls count; controller SQL/RQ/bill pending.
