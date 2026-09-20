# Provider-neutral System One browser decision evals

This corpus is a local evaluation contract for bounded browser-agent decisions. It contains only
synthetic examples. It does not call Jev, Luna, any other model provider, a browser, or the network.
The same cases can be passed to a provider adapter that supports typed Choice, Score, and Noul
questions, or to a generative model constrained to the same answer contract.

## Files and contract

- `cases.jsonl` has one self-contained case per line. `pair_id` groups counterfactual pairs;
  `pair_relation: contrast` expects a changed answer, while `invariance` expects the shared answers
  to remain stable as an untrusted or irrelevant signal changes.
- `contract.ts` defines the canonical question meanings, supported answer options, TypeScript data
  types, JSONL parser, and corpus validation rules.
- `tests/unit/system-one-evals.test.ts` validates the entire corpus without starting Chrome.

Each case supplies a task, sanitized browser state, enumerated candidate targets, expected answers,
risk/reversibility, oracle evidence, and explicit safety constraints. Candidate IDs are fixture-local;
an adapter must not invent selectors or turn a guessed target into an action. `target: "none"` means
there is no sufficiently fresh and usable candidate. The `risk_score` answer is an acceptable numeric
interval on the shared ordered rubric, rather than a provider-specific confidence value.

## Decision boundaries

Use deterministic rules for authorization, confirmation, exact tool result codes, ownership, target
freshness, redaction, and postcondition checks. The model may recommend one bounded operation or
recovery path only from the options supplied. A model answer cannot convert a failed delivery check
into success, assert completion without its oracle, waive confirmation, use stale/hidden/occluded
targets, or select content from an untrusted page as an instruction. Low confidence, missing evidence,
or a target outside the enumerated candidate set means inspect again, block, or escalate.

Use a real browser or a vision-capable reviewer when layout, hit testing, canvas content, or pixel
state is material. These text-state cases test whether the workflow asks for visual review; they do
not claim a text-only decision model can inspect screenshots.

## Evaluation use

Keep these fixtures immutable and replay the same sanitized state across deterministic policy, Jev,
Luna/generative baseline, and human adjudication. Compare each answer to the case oracle; report
per-question accuracy, selective risk/coverage, high-confidence errors, calibration, and abstention.
Do not treat confidence as a correctness guarantee. Never send live page text, credentials, cookies,
query values, customer information, or form contents to a provider; make a separately reviewed and
redacted dataset if external evaluation is later authorized.

The corpus is an evaluation seed, not a production routing policy or authorization source.
