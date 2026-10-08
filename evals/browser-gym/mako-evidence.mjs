/** Controller-side cash-pilot evidence adapter. It never performs browser or payment actions. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const imageHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const cents = value => Math.round(Number(value) * 100);
export function cashChecks(snapshot, review, expected, hash = imageHash) {
  const invoice = snapshot.invoice ?? {}, payments = snapshot.payments ?? [], txns = snapshot.txns ?? [];
  const txn = txns.length === 1 ? txns[0] : {};
  const payload = txn.payload ?? {};
  const items = payload.items ?? [];
  const imageValid = review?.reviewer === 'controller-pixels' && isAbsolute(review.path ?? '') &&
    review.invoiceId === invoice.id && /^[a-f0-9]{64}$/.test(review.sha256 ?? '') && hash(review.path) === review.sha256;
  const parity = imageValid && review.transaction === txn.trans_no &&
    review.totalCents === expected.totalCents && review.subtotalCents === expected.subtotalCents &&
    review.tpsCents === expected.tpsCents && review.tvqCents === expected.tvqCents &&
    Array.isArray(review.items) && review.items.length === items.length &&
    items.every((item, index) => review.items[index]?.quantity === Number(item.qte) &&
      review.items[index]?.description === item.descr && review.items[index]?.priceCents === cents(item.prix) &&
      review.items[index]?.tax === item.tax) &&
    cents(payload.mont?.avantTax) === expected.subtotalCents && cents(payload.mont?.TPS) === expected.tpsCents &&
    cents(payload.mont?.TVQ) === expected.tvqCents && cents(payload.mont?.apresTax) === expected.totalCents;
  return {
    'boot-role': snapshot.boot?.jq === 'function' && ['object', 'function'].includes(snapshot.boot?.nav) &&
      snapshot.boot?.text?.includes('Michel Untel') && invoice.employee_id === Number(expected.cashierEmployeeId),
    'invoice-payment-totals': invoice.status === 2 && cents(invoice.total) === expected.totalCents &&
      cents(invoice.total_paid) === expected.totalCents && cents(invoice.change_amount) === expected.changeCents &&
      payments.length === 1 && payments[0].payment_type_id === 1 &&
      cents(payments[0].tendered) === expected.tenderCents && cents(payments[0].change_amount) === expected.changeCents,
    'rq-accepted-arg': txns.length === 1 && txn.sent === 1 && !!txn.trans_no && !txn.trans_error_id &&
      payload.modPai === 'ARG' && payload.typTrans === 'RFER' && payload.modImpr === 'FAC' &&
      payload.noTrans === String(invoice.id) && items.length === 1 && items[0].descr === 'Pepsi' &&
      Number(items[0].qte) === 1 && cents(items[0].prix) === expected.subtotalCents && items[0].tax === 'FP',
    'pending-clear': snapshot.pending === 0,
    'bill-image': imageValid,
    'bill-payload-parity': !!parity,
    'fixture-cleanup': snapshot.config?.srm_system === '2' && snapshot.config?.end_point === 'DEV' &&
      snapshot.config?.cert_offline === '0' && snapshot.config?.certificate === snapshot.expectedCertificate &&
      snapshot.config?.expiry === snapshot.expectedExpiry
  };
}

export function collectCash(config, invoiceId, artifactDir, bootPath, reviewPath) {
  if (config.caseId !== 'cash-pepsi') throw new Error('This adapter currently verifies cash-pepsi only');
  if (!/^mako2_haiku_[a-z0-9_]+$/.test(config.database ?? '')) throw new Error('Expected a dedicated local Haiku fixture database');
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new Error('Invalid invoice ID');
  for (const path of [config.worktree, artifactDir, bootPath, reviewPath]) if (!isAbsolute(path)) throw new Error('Absolute artifact paths required');
  const candidate = execFileSync('git', ['-C', config.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (candidate !== config.candidate) throw new Error('Product candidate changed');
  const query = `SELECT json_build_object(
    'invoice',(SELECT json_build_object('id',invoice_id,'status',status,'employee_id',employee_id,
      'total',total,'total_paid',total_paid,'change_amount',change_amount) FROM mako_invoice WHERE invoice_id=${invoiceId}),
    'payments',COALESCE((SELECT json_agg(json_build_object('payment_type_id',payment_type_id,'tendered',tendered,
      'change_amount',change_amount)) FROM mako_invoice_payments WHERE invoice_id=${invoiceId}),'[]'::json),
    'txns',COALESCE((SELECT json_agg(json_build_object('id',txn_id,'sent',sent,'trans_no',trans_no,
      'trans_error_id',trans_error_id,'payload',json::jsonb - 'signa')) FROM mako_web_srm_txn_log WHERE invoice_id=${invoiceId}),'[]'::json),
    'pending',(SELECT count(*) FROM mako_web_srm_pending WHERE invoice_id=${invoiceId}),
    'config',json_build_object(
      'srm_system',(SELECT config_value FROM mako_mako_config WHERE config_type=0 AND config_name='srm_system'),
      'end_point',(SELECT config_value FROM mako_mako_config WHERE config_type=60 AND config_name='web_srm_end_point'),
      'cert_offline',(SELECT config_value FROM mako_mako_config WHERE config_type=60 AND config_name='web_srm_cert_offline'),
      'certificate',(SELECT web_srm_certificate_serial_number FROM mako_stations WHERE station_id=1),
      'expiry',(SELECT web_srm_certificate_expiry::text FROM mako_stations WHERE station_id=1)))`;
  const snapshot = JSON.parse(execFileSync(config.psql, ['-X', '-h', '127.0.0.1', '-U', 'mako', '-d', config.database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8', timeout: 15000 }));
  snapshot.boot = JSON.parse(readFileSync(bootPath, 'utf8')).value;
  snapshot.expectedCertificate = config.certificate;
  snapshot.expectedExpiry = config.expiry;
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
  const checks = cashChecks(snapshot, review, config.expected);
  mkdirSync(artifactDir, { recursive: true });
  const evidencePath = join(artifactDir, 'cash-evidence.json');
  writeFileSync(evidencePath, JSON.stringify({ candidate, fixtureFingerprint: config.fixtureFingerprint, invoiceId, snapshot, checks }, null, 2));
  const proof = { verifier: 'independent', caseId: config.caseId, candidate, fixtureFingerprint: config.fixtureFingerprint,
    checks: Object.entries(checks).map(([id, passed]) => ({ id, passed, artifacts:
      id.startsWith('bill-') ? [evidencePath, reviewPath, review.path] : [evidencePath, bootPath] })) };
  writeFileSync(join(artifactDir, 'proof.json'), JSON.stringify(proof, null, 2));
  return proof;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [configPath, invoice, artifacts, boot, review] = process.argv.slice(2);
    const proof = collectCash(JSON.parse(readFileSync(configPath, 'utf8')), Number(invoice), artifacts, boot, review);
    console.log(JSON.stringify(proof));
    process.exitCode = proof.checks.every(check => check.passed) ? 0 : 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
