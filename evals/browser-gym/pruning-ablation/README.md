# Focused pruning and reranking ablation — 2026-10-08

Confirmed defect: literal focused-query filtering ran after protected-control projection and discarded the Notes editor's two unnamed sibling buttons. The reranker was not responsible: the same omission appeared with reranking disabled and with provider status applied. Fixed by retaining visible controls in the matched/focused editable field's actual immediate DOM group, bounded to 12 controls. Frame/shadow identity qualifies the group; duplicate container IDs cannot merge groups. No labels or action targets are invented. Oversized groups remain recoverable by expand.

The fix restores discovery evidence, but this small test does not establish token or cost savings. All final arms still expanded canonical evidence to map the unnamed buttons to screenshot positions. Query-only cost rose 7.1%; the ranked arm was 0.4% cheaper than unfiltered, effectively level for one stochastic trial, and one provider request failed and fell back. Do not infer a ranking win from it.

## Final frozen-build comparison

| Arm | Processed tokens | API-equivalent USD | Calls / expansions / images | Provider |
| --- | ---: | ---: | --- | --- |
| unfocused-final | 166,389 | 0.00877950 | 5 / 1 / 2 | {"unused":4} |
| focused-final | 166,940 | 0.00940380 | 5 / 1 / 3 | {"unused":3} |
| ranked-final | 146,061 | 0.00874456 | 4 / 1 / 3 | {"fallback":1,"applied":2} |

All three final arms independently passed exactly one accepted POST containing the exact 15-character note, and controller review of actual final pixels showed the saved note. All requested images were available. The focused arm made one invalid full-plus-query request, contrary to its adapter; it was refused without dispatch and retained in costs/call counts. It is a business/visual pass with a protocol deviation, not a strictly compliant trial.

## Earlier attempts retained

| Arm | Processed tokens | API-equivalent USD | Calls / expansions / images | Provider |
| --- | ---: | ---: | --- | --- |
| unfocused | 181,286 | 0.00974421 | 5 / 1 / 3 | {"unused":4} |
| focused | 187,021 | 0.00903741 | 6 / 1 / 3 | {"unused":5} |
| ranked | 204,470 | 0.01022414 | 6 / 1 / 5 | {"applied":5} |
| unfocused-fixed | 145,756 | 0.00829828 | 4 / 1 / 3 | {"unused":3} |

All earlier arms saved exactly once. Focused baseline lacked initial/final pixels; ranked baseline recovered two screenshot failures. They are contaminated comparisons, retained without subtracting recovery cost. The intermediate unfocused-fixed run used path-based grouping before duplicate-ID hardening, so it is not part of the final three-arm comparison. Two allocated fixed-arm folders had no worker launch and no paid attempt.

All seven paid attempts total USD 0.06423190 API-equivalent assistant cost. Subscription billing and controller/setup tokens, server electricity and GPU cost are excluded. Processed tokens include fresh input, cache creation/read and output; they are not all billed at the same rate. No arm compacted, so this says nothing about context-compression effectiveness.

## Contract and provenance

- Same harmless frozen HTML, byte-identical job.md business contract (hashes in comparison.json), Haiku 5.5 medium, Claude CLI 2.1.295, fresh contexts, no Chrome extension, strict assigned workflow MCP, haiku-compact profile, 12 browser calls / three-minute contract, targetKey-only fill/click and one confirmation. Read/Write/ToolSearch plus assigned MCP; no shell, JS, subagents or product changes.
- Same image scale 0.5, viewport and initial/final screenshot obligations. Actual image counts varied by agent, so tokens/costs include that behavioral variation; image counts were not forcibly equalized. Each final page was explicitly activated before dispatch, and exact page IDs/configs are archived per arm. No activation bypass occurred while a worker held a lease.
- Final runtime: 6e4301c-dirty, built 2026-10-08T23:36:59Z. This identifier is the pre-commit build, not an assertion that the final documentation commit was its runtime. Compiled file hashes and build-info are archived. Final three arms ran without rebuilding between workers.
- Unfocused omits query; focused uses Notes|Saved, ranker disabled; ranked uses the same query with HTTP provider at 192.168.1.140:8125. Office service health before/after was ok with modelRevision 18f099b292864fde542713d7c41aa4464860e11bc07b045b51543e9e59e6e7e7 and runtimeRevision 11fe02151f79c41d0d4af7da708755d73b9c0da6. Explicit URL mode skips config revision-pin enforcement; health checks verified revisions instead. Final provider statuses: fallback/request-failed once, applied twice. Global service counters include other traffic and are not attributed to this trial.
- Evidence: controller-proof.json contains actual accepted saves, response scopes, image availability/paths and controller visual review. Per-arm summary.json is reconstructed from raw Claude JSONL, not the agent's self-reported budget. Raw transcripts and parsed tool results remain at C:/Users/wingz/OneDrive/Documents/ChatGPT/Work/pruning-ablation-01; they are not copied into Git because they include image payloads and local transcript context.

## Reproduction and limits

Run server.mjs in a disposable directory: it chooses a local port and writes server.json, fixture.html and controller-saves.json. Allocate an owned CDP page per arm, navigate to server.url/?arm=ARM, activate it before worker dispatch, adapt archived absolute paths/page IDs, and run each fresh CLI context sequentially against one frozen build. Never replay archived targetKeys. Keep failed attempts and audit raw transcript usage with ../gym.mjs auditNative. The fixture isolates the editor omission; it is not a substitute for the difficult Mako WebSRM or iframe management journeys.

Next work stays tracked in cdp-cli-15b: source-backed geometry/identity usable alongside pixels, then repeated balanced-order tests on actual management and WebSRM journeys. Do not invent confirm/cancel semantics for unnamed controls. Screenshot routing remains cdp-cli-3p7. Defaults/reranker thresholds were not changed by this fix.

Validation: full unit coverage run 512 passed / 9 skipped; final unit suite 512 passed / 9 skipped; final real-Chrome compact suite 5/5, including duplicate container IDs and exactly one dispatch. Build/typecheck passed. Repository line coverage 61.85% remains below the documented 80% gate (existing cdp-cli-yr7); workflow-compact line coverage is 94.06%.
