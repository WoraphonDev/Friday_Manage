// หน้าชำระใบแจ้งหนี้ (W22b) และเอกสารการเงินชุดใหม่ · ข้อมูลสมมติทั้งหมด
import { createHmac, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
const csrf = new Map<Client, string>();
const profile = { companyName: 'บริษัท ทดสอบเอกสาร จำกัด', taxId: '0105599999998', branchType: 'branch', branchNo: '00002', address: '9 ถนนสมมติ กรุงเทพฯ 10110', taxEmail: 'docs@example.com', whtEnabled: false };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

async function workspace(slug: string) {
  const team = await seedTeam(t, { slug });
  csrf.set(team.lead, ((await team.lead.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken);
  const wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [slug])).rows[0].id as string;
  await team.lead.get(`${team.ws}/billing`);
  expect((await post(team.lead, `${team.ws}/billing/profile`, profile, 'put')).status).toBe(200);
  return { lead: team.lead, ws: team.ws, wsId };
}
function post(c: Client, url: string, body: object, method: 'post' | 'put' = 'post') {
  return c.agent[method](`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!).set('Idempotency-Key', `idem-${randomUUID()}`).send(body);
}
async function checkout(c: Client, ws: string, body: object) {
  const r = await post(c, `${ws}/billing/checkout`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { invoice: { id: string; number: string }; promptpay?: { qrPayload: string }; card?: { clientSecret: string } };
}
function hook(type: string, providerRef: string, invoiceId: string) {
  const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type, data: { object: { id: providerRef, metadata: { invoice_id: invoiceId } } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', 'whsec_dev_fake').update(`${ts}.${raw}`).digest('hex')}`;
  return supertest(t.app.getHttpServer()).post('/api/v1/hooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(raw);
}
const ref = async (invoiceId: string) => (await t.owner.query('SELECT provider_ref FROM payments WHERE invoice_id = $1', [invoiceId])).rows[0].provider_ref as string;
const isPdf = (r: supertest.Response) => r.status === 200 && r.headers['content-type'] === 'application/pdf' && Buffer.from(r.body).subarray(0, 4).toString('latin1') === '%PDF';
const binary = (c: Client, url: string) => c.agent.get(`/api/v1${url}`).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (d: Buffer) => chunks.push(d));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

describe('ชำระใบเดิมจากหน้าชำระใบแจ้งหนี้', () => {
  it('บัตร: ขอ client secret ของใบเดิมได้ (รายการเดิม) · โอนใช้ไม่ได้ · ใบที่ชำระแล้วใช้ไม่ได้', async () => {
    const w = await workspace('docs-card');
    const card = await checkout(w.lead, w.ws, { plan: 'team_m', method: 'card' });
    const again = await post(w.lead, `${w.ws}/billing/invoices/${card.invoice.id}/pay`, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.card.clientSecret).toBe(card.card!.clientSecret);
    expect((await post(w.lead, `${w.ws}/billing/invoices/${card.invoice.id}/pay`, { renew: true })).body.error.code).toBe('renew_not_applicable');
    const transfer = await checkout(w.lead, w.ws, { plan: 'team_m', method: 'transfer' });
    expect((await post(w.lead, `${w.ws}/billing/invoices/${transfer.invoice.id}/pay`, {})).body.error.code).toBe('pay_not_applicable');
    await hook('payment_intent.succeeded', await ref(card.invoice.id), card.invoice.id);
    expect((await post(w.lead, `${w.ws}/billing/invoices/${card.invoice.id}/pay`, {})).body.error.code).toBe('invoice_closed');
    expect((await post(w.lead, `${w.ws}/billing/invoices/${randomUUID()}/pay`, {})).status).toBe(404);
  });

  it('PromptPay: QR หมดอายุ → สร้างใหม่ในใบเดิม (เลขอ้างอิงใหม่) · กดซ้ำได้ชุดเดิม · จ่ายด้วยรายการใหม่แล้วใบเดิมปิด', async () => {
    const w = await workspace('docs-qr');
    const pp = await checkout(w.lead, w.ws, { plan: 'team_s', method: 'promptpay' });
    const first = await ref(pp.invoice.id);
    const renewed = await post(w.lead, `${w.ws}/billing/invoices/${pp.invoice.id}/pay`, { renew: true });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    const second = await ref(pp.invoice.id);
    expect(second).not.toBe(first);
    expect(renewed.body.promptpay.qrPayload).toContain(second);
    expect(renewed.body.invoice.id).toBe(pp.invoice.id);
    // ขอ QR ปัจจุบันซ้ำ = รายการเดียวกัน
    expect((await post(w.lead, `${w.ws}/billing/invoices/${pp.invoice.id}/pay`, {})).body.promptpay.qrPayload).toContain(second);
    expect((await hook('payment_intent.succeeded', second, pp.invoice.id)).body).toEqual({ received: true });
    expect((await t.owner.query('SELECT status FROM invoices WHERE id = $1', [pp.invoice.id])).rows[0].status).toBe('paid');
  });

  it('สลิป: เวลาโอนที่แจ้งเก็บไว้เป็นวันที่ของใบกำกับภาษี · ล่วงหน้า / ก่อนออกใบแจ้งหนี้ไม่ได้', async () => {
    const w = await workspace('docs-slip');
    const tr = await checkout(w.lead, w.ws, { plan: 'team_s', method: 'transfer' });
    const url = `/api/v1${w.ws}/billing/invoices/${tr.invoice.id}/slip`;
    const send = (paidAt: string) => w.lead.agent.post(url).set('x-csrf-token', csrf.get(w.lead)!).field('paidAt', paidAt).attach('file', PNG, 'slip.png');
    expect((await send(new Date(Date.now() + 3_600_000).toISOString())).body.error.code).toBe('invalid_paid_at');
    expect((await send(new Date(Date.now() - 3 * 86_400_000).toISOString())).body.error.code).toBe('invalid_paid_at');
    const at = new Date(Date.now() - 10 * 60_000);
    const ok = await send(at.toISOString());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(new Date(ok.body.paymentPaidAt).getTime()).toBe(Math.floor(at.getTime() / 1000) * 1000 + (at.getTime() % 1000));
  });
});

describe('เอกสาร PDF', () => {
  it('ใบแจ้งหนี้ · ใบกำกับภาษี · ใบลดหนี้ · ใบเพิ่มหนี้ · ใบเสนอราคา · Workspace อื่นเปิดไม่ได้', async () => {
    const w = await workspace('docs-pdf');
    const other = await workspace('docs-pdf-other');
    const card = await checkout(w.lead, w.ws, { plan: 'team_m', method: 'card' });
    await hook('payment_intent.succeeded', await ref(card.invoice.id), card.invoice.id);
    const list = (await w.lead.get(`${w.ws}/billing/invoices`)).body.items as { id: string; pdfUrl: string; taxDocument: { id: string; number: string; issuedOn: string; pdfUrl: string }; notes: unknown[] }[];
    const inv = list.find((i) => i.id === card.invoice.id)!;
    expect(inv.taxDocument).toMatchObject({ number: expect.stringMatching(/^TX-\d{4}-\d{4}$/), issuedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(isPdf(await binary(w.lead, inv.pdfUrl.replace('/api/v1', '')))).toBe(true);
    expect(isPdf(await binary(w.lead, inv.taxDocument.pdfUrl.replace('/api/v1', '')))).toBe(true);
    expect((await binary(other.lead, inv.taxDocument.pdfUrl.replace('/api/v1', '').replace(w.ws, other.ws))).status).toBe(404);

    // ทีม Friday ออกใบลด / เพิ่มหนี้ (หลังบ้าน) → ลูกค้าเห็นในรายการและดาวน์โหลดได้
    const cn = (await t.owner.query(`INSERT INTO credit_notes (workspace_id, invoice_id, number, kind, amount_satang, vat_satang, reason, status, refund_method, issued_at) VALUES ($1,$2,'CN-DOCS-1','refund',100000,7000,'คืนส่วนที่ไม่ได้ใช้','issued','bank_transfer',now()) RETURNING id`, [w.wsId, card.invoice.id])).rows[0].id;
    const dn = (await t.owner.query(`INSERT INTO debit_notes (workspace_id, invoice_id, number, amount_satang, vat_satang, reason, issued_at) VALUES ($1,$2,'DN-DOCS-1',50000,3500,'คิดขาด',now()) RETURNING id`, [w.wsId, card.invoice.id])).rows[0].id;
    const notes = ((await w.lead.get(`${w.ws}/billing/invoices`)).body.items as typeof list).find((i) => i.id === card.invoice.id)!.notes;
    expect(notes).toEqual([
      expect.objectContaining({ kind: 'credit', number: 'CN-DOCS-1', amount: 107_000, pdfUrl: `/api/v1${w.ws}/billing/credit-notes/${cn}.pdf` }),
      expect.objectContaining({ kind: 'debit', number: 'DN-DOCS-1', amount: 53_500, pdfUrl: `/api/v1${w.ws}/billing/debit-notes/${dn}.pdf` }),
    ]);
    expect(isPdf(await binary(w.lead, `${w.ws}/billing/credit-notes/${cn}.pdf`))).toBe(true);
    expect(isPdf(await binary(w.lead, `${w.ws}/billing/debit-notes/${dn}.pdf`))).toBe(true);
    expect((await binary(other.lead, `${other.ws}/billing/credit-notes/${cn}.pdf`)).status).toBe(404);

    // ใบเสนอราคา: ทุกครั้งได้เลข QT- ใหม่ เก็บไว้อ้างอิง · ยืนราคา 30 วัน
    expect(isPdf(await binary(w.lead, `${w.ws}/billing/quotation.pdf?plan=team_l&cycle=yearly&wht=true`))).toBe(true);
    const quotes = (await t.owner.query(`SELECT number, plan, cycle, wht, amount_due, valid_until - current_date AS days FROM quotations WHERE workspace_id = $1`, [w.wsId])).rows;
    expect(quotes).toEqual([expect.objectContaining({ number: expect.stringMatching(/^QT-\d{4}-\d{4}$/), plan: 'team_l', cycle: 'yearly', wht: true, days: 30 })]);
    expect((await binary(w.lead, `${w.ws}/billing/quotation.pdf?plan=nope`)).status).toBe(400);
  });
});
