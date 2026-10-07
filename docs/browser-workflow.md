# Browser evidence workflow (2.2.1)

This deployment uses action-plus-state results, deterministic pruning and the
existing agent fallback. Qwen relevance projection is optional through the
shared office service; Jev and vision decision models are not enabled.
The acceptance metric remains complete bug-reproduction/evidence task tokens,
including cache reads, tool batches, verified quality and elapsed time.

## CLI and tools

```bash
cdp-cli workflow observe "$CDP_PAGE" --task 'Reproduce the cart history bug'
cdp-cli workflow act "$CDP_PAGE" --task 'Reproduce the cart history bug' --source SOURCE_ID --action click --selector '#checkout' --wait-for '#cart'
cdp-cli workflow expand "$CDP_PAGE" --task 'Inspect omitted evidence' --source SOURCE_ID
cdp-cli workflow screenshot "$CDP_PAGE" --task 'Capture the stuck cart'
```

Use `value.view.source.id` for the next action. Each supported action returns
fresh state and a complete diff against that source; no extra observation is
needed unless more evidence or settling is required. Captures probe stability
after 200ms by default. This is not a guarantee that a later asynchronous update
has completed: specify selector/text waits or use the existing advanced waits.

Actions support click, fill, select, top-frame key input, navigate/back/forward/
reload. Stable same-origin frame selectors work for click/fill/select. Existing
CLI tools remain the fallback for touch/drag, cross-origin/OOPIF fields, framed
keys, advanced response/navigation waits and uncertain state. No new arbitrary
JavaScript or shell tool is exposed by the MCP bridge.

The stdio MCP server is `cdp-cli workflow-mcp`. Register it as `cdp-workflow` for
Claude. Its observe/act/expand/screenshot tools inherit CDP_SESSION, CDP_PAGE,
CDP_URL and CDP_DAEMON_URL at launch; they cannot accept another page or session.
Missing ownership fails without adopting or creating a browser. Each call is
serialized. CLI fallback supports existing ordinary manual page references.

Screenshot tools return PNG image blocks and saved artifact metadata. Encoded
pixels never appear in text blocks. CLI output returns paths, not pixel data.
If an image exceeds the10MiB transport cap, use the artifact reader. A failed
screenshot or image read does not erase already completed action/state evidence.
`semanticStable:false` signals uncertainty between the image and state capture;
the captures are sequential, not an atomic pixel/DOM transaction.

## Protected evidence and recovery

Canonical masked captures are retained in the existing StateStore. Deterministic
projection preserves values, current/selected/checked state, task matches,
errors/alerts/status/dialogs, focus, latest changed nodes and parent context.
It removes unprotected hidden nodes and redundant/default fields. URL, coverage
and expansion references remain. Visible text and screenshots can contain
sensitive information; treat saved artifacts as evidence, not public telemetry.

Console warnings/errors and network failures/HTTP errors are attached when the
existing daemon can provide them, bounded to the last100 log entries per stream.
Unavailable services and limit hits are explicit; neither establishes absence
of errors. Complete logs, SPA boot and database persistence checks remain part
of project QA. Artifacts remain local until deliberately uploaded for review.

Actions require a previous source and a fresh semantic comparison including
disambiguating context. Stale/changed source is rejected before delivery. A
failed command, wait or post-action observation never automatically retries.
Recover evidence first because the action may already have occurred.
Expansion is historical: observe again before a new action.

## Local installation and routing

### Shared office reranker

Office clients can set `CDP_RERANK_URL=http://192.168.1.140:8125` for CLI and
MCP workflow calls. An optional user config at `%LOCALAPPDATA%\cdp-cli\reranker.json`
(Linux/macOS: `~/.config/cdp-cli/reranker.json`) uses this contract:

```json
{"url":"http://192.168.1.140:8125","timeoutMs":2500,"modelRevision":"18f099b292864fde542713d7c41aa4464860e11bc07b045b51543e9e59e6e7e7","runtimeRevision":"11fe02151f79c41d0d4af7da708755d73b9c0da6"}
```

`CDP_RERANK_CONFIG` can name another config. `CDP_RERANK_URL=off` disables
ranking, and `workflow ... --full` always bypasses it. `CDP_RERANK_TIMEOUT_MS`
overrides the bounded client deadline (50–5000ms). A matching pinned model and
runtime are validated in responses. The shared service holds a512-entry exact
task/document score cache containing hashed keys and scores only. It is reused
across separate CLI/MCP child processes and cleared on service restart.
Revision mismatch, failed
admission, malformed scores, timeout and unreachable service return the intact
deterministic view with `providerStatus:fallback`; no retry or new tool call.

Only unprotected relevance units reach the service. The task and their masked
semantic text are sent over the trusted office LAN, never screenshots, raw
canonical captures, browser handles or console/network streams. Canonical state
and all must-keep evidence stay local and remain protected before and after
ranking. The provider proposes relevance only and cannot execute actions.
Workflow observations automatically diff against the last workflow capture of
the same profile, protecting external changes after a stale rejection. Guard
and screenshot-alignment captures do not replace that reference. Incomplete,
unstable or unmodelled-text captures bypass learned projection.

