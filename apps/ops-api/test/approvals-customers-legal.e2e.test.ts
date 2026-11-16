// O42 · สรุปอนุมัติตัวเอง · หลาย Workspace · เวลาเข้าบัญชีลูกค้า · Legal hold · เอกสารกฎหมาย (รอบ 4 · H1–H17) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegalService } from '../src/legal/legal.service.js';
import { Mailer } from '../src/mail.js';
import { DigestService } from '../src/staff/digest.service.js';
import { SupportService } from '../src/support/support.service.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let owner: Staff;
let support: Staff;
let finance: Staff;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const bkkDay = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);
/** เวลาไทย HH:MM ของวันที่ระบุ */
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);
const today = bkkDay(new Date());
const yesterday = bkkDay(new Date(Date.now() - DAY));
const tomorrow = bkkDay(new Date(Date.now() + DAY));
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.owner.query(text, params)).rows as T[];
const approve = async (by: Staff, id: string) => {
  await reauth(by);
  const r = await by.agent.post(`/ops/approvals/${id}/approve`).send({ note: 'ตรวจแล้ว' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const member = async (c: Customer, email: string, role = 'member') => {
  const u = (await q<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [email, email.split('@')[0]]))[0].id;
  await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [c.id, u, role]);
  return u;
};
const codeOf = (to: string) => /(\d{6})/.exec([...mail.sent].reverse().find((m) => m.to === to)!.text)![1];

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'olive@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'fin@friday.example.com', 'Fin Finance', 'finance');
});
afterAll(() => t.close());

describe('อีเมลส่วนตัวของพนักงาน (H1)', () => {
  it('เจ้าของบัญชีตั้งเอง · แตะกุญแจ · ห้ามโดเมนบริษัท · รหัส 6 หลัก · แจ้งอีเมลเดิมเมื่อเปลี่ยน', async () => {
    expect((await owner.agent.post('/ops/staff/me/personal-email').send({ email: 'olive.home@mail.example' })).body.error.code).toBe('reauth_required');
    await reauth(owner);
    expect((await owner.agent.post('/ops/staff/me/personal-email').send({ email: 'olive.alt@friday.example.com' })).body.error.code).toBe('company_domain');
    const r = await owner.agent.post('/ops/staff/me/personal-email').send({ email: 'Olive.Home@mail.example' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pending).toBe('olive.home@mail.example');
    const code = codeOf('olive.home@mail.example');
    // รหัสเก็บเป็น hash เท่านั้น
    const [row] = await q<{ hash: string }>(`SELECT personal_email_code_hash AS hash FROM staff_users WHERE id = $1`, [owner.id]);
    expect(row.hash).not.toContain(code);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await owner.agent.post('/ops/staff/me/personal-email/verify').send({ code: wrong })).body.error.code).toBe('code_invalid');
    const ok = await owner.agent.post('/ops/staff/me/personal-email/verify').send({ code });
    expect(ok.body).toMatchObject({ email: 'olive.home@mail.example', notifiedOld: false });
    expect((await owner.agent.get('/ops/staff/me/personal-email')).body).toMatchObject({ email: 'olive.home@mail.example', pending: null, workEmail: 'olive@friday.example.com' });

    // เปลี่ยน: ระหว่างรอยืนยันยังใช้อีเมลเดิม · ยืนยันแล้วแจ้งอีเมลเดิม
    await owner.agent.post('/ops/staff/me/personal-email').send({ email: 'olive.new@mail.example' });
    expect((await owner.agent.get('/ops/staff/me/personal-email')).body).toMatchObject({ email: 'olive.home@mail.example', pending: 'olive.new@mail.example' });
    const changed = await owner.agent.post('/ops/staff/me/personal-email/verify').send({ code: codeOf('olive.new@mail.example') });
    expect(changed.body).toMatchObject({ email: 'olive.new@mail.example', notifiedOld: true });
    expect(mail.sent.at(-1)).toMatchObject({ to: 'olive.home@mail.example', subject: expect.stringContaining('ถูกเปลี่ยน') });
    expect((await q(`SELECT 1 FROM staff_audit_logs WHERE action = 'staff.personal_email_changed' AND target_id = $1`, [owner.id])).length).toBe(1);

    // คนอื่นเห็นแค่สถานะ (อีเมลถูกปิดบางส่วน)
    await support.agent.post('/ops/staff/me/personal-email').send({ email: 'sam@mail.example' }).expect(401);
    const list = (await owner.agent.get('/ops/staff')).body;
    expect(list.items.find((x: { id: string }) => x.id === owner.id)).toMatchObject({ personalEmail: 'olive.new@mail.example', personalEmailStatus: 'verified' });
  });
});

