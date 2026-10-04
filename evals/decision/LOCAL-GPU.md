# GPU assessment: total browser evidence workflow tokens

The RTX 4060 makes local reranking and occasional vision practical. The useful
result is the **complete Claude reproduction/evidence workflow**, not merely a
smaller state dump. On the controlled four-episode comparison, Qwen plus
action/observation fusion used 56% fewer recorded Claude tokens, 36% fewer
browser tool calls, and 22% fewer tool batches, with essentially unchanged
mean latency and the same independently verified success rate.

These are **transcript-derived controlled surrogates**, not live Mako2 or
WhiteTip2 investigations or a statistically established production improvement.
The real transcript workload and accounting rules are in
[TRANSCRIPT-WORKLOADS.md](TRANSCRIPT-WORKLOADS.md). The original CPU findings
remain in [LOCAL-CPU.md](LOCAL-CPU.md).

## Hardware, runtime and provenance

Windows laptop: RTX 4060 Laptop GPU, 8,188 MiB VRAM, driver 581.57; Ryzen 9
7940HS, eight cores / 16 threads, approximately 47.2 GiB system RAM. CUDA 12.8.93,
MSVC 2022, llama.cpp commit `11fe02151f79c41d0d4af7da708755d73b9c0da6`, CUDA
architecture 89. Same pinned model bytes as the CPU experiment; their complete
hashes are recorded in [cpu-environment.json](results/cpu-environment.json),
with upstream revisions in LOCAL-CPU.md. CUDA logs prove
layer offload and CUDA vision-projector execution.

Model services were bound to loopback only. Other existing Claude processes and
LM Studio were present on this shared laptop; desktop/GPU load was not exclusive.
The dedicated benchmarks ran sequentially. All owned model workers and private
Chrome processes were stopped afterwards. Office CT105 was not modified.

## Actual sustained Claude comparison

One fresh `claude-opus-5-5` conversation with medium effort runs each complete
task through observe/action/expand/screenshot/console tools. Both tasks require
four browser actions, a final screenshot, console evidence, and a correct
structured reproduction report. Private oracles verify the exact action trace,
final application state and referenced evidence. The agent has no arbitrary
shell, evaluation, filesystem or production-page tool.

The two tasks are history-restoration/cart failure and future-date/age
verification failure. Two repeats per task produce four episodes per arm.
All arms completed 4/4; no wrong browser action was delivered. The baseline
had one rejected stale/invalid proposal that required recovery. No arm requested
expansion. Optional retries and extra observations/images are included in usage.

| Arm | Verified episodes | Recorded Claude tokens | Browser calls / tool batches | Mean whole episode | Estimated dollars / success |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unfiltered structured-tool baseline | 4/4 | 1,546,813 | 50 / 32 | 20.4 s | $0.626 |
| Deterministic projection | 4/4 | 1,391,220 | 47 / 35 | 19.3 s | $0.524 |
| Deterministic + Qwen GPU | 4/4 | 762,188 | 48 / 29 | 22.2 s | $0.352 |
| Deterministic + Jev, separate cohort | 4/4 | 1,209,895 | 47 / 30 | 22.5 s | $0.518 |
| Deterministic + action/state fusion | 4/4 | 1,056,732 | 32 / 25 | 15.7 s | $0.503 |
| Qwen GPU + action/state fusion | 4/4 | 682,539 | 32 / 25 | 19.9 s | $0.342 |

Recorded tokens sum fresh input, cache creation, cache reads and output. This
sum measures processed token volume; it is **not uniformly priced billable
tokens**. Final CLI aggregate usage is counted once, not added to overlapping
streamed messages or modelUsage. The raw categories are preserved:

| Main arm | Fresh input | Cache creation | Cache reads | Output |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 72 | 270,070 | 1,272,185 | 4,486 |
| Deterministic | 78 | 223,265 | 1,164,011 | 3,866 |
| Qwen | 66 | 150,976 | 607,247 | 3,899 |
| Deterministic fused | 58 | 222,884 | 830,625 | 3,165 |
| Qwen fused | 58 | 149,706 | 529,505 | 3,270 |

