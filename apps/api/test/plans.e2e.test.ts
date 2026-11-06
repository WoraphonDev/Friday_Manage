// A29 · แพ็กเกจ, ขีดจำกัด (402) และใบเสนอราคา · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../src/common/tenant.js';
import { PlanLimits } from '../src/core/plan-limits.js';
import { addMember, client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;

/** ตั้งแพ็กเกจของ Workspace ตรง ๆ (ข้ามขั้นชำระเงินที่เป็นงาน A33) */
async function setPlan(code: string, patch: { status?: string; trialEndsAt?: string | null; periodEnd?: string } = {}) {
  await team.lead.get(`${team.ws}/usage`); // ให้ระบบสร้าง subscription ก่อน
  await t.owner.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = $2), status = $3,
       trial_ends_at = $4, current_period_end = COALESCE($5::timestamptz, current_period_end)
     WHERE workspace_id = $1`,
    [wsId, code, patch.status ?? 'active', patch.trialEndsAt ?? null, patch.periodEnd ?? null],
  );
}
const project = (suffix: string) => ({ key: `L${suffix}`, name: `Limit ${suffix}`, startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['Demo'] });

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
});
afterAll(() => t.close());

describe('GET w/usage', () => {
  it('Workspace ใหม่ทดลอง Team 14 วัน', async () => {
    const r = await team.lead.get(`${team.ws}/usage`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      plan: { code: 'team_s' },
      status: 'trialing',
      trial: { daysLeft: 14, expired: false },
      seats: { used: 2, limit: 10, over: false },
      projects: { used: 1, limit: null },
      canManageBilling: true,
    });
    const sub = await t.owner.query('SELECT status, cycle FROM subscriptions WHERE workspace_id = $1', [wsId]);
    expect(sub.rows).toEqual([{ status: 'trialing', cycle: 'monthly' }]);
  });

  it('Member เห็น usage แต่ไม่มีปุ่มจัดการแพ็กเกจ · Guest ไม่เห็น', async () => {
    const m = await team.dev.get(`${team.ws}/usage`);
    expect(m.body.canManageBilling).toBe(false);
    const g = await client(t.app);
    const gid = await signup(g, 'guest@plans.example.com', 'Guest');
    await addMember(t.owner, team.slug, gid, 'guest', { key: team.key, role: 'viewer' });
    expect((await g.get(`${team.ws}/usage`)).status).toBe(403);
  });

  it('ทดลองหมดแล้วกลับเป็น Free', async () => {
    await setPlan('team_s', { status: 'trialing', trialEndsAt: '2020-01-01T00:00:00Z' });
    const r = await team.lead.get(`${team.ws}/usage`);
    expect(r.body).toMatchObject({ plan: { code: 'free' }, projects: { limit: 3 }, seats: { limit: 5 } });
    expect(r.body.trial.expired).toBe(true);
  });
});

describe('402 plan_limit_reached', () => {
  it('โปรเจกต์: Free ครบ 3 → ตัวที่ 4 ได้ 402 พร้อมทางออก · Archive แล้วสร้างได้', async () => {
    await setPlan('free');
    expect((await team.lead.post(`${team.ws}/projects`, project('A'))).status).toBe(201);
    expect((await team.lead.post(`${team.ws}/projects`, project('B'))).status).toBe(201);
    const r = await team.lead.post(`${team.ws}/projects`, project('C'));
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('plan_limit_reached');
    expect(r.body.error.details).toMatchObject({ kind: 'projects', limit: 3, current: 3, plan: 'free', suggestedPlan: 'team_s', exits: ['archive_project', 'upgrade'] });
    expect((await team.lead.get(`${team.ws}/projects/LC`)).status).toBe(404);

    expect((await team.lead.post(`${team.ws}/projects/LA/archive`)).status).toBeLessThan(300);
    expect((await team.lead.post(`${team.ws}/projects`, project('C'))).status).toBe(201);
  });

  it('โปรเจกต์: Team ไม่จำกัด', async () => {
    await setPlan('team_s');
    expect((await team.lead.post(`${team.ws}/projects`, project('D'))).status).toBe(201);
    expect((await team.lead.get(`${team.ws}/usage`)).body.projects).toMatchObject({ limit: null, over: false });
  });

  it('สมาชิก: เกินจำนวนที่นั่งตอนตอบรับคำเชิญ → 402 · Guest ไม่นับ', async () => {
    await setPlan('free');
    // มี 2 คนแล้ว เติมถึง 4 แล้วเชิญคนที่ 5 (ผ่าน) และ 6 (ไม่ผ่าน)
    for (const i of [1, 2]) {
      const c = await client(t.app);
      await addMember(t.owner, team.slug, await signup(c, `fill${i}@plans.example.com`, `Fill ${i}`), 'member');
    }
    const accept = async (email: string, role?: string) => {
      const inv = await team.lead.post(`${team.ws}/invitations`, { emails: [email], ...(role ? { workspaceRole: role } : {}) });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const token = inv.body.items[0].inviteUrl.split('/join/')[1];
      const c = await client(t.app);
      await signup(c, email, email.split('@')[0]);
      return c.post(`/invitations/${token}/accept`);
    };
    const fifth = await accept('fifth@plans.example.com');
    expect(fifth.status, JSON.stringify(fifth.body)).toBe(200);
    const sixth = await accept('sixth@plans.example.com');
    expect(sixth.status).toBe(402);
    expect(sixth.body.error.details).toMatchObject({ kind: 'seats', limit: 5, current: 5, plan: 'free', suggestedPlan: 'team_s', exits: ['deactivate_members', 'upgrade'] });

    const guest = await client(t.app);
    const gid = await signup(guest, 'extra.guest@plans.example.com', 'Extra Guest');
    await addMember(t.owner, team.slug, gid, 'guest');
    expect((await team.lead.get(`${team.ws}/usage`)).body.seats).toMatchObject({ used: 5, limit: 5 });
  });

  it('สมาชิก: แนะนำแพ็กเกจเล็กสุดที่พอ (Team S เต็ม 10 → Team M)', async () => {
    await setPlan('team_s');
    await t.owner.query(
      `INSERT INTO users (email, display_name) SELECT 'bulk' || g || '@plans.example.com', 'Bulk ' || g FROM generate_series(1, 5) g`,
    );
    await t.owner.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) SELECT $1, id, 'member' FROM users WHERE email LIKE 'bulk%@plans.example.com'`,
      [wsId],
    );
    const limits = t.app.get(PlanLimits);
    const err = await t.app.get(TenantDb)
      .run({ userId: team.leadId, sessionId: 's' }, { workspaceId: wsId, slug: team.slug, role: 'owner' }, (tx) => limits.assert(tx, wsId, 'seats'))
      .catch((e) => e);
    expect(err.getStatus()).toBe(402);
    expect(err.details).toMatchObject({ kind: 'seats', limit: 10, current: 10, suggestedPlan: 'team_m' });
  });

  it('พื้นที่ไฟล์: Free = 1 GB ต่อคน · เกินพื้นที่ → 402 · Enterprise ไม่จำกัด', async () => {
    await setPlan('free');
    await t.owner.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id IN (SELECT id FROM users WHERE email LIKE $2 OR email LIKE $3)', [wsId, 'bulk%', 'fill%']);
    await t.owner.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id IN (SELECT id FROM users WHERE email LIKE 'fifth%')`, [wsId]);
    const seats = (await team.lead.get(`${team.ws}/usage`)).body.seats.used;
    const capacity = seats * 1024 ** 3;
    const proj = (await t.owner.query('SELECT id FROM projects WHERE workspace_id = $1 AND key = $2', [wsId, team.key])).rows[0].id;
    const file = (await t.owner.query(
      `INSERT INTO files (workspace_id, project_id, name, uploaded_by) VALUES ($1, $2, 'big.bin', $3) RETURNING id`, [wsId, proj, team.leadId],
    )).rows[0].id;
    await t.owner.query(
      `INSERT INTO file_versions (workspace_id, file_id, version_no, storage_key, size_bytes, uploaded_by) VALUES ($1, $2, 1, 'k', $3, $4)`,
      [wsId, file, capacity - 100, team.leadId],
    );
    const limits = t.app.get(PlanLimits);
    const run = (inc: number) =>
      t.app.get(TenantDb).run({ userId: team.leadId, sessionId: 's' }, { workspaceId: wsId, slug: team.slug, role: 'owner' }, (tx) => limits.assert(tx, wsId, 'storage_bytes', inc));
    await expect(run(100)).resolves.toBeUndefined();
    const err = await run(101).catch((e) => e);
    expect(err.getStatus()).toBe(402);
    expect(err.details).toMatchObject({ kind: 'storage_bytes', limit: capacity, current: capacity - 100, increment: 101, exits: ['manage_files', 'upgrade'] });

    await setPlan('enterprise');
    await expect(run(10 ** 12)).resolves.toBeUndefined();
    const u = (await team.lead.get(`${team.ws}/usage`)).body;
    expect(u.storage.limit).toBeNull();
    expect(u.seats.limit).toBeNull();
  });
});

describe('GET w/billing/quote', () => {
  const q = (plan: string, cycle: string, wht = false) => team.lead.get(`${team.ws}/billing/quote?plan=${plan}&cycle=${cycle}&wht=${wht}`);

  it('รายเดือน: VAT 7% จากยอดก่อนภาษี', async () => {
    const r = await q('team_s', 'monthly');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: 'team_s', cycle: 'monthly', subtotal: 150_000, vat: 10_500, total: 160_500, whtAmount: 0, amountDue: 160_500 });
  });

  it('หัก ณ ที่จ่าย 3% จากยอดก่อน VAT · ยอดชำระ = รวม − หัก', async () => {
    const r = await q('team_m', 'monthly', true);
    expect(r.body).toMatchObject({ subtotal: 300_000, vat: 21_000, total: 321_000, whtAmount: 9_000, amountDue: 312_000, wht: true });
  });

  it('รายปีจ่าย 10 เดือน', async () => {
    const r = await q('team_l', 'yearly', true);
    expect(r.body).toMatchObject({ subtotal: 5_500_000, vat: 385_000, total: 5_885_000, whtAmount: 165_000, amountDue: 5_720_000 });
  });

  it('เศษสตางค์ปัดเป็นจำนวนเต็ม', async () => {
    await t.owner.query(`UPDATE plans SET price_monthly_satang = 12_345 WHERE code = 'team_s'`);
    const r = await q('team_s', 'monthly', true);
    expect(r.body).toMatchObject({ subtotal: 12_345, vat: 864, total: 13_209, whtAmount: 370, amountDue: 12_839 });
    await t.owner.query(`UPDATE plans SET price_monthly_satang = NULL WHERE code = 'team_s'`);
  });

  it('แพ็กเกจที่ซื้อออนไลน์ไม่ได้ / พารามิเตอร์ผิด → 400', async () => {
    expect((await q('free', 'monthly')).status).toBe(400);
    expect((await q('enterprise', 'monthly')).status).toBe(400);
    expect((await q('team_s', 'weekly')).status).toBe(400);
  });

  it('Member ดูไม่ได้ (ws.billing)', async () => {
    const r = await team.dev.get(`${team.ws}/billing/quote?plan=team_s`);
    expect(r.status).toBe(403);
    expect(r.body.error.details.permission).toBe('ws.billing');
  });
});

describe('billing profile และ GET w/billing', () => {
  const body = { companyName: 'บริษัท ตัวอย่าง จำกัด', taxId: '0105500000001', address: '1 ถนนตัวอย่าง กรุงเทพฯ 10110', taxEmail: 'Account@Example.com', whtEnabled: true };

  it('ยังไม่มีข้อมูล → profile เป็น null', async () => {
    expect((await team.lead.get(`${team.ws}/billing/profile`)).body).toEqual({ profile: null });
  });

  it('บันทึกและแก้ได้ (1 Workspace = 1 profile) พร้อม Audit', async () => {
    const put = await team.lead.put(`${team.ws}/billing/profile`, body);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.profile).toMatchObject({ companyName: body.companyName, taxId: body.taxId, branchType: 'head', branchNo: null, taxEmail: 'account@example.com', whtEnabled: true });
    const again = await team.lead.put(`${team.ws}/billing/profile`, { ...body, branchType: 'branch', branchNo: '00001' });
    expect(again.body.profile).toMatchObject({ branchType: 'branch', branchNo: '00001' });
    expect((await t.owner.query('SELECT 1 FROM billing_profiles WHERE workspace_id = $1', [wsId])).rowCount).toBe(1);
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'billing.profile_updated'`, [wsId])).rowCount).toBe(2);
    expect((await team.lead.get(`${team.ws}/billing/profile`)).body.profile.taxId).toBe(body.taxId);
  });

  it('ข้อมูลผิดรูปแบบ → 400 · Member แก้ไม่ได้', async () => {
    const bad = await team.lead.put(`${team.ws}/billing/profile`, { ...body, taxId: '123' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields[0].path).toBe('taxId');
    const noBranch = await team.lead.put(`${team.ws}/billing/profile`, { ...body, branchType: 'branch' });
    expect(noBranch.status).toBe(400);
    expect((await team.dev.put(`${team.ws}/billing/profile`, body)).status).toBe(403);
    expect((await team.dev.get(`${team.ws}/billing/profile`)).status).toBe(403);
  });

  it('GET w/billing รวมแพ็กเกจ ใบแจ้งหนี้ และข้อมูลภาษี', async () => {
    await t.owner.query(
      `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, due_date)
       SELECT workspace_id, id, 'INV-TEST-0001', '2026-11-05', '2026-12-04', 150000, 10500, 160500, 160500, '2026-11-12' FROM subscriptions WHERE workspace_id = $1`,
      [wsId],
    );
    const r = await team.lead.get(`${team.ws}/billing`);
    expect(r.status).toBe(200);
    expect(r.body.plan.code).toBe('enterprise');
    expect(r.body.invoices).toMatchObject([{ number: 'INV-TEST-0001', total: 160_500, status: 'open' }]);
    expect(r.body.profile.companyName).toBe(body.companyName);
    expect((await team.dev.get(`${team.ws}/billing`)).status).toBe(403);
  });
});
