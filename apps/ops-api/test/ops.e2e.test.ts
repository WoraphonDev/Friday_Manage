// A32 · หลังบ้านทีม Friday · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signEnrollToken } from '../src/auth/auth.service.js';
import { signToken } from './token.js';
import { Mailer } from '../src/mail.js';
import { SoftKey } from './authenticator.js';
import { customer, type Customer, signIn, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let admin: Staff;
let support: Staff;
let finance: Staff;
let mail: Mailer;
const uploadRoot = resolve(process.env.UPLOAD_DIR ?? '../api/var/uploads');

const audit = async (ws: string, action: string) => (await t.owner.query(`SELECT actor_kind, actor_id, category, summary FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at`, [ws, action])).rows;

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  admin = await staff(t, 'admin@friday.example.com', 'Ada Admin', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
});
afterAll(() => t.close());

describe('ล็อกอินด้วย Security key (WebAuthn)', () => {
  it('ไม่มี session → 401 ทุก endpoint (ยกเว้น ops/auth/*)', async () => {
    const anon = request.agent(t.app.getHttpServer());
    for (const u of ['/ops/metrics', '/ops/workspaces', '/ops/payments', '/ops/feature-flags', '/ops/announcements', '/ops/support-sessions', '/ops/auth/me']) expect((await anon.get(u)).status, u).toBe(401);
    expect((await anon.post('/ops/workspaces/x/suspend').send({})).status).toBe(401);
  });

  it('ลงทะเบียน key ด้วยโทเค็นเท่านั้น · key ซ้ำ / challenge ผิด / origin ผิด ถูกปฏิเสธ', async () => {
    const row = await t.owner.query(`INSERT INTO staff_users (email, name, role) VALUES ('new@friday.example.com', 'New', 'support') RETURNING id`);
    const id = row.rows[0].id;
    const agent = request.agent(t.app.getHttpServer());
    expect((await agent.post('/ops/auth/register/options').send({})).status).toBe(401);
    expect((await agent.post('/ops/auth/register/options').send({ enrollToken: 'garbage.token' })).status).toBe(401);
    expect((await agent.post('/ops/auth/register/options').send({ enrollToken: signToken('ops-enroll', { sid: id }, -10) })).status).toBe(401); // หมดอายุ
    expect((await agent.post('/ops/auth/register/options').send({ enrollToken: signToken('ops-session', { sid: id }, 60) })).status).toBe(401); // ใช้ข้าม purpose ไม่ได้

    const key = new SoftKey();
    const o = await agent.post('/ops/auth/register/options').send({ enrollToken: signEnrollToken(id) });
    expect(o.status).toBe(200);
    expect(o.body.options).toMatchObject({ rp: { id: 'localhost' }, attestation: 'none' });
    expect((await agent.post('/ops/auth/register/verify').send({ challengeToken: o.body.challengeToken, response: key.register({ challenge: 'AAAA' }) })).status).toBe(400);
    expect((await agent.post('/ops/auth/register/verify').send({ challengeToken: o.body.challengeToken, response: key.register(o.body.options, { origin: 'https://evil.example.com' }) })).status).toBe(400);
    expect((await agent.post('/ops/auth/register/verify').send({ challengeToken: 'bad', response: {} })).status).toBe(400);
    const ok = await agent.post('/ops/auth/register/verify').send({ challengeToken: o.body.challengeToken, response: key.register(o.body.options), name: 'YubiKey 5' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ registered: true, keys: 1 });
    const again = await agent.post('/ops/auth/register/verify').send({ challengeToken: o.body.challengeToken, response: key.register(o.body.options) });
    expect(again.status).toBe(409); // key เดิมลงทะเบียนซ้ำไม่ได้
    const stored = (await t.owner.query(`SELECT webauthn_credentials AS c FROM staff_users WHERE id = $1`, [id])).rows[0].c;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'YubiKey 5', counter: 0 });
    expect(stored[0].publicKey).toBeTruthy();
  });

  it('login: ตั้ง cookie HttpOnly + SameSite=Strict · key ผิด / counter ย้อน (โคลน) / challenge เก่า ถูกปฏิเสธ', async () => {
    const agent = request.agent(t.app.getHttpServer());
    const key = admin.key;
    const o = await agent.post('/ops/auth/login/options').send({ email: admin.email });
    expect(o.body.options.allowCredentials).toHaveLength(1);
    const assertion = key.assert(o.body.options);
    const ok = await agent.post('/ops/auth/login/verify').send({ challengeToken: o.body.challengeToken, response: assertion });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.staff).toMatchObject({ email: admin.email, role: 'admin' });
    const cookie = (ok.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('fm_ops='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect((await agent.get('/ops/auth/me')).body.staff).toMatchObject({ email: admin.email });

    // เล่นซ้ำคำตอบเดิม (counter เท่าเดิม) → ไม่ผ่าน
    const replay = await request.agent(t.app.getHttpServer()).post('/ops/auth/login/verify').send({ challengeToken: o.body.challengeToken, response: assertion });
    expect(replay.status).toBe(401);
    // key ที่ไม่ได้ลงทะเบียน
    const rogue = new SoftKey();
    const o2 = await request.agent(t.app.getHttpServer()).post('/ops/auth/login/options').send({ email: admin.email });
    expect((await request.agent(t.app.getHttpServer()).post('/ops/auth/login/verify').send({ challengeToken: o2.body.challengeToken, response: rogue.assert(o2.body.options) })).status).toBe(401);
    // challenge ไม่ตรงกับที่เซ็นในโทเค็น
    const o3 = await request.agent(t.app.getHttpServer()).post('/ops/auth/login/options').send({ email: admin.email });
    expect((await request.agent(t.app.getHttpServer()).post('/ops/auth/login/verify').send({ challengeToken: o3.body.challengeToken, response: key.assert({ challenge: 'AAAAAAAAAAAAAAAAAAAAAA' }) })).status).toBe(401);
    // origin ของหน้าต่างอื่น
    const o4 = await request.agent(t.app.getHttpServer()).post('/ops/auth/login/options').send({ email: admin.email });
    expect((await request.agent(t.app.getHttpServer()).post('/ops/auth/login/verify').send({ challengeToken: o4.body.challengeToken, response: key.assert(o4.body.options, { origin: 'https://phish.example.com' }) })).status).toBe(401);
    // อีเมลที่ไม่มี: ได้ options หน้าตาเดียวกัน (ไม่เผยว่ามีพนักงานคนนี้) แต่ล็อกอินไม่ได้
    const ghost = await request.agent(t.app.getHttpServer()).post('/ops/auth/login/options').send({ email: 'ghost@friday.example.com' });
    expect(ghost.status).toBe(200);
    expect((await request.agent(t.app.getHttpServer()).post('/ops/auth/login/verify').send({ challengeToken: ghost.body.challengeToken, response: rogue.assert(ghost.body.options) })).status).toBe(401);
  });

  it('session: cookie ถูกแก้ → 401 · พนักงานถูกลบ → 401 · logout ล้าง cookie · Origin แปลกกับคำขอเขียน → 403', async () => {
    const tmp = await staff(t, 'tmp@friday.example.com', 'Tmp', 'support');
    expect((await tmp.agent.get('/ops/metrics')).status).toBe(200);
    const forged = request.agent(t.app.getHttpServer());
    expect((await forged.get('/ops/metrics').set('Cookie', 'fm_ops=eyJzaWQiOiJ4In0.AAAA')).status).toBe(401);
    expect((await tmp.agent.post('/ops/support-sessions/x/end').set('Origin', 'https://evil.example.com').send({})).status).toBe(403);
    expect((await tmp.agent.post('/ops/auth/logout').send({})).status).toBe(200);
    expect((await tmp.agent.get('/ops/metrics')).status).toBe(401);
    const again = await signIn(tmp.agent, tmp.email, tmp.key);
    expect(again.status).toBe(200);
    await t.owner.query(`DELETE FROM staff_users WHERE id = $1`, [tmp.id]);
    expect((await tmp.agent.get('/ops/metrics')).status).toBe(401); // ตรวจกับฐานข้อมูลทุกครั้ง
  });

  it('บทบาท: support / finance ทำได้เฉพาะหมวดของตน · admin ทำได้ทุกอย่าง', async () => {
    const c = await customer(t, 'roles');
    const body = { reason: 'ทดสอบสิทธิ์ของบทบาท' };
    expect((await support.agent.post(`/ops/workspaces/${c.id}/suspend`).send(body)).status).toBe(403);
    expect((await finance.agent.post(`/ops/workspaces/${c.id}/suspend`).send(body)).status).toBe(403);
    expect((await support.agent.get('/ops/payments')).status).toBe(403);
    expect((await finance.agent.get('/ops/support-sessions')).status).toBe(403);
    expect((await support.agent.get('/ops/feature-flags')).status).toBe(403);
    expect((await finance.agent.post(`/ops/workspaces/${c.id}/change-plan`).send({ plan: 'team_m', reason: 'ตกลงในสัญญา' })).status).toBe(200);
    expect((await admin.agent.post(`/ops/workspaces/${c.id}/suspend`).send(body)).status).toBe(200);
    expect((await admin.agent.get('/ops/payments')).status).toBe(200);
    expect((await support.agent.get('/ops/workspaces')).status).toBe(200);
  });
});

