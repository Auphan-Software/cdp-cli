# Compact reporting contract for paired browser trials

Apply this identical section to both native and CDP trial contracts before
hashing their immutable inputs. It replaces the contract's reporting section;
do not append it alongside contradictory per-row ledger instructions.

Keep required UI findings and evidence references during the journey. For this
bounded single-session trial, write the final artifacts after browser work:

- Write `result.json` once, as compact valid JSON of at most4096 UTF-8 bytes.
  Include outcome, case/candidate/fixture and browser identity, invoice/txn IDs
  when observed, initial/final screenshot references when returned, observed
  cashier/item/note/totals/payment/change, counts, recovery and delivery
  uncertainties, evidence gaps and cleanup. Reference evidence; do not duplicate
  tool receipts or narrate the journey. Preserve exact task values and all
  failures; the size budget is never permission to omit material uncertainty.
- Write `job.qa.md` once, as a compact ledger of at most4096 UTF-8 bytes. Update
  the existing UI rows, leave controller SQL/RQ/printed-bill rows untested, and
  add one short History entry. Preserve required existing rows and evidence
  references. If required content exceeds the budget, retain it and report the
  overrun rather than silently truncating it.
- A successful Write result confirms storage. Finish after both writes with
  outcome, invoice ID, artifact paths and pending controller checks in at
  most500 characters. Read/rewrite a completed report only to recover an actual
  failed write or a concrete discovered correctness problem; state the reason.

Early BLOCKED/FAIL follows the same compact artifact procedure. A required
checkpoint or actual context renewal overrides write-once: persist the minimum
recovery state and identify the reason. Never omit durable recovery evidence
just to reduce the measured cost.

The controller validates JSON, required fields, ledger preservation and evidence
independently. Malformed/incomplete output remains a failed reporting contract;
do not silently repair it and claim the actor passed. Retain all actor reporting,
failed writes, corrections and cache usage in the complete trial score. Also
publish setup/browser/reporting phase subtotals so reporting behavior cannot be
mistaken for browser execution efficiency.