Dollar estimates use Claude CLI's reported list-price model accounting, not an
invoice or subscription charge. Jev adds an estimated $0.0131 across its four
episodes: 311,744 input tokens at the current
[official $0.042/million input price](https://docs.typesafe.ai/models), output
free. GPU electricity, equipment and service operation are excluded. Failures
would remain in cost totals; this pilot had none. OpenAI Decisions was not
tested because its exact available contract/account access was not established.

Fusion, rather than relevance ranking alone, removes the separate observe
request after an action. Filtering alone saved tokens but added latency. The
fused comparison saved **864,274 processed tokens**, reduced estimated model
cost by 45%, and kept mean latency within 0.5 seconds of baseline. The faster
deterministic-fused arm is also useful: fewer calls and no ranking latency,
with smaller token/cost savings.

This baseline already returns screenshot pixels in one structured tool call.
It therefore does not include the historical Bash-screenshot then image-Read
split. The historical sessions also had large prior coding context, frames,
keyboard/drag interaction, database assertions and mobile checks, which this
pilot does not reproduce. These results cannot be applied as a percentage
discount to those original session totals.

## Exact score reuse

A follow-up matched comparison isolates the cache from fusion. The optional
bounded cache stores only scores keyed by exact task/document content and a
pinned model revision. Fresh unit identities are remapped; new content/tasks
miss. Must-keep rules and source validation still run. Cache settings are
immutable, disabled by default, and isolated to the provider instance. Recreate
the provider whenever the endpoint's model/runtime changes.

| Follow-up arm | Verified | Browser calls / batches | Provider calls | Provider time, all four episodes | Mean whole episode | Recorded tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen fused without score reuse | 4/4 | 33 / 24 | 25 | 19.44 s | 20.42 s | 678,739 |
| Qwen fused with exact score reuse | 4/4 | 33 / 24 | 8 | 8.99 s | 18.15 s | 670,159 |

The cache had 377 score hits. It reduced mean episode latency by about 11%
within this follow-up. It did not reduce browser calls; fusion supplied that
benefit. The approximately 1% token difference is small relative to model
variation and should not be attributed to caching as a proven token gain.

## Retention and delivered-state measurements

In the main cohort, all important named action/value/status targets remained
usable and all tasks succeeded, but the explicit broad gold-node metric was
**56/64 retained (87.5%)** for Qwen and Qwen-fused. Do not replace this with a
claim of perfect recall. Original rows did not preserve the identities of the
eight omitted nodes or a separate critical-node metric.

The follow-up added a critical subset and measured **42/42 retained** in both
Qwen arms, while broad gold remained 58/67. In that follow-up, the difference
was the redundant location paragraph: URL/hash still carried current location.
This distinction is explicit and postdates the main run; it does not
retroactively establish zero critical omissions for every earlier observation.
Future runs also record each omitted gold key. Deterministic must-keeps for
diffs, errors, dialogs/status, values, parents/context and navigation envelopes
remain ahead of every learned filter.

Across the main four episodes, Qwen-fused delivered 1,098 element records versus
2,262 in baseline (51.5% fewer), and 432,486 state-view characters versus
704,144 (38.6% fewer). Character/4 estimates were 108,132 versus 176,044 tokens.
These are cumulative agent-delivered observations, including differing
observation counts and diff/context envelopes; they are not per-snapshot recall
or actual tokenizer measurements. Raw canonical JSON is a different envelope
and must not be used as the character-reduction denominator.

Jev retained all the deterministic nodes on these conservative diagnostic
queries and did not further shrink that state representation. Its small API
price was not the dominant end-to-end expense; repeated Opus context was.
This does not establish that Jev never helps other tasks or decisions.

## GPU latency and memory

| Model / runtime tested | CPU latency from original experiment | Observed GPU latency | GPU resident snapshot / host peak working set |
| --- | ---: | ---: | ---: |
| Qwen3-Reranker-0.6B, classifier Q8 GGUF | 19.4–20.9 s full saved-fixture projection | 0.298 s p50 / 0.310 s p95, 36 projections | 1,926 MiB / 1.28 GiB |
| MiniCPM-V 4.6, Q4_K_M + F16 projector | 15.3–15.6 s screenshot choice | 0.576–0.757 s, median 0.659 s | 1,914 MiB / 1.28 GiB |
| Qwen3-VL 2B, Q4_K_M + Q8 projector | 8.42–8.70 s screenshot choice | 0.415–0.573 s, median 0.431 s | 2,918 MiB / 1.76 GiB |

VRAM figures are whole-device resident snapshots, including desktop/other
process overhead, not instrumented lifetime peaks or allocations attributed
solely to the model. Host values are owned worker process peak working sets.
Observed warm-cache worker startup was 1.39 s for reranker, 3.80 s for MiniCPM
and 2.34 s for Qwen-VL; these are not cold-disk download/start figures.

Short-input reranker batch median latency was 25 ms for one document, 108 ms
for six, 208 ms for 12 and 558 ms for 32. The 12/32-document cases each have one
sample. **The more cluttered agent workflow is slower than those saved fixtures:**
ranking many independent catalog regions took about 1.9–2.5 s initially, and
uncached repeated calls added roughly 4.4 s per complete episode. Do not promise
300 ms for arbitrary full CDP pages. Score reuse reduced that repeated overhead.

Reranker and Qwen-VL were also loaded together: 4,835 MiB whole-device resident
snapshot. Three overlapping six-document ranking and screenshot requests
completed in 0.32–0.77 s; ranking was 0.13–0.51 s. This is a co-residence smoke
check, not a concurrency SLA or thermal/load endurance test. Their CUDA layers
and projector remained offloaded. ShowUI and 7B–8B GUI models were not pursued.

## Vision usefulness and routing recommendation

Both local vision models chose correctly on 3/3 constrained screenshot cases.
Their text-only paths guessed one constant card and were correct on only 1/3.
Semantic-only and Luna text-only paths correctly abstained without visual
evidence. Fresh Luna screenshot choices were 3/3 at 3.98–5.49 s, including an
independent CLI launch per choice. This external comparator has different
startup overhead from an already-running browser agent.

Image filenames are now opaque rather than the expected card label, including
the images attached to Luna. The local endpoints receive pixels only. Earlier
CPU Luna attachment filenames were label-derived, so treat that earlier Luna
image comparator cautiously; the fresh opaque-name GPU-run comparator is the
preferred external comparison. Local CPU vision endpoints did not receive those
filenames. No confidence from generated choices qualifies automatic execution.

**Keep Qwen3-Reranker-0.6B for the GPU track**, using the tested CUDA classifier
Q8 runtime, exact bounded score reuse and protected evidence. This is the best
tested configuration here, not proof that Q8 beats untested FP16 GPU runtimes.
It is a credible replacement candidate for paid *relevance filtering*, with
real-application recall/evidence validation still required. Jev remains useful
for bounded decisions or uncertain evidence; its price alone is not a reason
to rank every observation remotely.

**Keep Qwen3-VL 2B as the preferred GPU vision comparison**, with MiniCPM as a
lighter alternative. Both are fast enough for rare ambiguity resolution on this
hardware, but three simple cards do not validate actual Mako2 dialogs, iframe
grounding, small text or misleading content. Keep an external agent/vision
fallback with deterministic execution checks; Decisions access remains untested
and the Luna comparator is unqualified for automatic execution. On CPU-only
Office CT107, keep external vision and
avoid Qwen relevance inference on every live step.

Recommended experimental GPU routing:
deterministic replay → exact semantic relocation → protected deterministic
projection → cached local Qwen ranking for substantial omitted content → rare
bounded local vision suggestion → Jev/available external Decisions → browser
agent → stronger diagnostic/coding agent. Return a fresh observation with each
action and gather screenshot artifacts with source identities. Expand canonical
state or escalate on uncertainty. Provider choices remain behind `projectState`
and `decideNext`; the CDP core has no mandatory model dependency.

Promote a default only after live Mako2 and WhiteTip2 paired reproduction/evidence
episodes confirm lower complete-agent token/cost consumption, equal evidence
quality and roughly equal or better latency. The GPU service was tested on the
laptop's loopback; Office LAN deployment and service uptime were not measured.

## Reproduction and validation

Start the pinned worker with `gpu-worker.ps1`, then use `cpu-batch.mjs` and
`gpu-workload.mjs` for endpoint/projection measurements. The opt-in sustained
test uses `CDP_CLAUDE_WORKFLOW=1`, `CDP_WORKFLOW_REPEATS=2`,
`CDP_WORKFLOW_ARMS=baseline,deterministic,qwen,deterministic-fused,qwen-fused`,
`CDP_DECISION_LOCAL_URL` and `CDP_WORKFLOW_RESULTS`. Jev credentials are supplied
only through an ephemeral environment; never write a key to a config/report.
Run cached comparison separately with `qwen-fused,qwen-cached-fused`.
`summarize-gpu.mjs` produces [gpu-summary.json](results/gpu-summary.json).

Build passed; 432 unit tests passed (nine optional skips), 40 standard live
tests passed, 32 opt-in sustained Claude episodes and both GPU vision comparisons
completed. Overall line coverage is 59.11%, below the repository's 80% target;
the pre-existing coverage gap remains tracked separately. No weights or
credentials are committed. Exploratory runs with weaker/incomplete report
validation are excluded from the final comparisons.
