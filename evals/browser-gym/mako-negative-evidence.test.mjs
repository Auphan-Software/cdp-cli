import assert from 'node:assert/strict';
import { test } from 'node:test';
import { negativeChecks, negativeSnapshotSql, expiryRecipe, billSinkSnapshot } from './mako-negative-evidence.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sha = 'a'.repeat(64), image = { path: resolve('proof/dialog.png'), sha256: sha }, dom = { path: resolve('proof/dom.json'), sha256: sha };
const expected = { certificate: 'AB12', originalExpiry: '2031-10-06 18:13:32', cashierEmployeeId: '1441700010', totalCents: 413, tenderCents: 500, changeCents: 87 };
function fixture(pay = true) {
  const before = { caseId: pay ? 'expired-certificate-pay' : 'expired-certificate-delete', candidate: 'candidate', fixtureFingerprint: 'fixture',
    invoiceId: 123, stationId: 1, database: 'mako2_haiku_websrm_gym', capturedAt: '2026-10-08T08:00:00Z',
    config: { srm_system: '2', end_point: 'DEV', cert_offline: '0', certificate: 'AB12', expiry: '2000-01-01 00:00:00', expired: true },
    invoice: { invoice_id: 123, status: 1, employee_id: 1441700010, total: '4.13', total_paid: '0', change_amount: '0' },
    sales: [{ sales_id: 1, product_id: 3640, quantity: 1, status: 1 }], payments: [], pending: [], txns: [],
    billSink: { directory: 'C:/autoprint', complete: true, files: [] } };
  const after = structuredClone(before); after.capturedAt = '2026-10-08T08:00:10Z';
  if (pay) {
    after.invoice = { ...before.invoice, status: 2, total_paid: '4.13', change_amount: '0.87' };
    after.payments = [{ payment_id: 1, payment_type_id: 1, tendered: '5.00', change_amount: '0.87', station_id: 1 }];
    after.pending = [{ txn_id: 12, invoice_id: 123, pending_action: 1, training: 0, exception: null, delete_reason: null }];
  }
  const cleanup = structuredClone(after); cleanup.capturedAt = '2026-10-08T08:00:11Z';
  cleanup.config.expired = false; cleanup.config.expiry = expected.originalExpiry;
  const review = { reviewer: 'controller-dom-pixels', caseId: before.caseId, invoiceId: 123, expiredDialogVisible: true,
    image, dom, boot: { path: resolve('proof/boot.json'), sha256: sha }, deliveries: [] };
  const read = path => path === dom.path ? { invoiceId: 123, stationId: 1, capturedAt: '2026-10-08T08:00:05Z', visible: true,
    action: pay ? 'cash-payment' : 'customer-failed-to-pay-delete',
    dialogText: 'The Web-SRM certificate of this station has expired. No bill can be produced until it is renewed in Management, Web SRM.' }
    : { jq: 'function', nav: 'object', text: 'Michel Untel', invoiceId: 123, stationId: 1 };
  return { before, after, cleanup, review, read };
}
const checks = f => negativeChecks(f.before, f.after, f.cleanup, f.review, expected, () => sha, f.read);

