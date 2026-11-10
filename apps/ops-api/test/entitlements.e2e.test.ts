// O21 · สิทธิ์และขีดจำกัดแบบมีเวอร์ชัน + ปรับเฉพาะราย ในหลังบ้าน · ข้อมูลสมมติเท่านั้น
import { DEFAULT_MATRIX } from '@friday/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/entitlements/entitlements.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let owner: Staff;
let owner2: Staff;
let finance: Staff;
let engineer: Staff;
let support: Staff;
let a: Customer;
let b: Customer;
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const matrix = (patch: Record<string, Record<string, unknown>> = {}) => {
  const m = structuredClone(DEFAULT_MATRIX) as Record<string, Record<string, unknown>>;
  for (const [plan, v] of Object.entries(patch)) Object.assign(m[plan], v);
  return m;
};
const member = async (c: Customer, email: string, role = 'member') => {
  const u = (await t.owner.query(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [email, email.split('@')[0]])).rows[0].id as string;
  await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [c.id, u, role]);
};
const approve = async (by: Staff, id: string) => {
  await reauth(by);
  const r = await by.agent.post(`/ops/approvals/${id}/approve`).send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  owner2 = await staff(t, 'owner2@friday.example.com', 'Oscar Owner', ['owner']);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  a = await customer(t, 'craft-demo', { plan: 'team_s', status: 'active' });
  b = await customer(t, 'nova-demo', { plan: 'enterprise', status: 'active' });
  // craft-demo ใช้ 9 / 10 ที่นั่ง (เจ้าของ + 8) · ใกล้ชนเพดาน
  for (let i = 0; i < 8; i++) await member(a, `dev${i}@craft-demo.example.com`);
  await member(a, 'guest@partner.example.com', 'guest');
});
afterAll(() => t.close());

describe('หน้าสิทธิ์และขีดจำกัด', () => {
  it('อ่านได้เฉพาะ Owner การเงิน วิศวกร', async () => {
    expect((await support.agent.get('/ops/entitlements')).status).toBe(403);
    expect((await engineer.agent.get('/ops/entitlements')).status).toBe(200);
    const r = await finance.agent.get('/ops/entitlements');
    expect(r.status).toBe(200);
    expect(r.body.current).toMatchObject({ version: 0 });
    expect(r.body.current.matrix.team_s.seats).toBe(10);
    expect(r.body.keys.map((k: { key: string }) => k.key)).toContain('api_rpm');
    expect(r.body.plans.find((p: { code: string }) => p.code === 'team_s').customers).toBe(1);
  });

  it('ใกล้ชนเพดาน: ใช้เกิน 85% ของขีดจำกัด · ส่งให้ทีมขายแล้วจำได้', async () => {
    const r = await owner.agent.get('/ops/entitlements');
    expect(r.body.nearLimit).toEqual([expect.objectContaining({ workspace: expect.objectContaining({ id: a.id }), plan: 'team_s', key: 'seats', used: 9, limit: 10, ratio: 0.9, referredAt: null })]);
    const before = mail.sent.length;
    const refer = await engineer.agent.post(`/ops/entitlements/near-limit/${a.id}/refer`).send({ key: 'seats' });
    expect(refer.status).toBe(200);
    expect(mail.sent.length).toBeGreaterThan(before);
    const again = await owner.agent.get('/ops/entitlements');
    expect(again.body.nearLimit[0].referredAt).not.toBeNull();
  });
});

