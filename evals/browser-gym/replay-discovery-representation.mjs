/** Design replay only: does not change runtime, execute actions, or estimate tokens. */
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
if (!input) throw new Error('Provide retained parsed tool-results.json and optional output JSON');
const rows = JSON.parse(readFileSync(input, 'utf8')).filter(row => Array.isArray(row.value?.view?.elements));
const result = { kind: 'proposed-discovery-representation-replay', runtimeImplemented: false,
  modelTokensMeasured: false, semanticRoundTripChecked: true, observations: rows.length, nodes: 0, weak: 0, strong: 0,
  beforeBytes: 0, afterBytes: 0, fieldBytes: { referencePrefixes: 0, weakQuality: 0, context: 0, state: 0, maskedValues: 0 }, perObservation: [] };
for (const row of rows) {
  const next = structuredClone(row), view = next.value.view;
  view.representation = 'source-refs/2'; view.defaultKeyQuality = 'weak';
  for (const node of view.elements) {
    result.nodes++;
    const match = /^r([a-f0-9]{16})\.(.+)$/.exec(node.k);
    if (!match) throw new Error('Unsupported existing reference representation');
    result.fieldBytes.referencePrefixes += 18;
    node.k = `r${Buffer.from(match[1], 'hex').toString('base64url')}.${match[2]}`;
    if (node.kq === 'weak') { result.weak++; result.fieldBytes.weakQuality += Buffer.byteLength(',"kq":"weak"'); delete node.kq; }
    // Existing compact output omits strong; this replay declares it explicitly.
    else if (node.kq === undefined) { result.strong++; node.kq = 'strong'; }
    for (const [field, metric] of [['context', 'context'], ['state', 'state'], ['value', 'maskedValues']]) {
      if (node[field] !== undefined) result.fieldBytes[metric] += Buffer.byteLength(`,"${field}":${JSON.stringify(node[field])}`);
    }
  }
  for (const [index, node] of view.elements.entries()) {
    const restored = structuredClone(node), match = /^r([A-Za-z0-9_-]{11})\.(.+)$/.exec(restored.k);
    if (!match) throw new Error('Unsupported proposed reference representation');
    restored.k = `r${Buffer.from(match[1], 'base64url').toString('hex')}.${match[2]}`;
    if (restored.kq === undefined) restored.kq = view.defaultKeyQuality;
    const original = structuredClone(row.value.view.elements[index]);
    if (original.kq === undefined) original.kq = 'strong';
    // Compare properties independently of serialization order; all other evidence remains exact.
    if (Object.keys(restored).length !== Object.keys(original).length ||
      Object.entries(original).some(([key, value]) => JSON.stringify(restored[key]) !== JSON.stringify(value))) {
      throw new Error('Discovery semantic roundtrip changed evidence');
    }
  }
  const beforeBytes = Buffer.byteLength(JSON.stringify(row)), afterBytes = Buffer.byteLength(JSON.stringify(next));
  result.beforeBytes += beforeBytes; result.afterBytes += afterBytes;
  result.perObservation.push({ source: view.source.id, nodes: view.elements.length, beforeBytes, afterBytes });
}
result.savedBytes = result.beforeBytes - result.afterBytes;
result.reductionPercent = 100 * result.savedBytes / result.beforeBytes;
if (output) writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
