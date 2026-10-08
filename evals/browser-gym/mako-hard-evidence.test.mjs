import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardChecks, hardFixtureRecipe, hardSnapshotSql, modifierFixtureNote } from './mako-hard-evidence.mjs';

const sha = 'a'.repeat(64), path = 'C:/autoprint/bill.png';
const originalFixture = { qst: '5678912340TQ0001', printNotes: '1', water: { product_id: 3651, invoice_print: 0 },
  waterPrices: [{ line_id: 1, size_id: 1, store_id: 14417, price: 2.39, status: 1 }, { line_id: 1, size_id: 2, store_id: 14417, price: 1.99, status: 1 }] };
function fixture(caseId) {
  const expected = { certificate: 'AB12', originalExpiry: '2031-10-06 18:13:32', originalFixture,
    invalidQst: '1234567890TQ0001', cashierEmployeeId: '1441700010', totalCents: 413 };
  const before = { caseId, invoiceId: 123, stationId: 1, candidate: 'candidate', fixtureFingerprint: 'fixture', database: 'mako2_haiku_websrm_gym',
    capturedAt: '2026-10-08T09:00:00Z', config: { srm_system: '2', end_point: 'DEV', cert_offline: '0', certificate: 'AB12', expiry: expected.originalExpiry, expired: false },
    fixture: structuredClone(originalFixture), invoice: { invoice_id: 123, status: 1, employee_id: 1441700010, total: 4.13, total_paid: 0 },
    sales: [{ sales_id: 1, product_id: 3640, quantity: 1, status: 1, price: 3.59 }], salesNotes: [], payments: [], txns: [], pending: [],
    billSink: { directory: 'C:/autoprint', complete: true, files: [] } };
  if (caseId === 'no-printable-item') { before.fixture.water.invoice_print = 1; before.fixture.waterPrices.forEach(p => p.price = 0); }
  if (caseId === 'invalid-tax-identity') before.fixture.qst = expected.invalidQst;
  const after = structuredClone(before); after.capturedAt = '2026-10-08T09:01:00Z';
  after.invoice.status = 2; after.invoice.web_srm_txn_id = 3;
  after.billSink.files = [{ path, sha256: sha }];
  const payload = { noTrans: '123', typTrans: 'RFER', modImpr: 'FAC', modPai: 'ARG', noTax: { noTVQ: before.fixture.qst },
    items: [{ descr: 'Pepsi', qte: '+00001.00', prix: '+000000003.59', tax: 'FP', acti: 'RES' }],
    mont: { avantTax: 3.59, TPS: 0.18, TVQ: 0.36, apresTax: 4.13 } };
  const txn = { txn_id: 3, idx: 0, sent: 1, trans_no: 'accepted', trans_error_id: null, errors: null, payload };
  after.txns = [txn];
  if (['zero-total-netting', 'no-printable-item'].includes(caseId)) {
    after.invoice.total = 0; after.invoice.total_paid = 0; payload.modPai = 'AUC'; Object.keys(payload.mont).forEach(k => payload.mont[k] = 0);
  }
  if (caseId === 'zero-total-netting') {
    txn.idx = 2; payload.noTrans = '123-2';
    after.payments = [{ tendered: 5, change_amount: 0.87, change_to: 1 }, { tendered: -4, change_amount: 0, change_to: 1 }, { tendered: -0.13, change_amount: 0, change_to: 1 }];
    after.txns.unshift({ txn_id: 1, idx: 0, sent: 1, payload: { modPai: 'ARG', mont: { apresTax: 4.13 } } },
      { txn_id: 2, idx: 1, sent: 1, payload: { mont: { apresTax: -4.13 } } });
  }
  if (caseId === 'no-printable-item') {
    after.sales = [{ sales_id: 1, product_id: 3651, quantity: 1, status: 1, price: 0 }];
    payload.items = [{ descr: 'SOB', qte: '+00001.00', prix: '+000000000.00', tax: 'SOB', acti: 'SOB' }];
  }
  if (caseId === 'long-modifier') {
    after.salesNotes = [{ sales_id: 1, product_id: 3640, notes: modifierFixtureNote }];
    payload.items[0].preci = [{ descr: modifierFixtureNote.slice(0, 127), acti: 'SOB' }];
  }
  if (caseId === 'invalid-tax-identity') { txn.trans_error_id = 'JW00B999540E'; txn.errors = [{ id: 'JW00B999522E' }]; }
  const cleanup = structuredClone(after); cleanup.capturedAt = '2026-10-08T09:02:00Z'; cleanup.fixture = structuredClone(originalFixture);
  const review = { reviewer: 'controller-pixels', caseId, invoiceId: 123, txnId: 3, path, sha256: sha, transaction: 'accepted',
    boot: { path: 'C:/proof/boot.json', sha256: sha }, text: caseId === 'invalid-tax-identity' ? 'CERTIFICAT INVALIDE NE PAS REMETTRE AU CLIENT' : 'AUCUN PAIEMENT',
    displayedTransactionAbsent: true, qst: expected.invalidQst, amounts: Object.fromEntries(Object.entries(payload.mont).map(([k,v]) => [k, Math.round(v*100)])),
    items: payload.items.map(i => ({ description: i.descr, quantity: Number(i.qte), priceCents: Math.round(Number(i.prix)*100), tax: i.tax, precisions: (i.preci ?? []).map(d => d.descr) })) };
  return { before, after, cleanup, review, expected, read: () => ({ jq: 'function', nav: 'object', text: 'Michel Untel', invoiceId: 123, stationId: 1 }) };
}
const check = f => hardChecks(f.before, f.after, f.cleanup, f.review, f.expected, () => sha, f.read);
for (const caseId of ['zero-total-netting', 'long-modifier', 'no-printable-item', 'invalid-tax-identity']) {
  test(`${caseId} passes only with actual controller bill/boot identity and restored fixture`, () => {
    assert.ok(Object.values(check(fixture(caseId))).every(Boolean));
    const f = fixture(caseId); f.review.reviewer = 'worker'; assert.equal(check(f)['bill-image'], false);
    const g = fixture(caseId); g.cleanup.fixture.qst = 'other'; assert.equal(check(g)['fixture-cleanup'], false);
    const h = fixture(caseId); h.after.billSink.files = []; assert.equal(check(h)['bill-image'], false);
    const wrong = fixture(caseId); wrong.review.txnId = 1; assert.equal(check(wrong)['bill-image'], false);
  });
}
test('zero netting rejects plain unpaid zero bill, residual money and tip incorrectly subtracted as cash', () => {
  const f = fixture('zero-total-netting'); f.after.payments = []; assert.equal(check(f)['zero-total-netting'], false);
  const g = fixture('zero-total-netting'); g.after.payments[2].tendered = -0.12; assert.equal(check(g)['zero-total-netting'], false);
  const h = fixture('zero-total-netting'); h.after.payments[0].change_to = 2; assert.equal(check(h)['zero-total-netting'], false);
  const extra = fixture('zero-total-netting'); extra.after.txns.push({ txn_id: 4 }); assert.equal(check(extra)['zero-total-netting'], false);
});
test('SOB must be exactly one complete synthetic item, with real nonprinting zero-price Water and no payment', () => {
  for (const mutate of [f => f.after.txns[0].payload.items.push({ descr: '' }), f => f.after.txns[0].payload.items[0].tax = 'NON',
    f => f.after.sales[0].price = 1, f => f.after.fixture.water.invoice_print = 0, f => f.after.payments.push({ tendered: 0 })]) {
    const f = fixture('no-printable-item'); mutate(f);
    assert.ok(!check(f)['no-print-fixture'] || !check(f)['rq-one-sob-item']);
  }
});
test('modifier fixture is a real persisted item note crossing character128; transmitted description is exact127 without space', () => {
  assert.equal(modifierFixtureNote[127], ' '); assert.ok(modifierFixtureNote.length > 128);
  const f = fixture('long-modifier'); f.after.txns[0].payload.items[0].preci[0].descr += ' ';
  assert.equal(check(f)['rq-description-no-trailing-space'], false);
  const g = fixture('long-modifier'); g.after.salesNotes = []; assert.equal(check(g)['modifier-boundary-fixture'], false);
  const h = fixture('long-modifier'); h.after.fixture.printNotes = '0'; assert.equal(check(h)['modifier-boundary-fixture'], false);
  const missingPixels = fixture('long-modifier'); missingPixels.review.items[0].precisions = [];
  assert.equal(check(missingPixels)['bill-payload-parity'], false);
  const reordered = fixture('long-modifier'); reordered.cleanup.fixture = Object.fromEntries(Object.entries(reordered.cleanup.fixture).reverse());
  assert.equal(check(reordered)['fixture-cleanup'], true);
});
test('tax mismatch requires specific RQ identity error, both printed marks and matching invalid QST', () => {
  const f = fixture('invalid-tax-identity'); f.after.txns[0].errors = [{ id: 'JW00B999034E' }]; assert.equal(check(f)['rq-identity-error'], false);
  const g = fixture('invalid-tax-identity'); g.review.text = 'CERTIFICAT INVALIDE'; assert.equal(check(g)['bill-both-invalid-marks'], false);
  const h = fixture('invalid-tax-identity'); h.review.displayedTransactionAbsent = false; assert.equal(check(h)['bill-both-invalid-marks'], false);
});
test('snapshot SQL is read-only, strips signature, and recipe statements CAS only known local fixture values', () => {
  const sql = hardSnapshotSql(123); assert.match(sql, /^WITH base AS \(SELECT/); assert.doesNotMatch(sql, /UPDATE|DELETE|INSERT/);
  assert.match(sql, /json::jsonb - 'signa'/); assert.throws(() => hardSnapshotSql('1; DELETE'));
  const water = hardFixtureRecipe('no-printable-item', originalFixture);
  assert.equal(water.setupSql.length, 3); assert.match(water.restoreSql[1], /AND price=0/); assert.match(water.restoreSql[1], /store_id=14417/);
  const qst = hardFixtureRecipe('invalid-tax-identity', originalFixture);
  assert.match(qst.setupSql[0], /AND config_value='5678912340TQ0001'/); assert.match(qst.restoreSql[0], /AND config_value='1234567890TQ0001'/);
  assert.doesNotMatch(qst.setupSql[0], /certificate/); assert.throws(() => hardFixtureRecipe('invalid-tax-identity', { qst: "';DELETE" }));
  assert.deepEqual(hardFixtureRecipe('zero-total-netting', originalFixture).setupSql, []);
});
