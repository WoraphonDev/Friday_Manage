// แกนการชำระเงินที่ไม่ขึ้นกับผู้ให้บริการ (A35a): สถานะ VAT, กรณีผิดปกติ และการกระทบยอด
import { createHmac, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { slipAmountIssue } from '../src/payments/invoices.service.js';
import { FakeGateway, PAYMENT_GATEWAY } from '../src/payments/providers.js';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let gateway: FakeGateway;
const csrf = new Map<Client, string>();
const profile = { companyName: 'บริษัท ทดสอบชำระ จำกัด', taxId: '0105599999999', branchType: 'head', address: '9 ถนนสมมติ กรุงเทพฯ 10110', taxEmail: 'pay@example.com', whtEnabled: true };
const PNG = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, fill)]);

async function workspace(slug: string) {
  const team = await seedTeam(t, { slug });
  csrf.set(team.lead, ((await team.lead.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken);
  const wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [slug])).rows[0].id as string;
  await team.lead.get(`${team.ws}/billing`);
  expect((await put(team.lead, `${team.ws}/billing/profile`, profile)).status).toBe(200);
  return { lead: team.lead, ws: team.ws, wsId };
}
const put = (c: Client, url: string, body: object) => c.agent.put(`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!).send(body);
async function checkout(c: Client, ws: string, body: object) {
  const r = await c.agent.post(`/api/v1${ws}/billing/checkout`).set('x-csrf-token', csrf.get(c)!).set('Idempotency-Key', `idem-${randomUUID()}`).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const ref = (await t.owner.query('SELECT provider_ref FROM payments WHERE invoice_id = $1', [r.body.invoice.id])).rows[0].provider_ref as string | null;
  return { invoice: r.body.invoice as { id: string; number: string; subtotal: number; vat: number; amountDue: number }, ref };
}
const slip = (c: Client, ws: string, invoiceId: string, file: Buffer, amount?: number) => {
  const req = c.agent.post(`/api/v1${ws}/billing/invoices/${invoiceId}/slip`).set('x-csrf-token', csrf.get(c)!);
  if (amount !== undefined) req.field('amount', String(amount));
  return req.attach('file', file, 'slip.png');
};
function hook(type: string, providerRef: string, invoiceId: string) {
  const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type, data: { object: { id: providerRef, metadata: { invoice_id: invoiceId } } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', 'whsec_dev_fake').update(`${ts}.${raw}`).digest('hex')}`;
  return supertest(t.app.getHttpServer()).post('/api/v1/hooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(raw);
}
const payment = async (invoiceId: string) => (await t.owner.query('SELECT id, status, exception_reason, verified_by, provider_ref FROM payments WHERE invoice_id = $1 ORDER BY created_at', [invoiceId])).rows;
const invoiceStatus = async (id: string) => (await t.owner.query('SELECT status FROM invoices WHERE id = $1', [id])).rows[0].status as string;
const plan = async (wsId: string) => (await t.owner.query('SELECT p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.workspace_id = $1', [wsId])).rows[0].code as string;

beforeAll(async () => {
  t = await startApp();
  gateway = t.app.get(PAYMENT_GATEWAY) as FakeGateway;
});
afterAll(() => t.close());

describe('สถานะ VAT ของบริษัท', () => {
  it('จด VAT: คิด VAT 7% · ชำระแล้วออกใบกำกับภาษี (TX-) รอส่ง e-Tax', async () => {
    const w = await workspace('core-vat');
    const q = await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly`);
    expect(q.body).toMatchObject({ subtotal: 300_000, vat: 21_000, vatRegistered: true, documentType: 'tax_invoice_receipt' });
    const { invoice, ref } = await checkout(w.lead, w.ws, { plan: 'team_m', cycle: 'monthly', method: 'card' });
    expect(invoice).toMatchObject({ vat: 21_000, amountDue: 321_000 });
    expect((await hook('payment_intent.succeeded', ref!, invoice.id)).body).toEqual({ received: true });
    const [doc] = (await t.owner.query('SELECT doc_type, number, status FROM tax_documents WHERE invoice_id = $1', [invoice.id])).rows;
    expect(doc).toMatchObject({ doc_type: 'tax_invoice_receipt', number: `TX-${invoice.number.slice(4)}` });
    expect((await payment(invoice.id))[0]).toMatchObject({ status: 'confirmed', verified_by: 'webhook' });
  });

  it('ยังไม่จด VAT: ไม่คิด VAT · ชำระแล้วออกใบเสร็จ (RC-) ทันที ไม่ส่ง e-Tax', async () => {
    config.vatRegistered = false;
    try {
      const w = await workspace('core-novat');
      const q = await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly&wht=true`);
      expect(q.body).toMatchObject({ subtotal: 300_000, vat: 0, total: 300_000, whtAmount: 9_000, amountDue: 291_000, vatRegistered: false, documentType: 'receipt' });
      const { invoice, ref } = await checkout(w.lead, w.ws, { plan: 'team_m', cycle: 'monthly', method: 'card' });
      expect(invoice).toMatchObject({ vat: 0, amountDue: 300_000 });
      await hook('payment_intent.succeeded', ref!, invoice.id);
      const [doc] = (await t.owner.query('SELECT doc_type, number, status, sent_at FROM tax_documents WHERE invoice_id = $1', [invoice.id])).rows;
      expect(doc).toMatchObject({ doc_type: 'receipt', number: `RC-${invoice.number.slice(4)}`, status: 'issued' });
      expect(doc.sent_at).not.toBeNull();
      // งานกวาดส่ง e-Tax ไม่หยิบใบเสร็จ
      await t.owner.query(`UPDATE tax_documents SET status = 'pending', created_at = now() - interval '1 hour' WHERE invoice_id = $1`, [invoice.id]);
      await t.app.get(PaymentsService).sweepETax();
      expect((await t.owner.query('SELECT status FROM tax_documents WHERE invoice_id = $1', [invoice.id])).rows[0].status).toBe('pending');
    } finally {
      config.vatRegistered = true;
    }
  });
});

