import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../build/state/store.js';
import { projectState, mustKeep } from '../../build/experimental/decision.js';
import { boundWorkflowResult, workflowViewProfile } from '../../build/workflow-output.js';
import { compactWorkflowResult } from '../../build/workflow-compact.js';

const [corpusPath, outputPath] = process.argv.slice(2);
if (!corpusPath || !outputPath) throw new Error('Usage: node replay-compact.mjs CORPUS OUTPUT');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'cdp-compact-replay-'));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const rows = [];
for (const entry of corpus) {
  const receipt = entry.text.map(t => { try { return JSON.parse(t); } catch { return null; } }).find(r => r?.value?.view);
  if (!receipt) continue;
  const path = receipt.value.canonicalPath;
  if (!path || !existsSync(path)) { rows.push({ index: entry.index, unavailable: 'canonical' }); continue; }
  const canonical = JSON.parse(readFileSync(path, 'utf8'));
  const fullPath = receipt.value.output?.fullPath;
  if (receipt.value.output?.bounded && (!fullPath || !existsSync(fullPath))) { rows.push({ index: entry.index, unavailable: 'full-workflow' }); continue; }
  const full = fullPath ? JSON.parse(readFileSync(fullPath, 'utf8')) : structuredClone(receipt);
  const evidence = { hints: canonical.hints, diff: full.value.view.diff, errors: full.value.view.errors,
    targets: full.value.action?.targetKey ? [full.value.action.targetKey] : [], protectVisibleActions: true };
  // Use complete canonical capture and original evidence, not transmitted node substitutions.
  full.value.view = await projectState(entry.input.task, canonical, { ...evidence, prune: !entry.input.full });
  delete full.value.output;
  const keys = mustKeep(entry.input.task, canonical, evidence);
  const store = new StateStore('http://replay', canonical.session, canonical.targetId, root);
  writeFileSync(join(store.dir, `${canonical.id}.json`), JSON.stringify(canonical));
  const baseline = boundWorkflowResult(full, join(root, `baseline-${entry.index}.json`), keys, workflowViewProfile({}));
  const candidate = compactWorkflowResult(full, store, canonical.captureProfile, entry.name.split('__').at(-1), keys,
    workflowViewProfile({ CDP_WORKFLOW_VIEW_PROFILE: 'haiku-compact' }),
    { full: entry.input.full, task: entry.input.task, hints: canonical.hints, targets: evidence.targets });
  for (const field of ['commandSucceeded', 'deliveryUnknown', 'actionDelivered']) {
    if (candidate.value.action?.[field] !== full.value.action?.[field]) throw new Error(`Delivery changed: ${entry.index}/${field}`);
  }
  if (candidate.value.view.source.id !== canonical.id) throw new Error('Source changed');
  const refs = candidate.value.view.elements.map(n => n.k);
  if (new Set(refs).size !== refs.length) throw new Error('Reference collision');
  rows.push({ index: entry.index, operation: entry.name.split('__').at(-1), canonicalAvailable: true,
    fullEvidence: fullPath ? 'artifact' : 'unbounded-receipt', baselineBytes: bytes(baseline), candidateBytes: bytes(candidate),
    baselineElements: baseline.value.view.elements.length, candidateElements: candidate.value.view.elements.length,
    candidateOmissions: candidate.value.output, exclusions: candidate.value.recovery.excluded,
    diagnosticsErrors: full.value.view.errors.length, deliveredErrors: candidate.value.view.errors.length });
}
const total = field => rows.reduce((sum, row) => sum + (row[field] ?? 0), 0);
const summary = { type: 'reconstructed-serializer-byte-replay', tokenSavingsProven: false,
  limitations: ['Baseline uses current bounding implementation, not the pinned runtime.', 'Excludes settling, dispatch, MCP budget blocks, images and evidence-recovery turns.', 'Not a model completion-cost or behavioral-equivalence measurement.'], root, rows,
  unavailable: rows.filter(r => r.unavailable).length, baselineBytes: total('baselineBytes'), candidateBytes: total('candidateBytes') };
summary.byteReduction = 1 - summary.candidateBytes / summary.baselineBytes;
writeFileSync(outputPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
