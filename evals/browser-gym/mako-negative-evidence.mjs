/** Controller-only negative-case evidence. SQL helpers read; fixture recipes are never executed. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageHash } from './mako-evidence.mjs';

const cases = new Set(['expired-certificate-pay', 'expired-certificate-delete']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cents = value => Math.round(Number(value) * 100);
const integer = value => Number.isSafeInteger(value) && value > 0;
function validate(config, invoiceId) {
  if (!cases.has(config.caseId) || !integer(invoiceId) || !integer(config.stationId ?? 1)) throw new Error('Invalid negative fixture identity');
  if (config.database !== 'mako2_haiku_websrm_gym') throw new Error('Dedicated local gym database required');
  for (const path of [config.worktree, config.psql, config.billSink]) if (!isAbsolute(path ?? '')) throw new Error('Absolute controller paths required');
  const head = execFileSync('git', ['-C', config.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== config.candidate) throw new Error('Product candidate changed');
}

export function negativeSnapshotSql(invoiceId, stationId = 1) {
  if (!integer(invoiceId) || !integer(stationId)) throw new Error('Invalid invoice/station');
  return `SELECT json_build_object(
    'capturedAt',clock_timestamp(),'invoiceId',${invoiceId},'stationId',${stationId},
    'invoice',(SELECT json_build_object('invoice_id',invoice_id,'status',status,'employee_id',employee_id,
      'subtotal',subtotal,'total',total,'total_paid',total_paid,'change_amount',change_amount,
      'web_srm_txn_id',web_srm_txn_id,'printed',printed,'date_close',date_close) FROM mako_invoice WHERE invoice_id=${invoiceId}),
    'sales',COALESCE((SELECT json_agg(json_build_object('sales_id',sales_id,'product_id',product_id,'quantity',quantity,
      'price',price,'unit_price',unit_price,'status',status,'web_srm_txn_id',web_srm_txn_id) ORDER BY sales_id)
      FROM mako_invoice_sales WHERE invoice_id=${invoiceId}),'[]'::json),
    'payments',COALESCE((SELECT json_agg(json_build_object('payment_id',payment_id,'payment_type_id',payment_type_id,
      'tendered',tendered,'change_amount',change_amount,'station_id',station_id) ORDER BY payment_id)
      FROM mako_invoice_payments WHERE invoice_id=${invoiceId}),'[]'::json),
    'txns',COALESCE((SELECT json_agg(json_build_object('txn_id',txn_id,'sent',sent,'trans_no',trans_no,
      'invoice_hash',invoice_hash,'trans_error_id',trans_error_id) ORDER BY txn_id)
      FROM mako_web_srm_txn_log WHERE invoice_id=${invoiceId}),'[]'::json),
    'pending',COALESCE((SELECT json_agg(json_build_object('txn_id',txn_id,'invoice_id',invoice_id,'training',training,
      'pending_action',pending_action,'pending_time',pending_time,'exception',exception,'delete_reason',delete_reason) ORDER BY txn_id)
      FROM mako_web_srm_pending WHERE invoice_id=${invoiceId}),'[]'::json),
    'config',json_build_object('srm_system',(SELECT config_value FROM mako_mako_config WHERE config_type=0 AND config_name='srm_system'),
      'end_point',(SELECT config_value FROM mako_mako_config WHERE config_type=60 AND config_name='web_srm_end_point'),
      'cert_offline',(SELECT config_value FROM mako_mako_config WHERE config_type=60 AND config_name='web_srm_cert_offline'),
      'certificate',(SELECT web_srm_certificate_serial_number FROM mako_stations WHERE station_id=${stationId}),
      'expiry',(SELECT web_srm_certificate_expiry::text FROM mako_stations WHERE station_id=${stationId}),
      'expired',(SELECT web_srm_certificate_expiry < localtimestamp FROM mako_stations WHERE station_id=${stationId})))`;
}

/** A before/after manifest detects new and overwritten PNGs. Identity requires controller pixels, not filenames. */
export function billSinkSnapshot(directory) {
  if (!isAbsolute(directory)) throw new Error('Absolute bill sink required');
  return { directory, complete: true, files: readdirSync(directory).filter(name => /\.png$/i.test(name)).sort().map(name => {
    const path = join(directory, name), stat = statSync(path);
    if (!stat.isFile()) throw new Error('Unexpected PNG sink entry');
    return { path, sha256: imageHash(path), bytes: stat.size };
  }) };
}

