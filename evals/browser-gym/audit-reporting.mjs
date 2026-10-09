import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {auditNative} from './gym.mjs';

const fields=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens'];
const basename=p=>String(p??'').replaceAll('\\','/').split('/').at(-1);
export function auditReporting(raw) {
  if(!raw.endsWith('\n')) throw Error('Incomplete transcript tail');
  const rows=raw.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const groups=new Map();
  for(const row of rows) {
    if(row.type!=='assistant'||!row.message?.usage) continue;
    const id=row.message.id??row.uuid;
    if(!id) throw Error('Missing assistant message identity');
    const g=groups.get(id)??{id,time:row.timestamp,calls:new Map(),rows:[]};
    if(row.timestamp<g.time) g.time=row.timestamp;
    g.rows.push(row);
    for(const b of row.message.content??[]) if(b.type==='tool_use') g.calls.set(b.id,b);
    groups.set(id,g);
  }
  const messages=[...groups.values()].sort((a,b)=>String(a.time).localeCompare(String(b.time)));
  const browser=c=>/^mcp__(claude-in-chrome|cdp-workflow)__/.test(c.name);
  const indices=messages.flatMap((m,i)=>[...m.calls.values()].some(browser)?[i]:[]);
  if(!indices.length) throw Error('No supported browser calls; phase attribution unavailable');
  const first=indices[0],last=indices.at(-1);
  const phases={};
  for(const [name,start,end] of [['setup',0,first],['browser',first,last+1],['reporting',last+1,messages.length]]) {
    const slice=messages.slice(start,end);
    const audit=auditNative(slice.flatMap(m=>m.rows.map(r=>JSON.stringify(r))).join('\n')+'\n');
    phases[name]={requests:slice.length,usage:audit.usage,processedTokens:audit.processedTokens,estimatedApiUsd:audit.estimatedApiUsd};
  }
  const calls=messages.flatMap((m,i)=>[...m.calls.values()].map(c=>({...c,request:i+1})));
  const artifacts=['result.json','job.qa.md'].map(name=>{
    const writes=calls.filter(c=>c.name==='Write'&&basename(c.input?.file_path)===name);
    const reads=calls.filter(c=>c.name==='Read'&&basename(c.input?.file_path)===name&&writes.some(w=>w.request<c.request));
    return {name,writes:writes.length,readsAfterWrite:reads.length,writeBytes:writes.map(w=>Buffer.byteLength(w.input?.content??'')),requests:writes.map(w=>w.request)};
  });
  const flags=artifacts.flatMap(a=>[
    ...(a.writes!==1?[`${a.name}: expected one final write, observed ${a.writes}`]:[]),
    ...(a.readsAfterWrite?[`${a.name}: read after write; inspect recovery justification`]:[]),
    ...(a.writeBytes.some(n=>n>4096)?[`${a.name}: exceeds4096-byte reporting budget; inspect required-content justification`]:[])
  ]);
  return {scope:'Actor usage only; phases split at first and last supported browser-tool requests. Flags require review, not automatic rejection of justified recovery.',phases,artifacts,flags,total:auditNative(raw).processedTokens};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(auditReporting(readFileSync(process.argv[2],'utf8')),null,2));}
  catch(e) {console.error(e.message);process.exitCode=1;}
}
