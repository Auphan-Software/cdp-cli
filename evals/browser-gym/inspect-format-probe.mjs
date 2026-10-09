/** Read-only transport comparison on one explicitly owned current page. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {callWorkflowTool} from '../../build/workflow-mcp.js';
const [page,out]=process.argv.slice(2);
if(!page||!out||!process.env.CDP_SESSION) throw Error('Usage: set CDP_SESSION; node inspect-format-probe.mjs EXACT_OWNED_PAGE OUTPUT_DIR');
if(process.env.CDP_PAGE&&process.env.CDP_PAGE!==page) throw Error('CDP_PAGE differs from exact requested page');
process.env.CDP_PAGE=page;
// The production bridge dispatches through its own entry point. Preserve that
// behavior when importing it from this standalone diagnostic helper.
process.argv[1]=resolve('build/index.js');
mkdirSync(out,{recursive:true});
const measurements=[];
for(const [name,args] of [
  ['ax',['snapshot',page,'--format','ax','--redact-values']],
  ['ax-json',['snapshot',page,'--format','ax','--redact-values','--json']],
  ['text',['snapshot',page,'--format','text']]
]) {
  const raw=execFileSync(process.execPath,[resolve('build/index.js'),'--session',process.env.CDP_SESSION,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
  writeFileSync(resolve(out,name+'.txt'),raw);
  let lines=raw.trimEnd().split('\n');
  if(name==='ax-json') lines=JSON.parse(raw).data.lines;
  measurements.push({name,transportBytes:Buffer.byteLength(raw),rows:lines.length,actionableSelectors: name==='text'?false:true,sha256:createHash('sha256').update(raw).digest('hex')});
}
for(const operation of ['snapshot','observe']) {
  const response=await callWorkflowTool(operation,{task:'Read-only comparison of current page discovery formats; no browser actions or navigation.'});
  const raw=JSON.stringify(response);
  writeFileSync(resolve(out,'mcp-'+operation+'.json'),raw+'\n');
  const blocks=response.content??[];
  const text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const value=JSON.parse(text);
  if(response.isError||value.success===false) throw Error('MCP '+operation+' refused: '+text);
  measurements.push({name:'mcp-'+operation,transportBytes:Buffer.byteLength(raw),textBytes:Buffer.byteLength(text),images:blocks.filter(b=>b.type==='image').length,sha256:createHash('sha256').update(raw).digest('hex')});
}
const summary={scope:'Sequential read-only current-page format probe; byte measurements are not model tokens or E2E cost. No actions, navigation, payment or fixture changes. CLI ax values redacted; text is body.innerText and has no selector/redaction contract. Raw artifacts remain local.',session:process.env.CDP_SESSION,page,measurements};
writeFileSync(resolve(out,'metrics.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
