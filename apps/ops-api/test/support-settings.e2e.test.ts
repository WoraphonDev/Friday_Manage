// O22 · ตั้งค่าการแจกงาน Support · ข้อความสำเร็จรูป · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { BusinessClock } from '../src/support/clock.js';
import { DEFAULT_CONFIG, type SupportConfig } from '../src/support/settings.service.js';
import { TicketsService } from '../src/support/tickets.service.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let owner: Staff;
let s1: Staff;
let s2: Staff;
let s3: Staff;
let finance: Staff;
let team: Customer;
let ent: Customer;
const bkk = (iso: string) => new Date(`${iso}+07:00`);
const ticket = (who: Staff, ws: Customer, body: Record<string, unknown>) =>
  who.agent.post('/ops/tickets').send({ workspaceId: ws.id, requesterEmail: `owner@${ws.slug}.example.com`, subject: 'เรื่องทดสอบการแจกงาน', body: 'รายละเอียดสมมติ', notify: false, ...body });
const save = (config: Partial<SupportConfig>, agents: unknown[] = []) => owner.agent.put('/ops/support/settings').send({ config: { ...DEFAULT_CONFIG, ...config }, agents });

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', ['owner']);
  s1 = await staff(t, 's1@friday.example.com', 'Ann Support', 'support');
  s2 = await staff(t, 's2@friday.example.com', 'Ben Support', 'support');
  s3 = await staff(t, 's3@friday.example.com', 'Cat Lead', 'support');
  finance = await staff(t, 'fin@friday.example.com', 'Fin Finance', 'finance');
  team = await customer(t, 'route-team', { plan: 'team_m', status: 'active' });
  ent = await customer(t, 'route-ent', { plan: 'enterprise', status: 'active' });
  // วันหยุดราชการในปฏิทินของระบบ (สมมติ)
  const cal = (await t.owner.query(`INSERT INTO holiday_calendars (name, source) VALUES ('วันหยุดราชการ (ทดสอบ)', 'bot') RETURNING id`)).rows[0].id;
  await t.owner.query(`INSERT INTO holidays (calendar_id, date, name) VALUES ($1, '2026-12-07', 'วันหยุดชดเชยสมมติ')`, [cal]);
});
afterAll(() => t.close());

describe('เวลาทำการ', () => {
  it('ข้ามวันหยุด · วันทำการ = วันทำการที่ N เวลาเดิม · ตั้งเวลาเองได้', () => {
    const holidays = new Set(['2026-12-07']);
    const c = new BusinessClock(undefined, holidays);
    // ศุกร์ 17:00 + 2 ชม. → จันทร์ 7 ธ.ค. หยุด → อังคาร 10:00
    expect(c.addHours(bkk('2026-12-04T17:00:00'), 2).toISOString()).toBe(bkk('2026-12-08T10:00:00').toISOString());
    // พฤหัส 10:00 + 2 วันทำการ → ศุกร์ (1) → อังคาร (2) 10:00
    expect(c.addDays(bkk('2026-12-03T10:00:00'), 2).toISOString()).toBe(bkk('2026-12-08T10:00:00').toISOString());
    // นอกเวลา (20:00) เริ่มนับวันทำการถัดไป 09:00
    expect(c.addDays(bkk('2026-12-02T20:00:00'), 1).toISOString()).toBe(bkk('2026-12-04T09:00:00').toISOString());
    expect(c.isOpen(bkk('2026-12-07T10:00:00'))).toBe(false);
    const sat = new BusinessClock(DEFAULT_CONFIG.hours.map((h, i) => (i === 5 ? { open: true, from: '10:00', to: '12:00' } : h)));
    expect(sat.addHours(bkk('2026-12-04T17:30:00'), 1).toISOString()).toBe(bkk('2026-12-05T10:30:00').toISOString());
  });
});

