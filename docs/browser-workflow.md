# Deterministic browser evidence workflow (2.2.0)

This deployment uses action-plus-state results, deterministic pruning and the
existing agent fallback. It does not enable Qwen, Jev or a vision decision model.
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