The office gateway listens on `192.168.1.140:8125`; its llama.cpp worker listens
only on loopback8126. Windows firewall permits the office `192.168.0.0/16`
network. There is no WAN port forwarding or public/authenticated service. Use
VPN or an authenticated TLS gateway before extending beyond that trusted LAN.
`GET /health` reports pinned revisions, aggregate counts and current admission
capacity without UI text. The service does not log request bodies.

The persistent `CDP-Reranker` startup task runs a low-priority CUDA worker.
Admission requires healthy GPU transcription with zero active jobs, at least
2GiB free VRAM, and initial GPU utilization below25%. It accepts one request,
never queues, checks transcription between at most eight-document microbatches,
and has a2-second ranking budget. Monitor failures reject work. A transcription
job can start during a microbatch: this is bounded best-effort sharing, not
GPU preemption or an exclusive reservation. Loaded model memory remains resident
while transcription is busy. Runtime logs and deployment manifest live in
`C:\ProgramData\cdp-reranker`; stopping the exact scheduled task and owned worker
and setting `CDP_RERANK_URL=off` rolls back to deterministic behavior.

Install scripts are in `scripts/reranker/`. Stage the pinned model/runtime and
config first; `install-service.ps1` verifies model identity and vacant ports,
creates the scoped firewall rule and registers the startup task. Reinstallation
refuses an existing task so upgrades require an explicit inspect/stop procedure.

Client configuration precedence is `CDP_RERANK_URL` (including explicit `off`),
then an explicit `CDP_RERANK_CONFIG`, otherwise the user config followed by the
machine config. Windows uses `%ProgramData%\cdp-cli\reranker.json`; Linux uses
`/etc/cdp-cli/reranker.json`. User config uses `%LOCALAPPDATA%` on Windows or
`$XDG_CONFIG_HOME` / `~/.config` elsewhere. A malformed or explicitly missing
override fails safely without switching to another endpoint. Timeout and pinned
model/runtime environment overrides remain supported.

Run `scripts/reranker/install-client.ps1` on Windows to verify the endpoint and
write the shared config. It preserves differing existing configuration unless
`-Replace` is explicitly supplied. For older retained MCP clients, run its
`-UserCompatibility` option from the actual unpackaged Claude runtime. Codex's
MSIX runtime can redirect a normal-looking AppData path into its private
LocalCache, making that file invisible to separately launched clients.

`cdp-cli reranker-status` reads configuration in the invoking runtime and makes
both a health request and a real two-document ranking request. Success requires
matching configured revisions, a relevant checkout selection and rejection of
an unrelated footer. It exits nonzero for missing/disabled/invalid configuration,
unreachable or busy services, revision mismatches, or unexpected selection. This
synthetic canary never touches browser state or business records. It uses a unique
query and requires positive model token usage to prove fresh ranking. Both
revision pins are required. It is a connection check, not a whole-task speed benchmark.

Linux consumers can call the HTTP endpoint directly (no Node or CDP browser is
required): POST `/rerank` with JSON `{"query":"...","documents":["..."]}`
and `Content-Type: application/json`. Results contain indexed relevance scores,
usage and pinned revisions. Apply the same revision checks, a bounded timeout,
and deterministic fallback on busy/error responses. Office Proxmox `arcturus`
(`192.168.3.40`) was verified using this route; its config is at
`/etc/cdp-cli/reranker.json`. The laptop and retained managed Claude runtime must
each verify from their own environment rather than trusting a Codex-only check.

Workflow views include `providerReason`: `not-configured`, `disabled`,
`invalid-config`, `full-view`, `history-unavailable`, `profile-mismatch`,
`unsafe-coverage`, `no-candidates`, `applied`, or `request-failed`.
No-candidate views do not pretend ranking ran. Truncated captures remain
ineligible; use a complete canonical capture for ranking measurements.

`npm run install:exe` rebuilds and installs Windows executable copies on PATH,
then checks cmd.exe/Git Bash/PHP build identity. The npm shim uses the same build.
Deploy the bundled skill `skills/cdp-cli-workflow/SKILL.md` into Claude/Codex user
skills. Central Jarvis QA profiles must allow the four `mcp__cdp-workflow__*`
tools; worker/investigation/QA instructions prefer this path while preserving
ownership and preflight. New conversations inherit these changes; already
loaded agent prompts/tool lists may need their next normal launch to refresh.

For rollback, restore the saved prior executable, rebuild the prior source for
the npm shim, and remove `cdp-workflow` with `claude mcp remove --scope user
cdp-workflow`. Restore prior prompt files if reverting workflow selection.
No model process, Proxmox container or application/database deployment is needed.

Validation before installation:436 unit tests passed (nine optional skips),
30 broader private-Chrome checks passed (two optional skips), and all four
dedicated workflow cases passed, including owned-session MCP PNG delivery and
failed-wait recovery. The dedicated cases can also run against the installed
executable via `CDP_WORKFLOW_TEST_BIN`. Overall unit line coverage is58.45%,
below the repository80% target; the existing gap remains tracked in cdp-cli-yr7.

The earlier controlled deterministic-fused pilot showed32% fewer processed
tokens,36% fewer browser calls and15.7s versus20.4s mean completion with4/4
verified successes. The production implementation adds source checks and real
legacy command execution; these pilot percentages are not a measured rollout
guarantee. Paired real Mako2/WhiteTip2 investigations remain the effectiveness
follow-up in cdp-cli-ozz.