describe('หน้าตั้งค่า', () => {
  it('ค่าเริ่มต้นตาม Canvas · Support ดูได้แต่แก้ไม่ได้ · การเงินเปิดไม่ได้', async () => {
    const r = await s1.agent.get('/ops/support/settings');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ canEdit: false, warnPct: 25, config: { mode: 'least', defaultCap: 8, reopenDays: 7, onAway: 'queue', sla: { team_l: { first: { n: 2, unit: 'h' } }, free: { resolve: null } } }, holidays: { count: 1 } });
    expect(r.body.agents.map((a: { name: string }) => a.name)).toEqual(['Ann Support', 'Ben Support', 'Cat Lead']);
    expect((await owner.agent.get('/ops/support/settings')).body.canEdit).toBe(true);
    expect((await finance.agent.get('/ops/support/settings')).status).toBe(403);
    expect((await s1.agent.put('/ops/support/settings').send({ config: DEFAULT_CONFIG })).status).toBe(403);
  });

  it('Owner บันทึก: ตรวจเวลา · กลุ่ม/เพดานรายคน · Audit สรุปสิ่งที่เปลี่ยน · ไม่เปลี่ยนไม่บันทึก', async () => {
    const bad = await save({ hours: DEFAULT_CONFIG.hours.map((h) => ({ ...h, to: '08:00' })) });
    expect(bad.status).toBe(400);
    const r = await save({ defaultCap: 2, sla: { ...DEFAULT_CONFIG.sla, team_m: { first: { n: 3, unit: 'h' }, resolve: { n: 2, unit: 'd' } } } }, [
      { staffId: s1.id, groups: ['l1'], cap: null },
      { staffId: s2.id, groups: ['l2'], cap: 3 },
      { staffId: s3.id, groups: ['l1', 'lead'], cap: null },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.saved).toBe(true);
    expect(r.body.changes).toEqual(expect.arrayContaining(['เพดานค่าเริ่มต้น 8 → 2', 'SLA Team M: ตอบ 4 ชม.ทำการ → 3 ชม.ทำการ · ปิด 3 วันทำการ → 2 วันทำการ', 'Ben Support: กลุ่ม ระดับ 2 · เพดาน 3']));
    expect((await save({ defaultCap: 2, sla: { ...DEFAULT_CONFIG.sla, team_m: { first: { n: 3, unit: 'h' }, resolve: { n: 2, unit: 'd' } } } })).body.saved).toBe(false);
    expect((await save({}, [{ staffId: finance.id, groups: ['fin'], cap: null }])).body.error.code).toBe('agent_invalid');
    const audit = await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = 'support.settings_updated'`);
    expect(audit.rows).toHaveLength(1);
    const view = (await owner.agent.get('/ops/support/settings')).body;
    expect(view.updatedBy).toBe('Olive Owner');
    expect(view.agents.find((a: { name: string }) => a.name === 'Ben Support')).toMatchObject({ groups: ['l2'], cap: 3 });
  });
});

describe('กฎแยกตามประเภท (T6)', () => {
  const ids: Record<string, string> = {};
  it('เพิ่มกฎ: ใส่ก่อนข้อ "เรื่องอื่นทั้งหมด" · นับ Ticket ที่ตรง · Support เพิ่มไม่ได้', async () => {
    const add = (body: Record<string, unknown>) => owner.agent.post('/ops/support/rules').send(body);
    ids.all = (await add({ target: 'all' })).body.rule.id;
    ids.l2 = (await add({ categories: ['bug', 'import'], target: 'l2', priority: 'high' })).body.rule.id;
    ids.acct = (await add({ plans: ['enterprise'], target: 'acct', priority: 'high' })).body.rule.id;
    const list = (await owner.agent.get('/ops/support/settings')).body.rules.map((r: { id: string }) => r.id);
    expect(list).toEqual([ids.l2, ids.acct, ids.all]);
    expect((await s1.agent.post('/ops/support/rules').send({ target: 'l1' })).status).toBe(403);
    expect((await add({ target: 'nobody' })).status).toBe(400);
    expect((await owner.agent.post('/ops/support/rules/preview').send({ categories: ['bug'], target: 'l2' })).body).toEqual({ matches: 0 });
  });

  it('เรียงใหม่ต้องครบ · ปิด/เปิดกฎ · ลงประวัติ', async () => {
    expect((await owner.agent.post('/ops/support/rules/reorder').send({ ids: [ids.acct, ids.l2] })).body.error.code).toBe('rules_mismatch');
    const r = await owner.agent.post('/ops/support/rules/reorder').send({ ids: [ids.acct, ids.l2, ids.all] });
    expect(r.body.rules.map((x: { id: string }) => x.id)).toEqual([ids.acct, ids.l2, ids.all]);
    expect((await owner.agent.patch(`/ops/support/rules/${ids.all}`).send({ enabled: false })).body.rule.enabled).toBe(false);
    await owner.agent.patch(`/ops/support/rules/${ids.all}`).send({ enabled: true });
    const n = await t.owner.query(`SELECT action FROM staff_audit_logs WHERE action LIKE 'support.rule%' ORDER BY created_at`);
    expect(n.rows.map((x) => x.action)).toEqual(['support.rule_created', 'support.rule_created', 'support.rule_created', 'support.rules_reordered', 'support.rule_toggled', 'support.rule_toggled']);
  });

  it('แจกงาน: ตรงข้อแรก → กลุ่ม + ความสำคัญเริ่มต้น · ระบุความสำคัญเองได้ · ผู้ดูแลบัญชีไม่ว่าง = คิวกลาง', async () => {
    const bug = await ticket(s1, team, { category: 'bug' });
    expect(bug.status, JSON.stringify(bug.body)).toBe(201);
    expect(bug.body.ticket).toMatchObject({ assigneeId: s2.id, priority: 'high', ruleId: ids.l2 });
    // SLA Team M ที่ตั้งไว้ = 3 ชม. ทำการ (ความสำคัญ "สูง" ยังนับเวลาทำการ)
    const clock = new BusinessClock(undefined, new Set(['2026-12-07']));
    expect(Math.abs(new Date(bug.body.ticket.firstResponseDueAt).getTime() - clock.addHours(new Date(bug.body.ticket.createdAt), 3).getTime())).toBeLessThan(1000);

    const how = await ticket(s1, team, { category: 'how_to', priority: 'low' });
    expect(how.body.ticket).toMatchObject({ priority: 'low', ruleId: ids.all });
    expect([s1.id, s3.id]).toContain(how.body.ticket.assigneeId);

    // Enterprise ยังไม่มีผู้ดูแลประจำบัญชี → คิวกลาง
    const e1 = await ticket(s1, ent, { category: 'bug' });
    expect(e1.body.ticket).toMatchObject({ assigneeId: null, priority: 'high', ruleId: ids.acct });
    expect((await s1.agent.put(`/ops/support/agents/${s2.id}/accounts`).send({ workspaceIds: [ent.id] })).status).toBe(403);
    const acc = await owner.agent.put(`/ops/support/agents/${s2.id}/accounts`).send({ workspaceIds: [ent.id] });
    expect(acc.body.accounts).toEqual([{ id: ent.id, name: 'Co route-ent' }]);
    const e2 = await ticket(s1, ent, { category: 'how_to' });
    expect(e2.body.ticket.assigneeId).toBe(s2.id);
    const detail = (await s2.agent.get(`/ops/tickets/${e2.body.ticket.id}`)).body;
    expect(detail.customer.accountManager).toBe('Ben Support');
    expect(detail.ticket.requesterName).toBe('owner');
    // Ben งานเต็มเพดาน 3 แล้ว → เรื่องของบัญชีที่ดูแลเข้าคิวกลาง
    await ticket(s1, ent, { category: 'how_to' });
    const full = await ticket(s1, ent, { category: 'how_to' });
    expect(full.body.ticket.assigneeId).toBeNull();
  });
});

describe('สถานะพนักงาน', () => {
  it('ไม่ว่าง = ไม่ได้งานใหม่ · ออฟไลน์คืนงานที่รอทีมตอบเข้าคิว · ทีมตอนนี้', async () => {
    await t.owner.query(`DELETE FROM support_rules`);
    await t.owner.query(`UPDATE support_tickets SET status = 'solved', solved_at = now()`);
    expect((await s1.agent.put('/ops/support/presence').send({ presence: 'busy', note: 'ประชุมถึง 11:00' })).body).toMatchObject({ presence: 'busy', released: 0 });
    const a = await ticket(s3, team, {});
    expect(a.body.ticket.assigneeId).toBe(s2.id);
    const b = await ticket(s3, team, {});
    expect(b.body.ticket.assigneeId).toBe(s3.id);
    await s3.agent.post(`/ops/tickets/${b.body.ticket.id}/messages`).send({ body: 'ได้รับแล้วครับ' }); // รอลูกค้า → ไม่คืนคิว
    // งานเท่ากัน → เรียงตามชื่อ
    expect((await ticket(s2, team, {})).body.ticket.assigneeId).toBe(s2.id);
    const d = await ticket(s2, team, {});
    expect(d.body.ticket.assigneeId).toBe(s3.id);
    const off = await s3.agent.put('/ops/support/presence').send({ presence: 'leave' });
    expect(off.body).toMatchObject({ presence: 'leave', released: 1 });
    expect((await t.owner.query(`SELECT assignee_id FROM support_tickets WHERE id = $1`, [d.body.ticket.id])).rows[0].assignee_id).toBeNull();
    expect((await t.owner.query(`SELECT assignee_id FROM support_tickets WHERE id = $1`, [b.body.ticket.id])).rows[0].assignee_id).toBe(s3.id);
    const now = (await owner.agent.get('/ops/support/team')).body;
    expect(now.items.map((x: { name: string; presence: string; load: number; cap: number }) => [x.name, x.presence, x.load, x.cap])).toEqual([
      ['Ann Support', 'busy', 0, 2],
      ['Ben Support', 'online', 2, 3],
      ['Cat Lead', 'leave', 1, 2],
    ]);
    expect((await owner.agent.put('/ops/support/presence').send({ presence: 'online' })).status).toBe(403);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM staff_audit_logs WHERE action = 'support.presence_changed'`)).rows[0].n).toBe(2);
  });

  it('ถามหัวหน้าทีมก่อน: อีเมลหัวหน้าทีม ไม่คืนงาน · วนตามลำดับ · ไม่แจกอัตโนมัติ', async () => {
    await save({ defaultCap: 5, onAway: 'ask_lead', mode: 'round' }, [{ staffId: s2.id, groups: ['l2'], cap: 5 }]);
    await s1.agent.put('/ops/support/presence').send({ presence: 'online' });
    await s3.agent.put('/ops/support/presence').send({ presence: 'online' });
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await ticket(s1, team, {})).body.ticket.assigneeId);
    expect(new Set(got).size).toBe(3);
    const before = mail.sent.length;
    const r = await s1.agent.put('/ops/support/presence').send({ presence: 'offline' });
    expect(r.body).toMatchObject({ released: 0, leadsNotified: 1 });
    expect(mail.sent.slice(before).map((m) => m.to)).toEqual(['s3@friday.example.com']);
    await save({ defaultCap: 5, onAway: 'ask_lead', mode: 'manual' });
    expect((await ticket(s2, team, {})).body.ticket.assigneeId).toBeNull();
  });
});

