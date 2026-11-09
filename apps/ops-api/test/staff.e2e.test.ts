// O01 · บทบาทหลายบทบาท วงเงิน การอนุมัติ สิทธิ์ฉุกเฉิน และพนักงาน · ข้อมูลสมมติเท่านั้น
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { SoftKey } from './authenticator.js';
import { customer, reauth, signIn, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let finance: Staff;
let support: Staff;
let engineer: Staff;
let auditor: Staff;
let mail: Mailer;

const staffLog = async (action: string) => (await t.owner.query(`SELECT staff_id, roles, approved_by, self_approved, workspace_id, reason FROM staff_audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows;

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  // Owner คนเดียวที่ทำงานการเงินเองด้วย (ทีมเล็กวันเปิดตัว)
  owner = await staff(t, 'owner@friday.example.com', 'Oscar Owner', ['owner', 'finance']);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', ['finance']);
  support = await staff(t, 'support@friday.example.com', 'Sam Support', ['support']);
  engineer = await staff(t, 'oncall@friday.example.com', 'Dev Oncall', ['engineer']);
  auditor = await staff(t, 'acc@office.example.com', 'สำนักงานบัญชี', ['auditor']);
});
afterAll(() => t.close());

describe('บทบาท (06-ops-roles › 2)', () => {
  it('ไม่มีบทบาทไหนผ่านทุกอย่าง: Owner ที่ไม่มีบทบาท Support ขยายทดลองใช้เองไม่ได้', async () => {
    const c = await customer(t, 'roles-1');
    expect((await owner.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 3, reason: 'ทดสอบสิทธิ์' })).status).toBe(403);
    expect((await support.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 3, reason: 'ทดสอบสิทธิ์' })).status).toBe(200);
  });

  it('วิศวกรเห็น Feature flags แต่ไม่เห็นเงิน · ผู้ตรวจอ่านรายงานได้แต่เขียนไม่ได้', async () => {
    expect((await engineer.agent.get('/ops/feature-flags')).status).toBe(200);
    expect((await engineer.agent.get('/ops/payments')).status).toBe(403);
    expect((await auditor.agent.get('/ops/payments')).status).toBe(200);
    expect((await auditor.agent.get('/ops/staff')).status).toBe(200);
    expect((await auditor.agent.get('/ops/audit')).status).toBe(200);
    expect((await auditor.agent.post('/ops/staff').send({ email: 'x@friday.example.com', name: 'X', roles: ['support'] })).status).toBe(403);
    expect((await support.agent.get('/ops/staff')).status).toBe(403);
  });

  it('me บอกบทบาท วงเงิน และสถานะยืนยันตัวตนซ้ำ', async () => {
    const me = await finance.agent.get('/ops/auth/me');
    expect(me.body).toMatchObject({ staff: { roles: ['finance'], elevated: [], limits: { discountPct: 30, refundSatang: 1_000_000 } }, reauthed: false });
  });
});

describe('การอนุมัติ (06 › 4) · มี Owner คนเดียว', () => {
  it('การเงินให้ส่วนลดเกินวงเงิน → 202 คำขอ · Owner อนุมัติ (ต้องแตะกุญแจซ้ำ) → ส่วนลดมีผลในนามผู้ขอ', async () => {
    const c = await customer(t, 'appr-1', { status: 'active' });
    const before = mail.sent.length;
    const r = await finance.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 40, months: 6, reason: 'ต่อสัญญารายปี' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'workspace.discount', status: 'pending', requestedBy: finance.id, canSelfApprove: false });
    expect(mail.sent.slice(before).map((m) => m.to)).toContain(owner.email);
    expect((await t.owner.query(`SELECT discount FROM subscriptions WHERE id = $1`, [c.sub])).rows[0].discount).toEqual({});

    const id = r.body.pendingApproval.id;
    expect((await finance.agent.post(`/ops/approvals/${id}:approve`).send({})).status).toBe(403);
    expect((await owner.agent.post(`/ops/approvals/${id}:approve`).send({})).body.error.code).toBe('reauth_required');
    await reauth(owner);
    const ok = await owner.agent.post(`/ops/approvals/${id}:approve`).send({ note: 'ตามสัญญา' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.approval).toMatchObject({ status: 'approved', decidedBy: owner.id, selfApproved: false });
    expect((await t.owner.query(`SELECT discount FROM subscriptions WHERE id = $1`, [c.sub])).rows[0].discount).toMatchObject({ percent: 40, setBy: finance.id });
    const [log] = (await staffLog('ops.discount_set')).filter((l) => l.workspace_id === c.id);
    expect(log).toMatchObject({ staff_id: finance.id, approved_by: owner.id, self_approved: false });
    expect((await owner.agent.post(`/ops/approvals/${id}:approve`).send({})).body.error.code).toBe('approval_not_pending');
  });

  it('ส่วนลดไม่ระบุรอบ (ตลอดไป) เกินวงเงินเสมอ · ภายในวงเงินทำได้ทันที', async () => {
    const c = await customer(t, 'appr-2', { status: 'active' });
    expect((await finance.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 10, reason: 'ไม่ระบุรอบ' })).status).toBe(202);
    expect((await finance.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 30, months: 12, reason: 'ตรงวงเงินพอดี' })).status).toBe(200);
  });

  it('Owner ทำเองเกินวงเงิน + มีผู้อนุมัติคนเดียว → อนุมัติตัวเองได้ ติดป้าย self_approved', async () => {
    const c = await customer(t, 'self-1', { status: 'active' });
    const r = await owner.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 50, months: 3, reason: 'ชดเชยระบบล่ม' });
    expect(r.status).toBe(202);
    expect(r.body.pendingApproval.canSelfApprove).toBe(true);
    await reauth(owner);
    const ok = await owner.agent.post(`/ops/approvals/${r.body.pendingApproval.id}:approve`).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.approval.selfApproved).toBe(true);
    expect((await staffLog('approval.self_approved')).length).toBe(1);
    const filtered = await auditor.agent.get('/ops/audit?selfApproved=true');
    expect(filtered.body.items.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['approval.self_approved', 'ops.discount_set']));
  });

  it('ไม่อนุมัติ · ยกเลิกโดยผู้ขอ · หมดอายุ', async () => {
    const c = await customer(t, 'appr-3', { status: 'active' });
    const mk = async () => (await finance.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 45, months: 2, reason: 'ทดสอบสถานะ' })).body.pendingApproval.id as string;
    const a = await mk();
    expect((await owner.agent.post(`/ops/approvals/${a}:reject`).send({ note: 'ให้เป็นเครดิตแทน' })).body.approval).toMatchObject({ status: 'rejected', decisionNote: 'ให้เป็นเครดิตแทน' });
    const b = await mk();
    expect((await support.agent.post(`/ops/approvals/${b}:cancel`).send({})).status).toBe(403);
    expect((await finance.agent.post(`/ops/approvals/${b}:cancel`).send({})).body.approval.status).toBe('cancelled');
    const e = await mk();
    await t.owner.query(`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [e]);
    await reauth(owner);
    const late = await owner.agent.post(`/ops/approvals/${e}:approve`).send({});
    expect(late.body.error).toMatchObject({ code: 'approval_not_pending', details: { status: 'expired' } });
    const mine = await finance.agent.get('/ops/approvals');
    expect(mine.body.items.every((x: { requestedBy: string }) => x.requestedBy === finance.id)).toBe(true);
    expect(mine.body.singleApprover).toBe(true);
  });

  it('ขยายทดลองใช้รวมเกิน 30 วันต้องอนุมัติ', async () => {
    const c = await customer(t, 'trial-1', { trialDays: 5 });
    expect((await support.agent.post(`/ops/workspaces/${c.id}:extend-trial`).send({ days: 20, reason: 'รอจัดซื้อ' })).status).toBe(200);
    const r = await support.agent.post(`/ops/workspaces/${c.id}:extend-trial`).send({ days: 15, reason: 'รอจัดซื้ออีกรอบ' });
    expect(r.status).toBe(202);
    expect(r.body.pendingApproval.payload.rule).toContain('เคยขยาย 1 ครั้ง 20 วัน');
  });
});

