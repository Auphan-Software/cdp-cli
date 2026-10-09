# Reduced-image and coordinate benchmark

The original hard WebSRM contract is unchanged: a fresh Counter order, one Pepsi,
an exact 141-character item note, cash5/change0.87, accepted DEV fiscal request,
no pending request, printed parity and unchanged fixture. Haiku5.5 medium uses
CSS1234x676 with routine617x338 images. Native coordinates remain CSS pixels;
workflow coordinates use delivered image pixels and source-bound mapping.

## Retained attempts

| Attempt | Independent outcome | Processed tokens | Browser calls | Images | Recorded estimated API USD |
|---|---|---:|---:|---:|---:|
| Native01 | Blocked: opened retained order; no new business effects claimed | 240859 | 9 | 2 | 0.01414132 |
| Native02 | Incomplete: exact literal copying refusal;1/8 checks | 491537 | 21 | 7 | 0.01856699 |
| Visual02, b032a888 | Complete:8/8, invoice150399 | 2694139 | 40 | 29 | 0.08516727 |
| Hybrid02,8efb331 | Blocked: cashier precondition; no invoice | 383343 | 11 | 8 | 0.01487416 |
| Native03 | Complete:8/8, invoice150400 | 716092 | 28 | 10 | 0.02443165 |
| Hybrid03,8efb331 | Complete:8/8, invoice150401 | 849727 | 17 | 13 | 0.02707562 |
| Hybrid04,8efb331, strict image policy | Complete:8/8, invoice150402 | 981230 | 25 | 8 | 0.02645409 |

Visual02 independently verified exact note persistence, one cash payment,
accepted txn36, no pending request, and actual printed pixels from
C:/autoprint/20261008213135.png. Printed SHA256:
6e11a54026c36152e6c3f4abcee9a271f877b8aa61803584e09bd807028a40c6.
The controller viewed the printed receipt, including taxes, fiscal transaction,
and the121-character repeated sequence at the truncation boundary.

Visual02 includes the erroneous initial prepared-gate stop and corrective
continuation, all failed calls and all recorded assistant usage. It made17
observe calls,21 acts,1 screenshot and1 snapshot. Twelve coordinate refusals
were counted; those are not twelve business delivery failures. Complete raw
transcripts and independent evidence remain in the local benchmark directories.

Native03 independently passed all eight checks, including exact141 note,
single cash payment, accepted txn37 and actual printed pixels from
C:/autoprint/20261008215602.png (SHA256
1a4add831da7a4d31018875cd950aa97459e6662251c54f3c2d489de58dc7f40).
It used23 recorded assistant requests,48523 peak input tokens,20648 browser
text bytes,9 half-resolution images and1 full-resolution recovery, with no
compaction. One tab-creation setup failure remains counted. Initial and final
native screenshots were extracted from the retained transcript and viewed.
Native runtime boot evidence comes from its actual read-only JavaScript
response, paired with those viewed pixels and independent SQL station identity.

Hybrid03 independently passed all eight checks: exact141 note, one payment,
accepted txn38, no pending request and viewed printed pixels
C:/autoprint/20261008220104.png (SHA256
26a9f51726df75ab47f65f816272e505c4bf4b30fbe1a34ef7619bd36628c3b7).
Its25 recorded assistant requests peaked at60010 input tokens, with no
compaction. One selector Pay stale-source refusal remains counted; coordinate
actions opened Drinks and paid Cash, both without coordinate refusal.
Initial new-order delivery uncertainty was independently resolved as a single
new invoice without repeating the action. No observe or expand was used.

Hybrid03 used68.46% fewer processed tokens than Visual02, with18.66% more than
the completed Native03 baseline and10.82% higher recorded estimated cost.
It made39.29% fewer browser calls than native, but had two extra model requests
and a larger peak context. These successful runs again demonstrate why calls
alone are a poor objective. Native elapsed156.68seconds versus Hybrid252.06seconds.
The bundle comparison with Visual02 includes corrected setup and prompt changes;
it is not a causal estimate for the pointer guard alone.

Hybrid04 also independently passed8/8: exact141 note, one cash payment,
accepted txn39, no pending request, actual viewed printed receipt
C:/autoprint/20261008220915.png (SHA256
87b9ed74edf6f2f447a3755f3983f80cd3b5a02e5313b9cd894a856638ceddd7).
All eight images were617x338 and coordinate-aligned. Its31 model requests,
six snapshots and25 browser calls explain why suppressing action images did not
guarantee fewer processed tokens. Two Counter coordinate refusals recovered
through snapshot/selector targeting; the precise cause of the first refusal is
not isolated. The second occurred after pointer movement. No paid interaction
was repeated. Compared with03, tokens rose15.48%, estimated cost fell2.30%,
and elapsed time fell to241.62seconds. Its extra139027 cache-read tokens were
partly offset in cost by lower cache creation/output. These are accounting facts,
not causal attribution of the regression to a particular instruction.

## Provisional selection

Hybrid03 is the lowest-token successful CDP attempt observed. Keep its flexible
combination: requested pixels, actionable selectors, source-chained acts,
readability recovery and independent effect checks. Do not promote04's strict
image suppression as a token optimization. It reduced pixel delivery but
fragmented discovery into more requests. Native03 remains lower on both token
and estimated cost metrics. This is not native parity or a universal optimum.

The useful next tool experiment is bounded MCP composition for known-selector
sequences (cdp-cli-nvo), retaining each step's guard and delivery uncertainty.
The CLI already offers recording/action composition; the five-tool MCP adapter
used in these trials exposes single acts. No new batch executor is claimed here.