describe('SLA', () => {
  it('ด่วนนับ 24 ชม. · เหลือ 25% เตือนผู้รับผิดชอบ · เกินแจ้งหัวหน้าทีม · ไม่ส่งซ้ำ · เกินขึ้นบนสุดของคิว', async () => {
    const u = await ticket(s2, team, { priority: 'urgent', assignToMe: true });
    const k = u.body.ticket;
    expect(new Date(k.firstResponseDueAt).getTime() - new Date(k.createdAt).getTime()).toBeLessThan(3_600_000 + 1000);
    const svc = t.app.get(TicketsService);
    const created = new Date(k.createdAt);
    const before = mail.sent.length;
    // ผ่านไป 50 นาทีจาก 60 → เหลือไม่ถึง 25%
    expect(await svc.slaTick(new Date(created.getTime() + 50 * 60_000))).toMatchObject({ warned: 1, breached: 0 });
    expect(await svc.slaTick(new Date(created.getTime() + 55 * 60_000))).toMatchObject({ warned: 0, breached: 0 });
    expect(mail.sent.slice(before).map((m) => [m.to, m.subject])).toEqual([['s2@friday.example.com', `[#${k.number}] ใกล้เกิน SLA ตอบครั้งแรก`]]);
    expect(await svc.slaTick(new Date(created.getTime() + 61 * 60_000))).toMatchObject({ breached: 1 });
    expect(mail.sent.at(-1)).toMatchObject({ to: 's3@friday.example.com', subject: `[#${k.number}] เกิน SLA ตอบครั้งแรก` });
    expect(await svc.slaTick(new Date(created.getTime() + 90 * 60_000))).toMatchObject({ warned: 0, breached: 0 });
    await t.owner.query(`UPDATE support_tickets SET first_response_due_at = now() - interval '1 minute' WHERE id = $1`, [k.id]);
    const list = (await s2.agent.get('/ops/tickets')).body.items;
    expect(list[0]).toMatchObject({ id: k.id, slaBreached: true });
  });

  it('ลูกค้าตอบหลังปิดเรื่องภายใน N วันที่ตั้งไว้ · เกินปิดถาวร', async () => {
    await save({ reopenDays: 3, mode: 'manual' });
    const k = (await ticket(s2, team, { assignToMe: true })).body.ticket;
    await s2.agent.post(`/ops/tickets/${k.id}/solve`).send({ outcome: 'แก้แล้ว', cause: 'ตั้งค่าผิด' });
    expect(mail.sent.at(-1)!.text).toContain('ภายใน 3 วัน');
    await t.owner.query(`UPDATE support_tickets SET solved_at = now() - interval '2 days' WHERE id = $1`, [k.id]);
    expect((await s2.agent.post(`/ops/tickets/${k.id}/messages`).send({ body: 'ยังไม่หาย', fromCustomer: true })).body).toMatchObject({ reopened: true });
    expect((await t.owner.query(`SELECT assignee_id FROM support_tickets WHERE id = $1`, [k.id])).rows[0].assignee_id).toBe(s2.id);
    await s2.agent.post(`/ops/tickets/${k.id}/solve`).send({ outcome: 'แก้แล้ว', cause: 'ตั้งค่าผิด' });
    await t.owner.query(`UPDATE support_tickets SET solved_at = now() - interval '4 days' WHERE id = $1`, [k.id]);
    expect((await t.app.get(TicketsService).closeStale()).closed).toBeGreaterThanOrEqual(1);
  });
});

