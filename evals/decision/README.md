# Optional decision-provider experiment

Recommendation: use canonical captures, deterministic compact views and explicit
semantic transition checks first. Keep learned relevance filtering opt-in. A bounded
choice endpoint is a plausible escalation stage, but these results do not establish
that Jev improves real browser-agent accuracy, latency or cost.

## Scope and architecture

`src/experimental/decision.ts` exports `projectState(task, canonical, options)` and
`decideNext(task, view, allowedActions, provider)`. Providers implement two methods;
the core contains no Jev import, credential lookup, HTTP or browser execution.
Nothing is connected to the default CLI command path. The only shared change is an
opt-in `experimentalHints` argument to the capture expression; ordinary captures
keep their existing output shape. There is no new stable CLI verb or recording schema.

Canonical means the **entire captured PageState**, not a complete DOM. Existing
capture truncates labels to 120 characters, caps elements, masks values, and has
frame/coverage limits. Projection cannot recover evidence capture never observed.
The experimental hints supply represented ancestor keys, region identities,
non-value container descriptors, live-region membership, editability and focus,
including open shadow roots. Hints are only available to the opt-in browser eval;
the ordinary state command does not yet persist them. Arbitrary ancestor text,
transient alerts and console/network journals are still outside capture coverage.

The deterministic stage removes unprotected hidden elements, duplicate name/text
within one node, layout boxes and default visible/enabled attributes. It keeps
identity quality. It does **not** deduplicate repeated row controls, suppress
unknown changes, or discard all unchanged state: those operations can hide useful
diagnostic evidence. Focus has one explicit top-level representation. Diff records
are passed through without rewriting or truncation; callers must supply the full
stored/computed diff, not a CLI line with omitted changes. A mismatched diff is rejected.

Must-keeps include every changed key, removed-node evidence in the diff, alerts,
errors, statuses/logs/dialogs, editable/value-bearing controls, focus, all exposed
checked/selected/current/pressed state (including false), known record/replay
targets, task words, live-region membership and represented ancestor closure.
Navigation, coverage, native dialog summaries and supplied console/network/browser
errors stay outside provider control. Providers can select existing units only.
Invalid selections/failures restore the entire deterministic view atomically.
Newly selected nodes also restore their represented ancestors.

`expandState(view, canonical, keys?)` returns clones from that same snapshot after
checking snapshot/digest/target/session. It assumes a trusted immutable store; it
does not recompute store integrity. Expansion handles omitted capture nodes, not
uncaptured DOM or regions. The omitted manifest stays constant-sized to avoid
giving back the compression savings as a giant list of keys.

Bounded actions are proposals. They require valid candidates, complete exposed
coverage, confidence and margin thresholds, and strong visible/enabled targets.
No model produces executable JavaScript, selectors or actions outside the allowlist.
Before execution, use `resolveProposedTarget` against a fresh canonical capture;
then use the existing deterministic input commands, which recheck target uniqueness.
Generic providers are responsible for bounding their asynchronous operations.

## Optional Jev adapter

`src/experimental/jev.ts` implements the first-party
[TypeSafe HTTP contract](https://docs.typesafe.ai/api): pinned `jev-1.13.0`, Noul
relevance questions and Choice over caller-supplied action IDs. No third-party proxy
endpoint is used. Keys come from `JEV_API_KEY` or `TYPESAFE_API_KEY`, supplied through
the existing environment secret mechanism. No accessible key was found in the
project/current, user or machine environment during this experiment. Transcript
credentials were not copied into code, fixtures or result files.

Relevance is batched into six questions per request. Noul below 0.1 means discard;
otherwise keep. Action acceptance uses top-option probability >=0.9 and runner-up
margin >=0.2. These thresholds are **uncalibrated experimental policies**, not
evidence of correctness. HTTP failures, bad answers and incomplete probability maps
fail closed. No automatic retry amplifies cost. A projection has a five-second
time budget and a 32-call preflight cap by default. Each sequential request gets
only the remaining budget. Hybrid makes two bounded projection operations.
Tokens missing from the response are marked unavailable rather than reported free.

## Reproduce

Build before running live tests. Tests launch and stop their own private Chrome;
they do not attach to the user's browser or production app.

```powershell
npm run build
npm run test:coverage
$env:CDP_DECISION_EVAL_METRICS = 'Q:\apps\cdp-cli\evals\decision\results\synthetic.json'
node node_modules/vitest/vitest.mjs run --config vitest.live.config.ts tests/live/decision-eval.live.test.ts
```

For an explicitly credential-backed run, set `CDP_DECISION_REAL_JEV=1` and supply
the key through the existing environment mechanism. Choose a different metrics
path; do not overwrite the mock reference. The flag replaces the mock in the
filter/action arms. Keep the error/coverage/identity checks even when an arm loses.

The mock is an intentionally limited lexical relevance classifier plus a scripted
bounded selector. Its counted calls simulate the adapter's six-question batching;
they are not HTTP calls. The downstream selector is the same across all arms and
never sees fixture case names or expected targets. Its synonym/context rules are
handwritten, so this is **not** Luna/Sol browser-agent completion evidence.

## Controlled eval and interpretation

`workbench.html` supplies 12 tasks, three repeats and deterministically randomized
arm order: 396 executions, 36 runs per arm/granularity. Every task/arm sees the
same initial capture, reset page, candidate actions and executor. Metrics compare
the complete contextual agent view to its compact variants; raw canonical byte
size is also recorded. This isolates projection effects from capture/batching gains.
The full-view baseline is not a measured current LLM browser-agent arm.

Gold target IDs, required diagnostic clues and DOM-side click/effect counters are
separate from provider inputs. There are two delivered-no-effect controls and one
ambiguous-target handoff. Projection time excludes capture, HTTP and downstream
agent reasoning. Text-token figures are bytes/4 estimates, not tokenizer usage.
`oracleExpansionRequests` is a counterfactual request count: no agent discovered
the missing clue. Actual task steps, downstream calls and total model tokens remain
unmeasured. Grouped metrics are normalized per arm/granularity; do not compare raw
totals from four filtering granularities against one baseline arm.

See [REPORT.md](REPORT.md) and [raw paired metrics](results/synthetic.json).

## Record/diff and TesterArmy concepts

The current actions/1 journal stores argv, stable frame selectors and placeholders
for fills/query-bearing URLs. It does not store transient DOM IDs as a dedicated
identity system; a caller may still choose brittle CSS selectors. Ordinary replay
verifies command success/delivery. Explicit `state click --spec --exit-on-fail`
can verify a semantic transition using fresh before/after captures. Its expectation
file remains an external dependency, not a durable effect witness in the journal.

The experimental replay module demonstrates descriptors with role/name/frame and
container context, strong exact matching, conservative semantic relocation when
an identity changes, and handoff for ambiguity/missing/weak identity. It rejects
same-key controls whose semantics changed and never fuzzy-matches names or uses
ordinal fallback. Same-session stale-key relocation is tested in real Chrome.

`verifyReplayEffect` requires a `mustChange` assertion. Appeared/gone/field anchors
use existing diff kinds; from/to values can assert the recorded semantic effect.
An already-present “Saved” message cannot count as a new success transition.
A name change alone is not a business oracle: production must assert meaningful
totals/persistence/dialog/value effects and may require reload or database evidence.
Delivery, change and business effect should remain distinct outcomes.

These are evaluations of the concepts in the user's request, not a port of
TesterArmy internals: no source/version for that framework was available here.
Journal schema upgrades, integration with state storage, event journals and real
agent ablations remain follow-up work; the experiment does not alter actions/1.