describe('สิทธิ์ฉุกเฉิน (A12)', () => {
  it('ต้องแตะกุญแจซ้ำ · เปิดได้ 30 / 60 นาที · ได้บทบาทชั่วคราว · แจ้ง Owner และผู้ตรวจ · จบแล้วสิทธิ์หาย', async () => {
    const solo = await staff(t, 'solo@friday.example.com', 'Solo Owner', ['owner']);
    const c = await customer(t, 'elev-1');
    const body = { role: 'support', minutes: 30, reason: 'Support ทุกคนลาป่วย ลูกค้ารอคำตอบ' };
    expect((await solo.agent.post('/ops/staff/me/elevations').send(body)).body.error.code).toBe('reauth_required');
    await reauth(solo);
    expect((await solo.agent.post('/ops/staff/me/elevations').send({ ...body, minutes: 90 })).status).toBe(400);
    expect((await solo.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 2, reason: 'ก่อนเปิดสิทธิ์' })).status).toBe(403);
    const before = mail.sent.length;
    const e = await solo.agent.post('/ops/staff/me/elevations').send(body);
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect(mail.sent.slice(before).map((m) => m.to)).toEqual(expect.arrayContaining([owner.email, auditor.email, solo.email]));
    expect((await solo.agent.get('/ops/auth/me')).body.staff).toMatchObject({ roles: ['owner'], elevated: ['support'] });
    expect((await solo.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 2, reason: 'หลังเปิดสิทธิ์' })).status).toBe(200);
    expect((await staffLog('ops.trial_extended')).at(-1).roles).toEqual(['owner', 'support']);
    expect((await solo.agent.post(`/ops/staff/me/elevations/${e.body.elevation.id}:end`).send({})).body).toEqual({ ended: true });
    expect((await solo.agent.post(`/ops/workspaces/${c.id}/extend-trial`).send({ days: 2, reason: 'หลังจบสิทธิ์' })).status).toBe(403);
    await t.owner.query(`UPDATE staff_users SET status = 'disabled' WHERE id = $1`, [solo.id]);
  });
});

