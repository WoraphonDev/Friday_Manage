// O41 · เครดิตและส่วนต่างเมื่อเปลี่ยนแพ็กเกจ (ฝั่ง Friday Ops) · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../src/billing/billing.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let finance: Staff;
let support: Staff;
let a: Customer;
const credit = (ws: Customer, satang: number, source = 'goodwill') => t.owner.query(`INSERT INTO workspace_credits (workspace_id, amount_satang, source, note) VALUES ($1,$2,$3,'ทดสอบ')`, [ws.id, satang, source]);
const balance = async (ws: Customer) => Number((await t.owner.query(`SELECT coalesce(sum(amount_satang),0)::int AS b FROM workspace_credits WHERE workspace_id = $1`, [ws.id])).rows[0].b);
const newInvoice = (ws: Customer, unit: number, plan?: object) =>
  finance.agent.post('/ops/invoices').send({ workspaceId: ws.id, dueDays: 7, discountPct: 0, wht: false, send: true, items: [{ description: 'ค่าบริการทดสอบ', qty: 1, unitSatang: unit }], ...(plan ? { plan } : {}) });

async function profile(ws: Customer) {
  await t.owner.query(`INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email) VALUES ($1, $2, '0105500000041', '41 ถนนสมมติ', $3)`, [ws.id, `บริษัท ${ws.slug} จำกัด`, `acc@${ws.slug}.example.com`]);
}

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  a = await customer(t, 'credit-demo', { plan: 'team_m', status: 'active' });
  await profile(a);
  // ราคาตัวอย่างแบบเดียวกับ customers.e2e
  await t.owner.query(`UPDATE plans SET price_monthly_satang = 300000, price_yearly_satang = 3000000, seat_limit = 25 WHERE code = 'team_m'`);
  await t.owner.query(`UPDATE plans SET price_monthly_satang = 150000, price_yearly_satang = 1500000 WHERE code = 'team_s'`);
  await t.owner.query(`UPDATE plans SET price_monthly_satang = 550000, price_yearly_satang = 5500000, seat_limit = 50 WHERE code = 'team_l'`);
});
afterAll(() => t.close());