describe('สลิปโอนเงิน: ทีมตรวจเอง + กรณีผิดปกติ', () => {
  let w: Awaited<ReturnType<typeof workspace>>;
  let first: Awaited<ReturnType<typeof checkout>>['invoice'];

  beforeAll(async () => {
    w = await workspace('core-slip');
    first = (await checkout(w.lead, w.ws, { plan: 'team_m', cycle: 'monthly', method: 'transfer' })).invoice;
  });

  it('เทียบยอดที่แจ้ง: ตรง (คลาดได้ 1 บาท) / หัก ณ ที่จ่ายแต่ไม่ได้แจ้ง / ไม่ตรง', () => {
    const inv = { amountDue: 321_000, subtotal: 300_000, whtAmount: 0 };
    expect(slipAmountIssue(321_000, inv)).toBeNull();
    expect(slipAmountIssue(320_950, inv)).toBeNull();
    expect(slipAmountIssue(312_000, inv)).toBe('wht_not_declared');
    expect(slipAmountIssue(300_000, inv)).toBe('amount_mismatch');
    expect(slipAmountIssue(312_000, { amountDue: 312_000, subtotal: 300_000, whtAmount: 9_000 })).toBeNull();
  });

  it('แจ้งยอดหัก 3% ทั้งที่ใบไม่มีหัก ณ ที่จ่าย → wht_not_declared · แนบใหม่ยอดตรง → ล้างเหตุผิดปกติ · ยอดไม่ตรง → amount_mismatch', async () => {
    const r = await slip(w.lead, w.ws, first.id, PNG(1), 312_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await payment(first.id))[0]).toMatchObject({ status: 'pending_review', exception_reason: 'wht_not_declared' });
    expect(await plan(w.wsId)).toBe('team_m'); // ยังเปิดสิทธิ์ระหว่างรอตรวจ

    await slip(w.lead, w.ws, first.id, PNG(1), 321_000);
    expect((await payment(first.id))[0].exception_reason).toBeNull();
    await slip(w.lead, w.ws, first.id, PNG(1), 150_000);
    expect((await payment(first.id))[0].exception_reason).toBe('amount_mismatch');
    expect((await slip(w.lead, w.ws, first.id, PNG(1), -5)).status).toBe(400);
    await slip(w.lead, w.ws, first.id, PNG(1));
    expect((await payment(first.id))[0]).toMatchObject({ exception_reason: null, provider_ref: expect.stringMatching(/^slip:[0-9a-f]{64}$/) });
  });

  it('สลิปเดียวกันแนบกับใบแจ้งหนี้อื่น → duplicate_slip และไม่เปิดแพ็กเกจ', async () => {
    const { invoice } = await checkout(w.lead, w.ws, { plan: 'team_l', cycle: 'monthly', method: 'transfer' });
    const r = await slip(w.lead, w.ws, invoice.id, PNG(1));
    expect(r.status).toBe(201);
    const [p] = await payment(invoice.id);
    expect(p).toMatchObject({ status: 'pending_review', exception_reason: 'duplicate_slip', provider_ref: null });
    expect(await plan(w.wsId)).toBe('team_m');
    const log = (await t.owner.query(`SELECT summary FROM audit_logs WHERE target_id = $1 AND action = 'billing.slip_uploaded' ORDER BY created_at DESC LIMIT 1`, [invoice.id])).rows[0].summary;
    expect(log).toContain('สลิปซ้ำ');

    // แนบสลิปใหม่ที่ไม่ซ้ำ → ผ่านเข้าคิวตรวจตามปกติและเปิดแพ็กเกจ
    await slip(w.lead, w.ws, invoice.id, PNG(2));
    expect((await payment(invoice.id))[0].exception_reason).toBeNull();
    expect(await plan(w.wsId)).toBe('team_l');
  });
});