describe('ตัวเลขและรายการ Workspace', () => {
  let a: Customer;
  let b: Customer;

  it('metrics: MRR จากใบแจ้งหนี้ที่ชำระแล้วล่าสุด (รายปีหาร 12) · ทดลอง · ยกเลิก · รอตรวจ', async () => {
    await t.owner.query('DELETE FROM subscriptions');
    a = await customer(t, 'paid-monthly', { plan: 'team_m', status: 'active', cycle: 'monthly' });
    b = await customer(t, 'paid-yearly', { plan: 'team_s', status: 'active', cycle: 'yearly' });
    await customer(t, 'on-trial', { status: 'trialing' });
    await customer(t, 'gone', { status: 'canceled' });
    const inv = async (c: Customer, subtotal: number, status: string, n: string) =>
      (await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date) VALUES ($1,$2,$3,current_date,current_date + 30,$4,0,$4,$4,$5,current_date) RETURNING id`, [c.id, c.sub, n, subtotal, status])).rows[0].id as string;
    await inv(a, 300_000, 'paid', 'FRI-T-0001');
    await inv(a, 999_999, 'open', 'FRI-T-0002'); // ยังไม่ชำระ ไม่นับ
    const yearly = await inv(b, 3_000_000, 'pending_review', 'FRI-T-0003');
    await t.owner.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [yearly]);
    const pend = await inv(b, 100, 'pending_review', 'FRI-T-0004');
    await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount) VALUES ($1, $2, 'transfer', 100)`, [b.id, pend]);
    const m = await support.agent.get('/ops/metrics');
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ mrr: 300_000 + 250_000, payingWorkspaces: 2, trialing: 1, canceledLast30Days: 1, pendingPayments: 1, workspaces: 5 });
    expect(m.body.byPlan).toMatchObject({ team_m: 1, team_s: 3 });
  });

  it('รายการ Workspace กรองตามแพ็กเกจ / สถานะ / ชื่อ · รายละเอียดมี owner, การใช้งาน, grant, session, ใบแจ้งหนี้', async () => {
    const all = await support.agent.get('/ops/workspaces');
    expect(all.body.items).toHaveLength(5);
    expect(all.body.items[0]).toHaveProperty('seats');
    expect((await support.agent.get('/ops/workspaces?plan=team_m')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['paid-monthly']);
    expect((await support.agent.get('/ops/workspaces?status=canceled')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['gone']);
    expect((await support.agent.get('/ops/workspaces?q=YEARLY')).body.items).toHaveLength(1);
    expect((await support.agent.get('/ops/workspaces?plan=nope')).status).toBe(400);
    const d = await support.agent.get(`/ops/workspaces/${a.id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ slug: 'paid-monthly', subscription: { plan: 'team_m', status: 'active' }, usage: { members: 1, projects: 0 }, owners: [{ role: 'owner' }], supportAccess: null, supportSessions: [] });
    expect(d.body.invoices).toHaveLength(2);
    expect((await support.agent.get(`/ops/workspaces/${randomUUID()}`)).status).toBe(404);
    expect((await support.agent.get('/ops/workspaces/not-a-uuid')).status).toBe(404);
  });
});

describe('เข้าช่วยเหลือบัญชีลูกค้า (support session)', () => {
  let c: Customer;
  const base = { ticketNo: '#4702', reason: 'ลูกค้าแจ้งกู้งานที่ลบโดยไม่ตั้งใจ' };
  let sessionId = '';

  it('ต้องมี grant จากลูกค้า · ตรวจเหตุผล · โหมดแก้ไขต้องมีผู้อนุมัติคนที่ 2 และ grant ระดับ write', async () => {
    c = await customer(t, 'help-me', { admins: ['admin@help-me.example.com'] });
    const url = `/ops/workspaces/${c.id}/support-sessions`;
    const none = await support.agent.post(url).send(base);
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('support_access_not_granted');

    await t.owner.query(`INSERT INTO support_access_grants (workspace_id, granted_by, until, max_mode, notify_admins) VALUES ($1, $2, now() - interval '1 hour', 'read', true)`, [c.id, c.owner]);
    expect((await support.agent.post(url).send(base)).body.error.code).toBe('support_access_not_granted'); // หมดอายุ
    await t.owner.query(`UPDATE support_access_grants SET until = NULL WHERE workspace_id = $1`, [c.id]);

    expect((await support.agent.post(url).send({ ...base, reason: 'สั้น' })).status).toBe(400);
    expect((await support.agent.post(url).send({ ticketNo: '', reason: base.reason })).status).toBe(400);
    expect((await support.agent.post(url).send({ ...base, mode: 'root' })).status).toBe(400);
    const w = await support.agent.post(url).send({ ...base, mode: 'write', secondApproverId: admin.id });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe('support_mode_not_allowed');

    await t.owner.query(`UPDATE support_access_grants SET max_mode = 'write' WHERE workspace_id = $1`, [c.id]);
    expect((await support.agent.post(url).send({ ...base, mode: 'write' })).body.error.code).toBe('second_approver_required');
    expect((await support.agent.post(url).send({ ...base, mode: 'write', secondApproverId: support.id })).body.error.code).toBe('second_approver_must_differ');
    expect((await support.agent.post(url).send({ ...base, mode: 'write', secondApproverId: randomUUID() })).body.error.code).toBe('second_approver_invalid');
    expect((await finance.agent.post(url).send(base)).status).toBe(403); // บทบาท finance
    expect((await support.agent.post(`/ops/workspaces/${randomUUID()}/support-sessions`).send(base)).status).toBe(404);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM support_sessions`)).rows[0].n).toBe(0);
  });

  it('เริ่ม session → บันทึก + Audit ของ Workspace + อีเมลแจ้ง Owner/Admin ทันที · เปิดซ้ำไม่ได้ · จบได้ครั้งเดียว', async () => {
    const before = mail.sent.length;
    const r = await support.agent.post(`/ops/workspaces/${c.id}/support-sessions`).send(base);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ session: { ticketNo: '#4702', mode: 'read', staffId: support.id, endedAt: null }, notified: 2 });
    sessionId = r.body.session.id;
    const sent = mail.sent.slice(before);
    expect(sent.map((m) => m.to).sort()).toEqual(['admin@help-me.example.com', 'owner@help-me.example.com']);
    expect(sent[0].subject).toContain('#4702');
    expect(sent[0].text).toContain('อ่านอย่างเดียว');
    const log = await audit(c.id, 'support.session_started');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_kind: 'friday_staff', actor_id: support.id, category: 'secu' });
    expect(log[0].summary).toContain('Sam Support');
    expect(log[0].summary).toContain('#4702');
    expect((await support.agent.post(`/ops/workspaces/${c.id}/support-sessions`).send(base)).body.error.code).toBe('session_already_open');
    expect((await support.agent.get('/ops/support-sessions')).body.items).toEqual([expect.objectContaining({ id: sessionId, staffName: 'Sam Support', workspace: { name: 'Co help-me', slug: 'help-me' } })]);

    expect((await finance.agent.post(`/ops/support-sessions/${sessionId}:end`).send({})).status).toBe(403);
    const other = await staff(t, 'support2@friday.example.com', 'Sue Support', 'support');
    expect((await other.agent.post(`/ops/support-sessions/${sessionId}/end`).send({})).status).toBe(403); // ไม่ใช่เจ้าของ session
    const end = await support.agent.post(`/ops/support-sessions/${sessionId}:end`).send({});
    expect(end.status).toBe(200);
    expect(end.body.session.endedAt).not.toBeNull();
    expect((await support.agent.post(`/ops/support-sessions/${sessionId}:end`).send({})).body.error.code).toBe('session_ended');
    expect(await audit(c.id, 'support.session_ended')).toHaveLength(1);
    expect((await support.agent.get('/ops/support-sessions')).body.items).toEqual([]);
    expect((await admin.agent.get(`/ops/workspaces/${c.id}`)).body.supportSessions).toHaveLength(1);
  });

  it('โหมดแก้ไข: ผู้อนุมัติคนที่ 2 ถูกบันทึก · ลูกค้าปิดแจ้งเตือนอีเมลได้ แต่ Audit ยังมี · Admin จบ session ของคนอื่นได้', async () => {
    await t.owner.query(`UPDATE support_access_grants SET notify_admins = false WHERE workspace_id = $1`, [c.id]);
    const before = mail.sent.length;
    const r = await support.agent.post(`/ops/workspaces/${c.id}/support-sessions`).send({ ...base, ticketNo: 'ZD-1234', mode: 'write', secondApproverId: admin.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ session: { mode: 'write', secondApproverId: admin.id }, notified: 0 });
    expect(mail.sent.length).toBe(before);
    expect(await audit(c.id, 'support.session_started')).toHaveLength(2);
    expect((await admin.agent.post(`/ops/support-sessions/${r.body.session.id}:end`).send({})).status).toBe(200);
  });
});

