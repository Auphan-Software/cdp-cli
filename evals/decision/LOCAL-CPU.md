# Office CPU comparison — 2026-10-03

Keep deterministic pruning as the default. Qwen3-Reranker-0.6B is useful as an
optional offline/private ranking tool, but **does not replace paid relevance
filtering for interactive full-state projection on this Xeon**. CPU vision can
resolve a simple screenshot ambiguity; external Luna is faster in these tests.
Keep local vision optional and unqualified for automatic execution.

## Environment and scope

Created fresh **CT107 `cdp-model-eval`, 192.168.3.107**, on office Proxmox `arcturus`
at 192.168.3.40. CT105 is the protected Jarvis/PostgreSQL runtime and was only
inspected as a reference; no cloning or changes to it occurred. Debian 13,
unprivileged, 64 GB ceph-lxc disk, 16 GiB memory, zero swap, eight assigned CPUs,
eight-CPU quota, low CPU weight, no automatic startup. The host has two Xeon
E5-2623 v4 CPUs: eight physical cores, sixteen logical threads, AVX2/FMA, no
AVX512. Assigned CPUs are shared and span NUMA nodes; they are not exclusive cores.

All local inference ran inside CT107, not on the Windows GPU. llama.cpp was built
with CUDA/Vulkan disabled; vision used `--no-mmproj-offload`. No GPU device was
exposed. Actual parent cgroup limits were 17,179,869,184 memory bytes, zero swap,
and `cpu.max=800000 100000`; the nested container namespace reports `max`, so
the parent limits were verified on Proxmox. No OOM kills occurred. File cache and
conversion pushed aggregate container memory near the limit; sampled model RSS
below excludes that shared cache. Host load varied, and these are deployment
observations on a shared office host, not exclusive-core laboratory benchmarks.

Runtime: llama.cpp `11fe02151f79c41d0d4af7da708755d73b9c0da6`, GNU 14.2,
CPU build, one server slot, context 4,096. Reference: Python 3.13,
Transformers 5.18.0, PyTorch 2.14.1+cpu. Model files and runtimes remain under
`/opt/cdp-eval`; CT107 is stopped after the experiments, retaining its files.

Twelve controlled browser fixtures compare baseline, deterministic pruning,
deterministic + real Jev, and deterministic + real Qwen. Each actual Luna paired
track ran once per task/arm; the separate Jev scripted-selector track ran three
repeats. Luna is the authenticated Codex CLI `gpt-6-luna`, constrained to choosing
one allowed action without tools. This measures real downstream model use and
one-step fixture effects, **not a multi-step browser-agent task-completion rate**.
Full states are masked, preserved, and exportable in
[fixture-dataset.json](results/fixture-dataset.json).

## Paired state filtering

The unfiltered agent view includes context annotations, so reductions below are
relative to that 31,135-character view, not the smaller raw canonical JSON.
“Lines” means represented semantic nodes, one node per state line. Estimated text
tokens are characters/4; actual Luna usage includes its system instructions and
cached input and is reported separately.

| Track | Mean lines | Line reduction | Mean characters | Character/estimated-token reduction | Projection p50 / p95 |
|---|---:|---:|---:|---:|---:|
| Unfiltered | 172 | 0% | 31,135 | 0% | about 1 / 3 ms |
| Deterministic | 141.1 | 18.0% | 21,273 | 31.7% | about 1 / 4 ms |
| Deterministic + Jev region | 100.8 | 41.4% | 15,158 | 51.3% | 257 / 386 ms |
| Deterministic + Qwen Q8 region | 15.7 | 90.9% | 2,507 | 92.0% | 19,357 / 20,913 ms |

Both learned filters applied successfully in all twelve final paired runs, with
100% recall and zero false negatives for the 84 specified important-node checks
across each arm. Gold combines six safety nodes, the requested action target,
and the unchanged “Account frozen” clue where required. Most safety gold is
protected by deterministic rules, so this small result does not establish general
learned-filter recall. All models are unable to remove protected diff changes,
alerts/dialogs/status, replay targets, values/selections, focus/editable controls,
parent context, exposed browser/console/network errors, or location context.

| Downstream Luna track | Correct actions / fixture verdicts | Wrong fixture clicks | Escalations | Actual total tokens saved versus paired baseline |
|---|---:|---:|---:|---:|
| Jev run: unfiltered | 10/12 | 0 | 3 | 0 |
| Jev run: deterministic | 10/12 | 1 | 1 | 43,522 |
| Jev run: Jev projection | 10/12 | 1 | 1 | 63,372 |
| Qwen run: unfiltered | 10/12 | 1 | 1 | 0 |
| Qwen run: deterministic | 10/12 | 1 | 1 | 43,475 |
| Qwen run: Qwen projection | 10/12 | 2 | 0 | 101,535 |

