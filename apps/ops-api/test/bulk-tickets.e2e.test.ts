// ช่วง 3 · ทำกับ Ticket ทีละหลายเรื่อง + ผูกเหตุขัดข้อง · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let sam: Staff;
let sue: Staff;
let ws: Customer;
let mail: Mailer;
const ids: string[] = [];
const waitJob = async (st: Staff, id: string) => {
  for (let i = 0; i < 50; i++) {
    const r = (await st.agent.get(`/ops/tickets/bulk/${id}`)).body;
    if (r.status === 'done') return r;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error('งานไม่จบ');
};

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  sue = await staff(t, 'sue@friday.example.com', 'Sue Support', 'support');
  ws = await customer(t, 'bulk-demo', { plan: 'team_m', status: 'active' });
  for (let i = 0; i < 4; i++) {
    const r = await sam.agent.post('/ops/tickets').send({ workspaceId: ws.id, requesterEmail: `user${i}@bulk-demo.example.com`, channel: 'email', subject: `LINE ไม่เด้ง ${i}`, body: 'แจ้งเตือน LINE ไม่มา', notify: false, assignToMe: true });
    ids.push(r.body.ticket.id);
  }
  // เปิดเรื่องมาแล้ว 1 ชม. (ข้อความแรกตอนเปิดไม่นับเป็น "ลูกค้าเพิ่งตอบ")
  await t.owner.query(`UPDATE support_tickets SET created_at = now() - interval '1 hour'`);
  await t.owner.query(`UPDATE support_ticket_messages SET created_at = now() - interval '1 hour'`);
});
afterAll(() => t.close());

