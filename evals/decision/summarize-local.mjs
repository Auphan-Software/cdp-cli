import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./results/', import.meta.url);
const read = async name => JSON.parse((await readFile(new URL(name,root),'utf8')).replace(/^\uFEFF/,''));
const dataset = await read('fixture-dataset.json');
const results = {};
for (const file of ['jev-region-luna.json','qwen-classifier-q8-luna.json']) {
  const data = await read(file);
  results[file] = {};
  for (const arm of ['baseline','deterministic','filter']) {
    const rows = data.rows.filter(r=>r.arm===arm);
    const sum = fn => rows.reduce((s,r)=>s+fn(r),0);
    const base = data.rows.filter(r=>r.arm==='baseline');
    const baselineTokens = base.reduce((s,r)=>s+r.lunaUsage.input_tokens+r.lunaUsage.output_tokens,0);
    const modelTokens = sum(r=>r.lunaUsage.input_tokens+r.lunaUsage.output_tokens);
    const latencies = rows.map(r=>r.projectionMs).sort((a,b)=>a-b);
    const gold = rows.map(r=>{
      const task=dataset.find(d=>d.task.name===r.task);
      return 6 + (task.task.target ? 1 : 0) + (task.task.clue ? 1 : 0);
    }).reduce((a,b)=>a+b,0);
    // All real paired rows have no important-node omissions. Do not infer node-count recall from a boolean when any miss occurs.
    const allRetained = rows.every(r=>!r.falseNegative && r.missingSafeguards===0);
    results[file][arm] = {
      runs: rows.length, meanCharacters: sum(r=>r.bytes)/rows.length,
      meanStateLines: sum(r=>dataset.find(d=>d.task.name===r.task).state.elements.length-r.omitted)/rows.length,
      lineReductionPct: 100*sum(r=>r.omitted/dataset.find(d=>d.task.name===r.task).state.elements.length)/rows.length,
      characterReductionPct: 100*sum(r=>1-r.bytes/base.find(b=>b.task===r.task).bytes)/rows.length,
      meanEstimatedTextTokens: sum(r=>r.estimatedTextTokens)/rows.length,
      goldImportantNodes: gold, importantRecall: allRetained ? 1 : null, importantFalseNegativeRate: allRetained ? 0 : null,
      correctActions: sum(r=>Number(r.correct)), fixtureVerdictCorrect: sum(r=>Number(r.verdictCorrect)), wrongTargets: sum(r=>Number(r.wrongTarget)),
      escalations: sum(r=>Number(r.escalate)), providerApplied: sum(r=>Number(r.providerStatus==='applied')), providerFallbacks: sum(r=>Number(r.providerStatus==='fallback')),
      projectionP50Ms: latencies[Math.ceil(rows.length*.5)-1], projectionP95Ms: latencies[Math.ceil(rows.length*.95)-1],
      meanDecisionPathMs: sum(r=>r.decisionPathMs)/rows.length,
      downstreamInputTokens: sum(r=>r.lunaUsage.input_tokens), downstreamOutputTokens: sum(r=>r.lunaUsage.output_tokens),
      downstreamCachedInputTokens: sum(r=>r.lunaUsage.cached_input_tokens), totalDownstreamTokensSaved: baselineTokens-modelTokens,
      providerCalls: sum(r=>(r.localMetrics?.calls??0)+r.jevCalls), providerTokens: sum(r=>r.localMetrics?.inputTokens??r.modelTokens??0),
      actualAgentObserveExpandCalls: null, oracleExpansionRequests: sum(r=>r.oracleExpansionRequests), fullBrowserAgentTaskCompletion: null,
      costPerSuccessfulTask: null
    };
  }
}
await writeFile(new URL('local-summary.json',root),JSON.stringify({
  warning: 'Twelve single-step synthetic fixture tasks per arm. Actual Codex Luna bounded-choice token usage, including system overhead and cache. No multi-step agent expansion or monetary cost measured. Important gold combines explicit task targets/clue with six safety nodes; much is protected deterministically.', results
},null,2));
console.log(JSON.stringify(results,null,2));
