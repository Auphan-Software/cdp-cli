# Office-PC shared reranker deployment

Measured October4,2026 on the actual transcription host `office-pc`
(`Henry-Work-PC`,192.168.1.140): Windows11Pro, i7-6700K four cores/eight threads,
32GiB RAM, GTX1080Ti11GiB, driver560.94. SSH uses the newly installed OpenSSH.

## Capacity verdict

There is enough observed idle capacity to keep the0.6B reranker resident.
Before loading:5,075MiB GPU memory used,6,032MiB free,0% utilization.
With the service loaded/benchmarked: approximately6,101–6,284MiB used and
4,980–5,006MiB free. Incremental VRAM is about1.0–1.2GiB. The worker reached
1,307,455,488bytes peak working set (1.22GiB); later idle working set was
537,460,736bytes (0.50GiB). WDDM does not expose reliable per-process VRAM here;
the incremental GPU figure is a whole-card before/after observation.

The existing transcription process18916 remained running. ItsHTTPS status
reported healthy CUDA `large-v3`,int8_float32, speaker diarization enabled,
zero active jobs and one-job capacity before and after. No customer transcript
or artificial transcription job was submitted. **Peak transcription memory and
simultaneous transcription latency remain unmeasured.** Resident headroom and
idle ranking are established; strict priority or peak-load coexistence is not.

## Runtime and LAN latency

Qwen3-Reranker-0.6B task-aware binary classifier Q8_0,639,153,440bytes;
SHA256`18f099b292864fde542713d7c41aa4464860e11bc07b045b51543e9e59e6e7e7`.
Same vetted classifier bytes as the prior CPU/RTX4060 tests. llama.cpp is
pinned at`11fe02151f79c41d0d4af7da708755d73b9c0da6`,built withCUDA12.8.93,
MSVC19.44,architecture61 and forced quantized matrix multiplication for Pascal.
Native/AVX512 CPU compilation is disabled for the older office CPU. No GPU
driver, transcription Python environment or transcription process was changed.

One slot,8192-token context, two CPU threads, batch2048/microbatch512, all GPU
layers requested. The gateway chunks work into at most eight documents and
24,000characters of repeated query/document material. Inference activity was
observed on the real GPU; large cancellation probe reached95% utilization.

The following measurements include HTTP over the office LAN and gateway
admission/monitor overhead. First rows have nonzero inference tokens; repeat
rows hit the exact score cache. These short fixed inputs are not full tasks.

| Documents | First request | Cached repeats |
| --- | ---: | ---: |
|1|526ms|20–91ms|
|6|439ms|24–88ms|
|12|516ms|23–35ms|
|32|989ms|48–53ms|

All36 projections across12 saved browser fixtures returned`applied`; none
fell back. Nine projections with nonzero inference work had632ms median and
873ms observed maximum/p95; some reused scores for part of the request. The27
fully cached projections had86ms median,105ms p95 and136ms maximum. Cold
prompt cache, multiple agents and changing production states may behave differently.

The saved-fixture comparison retained the checked target/clue identities with
zero omissions, and reduced nodes90.9% and projected characters/estimated tokens
91.9% against the unfiltered structured view. This fixture includes substantial
repetitive irrelevant UI. It is **not91.9% savings in full-agent tokens**, and
the12cases are not a comprehensive recall annotation. Initial reporting assumed
flat IDs for row-scoped Alpha/Beta targets; corrected gold identities and exact
score reconstruction are explicitly recorded in the raw result. Selected views,
node counts and character counts were checked against recorded values.

Raw results: [office-gpu-workload.json](results/office-gpu-workload.json),
[office-gpu-cancellation.json](results/office-gpu-cancellation.json),
[office-gpu-deployment.json](results/office-gpu-deployment.json).

## Production routing and verification

The startup task`CDP-Reranker` serves`http://192.168.1.140:8125` through a
scoped192.168.0.0/16 Windows firewall rule. llama.cpp is inaccessible from LAN,
listening only on127.0.0.1:8126. The gateway accepts relevance requests only;
it cannot click, execute shell, read canonical state or handle screenshots.
Request text is not logged. A512-entry score cache stores hashes and scores,
bound to immutable model/runtime identity; changed tasks/documents miss.

Admission checks transcription before GPU inference and between microbatches,
requires zero active transcription jobs and at least2GiB free VRAM, and rejects
new uncached work when initial GPU utilization is25% or higher. Worker startup
and restart require4GiB free and idle transcription. The worker runs below
normal CPU priority. One gateway request is admitted; additional callers receive
503 without queuing. A2-second gateway ranking budget and2.5-second client
deadline prevent model work from indefinitely delaying browser evidence.

Cancellation was tested against actual worker execution, not only mocks. The
worker was seen processing, client aborted at267ms, and the worker/gateway were
idle again by1,560ms. Admission remains closed while the worker drains; a
wedged owned worker is terminated after bounded polling. This is not instant
GPU preemption. Transcription can begin during an in-flight batch and the
resident model still occupies VRAM. Monitor failure or capacity rejection is
an expected fallback, not a reason to retry or wait for transcription.

Five private browser workflow checks passed with the live LAN service,
including real CLI and owned-session MCP,PNG image delivery, stale rejection,
failed-wait recovery, and an unavailable-provider action. Testing exposed an
external-change observation gap: the workflow now keeps a per-profile capture
alias for automatic diffs, so changes remain protected after stale rejection
without requiring the agent to repeat its old source. Guard/alignment captures
do not advance that alias. Unstable/truncated/unreachable or unmodelled-text
captures bypass learned filtering; ambiguous/volatile keys stay protected.

Unit coverage:441 passed,9 optional skips,58.52% lines after the final diff
protection fixes. Existing
repository80%coverage target gap remains tracked. A flaky SIGINT test now waits
for the monitor's actual signal listener rather than relying on a30ms sleep.

Use2.2.1 clients with the URL/config described in
[browser-workflow.md](../../docs/browser-workflow.md). Busy, timeout, revision
mismatch or unavailable responses preserve the deterministic view in the same
tool call. Must-keep rules run before/after ranking; canonical expansion and
the existing browser agent remain available. `--full` and`CDP_RERANK_URL=off`
bypass it. No reranker receives action authority. CPU vision is not enabled.

Recommended default for office clients: deterministic capture/diff and pruning
→ shared relevance service within the deadline → deterministic view on failure
→ canonical expansion/existing browser agent when evidence is insufficient.
The earlier transcript-derived full-agent pilot motivates this track; actual
paired Mako2/WhiteTip2 token/tool-turn/latency and evidence-quality validation
remains required before claiming production end-to-end savings.
