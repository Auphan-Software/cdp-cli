# Native Anthropic browser versus CDP workflow benchmark

Status 2026-10-08: researched and preflight implemented; no native performance run yet.
Tracked by `cdp-cli-8dl`. Preferred next comparison is now Claude Code's official Chrome
integration versus our workflow on the same managed CLI runtime. It supports a direct Pro/Max
login and does not require an API key. The earlier API-only requirement was too narrow.
The API toolset experiment below remains a separate option, not a prerequisite for the CLI pair.

## Preferred Claude CLI comparison

Local Claude Code2.1.294 exposes `--chrome`, and `claude auth status` confirms a logged-in
`claude.ai` account. The native Chrome messaging host is registered. The official extension
`fcoeoabgfenejglbffodgkkbkcdhcgfn` was absent from the inspected Chrome/Edge default profiles
and both CDP profile directories. Install/sign in to the extension and verify `/chrome`
reports an installed, connected browser before spending model tokens on a business journey.
[Official CLI integration](https://code.claude.com/docs/en/chrome).

Use a fresh managed session with exact Haiku5.5/medium/250k for each arm. For the Anthropic
arm enable `--chrome`, exclude our workflow MCP configuration, disable slash skills and the
Agent tool, and use a short browser-only contract without the CDP skill or QA-delegation prompt.
Preserve Jarvis tracking/hooks; `--bare` would remove hooks and require API authentication,
so it is unsuitable. Do not change global browser defaults or another agent's instructions.
Confirm actual native arguments, advertised tools, loaded instruction text and browser calls
from retained transcripts. Generic Jarvis launch currently injects subagent profiles and has
no browser-isolation option; session-specific launch support must be verified before dispatch.

The official extension owns a new session tab group. Limit the actor to its fresh gym tab;
do not let it inspect unrelated user tabs. Match the product/fixture/journey, output budget,
cache/compaction policy and independent evidence checks across arms. Include the official
extension's tool/schema/startup overhead in CLI costs. Treat site-permission setup separately
and record interventions. The old current24k cash run is context, not a substitute for a fresh
matched control. Label this result Claude Code Chrome integration, not an API-toolset benchmark.

## What is being compared

Anthropic's `browser_toolset_20260801` defines model-facing members and execution contracts.
Its SDK routes calls, but the caller supplies the browser and driver. The official minimal
CDP example is not a production driver. Therefore the claim must name the driver/version,
enabled members and added behavior; it cannot treat the API schema as a complete browser engine.
[Official tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool),
[SDK integration](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk).

Our current24k workflow supplies task-pruned action-plus-state results, source-bound targets,
delivery evidence, recovery receipts and execution budgets. Native offers focused tree reads,
references/coordinates and sequential action batches. Either could win: shorter results may
lower repeated input, while better model/tool alignment or fewer round trips may lower total
completion cost. We have no measured native winner. Previous 24k/64k figures compare only our
two packing profiles, not Anthropic's tool.

## Implementation and qualification gates

1. Use read-only `native-browser-preflight.mjs PINNED_CLI OUTPUT_JSON` with a configured
   `ANTHROPIC_API_KEY`. It calls model identity and token counting only, captures our actual
   bridge schemas, validates the native toolset, and reports prompt/schema counts separately.
   It does not generate model responses or act in a browser. Failed API qualification blocks
   paid/browser runs. Credentials and server error text are excluded from the artifact.
2. Pin the upstream minimal CDP example at quickstarts commit
   `9ec32b91df50b0d4906cae64b13c6298055ff40d`. It implements five members, lacks screenshots,
   form input and dialog recovery, and launches its own browser. Adapt it to an explicitly
   owned gym allocation; add required screenshot/input/dialog/stale-reference behavior and
   bounded execution before evaluating Mako2. Record the patch and exact enabled member list.
   [Pinned baseline](https://github.com/anthropics/claude-quickstarts/tree/9ec32b91df50b0d4906cae64b13c6298055ff40d/browser-toolset).
3. Run both arms through the same bounded API controller. Our arm executes actual workflow
   tools through the pinned bridge; native returns genuine toolset member results, not an MCP
   tool renamed to resemble them. Preserve complete request/response/usage records, images and
   exact tool schemas. Reject malformed replies and stop batches at first failure.
4. Validate executor controls without model spend first: owned tab only, refused stale refs,
   failed batch halts, bounded actions/deadline, visible inputs, screenshots and dialog handling.
   Neither arm may mutate business state through JavaScript or query SQL for actor decisions.

## First model comparison

Use Haiku5.5 medium/adaptive, the same short operator contract, product candidate, cashier,
station, browser viewport, fixture/config snapshot, API cache policy, output budget and controller.
Randomize one sequential cash pair, with unique invoices and no claimed DB rewind. Retain the
same 30-action/10-minute limits and count every native batch member individually. Stop on
completion or exhaustion; no automatic retry. Keep reranker off and compaction policy equal.
Both arms must capture final pixels and pass the existing independent seven-check cash verifier
(payments, RQ, pending state, bill pixels/payload and restoration). Use controller bill capture
for both. Do not compare lean API runs directly with the earlier large Claude Code contexts.

Measure total fresh/cache-write/cache-read/output usage and API cost per verified success,
wall time, model turns, all tools, batch sizes, screenshot tokens, failed waits, stale targets,
wrong/duplicate actions and interventions. Include failed attempts; identify excluded controller
costs. Run one difficult zero-netting or long-modifier pair only if the cash qualification passes
and that pair answers an unresolved performance question. Keep native compaction and transport
qualification separate from business success.

Report a bounded comparison with uncertainty, not a universal performance claim. Leave our
current24k default unchanged until comparable evidence supports a change.
