import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {launchGate} from './launch-gate.mjs';
const digest='a'.repeat(64), path=resolve('fixture');
const sample=()=>({candidate:'product',fixtureFingerprint:'fingerprint',model:'claude-haiku-5-5',toolCommit:'tool',caseId:'cash-pepsi',
  profile:'rich-64k',profileImplemented:true,fixtureReady:true,loginProven:true,cashierRoleProven:true,spaBootProven:true,
  rqDevProven:true,receiptCaptureProven:true,exclusiveBrowserProven:true,verifierReady:true,stopBudgetEnforced:true,
  skill:{canonical:path,installed:path},worktree:path,buildInfoPath:resolve('build.json'),entry:resolve('index.js'),
  mcpPath:resolve('mcp.json'),promptFile:resolve('prompt.md'),promptHash:digest,effort:'medium',autocompact:'250k'});
const server=()=>({mcpServers:{'cdp-workflow':{command:'node.exe',args:[resolve('index.js'),'workflow-mcp'],env:{CDP_WORKFLOW_VIEW_PROFILE:'rich-64k',
  CDP_RERANK_URL:'off',CDP_WORKFLOW_MAX_ACTIONS:'30',CDP_WORKFLOW_DEADLINE_MS:'600000'}}}});
const launch=()=>({model:'claude-haiku-5-5',effort:'medium',runtime:'claude',autocompact:'250k',use_worktree:false,working_dir:path});
const deps=(mcp=server(),build={commit:'tool',dirty:false})=>({exists:()=>true,hash:()=>digest,head:()=> 'product',
  read:p=>p.endsWith('build.json') ? build : mcp});
test('the pinned local arm is admitted with exact build, instructions, model and bounded MCP',()=>{
  assert.equal(launchGate(sample(),launch(),deps()).ready,true);
});
test('stale build, wrong profile, prompt drift and absent action cap refuse launch',()=>{
  assert.equal(launchGate(sample(),launch(),deps(server(),{commit:'old',dirty:false})).ready,false);
  assert.equal(launchGate(sample(),launch(),deps(server(),{commit:'tool',dirty:true})).ready,false);
  const mcp=server();mcp.mcpServers['cdp-workflow'].env.CDP_WORKFLOW_VIEW_PROFILE='current-24k';
  assert.equal(launchGate(sample(),launch(),deps(mcp)).ready,false);
  delete mcp.mcpServers['cdp-workflow'].env.CDP_WORKFLOW_MAX_ACTIONS;
  assert.ok(launchGate(sample(),launch(),deps(mcp)).blockers.some(b=>b.includes('MAX_ACTIONS')));
  const config=sample();config.promptHash='b'.repeat(64);
  assert.equal(launchGate(config,launch(),deps()).ready,false);
  const request=launch();request.model='claude-sonnet-5-5';
  assert.equal(launchGate(sample(),request,deps()).ready,false);
});
test('a failed readiness gate stops before inspecting any launchable build',()=>{
  const config=sample();config.loginProven=false;
  const dependencies=deps();dependencies.read=()=>{throw new Error('must not inspect build')};
  assert.equal(launchGate(config,launch(),dependencies).ready,false);
});

test('unsupported profile, unrelated runtime and extra process arguments cannot launch a mislabeled arm',()=>{
  const config=sample(), mcp=server();config.profile='unsupported';mcp.mcpServers['cdp-workflow'].env.CDP_WORKFLOW_VIEW_PROFILE='unsupported';
  assert.equal(launchGate(config,launch(),deps(mcp)).ready,false);
  for(const mutate of [s=>{s.command='python';},s=>{s.args.push('--invented');}]){
    const modified=server();mutate(modified.mcpServers['cdp-workflow']);
    assert.equal(launchGate(sample(),launch(),deps(modified)).ready,false);
  }
});
