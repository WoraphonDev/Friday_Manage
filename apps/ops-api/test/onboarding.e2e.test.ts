// O34 · Onboarding checklist และลูกค้าที่ติดใน Friday Ops · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { progressOf } from '../src/onboarding/onboarding.service.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let support: Staff;
let finance: Staff;
let engineer: Staff;
let auditor: Staff;
let pixel: Customer;
let kanit: Customer;
let done: Customer;
let quiet: Customer;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const q = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows;
const steps = async (ws: Customer, list: [string, Date][]) => {
  for (const [step, at] of list) await q(`INSERT INTO onboarding_progress (workspace_id, step, done_at, meta) VALUES ($1, $2, $3, $4)`, [ws.id, step, at, step === 'issues' ? { count: 46, imported: 46 } : {}]);
};
const member = async (ws: Customer, email: string, lastActive: Date | null, role = 'member') => {
  const u = (await q(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [email, email.split('@')[0]]))[0].id as string;
  await q(`INSERT INTO workspace_members (workspace_id, user_id, role, last_active_at) VALUES ($1, $2, $3, $4)`, [ws.id, u, role, lastActive]);
  return u;
};

beforeAll(async () => {
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Support A', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'eng@friday.example.com', 'Eng', ['engineer']);
  auditor = await staff(t, 'audit@friday.example.com', 'Audi', ['auditor']);

  // Pixel Forge: ทดลองใช้ 9 วัน · ผ่าน 2 ขั้น ติดที่ชวนทีม 5 วัน · คำเชิญค้าง 2
  pixel = await customer(t, 'pixel-forge', { trialDays: 9 });
  await q(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [pixel.id, ago(6)]);
  await steps(pixel, [['first_project', ago(6)], ['issues', ago(5)]]);
  await member(pixel, 'dev@pixel-forge.example.com', ago(1));
  await q(`UPDATE workspace_members SET last_active_at = $2 WHERE user_id = $1`, [pixel.owner, ago(1)]);
  for (const e of ['a@pixel-forge.example.com', 'b@pixel-forge.example.com'])
    await q(`INSERT INTO invitations (workspace_id, email, token_hash, expires_at, invited_by) VALUES ($1, $2, md5($2), now() + interval '7 days', $3)`, [pixel.id, e, pixel.owner]);
  await q(`INSERT INTO workspace_acquisitions (workspace_id, source, medium, via) VALUES ($1, 'blog', 'seo', 'signup')`, [pixel.id]);

  // Kanit Labs: Free · ติดที่งาน ≥ 10 มา 2 วัน (ยังไม่เกิน 3 วัน)
  kanit = await customer(t, 'kanit-labs', { plan: 'free', status: 'active' });
  await q(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [kanit.id, ago(3)]);
  await steps(kanit, [['first_project', ago(2)]]);
  await q(`UPDATE workspace_members SET last_active_at = $2 WHERE user_id = $1`, [kanit.owner, ago(0)]);

  // ครบ 6 ขั้นใน 4 วัน และจ่ายเงินแล้ว
  done = await customer(t, 'done-co', { status: 'active' });
  await q(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [done.id, ago(10)]);
  await steps(done, ['first_project', 'issues', 'team', 'assign_due', 'status_update', 'notifications'].map((k, i) => [k, ago(10 - i * 0.8)] as [string, Date]));
  await q(`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = $1`, [done.id]);
  await q(`INSERT INTO subscription_changes (workspace_id, kind, plan_to, mrr_before_satang, mrr_after_satang, actor_kind, effective_at) VALUES ($1, 'new', 'team_s', 0, 49000, 'user', now())`, [done.id]);

  // ไม่มีใครเข้าเกิน 14 วัน → หยุดใช้
  quiet = await customer(t, 'quiet-co', { plan: 'free', status: 'active' });
  await q(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [quiet.id, ago(25)]);
  await q(`UPDATE workspace_members SET last_active_at = $2 WHERE workspace_id = $1`, [quiet.id, ago(20)]);

  // สร้างนานแล้ว (นอกช่วง 30 วัน)
  const old = await customer(t, 'old-co', { status: 'active' });
  await q(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [old.id, ago(60)]);
});
afterAll(() => t.close());

describe('สิทธิ์', () => {
  it('Owner / Support / การเงิน / ผู้ตรวจ อ่านได้ · วิศวกรไม่เห็น · การเงินและผู้ตรวจแก้ / ส่งอีเมลไม่ได้', async () => {
    for (const st of [owner, support, finance, auditor]) expect((await st.agent.get('/ops/onboarding')).status).toBe(200);
    expect((await engineer.agent.get('/ops/onboarding')).status).toBe(403);
    expect((await engineer.agent.get(`/ops/onboarding/workspaces/${pixel.id}`)).status).toBe(403);
    expect((await finance.agent.put(`/ops/onboarding/workspaces/${pixel.id}/followup`).send({ status: 'open' })).status).toBe(403);
    expect((await auditor.agent.post(`/ops/onboarding/workspaces/${pixel.id}/email`).send({ subject: 'x', body: 'y' })).status).toBe(403);
  });
});