describe('แพ็กเกจและสถานะ Workspace', () => {
  it('ต่อช่วงทดลอง · ส่วนลด · เปลี่ยนแพ็กเกจ · ระงับ / เปิด — ทุกข้อเขียน Audit ของ Workspace', async () => {
    const c = await customer(t, 'plan-ops', { status: 'trialing', trialDays: 3 });
    const before = (await t.owner.query(`SELECT trial_ends_at FROM subscriptions WHERE id = $1`, [c.sub])).rows[0].trial_ends_at as Date;
    const x = await support.agent.post(`/ops/workspaces/${c.id}:extend-trial`).send({ days: 7, reason: 'รอผลจัดซื้อของลูกค้า' });
    expect(x.status, JSON.stringify(x.body)).toBe(200);
    expect(new Date(x.body.trialEndsAt).getTime() - before.getTime()).toBe(7 * 86_400_000);
    expect((await support.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 0, reason: 'x' })).status).toBe(400);
    expect((await support.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 99, reason: 'เกินกำหนดต่อได้' })).status).toBe(400);
    expect((await audit(c.id, 'ops.trial_extended'))[0]).toMatchObject({ actor_kind: 'friday_staff', category: 'plan' });

    expect((await support.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 10, reason: 'ลูกค้าเก่า' })).status).toBe(403);
    const d = await finance.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 15, months: 6, reason: 'โปรโมชันปีแรก' });
    expect(d.body.discount).toMatchObject({ percent: 15, months: 6, setBy: finance.id });
    expect((await t.owner.query(`SELECT discount FROM subscriptions WHERE id = $1`, [c.sub])).rows[0].discount.percent).toBe(15);
    expect((await finance.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 120, reason: 'เกิน' })).status).toBe(400);

    const cp = await finance.agent.post(`/ops/workspaces/${c.id}:change-plan`).send({ plan: 'enterprise', reason: 'ตามสัญญา ENT-2026-01' });
    expect(cp.body).toEqual({ plan: 'enterprise', previous: 'team_s' });
    expect(await t.owner.query(`SELECT p.code, s.status FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`, [c.sub]).then((r) => r.rows[0])).toEqual({ code: 'enterprise', status: 'active' });
    expect((await finance.agent.post(`/ops/workspaces/${c.id}:change-plan`).send({ plan: 'platinum', reason: 'ไม่มีแพ็กเกจนี้' })).status).toBe(400);
    expect((await support.agent.post(`/ops/workspaces/${c.id}:extend-trial`).send({ days: 3, reason: 'หลังเปลี่ยนเป็น active' })).body.error.code).toBe('not_trialing');

    const sus = await admin.agent.post(`/ops/workspaces/${c.id}:suspend`).send({ reason: 'ผิดข้อตกลงการใช้งาน' });
    expect(sus.body).toEqual({ id: c.id, status: 'suspended' });
    expect((await admin.agent.post(`/ops/workspaces/${c.id}:suspend`).send({ reason: 'ซ้ำอีกรอบ' })).body.error.code).toBe('no_change');
    expect((await admin.agent.get(`/ops/workspaces?status=suspended`)).body.items.map((x: { slug: string }) => x.slug)).toContain('plan-ops');
    expect((await admin.agent.post(`/ops/workspaces/${c.id}:resume`).send({ reason: 'แก้ปัญหาแล้ว' })).body.status).toBe('active');
    for (const a of ['ops.discount_set', 'ops.plan_changed', 'ops.workspace_suspended', 'ops.workspace_resumed']) expect((await audit(c.id, a)).length, a).toBe(1);
    await t.owner.query(`UPDATE workspaces SET status = 'pending_delete', deleted_at = now() WHERE id = $1`, [c.id]);
    expect((await admin.agent.post(`/ops/workspaces/${c.id}:suspend`).send({ reason: 'ลบไปแล้ว' })).body.error.code).toBe('workspace_deleted');
  });
});

