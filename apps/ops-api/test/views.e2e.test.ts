// ช่วง 3 · มุมมองที่บันทึก · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let lead: Staff;
let mew: Staff;
let fin: Staff;

beforeAll(async () => {
  t = await startOps();
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', 'admin');
  lead = await staff(t, 'lead@friday.example.com', 'ลีด ตัวอย่าง', 'support');
  mew = await staff(t, 'mew@friday.example.com', 'มิว ศิริ', 'support');
  fin = await staff(t, 'fin@friday.example.com', 'ฟิน บัญชี', 'finance');
  await t.owner.query(`INSERT INTO support_agents (staff_id, groups) VALUES ($1, '{lead}')`, [lead.id]);
});
afterAll(() => t.close());

describe('มุมมองที่บันทึก', () => {
  it('ส่วนตัวเห็นคนเดียว · ตัดค่าว่างและหน้าออก · ชื่อซ้ำในหน้าเดียวกันไม่ได้', async () => {
    const res = await mew.agent.post('/ops/views').send({ page: 'tickets', name: 'ด่วนของฉัน', filters: { tab: 'mine', priority: 'urgent,high', q: '', page: '3', ticket: 'x' } }).expect(201);
    expect(res.body).toMatchObject({ name: 'ด่วนของฉัน', team: false, mine: true, canEdit: true, filters: { tab: 'mine', priority: 'urgent,high' } });
    expect(Object.keys(res.body.filters)).toEqual(['tab', 'priority']);
    expect((await mew.agent.post('/ops/views').send({ page: 'tickets', name: 'ด่วนของฉัน', filters: {} })).body.error.code).toBe('duplicate_name');
    expect((await lead.agent.get('/ops/views?page=tickets')).body.items).toEqual([]);
    expect((await mew.agent.patch(`/ops/views/${res.body.id}`).send({ name: 'ด่วน' })).body.name).toBe('ด่วน');
    expect((await lead.agent.patch(`/ops/views/${res.body.id}`).send({ name: 'แอบแก้' })).status).toBe(404);
  });

  it('มุมมองของทีม: Support ทั่วไปสร้างไม่ได้ · หัวหน้าทีมสร้างได้ · คนในบทบาทเห็น แก้ไม่ได้ แต่ซ่อน / คัดลอกได้ · มีรอยใน audit', async () => {
    const no = await mew.agent.post('/ops/views').send({ page: 'tickets', name: 'เกิน SLA', filters: { sla: 'breached' }, roles: ['support'] });
    expect(no.status).toBe(403);
    const v = (await lead.agent.post('/ops/views').send({ page: 'tickets', name: 'เกิน SLA', filters: { sla: 'breached' }, roles: ['support'] }).expect(201)).body;
    expect(v).toMatchObject({ team: true, canEdit: true });
    const seen = (await mew.agent.get('/ops/views?page=tickets')).body;
    expect(seen.canManageTeam).toBe(false);
    expect(seen.items.map((x: { name: string }) => x.name)).toEqual(['ด่วน', 'เกิน SLA']);
    expect(seen.items[1]).toMatchObject({ team: true, canEdit: false, ownerName: 'ลีด ตัวอย่าง' });
    expect((await mew.agent.patch(`/ops/views/${v.id}`).send({ name: 'x' })).status).toBe(403);
    expect((await mew.agent.delete(`/ops/views/${v.id}`)).status).toBe(403);
    expect((await mew.agent.put(`/ops/views/${v.id}/prefs`).send({ hidden: true })).body.hidden).toBe(true);
    const copy = (await mew.agent.post(`/ops/views/${v.id}/copy`).expect(201)).body;
    expect(copy).toMatchObject({ name: 'เกิน SLA (สำเนา)', team: false, filters: { sla: 'breached' } });
    // การเงินไม่อยู่ในบทบาท support จึงไม่เห็น · Owner เห็นและลบได้
    expect((await fin.agent.get('/ops/views?page=tickets')).body.items).toEqual([]);
    expect((await boss.agent.get('/ops/views?page=tickets')).body.items.map((x: { name: string }) => x.name)).toContain('เกิน SLA');
    const log = await t.owner.query(`SELECT action FROM staff_audit_logs WHERE target_id = $1`, [v.id]);
    expect(log.rows.map((r) => r.action)).toEqual(['view.team_created']);
    await boss.agent.delete(`/ops/views/${v.id}`).expect(200);
  });

  it('ปักได้ไม่เกิน 5 · มุมมองเริ่มต้นหน้าละหนึ่ง · ตัวเลขบนเมนูนับตามตัวกรอง (ไม่มีสิทธิ์หน้านั้น = null)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await fin.agent.post('/ops/views').send({ page: i < 3 ? 'invoices' : 'overdue', name: `ชุด ${i}`, filters: {} }).expect(201)).body.id);
    for (const id of ids.slice(0, 5)) await fin.agent.put(`/ops/views/${id}/prefs`).send({ pinned: true }).expect(200);
    const over = await fin.agent.put(`/ops/views/${ids[5]}/prefs`).send({ pinned: true });
    expect(over.body.error).toMatchObject({ code: 'pin_limit', details: { max: 5 } });
    await fin.agent.put(`/ops/views/${ids[0]}/prefs`).send({ isDefault: true }).expect(200);
    await fin.agent.put(`/ops/views/${ids[1]}/prefs`).send({ isDefault: true }).expect(200);
    const list = (await fin.agent.get('/ops/views?page=invoices')).body.items;
    expect(list.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { id: string }) => x.id)).toEqual([ids[1]]);
    const counts = (await fin.agent.get('/ops/views/counts')).body.items;
    expect(counts).toHaveLength(5);
    expect(counts.every((c: { count: number | null }) => c.count === 0)).toBe(true);
    // มุมมองหน้า Ticket ของคนที่ไม่มีสิทธิ์ Ticket = null (ไม่บอกจำนวน)
    await t.owner.query(`UPDATE staff_users SET roles = '{auditor}' WHERE id = $1`, [mew.id]);
    const mine = (await mew.agent.get('/ops/views?page=tickets')).body.items.find((x: { name: string }) => x.name === 'ด่วน');
    await mew.agent.put(`/ops/views/${mine.id}/prefs`).send({ pinned: true }).expect(200);
    expect((await mew.agent.get('/ops/views/counts')).body.items).toEqual([{ id: mine.id, count: null }]);
  });

  it('ข้อมูลไม่ถูกต้อง', async () => {
    expect((await fin.agent.post('/ops/views').send({ page: 'nope', name: 'x', filters: {} })).status).toBe(400);
    expect((await fin.agent.post('/ops/views').send({ page: 'users', name: 'x', filters: { 'a.b': '1' } })).status).toBe(400);
    expect((await fin.agent.put('/ops/views/not-a-uuid/prefs').send({})).status).toBe(400);
  });
});
