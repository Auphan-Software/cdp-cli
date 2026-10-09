import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const workRoot = process.argv[2], output = process.argv[3];
if (!workRoot || !output) throw Error('Usage: export-coordinate-benchmark.mjs WORK_ROOT OUTPUT_JSON');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const runs = [['native01',1,'native'], ['native02',2,'native'], ['visual02',2,'visual'], ['hybrid02',2,'hybrid'], ['native03',3,'native'], ['hybrid03',3,'hybrid'], ['hybrid04',4,'hybrid']];
const metrics = runs.map(([name, number, arm]) => {
  const dir = path.join(workRoot, `visual-coordinate-bench-${String(number).padStart(2,'0')}`, arm);
  const accounting = read(path.join(dir,'accounting.json')), summary = read(path.join(dir,'summary.json'));
  const pick = (object, fields) => Object.fromEntries(fields.filter(k => object[k] !== undefined).map(k => [k,object[k]]));
  const identityPath = path.join(dir,'identity.json'), resultPath = path.join(dir,'controller-result.json');
  const identity = fs.existsSync(identityPath) ? read(identityPath) : {};
  const result = fs.existsSync(resultPath) ? read(resultPath) : undefined;
  const toolPath = path.join(dir,'tool-results.json');
  const screenshots = fs.existsSync(toolPath) ? read(toolPath).map(r => r.value?.screenshot).filter(s => s?.available) : [];
  const dimensions = {};
  for (const s of screenshots) { const key = `${s.pixelWidth}x${s.pixelHeight}`; dimensions[key] = (dimensions[key] ?? 0) + 1; }
  const files = ['accounting.json','summary.json','identity.json','controller-result.json','before.json','after.json','cleanup.json','boot.json','bill-review.json'].filter(n => fs.existsSync(path.join(dir,n)));
  return {name, evidenceDirectory:dir, actorOnly:true,
    identity:pick(identity,['model','effort','autocompact','toolCommit','productCommit','contractHash','noteHash','adapterHash']),
    accounting:pick(accounting,['usage','processedTokens','models','estimatedApiUsd','compactionCostComplete','usageScope','pricingAsOf','peakInputTokens','compactionBoundaries','elapsedSeconds','toolCalls','toolNames','toolErrors']),
    browser:pick(summary,['browserCalls','deliveredImages','browserTextBytes','coordinateClicks','snapshots','typed']),
    imageMetadata: screenshots.length ? {dimensions,coordinateUnaligned:screenshots.filter(s => s.coordinateAligned === false).length} : undefined,
    controller:result ? pick(result,['outcome','passed','total','invoiceId','expectedNoteLength','storedNoteLength','storedExact','billHash']) : {outcome:'blocked; no eligible new-invoice baseline'},
    evidenceSha256:Object.fromEntries(files.map(n => [n,hash(path.join(dir,n))])),
    rawTranscript:{path:accounting.rawTranscriptPath,sha256:hash(accounting.rawTranscriptPath)}
  };
});
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,JSON.stringify({scope:'Recorded actor usage; controller boot, monitoring, verification and reviews excluded. Failed attempts retained separately. One sequential successful pair plus prompt-policy candidate; not statistical or amortized workflow proof.',native03Images:'Independent inspection of extracted JPEGs: nine617x338, one1234x676.',runs:metrics},null,2)+'\n');
console.log(JSON.stringify({exported:output,runs:metrics.length}));
