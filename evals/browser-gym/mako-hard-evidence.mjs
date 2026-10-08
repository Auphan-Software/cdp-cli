/** Read-only controller evidence for wi-8367 hard cases. Never changes product fixtures. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { negativeSnapshotSql, billSinkSnapshot } from './mako-negative-evidence.mjs';
import { imageHash } from './mako-evidence.mjs';

const cases = new Set(['zero-total-netting', 'long-modifier', 'no-printable-item', 'invalid-tax-identity']);
const cents = value => Math.round(Number(value) * 100);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const integer = value => Number.isSafeInteger(value) && value > 0;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && isAbsolute(a) && isAbsolute(b) && resolve(a) === resolve(b);
export const modifierFixtureNote = 'Note: ' + 'a'.repeat(121) + ' ' + 'boundary tail'; // Character 128 is a space.

export function hardSnapshotSql(invoiceId, stationId = 1) {
  return `WITH base AS (${negativeSnapshotSql(invoiceId, stationId)}) SELECT base.json_build_object::jsonb || jsonb_build_object(
    'salesNotes',COALESCE((SELECT jsonb_agg(jsonb_build_object('sales_id',sales_id,'product_id',product_id,'notes',notes) ORDER BY sales_id)
      FROM mako_invoice_sales WHERE invoice_id=${invoiceId}),'[]'::jsonb),
    'payments',COALESCE((SELECT jsonb_agg(jsonb_build_object('payment_id',payment_id,'payment_type_id',payment_type_id,
      'tendered',tendered,'change_amount',change_amount,'change_to',change_to,'station_id',station_id) ORDER BY payment_id)
      FROM mako_invoice_payments WHERE invoice_id=${invoiceId}),'[]'::jsonb),
    'txns',COALESCE((SELECT jsonb_agg(jsonb_build_object('txn_id',txn_id,'idx',idx,'sent',sent,'trans_no',trans_no,
      'trans_error_id',trans_error_id,'errors',trans_error_json::jsonb,'payload',json::jsonb - 'signa') ORDER BY txn_id)
      FROM mako_web_srm_txn_log WHERE invoice_id=${invoiceId}),'[]'::jsonb),
    'fixture',jsonb_build_object(
      'qst',(SELECT config_value FROM mako_mako_config WHERE config_type=60 AND config_name='web_srm_qst_file_number'),
      'printNotes',(SELECT config_value FROM mako_mako_config WHERE config_type=0 AND config_name='print_receipt_notes'),
      'water',(SELECT jsonb_build_object('product_id',product_id,'invoice_print',invoice_print) FROM mako_inventory_products WHERE product_id=3651),
      'waterPrices',COALESCE((SELECT jsonb_agg(jsonb_build_object('line_id',line_id,'size_id',size_id,'store_id',store_id,'price',price,'status',status) ORDER BY line_id,size_id,store_id)
        FROM mako_price_line_products WHERE product_id=3651),'[]'::jsonb))) FROM base`;
}
function validate(config, invoiceId) {
  if (!cases.has(config.caseId) || !integer(invoiceId) || config.database !== 'mako2_haiku_websrm_gym') throw new Error('Dedicated hard-case fixture required');
  for (const path of [config.worktree, config.psql, config.billSink]) if (!isAbsolute(path ?? '')) throw new Error('Absolute controller paths required');
  if (execFileSync('git', ['-C', config.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== config.candidate) throw new Error('Product candidate changed');
}
export function captureHard(config, invoiceId) {
  validate(config, invoiceId);
  const snapshot = JSON.parse(execFileSync(config.psql, ['-X', '-h', '127.0.0.1', '-U', 'mako', '-d', config.database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', hardSnapshotSql(invoiceId, config.stationId ?? 1)],
  { encoding: 'utf8', timeout: 15000, env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' } }));
  return { ...snapshot, caseId: config.caseId, candidate: config.candidate, database: config.database,
    fixtureFingerprint: config.fixtureFingerprint, billSink: billSinkSnapshot(config.billSink) };
}
function artifact(evidence, hash) {
  try { return isAbsolute(evidence?.path ?? '') && /^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '') && hash(evidence.path) === evidence.sha256; }
  catch { return false; }
}
const paymentNet = payments => payments.reduce((sum, p) => sum + cents(p.tendered) - ([1, 4].includes(p.change_to) ? cents(p.change_amount) : 0), 0);
export function hardChecks(before, after, cleanup, review, expected, hash = imageHash, read = path => JSON.parse(readFileSync(path, 'utf8'))) {
  if (!cases.has(before?.caseId)) throw new Error('Unsupported hard case');
  const id = before.invoiceId;
  const identity = integer(id) && [after, cleanup].every(s => s?.invoiceId === id && s.caseId === before.caseId &&
    s.stationId === before.stationId && s.database === before.database && s.candidate === before.candidate && s.fixtureFingerprint === before.fixtureFingerprint);
  const ordered = Date.parse(before.capturedAt) <= Date.parse(after.capturedAt) && Date.parse(after.capturedAt) <= Date.parse(cleanup.capturedAt);
  const valid = identity && ordered && before.invoice?.invoice_id === id && before.invoice.status === 1 &&
    after.invoice?.invoice_id === id && after.invoice.status === 2 && before.config?.expired === false && after.config?.expired === false &&
    same(before.fixture, after.fixture) && [before, after].every(s => s.config?.srm_system === '2' && s.config?.end_point === 'DEV' && s.config?.cert_offline === '0' &&
      s.config.certificate === expected.certificate && s.config.expiry === expected.originalExpiry &&
      ['sales', 'salesNotes', 'payments', 'txns', 'pending'].every(key => Array.isArray(s[key]))) && before.txns.length === 0;
  const txn = after.txns?.find(t => t.txn_id === after.invoice?.web_srm_txn_id), payload = txn?.payload ?? {}, items = payload.items ?? [];
  const current = valid && !!txn && Array.isArray(items) && after.pending.length === 0 && payload.noTrans === `${id}${txn.idx ? `-${txn.idx}` : ''}` &&
    payload.typTrans === 'RFER' && payload.modImpr === 'FAC';
  const accepted = current && txn.sent === 1 && !!txn.trans_no && !txn.trans_error_id && (!txn.errors || (Array.isArray(txn.errors) && txn.errors.length === 0));
  let boot;
  if (review?.reviewer === 'controller-pixels' && artifact(review.boot, hash)) { try { boot = read(review.boot.path); } catch {} }
  const bootRole = valid && boot?.jq === 'function' && ['object', 'function'].includes(boot.nav) && boot.invoiceId === id && boot.stationId === before.stationId &&
    boot.text?.includes(expected.cashierName ?? 'Michel Untel') && before.invoice.employee_id === Number(expected.cashierEmployeeId);
  const sink = before.billSink?.complete === true && after.billSink?.complete === true && before.billSink.directory === after.billSink.directory &&
    Array.isArray(before.billSink.files) && Array.isArray(after.billSink.files) && after.billSink.files.some(file =>
      samePath(file.path, review?.path) && file.sha256 === review.sha256 && !before.billSink.files.some(old => samePath(old.path, file.path) && old.sha256 === file.sha256));
  const bill = current && sink && review?.reviewer === 'controller-pixels' && review.invoiceId === id && review.caseId === before.caseId &&
    review.txnId === txn.txn_id && artifact(review, hash);
  const parity = bill && review.transaction === txn.trans_no && Array.isArray(review.items) && review.items.length === items.length &&
    items.every((item, i) => review.items[i]?.description === item.descr && review.items[i]?.quantity === Number(item.qte) &&
      review.items[i]?.priceCents === cents(item.prix) && review.items[i]?.tax === item.tax &&
      same(review.items[i]?.precisions ?? [], (item.preci ?? []).map(detail => detail.descr))) &&
    ['avantTax', 'TPS', 'TVQ', 'apresTax'].every(key => review.amounts?.[key] === cents(payload.mont?.[key]));
  const cleanupGood = identity && ordered && cleanup.config?.expired === false && same(cleanup.config, before.config) &&
    same(cleanup.fixture, expected.originalFixture);
  const checks = { 'boot-role': !!bootRole, 'bill-image': !!bill, 'fixture-cleanup': !!cleanupGood };
  if (before.caseId === 'zero-total-netting') {
    checks['zero-total-netting'] = !!(current && before.payments.length === 0 && after.payments.length >= 2 &&
      after.payments.some(p => cents(p.tendered) > 0) && after.payments.some(p => cents(p.tendered) < 0) &&
      paymentNet(after.payments) === 0 && cents(after.invoice.total) === 0 && cents(after.invoice.total_paid) === 0 && txn.idx === 2 && after.txns.length === 3 &&
      after.txns.some(t => t.idx === 0 && t.sent === 1 && t.payload?.modPai === 'ARG' && cents(t.payload?.mont?.apresTax) === expected.totalCents) &&
      after.txns.some(t => t.idx === 1 && t.sent === 1 && cents(t.payload?.mont?.apresTax) === -expected.totalCents));
    checks['rq-auc-accepted'] = !!(accepted && payload.modPai === 'AUC' && ['avantTax', 'TPS', 'TVQ', 'apresTax'].every(key => cents(payload.mont?.[key]) === 0));
    checks['bill-aucun-paiement'] = !!(bill && review.text?.includes('AUCUN PAIEMENT') && review.amounts?.apresTax === 0);
    checks['bill-payload-parity'] = !!parity;
  } else if (before.caseId === 'no-printable-item') {
    const water = after.fixture?.water, prices = after.fixture?.waterPrices;
    checks['no-print-fixture'] = !!(current && water?.product_id === 3651 && water.invoice_print === 1 && Array.isArray(prices) && prices.length > 0 &&
      prices.every(p => cents(p.price) === 0) && after.sales.length === 1 && after.sales[0].product_id === 3651 &&
      after.sales[0].status === 1 && Number(after.sales[0].quantity) === 1 && cents(after.sales[0].price) === 0 && after.payments.length === 0);
    checks['rq-one-sob-item'] = !!(accepted && items.length === 1 && items[0].descr === 'SOB' && Number(items[0].qte) === 1 &&
      cents(items[0].prix) === 0 && items[0].tax === 'SOB' && items[0].acti === 'SOB' && !items[0].preci);
    checks['rq-auc-accepted'] = !!(accepted && payload.modPai === 'AUC' && ['avantTax', 'TPS', 'TVQ', 'apresTax'].every(key => cents(payload.mont?.[key]) === 0));
  } else if (before.caseId === 'long-modifier') {
    const note = expected.modifierNote ?? modifierFixtureNote, chars = Array.from(note);
    const description = chars.slice(0, 128).join('').trim();
    const stored = after.salesNotes?.filter(s => s.notes === note), details = items.flatMap(i => i.preci ?? []);
    checks['modifier-boundary-fixture'] = !!(current && chars.length > 128 && chars[127] === ' ' && chars[126] !== ' ' &&
      /^[\x20-\x7e]+$/.test(note) && after.fixture?.printNotes === '1' && stored?.length === 1 &&
      after.sales.length === 1 && after.sales[0].product_id === 3640 && stored[0].sales_id === after.sales[0].sales_id);
    checks['rq-description-no-trailing-space'] = !!(accepted && details.some(d => d.descr === description && Array.from(d.descr).length === 127 &&
      d.descr === d.descr.trim() && d.acti === 'SOB'));
    checks['rq-accepted-arg'] = !!(accepted && payload.modPai === 'ARG' && cents(payload.mont?.apresTax) === expected.totalCents);
    checks['invoice-payment-totals'] = !!(current && cents(after.invoice.total) === expected.totalCents &&
      cents(after.invoice.total_paid) === expected.totalCents && cents(after.invoice.change_amount) === expected.changeCents &&
      after.payments.length === 1 && after.payments[0].payment_type_id === 1 && after.payments[0].station_id === before.stationId &&
      cents(after.payments[0].tendered) === expected.tenderCents && cents(after.payments[0].change_amount) === expected.changeCents);
    checks['bill-payload-parity'] = !!parity;
  } else {
    const errors = Array.isArray(txn?.errors) ? txn.errors : [];
    checks['rq-identity-error'] = !!(current && txn.sent === 1 && after.fixture?.qst === expected.invalidQst &&
      after.fixture.qst !== expected.originalFixture?.qst && payload.noTax?.noTVQ === expected.invalidQst &&
      [txn.trans_error_id, ...errors.map(e => e.id)].includes('JW00B999522E'));
    checks['bill-both-invalid-marks'] = !!(bill && review.text?.includes('CERTIFICAT INVALIDE') &&
      review.text.includes('NE PAS REMETTRE AU CLIENT') && review.displayedTransactionAbsent === true && review.qst === expected.invalidQst);
  }
  return checks;
}

/** Recipes only: snapshot values first; stop other workers; require one row for each CAS. */
export function hardFixtureRecipe(caseId, original) {
  if (!cases.has(caseId)) throw new Error('Unsupported fixture');
  if (caseId === 'zero-total-netting') return { database: 'mako2_haiku_websrm_gym', setupSql: [], restoreSql: [], journey: 'Fresh Pepsi invoice → Cash $5 → Recall Invoice → OK → invoice discount preset 100% Proprio → existing Customer Unhappy reason → refund Cash -$4.00 and -$0.13 → close. Proprio names the preset, not a second reason. Preserve all three payment rows and initial/recall/final transactions.' };
  if (caseId === 'long-modifier') return { database: 'mako2_haiku_websrm_gym', setupSql: [], restoreSql: [], modifierNote: modifierFixtureNote,
    journey: 'Fresh Pepsi invoice → select Pepsi line → Modify → item Notes → enter modifierNote → save → Pay → Cash $5. Verify print_receipt_notes=1 before launch; do not substitute invoice notes.' };
  if (caseId === 'invalid-tax-identity') {
    if (!/^\d{10}TQ\d{4}$/.test(original.qst)) throw new Error('Invalid original QST');
    const update = (from, to) => `UPDATE mako_mako_config SET config_value='${to}' WHERE config_type=60 AND config_name='web_srm_qst_file_number' AND config_value='${from}' RETURNING config_value;`;
    return { database: 'mako2_haiku_websrm_gym', setupSql: [update(original.qst, '1234567890TQ0001')], restoreSql: [update('1234567890TQ0001', original.qst)],
      journey: 'Reload fresh POS request after QST change → fresh Pepsi invoice → Pay → Cash $5 → inspect RQ error and actual invalid bill. Restore QST exactly and reload. Certificate serial/key/store remain unchanged.' };
  }
  if (original.water?.product_id !== 3651 || !Number.isSafeInteger(original.water.invoice_print) || !Array.isArray(original.waterPrices) || !original.waterPrices.length) throw new Error('Saved Water fixture required');
  const prices = original.waterPrices.map(p => {
    if (![p.line_id, p.size_id, p.store_id].every(integer) || !/^\d+(?:\.\d+)?$/.test(String(p.price))) throw new Error('Invalid saved Water price');
    const update = (from, to) => `UPDATE mako_price_line_products SET price=${to} WHERE product_id=3651 AND line_id=${p.line_id} AND size_id=${p.size_id} AND store_id=${p.store_id} AND price=${from} RETURNING product_id,size_id,price;`;
    return { setup: update(p.price, 0), restore: update(0, p.price) };
  });
  return { database: 'mako2_haiku_websrm_gym', setupSql: [...prices.map(p => p.setup), `UPDATE mako_inventory_products SET invoice_print=1 WHERE product_id=3651 AND invoice_print=${original.water.invoice_print} RETURNING product_id,invoice_print;`],
    restoreSql: [`UPDATE mako_inventory_products SET invoice_print=${original.water.invoice_print} WHERE product_id=3651 AND invoice_print=1 RETURNING product_id,invoice_print;`, ...prices.map(p => p.restore)],
    journey: 'Run setup statements atomically in dedicated gym DB, requiring one returned row each. Reload POS → fresh counter invoice → Add → Drinks → Water (3651), quantity one → Pay → Payment is complete → Done. No cash/payment insertion. Restore touched prices/print flag atomically and reload; verify fixture snapshot.' };
}
export function writeHardProof(config, artifactDir, paths) {
  const load = path => JSON.parse(readFileSync(path, 'utf8'));
  const before = load(paths.before), after = load(paths.after), cleanup = load(paths.cleanup), review = load(paths.review);
  validate(config, before.invoiceId);
  if (!isAbsolute(artifactDir) || before.caseId !== config.caseId || before.candidate !== config.candidate || before.fixtureFingerprint !== config.fixtureFingerprint ||
      before.stationId !== (config.stationId ?? 1) || before.database !== config.database || before.billSink?.directory !== config.billSink) throw new Error('Pinned fixture identity mismatch');
  const checks = hardChecks(before, after, cleanup, review, config.expected);
  mkdirSync(artifactDir, { recursive: true }); const evidence = join(artifactDir, 'hard-evidence.json');
  writeFileSync(evidence, JSON.stringify({ paths, checks }, null, 2));
  const artifacts = [evidence, ...Object.values(paths), review.path, review.boot?.path].filter(p => typeof p === 'string');
  const proof = { verifier: 'independent', caseId: config.caseId, candidate: config.candidate, fixtureFingerprint: config.fixtureFingerprint,
    checks: Object.entries(checks).map(([id, passed]) => ({ id, passed, artifacts })) };
  writeFileSync(join(artifactDir, 'proof.json'), JSON.stringify(proof, null, 2)); return proof;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, configPath, ...args] = process.argv.slice(2), config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (operation === 'snapshot') console.log(JSON.stringify(captureHard(config, Number(args[0])), null, 2));
    else if (operation === 'proof') {
      const [dir, before, after, cleanup, review] = args, proof = writeHardProof(config, dir, { before, after, cleanup, review });
      console.log(JSON.stringify(proof)); process.exitCode = proof.checks.every(c => c.passed) ? 0 : 2;
    } else throw new Error('Usage: snapshot config invoiceId | proof config artifactDir before after cleanup review');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
