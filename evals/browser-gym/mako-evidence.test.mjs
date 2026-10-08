import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { cashChecks } from './mako-evidence.mjs';
const expected = { cashierEmployeeId:'1441700010',subtotalCents:359,tpsCents:18,tvqCents:36,totalCents:413,tenderCents:500,changeCents:87 };
const sample = () => ({ invoice:{id:100,status:2,employee_id:1441700010,total:4.13,total_paid:4.13,change_amount:.87},
  payments:[{payment_type_id:1,tendered:5,change_amount:.87}],pending:0,boot:{jq:'function',nav:'object',text:'Local Station - Michel Untel'},
  config:{srm_system:'2',end_point:'DEV',cert_offline:'0',certificate:'test',expiry:'2031-10-06 18:13:32'},
  expectedCertificate:'test',expectedExpiry:'2031-10-06 18:13:32',
  txns:[{sent:1,trans_no:'accepted',trans_error_id:null,payload:{noTrans:'100',modPai:'ARG',typTrans:'RFER',modImpr:'FAC',
    items:[{qte:'+00001.00',descr:'Pepsi',prix:'+000000003.59',tax:'FP'}],
    mont:{avantTax:'+000000003.59',TPS:'+000000000.18',TVQ:'+000000000.36',apresTax:'+000000004.13'}}}] });
const review = () => ({reviewer:'controller-pixels',path:resolve('bills/bill.png'),sha256:'a'.repeat(64),invoiceId:100,transaction:'accepted',
  subtotalCents:359,tpsCents:18,tvqCents:36,totalCents:413,items:[{quantity:1,description:'Pepsi',priceCents:359,tax:'FP'}]});
const hash = () => 'a'.repeat(64);
test('cash evidence requires matching persisted payment, RQ and controller-reviewed bill', () => {
  assert.ok(Object.values(cashChecks(sample(),review(),expected,hash)).every(Boolean));
});
test('duplicates, pending requests and restored-fixture drift fail their independent checks', () => {
  const snapshot=sample(); snapshot.txns.push(snapshot.txns[0]); snapshot.pending=1; snapshot.config.end_point='PROD';
  const checks=cashChecks(snapshot,review(),expected,hash);
  assert.equal(checks['rq-accepted-arg'],false); assert.equal(checks['pending-clear'],false); assert.equal(checks['fixture-cleanup'],false);
});
test('wrong bill identity/hash or line discrepancy cannot prove parity', () => {
  const r=review(); r.items[0].priceCents=360;
  assert.equal(cashChecks(sample(),r,expected,hash)['bill-payload-parity'],false);
  r.invoiceId=101;
  assert.equal(cashChecks(sample(),r,expected,hash)['bill-image'],false);
  assert.equal(cashChecks(sample(),review(),expected,()=> 'b'.repeat(64))['bill-image'],false);
});