describe('ภาพรวม (บอร์ด 18)', () => {
  it('KPI · แถบผ่านแต่ละขั้น · ข้อสังเกต ของ Workspace ใน 30 วัน', async () => {
    const r = await owner.agent.get('/ops/onboarding?days=30');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body;
    expect(b.kpis).toMatchObject({ newWorkspaces: 4, trial: 1, free: 2, completedPct: 25, stuckOver3: 1, stuckUnassigned: 1 });
    expect(b.kpis.avgDaysToComplete).toBeCloseTo(4, 0);
    expect(b.funnel.map((f: { key: string; pct: number; drop: number | null }) => [f.key, f.pct, f.drop])).toEqual([
      ['first_project', 75, null],
      ['issues', 50, -25],
      ['team', 25, -25],
      ['assign_due', 25, 0],
      ['status_update', 25, 0],
      ['notifications', 25, 0],
    ]);
    // หลุดมากสุดขั้นแรกที่เจอ (งาน ≥ 10) · ผ่านขั้นนี้จ่ายเงิน 50% (1 ใน 2) · ไม่ผ่าน 0%
    expect(b.insights).toEqual({ biggestDrop: { key: 'issues', drop: -25, paidPassedPct: 50, paidOtherPct: 0 }, notificationsPct: 25 });
    expect((await owner.agent.get('/ops/onboarding?days=7')).body.kpis.newWorkspaces).toBe(2);
    expect((await owner.agent.get('/ops/onboarding?days=90')).body.kpis.newWorkspaces).toBe(5);
    expect((await owner.agent.get('/ops/onboarding?days=14')).status).toBe(400);
  });

  it('ลูกค้าที่ติดเรียงตามวันที่ติด · ไม่รวมที่ครบแล้ว · ที่หยุดใช้ย้ายไปอีกรายการ', async () => {
    const b = (await support.agent.get('/ops/onboarding')).body;
    expect(b.stuck.map((x: { slug: string }) => x.slug)).toEqual(['pixel-forge', 'kanit-labs']);
    expect(b.stuck[0]).toMatchObject({ name: 'Co pixel-forge', members: 2, stuckStep: 'team', stuckDays: 5, trialDaysLeft: 9, done: 2, followup: null });
    expect(b.stuck[1]).toMatchObject({ stuckStep: 'issues', stuckDays: 2, trialDaysLeft: null, plan: 'free' });
    expect(b.inactive.map((x: { slug: string }) => x.slug)).toEqual(['quiet-co']);
    expect(b.inactive[0]).toMatchObject({ stuckStep: 'first_project', stuckDays: 25 });
    // ทีม Friday เห็นตัวเลขและชื่อ Workspace เท่านั้น
    expect(JSON.stringify(b)).not.toContain('@');
  });

  it('progressOf: ติดมานับจากขั้นก่อนหน้าที่เสร็จ แม้ทำข้ามขั้น', () => {
    const now = new Date('2026-11-12T00:00:00Z');
    const p = progressOf({ createdAt: new Date('2026-11-01T00:00:00Z'), lastActiveAt: now, steps: { first_project: new Date('2026-11-02T00:00:00Z'), status_update: new Date('2026-11-05T00:00:00Z') } }, now);
    expect(p).toMatchObject({ done: 2, stuckStep: 'issues', stuckDays: 10, complete: false, inactive: false });
  });
});

