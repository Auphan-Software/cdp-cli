# Anthropic guidance applied to the browser gym

Research checked 2026-10-08 against official Anthropic documentation. Recommendations below
distinguish documented behavior from our proposed experiments. No live Haiku E2E result is implied.

## Effort, prompts and steering

Start with adaptive thinking and medium effort; compare high for long tasks or strict instruction
following. Low can skip checks or stop early in long agent prompts. Keep the operator prompt short,
bound completion explicitly, and require real verification. With custom tools and JSON output,
retain adaptive thinking or restrict JSON formatting to the final answer. Changing top-level effort
breaks message caching; per-message effort changes have a separate beta. Deliver human steering as
user text after tool results, never inside a tool result; separate harness notices from human words.
[Haiku prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5)

## Browser tool contract

Anthropic offers `browser_toolset_20260801` for Haiku 5.5 through the Claude API and Google Cloud.
The application executes tools against its own browser. Prefer returned element references over
coordinates where accessible elements exist. References are tab scoped and must be rejected when
stale. Start with focused interactive/subtree reads; use screenshots when appearance matters.
Execute action batches sequentially, halt on the first failure, and identify unexecuted actions.
Return current state with the last action when useful. Optional JavaScript, upload and diagnostic
tools need not be exposed by default.
[Browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)

Our MCP observe/act interface does not automatically acquire the native toolset's behavior. Test
a compatible adapter as a separate arm. Prioritize source-bound target resolution in CDP so the
worker does not manufacture CSS from structural keys. Preserve meaningful labels and effects;
try a wider semantic view against current packing rather than assuming fewer bytes wins.

## Conversation compaction and caching

Anthropic recommends on-demand compaction wherever available. It can keep recent turns verbatim
and summarize older history, including background operation. Tool-result clearing is a separate
context-editing mechanism.
[Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)

Haiku 5.5 supports on-demand compaction in beta with `compact-2026-09-04`; check actual platform
capabilities before enabling it. Return the signed block unchanged and replace only summarized
history. Default summaries do not preserve original images or document contents: reattach evidence
needed for later visual checks. Summary usage is billed through `usage.iterations`; ordinary
top-level counters can be zero. Do not combine on-demand compaction and `context_management`
in one request.
[On-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)

Clearing tool results invalidates the affected cached prefix and incurs cache rebuilding. Amortize
that cost rather than clearing tiny amounts repeatedly. Client history rewrites can invalidate
preserved thinking; server-supported compaction/editing has specific preservation conditions.
[Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)

Our proposed ~80k renewal is an experiment, not an Anthropic recommendation. Compare it with no
renewal on the same long Web-SRM journey. Count summary generation, cache rebuilding, parent and
failed-attempt cost. Independently check payment state, invoice/transaction IDs, pending evidence
and restoration obligations after renewal. Retain bill files outside the conversation and reload
their pixels when needed. Existing smoke data contains no native compaction boundaries and cannot
establish whether conversation compression helps.

## Migration and measurement

Pin `claude-haiku-5-5` rather than an alias. The new tokenizer can count roughly 30% more tokens
for identical text than Haiku 4.5. Remove manual thinking budgets, nondefault sampling controls
and assistant prefills when migrating; preserve supported conversation blocks.
[Migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)

Our release criterion remains cost per independently verified completion, with failures included.
Compare medium/high Haiku and a Sonnet control from equivalent fixture snapshots. DOM transport
packing, reranking and conversation compaction are separate experiments. No savings conclusion
is valid from response bytes alone or from a run blocked before the sale and printed-bill checks.

## Implemented consequence

The gym auditor now counts compaction iterations, avoids adding top-level usage twice, and declines
to estimate cost when multi-phase/cache attribution is insufficient. Three regression tests cover
zero top-level counters, multiple phases and unattributed cache usage. Native API integration,
native browser-toolset integration and compaction experiments remain tracked implementation work.
Source-bound target resolution, visible-action protection and execution budgets are implemented;
the local cash fixture and independent payment/RQ/bill adapter are ready for a measured pilot.
