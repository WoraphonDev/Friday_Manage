// รอบ 4 · O40 · คิว e-Tax (etax_jobs): ลองใหม่ 3 ครั้ง · แจ้งยกเลิก · ฉบับออกแทน · ใบลด / เพิ่มหนี้ · ผลที่มาช้า · ผู้ซื้อจากเอกสาร
// ผู้ให้บริการเป็นตัวปลอม (FakeETax) · ข้อมูลสมมติเท่านั้น
import { createHmac, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { type Db, replaceTaxDocument } from '@friday/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SYSTEM_DB } from '../src/db/db.module.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { ETAX_PROVIDER, ETaxError, FakeETax, HttpETax } from '../src/payments/providers.js';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let etax: FakeETax;
let svc: PaymentsService;
let sys: Db;
let lead: Client;
let ws: string;
let wsId: string;
let csrf = '';
const profile = { companyName: 'บริษัท อีแท็กซ์ทดสอบ จำกัด', taxId: '0105561234567', branchType: 'head', address: '7 ถนนสมมติ กรุงเทพฯ 10110', taxEmail: 'etax@example.com', whtEnabled: false };

const put = (url: string, body: object) => lead.agent.put(`/api/v1${url}`).set('x-csrf-token', csrf).send(body);
function stripe(providerRef: string, invoiceId: string) {
  const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: providerRef, metadata: { invoice_id: invoiceId } } } });
  const ts = Math.floor(Date.now() / 1000);
  return supertest(t.app.getHttpServer()).post('/api/v1/hooks/stripe').set('content-type', 'application/json').set('stripe-signature', `t=${ts},v1=${createHmac('sha256', 'whsec_dev_fake').update(`${ts}.${raw}`).digest('hex')}`).send(raw);
}
const etaxHook = (body: object) => {
  const raw = JSON.stringify(body);
  return supertest(t.app.getHttpServer()).post('/api/v1/hooks/etax').set('content-type', 'application/json').set('x-etax-signature', `sha256=${createHmac('sha256', 'etax_dev_fake').update(raw).digest('hex')}`).send(raw);
};
/** ใบแจ้งหนี้บัตรที่ชำระแล้ว → ใบกำกับภาษี (ส่ง e-Tax ทันทีหลังรับเงิน) */
async function paid() {
  const r = await lead.agent.post(`/api/v1${ws}/billing/checkout`).set('x-csrf-token', csrf).set('Idempotency-Key', `idem-${randomUUID()}`).send({ plan: 'team_m', cycle: 'monthly', method: 'card' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const ref = (await t.owner.query('SELECT provider_ref FROM payments WHERE invoice_id = $1', [r.body.invoice.id])).rows[0].provider_ref;
  expect((await stripe(ref, r.body.invoice.id)).status).toBe(200);
  const doc = (await t.owner.query(`SELECT id, number, status, provider_ref FROM tax_documents WHERE invoice_id = $1`, [r.body.invoice.id])).rows[0];
  return { invoiceId: r.body.invoice.id as string, doc: doc as { id: string; number: string; status: string; provider_ref: string | null } };
}
const job = async (docId: string, action = 'issue') => (await t.owner.query(`SELECT * FROM etax_jobs WHERE doc_id = $1 AND action = $2`, [docId, action])).rows[0];
const docRow = async (id: string) => (await t.owner.query(`SELECT status, provider_ref FROM tax_documents WHERE id = $1`, [id])).rows[0];
/** เลื่อนเวลาลองใหม่ให้ถึงแล้ว (แทนการรอ 10 นาที) */
const due = () => t.owner.query(`UPDATE etax_jobs SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`);
const audits = async (action: string) => (await t.owner.query(`SELECT summary, target_id FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at`, [wsId, action])).rows;

beforeAll(async () => {
  t = await startApp();
  const team = await seedTeam(t, { slug: 'etax-demo' });
  lead = team.lead;
  ws = team.ws;
  csrf = ((await lead.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', ['etax-demo'])).rows[0].id;
  await lead.get(`${ws}/billing`);
  expect((await put(`${ws}/billing/profile`, profile)).status).toBe(200);
  etax = t.app.get(ETAX_PROVIDER) as FakeETax;
  svc = t.app.get(PaymentsService);
  sys = t.app.get(SYSTEM_DB);
});
afterAll(() => t.close());

describe('ลองใหม่และผู้ซื้อที่ล็อกในเอกสาร', () => {
  it('ผู้ให้บริการล่ม: ลอง 3 ครั้ง ห่าง 10 นาที แล้ว failed · ส่งใหม่ใช้ผู้ซื้อตามเอกสาร ไม่ใช่โปรไฟล์ที่แก้ทีหลัง', async () => {
    etax.failNext(3);
    const { doc } = await paid();
    let j = await job(doc.id);
    expect(j).toMatchObject({ doc_kind: 'tax_document', status: 'pending', attempts: 1, last_error: '503 · ผู้ให้บริการปิดปรับปรุง' });
    expect(Math.round((new Date(j.next_attempt_at).getTime() - new Date(j.last_attempt_at).getTime()) / 60_000)).toBe(10);
    expect((await docRow(doc.id)).status).toBe('pending');
    // ยังไม่ถึงเวลา: ไม่ลองซ้ำ
    expect(await svc.sweepETax()).toMatchObject({ submitted: 0, errors: 0 });
    // ลูกค้าแก้ชื่อบริษัทหลังออกเอกสาร → เอกสารเดิมต้องใช้ชื่อเดิม
    expect((await put(`${ws}/billing/profile`, { ...profile, companyName: 'บริษัท ชื่อใหม่ภายหลัง จำกัด' })).status).toBe(200);
    await due();
    expect(await svc.sweepETax()).toMatchObject({ errors: 1 });
    await due();
    expect(await svc.sweepETax()).toMatchObject({ errors: 1 });
    j = await job(doc.id);
    expect(j).toMatchObject({ status: 'failed', attempts: 3, next_attempt_at: null });
    expect((await docRow(doc.id)).status).toBe('failed');
    expect((await audits('billing.etax_failed')).at(-1).summary).toContain('ลอง 3 ครั้งไม่สำเร็จ');
    await due();
    expect(await svc.sweepETax()).toMatchObject({ submitted: 0, errors: 0 });
    // การเงินกด "ส่งใหม่" (ops-api เริ่มนับใหม่)
    await t.owner.query(`UPDATE etax_jobs SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1`, [j.id]);
    await t.owner.query(`UPDATE tax_documents SET status = 'pending' WHERE id = $1`, [doc.id]);
    expect(await svc.sweepETax()).toMatchObject({ submitted: 1 });
    expect(etax.issued.at(-1)).toMatchObject({ documentId: doc.id, taxDocumentId: doc.id, kind: 'tax_invoice', number: doc.number, buyer: { companyName: profile.companyName, taxId: profile.taxId, email: 'etax@example.com' } });
    expect(await job(doc.id)).toMatchObject({ status: 'submitted', provider_ref: `etax_${doc.number}`, last_error: null });
    expect(await docRow(doc.id)).toEqual({ status: 'submitted', provider_ref: `etax_${doc.number}` });
    await put(`${ws}/billing/profile`, profile);
  });

  it('hooks/etax: ปฏิเสธพร้อมรหัสและสาเหตุ · ซ้ำไม่ทำซ้ำ · ตรวจสถานะเมื่อ webhook ไม่มา', async () => {
    const { doc } = await paid();
    expect(doc.status).toBe('submitted');
    const failed = await etaxHook({ providerRef: doc.provider_ref, status: 'failed', code: 'E-102', message: 'เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ครบ 13 หลัก' });
    expect(failed.body).toEqual({ received: true });
    expect(await job(doc.id)).toMatchObject({ status: 'failed', last_error: 'E-102 · เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ครบ 13 หลัก' });
    expect((await docRow(doc.id)).status).toBe('failed');
    expect((await etaxHook({ providerRef: doc.provider_ref, status: 'failed', code: 'E-102', message: 'เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ครบ 13 หลัก' })).body).toEqual({ received: true, duplicate: true });

    // ส่งแล้วไม่มี webhook: ทีมกด "ตรวจสถานะ" → งานกวาดถามผู้ให้บริการ
    const other = await paid();
    expect((await job(other.doc.id)).next_attempt_at).not.toBeNull(); // ครบ 1 ชม. ถามเอง
    etax.statuses.set(other.doc.provider_ref!, { status: 'issued' });
    await t.owner.query(`UPDATE etax_jobs SET next_attempt_at = now() - interval '1 second' WHERE doc_id = $1`, [other.doc.id]);
    expect(await svc.sweepETax()).toMatchObject({ checked: 1 });
    expect(await job(other.doc.id)).toMatchObject({ status: 'done', next_attempt_at: null });
    expect((await docRow(other.doc.id)).status).toBe('issued');
  });
});

describe('ออกฉบับใหม่แทน · แจ้งยกเลิก', () => {
  it('ยกเลิกฉบับเดิมแล้วแจ้งผู้ให้บริการอัตโนมัติ · ฉบับใหม่อ้างฉบับเดิม · ผลของฉบับเดิมที่มาช้าไม่เปลี่ยนสถานะกลับ', async () => {
    const { doc: old } = await paid();
    expect(old.status).toBe('submitted');
    const buyer = { companyName: 'บริษัท ชื่อที่ถูกต้อง จำกัด', taxId: '0105561234567', branchType: 'head', branchNo: null, address: '7 ถนนสมมติ กรุงเทพฯ 10110', email: 'etax@example.com' };
    const r = await sys.transaction((tx) => replaceTaxDocument(tx, old.id, 'ชื่อบริษัทผิด', { buyer }));
    const fresh = r!.replacement!;
    expect(await job(old.id, 'cancel')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await job(fresh.id)).toMatchObject({ status: 'pending' });
    const before = { issued: etax.issued.length, cancelled: etax.cancelled.length };
    expect(await svc.sweepETax()).toMatchObject({ submitted: 2 });
    expect(etax.cancelled.slice(before.cancelled)).toEqual([{ documentId: old.id, kind: 'tax_invoice', number: old.number, providerRef: old.provider_ref, reason: 'ชื่อบริษัทผิด' }]);
    expect(etax.issued.slice(before.issued)).toEqual([expect.objectContaining({ documentId: fresh.id, number: fresh.number, buyer: expect.objectContaining({ companyName: buyer.companyName }), replaces: { number: old.number, issuedOn: expect.any(String), providerRef: old.provider_ref }, reason: 'ชื่อบริษัทผิด' })]);
    const cancelRef = (await job(old.id, 'cancel')).provider_ref;
    expect(cancelRef).toBe(`etax_cancel_${old.number}`);

    // ผลของฉบับเดิมมาหลังยกเลิกในระบบ → เก็บในประวัติ ไม่เปลี่ยนเป็น "ออกแล้ว"
    expect((await etaxHook({ providerRef: old.provider_ref, status: 'issued' })).body).toEqual({ received: true, late: true });
    expect((await docRow(old.id)).status).toBe('cancelled');
    expect((await audits('billing.etax_late_result')).at(-1)).toMatchObject({ target_id: old.id, summary: expect.stringContaining('หลังยกเลิกในระบบแล้ว') });
    // ผู้ให้บริการยืนยันการยกเลิก
    expect((await etaxHook({ providerRef: cancelRef, status: 'cancelled' })).body).toEqual({ received: true });
    expect(await job(old.id, 'cancel')).toMatchObject({ status: 'done' });
    expect((await audits('billing.etax_cancelled')).at(-1).target_id).toBe(old.id);
    expect((await docRow(old.id)).status).toBe('cancelled');
  });

  it('ยกเลิกก่อนผู้ให้บริการออก: ไม่ต้องแจ้งยกเลิก และหยุดงานส่งฉบับเดิม', async () => {
    etax.failNext(1);
    const { doc } = await paid();
    expect((await docRow(doc.id)).status).toBe('pending');
    await sys.transaction((tx) => replaceTaxDocument(tx, doc.id, 'ข้อมูลสาขาผิด'));
    expect(await job(doc.id, 'cancel')).toBeUndefined();
    expect(await job(doc.id)).toMatchObject({ status: 'manual' });
  });
});

describe('ใบลดหนี้ / ใบเพิ่มหนี้', () => {
  it('ส่ง e-Tax พร้อมอ้างใบกำกับภาษีเดิม · ผู้ซื้อตามใบกำกับภาษี · ผลมาทาง webhook', async () => {
    await svc.sweepETax(); // ล้างคิวของ test ก่อนหน้า
    const { invoiceId, doc } = await paid();
    await etaxHook({ providerRef: doc.provider_ref, status: 'issued' });
    const cn = (await t.owner.query(`INSERT INTO credit_notes (workspace_id, invoice_id, number, kind, amount_satang, vat_satang, reason, status, issued_at) VALUES ($1,$2,$3,'refund',100000,7000,'คืนเงินบางส่วน','issued',now()) RETURNING id, number`, [wsId, invoiceId, `CN-Q${randomUUID().slice(0, 6)}`])).rows[0];
    const dn = (await t.owner.query(`INSERT INTO debit_notes (workspace_id, invoice_id, number, amount_satang, vat_satang, reason) VALUES ($1,$2,$3,50000,3500,'คิดขาด') RETURNING id, number`, [wsId, invoiceId, `DN-Q${randomUUID().slice(0, 6)}`])).rows[0];
    // ops-api เข้าคิวตอนออกเอกสาร (จำลองด้วย SQL)
    await t.owner.query(`INSERT INTO etax_jobs (workspace_id, doc_kind, doc_id, action) VALUES ($1,'credit_note',$2,'issue'), ($1,'debit_note',$3,'issue')`, [wsId, cn.id, dn.id]);
    const before = etax.issued.length;
    expect(await svc.sweepETax()).toMatchObject({ submitted: 2 });
    const sent = etax.issued.slice(before);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: cn.id, kind: 'credit_note', number: cn.number, amounts: { subtotal: 100000, vat: 7000, total: 107000 }, references: { number: doc.number, issuedOn: expect.any(String), providerRef: doc.provider_ref }, buyer: expect.objectContaining({ companyName: profile.companyName }), reason: 'คืนเงินบางส่วน' }),
        expect.objectContaining({ documentId: dn.id, kind: 'debit_note', number: dn.number, amounts: { subtotal: 50000, vat: 3500, total: 53500 } }),
      ]),
    );
    expect(sent.every((x) => x.taxDocumentId === undefined)).toBe(true);
    const ref = (await job(cn.id)).provider_ref;
    expect((await etaxHook({ providerRef: ref, status: 'issued' })).body).toEqual({ received: true });
    expect(await job(cn.id)).toMatchObject({ status: 'done' });
  });
});