describe('ติดตาม (V5) และการ์ด (V7)', () => {
  it('รายละเอียด: ลำดับขั้นพร้อมวันที่และตัวเลข · สัญญาณ · Owner · ผู้ติดตามที่เลือกได้', async () => {
    const r = await support.agent.get(`/ops/onboarding/workspaces/${pixel.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body;
    expect(b).toMatchObject({ done: 2, total: 6, complete: false, stuckStep: 'team', stuckDays: 5, inactive: false, followup: null });
    expect(b.workspace).toMatchObject({ name: 'Co pixel-forge', plan: 'team_s', subStatus: 'trialing', trialDaysLeft: 9, members: 2 });
    expect(b.owner).toEqual({ name: 'owner', email: 'owner@pixel-forge.example.com', suppressed: false });
    expect(b.steps[1]).toMatchObject({ key: 'issues', meta: { count: 46, imported: 46 } });
    expect(b.steps[2]).toEqual({ key: 'team', doneAt: null, meta: {} });
    expect(b.signals).toMatchObject({ pendingInvites: 2, acceptedInvites: 0, active7d: 2, openTickets: 0, acquisition: { source: 'blog', medium: 'seo', via: 'signup' } });
    expect(b.assignees.map((a: { name: string }) => a.name)).toEqual(['Olive Owner', 'Support A']);
    expect((await support.agent.get('/ops/onboarding/workspaces/not-a-uuid')).status).toBe(404);
  });

  it('บันทึกอย่างเดียว: ผู้ติดตาม + บันทึกภายใน · ลง Audit ของทีมเท่านั้น (ลูกค้าไม่เห็นบันทึกภายใน)', async () => {
    const r = await support.agent.put(`/ops/onboarding/workspaces/${pixel.id}/followup`).send({ assigneeId: support.id, note: 'ลูกค้านำเข้าแผนแล้ว น่าจะพร้อมจ่าย' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.followup).toMatchObject({ assigneeId: support.id, status: 'open', note: 'ลูกค้านำเข้าแผนแล้ว น่าจะพร้อมจ่าย' });
    expect((await support.agent.put(`/ops/onboarding/workspaces/${pixel.id}/followup`).send({ assigneeId: finance.id })).status).toBe(422);
    expect(await q(`SELECT 1 FROM audit_logs WHERE workspace_id = $1`, [pixel.id])).toEqual([]);
    expect((await q(`SELECT action, workspace_id FROM staff_audit_logs WHERE action = 'ops.onboarding_followup'`))[0]).toEqual({ action: 'ops.onboarding_followup', workspace_id: pixel.id });
    const list = (await owner.agent.get('/ops/onboarding')).body;
    expect(list.kpis.stuckUnassigned).toBe(0);
    expect(list.stuck[0].followup).toMatchObject({ assigneeName: 'Support A', status: 'open' });
  });

  it('ส่งอีเมล: แทนตัวแปร · เข้าคิวส่งของ API ลูกค้า · Audit ลูกค้าและทีม · นับยอดใช้ข้อความสำเร็จรูป · ส่งซ้ำใน 7 วันไม่ได้', async () => {
    const [canned] = await q(`INSERT INTO support_canned_replies (title, body, tag) VALUES ('ชวนทีม: คำเชิญยังไม่ถูกตอบรับ', 'x', 'onboarding') RETURNING id`);
    const r = await support.agent.post(`/ops/onboarding/workspaces/${pixel.id}/email`).send({ subject: 'คำเชิญยังไม่ถูกตอบรับ', body: 'สวัสดีครับ คุณ{ชื่อผู้แจ้ง} ทีม {ชื่อ Workspace} มีงานพร้อมแล้ว', cannedId: canned.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.followup).toMatchObject({ status: 'emailed', emailsSent: 1, assigneeId: support.id });
    const [d] = await q(
      `SELECT d.target_ref, d.status, d.resend_requested_at IS NOT NULL AS queued, n.event_type, n.in_app, n.payload FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE d.workspace_id = $1`,
      [pixel.id],
    );
    expect(d).toMatchObject({ target_ref: 'owner@pixel-forge.example.com', status: 'queued', queued: true, event_type: 'ops.announcement', in_app: false });
    expect(d.payload).toEqual({ title: 'คำเชิญยังไม่ถูกตอบรับ', text: 'สวัสดีครับ คุณowner ทีม Co pixel-forge มีงานพร้อมแล้ว', kind: 'onboarding_followup' });
    expect((await q(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.onboarding_email'`, [pixel.id]))[0].summary).toContain('[Friday Support A]');
    expect((await q(`SELECT uses FROM support_canned_replies WHERE id = $1`, [canned.id]))[0].uses).toBe(1);
    const again = await owner.agent.post(`/ops/onboarding/workspaces/${pixel.id}/email`).send({ subject: 'อีกครั้ง', body: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('email_too_soon');
    const detail = (await owner.agent.get(`/ops/onboarding/workspaces/${pixel.id}`)).body;
    expect(detail.followup).toMatchObject({ status: 'emailed', emailsSent: 1, assigneeName: 'Support A' });
    expect(new Date(detail.followup.nextEmailAt).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
  });

  it('ไม่ส่งถึงอีเมลในรายชื่อไม่ส่ง (O23)', async () => {
    await q(`INSERT INTO email_suppressions (email, reason, workspace_id) VALUES ('OWNER@kanit-labs.example.com', 'complaint', $1)`, [kanit.id]);
    expect((await owner.agent.get(`/ops/onboarding/workspaces/${kanit.id}`)).body.owner.suppressed).toBe(true);
    const r = await owner.agent.post(`/ops/onboarding/workspaces/${kanit.id}/email`).send({ subject: 'ช่วยเริ่มใช้งาน', body: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('email_suppressed');
    expect(await q(`SELECT 1 FROM notification_deliveries WHERE workspace_id = $1`, [kanit.id])).toEqual([]);
  });

  it('การ์ด V7: Workspace ที่ครบแล้วได้ complete = true (หน้าเว็บไม่แสดงการ์ด)', async () => {
    const b = (await finance.agent.get(`/ops/onboarding/workspaces/${done.id}`)).body;
    expect(b).toMatchObject({ complete: true, done: 6, stuckStep: null });
  });
});