describe('พนักงาน (A1, A2)', () => {
  it('เชิญ → ลิงก์ลงทะเบียน · ต้องมีกุญแจ 2 อันก่อนเข้าใช้ · เชิญ Owner ต้องแตะกุญแจซ้ำ', async () => {
    const inv = await owner.agent.post('/ops/staff').send({ email: 'new.hire@friday.example.com', name: 'พนักงานใหม่', roles: ['support', 'support'], department: 'ปฏิบัติการ' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.staff).toMatchObject({ roles: ['support'], status: 'invited', department: 'ปฏิบัติการ' });
    expect(mail.sent.at(-1)?.to).toBe('new.hire@friday.example.com');
    const token = decodeURIComponent(new URL(inv.body.enrollUrl).searchParams.get('token')!);
    expect((await owner.agent.post('/ops/staff').send({ email: 'NEW.HIRE@friday.example.com', name: 'ซ้ำ', roles: ['support'] })).body.error.code).toBe('staff_exists');

    const agent = request.agent(t.app.getHttpServer());
    const k1 = new SoftKey();
    const k2 = new SoftKey();
    for (const [i, key] of [k1, k2].entries()) {
      const o = await agent.post('/ops/auth/register/options').send({ enrollToken: token });
      const v = await agent.post('/ops/auth/register/verify').send({ challengeToken: o.body.challengeToken, response: key.register(o.body.options), name: `key-${i}` });
      expect(v.body.status).toBe(i === 0 ? 'invited' : 'active');
      if (i === 0) expect((await signIn(agent, 'new.hire@friday.example.com', k1)).body.error.code).toBe('enrollment_incomplete');
    }
    expect((await signIn(agent, 'new.hire@friday.example.com', k2)).status).toBe(200);
    expect((await staffLog('staff.invited')).length).toBeGreaterThanOrEqual(1);
  });

  it('เปลี่ยนบทบาท แผนก วงเงิน · ถอด Owner คนสุดท้ายไม่ได้ · เพิ่ม Owner ต้องแตะกุญแจ · ระงับแล้ว session ใช้ไม่ได้', async () => {
    const u = await owner.agent.patch(`/ops/staff/${support.id}`).send({ roles: ['support', 'finance'], department: 'ปฏิบัติการ', limits: { trialDays: 45 }, reason: 'รับงานการเงินเพิ่ม' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.staff).toMatchObject({ roles: ['support', 'finance'], limits: { trialDays: 45, discountPct: 30 }, customLimits: { trialDays: 45 } });
    expect((await owner.agent.patch(`/ops/staff/${owner.id}`).send({ roles: ['finance'], reason: 'ลองถอดตัวเอง' })).body.error.code).toBe('last_owner');
    // เพิ่ม / เชิญ Owner ต้องแตะกุญแจซ้ำ (ใช้ Owner อีกคนที่ยังไม่เคยยืนยันซ้ำ)
    const fresh = await staff(t, 'owner.fresh@friday.example.com', 'Fresh Owner', ['owner']);
    expect((await fresh.agent.patch(`/ops/staff/${engineer.id}`).send({ roles: ['engineer', 'owner'], reason: 'ผู้ร่วมก่อตั้ง' })).body.error.code).toBe('reauth_required');
    expect((await fresh.agent.post('/ops/staff').send({ email: 'boss2@friday.example.com', name: 'Boss', roles: ['owner'] })).body.error.code).toBe('reauth_required');
    expect((await fresh.agent.post(`/ops/staff/${fresh.id}/status`).send({ status: 'suspended', reason: 'ทดสอบ' })).body.error.code).toBe('cannot_change_self');
    const sus = await owner.agent.post(`/ops/staff/${finance.id}/status`).send({ status: 'suspended', reason: 'ลาพักยาว' });
    expect(sus.body.staff.status).toBe('suspended');
    expect((await finance.agent.get('/ops/auth/me')).status).toBe(401);
    expect((await owner.agent.post(`/ops/staff/${finance.id}/status`).send({ status: 'active', reason: 'กลับมาทำงาน' })).body.staff.status).toBe('active');
    expect((await finance.agent.get('/ops/auth/me')).status).toBe(200);
    expect((await owner.agent.post(`/ops/staff/${finance.id}:enroll-link`).send({})).body.enrollUrl).toContain('/enroll?token=');
    const list = await owner.agent.get('/ops/staff');
    expect(list.body.singleApprover).toBe(false); // มี Owner 2 คนแล้ว (owner + fresh)
    expect(list.body.items.find((x: { id: string }) => x.id === support.id).keys).toHaveLength(1);
    await t.owner.query(`UPDATE staff_users SET status = 'disabled' WHERE id = $1`, [fresh.id]);
  });

  it('บัญชีผู้ตรวจหมดอายุแล้วเข้าไม่ได้', async () => {
    await t.owner.query(`UPDATE staff_users SET expires_at = now() - interval '1 minute' WHERE id = $1`, [auditor.id]);
    expect((await auditor.agent.get('/ops/auth/me')).status).toBe(401);
    expect((await signIn(auditor.agent, auditor.email, auditor.key)).status).toBe(401);
  });
});
