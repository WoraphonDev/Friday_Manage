// O52 · ขอสิทธิ์ชั่วคราว · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JitService } from '../src/staff/jit.service.js';
import { reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let boss2: Staff;
let sam: Staff;
let aud: Staff;

beforeAll(async () => {
  t = await startOps();
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', ['owner']);
  boss2 = await staff(t, 'boss2@friday.example.com', 'บอสสอง ตัวอย่าง', ['owner']);
  sam = await staff(t, 'sam@friday.example.com', 'สมหญิง Support', 'support');
  aud = await staff(t, 'aud@friday.example.com', 'ผู้ตรวจ ตัวอย่าง', ['auditor']);
});
afterAll(() => t.close());

describe('ขอสิทธิ์ชั่วคราว', () => {
  let requestId: string;
  let elevationId: string;

  it('Support ขอบทบาทการเงิน 1 ชม. ผูก Ticket · กติกา: ห้ามขอ Owner · ห้ามเกิน 8 ชม. · ขอซ้ำที่รออยู่ไม่ได้ · Owner ใช้สิทธิ์ฉุกเฉินแทน', async () => {
    expect((await sam.agent.post('/ops/jit/requests').send({ role: 'owner', minutes: 60, reason: 'ขอสิทธิ์สูงสุดเพื่อทดสอบ' })).status).toBe(400);
    expect((await sam.agent.post('/ops/jit/requests').send({ role: 'finance', minutes: 600, reason: 'ต้องดูใบแจ้งหนี้และสลิป' })).status).toBe(400);
    expect((await sam.agent.post('/ops/jit/requests').send({ role: 'support', minutes: 60, reason: 'มีบทบาทนี้อยู่แล้วนะ' })).body.error.code).toBe('role_already_held');
    const r = await sam.agent.post('/ops/jit/requests').send({ role: 'finance', minutes: 60, reason: 'ลูกค้าแจ้งว่าโอนแล้วแต่ใบแจ้งหนี้ยังค้าง', ticketRef: '#1842' }).expect(202);
    requestId = r.body.pendingApproval.id;
    expect(r.body.pendingApproval).toMatchObject({ kind: 'staff.elevate', status: 'pending' });
    expect((await sam.agent.post('/ops/jit/requests').send({ role: 'finance', minutes: 30, reason: 'ขอซ้ำอีกครั้งระหว่างรอ' })).body.error.code).toBe('request_pending');
    expect((await boss.agent.post('/ops/jit/requests').send({ role: 'finance', minutes: 60, reason: 'Owner ขอแบบพนักงาน' })).body.error.code).toBe('use_break_glass');
    const exp = await t.owner.query(`SELECT expires_at - created_at < interval '61 minutes' AS hour FROM approval_requests WHERE id = $1`, [requestId]);
    expect(exp.rows[0].hour).toBe(true);
  });

  it('Owner เห็นในแถบต้องทำ + ตัวนับภาพรวม · Support เห็นคำขอของตัวเอง · ผู้ตรวจเห็นตัวเลข', async () => {
    const o = (await boss.agent.get('/ops/jit').expect(200)).body;
    expect(o.pending).toEqual([expect.objectContaining({ id: requestId, role: 'finance', minutes: 60, ticketRef: '#1842', staffName: 'สมหญิง Support', staffRoles: ['support'] })]);
    expect(o).toMatchObject({ canApprove: true, stats: { requested: 1, approved: 0, active: 0 } });
    expect((await boss.agent.get('/ops/overview')).body.tasks.jitPending).toBe(1);
    const m = (await sam.agent.get('/ops/jit').expect(200)).body;
    expect(m).toMatchObject({ pending: [], stats: null, canApprove: false, mine: { active: [], pending: [expect.objectContaining({ id: requestId, role: 'finance' })] } });
    expect((await aud.agent.get('/ops/jit')).body.stats.requested).toBe(1);
  });

  it('ห้ามอนุมัติตัวเอง · Owner อนุมัติ (แตะกุญแจ) → ได้บทบาททันที นับเวลาตอนอนุมัติ', async () => {
    expect((await sam.agent.post(`/ops/approvals/${requestId}/approve`).send({})).status).toBe(403);
    await reauth(boss);
    await boss.agent.post(`/ops/approvals/${requestId}/approve`).send({}).expect(200);
    const me = (await sam.agent.get('/ops/auth/me').expect(200)).body.staff;
    expect(me.elevated).toEqual(['finance']);
    const mine = (await sam.agent.get('/ops/jit/me').expect(200)).body;
    expect(mine.active).toEqual([expect.objectContaining({ role: 'finance', kind: 'approved', ticketRef: '#1842', approvedBy: 'บอส ตัวอย่าง' })]);
    elevationId = mine.active[0].id;
    const left = Date.parse(mine.active[0].endsAt) - Date.now();
    expect(left).toBeGreaterThan(58 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);
    // เข้าหน้าเงินได้แล้ว
    expect((await sam.agent.get('/ops/invoices?limit=1')).status).toBe(200);
  });

  it('ทุกบรรทัดใน Audit log ระหว่างใช้สิทธิ์ติดป้าย · กรองได้', async () => {
    await sam.agent.post('/ops/staff/me/personal-email').send({ email: 'sam.personal@example.org' });
    const logs = (await boss.agent.get(`/ops/audit?elevationId=${elevationId}`).expect(200)).body.items;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.every((l: { elevationId: string }) => l.elevationId === elevationId)).toBe(true);
    expect(logs.map((l: { action: string }) => l.action)).toContain('staff.elevated');
    const all = (await boss.agent.get('/ops/audit?elevated=true')).body.items;
    expect(all.length).toBe(logs.length);
  });

  it('เปิดอยู่ / ประวัติ: Owner เห็นทุกคน · คนทั่วไปเห็นของตัวเอง · คืนสิทธิ์ได้เอง', async () => {
    const act = (await boss.agent.get('/ops/jit/elevations?tab=active').expect(200)).body;
    expect(act).toMatchObject({ total: 1, items: [expect.objectContaining({ staffName: 'สมหญิง Support', role: 'finance', approvedBy: 'บอส ตัวอย่าง', kind: 'approved' })] });
    expect((await aud.agent.get('/ops/jit/elevations?tab=active')).body.total).toBe(1);
    // สิทธิ์ฉุกเฉินของ Owner อยู่ในตารางเดียวกัน
    await reauth(boss2);
    await boss2.agent.post('/ops/staff/me/elevations').send({ role: 'auditor', minutes: 30, reason: 'ตรวจเหตุละเมิดข้อมูลด่วน' }).expect(201);
    expect((await boss.agent.get('/ops/jit/elevations?tab=active&q=บอสสอง')).body.items).toEqual([expect.objectContaining({ kind: 'break_glass', role: 'auditor' })]);
    expect((await sam.agent.get('/ops/jit/elevations?tab=active')).body.total).toBe(1);
    await sam.agent.post(`/ops/staff/me/elevations/${elevationId}/end`).expect(200);
    expect((await sam.agent.get('/ops/auth/me')).body.staff.elevated).toEqual([]);
    const hist = (await boss.agent.get('/ops/jit/elevations?tab=history')).body;
    expect(hist.items).toEqual([expect.objectContaining({ id: elevationId, endedBy: 'สมหญิง Support', actions: expect.any(Number) })]);
  });

  it('ปฏิเสธ → ไม่ได้สิทธิ์ · เหลือ 5 นาทีแจ้งครั้งเดียว', async () => {
    const r = (await sam.agent.post('/ops/jit/requests').send({ role: 'engineer', minutes: 240, reason: 'ดูสถานะระบบตอนลูกค้าแจ้งล่ม' }).expect(202)).body;
    await boss.agent.post(`/ops/approvals/${r.pendingApproval.id}/reject`).send({ note: 'ให้วิศวกรดูแทน' }).expect(200);
    expect((await sam.agent.get('/ops/auth/me')).body.staff.elevated).toEqual([]);
    expect((await boss.agent.get('/ops/jit')).body.stats).toMatchObject({ requested: 2, approved: 1, rejected: 1 });
    const svc = t.app.get(JitService);
    const soon = new Date(Date.now() + 26 * 60_000);
    expect(await svc.warnEnding(soon)).toBe(1);
    expect(await svc.warnEnding(soon)).toBe(0);
  });
});
