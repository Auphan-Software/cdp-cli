/** Payload replay only; never reports simulated model-token savings. */
import {readFileSync,writeFileSync} from 'node:fs';
import {workflowReceipt} from '../../build/workflow-receipt.js';
const [path,out]=process.argv.slice(2);
if(!path) throw Error('Provide a retained Claude JSONL and optional output path');
const tools=new Map(),results=new Map();
for(const line of readFileSync(path,'utf8').trim().split('\n'))for(const block of JSON.parse(line).message?.content??[]){
 if(block.type==='tool_use')tools.set(block.id,block);
 if(block.type==='tool_result')results.set(block.tool_use_id,block);
}
const summary={kind:'historical-payload-replay',modelTokensMeasured:false,beforeBytes:0,afterBytes:0,calls:0,operations:{}};
for(const[id,result]of results){const tool=tools.get(id);if(!tool?.name.startsWith('mcp__cdp-workflow__'))continue;
 const operation=tool.name.split('__').at(-1);const item=summary.operations[operation]??={calls:0,beforeBytes:0,afterBytes:0};
 summary.calls++;item.calls++;
 for(const block of result.content??[]){if(block.type!=='text')continue;
  let after=block.text;try{after=JSON.stringify(workflowReceipt(JSON.parse(block.text),operation,tool.input.full===true));}catch{}
  const a=Buffer.byteLength(block.text),b=Buffer.byteLength(after);summary.beforeBytes+=a;summary.afterBytes+=b;item.beforeBytes+=a;item.afterBytes+=b;
 }
}
summary.reductionPercent=100*(1-summary.afterBytes/summary.beforeBytes);
if(out)writeFileSync(out,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