describe('จ่ายซ้ำและกระทบยอด', () => {
  let w: Awaited<ReturnType<typeof workspace>>;

  beforeAll(async () => {
    w = await workspace('core-recon');
  });

  it('ใบแจ้งหนี้ชำระแล้ว แต่มีเงินเข้าอีกรายการ → double_payment ไม่ยืนยันซ้ำ', async () => {
    const { invoice, ref } = await checkout(w.lead, w.ws, { plan: 'team_m', cycle: 'monthly', method: 'card' });
    await hook('payment_intent.succeeded', ref!, invoice.id);
    expect(await invoiceStatus(invoice.id)).toBe('paid');
    // จำลองลูกค้าจ่ายอีกครั้งผ่าน PromptPay ของใบเดียวกัน
    await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, provider_ref) VALUES ($1, $2, 'promptpay', 321000, 'pp_fake_double')`, [w.wsId, invoice.id]);
    const r = await hook('payment_intent.succeeded', 'pp_fake_double', invoice.id);
    expect(r.body).toEqual({ received: true, exception: 'double_payment' });
    const second = (await payment(invoice.id)).find((p) => p.provider_ref === 'pp_fake_double');
    expect(second).toMatchObject({ status: 'pending_review', exception_reason: 'double_payment', verified_by: null });
    expect((await hook('payment_intent.succeeded', 'pp_fake_double', invoice.id)).body).toEqual({ received: true, exception: 'double_payment' });
    expect((await t.owner.query('SELECT count(*)::int AS n FROM tax_documents WHERE invoice_id = $1', [invoice.id])).rows[0].n).toBe(1);
  });

  it('กระทบยอด: Webhook หลุด → ยืนยันให้ · ยอดไม่ตรง → amount_mismatch · ไม่รู้จัก → รายงาน · รันซ้ำไม่ทำซ้ำ', async () => {
    const missed = await checkout(w.lead, w.ws, { plan: 'team_l', cycle: 'monthly', method: 'card' });
    const wrong = await checkout(w.lead, w.ws, { plan: 'team_l', cycle: 'yearly', method: 'card' });
    const now = new Date();
    gateway.settled.push(
      { providerRef: missed.ref!, invoiceId: missed.invoice.id, amount: missed.invoice.amountDue, at: now },
      { providerRef: wrong.ref!, invoiceId: wrong.invoice.id, amount: wrong.invoice.amountDue - 50_000, at: now },
      { providerRef: 'pi_fake_stranger', invoiceId: null, amount: 10_000, at: now },
      { providerRef: 'pi_fake_old', invoiceId: null, amount: 10_000, at: new Date(now.getTime() - 10 * 86_400_000) },
    );
    const svc = t.app.get(PaymentsService);
    const since = new Date(now.getTime() - 86_400_000);
    const r = await svc.reconcile(since);
    expect(r).toMatchObject({ checked: 3, settled: 1, exceptions: 1, unmatched: [{ providerRef: 'pi_fake_stranger', invoiceId: null, amount: 10_000 }] });
    expect(await invoiceStatus(missed.invoice.id)).toBe('paid');
    expect((await payment(missed.invoice.id))[0]).toMatchObject({ status: 'confirmed', verified_by: 'webhook' });
    expect(await invoiceStatus(wrong.invoice.id)).toBe('open');
    expect((await payment(wrong.invoice.id))[0]).toMatchObject({ status: 'pending_review', exception_reason: 'amount_mismatch' });
    const log = (await t.owner.query(`SELECT summary FROM audit_logs WHERE target_id = $1 AND action = 'billing.payment_exception'`, [wrong.invoice.id])).rows[0].summary;
    expect(log).toContain('amount_mismatch');

    expect(await svc.reconcile(since)).toMatchObject({ checked: 3, settled: 0, exceptions: 0 });
    // Webhook ที่มาช้าหลังติดเหตุผิดปกติ ไม่ยืนยันทับ
    expect((await hook('payment_intent.succeeded', wrong.ref!, wrong.invoice.id)).body).toEqual({ received: true, exception: 'amount_mismatch' });
    expect(await invoiceStatus(wrong.invoice.id)).toBe('open');
  });
});