describe('สรุปรายการที่อนุมัติตัวเอง (H2–H3)', () => {
  let c: Customer;

  it('08:00 ส่งสรุปของเมื่อวานถึงอีเมลส่วนตัว · 1 คำขอ = 1 บรรทัด · ส่งวันละครั้ง', async () => {
    c = await customer(t, 'digest-demo', { status: 'trialing' });
    const trial = await owner.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 40, reason: 'ชดเชยระบบช้า' });
    expect(trial.status, JSON.stringify(trial.body)).toBe(202);
    await approve(owner, trial.body.pendingApproval.id);
    const disc = await owner.agent.post(`/ops/workspaces/${c.id}/discount`).send({ percent: 40, months: 6, reason: 'ลูกค้ากลุ่มสัมมนา' });
    expect(disc.status).toBe(202);
    await approve(owner, disc.body.pendingApproval.id);
    // 1 การอนุมัติเขียน Audit หลายแถว แต่สรุปนับจากคำขอ
    expect((await q(`SELECT 1 FROM staff_audit_logs WHERE self_approved`)).length).toBeGreaterThan(2);
    await q(`UPDATE approval_requests SET decided_at = $1 WHERE self_approved`, [at(yesterday, '10:14')]);

    const digest = t.app.get(DigestService);
    expect((await digest.tick(at(today, '07:30'))).skipped).toBe('too_early');
    const before = mail.sent.length;
    expect(await digest.tick(at(today, '08:05'))).toMatchObject({ sent: 1, failed: 0 });
    const m = mail.sent.slice(before);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ to: 'olive.new@mail.example', subject: expect.stringContaining('(2 รายการ)') });
    expect(m[0].text.split('\n').filter((l) => l.startsWith('10:14 |'))).toHaveLength(2);
    expect(m[0].text).toContain('Co digest-demo');
    expect(await digest.tick(at(today, '09:05'))).toMatchObject({ sent: 0 });
    expect(mail.sent.length).toBe(before + 1);
    const s = (await owner.agent.get('/ops/staff')).body;
    expect(s.digest).toEqual([expect.objectContaining({ staffId: owner.id, personalEmail: 'o•••@mail.example', personalEmailVerified: true, lastCount: 2, failedAt: null })]);
  });

  it('ยังไม่ตั้งอีเมลส่วนตัว → บันทึกส่งไม่สำเร็จ แถบแดง · รอบหน้ารวมรายการที่ค้าง', async () => {
    const r = await owner.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 21, reason: 'ขยายอีกรอบ' });
    expect(r.status).toBe(202);
    await approve(owner, r.body.pendingApproval.id);
    await q(`UPDATE approval_requests SET decided_at = $1 WHERE id = $2`, [at(today, '14:02'), r.body.pendingApproval.id]);
    await q(`UPDATE staff_users SET personal_email = NULL, personal_email_verified_at = NULL WHERE id = $1`, [owner.id]);
    const digest = t.app.get(DigestService);
    expect(await digest.tick(at(tomorrow, '08:01'))).toMatchObject({ sent: 0, failed: 1 });
    const s = (await owner.agent.get('/ops/staff')).body;
    expect(s.digest[0]).toMatchObject({ personalEmail: null, personalEmailVerified: false });
    expect(s.digest[0].failedAt).not.toBeNull();
    expect(s.digest[0].failedText).toContain('ยังไม่ตั้งอีเมลส่วนตัว');
    expect((await q(`SELECT 1 FROM staff_audit_logs WHERE action = 'approval.digest_failed'`)).length).toBe(1);
    // ตั้งอีเมลคืน → วันถัดไปส่งรายการที่ค้าง (ช่วงตั้งแต่ส่งสำเร็จครั้งล่าสุด)
    await q(`UPDATE staff_users SET personal_email = 'olive.new@mail.example', personal_email_verified_at = now() WHERE id = $1`, [owner.id]);
    const before = mail.sent.length;
    const after2 = bkkDay(new Date(Date.now() + 2 * DAY));
    expect(await digest.tick(at(after2, '08:01'))).toMatchObject({ sent: 1 });
    expect(mail.sent.slice(before)[0].text).toContain('14:02 |');
    expect((await owner.agent.get('/ops/staff')).body.digest[0].failedAt).toBeNull();
  });
});