describe('หักเครดิตทุกใบแจ้งหนี้ (R2 · R4)', () => {
  it('เครดิตไม่พอ: หักบางส่วน · รายการรอโอนเท่ายอดที่เหลือ · ใบกำกับภาษียังเต็มยอด', async () => {
    await credit(a, 50_000);
    const r = await newInvoice(a, 300_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // 3,000 + VAT 210 = 3,210 · หักเครดิต 500 → ต้องชำระ 2,710
    expect(r.body.invoice).toMatchObject({ subtotal: 300_000, vat: 21_000, total: 321_000, creditApplied: 50_000, amountDue: 271_000, status: 'open' });
    expect((await t.owner.query(`SELECT amount::int FROM payments WHERE invoice_id = $1`, [r.body.invoice.id])).rows).toEqual([{ amount: 271_000 }]);
    expect((await t.owner.query(`SELECT amount_satang::int AS a, source FROM workspace_credits WHERE invoice_id = $1`, [r.body.invoice.id])).rows).toEqual([{ a: -50_000, source: 'applied' }]);
    expect(await balance(a)).toBe(0);
    expect(mail.sent.at(-1)?.text).toContain('หักเครดิต');
  });

  it('เครดิตพอทั้งใบ: ชำระแล้วทันที ออกใบกำกับภาษีวันนี้ ไม่มีรายการรอโอน · อีเมลบอกว่าชำระด้วยเครดิต', async () => {
    await credit(a, 400_000);
    const r = await newInvoice(a, 100_000);
    expect(r.body.invoice).toMatchObject({ total: 107_000, creditApplied: 107_000, amountDue: 0, status: 'paid' });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1`, [r.body.invoice.id])).rows[0].n).toBe(0);
    const doc = (await t.owner.query(`SELECT doc_type, status FROM tax_documents WHERE invoice_id = $1`, [r.body.invoice.id])).rows;
    expect(doc).toHaveLength(1);
    expect(mail.sent.at(-1)?.subject).toContain('ชำระด้วยเครดิตแล้ว');
    expect(await balance(a)).toBe(293_000);
  });

  it('ยกเลิกใบที่ยังไม่ชำระซึ่งหักเครดิตไป → คืนเครดิต (reversal) · ยกเลิกซ้ำไม่คืนซ้ำ', async () => {
    const r = await newInvoice(a, 500_000); // 5,350 หักเครดิต 2,930 ที่เหลือ
    expect(r.body.invoice.creditApplied).toBe(293_000);
    expect(await balance(a)).toBe(0);
    const v = await finance.agent.post(`/ops/invoices/${r.body.invoice.id}/void`).send({ reason: 'ออกผิดรายการ', money: 'none' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(await balance(a)).toBe(293_000);
    expect((await t.owner.query(`SELECT source FROM workspace_credits WHERE invoice_id = $1 ORDER BY created_at`, [r.body.invoice.id])).rows.map((x) => x.source)).toEqual(['applied', 'reversal']);
  });
});

describe('บัญชีเครดิต (R1)', () => {
  it('ประวัติใหม่สุดก่อน พร้อมคงเหลือหลังแต่ละบรรทัด · สรุปใบถัดไป · Support อ่านได้', async () => {
    const r = await support.agent.get(`/ops/credits?workspaceId=${a.id}`);
    expect(r.status).toBe(200);
    expect(r.body.balanceSatang).toBe(293_000);
    expect(r.body.items[0]).toMatchObject({ source: 'reversal', amountSatang: 293_000, balanceSatang: 293_000 });
    expect(r.body.items.at(-1)).toMatchObject({ source: 'goodwill', amountSatang: 50_000, balanceSatang: 50_000 });
    expect(r.body.next).toMatchObject({ plan: 'team_m', totalSatang: 321_000, creditSatang: 293_000, payableSatang: 28_000 });
  });

  it('คืนเป็นเงิน: ไม่เกินคงเหลือ · ในวงเงินทำเลย (แถว refunded) · เกินวงเงิน → ขออนุมัติ · Support ทำไม่ได้', async () => {
    expect((await finance.agent.post('/ops/credits:refund').send({ workspaceId: a.id, amountSatang: 999_999, reason: 'ขอคืนทั้งหมด' })).body.error.code).toBe('credit_exceeds_balance');
    expect((await support.agent.post('/ops/credits:refund').send({ workspaceId: a.id, amountSatang: 10_000, reason: 'ขอคืน' })).status).toBe(403);
    const ok = await finance.agent.post('/ops/credits:refund').send({ workspaceId: a.id, amountSatang: 93_000, reason: 'ลูกค้าเลิกใช้บางส่วน' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ refundedSatang: 93_000, balanceSatang: 200_000 });
    expect(mail.sent.at(-1)?.text).toContain('โอนคืน');
    await t.owner.query(`UPDATE staff_users SET limits = '{"refundSatang": 50000}'::jsonb WHERE id = $1`, [finance.id]);
    const big = await finance.agent.post('/ops/credits:refund').send({ workspaceId: a.id, amountSatang: 150_000, reason: 'คืนส่วนที่เหลือ' });
    expect(big.status).toBe(202);
    expect(big.body.pendingApproval).toBeTruthy();
    await t.owner.query(`UPDATE staff_users SET limits = NULL WHERE id = $1`, [finance.id]);
    expect(await balance(a)).toBe(200_000);
  });
});

describe('เปลี่ยนแพ็กเกจ (C4 · R2 · R3)', () => {
  it('อัปเกรดกลางรอบ: ตัวอย่างยอดแสดงเครดิตที่หักและยอดที่ต้องชำระ', async () => {
    const pv = await finance.agent.get(`/ops/workspaces/${a.id}/change-plan/preview?plan=team_l`);
    expect(pv.status).toBe(200);
    expect(pv.body.creditBalanceSatang).toBe(200_000);
    expect(pv.body.creditApplySatang).toBe(Math.min(200_000, pv.body.totalSatang));
    expect(pv.body.payNowSatang).toBe(pv.body.totalSatang - pv.body.creditApplySatang);
    expect(pv.body.unused).toBeNull();
  });

  it('เปลี่ยนรอบบิลกลางรอบ: ส่วนที่ยังไม่ได้ใช้ → ใบลดหนี้ + เครดิต · ใบใหม่หักเครดิต · ที่เหลือเข้าเครดิต (เดิมถูกตัดเป็น ฿0)', async () => {
    const b = await customer(t, 'credit-yearly', { plan: 'team_m', status: 'active', cycle: 'yearly' });
    await profile(b);
    // ใบรายปีที่จ่ายแล้วและเปิดรอบนี้ (รอบ 365 วัน · ผ่านไป 5 วัน)
    const src = (await t.owner.query(
      `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date, paid_at)
       VALUES ($1,$2,$3,current_date - 5,current_date + 359,3000000,210000,3210000,3210000,'paid',current_date - 5, now() - interval '5 days') RETURNING id`,
      [b.id, b.sub, `FRI-Y-${randomUUID().slice(0, 6)}`],
    )).rows[0].id;
    await t.owner.query(`INSERT INTO tax_documents (workspace_id, invoice_id, doc_type, number, status, issued_on) VALUES ($1,$2,'tax_invoice_receipt',$3,'issued',current_date - 5)`, [b.id, src, `TX-Y-${randomUUID().slice(0, 6)}`]);
    await t.owner.query(`UPDATE subscriptions SET current_period_start = now() - interval '5 days', current_period_end = now() + interval '360 days', source_invoice_id = $2 WHERE id = $1`, [b.sub, src]);

    const pv = await finance.agent.get(`/ops/workspaces/${b.id}/change-plan/preview?plan=team_m&cycle=monthly`);
    expect(pv.body.lines).toHaveLength(1);
    expect(pv.body.unused.creditSatang).toBeGreaterThan(3_000_000); // ส่วนที่ยังไม่ได้ใช้ ~360/365 ของ 32,100
    expect(pv.body.payNowSatang).toBe(0);
    expect(pv.body.leftoverCreditSatang).toBe(pv.body.unused.creditSatang - pv.body.totalSatang);

    const r = await finance.agent.post(`/ops/workspaces/${b.id}:change-plan`).send({ plan: 'team_m', cycle: 'monthly', reason: 'ลูกค้าลดทีม ขอเปลี่ยนเป็นรายเดือน' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.creditNote?.number).toMatch(/^CN-/);
    expect(r.body.invoice).toMatchObject({ status: 'paid', amountDue: 0, creditApplied: 321_000 });
    expect(r.body.refund).toBeNull();
    const cn = (await t.owner.query(`SELECT kind, amount_satang + vat_satang AS cash FROM credit_notes WHERE invoice_id = $1`, [src])).rows[0];
    expect(cn.kind).toBe('credit');
    expect(await balance(b)).toBe(Number(cn.cash) - 321_000);
    // ใบลดหนี้อ้างใบกำกับภาษีที่จด VAT → เข้าคิว e-Tax
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM etax_jobs WHERE doc_kind = 'credit_note'`)).rows[0].n).toBeGreaterThan(0);
  });

  it('เลือก "คืนเงิน": เครดิตที่เหลือส่งขออนุมัติคืนเงิน (เกินวงเงิน)', async () => {
    const c2 = await customer(t, 'credit-refund', { plan: 'team_l', status: 'active', cycle: 'yearly' });
    await profile(c2);
    const src = (await t.owner.query(
      `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date, paid_at)
       VALUES ($1,$2,$3,current_date - 5,current_date + 359,5500000,385000,5885000,5885000,'paid',current_date - 5, now() - interval '5 days') RETURNING id`,
      [c2.id, c2.sub, `FRI-R-${randomUUID().slice(0, 6)}`],
    )).rows[0].id;
    await t.owner.query(`UPDATE subscriptions SET current_period_start = now() - interval '5 days', current_period_end = now() + interval '360 days', source_invoice_id = $2 WHERE id = $1`, [c2.sub, src]);
    const r = await finance.agent.post(`/ops/workspaces/${c2.id}:change-plan`).send({ plan: 'team_l', cycle: 'monthly', reason: 'ลูกค้าขอเงินคืนส่วนที่เหลือ', remainder: 'refund' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.refund.pendingApproval).toBeTruthy();
  });
});

