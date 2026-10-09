/** Scoped, idempotent instruction migration. Preserve unrelated local edits. */
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
const rules=[
 ['An action returns fresh compact state and a diff: inspect that result before\nasking for another observation.',
  'Actions return short delivery/witness receipts and a fresh source ID. Chain known\nstable selectors; observe when controls or required effects are unknown.'],
 ['return fresh compact state and a diff; consume that result before another\nobservation.',
  'return short delivery/witness receipts and fresh source IDs. Observe for unknown\ncontrols or effects; expand required historical evidence, or use full:true explicitly.'],
 ["Use the last `view.source.id` as the next action's source. Each action returns\nfresh compact state, latest diff and available diagnostic errors; do not add a\nredundant observation.",
  "Use the returned `view.source.id` as the next action's source. Actions return short\ndelivery/witness receipts. Chain known stable CSS selectors; discover unknown\ncontrols with observe. Use source keys only from that exact current observation."],
 ['`act` returns fresh compact state and a diff; consume it without a separate\nobserve call.',
  '`act` returns a short delivery/witness receipt and fresh source ID. Chain known\nstable selectors; observe only for unknown controls or required effects.'],
 ['Normal loop: observe once, then act using value.view.source.id returned by the preceding successful action; do not routinely re-observe or DOM-retag between actions. On a stale rejection with actionDelivered:false and a fresh returned view/source, inspect that state and reassess without another observe. Re-observe if fresh state is unavailable or unusable, after historical expansion, or for an uncertain required effect.',
  'Normal loop: discover controls deliberately, then chain known stable CSS selectors using each returned value.view.source.id. Actions return short delivery/witness receipts; screenshots return pixels/alignment metadata without state dumps. Observe for unknown controls or uncertain required effects. Use source keys only from that exact current observation. Expand required historical evidence, or request full:true explicitly for rich output. On stale refusal with actionDelivered:false reassess with the returned source; recover effects before retrying uncertain delivery.'],
 ['Treat bounded-output omissions as evidence gaps and use paginated expand or the saved artifact for required detail.',
  'Expand specific evidence needed by the acceptance contract; detailsOmitted alone does not require expansion. Omitted or unavailable evidence is not a pass.']
];
const plugin='plugins/auphandev',cache=homedir()+'/.claude/plugins/cache/auphan-claude-code-plugins/developer-tools/1.6.1';
const paths=[
 `Q:/apps/auphan-claude-code-plugins/${plugin}/agents/cdp-cli-agent.md`,
 `Q:/apps/auphan-claude-code-plugins/${plugin}/skills/cdp-cli/SKILL.md`,
 `${cache}/agents/cdp-cli-agent.md`,`${cache}/skills/cdp-cli/SKILL.md`,
 'Q:/apps/jarvis/templates/skills/persistent-browser-qa-SKILL.md',
 'Q:/apps/jarvis/templates/worker-prompt.md','Q:/apps/jarvis/config/claude-subagents.json',
 homedir()+'/.codex/skills/persistent-browser-qa/SKILL.md',homedir()+'/.claude/skills/persistent-browser-qa/SKILL.md'
];
for(const path of paths){if(!existsSync(path))continue;const before=readFileSync(path,'utf8');let after=before;
 const nl=before.includes('\r\n')?'\r\n':'\n';
 for(const[from,to]of rules)after=after.replace(from.replaceAll('\n',nl),to.replaceAll('\n',nl));
 if(path.endsWith('.json'))JSON.parse(after);
 if(after!==before){writeFileSync(path,after);console.log(path);}
}