Luna sometimes clicked a genuinely ambiguous account row. With Qwen projection,
it also substituted Submit for the synonym task “Commit the order.” Therefore
preserving every gold node and reducing tokens is insufficient to authorize
automatic decisions. The independent bounded Jev selector used the existing
confidence/margin guard: action-only got 24/36 correct fixture verdicts, and
filter + action got 21/36, with zero wrong clicks but substantial escalation.
The scripted downstream selector achieved 36/36 with Jev region projection;
that difference is why scripted results must not be called browser-agent accuracy.

The Qwen paired track used 26,592 local prompt tokens for twelve projections and
saved a further 58,060 total downstream tokens beyond deterministic pruning.
Jev used 236,765 provider input+output tokens and saved a further 19,850 downstream
tokens beyond pruning. Its current adapter repeats unit text in state and question
instructions; future deduplication may lower that overhead. The public
[Jev price](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is
$0.042/million input tokens, with free output. Treating all reported provider tokens
as input gives a conservative upper bound of **$0.00995 for the twelve projection
calls**, about $0.00083/call. This is a price-based estimate, not an invoice.

No real observe/expand calls occurred in the bounded selector, which forbids
tools; oracle expansion requests were zero. Actual agent expansion overhead,
multi-step completion, and **end-to-end cost per successful task remain unmeasured**.
Codex subscription usage and CPU time cannot be converted to API dollars without
account pricing and an infrastructure cost model. Cached tokens differ between
runs, so total tokens saved are not equivalent to billed dollars saved.
See [local-summary.json](results/local-summary.json) and its raw paired files.

## Qwen CPU runtime and batch results

Scoring was checked against the
[official Qwen recipe](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B): final
answer-position logits, softmax over yes/no only, no generation-based relevance.
Official weights are pinned at `e61197ed45024b0ed8a2d74b80b4d909f1255473`.
The CPU reference scores Save at 0.75123 and a catalog paragraph at 0.003212.
The task-template classifier Q8 scores were 0.78717 and 0.002444; Q4 gave 0.58823
and 0.01534. These are uncalibrated relevance scores; Q4's larger drift favors Q8
where evidence quality matters.

The current [converter](https://github.com/ggml-org/llama.cpp/blob/master/conversion/qwen.py)
extracts classifier rows [yes, no]; the
[RANK graph](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-graph.cpp)
applies two-element softmax, and `/rerank` returns element zero. The adapter does
not apply a second sigmoid. `build-classifier.py` changes only the GGUF task
instruction to match the reference and asserts exactly one replacement.
The full causal-LM GGUF adapter instead normalizes pre-sampling yes/no logprob
differences and rejects missing scores or truncation. It explicitly disables
repetition penalties. Both preserve the official special-token suffix.

| Runtime | 1 short candidate | Batch 6 | Batch 12 | Batch 32 |
|---|---:|---:|---:|---:|
| GGUF Q8, 8 threads | median 0.739 s | median 4.441 s | 8.700 s | 22.756 s |
| GGUF Q8, 4 threads | median 0.827 s | median 4.807 s | 9.696 s | 25.609 s |
| GGUF Q4_K_M, 4 threads | median 0.597 s | median 3.772 s | 7.396 s | 19.809 s |
| Transformers FP32, 8 threads | median 0.520 s | median 2.983 s | 4.789 s | 11.846 s |

Single/batch-six cells use three repeated requests; larger batches have one sample,
so do not interpret them as p95 values. These are short 89–98-token documents.
The actual four-region Save workload totals 2,225 tokens, including one long
region. FP32 padded batching took **41.326 s**, whereas final Q8 per-task projection
took about **19–21 s**. Padding makes short-batch throughput a poor predictor of
full-state usefulness. Eight threads slightly beat four for Q8 here; no global
claim about Xeon tuning follows from this shared-host trial.

Observed resident memory: classifier Q8 about **1.68 GiB**, Q4 about **1.18 GiB**;
FP32 reference peak **3.77 GiB** for two short queries, with full-region FP32 peak
not captured. Cache-warm model startup was approximately 1.1 s for the original
Q8 server. This is not a cold-disk startup benchmark.

Initial JSON-rich region prompts exceeded the 4,096 context budget and fell back
atomically. Compact line documents fixed that, but full-head top-100 logprob
results sometimes omitted yes/no and correctly fell back. Final classifier Q8
removed that failure mode. Startup-race pilot batches are retained but excluded
from the table; final batch runners wait for `/health` readiness. No further
per-node/hybrid optimization was justified: even 32 tiny candidates require
12–26 s, so scoring every node is unsuitable for each browser step.

**Worth keeping:** Qwen weights and the provider-neutral adapter for offline,
privacy-required, or tiny candidate sets. **Best practical tested runtime:** Q8
classifier GGUF for whole-region ranking and memory; FP32 batching for small,
similarly sized documents if extra memory is acceptable. Quantization did not
automatically produce the best throughput. Neither is an interactive paid-filter
replacement on this host.

## CPU vision and fallback comparison

Three 640×320 browser screenshots put a green check on different A/B/C cards.
The semantic state contains card labels but no visual clue. Models choose from
A/B/C/escalate with a constrained JSON schema. IDs are random and digests opaque;
screenshots and choices originate from the same reset. An early answer leak in
the fixture metadata was found by independent review, fixed, and rerun. Those
earlier files are explicitly marked `confounded` and excluded from accuracy.

| Path | Correct visual choice | Escalations | Observed latency |
|---|---:|---:|---:|
| Semantic-only abstention | 0/3 | 3 | under 1 ms |
| Jev text-only | 0/3 | 3 | 117–208 ms |
| MiniCPM text-only | 1/3 | 0 | 3.45–3.59 s |
| MiniCPM-V 4.6 CPU screenshot | 3/3 | 0 | **15.32–15.63 s** |
| Qwen3-VL 2B text-only | 1/3 | 0 | 6.14–6.81 s |
| Qwen3-VL 2B CPU screenshot | 3/3 | 0 | **8.42–8.70 s** |
| Luna text-only | 0/3 | 3 | 3.58–3.96 s |
| Luna screenshot | 3/3 | 0 | **3.52–3.64 s** |
| OpenAI Decisions text/screenshot | unavailable | — | no endpoint/account contract available |

Abstention is the correct semantic response to missing visual evidence; 0/3 is
not a semantic-tool failure. Three simple icons are smoke evidence, not a general
GUI accuracy benchmark. Small text, disabled controls, instructions embedded in
screenshots and candidate permutations need broader testing. Confidence generated
by a vision model is not calibration: local proposals explicitly carry
`executionQualified=false`, and guarded decisions reject them at any threshold.
Stale screenshots are rejected before model inference.

MiniCPM used official Q4_K_M plus F16 projector, `--reasoning off`, four CPU
threads, no GPU, one screenshot. The official model combines a 0.8B language
backbone with a roughly 0.4B vision encoder; the requested “1.3B” is a rough
combined size. Revision `afe9accb78d2995d214cd912920c9c92f4015faa` of the
[official GGUF repository](https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf)
and the [linked deployment guide](https://github.com/OpenSQZ/MiniCPM-V-CookBook/blob/main/deployment/llama.cpp/minicpm-v4_6_llamacpp.md)
were used. Observed post-inference RSS **2.27 GiB**, cache-warm startup **2.8 s**.

Qwen3-VL used official Q4_K_M with Q8 projector from revision
`52d6c8ffea26cc873ac5ad116f8631268d7eb503` of
[Qwen's GGUF repository](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF),
four CPU threads, no offload. Observed post-inference RSS about **2.90–3.09 GiB**,
cache-warm startup **3.1 s**. Qwen is the better local vision candidate here, but
external Luna remained faster. We stopped after a meaningful bounded baseline;
no extensive Qwen vision tuning, optional ShowUI, or 7B–8B GUI-model work was done.

OpenAI Decisions was not available in installed tools, credentials or a verified
public API contract. It remains an explicitly unavailable comparison arm;
Responses/Structured Outputs was not silently substituted. Actual Luna access
does not establish Decisions API access.

## Recommended routing

1. Exact deterministic replay, then unique semantic relocation. Require fresh
   target ownership and verify the recorded semantic transition after execution.
   Truly ambiguous or incomplete replay hands off instead of fuzzy matching.
2. Deterministic pruning and all must-keep evidence. Preserve the canonical state
   and explicit expansion manifest regardless of provider outcomes.
3. Optional local Qwen projection only for offline/privacy needs or small candidate
   sets with a hard latency budget. Skip whole-state local ranking by default.
4. Optional Qwen3-VL for rare offline screenshot ambiguity with an explicit
   10-second allowance; MiniCPM is slower here. Local visual choices require
   independent qualification before automatic execution.
5. Optional Jev region filtering for large semantic dumps; guarded Jev bounded
   text decision where evidence is sufficient. Add the real OpenAI Decisions
   provider when its contract and access are supplied.
6. Luna/browser-agent fallback for screenshots, additional observation and task
   reasoning; stronger diagnostic/coding agent for unresolved ambiguity, errors,
   failed transitions or missing evidence.

The opt-in `routeNext` experiment tests this sequence through provider-neutral
interfaces. Unit contracts verify replay/relocation skip models, ambiguous replay
hands off, safeguards survive projection, and an unqualified local visual choice
falls through to a qualified paid decision. It proposes actions only. The default
CLI core, recorded journal schema and execution path are unchanged. This is a
tested routing scaffold, not measured completion of the entire autonomous ladder.

Build, 427 unit tests and 40 live tests pass (optional tests are separately skipped).
Independent review fixed answer leakage, scoring/usage errors and duplicate replay
identity handling before final results. Repository coverage is approximately 59%, below its historical
80% target, tracked by `cdp-cli-yr7`. Remaining real multi-step routing, expansion,
calibration, Decisions access and dollar-cost work is tracked in `cdp-cli-ozz`;
the credential-backed fixture work updates `cdp-cli-d1p` without closing that
broader browser-agent evaluation.
