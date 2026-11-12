// O20 · คูปองตอน checkout และราคาแบบมีเวอร์ชัน (grandfathering) ฝั่ง API ลูกค้า · ข้อมูลสมมติเท่านั้น
import { createHmac, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGateway, PAYMENT_GATEWAY } from '../src/payments/providers.js';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let gateway: FakeGateway;
let staffId: string;
const csrf = new Map<Client, string>();
const profile = { companyName: 'บริษัท คูปองทดสอบ จำกัด', taxId: '0105599999998', branchType: 'head', address: '1 ถนนสมมติ กรุงเทพฯ 10110', taxEmail: 'coupon@example.com', whtEnabled: false };
const DAY = 86_400_000;
const isoDate = (days: number) => new Date(Date.now() + 7 * 3_600_000 + days * DAY).toISOString().slice(0, 10);

async function workspace(slug: string) {
  const team = await seedTeam(t, { slug });
  csrf.set(team.lead, ((await team.lead.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken);
  csrf.set(team.dev, ((await team.dev.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken);
  const wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [slug])).rows[0].id as string;
  await team.lead.get(`${team.ws}/billing`);
  const p = await team.lead.agent.put(`/api/v1${team.ws}/billing/profile`).set('x-csrf-token', csrf.get(team.lead)!).send(profile);
  expect(p.status).toBe(200);
  return { lead: team.lead, dev: team.dev, ws: team.ws, wsId };
}
type W = Awaited<ReturnType<typeof workspace>>;
const post = (c: Client, url: string, body: object, key = `idem-${randomUUID()}`) => c.agent.post(`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!).set('Idempotency-Key', key).send(body);
async function checkout(w: W, body: object) {
  const r = await post(w.lead, `${w.ws}/billing/checkout`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const ref = (await t.owner.query('SELECT provider_ref FROM payments WHERE invoice_id = $1', [r.body.invoice.id])).rows[0]?.provider_ref as string | undefined;
  return { body: r.body, ref };
}
function paid(providerRef: string, invoiceId: string) {
  const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: providerRef, metadata: { invoice_id: invoiceId } } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', 'whsec_dev_fake').update(`${ts}.${raw}`).digest('hex')}`;
  return supertest(t.app.getHttpServer()).post('/api/v1/hooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(raw);
}
async function coupon(code: string, over: Record<string, unknown> = {}) {
  const c = { kind: 'percent', value: 20, duration: 'repeating', duration_cycles: 2, plan_codes: ['team_s', 'team_m', 'team_l'], max_redemptions: null, expires_on: null, new_customers_only: false, stackable: false, status: 'active', ...over };
  const r = await t.owner.query(
    `INSERT INTO coupons (code, kind, value, duration, duration_cycles, plan_codes, max_redemptions, expires_on, new_customers_only, stackable, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [code, c.kind, c.value, c.duration, c.duration_cycles, c.plan_codes, c.max_redemptions, c.expires_on, c.new_customers_only, c.stackable, c.status, staffId],
  );
  return r.rows[0].id as string;
}
const redemption = async (wsId: string, code: string) =>
  (await t.owner.query(`SELECT r.status, r.cycles_total, r.ended_at FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id WHERE r.workspace_id = $1 AND c.code = $2`, [wsId, code])).rows[0];

beforeAll(async () => {
  t = await startApp();
  gateway = t.app.get(PAYMENT_GATEWAY) as FakeGateway;
  staffId = (await t.owner.query(`INSERT INTO staff_users (email, name, roles) VALUES ('promo@friday.example.com', 'Pim Promo', '{finance}') RETURNING id`)).rows[0].id;
});
afterAll(() => t.close());

describe('คูปองตอนชำระเงิน', () => {
  it('ส่วนลด % 2 รอบแรก: หักก่อน VAT · ผู้ให้บริการตัดยอดสุทธิ · นับรอบเมื่อชำระ · รอบที่ 2 ได้ต่อเอง · ครบแล้วจ่ายราคาปกติ', async () => {
    await coupon('TEAM20');
    const w = await workspace('cp-percent');
    const q = await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly&coupon=%20team20%20`);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body).toMatchObject({ listPrice: 300_000, discount: 60_000, subtotal: 240_000, vat: 16_800, total: 256_800, amountDue: 256_800, coupon: 'TEAM20', freeMonths: null, grandfathered: false });
    expect(q.body.discounts).toEqual([{ code: 'TEAM20', kind: 'percent', value: 20, amount: 60_000, cyclesLeft: 1, carried: false }]);
    expect(q.body.internal).toBeUndefined();

    const first = await checkout(w, { plan: 'team_m', cycle: 'monthly', method: 'card', coupon: 'team20' });
    expect(first.body.invoice).toMatchObject({ subtotal: 240_000, discount: 60_000, amountDue: 256_800 });
    // Gateway (ตัวจำลอง / ของจริงใน A35b) ได้ยอดหลังหักส่วนลดแล้ว
    expect(gateway.calls.at(-1)!.request.amount).toBe(256_800);
    expect((await t.owner.query('SELECT amount FROM payments WHERE invoice_id = $1', [first.body.invoice.id])).rows[0].amount).toBe('256800');
    expect(await redemption(w.wsId, 'TEAM20')).toMatchObject({ status: 'pending', cycles_total: 2 });
    expect((await paid(first.ref!, first.body.invoice.id)).body).toEqual({ received: true });
    expect(await redemption(w.wsId, 'TEAM20')).toMatchObject({ status: 'active' });

    // รอบที่ 2: ไม่ต้องใส่โค้ดอีก
    const q2 = await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly`);
    expect(q2.body).toMatchObject({ discount: 60_000, coupon: null });
    expect(q2.body.discounts[0]).toMatchObject({ code: 'TEAM20', carried: true, cyclesLeft: 0 });
    const second = await checkout(w, { plan: 'team_m', cycle: 'monthly', method: 'promptpay' });
    await paid(second.ref!, second.body.invoice.id);
    const ended = await redemption(w.wsId, 'TEAM20');
    expect(ended.status).toBe('ended');
    expect(ended.ended_at).not.toBeNull();

    // หมดส่วนลดแล้ว: ราคาปกติ · ใส่โค้ดเดิมซ้ำไม่ได้
    expect((await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly`)).body).toMatchObject({ discount: 0, subtotal: 300_000, discounts: [] });
    const again = await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly&coupon=TEAM20`);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('coupon_already_used');
    // ใบแจ้งหนี้และ PDF แสดงส่วนลด
    const inv = await w.lead.get(`${w.ws}/billing/invoices/${first.body.invoice.id}`);
    expect(inv.body.discount).toBe(60_000);
  });

  it('โค้ดที่ใช้ไม่ได้ตอบ 422 พร้อมข้อความไทย', async () => {
    await coupon('DRAFT10', { status: 'draft' });
    await coupon('OLD10', { expires_on: isoDate(-1) });
    await coupon('SONLY', { plan_codes: ['team_s'] });
    await coupon('NEWBIE', { new_customers_only: true });
    await coupon('ONEONLY', { max_redemptions: 1, duration: 'once', duration_cycles: null });
    const w = await workspace('cp-errors');
    const code = async (c: string, plan = 'team_m') => {
      const r = await w.lead.get(`${w.ws}/billing/quote?plan=${plan}&cycle=monthly&coupon=${c}`);
      expect(r.status, `${c} ${JSON.stringify(r.body)}`).toBe(422);
      expect(r.body.error.message).toMatch(/[ก-๙]/);
      return r.body.error.code as string;
    };
    expect(await code('NOPE99')).toBe('coupon_not_found');
    expect(await code('DRAFT10')).toBe('coupon_inactive');
    expect(await code('OLD10')).toBe('coupon_expired');
    expect(await code('SONLY')).toBe('coupon_plan_mismatch');
    expect((await w.lead.get(`${w.ws}/billing/quote?plan=team_s&cycle=monthly&coupon=SONLY`)).status).toBe(200);
    expect((await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly&coupon=bad code`)).status).toBe(400);

    // จำนวนสิทธิ์: Workspace อื่นใช้ไปแล้ว (รอชำระก็จองสิทธิ์ไว้)
    const other = await workspace('cp-errors-2');
    await checkout(other, { plan: 'team_m', cycle: 'monthly', method: 'transfer', coupon: 'ONEONLY' });
    expect(await code('ONEONLY')).toBe('coupon_exhausted');

    // เฉพาะลูกค้าใหม่: เคยชำระแล้วใช้ไม่ได้
    expect((await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly&coupon=NEWBIE`)).status).toBe(200);
    const plain = await checkout(w, { plan: 'team_m', cycle: 'monthly', method: 'card' });
    await paid(plain.ref!, plain.body.invoice.id);
    expect(await code('NEWBIE')).toBe('coupon_new_customers_only');

    // สมาชิกที่ไม่ใช่ผู้ชำระเงินดูราคาไม่ได้
    expect((await w.dev.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly&coupon=SONLY`)).status).toBe(403);
  });

  it('ใช้คู่กันได้เฉพาะคูปองที่ติด "ใช้คู่กับคูปองอื่นได้" ทั้งคู่', async () => {
    await coupon('STACKA', { kind: 'amount', value: 50_000, duration: 'forever', duration_cycles: null, stackable: true });
    await coupon('STACKB', { kind: 'percent', value: 10, duration: 'once', duration_cycles: null, stackable: true });
    await coupon('SOLO', { kind: 'percent', value: 10, duration: 'once', duration_cycles: null });
    const w = await workspace('cp-stack');
    const first = await checkout(w, { plan: 'team_s', cycle: 'monthly', method: 'card', coupon: 'STACKA' });
    expect(first.body.invoice).toMatchObject({ discount: 50_000, subtotal: 100_000 });
    await paid(first.ref!, first.body.invoice.id);
    const solo = await w.lead.get(`${w.ws}/billing/quote?plan=team_s&cycle=monthly&coupon=SOLO`);
    expect(solo.status).toBe(422);
    expect(solo.body.error.code).toBe('coupon_not_stackable');
    const both = await w.lead.get(`${w.ws}/billing/quote?plan=team_s&cycle=monthly&coupon=STACKB`);
    expect(both.body).toMatchObject({ listPrice: 150_000, discount: 65_000, subtotal: 85_000, coupon: 'STACKB' });
    expect(both.body.discounts.map((d: { code: string; carried: boolean; cyclesLeft: number | null }) => [d.code, d.carried, d.cyclesLeft])).toEqual([
      ['STACKA', true, null],
      ['STACKB', false, 0],
    ]);
  });

  it('ใช้ฟรี N เดือน: ใบยอด 0 ปิดทันทีโดยไม่ผ่านผู้ให้บริการ · เปิดแพ็กเกจ N เดือน · ไม่ออกใบกำกับภาษี', async () => {
    await coupon('EDUFREE', { kind: 'free_months', value: 2, duration: 'once', duration_cycles: null, plan_codes: ['team_m'] });
    const w = await workspace('cp-free');
    const q = await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly&coupon=EDUFREE`);
    expect(q.body).toMatchObject({ discount: 300_000, subtotal: 0, vat: 0, amountDue: 0, freeMonths: 2 });
    const calls = gateway.calls.length;
    const key = `idem-${randomUUID()}`;
    const r = await post(w.lead, `${w.ws}/billing/checkout`, { plan: 'team_m', cycle: 'monthly', method: 'card', coupon: 'EDUFREE' }, key);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ payment: null, free: true, replayed: false, invoice: { status: 'paid', amountDue: 0, discount: 300_000 } });
    expect(gateway.calls.length).toBe(calls);
    const months = (Date.parse(r.body.invoice.periodEnd) - Date.parse(r.body.invoice.periodStart)) / DAY;
    expect(months).toBeGreaterThan(55);
    expect(months).toBeLessThan(63);
    expect((await t.owner.query(`SELECT s.status, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.workspace_id = $1`, [w.wsId])).rows[0]).toEqual({ status: 'active', code: 'team_m' });
    expect((await t.owner.query('SELECT count(*)::int AS n FROM tax_documents WHERE invoice_id = $1', [r.body.invoice.id])).rows[0].n).toBe(0);
    expect(await redemption(w.wsId, 'EDUFREE')).toMatchObject({ status: 'ended' });
    // ส่งซ้ำด้วย key เดิมได้ผลเดิม
    const replay = await post(w.lead, `${w.ws}/billing/checkout`, { plan: 'team_m', cycle: 'monthly', method: 'card', coupon: 'EDUFREE' }, key);
    expect(replay.body).toMatchObject({ replayed: true, free: true, invoice: { id: r.body.invoice.id } });
    // หมดช่วงฟรีแล้วจ่ายราคาปกติ
    expect((await w.lead.get(`${w.ws}/billing/quote?plan=team_m&cycle=monthly`)).body).toMatchObject({ discount: 0, amountDue: 321_000 });
  });
});

describe('ราคาแบบมีเวอร์ชัน (grandfathering)', () => {
  it('ลูกค้าเดิมคงราคาเดิมจนกว่าจะย้ายแพ็กเกจ · ลูกค้าใหม่ได้ราคาใหม่ · next_cycle ที่ถึงวันแล้วย้ายให้ · ลดราคาแล้วลูกค้าเดิมได้ราคาใหม่', async () => {
    const old = await workspace('gf-old');
    // ราคาเดิม (เวอร์ชัน 1 = ค่าตั้งต้น ฿3,000) → ลูกค้าจ่ายแล้วผูกกับเวอร์ชันนั้น
    const v1 = (await t.owner.query(`INSERT INTO plan_price_versions (plan_code, version, effective_at, reason) VALUES ('team_m', 1, now() - interval '30 days', 'เริ่มต้น') RETURNING id`)).rows[0].id;
    const first = await checkout(old, { plan: 'team_m', cycle: 'monthly', method: 'card' });
    await paid(first.ref!, first.body.invoice.id);
    expect((await t.owner.query('SELECT price_version_id FROM subscriptions WHERE workspace_id = $1', [old.wsId])).rows[0].price_version_id).toBe(v1);

    // ขึ้นราคาเป็น ฿3,500
    await t.owner.query(`INSERT INTO plan_price_versions (plan_code, version, monthly_satang, effective_at, reason) VALUES ('team_m', 2, 350000, now() - interval '1 minute', 'ขึ้นราคา')`);
    await t.owner.query(`UPDATE plans SET price_monthly_satang = 350000 WHERE code = 'team_m'`);
    expect((await old.lead.get(`${old.ws}/billing/quote?plan=team_m&cycle=monthly`)).body).toMatchObject({ listPrice: 300_000, grandfathered: true });
    // ย้ายแพ็กเกจ = ราคาปัจจุบันของแพ็กเกจใหม่
    expect((await old.lead.get(`${old.ws}/billing/quote?plan=team_l&cycle=monthly`)).body).toMatchObject({ listPrice: 550_000, grandfathered: false });
    const fresh = await workspace('gf-new');
    expect((await fresh.lead.get(`${fresh.ws}/billing/quote?plan=team_m&cycle=monthly`)).body).toMatchObject({ listPrice: 350_000, grandfathered: false });
    // ต่ออายุแพ็กเกจเดิมยังผูกเวอร์ชันเดิม
    const renew = await checkout(old, { plan: 'team_m', cycle: 'monthly', method: 'card' });
    expect(renew.body.invoice.subtotal).toBe(300_000);
    await paid(renew.ref!, renew.body.invoice.id);
    expect((await t.owner.query('SELECT price_version_id FROM subscriptions WHERE workspace_id = $1', [old.wsId])).rows[0].price_version_id).toBe(v1);

    // เวอร์ชัน 3 แบบ next_cycle ที่พ้นช่วงแจ้งล่วงหน้าแล้ว → ลูกค้าเดิมย้าย
    await t.owner.query(`INSERT INTO plan_price_versions (plan_code, version, monthly_satang, existing_policy, existing_from, effective_at, reason) VALUES ('team_m', 3, 380000, 'next_cycle', now() - interval '1 minute', now() - interval '31 days', 'ปรับราคาทุกคน')`);
    await t.owner.query(`UPDATE plans SET price_monthly_satang = 380000 WHERE code = 'team_m'`);
    expect((await old.lead.get(`${old.ws}/billing/quote?plan=team_m&cycle=monthly`)).body).toMatchObject({ listPrice: 380_000, grandfathered: false });

    // ลดราคาลงต่ำกว่าราคาเดิม → ลูกค้าเดิมได้ราคาที่ถูกกว่า
    await t.owner.query(`INSERT INTO plan_price_versions (plan_code, version, monthly_satang, effective_at, reason) VALUES ('team_m', 4, 250000, now(), 'ลดราคา')`);
    expect((await old.lead.get(`${old.ws}/billing/quote?plan=team_m&cycle=monthly`)).body).toMatchObject({ listPrice: 250_000, grandfathered: false });
    await t.owner.query(`UPDATE plans SET price_monthly_satang = NULL WHERE code = 'team_m'`);
  });

  it('ปิดรับสมัครใหม่: ลูกค้าใหม่ซื้อไม่ได้ ลูกค้าเดิมต่ออายุได้ · หน้าราคาสาธารณะบอกสถานะและชื่อที่แสดง', async () => {
    const old = await workspace('open-old');
    const first = await checkout(old, { plan: 'team_l', cycle: 'monthly', method: 'card' });
    await paid(first.ref!, first.body.invoice.id);
    await t.owner.query(`UPDATE plans SET open_for_signup = false, listed = false, display_name = 'Team L (เดิม)' WHERE code = 'team_l'`);
    try {
      const fresh = await workspace('open-new');
      const r = await fresh.lead.get(`${fresh.ws}/billing/quote?plan=team_l&cycle=monthly`);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('plan_not_open');
      expect((await old.lead.get(`${old.ws}/billing/quote?plan=team_l&cycle=monthly`)).status).toBe(200);
      const pub = await supertest(t.app.getHttpServer()).get('/api/v1/public/plans');
      expect(pub.body.items.find((p: { code: string }) => p.code === 'team_l')).toMatchObject({ name: 'Team L (เดิม)', listed: false, openForSignup: false });
    } finally {
      await t.owner.query(`UPDATE plans SET open_for_signup = true, listed = true, display_name = NULL WHERE code = 'team_l'`);
    }
  });
});
