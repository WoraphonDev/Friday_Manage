// A33 · ชำระเงิน: บัตร, PromptPay, โอน, ใบกำกับภาษี, 50 ทวิ · Stripe / e-Tax เป็นตัวปลอม · ข้อมูลสมมติเท่านั้น
import { createHmac, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { ETAX_PROVIDER, FakeETax, FakeGateway, gatewayFromEnv, PAYMENT_GATEWAY, StripeGateway, verifyStripeSignature } from '../src/payments/providers.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let ws: string;
let wsId: string;
let gateway: FakeGateway;
let etax: FakeETax;

const profile = { companyName: 'บริษัท ตัวอย่าง จำกัด', taxId: '0105512345678', branchType: 'head', address: '1 ถนนสมมติ กรุงเทพฯ 10110', taxEmail: 'billing@example.com', whtEnabled: true };
const key = () => `idem-${randomUUID()}`;
const post = (c: Client, url: string, body: object, idem?: string) => c.agent.post(`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!).set(idem ? { 'Idempotency-Key': idem } : {}).send(body);
const csrf = new Map<Client, string>();
const put = (c: Client, url: string, body: object) => c.agent.put(`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!).send(body);
const upload = (c: Client, url: string, file: Buffer, name: string) => c.agent.post(`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!).attach('file', file, name);

function stripeEvent(type: string, providerRef: string, invoiceId?: string) {
  return JSON.stringify({ id: `evt_${randomUUID()}`, type, data: { object: { id: providerRef, metadata: invoiceId ? { invoice_id: invoiceId } : {} } } });
}
function sign(raw: string, secret = 'whsec_dev_fake', ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
}
const hook = (raw: string, signature = sign(raw)) => t.app.getHttpServer && (async () => (await import('supertest')).default(t.app.getHttpServer()).post('/api/v1/hooks/stripe').set('content-type', 'application/json').set('stripe-signature', signature).send(raw))();
const etaxHook = async (body: object, secret = 'etax_dev_fake') => {
  const raw = JSON.stringify(body);
  return (await import('supertest')).default(t.app.getHttpServer()).post('/api/v1/hooks/etax').set('content-type', 'application/json').set('x-etax-signature', `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`).send(raw);
};
const sub = async () => (await t.owner.query(`SELECT s.status, s.cycle, s.payment_method, p.code, s.current_period_end FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.workspace_id = $1`, [wsId])).rows[0];
const pdfBuffer = async (c: Client, url: string) => {
  const res = await c.get(url).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (x: Buffer) => chunks.push(x));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return res as typeof res & { body: Buffer };
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from('%PDF-1.4\n% fake withholding certificate\n');

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  ws = team.ws;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  gateway = t.app.get(PAYMENT_GATEWAY) as FakeGateway;
  etax = t.app.get(ETAX_PROVIDER) as FakeETax;
  for (const c of [team.lead, team.dev]) csrf.set(c, ((await c.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken);
  await team.lead.get(`${ws}/billing`); // สร้าง subscription ทดลอง
});
afterAll(() => t.close());

describe('เงื่อนไขก่อนชำระ', () => {
  it('ต้องมี Idempotency-Key · Admin เท่านั้น · ข้อมูลภาษี · หัก ณ ที่จ่ายใช้กับบัตรไม่ได้', async () => {
    const body = { plan: 'team_m', method: 'card' };
    const none = await post(team.lead, `${ws}/billing/checkout`, body);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('idempotency_key_required');
    expect((await post(team.lead, `${ws}/billing/checkout`, body, 'short')).status).toBe(400);
    expect((await post(team.dev, `${ws}/billing/checkout`, body, key())).status).toBe(403);
    const noProfile = await post(team.lead, `${ws}/billing/checkout`, body, key());
    expect(noProfile.status).toBe(422);
    expect(noProfile.body.error.code).toBe('billing_profile_required');
    const wht = await post(team.lead, `${ws}/billing/checkout`, { ...body, wht: true }, key());
    expect(wht.status).toBe(422);
    expect(wht.body.error.code).toBe('wht_not_allowed_for_card');
    expect((await post(team.lead, `${ws}/billing/checkout`, { ...body, plan: 'enterprise' }, key())).status).toBe(400);
    expect((await post(team.lead, `${ws}/billing/checkout`, { ...body, method: 'cash' }, key())).status).toBe(400);
    const pr = await put(team.lead, `${ws}/billing/profile`, profile);
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
  });
});

describe('บัตร (Stripe)', () => {
  const idem = key();
  let invoiceId = '';
  let providerRef = '';
  let taxDocId = '';

  it('checkout → ใบแจ้งหนี้ + client secret · ส่งซ้ำด้วย key เดิมได้ผลเดิม · key เดิมแต่ข้อมูลต่าง → 422', async () => {
    const r = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_m', cycle: 'monthly', method: 'card' }, idem);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.invoice).toMatchObject({ status: 'open', subtotal: 300_000, vat: 21_000, total: 321_000, whtAmount: 0, amountDue: 321_000 });
    expect(r.body.invoice.number).toMatch(/^FRI-\d{4}-0001$/);
    expect(r.body.card.clientSecret).toMatch(/_secret_/);
    expect(r.body.payment).toMatchObject({ method: 'card', status: 'pending_review', amount: 321_000 });
    expect(r.body.replayed).toBe(false);
    invoiceId = r.body.invoice.id;
    providerRef = (await t.owner.query(`SELECT provider_ref FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].provider_ref;
    expect(providerRef).toMatch(/^pi_fake_/);
    expect(gateway.calls[0]).toMatchObject({ kind: 'card', request: { amount: 321_000, email: 'billing@example.com', invoiceNumber: r.body.invoice.number } });

    const again = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_m', cycle: 'monthly', method: 'card' }, idem);
    expect(again.body).toMatchObject({ replayed: true, invoice: { id: invoiceId }, card: { clientSecret: r.body.card.clientSecret } });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM invoices WHERE workspace_id = $1`, [wsId])).rows[0].n).toBe(1);
    const reuse = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_l', cycle: 'monthly', method: 'card' }, idem);
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('idempotency_key_reuse');
    expect((await sub()).code).toBe('team_s'); // ยังเป็นแพ็กเกจทดลอง จนกว่าจะชำระ
  });

  it('Webhook: ลายเซ็นผิด / เก่าเกิน → 400 · ไม่รู้จัก / ชนิดอื่น → 200 ไม่ทำอะไร', async () => {
    const raw = stripeEvent('payment_intent.succeeded', providerRef, invoiceId);
    expect((await hook(raw, 'garbage'))!.status).toBe(400);
    expect((await hook(raw, sign(raw, 'whsec_wrong')))!.status).toBe(400);
    expect((await hook(raw, sign(raw, 'whsec_dev_fake', Math.floor(Date.now() / 1000) - 3600)))!.status).toBe(400);
    expect((await hook(raw, ''))!.status).toBe(400);
    expect((await hook(stripeEvent('payment_intent.succeeded', 'pi_unknown')))!.body).toEqual({ received: true, unknown: true });
    expect((await hook(stripeEvent('customer.created', 'cus_1')))!.body).toEqual({ received: true, ignored: true });
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [invoiceId])).rows[0].status).toBe('open');
  });

  it('ชำระสำเร็จ → ใบแจ้งหนี้ paid, เปิดแพ็กเกจ Team M, ออกใบกำกับภาษี (e-Tax) · ส่งซ้ำไม่ทำซ้ำ', async () => {
    const raw = stripeEvent('payment_intent.succeeded', providerRef, invoiceId);
    const r = await hook(raw);
    expect(r!.status, JSON.stringify(r!.body)).toBe(200);
    expect(r!.body).toEqual({ received: true });
    const inv = (await t.owner.query(`SELECT status, paid_at FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
    expect(inv.status).toBe('paid');
    expect(inv.paid_at).not.toBeNull();
    expect((await t.owner.query(`SELECT status FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].status).toBe('confirmed');
    expect(await sub()).toMatchObject({ status: 'active', code: 'team_m', cycle: 'monthly', payment_method: 'card' });
    const doc = (await t.owner.query(`SELECT id, number, status, provider_ref FROM tax_documents WHERE invoice_id = $1`, [invoiceId])).rows;
    expect(doc).toHaveLength(1);
    expect(doc[0]).toMatchObject({ status: 'submitted', provider_ref: expect.stringMatching(/^etax_TX-/) });
    taxDocId = doc[0].id;
    expect(etax.issued).toHaveLength(1);
    expect(etax.issued[0]).toMatchObject({ amounts: { subtotal: 300_000, vat: 21_000, total: 321_000 }, buyer: { companyName: profile.companyName, taxId: profile.taxId, email: 'billing@example.com' } });
    const planNow = await team.lead.get(`${ws}/billing`);
    expect(planNow.body.subscription ?? planNow.body).toBeTruthy();

    expect((await hook(raw))!.body).toEqual({ received: true, duplicate: true });
    expect(etax.issued).toHaveLength(1);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM tax_documents WHERE invoice_id = $1`, [invoiceId])).rows[0].n).toBe(1);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'billing.payment_confirmed' AND workspace_id = $1`, [wsId])).rows[0].n).toBe(1);
  });

  it('hooks/etax: ลายเซ็นผิด 400 · ออกเอกสารสำเร็จ → issued + sentAt · ซ้ำ / ไม่รู้จัก ตอบ 200', async () => {
    const providerRefDoc = (await t.owner.query(`SELECT provider_ref FROM tax_documents WHERE id = $1`, [taxDocId])).rows[0].provider_ref;
    expect((await etaxHook({ providerRef: providerRefDoc, status: 'issued' }, 'wrong-secret')).status).toBe(400);
    expect((await etaxHook({ providerRef: '', status: 'issued' })).status).toBe(400);
    expect((await etaxHook({ providerRef: 'etax_nope', status: 'issued' })).body).toEqual({ received: true, unknown: true });
    const ok = await etaxHook({ providerRef: providerRefDoc, status: 'issued' });
    expect(ok.body).toEqual({ received: true });
    const doc = (await t.owner.query(`SELECT status, sent_at FROM tax_documents WHERE id = $1`, [taxDocId])).rows[0];
    expect(doc.status).toBe('issued');
    expect(doc.sent_at).not.toBeNull();
    expect((await etaxHook({ providerRef: providerRefDoc, status: 'issued' })).body).toEqual({ received: true, duplicate: true });
  });

  it('รายการใบแจ้งหนี้ + PDF ใบแจ้งหนี้ / ใบกำกับภาษี · Member ดูไม่ได้', async () => {
    const list = await team.lead.get(`${ws}/billing/invoices`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: invoiceId, status: 'paid', method: 'card', paymentStatus: 'confirmed', taxDocument: { id: taxDocId, status: 'issued' }, pdfUrl: `/api/v1/w/${team.slug}/billing/invoices/${invoiceId}.pdf` });
    expect((await team.lead.get(`${ws}/billing/invoices/${invoiceId}`)).body.number).toMatch(/^FRI-/);

    const inv = await pdfBuffer(team.lead, `${ws}/billing/invoices/${invoiceId}.pdf`);
    expect(inv.status).toBe(200);
    expect(inv.headers['content-type']).toContain('application/pdf');
    expect(inv.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(inv.body.length).toBeGreaterThan(2000);
    const tax = await pdfBuffer(team.lead, `${ws}/billing/tax-documents/${taxDocId}.pdf`);
    expect(tax.status).toBe(200);
    expect(tax.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await team.lead.get(`${ws}/billing/invoices/${randomUUID()}.pdf`)).status).toBe(404);
    expect((await team.lead.get(`${ws}/billing/tax-documents/${taxDocId}`)).status).toBe(404);
    for (const u of ['invoices', `invoices/${invoiceId}.pdf`, `tax-documents/${taxDocId}.pdf`]) expect((await team.dev.get(`${ws}/billing/${u}`)).status, u).toBe(403);
  });
});

describe('PromptPay', () => {
  it('QR หมดอายุ 15 นาที · หัก ณ ที่จ่าย 3% ลดยอดชำระ · ล้มเหลว = รอบใหม่ได้ · ยกเลิก = void', async () => {
    const r = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_s', cycle: 'yearly', method: 'promptpay', wht: true, poNumber: 'PO-2026-001' }, key());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // รายปี = 10 เดือน: 1,500 × 10 = 15,000 บาท · VAT 7% = 1,050 · หัก 3% ของยอดก่อน VAT = 450
    expect(r.body.invoice).toMatchObject({ subtotal: 1_500_000, vat: 105_000, total: 1_605_000, whtAmount: 45_000, amountDue: 1_560_000, poNumber: 'PO-2026-001' });
    expect(r.body.promptpay.qrPayload).toContain('FAKE');
    const mins = (new Date(r.body.promptpay.expiresAt).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(13);
    expect(mins).toBeLessThanOrEqual(15);
    expect(r.body.invoice.number).toMatch(/0002$/);
    const ref = (await t.owner.query(`SELECT provider_ref FROM payments WHERE invoice_id = $1`, [r.body.invoice.id])).rows[0].provider_ref;

    await hook(stripeEvent('payment_intent.payment_failed', ref));
    expect((await t.owner.query(`SELECT i.status AS inv, p.status AS pay FROM invoices i JOIN payments p ON p.invoice_id = i.id WHERE i.id = $1`, [r.body.invoice.id])).rows[0]).toEqual({ inv: 'open', pay: 'rejected' });
    await hook(stripeEvent('payment_intent.canceled', ref));
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [r.body.invoice.id])).rows[0].status).toBe('void');
    expect((await sub()).code).toBe('team_m'); // ไม่กระทบแพ็กเกจเดิม
    // ชำระสำเร็จแล้วไม่ถูกย้อนด้วยเหตุการณ์ล้มเหลวที่มาทีหลัง
    const ok = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_s', cycle: 'monthly', method: 'promptpay' }, key());
    const okRef = (await t.owner.query(`SELECT provider_ref FROM payments WHERE invoice_id = $1`, [ok.body.invoice.id])).rows[0].provider_ref;
    await hook(stripeEvent('payment_intent.succeeded', okRef));
    await hook(stripeEvent('payment_intent.payment_failed', okRef));
    expect((await t.owner.query(`SELECT status FROM payments WHERE invoice_id = $1`, [ok.body.invoice.id])).rows[0].status).toBe('confirmed');
    expect(await sub()).toMatchObject({ code: 'team_s', status: 'active', payment_method: 'promptpay' });
  });
});

describe('โอนเงิน + สลิป + 50 ทวิ', () => {
  let invoiceId = '';
  const idem = key();

  it('checkout → ใบแจ้งหนี้พร้อมบัญชีรับโอน (ครบกำหนด 7 วัน) · ยังไม่เปลี่ยนแพ็กเกจจนกว่าจะแนบสลิป', async () => {
    const r = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_l', cycle: 'monthly', method: 'transfer', wht: true }, idem);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    invoiceId = r.body.invoice.id;
    expect(r.body.invoice).toMatchObject({ subtotal: 550_000, vat: 38_500, total: 588_500, whtAmount: 16_500, amountDue: 572_000 });
    expect(r.body.transfer).toMatchObject({ reference: r.body.invoice.number, amount: 572_000, bank: expect.any(String), accountNo: expect.any(String) });
    const days = (Date.parse(r.body.transfer.dueDate) - Date.parse(r.body.invoice.periodStart)) / 86_400_000;
    expect(days).toBe(7);
    expect((await sub()).code).toBe('team_s');
    expect(r.body.invoice.status).toBe('open');
  });

  it('แนบสลิป → pending_review แต่ใช้แพ็กเกจใหม่ได้ทันที · ตรวจชนิด / ขนาดไฟล์ · แนบใหม่ได้', async () => {
    const url = `${ws}/billing/invoices/${invoiceId}/slip`;
    const none = await team.lead.agent.post(`/api/v1${url}`).set('x-csrf-token', csrf.get(team.lead)!);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('file_required');
    const txt = await upload(team.lead, url, Buffer.from('not an image at all, just text'), 'slip.png');
    expect(txt.status).toBe(400);
    expect(txt.body.error.code).toBe('invalid_file');
    const big = await upload(team.lead, url, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), 'slip.png');
    expect(big.status).toBe(413);
    expect((await upload(team.dev, url, PNG, 'slip.png')).status).toBe(403);

    const ok = await upload(team.lead, url, PNG, 'slip.png');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ id: invoiceId, status: 'pending_review', paymentStatus: 'pending_review', hasSlip: true, method: 'transfer' });
    expect(await sub()).toMatchObject({ status: 'active', code: 'team_l', payment_method: 'transfer' });
    const key1 = (await t.owner.query(`SELECT slip_file_key FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].slip_file_key;
    await expect(access(join(config.uploadDir, key1))).resolves.toBeUndefined();
    expect((await upload(team.lead, url, PDF, 'slip.pdf')).status).toBe(201); // แนบใหม่ (แก้สลิป) ได้ระหว่างรอตรวจ
    expect((await t.owner.query(`SELECT slip_file_key FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].slip_file_key).toMatch(/\.pdf$/);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM tax_documents WHERE invoice_id = $1`, [invoiceId])).rows[0].n).toBe(0); // ใบกำกับภาษีออกหลังเจ้าหน้าที่ยืนยัน
  });

  it('50 ทวิ: ใบแจ้งหนี้ที่หักภาษีเท่านั้น · ภายใน 30 วัน · เป็นไฟล์ที่ถูกต้อง', async () => {
    const url = `${ws}/billing/invoices/${invoiceId}/wht-certificate`;
    expect((await upload(team.lead, url, Buffer.from('plain text'), 'wht.pdf')).body.error.code).toBe('invalid_file');
    const ok = await upload(team.lead, url, PDF, 'wht.pdf');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.whtCertificate).toMatchObject({ status: 'pending_review' });
    expect(ok.body.whtDueBy).toBeTruthy();
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM wht_certificates WHERE invoice_id = $1`, [invoiceId])).rows[0].n).toBe(1);

    const noWht = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_s', method: 'transfer' }, key());
    expect((await upload(team.lead, `${ws}/billing/invoices/${noWht.body.invoice.id}/wht-certificate`, PDF, 'wht.pdf')).body.error.code).toBe('wht_not_applicable');
    await t.owner.query(`UPDATE invoices SET created_at = now() - interval '31 days' WHERE id = $1`, [invoiceId]);
    const late = await upload(team.lead, url, PDF, 'wht.pdf');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('wht_deadline_passed');
  });

  it('สลิปใช้ได้เฉพาะใบแจ้งหนี้ที่โอน และยังไม่ปิด', async () => {
    const card = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_m', method: 'card' }, key());
    expect((await upload(team.lead, `${ws}/billing/invoices/${card.body.invoice.id}/slip`, PNG, 's.png')).body.error.code).toBe('slip_not_applicable');
    await t.owner.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [invoiceId]);
    expect((await upload(team.lead, `${ws}/billing/invoices/${invoiceId}/slip`, PNG, 's.png')).body.error.code).toBe('invoice_closed');
    expect((await upload(team.lead, `${ws}/billing/invoices/${randomUUID()}/slip`, PNG, 's.png')).status).toBe(404);
  });
});

describe('ยกเลิกแพ็กเกจ', () => {
  it('Owner เท่านั้น · ใช้ต่อได้ถึงสิ้นรอบ · ยกเลิกซ้ำไม่ได้', async () => {
    expect((await post(team.dev, `${ws}/billing/subscription:cancel`, {})).status).toBe(403);
    const before = await sub();
    const r = await post(team.lead, `${ws}/billing/subscription:cancel`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('canceled');
    expect(new Date(r.body.endsAt).getTime()).toBe(new Date(before.current_period_end).getTime());
    expect(await sub()).toMatchObject({ status: 'canceled', code: 'team_l' });
    // ยังใช้สิทธิ์ของแพ็กเกจเดิมถึงวันสิ้นรอบ
    const usage = await team.lead.get(`${ws}/billing`);
    expect(JSON.stringify(usage.body)).toContain('Team L');
    const again = await post(team.lead, `${ws}/billing/subscription/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_canceled');
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'billing.subscription_canceled' AND workspace_id = $1`, [wsId])).rows[0].n).toBe(1);
  });
});

describe('กวาดส่งใบกำกับภาษีที่ค้าง', () => {
  it('เอกสาร pending ที่หลังบ้านสร้างตอนยืนยันสลิป ถูกส่งไปผู้ให้บริการ e-Tax', async () => {
    const inv = (await t.owner.query(`SELECT id FROM invoices WHERE workspace_id = $1 ORDER BY created_at LIMIT 1`, [wsId])).rows[0].id;
    const doc = (await t.owner.query(`INSERT INTO tax_documents (workspace_id, invoice_id, doc_type, number, created_at) VALUES ($1, $2, 'tax_invoice_receipt', 'TX-SWEEP-1', now() - interval '5 minutes') RETURNING id`, [wsId, inv])).rows[0].id;
    const fresh = (await t.owner.query(`INSERT INTO tax_documents (workspace_id, invoice_id, doc_type, number) VALUES ($1, $2, 'tax_invoice_receipt', 'TX-SWEEP-2') RETURNING id`, [wsId, inv])).rows[0].id;
    const before = etax.issued.length;
    const r = await t.app.get(PaymentsService).sweepETax();
    expect(r.submitted).toBe(1);
    expect(etax.issued.slice(before).map((x) => x.number)).toEqual(['TX-SWEEP-1']);
    expect((await t.owner.query(`SELECT status, provider_ref FROM tax_documents WHERE id = $1`, [doc])).rows[0]).toEqual({ status: 'submitted', provider_ref: 'etax_TX-SWEEP-1' });
    expect((await t.owner.query(`SELECT status FROM tax_documents WHERE id = $1`, [fresh])).rows[0].status).toBe('pending'); // ยังใหม่เกินไป รอผู้สร้างส่งเอง
  });
});

describe('ใบเก่าไม่ทับสิทธิ์ของใบใหม่ (N02 · full-system-audit)', () => {
  async function checkout(plan: string, method: 'transfer' | 'card') {
    const r = await post(team.lead, `${ws}/billing/checkout`, { plan, cycle: 'monthly', method }, key());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.invoice as { id: string };
  }
  async function payCard(invoiceId: string) {
    const ref = (await t.owner.query(`SELECT provider_ref FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].provider_ref;
    expect((await hook(stripeEvent('payment_intent.succeeded', ref, invoiceId)))!.status).toBe(200);
  }
  const slip = (id: string) => upload(team.lead, `${ws}/billing/invoices/${id}/slip`, PNG, 'slip.png');

  it('แนบสลิปใบเก่าซ้ำหลังใบใหม่ชำระด้วยบัตร → เก็บสลิปได้ แต่ Team L ไม่ถูกลดเป็น Team M', async () => {
    const a = await checkout('team_m', 'transfer');
    expect((await slip(a.id)).status).toBe(201);
    expect(await sub()).toMatchObject({ status: 'active', code: 'team_m' });
    const b = await checkout('team_l', 'card');
    await payCard(b.id);
    expect(await sub()).toMatchObject({ status: 'active', code: 'team_l' });
    const again = await slip(a.id);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ status: 'pending_review', hasSlip: true });
    expect(await sub()).toMatchObject({ status: 'active', code: 'team_l' });
    expect((await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'billing.slip_uploaded' AND target_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.id])).rows[0].summary).toContain('ไม่เปลี่ยนแพ็กเกจ');
  });

  it('Webhook มาสลับลำดับ: ใบใหม่ชำระก่อน ใบเก่าชำระทีหลัง → ใบเก่า paid แต่สิทธิ์เป็นของใบใหม่', async () => {
    const older = await checkout('team_m', 'card');
    const newer = await checkout('team_l', 'card');
    await payCard(newer.id);
    await payCard(older.id);
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [older.id])).rows[0].status).toBe('paid');
    expect(await sub()).toMatchObject({ status: 'active', code: 'team_l' });
    expect((await t.owner.query(`SELECT source_invoice_id FROM subscriptions WHERE workspace_id = $1`, [wsId])).rows[0].source_invoice_id).toBe(newer.id);
  });
});

describe('ผู้ให้บริการ', () => {
  it('เลือก provider จาก env · production ต้องตั้ง Stripe · ตรวจลายเซ็น Stripe', () => {
    expect(gatewayFromEnv({})).toBeInstanceOf(FakeGateway);
    expect(gatewayFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toBeInstanceOf(StripeGateway);
    expect(() => gatewayFromEnv({ NODE_ENV: 'production' })).toThrow(/STRIPE_SECRET_KEY/);
    const raw = Buffer.from('{"a":1}');
    const header = (ts: number, secret = 's3cret') => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex')}`;
    const now = 1_800_000_000_000;
    expect(() => verifyStripeSignature(raw, header(now / 1000), 's3cret', now)).not.toThrow();
    expect(() => verifyStripeSignature(raw, header(now / 1000, 'other'), 's3cret', now)).toThrow('bad_signature');
    expect(() => verifyStripeSignature(Buffer.from('{"a":2}'), header(now / 1000), 's3cret', now)).toThrow('bad_signature');
    expect(() => verifyStripeSignature(raw, header(now / 1000 - 301), 's3cret', now)).toThrow('signature_expired');
    expect(() => verifyStripeSignature(raw, undefined, 's3cret', now)).toThrow('missing_signature');
  });
});
