import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./results/', import.meta.url);
const read = async name => JSON.parse((await readFile(new URL(name, root), 'utf8')).replace(/^\uFEFF/, ''));
const percentile = (values, p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] ?? null;
const sum = (rows, fn) => rows.reduce((total,row)=>total+fn(row),0);
const cohorts = {};
for (const [cohort,file] of [['main','gpu-claude-workflow.json'],['jev','gpu-claude-jev.json'],['cache','gpu-claude-cache.json']]) {
  const data = await read(file); const arms = {};
  for (const arm of new Set(data.rows.map(r=>r.arm))) {
    const rows = data.rows.filter(r=>r.arm===arm), observations=rows.flatMap(r=>r.observations), success=rows.filter(r=>r.success);
    const usage = Object.fromEntries(['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens'].map(k=>[k,sum(rows,r=>r.usage?.[k]??0)]));
    const criticalMeasured = observations.every(o=>Number.isSafeInteger(o.criticalFalseNegativeNodes));
    const totalCostUsd=sum(rows,r=>r.totalCostUsd??0);
    const jevInputTokens=sum(rows,r=>arm==='jev'?r.providerMetrics?.inputTokens??0:0);
    const jevEstimatedCostUsd=jevInputTokens*.042/1e6;
    arms[arm]={runs:rows.length,successes:success.length,usage,totalRecordedTokens:Object.values(usage).reduce((a,b)=>a+b,0),
      missingUsageRuns:rows.filter(r=>!r.usageValid).length,toolCalls:sum(rows,r=>r.toolCalls),toolBatches:sum(rows,r=>r.toolRounds),
      assistantResponses:sum(rows,r=>r.inferenceRequests),toolKinds:Object.fromEntries([...new Set(rows.flatMap(r=>r.calls.map(c=>c.name)))].map(name=>[name,sum(rows,r=>r.calls.filter(c=>c.name===name).length)])),
      rejectedTools:sum(rows,r=>r.calls.filter(c=>c.failed).length),meanElapsedMs:sum(rows,r=>r.elapsedMs)/rows.length,
      elapsedP50Ms:percentile(rows.map(r=>r.elapsedMs),.5),elapsedP95Ms:percentile(rows.map(r=>r.elapsedMs),.95),
      meanSuccessfulElapsedMs:success.length?sum(success,r=>r.elapsedMs)/success.length:null,
      reportedClaudeCostUsd:totalCostUsd,jevInputTokens,jevEstimatedCostUsd,
      estimatedCostPerSuccessUsd:success.length?(totalCostUsd+jevEstimatedCostUsd)/success.length:null,
      providerCalls:sum(rows,r=>r.providerMetrics?.calls??0),providerLatencyMs:sum(rows,r=>r.providerMetrics?.latencyMs??0),
      providerCacheHits:sum(rows,r=>r.providerMetrics?.cacheHits??0),projectionP50Ms:percentile(observations.map(o=>o.projectionMs),.5),projectionP95Ms:percentile(observations.map(o=>o.projectionMs),.95),
      providerFallbacks:observations.filter(o=>o.providerStatus==='fallback').length,
      canonicalNodes:sum(observations,o=>o.canonicalNodes),retainedNodes:sum(observations,o=>o.projectedNodes),
      canonicalCharacters:sum(observations,o=>o.canonicalCharacters),projectedCharacters:sum(observations,o=>o.projectedCharacters),
      estimatedProjectedTokens:sum(observations,o=>Math.ceil(o.projectedCharacters/4)),
      goldNodes:sum(observations,o=>o.goldNodes),goldOmissions:sum(observations,o=>o.falseNegativeNodes),
      criticalGoldNodes:criticalMeasured?sum(observations,o=>o.criticalGoldNodes):null,criticalGoldOmissions:criticalMeasured?sum(observations,o=>o.criticalFalseNegativeNodes):null};
  }
  cohorts[cohort]=arms;
}
const batch=await read('gpu-q8-batch.json'), workload=await read('gpu-q8-workload.json');
const vision={};
for(const model of ['minicpm','qwen-vl']){
  const data=await read(`gpu-${model}-vision.json`);vision[model]={};
  for(const arm of new Set(data.rows.map(r=>r.arm))){const rows=data.rows.filter(r=>r.arm===arm);vision[model][arm]={runs:rows.length,rawCorrect:rows.filter(r=>r.rawCorrect).length,failures:rows.filter(r=>r.failure).length,minMs:Math.min(...rows.map(r=>r.ms)),maxMs:Math.max(...rows.map(r=>r.ms)),p50Ms:percentile(rows.map(r=>r.ms),.5)};}
}
const report={warning:'Controlled transcript-derived Claude Opus5.5 reproduction/evidence pilot, 2 tasks x 2 repeats per arm. Cohorts are separate. Reported CLI list-price estimates exclude hardware and are not invoices. The main run lacks critical-node identities; do not retroactively assert zero critical omissions. Text-only visual abstention is expected, even though rawCorrect compares to the hidden visual target.',cohorts,
  batch:Object.fromEntries([...new Set(batch.rows.map(r=>r.units))].map(n=>[n,{runs:batch.rows.filter(r=>r.units===n).length,p50Ms:percentile(batch.rows.filter(r=>r.units===n).map(r=>r.ms),.5)}])),
  savedFixtureProjection:{runs:workload.rows.length,p50Ms:percentile(workload.rows.map(r=>r.projectionMs),.5),p95Ms:percentile(workload.rows.map(r=>r.projectionMs),.95),fallbacks:workload.rows.filter(r=>r.status!=='applied').length},vision};
await writeFile(new URL('gpu-summary.json',root),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