describe('ข้อความสำเร็จรูป (T4)', () => {
  it('Owner จัดการ · Support ใช้และนับครั้ง · เลิกใช้แล้วซ่อน · Audit', async () => {
    const c = await owner.agent.post('/ops/support/canned-replies').send({ title: 'Webhook ล้ม: ปลายทางถูกลบ', body: 'สวัสดีครับคุณ{ชื่อผู้แจ้ง} เรื่อง #{เลข Ticket} ของ {ชื่อ Workspace}', tag: 'webhook' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = c.body.item.id;
    expect((await s1.agent.post('/ops/support/canned-replies').send({ title: 'x1', body: 'yy' })).status).toBe(403);
    expect((await s1.agent.post(`/ops/support/canned-replies/${id}/use`).send({})).body).toEqual({ uses: 1 });
    expect((await s1.agent.post(`/ops/support/canned-replies/${id}/use`).send({})).body).toEqual({ uses: 2 });
    expect((await s1.agent.get('/ops/support/canned-replies')).body.items).toEqual([expect.objectContaining({ id, uses: 2, tag: 'webhook', updatedBy: 'Olive Owner' })]);
    await owner.agent.patch(`/ops/support/canned-replies/${id}`).send({ title: 'Webhook ล้ม: ปลายทางถูกลบ', body: 'ข้อความใหม่', tag: 'webhook' });
    await owner.agent.post(`/ops/support/canned-replies/${id}/archive`).send({});
    expect((await s1.agent.get('/ops/support/canned-replies')).body.items).toEqual([]);
    expect((await owner.agent.get('/ops/support/canned-replies?archived=true')).body.items).toHaveLength(1);
    expect((await s1.agent.post(`/ops/support/canned-replies/${id}/use`).send({})).body.error.code).toBe('canned_archived');
    await owner.agent.post(`/ops/support/canned-replies/${id}/restore`).send({});
    const a = await t.owner.query(`SELECT action FROM staff_audit_logs WHERE action LIKE 'support.canned%' ORDER BY created_at`);
    expect(a.rows.map((x) => x.action)).toEqual(['support.canned_created', 'support.canned_updated', 'support.canned_archived', 'support.canned_restored']);
  });
});