export function captureNegative(config, invoiceId) {
  validate(config, invoiceId);
  const snapshot = JSON.parse(execFileSync(config.psql, ['-X', '-h', '127.0.0.1', '-U', 'mako', '-d', config.database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', negativeSnapshotSql(invoiceId, config.stationId ?? 1)],
  { encoding: 'utf8', timeout: 15000, env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' } }));
  return { ...snapshot, caseId: config.caseId, candidate: config.candidate, fixtureFingerprint: config.fixtureFingerprint,
    database: config.database, billSink: billSinkSnapshot(config.billSink) };
}

function artifactValid(evidence, hash) {
  try { return isAbsolute(evidence?.path ?? '') && /^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '') && hash(evidence.path) === evidence.sha256; }
  catch { return false; }
}
export function negativeChecks(before, after, cleanup, review, expected, hash = imageHash, read = path => JSON.parse(readFileSync(path, 'utf8'))) {
  if (!cases.has(before?.caseId)) throw new Error('Unsupported negative case');
  const id = before.invoiceId, pay = before.caseId === 'expired-certificate-pay';
  const identity = integer(id) && [after, cleanup].every(s => s?.invoiceId === id && s.caseId === before.caseId &&
    s.stationId === before.stationId && s.database === before.database && s.candidate === before.candidate && s.fixtureFingerprint === before.fixtureFingerprint);
  const interval = Number.isFinite(Date.parse(before.capturedAt)) && Date.parse(after.capturedAt) >= Date.parse(before.capturedAt);
  const valid = identity && interval && before.config?.expired === true && after.config?.expired === true &&
    before.config?.srm_system === '2' && before.config?.end_point === 'DEV' && before.config?.cert_offline === '0' &&
    before.config?.certificate === expected.certificate && before.config?.expiry === (expected.expiredExpiry ?? '2000-01-01 00:00:00') &&
    same(before.config, after.config) && before.invoice?.status === 1 &&
    before.invoice.invoice_id === id && Array.isArray(before.sales) && before.sales.some(s => s.status === 1) &&
    [before, after].every(s => ['payments', 'txns', 'pending', 'sales'].every(k => Array.isArray(s[k])));
  let dom;
  if (review?.reviewer === 'controller-dom-pixels' && review.invoiceId === id && review.caseId === before.caseId &&
      review.expiredDialogVisible === true && artifactValid(review.image, hash) && artifactValid(review.dom, hash)) {
    try { dom = read(review.dom.path); } catch { /* Invalid controller evidence cannot pass. */ }
  }
  const dialog = valid && dom?.invoiceId === id && dom.stationId === before.stationId && dom.visible === true &&
    dom.action === (pay ? 'cash-payment' : 'customer-failed-to-pay-delete') &&
    Date.parse(dom.capturedAt) >= Date.parse(before.capturedAt) && Date.parse(dom.capturedAt) <= Date.parse(after.capturedAt) &&
    (dom.dialogText?.includes('The Web-SRM certificate of this station has expired. No bill can be produced until it is renewed') ||
      dom.dialogText?.includes('Le certificat Web-SRM de cette station est expiré. Aucune facture ne peut être produite avant son renouvellement'));
  const boot = review?.boot;
  let bootDom;
  if (artifactValid(boot, hash)) { try { bootDom = read(boot.path); } catch {} }
  const bootRole = valid && review?.reviewer === 'controller-dom-pixels' && bootDom?.jq === 'function' &&
    ['object', 'function'].includes(bootDom.nav) && bootDom.text?.includes(expected.cashierName ?? 'Michel Untel') &&
    bootDom.invoiceId === id && bootDom.stationId === before.stationId && before.invoice.employee_id === Number(expected.cashierEmployeeId);
  const beforeFiles = before.billSink?.files, afterFiles = after.billSink?.files;
  const sinkValid = before.billSink?.complete === true && after.billSink?.complete === true &&
    before.billSink.directory === after.billSink.directory && Array.isArray(beforeFiles) && Array.isArray(afterFiles);
  const changed = sinkValid ? afterFiles.filter(file => !beforeFiles.some(old => old.path === file.path && old.sha256 === file.sha256)) : [];
  const noBill = valid && sinkValid && review?.reviewer === 'controller-dom-pixels' &&
    changed.every(file => {
      const rows = (review.deliveries ?? []).filter(r => r.path === file.path && r.sha256 === file.sha256);
      return rows.length === 1 && rows[0].reviewer === 'controller-pixels' && artifactValid(rows[0], hash) &&
        ['bill', 'kitchen', 'other'].includes(rows[0].kind) && integer(rows[0].invoiceId) &&
        !(rows[0].kind === 'bill' && rows[0].invoiceId === id);
    }) && beforeFiles.every(file => afterFiles.some(next => next.path === file.path));
  const preserved = valid && after.invoice?.invoice_id === id && same(before.sales, after.sales);
  const pendingExpected = preserved && before.payments.length === 0 && before.pending.length === 0 && before.txns.length === 0 &&
    after.invoice.status === 2 && after.invoice.web_srm_txn_id === before.invoice.web_srm_txn_id &&
    cents(before.invoice.total) === expected.totalCents && cents(after.invoice.total) === expected.totalCents &&
    cents(after.invoice.change_amount) === expected.changeCents &&
    cents(after.invoice.total_paid) === expected.totalCents && after.payments.length === 1 &&
    after.payments[0].payment_type_id === 1 && after.payments[0].station_id === before.stationId &&
    cents(after.payments[0].tendered) === expected.tenderCents && cents(after.payments[0].change_amount) === expected.changeCents &&
    after.pending.length === 1 && after.pending[0].invoice_id === id && after.pending[0].pending_action === 1 &&
    after.pending[0].training === 0 && after.pending[0].exception === null && after.pending[0].delete_reason === null;
  const checks = {
    'boot-role': !!bootRole, 'expired-cert-dialog': !!dialog,
    'no-new-rq-txn': !!(valid && same(before.txns, after.txns)),
    'fixture-cleanup': !!(identity && Date.parse(cleanup.capturedAt) >= Date.parse(after.capturedAt) && cleanup.config?.expired === false &&
      cleanup.config?.expiry === expected.originalExpiry && cleanup.config?.certificate === expected.certificate &&
      cleanup.config?.srm_system === '2' && cleanup.config?.end_point === 'DEV' && cleanup.config?.cert_offline === '0'),
    'no-bill-delivery': !!noBill
  };
  if (pay) checks['pending-expected'] = !!pendingExpected;
  else checks['invoice-not-deleted'] = !!(preserved && same(before.invoice, after.invoice) &&
    same(before.payments, after.payments) && same(before.pending, after.pending));
  return checks;
}

/** CAS recipe only. Caller must stop other fixture workers and snapshot exact station values first. */
export function expiryRecipe(originalExpiry, certificate, stationId = 1) {
  if (!integer(stationId) || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(originalExpiry) || !/^[A-Fa-f0-9]+$/.test(certificate)) throw new Error('Invalid saved station metadata');
  const expired = '2000-01-01 00:00:00';
  const update = (from, to) => `BEGIN; UPDATE mako_stations SET web_srm_certificate_expiry=TIMESTAMP '${to}' WHERE station_id=${stationId} AND web_srm_certificate_expiry=TIMESTAMP '${from}' AND web_srm_certificate_serial_number='${certificate}' RETURNING station_id,web_srm_certificate_expiry; COMMIT;`;
  return { database: 'mako2_haiku_websrm_gym', setupSql: update(originalExpiry, expired), restoreSql: update(expired, originalExpiry),
    instruction: 'Run only after all other fixture workers stop; require exactly one returned row. Reload a fresh POS request after setup and restoration. Capture refusal before restore. Leave retryable pending evidence intact; restoring expiry may permit cleanup/reprint to transmit. No certificate enrollment/deletion or Windows certificate-store changes.' };
}

export function writeNegativeProof(config, artifactDir, paths) {
  if (!isAbsolute(artifactDir)) throw new Error('Absolute artifact directory required');
  const load = path => JSON.parse(readFileSync(path, 'utf8'));
  const before = load(paths.before), after = load(paths.after), cleanup = load(paths.cleanup), review = load(paths.review);
  validate(config, before.invoiceId);
  if (before.candidate !== config.candidate || before.fixtureFingerprint !== config.fixtureFingerprint || before.caseId !== config.caseId ||
      before.database !== config.database || before.stationId !== (config.stationId ?? 1) ||
      before.billSink?.directory !== config.billSink) throw new Error('Snapshot differs from pinned fixture');
  const checks = negativeChecks(before, after, cleanup, review, config.expected);
  mkdirSync(artifactDir, { recursive: true });
  const evidencePath = join(artifactDir, 'negative-evidence.json');
  writeFileSync(evidencePath, JSON.stringify({ checks, paths }, null, 2));
  const artifacts = [evidencePath, ...Object.values(paths), review.image?.path, review.dom?.path, review.boot?.path,
    ...(review.deliveries ?? []).map(r => r.path)].filter(path => typeof path === 'string');
  const proof = { verifier: 'independent', caseId: config.caseId, candidate: config.candidate, fixtureFingerprint: config.fixtureFingerprint,
    checks: Object.entries(checks).map(([id, passed]) => ({ id, passed, artifacts })) };
  writeFileSync(join(artifactDir, 'proof.json'), JSON.stringify(proof, null, 2));
  return proof;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, configPath, ...args] = process.argv.slice(2), config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (operation === 'snapshot') console.log(JSON.stringify(captureNegative(config, Number(args[0])), null, 2));
    else if (operation === 'proof') {
      const [dir, before, after, cleanup, review] = args;
      const proof = writeNegativeProof(config, dir, { before, after, cleanup, review });
      console.log(JSON.stringify(proof)); process.exitCode = proof.checks.every(c => c.passed) ? 0 : 2;
    } else throw new Error('Usage: snapshot config.json invoiceId | proof config.json artifactDir before.json after.json cleanup.json review.json');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
