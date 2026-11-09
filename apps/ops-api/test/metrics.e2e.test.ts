// O06 · ภาพรวม ธุรกิจและกำไร ต้นทุน และค่าการตลาด · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let finance: Staff;
let support: Staff;
let auditor: Staff;
let a: Customer;
let b: Customer;
let c: Customer;
let d: Customer;
let e: Customer;
const DAY = 86_400_000;
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const month = () => today().slice(0, 7);

/** ประวัติ MRR (A34) · วันที่ย้อนหลังเป็นวัน */
const change = (c: Customer, kind: string, before: number, after: number, daysAgo: number, plan = 'team_m') =>
  t.owner.query(`INSERT INTO subscription_changes (workspace_id, kind, plan_to, mrr_before_satang, mrr_after_satang, actor_kind, effective_at) VALUES ($1,$2,$3,$4,$5,'user', now() - make_interval(days => $6))`, [c.id, kind, plan, before, after, daysAgo]);

beforeAll(async () => {
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  auditor = await staff(t, 'audit@office.example.com', 'Aud Office', ['auditor']);
  a = await customer(t, 'biz-a', { plan: 'team_m', status: 'active' });
  b = await customer(t, 'biz-b', { plan: 'team_l', status: 'active' });
  c = await customer(t, 'biz-c', { plan: 'team_s', status: 'canceled' });
  d = await customer(t, 'biz-d', { plan: 'team_l', status: 'active', cycle: 'yearly' });
  e = await customer(t, 'biz-e', { plan: 'team_s', status: 'active' });
  await t.owner.query(`UPDATE plans SET seat_limit = 25, storage_gb_per_member = 5 WHERE code = 'team_m'`);
  await change(a, 'new', 0, 300_000, 120);
  await change(b, 'new', 0, 550_000, 60, 'team_l');
  await change(c, 'new', 0, 150_000, 380, 'team_s');
  await change(c, 'cancel', 150_000, 0, 0, 'team_s');
  await change(d, 'new', 0, 300_000, 380);
  await change(d, 'upgrade', 300_000, 550_000, 31, 'team_l');
  await change(e, 'new', 0, 1_000, 10, 'team_s');
  await t.owner.query(`INSERT INTO cost_rates (resource, unit_cost_satang, effective_from) VALUES ('line_message', 4, '2026-01-01'), ('email', 1, '2026-01-01')`);
  await t.owner.query(`INSERT INTO infra_costs (month, category, amount_satang) VALUES (date_trunc('month', now())::date, 'aws', 100000)`);
  await t.owner.query(`INSERT INTO daily_usages (workspace_id, date, line_messages, emails, active_users) VALUES ($1, current_date - 1, 1000, 500, 10), ($2, current_date - 1, 0, 0, 10), ($3, current_date - 1, 100000, 0, 0)`, [a.id, d.id, e.id]);
  await t.owner.query(`INSERT INTO workspace_acquisitions (workspace_id, source) VALUES ($1, 'facebook'), ($2, 'google')`, [a.id, b.id]);
  await t.owner.query(`INSERT INTO marketing_costs (month, source, amount_satang) VALUES (date_trunc('month', now())::date, 'google', 4800000)`);
  await t.owner.query(`INSERT INTO cancellation_responses (workspace_id, reason, outcome) VALUES ($1, 'too_expensive', 'canceled')`, [c.id]);
  await t.owner.query(`INSERT INTO product_events (workspace_id, name, props) VALUES ($1, 'feature.used', '{"feature":"gantt"}')`, [a.id]);
  const guest = (await t.owner.query(`INSERT INTO users (email, display_name) VALUES ('guest@biz.example.com', 'guest') RETURNING id`)).rows[0].id;
  await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'guest')`, [a.id, guest]);
  await t.owner.query(`UPDATE users SET email_verified_at = now() WHERE email = 'owner@biz-a.example.com'`);
  // ค้างรับ 45 วัน · รายปีที่ชำระแล้วเหลือ 334 วัน
  await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date) VALUES ($1,$2,'FRI-BIZ-1',current_date - 75,current_date - 46,300000,21000,321000,321000,'open',current_date - 45)`, [a.id, a.sub]);
  await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date, paid_at) VALUES ($1,$2,'FRI-BIZ-2',current_date - 30,current_date + 334,5500000,385000,5885000,5885000,'paid',current_date - 25, now() - interval '28 days')`, [d.id, d.sub]);
  await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date) VALUES ($1,$2,'FRI-BIZ-3',current_date,current_date + 29,1000,70,1070,1070,'pending_review',current_date + 7)`, [e.id, e.sub]);
  const inv = (await t.owner.query(`SELECT id FROM invoices WHERE number = 'FRI-BIZ-3'`)).rows[0].id;
  await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, exception_reason) VALUES ($1,$2,'transfer',1070,'amount_mismatch')`, [e.id, inv]);
});
afterAll(() => t.close());

describe('ภาพรวม (Main)', () => {
  it('MRR / ARR / churn / NRR / MRR movement · งานวันนี้', async () => {
    const r = await finance.agent.get('/ops/overview');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = r.body.money;
    expect(m).toMatchObject({ mrr: 1_401_000, arr: 1_401_000 * 12, payingWorkspaces: 4 });
    // ต้นเดือน: a, b, d, c (+ e ถ้าเริ่มก่อนต้นเดือน) · ยกเลิก 1 ราย 150,000
    expect(m.movement.cancel).toEqual({ count: 1, mrrDelta: -150_000 });
    expect(m.churn.logoPct).toBeGreaterThan(0);
    expect(m.churn.revenuePct).toBeGreaterThan(9);
    // 12 เดือนก่อน: c 150,000 + d 300,000 · ตอนนี้ d 550,000 → 122.2%
    expect(m.nrrPct).toBe(122.2);
    // กราฟ 12 เดือน: เดือนนี้ = MRR ตอนนี้ · 11 เดือนก่อนมีแค่ c 150,000 + d 300,000
    expect(m.mrrHistory).toHaveLength(12);
    expect(m.mrrHistory[11]).toEqual({ month: r.body.month, mrrSatang: 1_401_000 });
    expect(m.mrrHistory[0].mrrSatang).toBe(450_000);
    expect(r.body.tasks).toMatchObject({ paymentExceptions: 1, invoicesOverdue: 1, approvals: 0, incidentsOpen: 0 });
    const sp = await support.agent.get('/ops/overview');
    expect(sp.body.money).toBeNull();
    expect(sp.body.tasks.paymentExceptions).toBe(1);
  });
});

describe('ธุรกิจและกำไร (Business)', () => {
  let first = '';

  it('กำไรต่อแพ็กเกจ / ลูกค้า · ลูกค้าที่ต้นทุนเกินรายได้ · ส่วนแบ่งค่าเซิร์ฟเวอร์ตามผู้ใช้งาน', async () => {
    const r = await finance.agent.get('/ops/business');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    first = r.body.computedAt;
    expect(r.body).toMatchObject({ mrrSatang: 1_401_000, payingWorkspaces: 4 });
    const siam = r.body.customers.top.find((x: { workspace: { slug: string } }) => x.workspace.slug === 'biz-a');
    // LINE 1,000 × 4 + อีเมล 500 × 1 + ค่าเซิร์ฟเวอร์ 100,000 × 10 / 20 = 54,500
    expect(siam).toMatchObject({ revenueSatang: 300_000, costSatang: 54_500, grossSatang: 245_500 });
    expect(r.body.customers.unprofitable.map((x: { workspace: { slug: string } }) => x.workspace.slug)).toEqual(['biz-e']);
    expect(r.body.margin).toMatchObject({ infraSatang: 100_000, infraMonth: month() });
    expect(r.body.margin.byPlan.map((p: { plan: string }) => p.plan).sort()).toEqual(['team_l', 'team_m', 'team_s']);
  });

  it('funnel · cohort · ช่องทาง CAC · เหตุผลยกเลิก · การใช้ฟีเจอร์ · พร้อมอัปเกรด · ค้างรับ · รับล่วงหน้า · คาดการณ์', async () => {
    const r = (await auditor.agent.get('/ops/business')).body;
    expect(r.funnel).toMatchObject({ windowDays: 90, signups: 5, emailVerified: 1, paid: 5 });
    const cohortA = r.cohorts.find((x: { month: string; customers: number; retention: number[] }) => x.customers === 1 && x.retention.length >= 4);
    expect(cohortA.retention.every((v: number) => v === 100)).toBe(true);
    expect(r.channels.find((x: { source: string }) => x.source === 'google')).toMatchObject({ newPaying: 1, spendSatang: 4_800_000, cacSatang: 4_800_000 });
    expect(r.cancellationReasons).toEqual([{ reason: 'too_expensive', n: 1, kept: 0 }]);
    expect(r.featureAdoption).toEqual([{ feature: 'gantt', workspaces: 1, pct: 25 }]);
    expect(r.upgradeReady.find((x: { workspace: { slug: string } }) => x.workspace.slug === 'biz-a').signals.map((s: { code: string }) => s.code)).toContain('many_guests');
    expect(r.arAging).toMatchObject({ d31_60: 321_000, d0_30: 0, d60plus: 0, notDue: 1_070 });
    expect(r.deferredRevenueSatang).toBeGreaterThan(5_000_000);
    expect(r.forecast).toHaveLength(3);
    expect(r.ltvSatang).toBeGreaterThan(0);
  });

  it('cache: เรียกซ้ำได้ผลเดิม · คำนวณใหม่ได้เฉพาะ Owner / การเงิน · Support เปิดไม่ได้', async () => {
    expect((await finance.agent.get('/ops/business')).body.computedAt).toBe(first);
    expect((await auditor.agent.get('/ops/business?refresh=true')).status).toBe(403);
    const again = await finance.agent.get('/ops/business?refresh=true');
    expect(again.body.computedAt).not.toBe(first);
    expect((await support.agent.get('/ops/business')).status).toBe(403);
  });
});

describe('ตั้งค่าต้นทุน (B9) และค่าการตลาด (B10)', () => {
  it('ต้นทุนต่อหน่วย: ค่าธรรมเนียมเป็น % · อื่นเป็นสตางค์ · ตั้งล่วงหน้าได้ · เปลี่ยนแล้ว cache ถูกล้าง', async () => {
    expect((await finance.agent.put('/ops/costs/rates').send({ rates: [{ resource: 'payment_fee_card', unitCostSatang: 3, effectiveFrom: today() }], reason: 'ผิดชนิด' })).body.error.code).toBe('rate_kind_mismatch');
    const future = new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10);
    const r = await finance.agent.put('/ops/costs/rates').send({
      rates: [{ resource: 'payment_fee_promptpay', pct: 1.65, effectiveFrom: today() }, { resource: 'storage_gb_month', unitCostSatang: 80, effectiveFrom: today() }, { resource: 'line_message', unitCostSatang: 5, effectiveFrom: future }],
      reason: 'ใบแจ้งหนี้ผู้ให้บริการเดือนนี้',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const byRes = Object.fromEntries(r.body.rates.map((x: { resource: string }) => [x.resource, x]));
    expect(byRes.payment_fee_promptpay).toMatchObject({ kind: 'pct', current: { pct: 1.65 } });
    expect(byRes.line_message.current.unitCostSatang).toBe(4);
    expect(byRes.line_message.scheduled).toHaveLength(1);
    expect((await auditor.agent.put('/ops/costs/rates').send({ rates: [{ resource: 'email', unitCostSatang: 1, effectiveFrom: today() }], reason: 'x'.repeat(5) })).status).toBe(403);
    const infra = await owner.agent.put('/ops/costs/infra').send({ month: month(), items: [{ category: 'aws', amountSatang: 200_000 }, { category: 'tools', amountSatang: 50_000 }] });
    expect(infra.body.infra.filter((i: { month: string }) => i.month === month())).toHaveLength(2);
    const after = (await finance.agent.get('/ops/business')).body;
    expect(after.margin.infraSatang).toBe(250_000);
  });

  it('ค่าการตลาดรายเดือนตามช่องทาง · เดือนอนาคตไม่ได้ · ผู้ตรวจอ่านได้ Support ไม่ได้', async () => {
    const next = new Date(Date.now() + 40 * DAY).toISOString().slice(0, 7);
    expect((await finance.agent.put('/ops/marketing-costs').send({ month: next, items: [{ source: 'google', amountSatang: 1 }] })).body.error.code).toBe('month_in_future');
    const r = await finance.agent.put('/ops/marketing-costs').send({ month: month(), items: [{ source: 'Google', amountSatang: 5_000_000, note: 'ดึงได้เมื่อเชื่อม Google Ads' }, { source: 'facebook', amountSatang: 2_200_000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ month: month(), totalSatang: 7_200_000, sources: ['facebook', 'google'] });
    expect((await auditor.agent.get(`/ops/marketing-costs?month=${month()}`)).body.items).toHaveLength(2);
    expect((await support.agent.get('/ops/marketing-costs')).status).toBe(403);
    const log = (await t.owner.query(`SELECT count(*)::int AS n FROM staff_audit_logs WHERE action LIKE 'metrics.%'`)).rows[0].n;
    expect(log).toBe(3);
  });
});
