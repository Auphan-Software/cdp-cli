# Provenance of verbose browser workflow output

2026-10-08 investigation prompted by Henry's observation that the original CLI deliberately removed verbose text. Git history confirms the original lean commands and later workflow adapter are different interfaces. The native benchmark used the newer workflow/MCP interface, not the original direct CLI command path. No original-CLI-versus-native token conclusion is justified from that benchmark.

| Date (local commit time) | Commit | Verified change |
|---|---|---|
|2025-10-26|323e883|Initial release: click reports selector/x/y/double; fill reports selector/value; no automatic page-state/diff/console dump.|
|2025-12-18|a40cbe6|“Simplify snapshot format for integration testing”: replaces raw accessibility tree with actionable labels/selectors, removes verbose DOM format.|
|2025-12-20|58584d3|“Simplify multiple-match error output”: replaces metadata objects with short snapshot-style strings; clips text to50characters rather than160.|
|2026-09-25|6de4059|Adds bounded page-state captures/diffs and QA pilot as a separate state path. Ordinary commands do not automatically gain a full state response.|
|2026-10-03 23:43|3ac0a8e|Adds supported `workflow` plus `workflow-mcp`. Actions invoke existing CLI then capture fresh page state; responses include action evidence, projected elements, diff, diagnostics, canonical path and optional screenshot. Screenshot operation also captures/projects state. MCP serializes each entire response row as model-facing JSON. New skill tells agents to prefer these tools; deployment docs route Jarvis QA profiles to them.|
|2026-10-07 12:32|30cd6fb|Adds24KB transport bounding, recovery artifact paths and omission notices. Packs errors/diffs/elements into the available budget. Limits a state-bearing response; does not restore small direct-command receipts.|
|2026-10-08 00:10|0e70cc0|Adds action/deadline execution budgets and budget blocks to MCP responses.|
|2026-10-08 13:16|f6ed9e5|Adds opt-in haiku-compact8KB profile, source references, canonical evidence recovery and new recovery metadata. Attempts to shrink the existing workflow architecture.|
|2026-10-08 17:04|d5e7133|Retires query/reranking; captures unnamed-control geometry. Fresh-state/diff/evidence responses remain.|
|2026-10-08 17:06|46cbcdf|Defaults new MCP bridges to haiku-compact; ordinary composable CLI default remains unchanged. This changes the workflow profile selection, not the original cause of state-bearing responses.|

The decisive introduction is3ac0a8e, not the latest reranker retirement. At that commit `src/workflow.ts` calls `capture` for observe/act/screenshot, obtains console/network logs, calls `projectState`, and returns `{action,view,diagnostics,canonicalPath,screenshot}`. `src/workflow-mcp.ts` uses `result.rows.map(row => ({type:'text',text:JSON.stringify(row)}))`. The3ac0a8e diff does **not** change `src/commands/input.ts`, `src/commands/debug.ts` or `src/output.ts`: verbosity was added around the existing core rather than replacing their implementations.

## Session evidence and responsibility

Jarvis raw QMD transcript `qmd://transcripts/codex-01a104aa-f31c-7f12-849b-a0be71bf3e4e.md`, export dated2026-10-04, source codex, contains the deployment discussion:

- Lines363–372: Codex proposes fresh state on every action, pruning, fallback and initial paired real-application validation before default adoption.
- Lines384–396: Codex claims32% lower processed tokens and36% fewer browser calls in a4/4 controlled pilot without reranking, while saying real Mako2/WhiteTip2 validation is still required.
- Line400: Henry authorizes building/deploying that proposal plus skill/agent prompt changes.
- Lines404–410: Codex implements the action/state/diff/console-network path and central prompt routing.
- Lines430–438: Codex reports installation and shared prompt deployment while actual real-application token savings remain unvalidated.

The user's authorization was for the proposed efficiency improvement. The rich response architecture and promotion through agent instructions came from the Codex implementation, based on limited pilot evidence; that does not establish that Henry requested verbose output. Shared Git author identity is Henry Shing throughout, so authorship alone cannot identify the implementing human/agent; the transcript establishes Codex's implementation role.

Current benchmark adapter intentionally selects this newer MCP path. The installed shared skill also says to prefer `mcp__cdp-workflow__observe/act/expand/screenshot`. Source defaulting to8KB on October8 is an attempted reduction of the new interface, not evidence that the original direct CLI always emitted8KB. The observed173KB of browser text versus native18KB is attributable to the measured adapter path; original direct CLI cost has not been measured in that matched hard contract.

## Correction to the diagnosis

The accurate diagnosis is **a later agent-facing workflow representation regression relative to the original lean-interface design**, not an inherent property of Henry's original CDP CLI. The accumulated context/caching/pricing measurements in `websrm-token-gap-analysis.md` remain valid for the measured newer workflow. The original direct commands, explicit snapshot selection and composable action execution remain available, though their execution/safety internals have evolved.

A correction should preserve the original opt-in evidence principle: simple action receipts by default, deliberate observation when needed, useful requested pixels, and full canonical evidence accessible separately. Retain later execution/delivery/iframe fixes rather than blindly reverting the entire repository. No code, installed routing or runtime was changed in this history investigation.
