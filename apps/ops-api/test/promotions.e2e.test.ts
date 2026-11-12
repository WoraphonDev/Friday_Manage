// O20 · แพ็กเกจและโปรโมชันในหลังบ้าน: แก้ราคาแบบมีเวอร์ชัน, คูปอง, รายงานจ่ายต่อหลังหมดส่วนลด · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let owner2: Staff;
let finance: Staff;
let support: Staff;
let a: Customer;
let b: Customer;
const DAY = 86_400_000;
const isoDate = (days: number) => new Date(Date.now() + 7 * 3_600_000 + days * DAY).toISOString().slice(0, 10);
const approve = async (by: Staff, id: string) => {
  await reauth(by);
  const r = await by.agent.post(`/ops/approvals/${id}/approve`).send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const staffAudit = async (action: string) => (await t.owner.query(`SELECT reason, approved_by FROM staff_audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows;
const planBody = (over: Record<string, unknown> = {}) => ({ displayName: 'Team M', monthlySatang: 300_000, yearlySatang: null, listed: true, openForSignup: true, existingPolicy: 'grandfather', reason: 'ปรับตามต้นทุน', ...over });
const couponBody = (over: Record<string, unknown> = {}) => ({ code: 'launch20', description: 'เปิดตัว', kind: 'percent', value: 20, duration: 'repeating', durationCycles: 3, planCodes: ['team_s', 'team_m'], maxRedemptions: 100, expiresOn: isoDate(60), newCustomersOnly: true, stackable: false, ...over });
let seq = 0;
async function invoice(ws: Customer, o: { subtotal: number; discount?: number; status?: string; periodEndDays?: number; createdDaysAgo?: number }) {
  return (await t.owner.query(
    `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, discount, vat, total, amount_due, status, due_date, paid_at, created_at)
     VALUES ($1, $2, $3, current_date - 30, current_date + $4::int, $5, $6, 0, $5, $5, $7::invoice_status, current_date, CASE WHEN $7 = 'paid' THEN now() END, now() - make_interval(days => $8)) RETURNING *`,
    [ws.id, ws.sub, `FRI-P${++seq}-${randomUUID().slice(0, 4)}`, o.periodEndDays ?? 0, o.subtotal, o.discount ?? 0, o.status ?? 'paid', o.createdDaysAgo ?? 0],
  )).rows[0];
}

beforeAll(async () => {
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  owner2 = await staff(t, 'owner2@friday.example.com', 'Oscar Owner', ['owner']);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  support = await staff(t, 'support@friday.example.com', 'Sue Support', 'support');
  a = await customer(t, 'promo-a', { plan: 'team_m', status: 'active' });
  b = await customer(t, 'promo-b', { plan: 'team_m', status: 'active' });
  await customer(t, 'promo-c', { plan: 'team_s' });
});
afterAll(() => t.close());

describe('สิทธิ์', () => {
  it('Owner / การเงินเท่านั้น', async () => {
    expect((await support.agent.get('/ops/promotions')).status).toBe(403);
    expect((await support.agent.post('/ops/promotions/coupons').send(couponBody())).status).toBe(403);
    const r = await finance.agent.get('/ops/promotions');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.plans.map((p: { code: string }) => p.code)).toEqual(['free', 'team_s', 'team_m', 'team_l', 'enterprise']);
    expect(r.body.plans.find((p: { code: string }) => p.code === 'team_m')).toMatchObject({ name: 'Team M', monthlySatang: 300_000, yearlySatang: 3_000_000, yearlyCustom: false, customers: 2, priceEditable: true });
    expect(r.body.plans.find((p: { code: string }) => p.code === 'enterprise')).toMatchObject({ monthlySatang: null, priceEditable: false });
    expect(r.body.summary).toEqual({ activeCoupons: 0, discountThisMonthSatang: 0 });
  });
});

describe('P1 แก้ไขแพ็กเกจ', () => {
  it('ต้องแตะ key · แก้ชื่อ / การแสดงผลบันทึกเป็นเวอร์ชันทันที · เปลี่ยนราคาต้องมีคนอนุมัติ · ลูกค้าเดิมผูกราคาเดิม', async () => {
    const noKey = await finance.agent.post('/ops/promotions/plans/team_m').send(planBody({ displayName: 'Team M+' }));
    expect(noKey.status).toBe(401);
    expect(noKey.body.error.code).toBe('reauth_required');
    await reauth(finance);
    expect((await finance.agent.post('/ops/promotions/plans/team_m').send(planBody())).body.error.code).toBe('no_changes');
    expect((await finance.agent.post('/ops/promotions/plans/free').send(planBody({ displayName: 'Free', monthlySatang: 10_000 }))).body.error.code).toBe('price_not_editable');
    expect((await finance.agent.post('/ops/promotions/plans/team_x').send(planBody())).status).toBe(404);

    const named = await finance.agent.post('/ops/promotions/plans/team_m').send(planBody({ displayName: 'Team M+', listed: false }));
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    // ฐานไม่มีเวอร์ชัน: เก็บราคาเดิมเป็นเวอร์ชัน 1 แล้วผูกลูกค้าเดิม
    expect(named.body.version).toBe(2);
    expect((await t.owner.query(`SELECT display_name, listed FROM plans WHERE code = 'team_m'`)).rows[0]).toEqual({ display_name: 'Team M+', listed: false });
    const v1 = (await t.owner.query(`SELECT id FROM plan_price_versions WHERE plan_code = 'team_m' AND version = 1`)).rows[0].id;
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM subscriptions WHERE price_version_id = $1`, [v1])).rows[0].n).toBe(2);

    const price = await finance.agent.post('/ops/promotions/plans/team_m').send(planBody({ displayName: 'Team M+', listed: false, monthlySatang: 350_000, yearlySatang: 3_400_000 }));
    expect(price.status, JSON.stringify(price.body)).toBe(202);
    expect(price.body.pendingApproval.kind).toBe('promotions.plan_price');
    const pending = (await finance.agent.get('/ops/promotions')).body;
    expect(pending.pendingPrices).toHaveLength(1);
    expect(pending.pendingPrices[0]).toMatchObject({ plan: 'team_m', monthlySatang: 350_000, requestedBy: 'Fin Finance' });
    expect((await t.owner.query(`SELECT price_monthly_satang FROM plans WHERE code = 'team_m'`)).rows[0].price_monthly_satang).toBeNull();

    await approve(owner2, price.body.pendingApproval.id);
    expect((await t.owner.query(`SELECT price_monthly_satang, price_yearly_satang FROM plans WHERE code = 'team_m'`)).rows[0]).toEqual({ price_monthly_satang: '350000', price_yearly_satang: '3400000' });
    const after = (await finance.agent.get('/ops/promotions')).body.plans.find((p: { code: string }) => p.code === 'team_m');
    expect(after).toMatchObject({ name: 'Team M+', monthlySatang: 350_000, yearlySatang: 3_400_000, yearlyCustom: true, version: 3, grandfathered: 2, listed: false });
    const log = await staffAudit('promotions.plan_updated');
    expect(log.at(-1).reason).toContain('ลูกค้าเดิมใช้ราคาเดิม');
    expect(log.at(-1).approved_by).toBe(owner2.id);

    const hist = (await finance.agent.get('/ops/promotions/price-history')).body.items;
    expect(hist[0]).toMatchObject({ plan: 'team_m', version: 3, status: 'current', approvedBy: 'Oscar Owner' });
    expect(hist[0].changes).toEqual([
      { field: 'monthly', from: 300_000, to: 350_000 },
      { field: 'yearly', from: 3_000_000, to: 3_400_000 },
    ]);
    expect(hist.find((h: { version: number }) => h.version === 2).changes).toEqual([
      { field: 'name', from: 'Team M', to: 'Team M+' },
      { field: 'listed', from: true, to: false },
    ]);
  });

  it('ลูกค้าเดิมเปลี่ยนตามรอบถัดไป: มีผลหลัง 30 วัน และส่งประกาศถึงลูกค้าเดิมให้อัตโนมัติ', async () => {
    await reauth(owner);
    const r = await owner.agent.post('/ops/promotions/plans/team_m').send(planBody({ displayName: 'Team M+', listed: false, monthlySatang: 380_000, yearlySatang: null, existingPolicy: 'next_cycle' }));
    expect(r.status).toBe(202);
    // ช่วงมี Owner หลายคน: ผู้ขออนุมัติเองไม่ได้
    expect((await owner.agent.post(`/ops/approvals/${r.body.pendingApproval.id}/approve`).send({})).status).toBe(422);
    const done = await approve(owner2, r.body.pendingApproval.id);
    expect(done).toBeTruthy();
    const [v] = (await t.owner.query(`SELECT existing_policy, existing_from - effective_at AS gap FROM plan_price_versions WHERE plan_code = 'team_m' ORDER BY version DESC LIMIT 1`)).rows;
    expect(v.existing_policy).toBe('next_cycle');
    expect(v.gap.days).toBe(30);
    const [ann] = (await t.owner.query(`SELECT id, title, channels, sent_at FROM announcements ORDER BY created_at DESC LIMIT 1`)).rows;
    expect(ann.title).toContain('Team M+');
    expect(ann.channels.sort()).toEqual(['banner', 'email']);
    const targets = (await t.owner.query(`SELECT workspace_id FROM announcement_targets WHERE announcement_id = $1 ORDER BY workspace_id`, [ann.id])).rows.map((x) => x.workspace_id);
    expect(targets.sort()).toEqual([a.id, b.id].sort());
  });
});