describe('HttpETax', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('ออก POST {url} · ยกเลิก POST {url}/cancel · ถามผล GET {url}/{ref} · ข้อผิดพลาดมีรหัส', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const reply = (status: number, body: object) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body as string | undefined });
      if (url.endsWith('/cancel')) return reply(200, { id: 'CNL-1' });
      if (init.method === 'GET') return reply(200, { status: 'failed', error: { code: 'E-102', message: 'เลขผู้เสียภาษีไม่ครบ' } });
      if (JSON.parse(init.body as string).number === 'TX-BAD') return reply(422, { error: { code: 'E-201', message: 'ข้อมูลไม่ครบ' } });
      return reply(200, { id: 'ETX-1' });
    });
    const p = new HttpETax('https://etax.example.com/v1/', 'key');
    const input = { documentId: 'd1', kind: 'tax_invoice' as const, number: 'TX-1', issuedOn: '2026-11-03', invoiceNumber: 'FRI-1', amounts: { subtotal: 1, vat: 0, total: 1 }, buyer: { companyName: 'x', taxId: '0', branchType: 'head', branchNo: null, address: 'x', email: 'x@example.com' } };
    expect(await p.issue(input)).toEqual({ providerRef: 'ETX-1' });
    expect(await p.cancel({ documentId: 'd1', kind: 'tax_invoice', number: 'TX-1', providerRef: 'ETX-1', reason: 'ผิด' })).toEqual({ providerRef: 'CNL-1' });
    expect(await p.status('ETX-1')).toEqual({ status: 'failed', code: 'E-102', message: 'เลขผู้เสียภาษีไม่ครบ' });
    await expect(p.issue({ ...input, number: 'TX-BAD' })).rejects.toEqual(new ETaxError('E-201', 'ข้อมูลไม่ครบ'));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST https://etax.example.com/v1', 'POST https://etax.example.com/v1/cancel', 'GET https://etax.example.com/v1/ETX-1', 'POST https://etax.example.com/v1']);
  });
});