describe('ตรวจสลิปและ 50 ทวิ', () => {
  async function pending(slug: string, opts: { slip?: boolean; activated?: boolean } = {}) {
    const c = await customer(t, slug, { status: 'trialing', admins: [`admin@${slug}.example.com`] });
    const inv = (await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, wht_amount, amount_due, status, due_date) VALUES ($1,$2,$3,current_date,current_date + 29,550000,38500,588500,16500,572000,'pending_review',current_date + 7) RETURNING *, to_char(period_start, 'YYYY-MM-DD') AS ps`, [c.id, c.sub, `FRI-${slug}-1`])).rows[0];
    const slipKey = `slips/${inv.id}-${randomUUID()}.png`;
    if (opts.slip !== false) {
      await mkdir(dirname(join(uploadRoot, slipKey)), { recursive: true });
      await writeFile(join(uploadRoot, slipKey), Buffer.from('fake slip bytes'));
    }
    const pay = (await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, slip_file_key) VALUES ($1,$2,'transfer',572000,$3) RETURNING id`, [c.id, inv.id, opts.slip === false ? null : slipKey])).rows[0].id as string;
    await t.owner.query(`INSERT INTO audit_logs (workspace_id, actor_kind, category, action, target_type, target_id, summary) VALUES ($1,'user','plan','billing.checkout','invoice',$2,$3)`, [c.id, inv.id, JSON.stringify({ plan: 'team_l', cycle: 'monthly', method: 'transfer', wht: true, key: 'k', payload: 'p' })]);
    if (opts.activated) {
      const plan = (await t.owner.query(`SELECT id FROM plans WHERE code = 'team_l'`)).rows[0].id;
      await t.owner.query(`UPDATE subscriptions SET plan_id = $2, status = 'active', trial_ends_at = NULL, current_period_start = $3, current_period_end = now() + interval '30 days' WHERE id = $1`, [c.sub, plan, new Date(`${inv.ps}T00:00:00+07:00`)]);
    }
    return { c, inv, pay };
  }

  it('รายการรอตรวจ + ดาวน์โหลดสลิป · เฉพาะ finance / admin', async () => {
    const p = await pending('review-me');
    await t.owner.query(`INSERT INTO wht_certificates (workspace_id, invoice_id, file_key, uploaded_by) VALUES ($1,$2,'wht/x.pdf',$3)`, [p.c.id, p.inv.id, p.c.owner]);
    const list = await finance.agent.get('/ops/payments?status=pending_review');
    expect(list.status).toBe(200);
    const mine = list.body.items.find((x: { id: string }) => x.id === p.pay);
    expect(mine).toMatchObject({ method: 'transfer', amount: 572000, hasSlip: true, status: 'pending_review', invoice: { number: 'FRI-review-me-1', whtAmount: 16500 }, workspace: { slug: 'review-me' }, whtCertificates: [{ status: 'pending_review' }] });
    expect((await finance.agent.get('/ops/payments?status=bogus')).status).toBe(400);
    const file = await finance.agent.get(`/ops/payments/${p.pay}/slip`).buffer(true).parse((r, cb) => { const ch: Buffer[] = []; r.on('data', (x: Buffer) => ch.push(x)); r.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(file.status).toBe(200);
    expect((file.body as Buffer).toString()).toBe('fake slip bytes');
    expect((await support.agent.get(`/ops/payments/${p.pay}/slip`)).status).toBe(403);
    const none = await pending('no-slip', { slip: false });
    expect((await finance.agent.get(`/ops/payments/${none.pay}/slip`)).status).toBe(404);
    expect((await finance.agent.get(`/ops/payments/${randomUUID()}/slip`)).status).toBe(404);
  });

  it('ยืนยัน → ชำระแล้ว + เปิดแพ็กเกจตามที่สั่งซื้อ + สร้างใบกำกับภาษี + Audit · ยืนยันซ้ำไม่ได้', async () => {
    const p = await pending('confirm-me');
    const r = await finance.agent.post(`/ops/payments/${p.pay}:confirm`).send({ note: 'ตรวจกับ statement แล้ว' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'confirmed', invoice: 'FRI-confirm-me-1' });
    expect((await t.owner.query(`SELECT status, reviewed_by FROM payments WHERE id = $1`, [p.pay])).rows[0]).toEqual({ status: 'confirmed', reviewed_by: finance.id });
    expect((await t.owner.query(`SELECT status, paid_at FROM invoices WHERE id = $1`, [p.inv.id])).rows[0].status).toBe('paid');
    expect((await t.owner.query(`SELECT p.code, s.status, s.payment_method FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`, [p.c.sub])).rows[0]).toEqual({ code: 'team_l', status: 'active', payment_method: 'transfer' });
    expect((await t.owner.query(`SELECT doc_type, status, number FROM tax_documents WHERE invoice_id = $1`, [p.inv.id])).rows).toEqual([{ doc_type: 'tax_invoice_receipt', status: 'pending', number: 'TX-confirm-me-1' }]);
    expect((await audit(p.c.id, 'ops.payment_confirmed'))[0]).toMatchObject({ actor_kind: 'friday_staff', actor_id: finance.id });
    expect((await finance.agent.post(`/ops/payments/${p.pay}:confirm`).send({})).body.error.code).toBe('already_confirmed');
    expect((await finance.agent.post(`/ops/payments/${p.pay}:reject`).send({ reason: 'ยืนยันไปแล้ว' })).body.error.code).toBe('already_confirmed');
  });

  it('ปฏิเสธ → ใบแจ้งหนี้กลับเป็น open · เลิกสิทธิ์แพ็กเกจที่เปิดชั่วคราว · อีเมลแจ้ง Owner/Admin พร้อมเหตุผล', async () => {
    const p = await pending('reject-me', { activated: true });
    expect((await finance.agent.post(`/ops/payments/${p.pay}:reject`).send({})).status).toBe(400);
    const before = mail.sent.length;
    const r = await finance.agent.post(`/ops/payments/${p.pay}:reject`).send({ reason: 'ยอดโอนไม่ตรงกับใบแจ้งหนี้' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id: p.pay, status: 'rejected', revoked: true });
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [p.inv.id])).rows[0].status).toBe('open');
    expect((await t.owner.query(`SELECT status FROM subscriptions WHERE id = $1`, [p.c.sub])).rows[0].status).toBe('canceled');
    const sent = mail.sent.slice(before);
    expect(sent.map((m) => m.to).sort()).toEqual([`admin@reject-me.example.com`, `owner@reject-me.example.com`]);
    expect(sent[0].text).toContain('ยอดโอนไม่ตรงกับใบแจ้งหนี้');
    expect((await audit(p.c.id, 'ops.payment_rejected'))[0].summary).toContain('เลิกสิทธิ์');
    expect((await finance.agent.post(`/ops/payments/${p.pay}:reject`).send({ reason: 'ซ้ำ' })).body.error.code).toBe('already_rejected');
    // ลูกค้าแนบสลิปใหม่ (API ลูกค้าตั้ง payment กลับเป็น pending_review) → ยืนยันได้
    await t.owner.query(`UPDATE payments SET status = 'pending_review' WHERE id = $1`, [p.pay]);
    expect((await finance.agent.post(`/ops/payments/${p.pay}:confirm`).send({})).status).toBe(200);
  });

  it('50 ทวิ: ยืนยัน / ปฏิเสธ (ต้องมีเหตุผลและแจ้งลูกค้า) ครั้งเดียวต่อฉบับ', async () => {
    const p = await pending('wht-me');
    const w1 = (await t.owner.query(`INSERT INTO wht_certificates (workspace_id, invoice_id, file_key, uploaded_by) VALUES ($1,$2,'wht/a.pdf',$3) RETURNING id`, [p.c.id, p.inv.id, p.c.owner])).rows[0].id as string;
    const w2 = (await t.owner.query(`INSERT INTO wht_certificates (workspace_id, invoice_id, file_key, uploaded_by) VALUES ($1,$2,'wht/b.pdf',$3) RETURNING id`, [p.c.id, p.inv.id, p.c.owner])).rows[0].id as string;
    expect((await finance.agent.post(`/ops/wht-certificates/${w1}:confirm`).send({})).body).toEqual({ id: w1, status: 'confirmed' });
    expect((await finance.agent.post(`/ops/wht-certificates/${w1}:confirm`).send({})).body.error.code).toBe('already_reviewed');
    expect((await finance.agent.post(`/ops/wht-certificates/${w2}:reject`).send({})).status).toBe(400);
    const before = mail.sent.length;
    expect((await finance.agent.post(`/ops/wht-certificates/${w2}:reject`).send({ reason: 'เลขประจำตัวผู้เสียภาษีไม่ตรง' })).body.status).toBe('rejected');
    expect(mail.sent.length - before).toBe(2);
    expect((await t.owner.query(`SELECT status, reviewed_by FROM wht_certificates WHERE id = $1`, [w2])).rows[0]).toEqual({ status: 'rejected', reviewed_by: finance.id });
    expect((await audit(p.c.id, 'ops.wht_confirmed')).length).toBe(1);
    expect((await finance.agent.post(`/ops/wht-certificates/${randomUUID()}:confirm`).send({})).status).toBe(404);
    expect((await finance.agent.get(`/ops/wht-certificates/${w1}/file`)).status).toBe(404); // ไฟล์ตัวอย่างไม่ได้อยู่ในที่เก็บ
  });
});