describe('ลดแพ็กเกจที่ตั้งไว้ (R6)', () => {
  it('วันที่มีผลยังเกินขีดจำกัด → คงแพ็กเกจเดิมอีก 1 รอบ · อีเมล Owner ครั้งเดียว · ลดได้เมื่อไม่เกินแล้ว', async () => {
    const d = await customer(t, 'credit-down', { plan: 'team_m', status: 'active' });
    const teamS = (await t.owner.query(`SELECT id, seat_limit FROM plans WHERE code = 'team_s'`)).rows[0];
    const limit = (await t.owner.query(`SELECT (matrix -> 'team_s' ->> 'seats')::int AS n FROM entitlement_versions ORDER BY version DESC LIMIT 1`)).rows[0]?.n ?? 10;
    for (let i = 0; i < limit; i++) {
      const u = (await t.owner.query(`INSERT INTO users (email, display_name) VALUES ($1, 'สมาชิก') RETURNING id`, [`m${i}-${randomUUID().slice(0, 4)}@credit-down.example.com`])).rows[0].id;
      await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [d.id, u]);
    }
    await t.owner.query(`UPDATE subscriptions SET pending_plan_id = $2, pending_cycle = 'monthly', current_period_end = now() - interval '1 minute' WHERE id = $1`, [d.sub, teamS.id]);
    const svc = t.app.get(BillingService);
    const before = mail.sent.length;
    expect(await svc.applyScheduledPlans()).toEqual([]);
    expect(await svc.applyScheduledPlans()).toEqual([]);
    expect(mail.sent.length - before).toBe(1);
    expect(mail.sent.at(-1)?.text).toContain('ต่ออีก 1 รอบ');
    expect((await t.owner.query(`SELECT p.code, s.pending_plan_id IS NOT NULL AS pending FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`, [d.sub])).rows[0]).toEqual({ code: 'team_m', pending: true });
    // ลดสมาชิกให้ไม่เกินแล้วรอบถัดไปเปลี่ยนให้
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE workspace_id = $1 AND role = 'member'`, [d.id]);
    expect((await svc.applyScheduledPlans()).map((x) => x.to)).toEqual(['team_s']);
  });
});