describe('คูปอง', () => {
  it('สร้างร่าง · โค้ดซ้ำไม่ได้ · ตรวจกติกาข้ามช่อง · เปิดใช้ต้องแตะ key (ตรวจก่อนบันทึก)', async () => {
    const draft = await finance.agent.post('/ops/promotions/coupons').send(couponBody());
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.coupon).toMatchObject({ code: 'LAUNCH20', status: 'draft', state: 'draft', used: 0, retention: { rate: null }, createdBy: 'Fin Finance' });
    expect((await finance.agent.post('/ops/promotions/coupons').send(couponBody())).body.error.code).toBe('coupon_code_taken');
    const bad = await finance.agent.post('/ops/promotions/coupons').send(couponBody({ code: 'BAD1', kind: 'percent', value: 120, duration: 'repeating', durationCycles: null }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['durationCycles', 'value']);
    expect((await finance.agent.post('/ops/promotions/coupons').send(couponBody({ code: 'FREE1', kind: 'free_months', value: 2, duration: 'repeating', durationCycles: 2 }))).status).toBe(400);

    // หมด 15 นาทีของการแตะ key: ล้าง cookie ด้วยการแตะใหม่ไม่ได้ จึงใช้พนักงานอีกคนที่ยังไม่แตะ
    const fin2 = await staff(t, 'finance2@friday.example.com', 'Fai Finance', 'finance');
    const noKey = await fin2.agent.post('/ops/promotions/coupons').send(couponBody({ code: 'NOKEY1', activate: true }));
    expect(noKey.status).toBe(401);
    expect(noKey.body.error.code).toBe('reauth_required');
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM coupons WHERE code = 'NOKEY1'`)).rows[0].n).toBe(0);
    expect((await fin2.agent.post(`/ops/promotions/coupons/${draft.body.coupon.id}/activate`).send({})).status).toBe(401);
  });

  it('เปิดใช้ภายในวงเงินทันที · เกินวงเงิน / ตลอดไป / ใช้ฟรีต้องให้ Owner อนุมัติ · Audit', async () => {
    await reauth(finance);
    const id = (await t.owner.query(`SELECT id FROM coupons WHERE code = 'LAUNCH20'`)).rows[0].id;
    const on = await finance.agent.post(`/ops/promotions/coupons/${id}/activate`).send({});
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.coupon).toMatchObject({ status: 'active', state: 'active' });
    expect((await finance.agent.post(`/ops/promotions/coupons/${id}/activate`).send({})).body.error.code).toBe('coupon_already_active');

    const big = await finance.agent.post('/ops/promotions/coupons').send(couponBody({ code: 'STARTUP50', value: 50, durationCycles: 12, activate: true }));
    expect(big.status, JSON.stringify(big.body)).toBe(202);
    expect(big.body.coupon).toMatchObject({ status: 'draft', pendingApproval: true });
    expect(big.body.pendingApproval.kind).toBe('promotions.coupon_activate');
    const forever = await finance.agent.post('/ops/promotions/coupons').send(couponBody({ code: 'LOYAL5', value: 5, duration: 'forever', durationCycles: null, activate: true }));
    expect(forever.status).toBe(202);
    const free = await finance.agent.post('/ops/promotions/coupons').send(couponBody({ code: 'EDU-FREE', kind: 'free_months', value: 6, duration: 'once', durationCycles: null, planCodes: ['team_m'], activate: true }));
    expect(free.status).toBe(202);
    await approve(owner2, big.body.pendingApproval.id);
    expect((await t.owner.query(`SELECT status, activated_by FROM coupons WHERE code = 'STARTUP50'`)).rows[0]).toEqual({ status: 'active', activated_by: finance.id });
    const log = await staffAudit('promotions.coupon_activated');
    expect(log.map((l) => l.reason)).toEqual([expect.stringContaining('LAUNCH20 · ลด 20% 3 รอบบิลแรก'), expect.stringContaining('STARTUP50')]);
    expect(log[1].approved_by).toBe(owner2.id);
    expect((await staffAudit('promotions.coupon_created')).length).toBe(4);
  });

  it('คูปองที่เปิดแล้วแก้ได้เฉพาะคำอธิบาย / วันหมดอายุ / จำนวนสิทธิ์ · ร่างแก้ได้ทุกช่อง · ปิดก่อนกำหนดต้องมีเหตุผล', async () => {
    const id = (await t.owner.query(`SELECT id FROM coupons WHERE code = 'LAUNCH20'`)).rows[0].id;
    expect((await finance.agent.patch(`/ops/promotions/coupons/${id}`).send({ value: 30 })).body.error.code).toBe('coupon_locked');
    const exp = await finance.agent.patch(`/ops/promotions/coupons/${id}`).send({ expiresOn: isoDate(90) });
    expect(exp.status, JSON.stringify(exp.body)).toBe(200);
    expect(exp.body.coupon.expiresOn).toBe(isoDate(90));
    expect((await finance.agent.patch(`/ops/promotions/coupons/${id}`).send({ expiresOn: isoDate(-2) })).status).toBe(400);

    const loyal = (await t.owner.query(`SELECT id FROM coupons WHERE code = 'LOYAL5'`)).rows[0].id;
    const edited = await finance.agent.patch(`/ops/promotions/coupons/${loyal}`).send({ code: 'loyal10', value: 10, duration: 'once' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.coupon).toMatchObject({ code: 'LOYAL10', value: 10, duration: 'once', durationCycles: null });

    expect((await finance.agent.post(`/ops/promotions/coupons/${id}/disable`).send({ reason: 'x' })).status).toBe(400);
    const off = await finance.agent.post(`/ops/promotions/coupons/${id}/disable`).send({ reason: 'ปิดโปรเปิดตัวก่อนกำหนด' });
    expect(off.status).toBe(200);
    expect(off.body.coupon).toMatchObject({ status: 'disabled', state: 'disabled', disableReason: 'ปิดโปรเปิดตัวก่อนกำหนด' });
    expect((await finance.agent.post(`/ops/promotions/coupons/${id}/disable`).send({ reason: 'ซ้ำอีกครั้ง' })).body.error.code).toBe('coupon_not_active');
    // เปิดกลับได้ (แตะ key อยู่แล้ว)
    expect((await finance.agent.post(`/ops/promotions/coupons/${id}/activate`).send({})).status).toBe(200);
  });

  it('ยืนยันสลิปในหลังบ้านนับรอบของคูปอง · รายงานลูกค้าที่จ่ายต่อหลังหมดส่วนลด · ส่วนลดที่ให้ไปเดือนนี้', async () => {
    const id = (await t.owner.query(`SELECT id FROM coupons WHERE code = 'STARTUP50'`)).rows[0].id;
    // a: ใช้คูปองครบ (1 รอบ) แล้วจ่ายราคาปกติต่อ → จ่ายต่อ
    const ra = (await t.owner.query(`INSERT INTO coupon_redemptions (workspace_id, coupon_id, cycles_total) VALUES ($1, $2, 1) RETURNING id`, [a.id, id])).rows[0].id;
    const ia = await invoice(a, { subtotal: 150_000, discount: 150_000, status: 'open', periodEndDays: -3, createdDaysAgo: 40 });
    await t.owner.query(`INSERT INTO coupon_uses (workspace_id, redemption_id, coupon_id, invoice_id, amount) VALUES ($1, $2, $3, $4, 150000)`, [a.id, ra, id, ia.id]);
    const pay = (await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, status, slip_file_key) VALUES ($1, $2, 'transfer', 150000, 'pending_review', 'slips/x.png') RETURNING id`, [a.id, ia.id])).rows[0].id;
    const ok = await finance.agent.post(`/ops/payments/${pay}/confirm`).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await t.owner.query(`SELECT status, ended_at IS NOT NULL AS ended FROM coupon_redemptions WHERE id = $1`, [ra])).rows[0]).toEqual({ status: 'ended', ended: true });
    await invoice(a, { subtotal: 300_000, periodEndDays: 27 });
    // b: ใช้ครบแล้ว รอบสุดท้ายจบไปแล้วแต่ไม่จ่ายต่อ
    const rb = (await t.owner.query(`INSERT INTO coupon_redemptions (workspace_id, coupon_id, cycles_total, status, ended_at) VALUES ($1, $2, 1, 'ended', now()) RETURNING id`, [b.id, id])).rows[0].id;
    const ib = await invoice(b, { subtotal: 150_000, discount: 150_000, periodEndDays: -2, createdDaysAgo: 35 });
    await t.owner.query(`INSERT INTO coupon_uses (workspace_id, redemption_id, coupon_id, invoice_id, amount, status, paid_at) VALUES ($1, $2, $3, $4, 150000, 'paid', now())`, [b.id, rb, id, ib.id]);

    const o = (await finance.agent.get('/ops/promotions')).body;
    const c = o.coupons.find((x: { code: string }) => x.code === 'STARTUP50');
    expect(c).toMatchObject({ used: 2, discountGivenSatang: 300_000, retention: { ended: 2, eligible: 2, kept: 1, rate: 0.5 } });
    expect(o.summary.discountThisMonthSatang).toBe(300_000);
    expect(o.summary.activeCoupons).toBe(2);

    const list = (await finance.agent.get(`/ops/promotions/coupons/${id}/redemptions`)).body.items;
    expect(list.map((r: { workspace: { slug: string }; keptPaying: boolean; cyclesUsed: number }) => [r.workspace.slug, r.keptPaying, r.cyclesUsed]).sort()).toEqual([
      ['promo-a', true, 1],
      ['promo-b', false, 1],
    ]);
    expect((await finance.agent.get(`/ops/promotions/coupons/not-a-uuid/redemptions`)).status).toBe(404);
  });
});