describe('Feature flag และประกาศ', () => {
  it('CRUD flag + เปิดให้บาง Workspace (Audit ของ Workspace นั้น) · key ซ้ำไม่ได้', async () => {
    const c = await customer(t, 'beta-co');
    const f = await admin.agent.post('/ops/feature-flags').send({ key: 'gantt_v2', description: 'Gantt ใหม่', defaultOn: false });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect((await admin.agent.post('/ops/feature-flags').send({ key: 'gantt_v2' })).status).toBe(409);
    expect((await admin.agent.post('/ops/feature-flags').send({ key: 'Bad Key' })).status).toBe(400);
    expect((await admin.agent.patch(`/ops/feature-flags/${f.body.id}`).send({ defaultOn: true })).body.defaultOn).toBe(true);

    const o = await admin.agent.put(`/ops/feature-flags/${f.body.id}/overrides/${c.id}`).send({ enabled: true });
    expect(o.body).toEqual({ flagId: f.body.id, workspaceId: c.id, enabled: true });
    await admin.agent.put(`/ops/feature-flags/${f.body.id}/overrides/${c.id}`).send({ enabled: false }); // แก้ค่าเดิม
    const list = await admin.agent.get('/ops/feature-flags');
    expect(list.body.items).toEqual([expect.objectContaining({ key: 'gantt_v2', overrides: [{ workspaceId: c.id, slug: 'beta-co', name: 'Co beta-co', enabled: false }] })]);
    expect(await audit(c.id, 'ops.feature_override')).toHaveLength(2);
    expect((await admin.agent.put(`/ops/feature-flags/${f.body.id}/overrides/${randomUUID()}`).send({ enabled: true })).status).toBe(404);
    expect((await admin.agent.delete(`/ops/feature-flags/${f.body.id}/overrides/${c.id}`)).status).toBe(200);
    expect((await admin.agent.delete(`/ops/feature-flags/${f.body.id}/overrides/${c.id}`)).status).toBe(404);
    expect(await audit(c.id, 'ops.feature_override_removed')).toHaveLength(1);
    expect((await admin.agent.delete(`/ops/feature-flags/${f.body.id}`)).status).toBe(200);
    expect((await admin.agent.get('/ops/feature-flags')).body.items).toEqual([]);
  });

  it('ประกาศ: สร้าง / แก้ / ปล่อย (ส่งแล้วแก้ไม่ได้) / ลบ', async () => {
    const a = await admin.agent.post('/ops/announcements').send({ message: 'ปิดปรับปรุงคืนวันเสาร์ 22:00–23:00', audience: 'owners_admins', channels: ['banner', 'email'], scheduledAt: '2026-12-05T15:00:00+07:00' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ audience: 'owners_admins', channels: ['banner', 'email'], sentAt: null });
    expect((await admin.agent.post('/ops/announcements').send({ message: '' })).status).toBe(400);
    expect((await admin.agent.post('/ops/announcements').send({ message: 'x', channels: ['sms'] })).status).toBe(400);
    expect((await admin.agent.patch(`/ops/announcements/${a.body.id}`).send({ message: 'ปิดปรับปรุงคืนวันอาทิตย์' })).body.message).toBe('ปิดปรับปรุงคืนวันอาทิตย์');
    const pub = await admin.agent.post(`/ops/announcements/${a.body.id}:publish`).send({});
    expect(pub.body.sentAt).not.toBeNull();
    expect((await admin.agent.post(`/ops/announcements/${a.body.id}:publish`).send({})).body.error.code).toBe('announcement_sent');
    expect((await admin.agent.patch(`/ops/announcements/${a.body.id}`).send({ message: 'แก้หลังส่ง' })).body.error.code).toBe('announcement_sent');
    expect((await admin.agent.get('/ops/announcements')).body.items).toHaveLength(1);
    expect((await admin.agent.delete(`/ops/announcements/${a.body.id}`)).status).toBe(200);
    expect((await admin.agent.delete(`/ops/announcements/${a.body.id}`)).status).toBe(404);
    expect((await support.agent.post('/ops/announcements').send({ message: 'x' })).status).toBe(403);
  });
});