describe('บันทึกเป็นเวอร์ชันใหม่ (P2) และประวัติ (P3)', () => {
  it('ดูก่อนบันทึก: นับลูกค้าที่ถูกลดสิทธิ์', async () => {
    const r = await finance.agent.post('/ops/entitlements/preview').send({ matrix: matrix({ team_s: { seats: 5, api_rpm: 120 } }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fromVersion: 0, nextVersion: 1, affectedTotal: 1 });
    expect(r.body.changes).toEqual(
      expect.arrayContaining([
        { plan: 'team_s', key: 'seats', from: 10, to: 5, reduced: true },
        { plan: 'team_s', key: 'api_rpm', from: 60, to: 120, reduced: false },
      ]),
    );
    expect(r.body.affected).toEqual([expect.objectContaining({ plan: 'team_s', key: 'seats', workspaces: 1 })]);
  });

  it('ข้อมูลผิด / ไม่มีอะไรเปลี่ยน / วิศวกรบันทึกไม่ได้', async () => {
    const bad = await finance.agent.post('/ops/entitlements/versions').send({ matrix: matrix({ free: { gantt: 3 } }), reason: 'ทดสอบ' });
    expect(bad.status).toBe(400);
    expect((await finance.agent.post('/ops/entitlements/versions').send({ matrix: matrix({ free: { seats: 0 } }), reason: 'ทดสอบ' })).status).toBe(400);
    expect((await finance.agent.post('/ops/entitlements/versions').send({ matrix: matrix(), reason: 'ไม่มีอะไรเปลี่ยน' })).status).toBe(422);
    expect((await engineer.agent.post('/ops/entitlements/versions').send({ matrix: matrix({ team_s: { seats: 12 } }), reason: 'ทดสอบ' })).status).toBe(403);
  });

  it('ต้องมีคนอนุมัติเสมอ · อนุมัติแล้วได้เวอร์ชันใหม่และ plans ตรงกัน', async () => {
    const r = await finance.agent.post('/ops/entitlements/versions').send({ matrix: matrix({ team_s: { seats: 12, automation_runs: 6000 } }), reason: 'ลูกค้า Team S ต้องการที่นั่งเพิ่ม' });
    expect(r.status).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'entitlements.version', status: 'pending' });
    const pending = await owner.agent.get('/ops/entitlements');
    expect(pending.body.pending).toHaveLength(1);
    const done = await approve(owner, r.body.pendingApproval.id);
    expect(done.result).toMatchObject({ version: 1 });
    const seat = await t.owner.query(`SELECT seat_limit FROM plans WHERE code = 'team_s'`);
    expect(seat.rows[0].seat_limit).toBe(12);
    const ov = await owner.agent.get('/ops/entitlements');
    expect(ov.body.current).toMatchObject({ version: 1, createdBy: 'Fin Finance', approvedBy: 'Olive Owner' });
    expect(ov.body.pending).toHaveLength(0);
    const audit = await t.owner.query(`SELECT action, approved_by FROM staff_audit_logs WHERE action = 'entitlements.version_created'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('เวอร์ชันที่ตั้งวันมีผลล่วงหน้ายังไม่ใช้ และอยู่ในรายการรอมีผล', async () => {
    const r = await finance.agent.post('/ops/entitlements/versions').send({ matrix: matrix({ team_s: { seats: 15, automation_runs: 6000 } }), effectiveAt: iso(10), reason: 'ปรับต้นเดือนหน้า' });
    await approve(owner2, r.body.pendingApproval.id);
    const ov = await owner.agent.get('/ops/entitlements');
    expect(ov.body.current.version).toBe(1);
    expect(ov.body.scheduled).toEqual([expect.objectContaining({ version: 2 })]);
    expect((await t.owner.query(`SELECT seat_limit FROM plans WHERE code = 'team_s'`)).rows[0].seat_limit).toBe(12);
  });

  it('ประวัติแสดงความต่าง · กู้เวอร์ชันเก่าเป็นเวอร์ชันใหม่', async () => {
    const h = await engineer.agent.get('/ops/entitlements/versions');
    expect(h.status).toBe(200);
    expect(h.body.items.map((i: { version: number; status: string }) => [i.version, i.status])).toEqual([[2, 'scheduled'], [1, 'current']]);
    expect(h.body.items[0].changes).toEqual([{ plan: 'team_s', key: 'seats', from: 12, to: 15, reduced: false }]);
    // กู้เวอร์ชัน 1 ทับเวอร์ชันที่รอมีผล → เทียบกับเวอร์ชันที่ใช้อยู่ (1) จึงไม่มีอะไรเปลี่ยน
    expect((await owner.agent.post('/ops/entitlements/versions/1/restore').send({ reason: 'กู้คืน' })).status).toBe(422);
    expect((await owner.agent.post('/ops/entitlements/versions/9/restore').send({ reason: 'กู้คืน' })).status).toBe(404);
  });
});

describe('ปรับเฉพาะราย', () => {
  it('ไม่เกิน 20% และมีวันหมดอายุ ทำได้เลย · ลง Audit log ของลูกค้า', async () => {
    const r = await engineer.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'api_rpm', value: 70, expiresAt: iso(20), reason: 'ย้ายข้อมูลจากระบบเก่าผ่าน API' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const audit = await t.owner.query(`SELECT actor_kind, summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.entitlement_override'`, [a.id]);
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'friday_staff' });
    expect(audit.rows[0].summary).toContain('API ต่อนาทีเป็น 70');
    const ov = await owner.agent.get('/ops/entitlements');
    expect(ov.body.overrides).toEqual([expect.objectContaining({ key: 'api_rpm', base: 60, value: 70, status: 'active', createdBy: 'Eve Engineer', workspace: expect.objectContaining({ id: a.id, plan: 'team_s' }) })]);
  });

  it('เกิน 20% / เปิดฟีเจอร์นอกแพ็กเกจ / ไม่มีวันหมดอายุ ต้องให้ Owner อนุมัติ', async () => {
    const seats = await finance.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'seats', value: 20, expiresAt: iso(30), reason: 'ทีมเพิ่มชั่วคราว' });
    expect(seats.status).toBe(202);
    const sso = await finance.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'sso', value: true, expiresAt: iso(6), reason: 'ทดลองก่อนซื้อ Enterprise' });
    expect(sso.status).toBe(202);
    const contract = await finance.agent.post('/ops/entitlements/overrides').send({ workspaceId: b.id, key: 'seats', value: 120, contractRef: 'ENT-DEMO-004', reason: 'สัญญา Enterprise' });
    expect(contract.status).toBe(202);
    await approve(owner, contract.body.pendingApproval.id);
    const ov = await owner.agent.get('/ops/entitlements');
    expect(ov.body.overrides.find((o: { key: string; workspace: { id: string } }) => o.workspace.id === b.id)).toMatchObject({ base: null, value: 120, status: 'contract', approvedBy: 'Olive Owner' });
  });

  it('ต้องมีวันหมดอายุหรือเลขที่สัญญา · ชนิดค่าต้องตรงกับคีย์', async () => {
    expect((await finance.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'seats', value: 11, reason: 'ไม่มีวันหมด' })).status).toBe(400);
    expect((await finance.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'sso', value: 5, expiresAt: iso(3), reason: 'ผิดชนิด' })).status).toBe(400);
    expect((await finance.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'seats', value: 11, expiresAt: iso(-1), reason: 'หมดแล้ว' })).status).toBe(400);
    expect((await support.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'seats', value: 11, expiresAt: iso(3), reason: 'ไม่มีสิทธิ์' })).status).toBe(403);
  });

  it('รายการใหม่ของคีย์เดิมแทนรายการเก่า · ยกเลิกได้', async () => {
    const r = await engineer.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'api_rpm', value: 72, expiresAt: iso(3), reason: 'ขยายเวลาย้ายข้อมูล' });
    expect(r.status).toBe(201);
    const active = await t.owner.query(`SELECT value FROM entitlement_overrides WHERE workspace_id = $1 AND key = 'api_rpm' AND revoked_at IS NULL`, [a.id]);
    expect(active.rows).toEqual([{ value: 72 }]);
    const ov = await owner.agent.get('/ops/entitlements');
    const row = ov.body.overrides.find((o: { key: string }) => o.key === 'api_rpm');
    expect(row.status).toBe('expiring');
    const revoked = await owner.agent.post(`/ops/entitlements/overrides/${row.id}/revoke`).send({ reason: 'ย้ายข้อมูลเสร็จแล้ว' });
    expect(revoked.status).toBe(200);
    expect((await owner.agent.post(`/ops/entitlements/overrides/${row.id}/revoke`).send({ reason: 'ซ้ำ' })).status).toBe(404);
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.entitlement_override_revoked'`, [a.id]);
    expect(audit.rows[0].summary).toContain('ย้ายข้อมูลเสร็จแล้ว');
  });

  it('แจ้งเจ้าของรายการล่วงหน้า 7 วันก่อนหมดอายุ ครั้งเดียว', async () => {
    await engineer.agent.post('/ops/entitlements/overrides').send({ workspaceId: a.id, key: 'automation_runs', value: 6500, expiresAt: iso(5), reason: 'แคมเปญปลายปี' }).expect(201);
    const svc = t.app.get(EntitlementsService);
    const before = mail.sent.length;
    const first = await svc.tick();
    expect(first.sent).toBe(1);
    expect(mail.sent.slice(before)[0]).toMatchObject({ to: 'eng@friday.example.com' });
    expect((await svc.tick()).warned).toBe(0);
  });
});