Native02 is not a successful-task parity baseline: it stopped
before the required note and payment. Processed tokens include cache reads;
the estimated cost column uses the retained accounting assumptions, not a bill.

## Implemented candidate

The global pointer mutation guard is narrowed to mutated regions and competing
source/current surfaces at the requested point. CSSOM/clipping/pseudo styles,
scroll/viewport drift, and running point-overlapping animations remain guarded.
The guard is rechecked after mouse movement before pressing. Existing global
semantic/layout checks remain conservative. Source-bound alignment is not
atomic transaction identity or proof of business effects.

The tested hybrid prompt explicitly uses screenshot rather than observe for
pixels, snapshot for precise selectors, and returned-source selector chains.
It requests resulting pixels only when needed for the next action or evidence.
Direct literal copying from the note file is expressly permitted.

Hybrid02 exposed a controller boot bug: identical shell/query navigation could
change the SPA hash without rerunning test_scenario authentication. Runtime
jQuery/navAuto were live but the tables header lacked a cashier. Fresh
index.php navigation with a unique _cb query forced the full shell reload and
the actual tables header then showed Local Station - Michel Untel. Fresh03
arms use this identical entry correction; prior attempts remain retained.

All original inputs are retained. The new guard and prompt are a bundled
candidate, so an improvement cannot be attributed to either alone.

## Choosing existing options

| Need | Candidate tool choice | Evidence boundary |
|---|---|---|
| Visible navigation | screenshotViewportScale0.5 then source image x/y | Refresh after refused/stale image; native clicks remain CSS |
| Exact field selector or ambiguous label | actionable snapshot, optionally frame | Redacted values cannot prove persistence |
| Repeated known controls | selector acts chained using returned source | Inspect uncertain delivery before retry |
| Small verification text | readable full-resolution recovery or CLI selector crop | Cropped images are unsupported coordinate sources |
| Management iframe | frame-specific snapshot/selector action, appropriate waits | Do not navigate directly to a dead partial |
| Known scripted regression | existing action-file composition | Separate scripted cost from exploratory model cost |
| Asynchronous completion | selector/text/expression/response/navigation wait | Wait success must match the claimed business effect |
| Historical error or receipt | expand requested evidence section | Historical keys are not current actionable controls |

JPEG quality reduces file size, not necessarily model image tokens at identical
dimensions. AX/text snapshot modes, crops and frame paths remain available in
the composable CLI; the restricted five-tool workflow does not expose every CLI
flag. Future variants should change one discovery policy at a time, repeat
matched successful runs, and rank by complete verified cost, correctness,
recovery and elapsed time. Current bundle trials do not identify a global optimum.

## Evidence and limitations

Local evidence: C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/visual-coordinate-bench-02
and visual-coordinate-bench-03/04. Both03 arms share corrected contract SHA256
3c7181816bb96eed9e953d9b8f8f88991062261e71bf90b1f0ec05943815c0ab;
note SHA256 remains ba0d0f61026acfb1adc74f4abbaf3ef41111e0541f2dee6ba7272bde922008f7.

[Hashed measurements](coordinate-benchmark-review/metrics.json) retain all seven
attempts (6356927 recorded actor tokens in total), raw transcript hashes and
independent evidence hashes. Recreate with `node export-coordinate-benchmark.mjs
WORK_ROOT OUTPUT_JSON`. All token/cost numbers above are recorded **actor** usage:
controller boot/setup, monitoring, independent SQL/RQ/receipt verification and
reviews are excluded. Native includes fresh-tab/navigation/resize work while
CDP starts controller-prebooted. Thus startup is asymmetric in CDP's favor and
these figures are not all-in workflow cost or amortized cost over failures.
Estimated prices use retained assumptions (input0.10/M, one-hour writes0.20/M,
cache reads0.01/M, output0.50/M USD); they are not a subscription bill or freshly
verified current vendor prices.

Adaptive image delivery also differs: Native03 has9 half images+1 full;
Hybrid03 has6 half+7 full (2.62times native's pixel area). Four Hybrid03 images
are coordinate-unaligned and cannot be used for point actions. This does not
prevent reading their visual effects. Pixel area is not a model-token formula.
Native images are JPEG, CDP images PNG. One successful sequential pair plus04
is not a randomized/repeated reliability or parity experiment. Neither arm
compacted, so no conversation-compaction savings are demonstrated.

Canonical plugin instructions were updated/pushed at350fe68 and installed
agent/CLI skill copies backed up before local rollout. Shared Claude and Codex
workflow skills now expose reduced images, screenshot coordinate space and
actionable snapshot. Fresh workers receive these instructions; no existing
unrelated agent was interrupted or assumed to reload its tools.
Jarvis workitem8508/session2067 retains the named Blink terminal; dashboard
localhost3001 was unavailable while final trial evidence was recorded. No
successful durable dashboard note is claimed for that period.

Unit suite:522 passed,9 skipped. Earlier full live run:65 passed,3 failed,
4 skipped; those three obsolete expectation cases passed after targeted test
corrections. This is aggregated verification, not a fresh full-suite result.
Coverage61.53% lines/66.21% functions remains below the repository80% requirement,
tracked in cdp-cli-yr7. Final coordinate live regressions passed, including
half-viewport dimensions, image-to-CSS mapping, same-origin iframe clicks,
disabled/moved/covered targets, CSSOM pointer-events and clipping changes,
hover-triggered overlays, redacted field values, and an unrelated background
style change. These targeted checks do not replace a fresh full live suite.