test('expired cash refusal expects committed payment and one retryable CLOSE pending, not an unchanged open invoice', () => {
  const f = fixture(); assert.ok(Object.values(checks(f)).every(Boolean));
  for (const mutate of [f => { f.after.pending[0].exception = 'error'; }, f => { f.after.pending[0].pending_action = 2; },
    f => { f.after.payments[0].tendered = 10; }, f => { f.after.invoice.status = 1; },
    f => { f.after.sales[0].quantity = 2; }, f => { f.after.pending.push({ ...f.after.pending[0], txn_id: 13 }); }]) {
    const bad = fixture(); mutate(bad); assert.equal(checks(bad)['pending-expected'], false);
  }
});
test('failure-to-pay expiry refusal preserves invoice, sales, payments and pending rows', () => {
  assert.ok(Object.values(checks(fixture(false))).every(Boolean));
  for (const mutate of [f => { f.after.invoice.status = 3; }, f => { f.after.sales = []; },
    f => { f.after.payments = [{ payment_id: 1 }]; }, f => { f.after.pending = [{ txn_id: 12 }]; }]) {
    const bad = fixture(false); mutate(bad); assert.equal(checks(bad)['invoice-not-deleted'], false);
  }
});
test('new RQ transactions and changed existing transaction evidence fail', () => {
  const f = fixture(); f.after.txns = [{ txn_id: 1 }]; assert.equal(checks(f)['no-new-rq-txn'], false);
  const g = fixture(false); g.before.txns = [{ txn_id: 1, sent: 0 }]; g.after.txns = [{ txn_id: 1, sent: 1 }];
  assert.equal(checks(g)['no-new-rq-txn'], false);
});
test('worker PASS, hidden/wrong/old dialog DOM and changed image cannot prove refusal', () => {
  for (const mutate of [f => { f.review.reviewer = 'worker'; }, f => { f.review.expiredDialogVisible = false; },
    f => { f.review.image.sha256 = 'b'.repeat(64); }, f => { f.read = () => ({ visible: true, invoiceId: 999 }); },
    f => { const read = f.read; f.read = path => ({ ...read(path), capturedAt: '2026-10-08T07:00:00Z' }); }]) {
    const f = fixture(); mutate(f); assert.equal(checks(f)['expired-cert-dialog'], false);
  }
});
test('bill sink checks classify every changed PNG by controller-reviewed invoice identity, ignoring unrelated concurrent bills', () => {
  const f = fixture();
  const file = { path: resolve('autoprint/new.png'), sha256: sha, bytes: 123 };
  f.after.billSink.files = [file];
  assert.equal(checks(f)['no-bill-delivery'], false); // No invoice identity yet.
  f.review.deliveries = [{ ...file, reviewer: 'controller-pixels', invoiceId: 999, kind: 'bill' }];
  assert.equal(checks(f)['no-bill-delivery'], true);
  f.review.deliveries[0].invoiceId = 123;
  assert.equal(checks(f)['no-bill-delivery'], false);
  f.review.deliveries[0].kind = 'kitchen';
  assert.equal(checks(f)['no-bill-delivery'], true);
  f.before.billSink.files = [{ ...file, sha256: 'b'.repeat(64) }]; // Overwrite is still a new delivery.
  f.review.deliveries = [];
  assert.equal(checks(f)['no-bill-delivery'], false);
  f.after.billSink.files = [];
  assert.equal(checks(f)['no-bill-delivery'], false); // Disappearing evidence cannot prove absence.
});
test('cleanup requires exact restored expiry/certificate and same candidate/fixture identities', () => {
  for (const mutate of [f => { f.cleanup.config.expiry = '2032-01-01 00:00:00'; },
    f => { f.cleanup.config.certificate = 'CD34'; }, f => { f.after.invoiceId = 999; },
    f => { f.after.candidate = 'other'; }, f => { f.after.fixtureFingerprint = 'other'; }]) {
    const f = fixture(); mutate(f); assert.equal(checks(f)['fixture-cleanup'], false);
  }
});
test('read-only SQL scopes all invoice relations and fixture recipe changes only station expiry through compare-and-swap', () => {
  const sql = negativeSnapshotSql(123);
  assert.match(sql, /^SELECT /); assert.doesNotMatch(sql, /UPDATE|DELETE|INSERT|signature|pan|memo/);
  assert.equal((sql.match(/WHERE invoice_id=123/g) ?? []).length, 5);
  assert.throws(() => negativeSnapshotSql('123; DELETE'));
  const recipe = expiryRecipe(expected.originalExpiry, expected.certificate);
  assert.match(recipe.setupSql, /SET web_srm_certificate_expiry=TIMESTAMP '2000/);
  assert.match(recipe.restoreSql, /AND web_srm_certificate_expiry=TIMESTAMP '2000/);
  assert.match(recipe.restoreSql, /AND web_srm_certificate_serial_number='AB12'/);
  assert.doesNotMatch(recipe.restoreSql, /SET web_srm_certificate_serial_number/);
  assert.throws(() => expiryRecipe("2031-01-01';delete", 'AB12'));
});
test('actual sink manifests hash files so same-name overwritten PNGs are detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'negative-sink-'));
  try {
    const path = join(dir, 'invoice.png'); writeFileSync(path, 'first');
    const before = billSinkSnapshot(dir); writeFileSync(path, 'changed');
    const after = billSinkSnapshot(dir);
    assert.equal(before.complete, true); assert.equal(before.files.length, 1);
    assert.notEqual(before.files[0].sha256, after.files[0].sha256);
    assert.equal(before.files[0].path, after.files[0].path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
