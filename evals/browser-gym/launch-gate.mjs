/** Read-only admission gate. A failed check exits before the caller may launch Jarvis. */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readiness } from './gym.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function launchGate(config, launch, dependencies = {}) {
  const exists = dependencies.exists ?? existsSync, digest = dependencies.hash ?? hash;
  const read = dependencies.read ?? (path => JSON.parse(readFileSync(path, 'utf8')));
  const head = dependencies.head ?? (path => execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim());
  const blockers = [...readiness(config, exists, digest).blockers];
  for (const key of ['worktree','buildInfoPath','entry','mcpPath','promptFile']) {
    if (!isAbsolute(config[key] ?? '') || !exists(config[key])) blockers.push(`Missing absolute ${key}`);
  }
  if (blockers.length) return {ready:false,blockers};
  const build = read(config.buildInfoPath), server = read(config.mcpPath).mcpServers?.['cdp-workflow'];
  if (build.dirty !== false || build.commit !== config.toolCommit) blockers.push('Build identity is not the pinned clean commit');
  if (!['current-24k', 'rich-64k'].includes(config.profile)) blockers.push('Unsupported transport profile');
  if (!server || !['node', 'node.exe'].includes(server.command) || !Array.isArray(server.args) || server.args.length !== 2 ||
      resolve(server.args[0] ?? '') !== resolve(config.entry) || server.args[1] !== 'workflow-mcp')
    blockers.push('Project MCP does not launch the pinned workflow entry');
  if (server?.env?.CDP_WORKFLOW_VIEW_PROFILE !== config.profile) blockers.push('MCP transport profile differs from declared arm');
  if (server?.env?.CDP_RERANK_URL !== 'off') blockers.push('Reranker must be off for the initial view comparison');
  for (const [key, maximum] of [['CDP_WORKFLOW_MAX_ACTIONS',30],['CDP_WORKFLOW_DEADLINE_MS',600000]]) {
    const raw=server?.env?.[key];
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) <= 0 || Number(raw) > maximum)
      blockers.push(`Missing bounded ${key}`);
  }
  if (head(config.worktree) !== config.candidate) blockers.push('Product candidate changed');
  if (!/^[a-f0-9]{64}$/.test(config.promptHash ?? '') || digest(config.promptFile) !== config.promptHash)
    blockers.push('Operator prompt differs from pinned digest');
  if (launch.model !== config.model || launch.effort !== config.effort || launch.runtime !== 'claude' ||
      launch.autocompact !== config.autocompact || launch.use_worktree !== false ||
      resolve(launch.working_dir ?? '') !== resolve(config.worktree)) blockers.push('Launch settings differ from declared arm');
  return {ready:blockers.length === 0,blockers,toolCommit:build.commit,profile:config.profile,promptHash:config.promptHash};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [configPath,launchPath]=process.argv.slice(2);
    const result=launchGate(JSON.parse(readFileSync(configPath,'utf8')),JSON.parse(readFileSync(launchPath,'utf8')));
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.ready ? 0 : 2;
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
