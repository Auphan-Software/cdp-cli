import test from 'node:test';
import assert from 'node:assert/strict';
import {auditReporting} from './audit-reporting.mjs';
const row=(id,time,calls,usage={input_tokens:2,cache_creation_input_tokens:3,cache_read_input_tokens:5,output_tokens:7})=>JSON.stringify({type:'assistant',timestamp:time,message:{id,model:'claude-haiku-5-5',usage,content:calls.map((c,i)=>({type:'tool_use',id:id+i,...c}))}});
const write=(file_path,content='{}')=>({name:'Write',input:{file_path,content}});
test('streamed blocks deduplicate requests and calls; reporting read/rewrite is visible',()=>{
  const rows=[row('a','1',[{name:'Read',input:{file_path:'job.qa.md'}}]),row('b','2',[{name:'mcp__cdp-workflow__snapshot',input:{}}]),row('b','2',[{name:'mcp__cdp-workflow__snapshot',input:{}}]),row('c','3',[write('C:\\trial\\result.json')]),row('d','4',[{name:'Read',input:{file_path:'C:/trial/result.json'}}]),row('e','5',[write('result.json'),write('job.qa.md')])];
  const a=auditReporting(rows.join('\n')+'\n');
  assert.equal(a.phases.browser.requests,1);assert.equal(a.phases.reporting.requests,3);
  assert.equal(a.total,85);assert.equal(a.artifacts[0].writes,2);
  assert.equal(a.artifacts[0].readsAfterWrite,1);assert.equal(a.artifacts[1].readsAfterWrite,0);
  assert.equal(a.flags.length,2);
});
test('complete compact reporting has no flags; over-budget evidence stays visible',()=>{
  const raw=[row('a','1',[{name:'mcp__claude-in-chrome__computer',input:{}}]),row('b','2',[write('result.json'),write('job.qa.md')])].join('\n')+'\n';
  assert.deepEqual(auditReporting(raw).flags,[]);
  assert.match(auditReporting(raw.replace('"content":"{}"','"content":"'+'x'.repeat(4097)+'"')).flags[0],/budget/);
  assert.throws(()=>auditReporting(raw.trimEnd()),/tail/);
  assert.throws(()=>auditReporting(row('a','1',[])+'\n'),/No supported/);
});