describe('ทำกับหลาย Workspace (H4–H7)', () => {
  let a: Customer;
  let b: Customer;
  let d: Customer;
  let e: Customer;
  let x: Customer;

  beforeAll(async () => {
    a = await customer(t, 'bulk-alpha', { status: 'trialing' });
    b = await customer(t, 'bulk-bravo', { status: 'trialing' });
    d = await customer(t, 'bulk-delta', { status: 'trialing' });
    e = await customer(t, 'bulk-echo', { status: 'trialing' });
    x = await customer(t, 'bulk-xray', { status: 'active' });
    await q(`UPDATE workspaces SET status = 'suspended', suspension_mode = 'full' WHERE id = $1`, [d.id]);
    await q(`UPDATE subscriptions SET trial_ends_at = now() - interval '2 days' WHERE id = $1`, [e.sub]);
    // bravo เคยขยาย 25 วัน → +7 = 32 เกินวงเงิน 30 วัน
    await q(`INSERT INTO audit_logs (workspace_id, actor_kind, category, action, summary) VALUES ($1, 'friday_staff', 'plan', 'ops.trial_extended', 'ต่อช่วงทดลอง 25 วัน → 2026-12-01 · ก่อนหน้า')`, [b.id]);
  });

  it('ตรวจก่อนทำตามตัวกรอง: ทำได้ / ต้องอนุมัติ / ข้ามพร้อมเหตุผล · บทบาทตาม action', async () => {
    const body = { action: 'extend_trial', filter: { q: 'bulk-', status: 'trialing' }, days: 7, reason: 'ชดเชยระบบช้าช่วง 14–15 พ.ย.' };
    expect((await finance.agent.post('/ops/workspaces/bulk/preview').send(body)).status).toBe(403);
    const r = await support.agent.post('/ops/workspaces/bulk/preview').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ total: 4, counts: { ok: 1, approval: 1, skip: 2 }, limits: { trialDays: 30, trialTimes: 2 } });
    const by = Object.fromEntries(r.body.rows.map((row: { slug: string; verdict: string; reason: string | null }) => [row.slug, [row.verdict, row.reason]]));
    expect(by['bulk-alpha']).toEqual(['ok', null]);
    expect(by['bulk-bravo']).toEqual(['approval', 'รวม 32 วัน (วงเงิน 30)']);
    expect(by['bulk-delta']).toEqual(['skip', 'ถูกระงับ']);
    expect(by['bulk-echo'][0]).toBe('skip');
    expect(by['bulk-echo'][1]).toContain('ทดลองหมด');
    // ระบุทั้ง ids และ filter ไม่ได้ · เกิน 1,000 ไม่ได้
    expect((await support.agent.post('/ops/workspaces/bulk/preview').send({ ...body, ids: [a.id] })).status).toBe(400);
    expect((await support.agent.post('/ops/workspaces/bulk/preview').send({ action: 'extend_trial', days: 7, reason: 'ทดสอบ', ids: Array.from({ length: 1001 }, () => a.id) })).status).toBe(400);
  });

  it('ทำจริง: รายที่เกินวงเงิน = 1 คำขออนุมัติ · ผลรายแถว · Audit ชุด', async () => {
    const r = await support.agent.post('/ops/workspaces/bulk/apply').send({ action: 'extend_trial', filter: { q: 'bulk-', status: 'trialing' }, days: 7, reason: 'ชดเชยระบบช้า', notifyOwners: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.counts).toEqual({ done: 1, pending: 1, skipped: 2, failed: 0 });
    const pending = r.body.rows.find((row: { slug: string }) => row.slug === 'bulk-bravo');
    expect(pending).toMatchObject({ result: 'pending', approvalId: expect.any(String) });
    expect((await q(`SELECT kind, workspace_id FROM approval_requests WHERE id = $1`, [pending.approvalId]))[0]).toMatchObject({ kind: 'workspace.extend_trial', workspace_id: b.id });
    expect((await q(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.trial_extended'`, [a.id])).length).toBe(1);
    expect(mail.sent.some((m) => m.to === 'owner@bulk-alpha.example.com' && m.subject.includes('ขยายช่วงทดลองใช้'))).toBe(true);
    const [batch] = await q<{ reason: string }>(`SELECT reason FROM staff_audit_logs WHERE action = 'ops.bulk_extend_trial' AND target_id = $1`, [r.body.batchId]);
    expect(batch.reason).toContain('สำเร็จ 1 · รออนุมัติ 1 · ข้าม 2 · ล้ม 0');
    // ป้ายระงับบอกโหมด
    expect((await support.agent.get('/ops/workspaces?q=bulk-delta')).body.items[0]).toMatchObject({ status: 'suspended', suspensionMode: 'full' });
  });

  it('ใช้คูปองที่มีอยู่: redeem จริง · นับสิทธิ์ · เกินวงเงินขออนุมัติ', async () => {
    const [{ id: welcome }] = await q<{ id: string }>(
      `INSERT INTO coupons (code, kind, value, duration, duration_cycles, plan_codes, max_redemptions, status, created_by) VALUES ('WELCOME20', 'percent', 20, 'repeating', 3, '{team_s}', 2, 'active', $1) RETURNING id`,
      [owner.id],
    );
    const body = { action: 'coupon', ids: [a.id, b.id, x.id], couponId: welcome, reason: 'ลูกค้ากลุ่มคลินิกจากงานสัมมนา' };
    expect((await support.agent.post('/ops/workspaces/bulk/preview').send(body)).status).toBe(403);
    const p = (await finance.agent.post('/ops/workspaces/bulk/preview').send(body)).body;
    expect(p).toMatchObject({ counts: { ok: 2, approval: 0, skip: 1 }, coupon: { code: 'WELCOME20', cycles: 3 } });
    expect(p.rows[2]).toMatchObject({ verdict: 'skip', code: 'coupon_exhausted' });
    const r = (await finance.agent.post('/ops/workspaces/bulk/apply').send(body)).body;
    expect(r.counts).toEqual({ done: 2, pending: 0, skipped: 1, failed: 0 });
    const red = await q<{ workspace_id: string; status: string; cycles_total: number }>(`SELECT workspace_id, status, cycles_total FROM coupon_redemptions WHERE coupon_id = $1 ORDER BY created_at`, [welcome]);
    expect(red).toHaveLength(2);
    expect(red.every((x) => x.status === 'active' && x.cycles_total === 3)).toBe(true);
    expect((await q(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.coupon_granted'`, [a.id])).length).toBe(1);
    // ใช้ซ้ำ = ข้าม
    expect((await finance.agent.post('/ops/workspaces/bulk/preview').send({ ...body, ids: [a.id] })).body.rows[0]).toMatchObject({ verdict: 'skip', code: 'coupon_already_used' });

    const [{ id: big }] = await q<{ id: string }>(`INSERT INTO coupons (code, kind, value, duration, plan_codes, status, created_by, stackable) VALUES ('BIG50', 'percent', 50, 'forever', '{team_s}', 'active', $1, true) RETURNING id`, [owner.id]);
    const over = (await finance.agent.post('/ops/workspaces/bulk/apply').send({ action: 'coupon', ids: [x.id], couponId: big, reason: 'ลูกค้ารายใหญ่ย้ายจากคู่แข่ง' })).body;
    expect(over.counts).toMatchObject({ pending: 1 });
    await approve(owner, over.rows[0].approvalId);
    expect((await q(`SELECT 1 FROM coupon_redemptions WHERE coupon_id = $1 AND workspace_id = $2 AND status = 'active'`, [big, x.id])).length).toBe(1);
    // คูปองปิดแล้วใช้ไม่ได้ทั้งชุด
    await q(`UPDATE coupons SET status = 'disabled' WHERE id = $1`, [big]);
    expect((await finance.agent.post('/ops/workspaces/bulk/preview').send({ action: 'coupon', ids: [a.id], couponId: big, reason: 'ทดสอบ' })).body.error.code).toBe('coupon_inactive');
  });
});

describe('เวลาเข้าบัญชีลูกค้า (H8–H9)', () => {
  it('ขยาย 15/30/60 · รวม ≤ 2 ชม. · เฉพาะผู้เข้า · แจ้ง Owner/Admin · งานทุกนาทีปิดที่หมดเวลา', async () => {
    const c = await customer(t, 'sess-demo', { status: 'active', admins: ['admin@sess-demo.example.com'] });
    await q(`INSERT INTO support_access_grants (workspace_id, granted_by, until) VALUES ($1, $2, now() + interval '1 day')`, [c.id, c.owner]);
    const s = await support.agent.post(`/ops/workspaces/${c.id}/support-sessions`).send({ ticketNo: '#530', reason: 'ตรวจเรื่องสิทธิ์โปรเจกต์ของลูกค้า', durationMinutes: 30 });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const id = s.body.session.id;
    const started = new Date(s.body.session.startedAt).getTime();
    expect((await owner.agent.post(`/ops/support-sessions/${id}/extend`).send({ minutes: 30, reason: 'ไม่ใช่ผู้เข้า' })).status).toBe(403);
    expect((await support.agent.post(`/ops/support-sessions/${id}/extend`).send({ minutes: 45, reason: 'ผิดค่า' })).status).toBe(400);
    const before = mail.sent.length;
    const e1 = await support.agent.post(`/ops/support-sessions/${id}/extend`).send({ minutes: 60, reason: 'ยังตรวจไม่เสร็จ' });
    expect(e1.status, JSON.stringify(e1.body)).toBe(200);
    expect(new Date(e1.body.session.expiresAt).getTime() - started).toBeGreaterThanOrEqual(89 * 60_000);
    expect(e1.body).toMatchObject({ notified: 2, capped: false });
    expect(mail.sent.slice(before).map((m) => m.to).sort()).toEqual(['admin@sess-demo.example.com', 'owner@sess-demo.example.com']);
    const e2 = await support.agent.post(`/ops/support-sessions/${id}/extend`).send({ minutes: 60, reason: 'ต่ออีกนิด' });
    expect(e2.body.capped).toBe(true);
    expect(new Date(e2.body.session.expiresAt).getTime() - started).toBeLessThanOrEqual(120 * 60_000);
    expect((await support.agent.post(`/ops/support-sessions/${id}/extend`).send({ minutes: 15, reason: 'อีกครั้ง' })).body.error.code).toBe('session_max_reached');
    expect((await q(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'support.session_extended'`, [c.id])).length).toBe(2);

    // หมดเวลา → งานทุก 1 นาทีปิดเอง (ไม่ต้องมีคนเปิดรายการ) · ตารางบอกเวลาที่ใช้ / หมดเวลา
    await q(`UPDATE support_sessions SET started_at = now() - interval '70 minutes', expires_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    expect(await t.app.get(SupportService).closeExpired()).toEqual({ closed: 1 });
    expect((await q(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'support.session_expired'`, [c.id])).length).toBe(1);
    const list = (await support.agent.get('/ops/support-sessions?scope=recent')).body;
    expect(list.serverTime).toBeTruthy();
    expect(list.items.find((x: { id: string }) => x.id === id)).toMatchObject({ endReason: 'expired', usedMinutes: 60, staffName: 'Sam Support' });
    expect((await support.agent.get('/ops/support-sessions')).body.items.find((x: { id: string }) => x.id === id)).toBeUndefined();
  });
});

describe('Legal hold และนโยบายการเก็บข้อมูล (H10–H12)', () => {
  let c: Customer;
  let mali = '';
  let reqId = '';

  it('ตั้ง hold เฉพาะผู้ใช้: คำขอลบ PDPA ขึ้น "รอ Legal hold" แจ้งผู้ขอครั้งเดียว · ลบไม่ได้', async () => {
    c = await customer(t, 'hold-demo', { status: 'active' });
    mali = await member(c, 'mali@hold-demo.example.com');
    const r = (await support.agent.post('/ops/privacy/requests').send({ requestType: 'erase', requesterEmail: 'mali@hold-demo.example.com', identity: 'email_match', acknowledge: false })).body.request;
    reqId = r.id;
    await support.agent.post(`/ops/privacy/requests/${reqId}/advance`).send({ note: 'ตรวจขอบเขตแล้ว' }).expect(200);
    const hold = { workspaceId: c.id, scope: 'users', userEmails: ['mali@hold-demo.example.com'], reason: 'ข้อพิพาทการชำระเงิน', reference: 'หนังสือเลขที่ ตย.01/2569' };
    expect((await support.agent.post('/ops/privacy/legal-holds').send(hold)).status).toBe(403);
    const fresh = await staff(t, 'olga@friday.example.com', 'Olga Second', ['support']);
    expect((await fresh.agent.get('/ops/privacy/legal-holds')).status).toBe(200);
    expect((await owner.agent.post('/ops/privacy/legal-holds').send({ ...hold, userEmails: ['nobody@hold-demo.example.com'] })).body.error.code).toBe('not_member');
    const before = mail.sent.length;
    const h = await owner.agent.post('/ops/privacy/legal-holds').send(hold);
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect(h.body).toMatchObject({ notified: 0, heldRequests: 1, hold: { scope: 'users', userIds: [mali], notifyCustomer: false } });
    expect(mail.sent.slice(before)).toEqual([expect.objectContaining({ to: 'mali@hold-demo.example.com', subject: expect.stringContaining('เก็บไว้ตามกฎหมาย') })]);
    // ไม่แจ้งลูกค้า = ไม่มีรอยใน Audit ที่ลูกค้าเห็น
    expect((await q(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'privacy.legal_hold%'`, [c.id])).length).toBe(0);
    const reqs = (await support.agent.get('/ops/privacy/requests')).body.items;
    expect(reqs.find((x: { id: string }) => x.id === reqId)).toMatchObject({ status: 'open', legalHold: true });
    expect((await owner.agent.post(`/ops/privacy/requests/${reqId}/erase`).send({ confirm: 'ลบข้อมูล', reason: 'ผู้ขอยืนยันแล้ว' })).body.error.code).toBe('legal_hold');
    // แจ้งผู้ขอครั้งเดียว
    expect(mail.sent.filter((m) => m.to === 'mali@hold-demo.example.com' && m.subject.includes('เก็บไว้ตามกฎหมาย'))).toHaveLength(1);
  });

  it('ยกเลิก hold ต้องผ่านคำขออนุมัติ (G7) · หลังยกเลิกลบได้ตามปกติ', async () => {
    const [h] = (await owner.agent.get('/ops/privacy/legal-holds')).body.items;
    const r = await owner.agent.post(`/ops/privacy/legal-holds/${h.id}/release`).send({ reason: 'ข้อพิพาทยุติแล้ว' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((await owner.agent.get('/ops/privacy/legal-holds')).body.items[0].releaseApproval).toBe(r.body.pendingApproval.id);
    await approve(owner, r.body.pendingApproval.id);
    expect((await owner.agent.get('/ops/privacy/legal-holds')).body.items[0]).toMatchObject({ active: false, releaseReason: 'ข้อพิพาทยุติแล้ว' });
    expect((await support.agent.get('/ops/privacy/requests')).body.items.find((x: { id: string }) => x.id === reqId).legalHold).toBe(false);
  });

  it('ระยะเก็บ: ยาวขึ้นบันทึกเลย · สั้นลงต้องอนุมัติ · ภาษีล็อก · นอกขอบเขตไม่ได้', async () => {
    const r0 = (await support.agent.get('/ops/privacy/retention')).body;
    expect(r0.taxYears).toBe(5);
    expect(r0.rows.map((x: { key: string; days: number }) => [x.key, x.days])).toEqual([['workspaceDataDays', 90], ['trashDays', 30], ['systemLogDays', 90], ['staffAuditDays', 730]]);
    expect((await support.agent.put('/ops/privacy/retention').send({ key: 'systemLogDays', days: 120, reason: 'ทดสอบสิทธิ์' })).status).toBe(403);
    await reauth(owner);
    expect((await owner.agent.put('/ops/privacy/retention').send({ key: 'systemLogDays', days: 10, reason: 'ต่ำเกินไป' })).body.error.code).toBe('retention_out_of_range');
    const longer = await owner.agent.put('/ops/privacy/retention').send({ key: 'systemLogDays', days: 120, reason: 'ผู้ตรวจขอเก็บนานขึ้น' });
    expect(longer.status, JSON.stringify(longer.body)).toBe(200);
    expect(longer.body.retention.systemLogDays).toBe(120);
    await q(`INSERT INTO audit_logs (workspace_id, actor_kind, category, action, ip, user_agent, created_at) VALUES ($1, 'user', 'secu', 'auth.login', '203.0.113.9', 'Mozilla/5.0', now() - interval '45 days')`, [c.id]);
    expect((await owner.agent.get('/ops/privacy/retention/estimate?key=systemLogDays&days=30')).body.rows).toBeGreaterThanOrEqual(1);
    const shorter = await owner.agent.put('/ops/privacy/retention').send({ key: 'systemLogDays', days: 30, reason: 'ลดข้อมูลส่วนบุคคลตามผลตรวจ DPO' });
    expect(shorter.status).toBe(202);
    expect((await owner.agent.get('/ops/privacy/retention')).body.rows[2]).toMatchObject({ days: 120, pendingApproval: { id: shorter.body.pendingApproval.id, days: 30 } });
    await approve(owner, shorter.body.pendingApproval.id);
    expect((await owner.agent.get('/ops/privacy/retention')).body.rows[2].days).toBe(30);
    expect((await q<{ value: { systemLogDays: number } }>(`SELECT value FROM ops_settings WHERE key = 'retention'`))[0].value.systemLogDays).toBe(30);
  });
});

describe('ลบถาวรทันที (H13)', () => {
  let c: Customer;
  let ticket = '';

  beforeAll(async () => {
    c = await customer(t, 'purge-demo', { status: 'canceled' });
    await q(`UPDATE workspaces SET status = 'pending_delete', deleted_at = now() - interval '2 days', deleted_by = $2, purge_after = now() + interval '28 days' WHERE id = $1`, [c.id, c.owner]);
    ticket = (await q<{ id: string }>(`INSERT INTO support_tickets (workspace_id, requester_user_id, subject) VALUES ($1, $2, 'ขอให้ลบข้อมูลทั้งหมดทันที') RETURNING id`, [c.id, c.owner]))[0].id;
  });

  it('ตรวจ Ticket จาก Owner · slug · Legal hold · คนที่สองต้องอนุมัติเสมอ แม้มี Owner คนเดียว', async () => {
    const pv = (await owner.agent.get(`/ops/privacy/pending-deletes/${c.id}`)).body;
    expect(pv).toMatchObject({ keepYears: 5, checks: { legalHold: false, unpaidInvoices: 0 }, tickets: [{ id: ticket, fromOwner: true }] });
    await reauth(owner);
    expect((await owner.agent.post(`/ops/privacy/pending-deletes/${c.id}/purge-now`).send({ ticketId: ticket, confirmSlug: 'wrong', reason: 'ลูกค้าขอลบทันที' })).body.error.code).toBe('confirm_required');
    const [{ id: holdId }] = await q<{ id: string }>(`INSERT INTO legal_holds (workspace_id, reason, reference, created_by) VALUES ($1, 'คำสั่งศาล', 'คดีตัวอย่าง', $2) RETURNING id`, [c.id, owner.id]);
    expect((await owner.agent.post(`/ops/privacy/pending-deletes/${c.id}/purge-now`).send({ ticketId: ticket, confirmSlug: 'purge-demo', reason: 'ลูกค้าขอลบทันที' })).body.error.code).toBe('legal_hold');
    expect((await support.agent.get('/ops/privacy/pending-deletes')).body.items.find((w: { id: string }) => w.id === c.id).legalHold).toBe(true);
    await q(`UPDATE legal_holds SET released_at = now(), released_by = $2, release_reason = 'ทดสอบ' WHERE id = $1`, [holdId, owner.id]);
    const r = await owner.agent.post(`/ops/privacy/pending-deletes/${c.id}/purge-now`).send({ ticketId: ticket, confirmSlug: 'PURGE-DEMO', reason: 'ลูกค้าขอลบทันทีตาม Ticket' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'privacy.purge_now', canSelfApprove: false });
    await reauth(owner);
    expect((await owner.agent.post(`/ops/approvals/${r.body.pendingApproval.id}/approve`).send({})).body.error.code).toBe('self_approval_not_allowed');

    const owner2 = await staff(t, 'oscar@friday.example.com', 'Oscar Owner', ['owner']);
    await approve(owner2, r.body.pendingApproval.id);
    const [w] = await q<{ purge_after: Date }>(`SELECT purge_after FROM workspaces WHERE id = $1`, [c.id]);
    expect(new Date(w.purge_after).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await q(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.workspace_purge_approved'`, [c.id])).length).toBe(1);
    expect((await support.agent.get('/ops/privacy/pending-deletes')).body.items.find((x: { id: string }) => x.id === c.id).purgeApproved).toBe(true);
    // มี Owner 2 คนแล้ว → ไม่มีการอนุมัติตัวเอง จึงหยุดส่งสรุป
    expect((await t.app.get(DigestService).tick(at(today, '08:30'))).skipped).toBe('multiple_owners');
  });
});

describe('แจ้งเอกสารกฎหมายฉบับใหม่ (H14–H15)', () => {
  it('ส่งเป็นชุด บันทึก legal_notices · ข้ามที่ตีกลับถาวร · สถิติ · เตือน 7 วันก่อนมีผล', async () => {
    await q(`INSERT INTO email_suppressions (email, reason) VALUES ('owner@bulk-echo.example.com', 'hard_bounce'), ('owner@bulk-delta.example.com', 'complaint')`);
    const aud = (await owner.agent.get('/ops/legal/audience')).body;
    expect(aud.all).toBeGreaterThan(5);
    expect(aud.suppressed).toBe(1);
    const effective = new Date(Date.now() + 31 * DAY);
    const body = { docType: 'terms', version: '2', summary: 'เพิ่มข้อกำหนดการใช้ AI ช่วยสรุปงาน · ปรับระยะเก็บ Log ระบบเป็น 30 วัน', body: 'ข้อกำหนดการใช้งาน (ตัวอย่าง) '.repeat(5), effectiveAt: effective.toISOString(), requiresAcceptance: true };
    await reauth(owner);
    const before = mail.sent.length;
    const r = await owner.agent.post('/ops/legal/documents').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.document).toMatchObject({ notifyAudience: 'all', notifyBanner: true });
    expect(new Date(r.body.document.remindAt).getTime()).toBe(effective.getTime() - 7 * DAY);
    const legal = t.app.get(LegalService);
    await legal.tick();
    const notices = await q<{ status: string; email: string }>(`SELECT status, email FROM legal_notices WHERE document_id = $1 AND kind = 'notice'`, [r.body.document.id]);
    expect(notices).toHaveLength(aud.all);
    // ตีกลับถาวร = ข้าม · ร้องเรียน (ปิดอีเมลข่าวสาร) ยังได้อีเมลกฎหมาย
    expect(notices.filter((n) => n.status === 'suppressed').map((n) => n.email)).toEqual(['owner@bulk-echo.example.com']);
    expect(notices.find((n) => n.email === 'owner@bulk-delta.example.com')?.status).toBe('sent');
    const sent = mail.sent.slice(before);
    expect(sent).toHaveLength(aud.all - 1);
    expect(sent[0].subject).toContain('ข้อกำหนดการใช้งานฉบับใหม่มีผล');
    expect(sent[0].text).toContain('- เพิ่มข้อกำหนดการใช้ AI ช่วยสรุปงาน');
    expect((await q(`SELECT notified_at FROM legal_documents WHERE id = $1`, [r.body.document.id]))[0].notified_at).not.toBeNull();
    expect(await legal.tick()).toEqual({ sent: 0 });
    const docs = (await owner.agent.get('/ops/legal/documents')).body.items;
    const sched = docs.find((g: { docType: string; locale: string }) => g.docType === 'terms' && g.locale === 'th').scheduled[0];
    expect(sched).toMatchObject({ noticeSent: aud.all - 1, noticeBounced: 1, noticeTotal: aud.all, reminderSent: 0 });

    const n = mail.sent.length;
    await legal.tick(new Date(effective.getTime() - 6 * DAY));
    expect(mail.sent.slice(n).every((m) => m.subject.startsWith('เตือน: '))).toBe(true);
    expect(mail.sent.length - n).toBe(aud.all - 1);
  });

  it('เฉพาะ Owner / Admin · ไม่ส่ง · เวลาส่งต้องไม่หลังวันมีผล', async () => {
    const body = { docType: 'privacy', version: '3', summary: 'แจ้งรายชื่อผู้ประมวลผลข้อมูลช่วงใหม่', body: 'นโยบายความเป็นส่วนตัว (ตัวอย่าง) '.repeat(5), effectiveAt: new Date(Date.now() + 2 * DAY).toISOString(), requiresAcceptance: false };
    await reauth(owner);
    expect((await owner.agent.post('/ops/legal/documents').send({ ...body, notifyAt: new Date(Date.now() + 3 * DAY).toISOString() })).body.error.code).toBe('notify_after_effective');
    const r = await owner.agent.post('/ops/legal/documents').send({ ...body, notifyAudience: 'admins' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // มีผลใน 2 วัน (< 7 วัน) จึงไม่มีรอบเตือน
    expect(r.body.document.remindAt).toBeNull();
    await t.app.get(LegalService).tick();
    const emails = (await q<{ email: string }>(`SELECT email FROM legal_notices WHERE document_id = $1`, [r.body.document.id])).map((x) => x.email);
    expect(emails.length).toBe((await owner.agent.get('/ops/legal/audience')).body.admins);
    expect(emails).not.toContain('mali@hold-demo.example.com');
    const none = await owner.agent.post('/ops/legal/documents').send({ ...body, docType: 'cookie', version: '1', notifyAudience: 'none' });
    expect(none.body.document).toMatchObject({ notifyAudience: null, notifyAt: null });
  });
});