describe('ทำทีละหลายเรื่อง', () => {
  it('ผูกเหตุขัดข้องตามตัวกรอง · ตัวกรอง incident เห็นทุกเรื่อง · เรื่องเดิมที่ผูกแล้วข้าม', async () => {
    const inc = (await t.owner.query(`INSERT INTO incidents (title) VALUES ('LINE ล่าช้า') RETURNING id`)).rows[0].id as string;
    await sam.agent.put(`/ops/tickets/${ids[0]}/incident`).send({ incidentId: inc }).expect(200);
    const pre = (await sam.agent.post('/ops/tickets/bulk/preview').send({ filter: { q: 'LINE ไม่เด้ง' }, action: { type: 'incident', incidentId: inc } }).expect(200)).body;
    expect(pre).toMatchObject({ total: 4, eligible: 3, customerFacing: false });
    expect(pre.skipped).toEqual([expect.objectContaining({ id: ids[0], reason: 'no_change' })]);
    // ไม่ถึงลูกค้า = ไม่ต้องพิมพ์จำนวน
    const job = (await sam.agent.post('/ops/tickets/bulk').send({ filter: { q: 'LINE ไม่เด้ง' }, action: { type: 'incident', incidentId: inc } }).expect(202)).body;
    const done = await waitJob(sam, job.id);
    expect(done.ok).toHaveLength(3);
    expect((await sam.agent.get(`/ops/tickets?incident=${inc}`)).body.total).toBe(4);
    expect((await sam.agent.get(`/ops/tickets/${ids[1]}`)).body.ticket.incident).toMatchObject({ id: inc, title: 'LINE ล่าช้า' });
    expect((await sue.agent.get(`/ops/tickets/bulk/${job.id}`)).status).toBe(404);
    const audit = await t.owner.query(`SELECT count(*)::int AS n FROM staff_audit_logs WHERE action = 'support.bulk'`);
    expect(audit.rows[0].n).toBe(1);
  });

  it('ตอบด้วยข้อความเดียวกันแทนตัวแปรทีละเรื่อง · ต้องพิมพ์จำนวนให้ตรง · ข้ามเรื่องที่ลูกค้าเพิ่งตอบและที่เพื่อนกำลังพิมพ์', async () => {
    await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, body) VALUES ($1, 'customer', 'ยังไม่ได้เลยค่ะ')`, [ids[2]]);
    await sue.agent.post('/ops/presence').send({ type: 'ticket', id: ids[3], mode: 'typing' }).expect(200);
    const action = { type: 'reply', body: 'เรียนคุณ{ชื่อผู้แจ้ง} เรื่อง {เลข Ticket} ทีมกำลังแก้ไข' };
    const pre = (await sam.agent.post('/ops/tickets/bulk/preview').send({ ids, action }).expect(200)).body;
    expect(pre).toMatchObject({ eligible: 2, customerFacing: true });
    expect(pre.sample.body).toMatch(/^เรียนคุณuser0 เรื่อง #\d+ ทีมกำลังแก้ไข$/);
    expect(pre.skipped.map((x: { reason: string }) => x.reason).sort()).toEqual(['just_replied', 'typing']);
    expect(pre.skipped.find((x: { reason: string }) => x.reason === 'typing').message).toBe('Sue Support กำลังพิมพ์ตอบ');
    const wrong = await sam.agent.post('/ops/tickets/bulk').send({ ids, action, confirmCount: 4 });
    expect(wrong.body.error).toMatchObject({ code: 'count_mismatch', details: { eligible: 2 } });
    const before = mail.sent.length;
    const job = (await sam.agent.post('/ops/tickets/bulk').send({ ids, action, confirmCount: 2 }).expect(202)).body;
    const done = await waitJob(sam, job.id);
    expect(done.ok).toHaveLength(2);
    expect(done.skipped).toHaveLength(2);
    const sent = mail.sent.slice(before);
    expect(sent.map((m) => m.to).sort()).toEqual(['user0@bulk-demo.example.com', 'user1@bulk-demo.example.com']);
    expect(sent[0].text).toContain('ทีมกำลังแก้ไข');
  });

  it('เปลี่ยนความสำคัญ · ปิดเรื่องที่ผูกเหตุขัดข้องทั้งชุดพร้อมข้อความปิดเรื่อง · เกิน 1,000 / ไม่มีเป้าหมาย / ไม่มีสิทธิ์', async () => {
    const pr = (await sam.agent.post('/ops/tickets/bulk').send({ ids: [ids[0], ids[1]], action: { type: 'priority', priority: 'urgent' } }).expect(202)).body;
    expect((await waitJob(sam, pr.id)).ok).toHaveLength(2);
    expect((await sam.agent.get('/ops/tickets?priority=urgent')).body.total).toBe(2);
    const inc = (await sam.agent.get(`/ops/tickets/${ids[0]}`)).body.ticket.incident.id;
    await t.owner.query(`DELETE FROM ops_presence`);
    await t.owner.query(`UPDATE support_ticket_messages SET created_at = now() - interval '10 minutes' WHERE author_kind = 'customer'`);
    const action = { type: 'solve', outcome: 'ระบบ LINE กลับมาปกติแล้ว ขออภัยในความไม่สะดวก', cause: 'LINE ล่าช้า (เหตุขัดข้อง)', sendCsat: false };
    const pre = (await sam.agent.post('/ops/tickets/bulk/preview').send({ filter: { incident: inc }, action }).expect(200)).body;
    expect(pre.eligible).toBe(4);
    const job = (await sam.agent.post('/ops/tickets/bulk').send({ filter: { incident: inc }, action, confirmCount: 4 }).expect(202)).body;
    expect((await waitJob(sam, job.id)).ok).toHaveLength(4);
    expect((await sam.agent.get(`/ops/tickets?status=solved&incident=${inc}`)).body.total).toBe(4);
    const list = (await sam.agent.get('/ops/incidents')).body.items.find((x: { id: string }) => x.id === inc);
    expect(list.tickets).toEqual({ total: 4, open: 0 });
    expect((await sam.agent.post('/ops/tickets/bulk/preview').send({ ids: Array.from({ length: 1001 }, () => ids[0]), action })).status).toBe(400);
    expect((await sam.agent.post('/ops/tickets/bulk').send({ ids: [ids[0], ids[1]], action: { type: 'priority', priority: 'urgent' } })).body.error.code).toBe('nothing_to_do');
    expect((await sam.agent.post('/ops/tickets/bulk/preview').send({ action })).status).toBe(400);
    const fin = await staff(t, 'fin@friday.example.com', 'Fin', 'finance');
    expect((await fin.agent.post('/ops/tickets/bulk/preview').send({ ids, action })).status).toBe(403);
  });
});
