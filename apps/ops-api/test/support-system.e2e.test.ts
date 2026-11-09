// O04 · Ticket สถานะระบบ เหตุขัดข้อง ปิดปรับปรุง งานที่ล้ม · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { addBusinessHours, TicketsService } from '../src/support/tickets.service.js';
import { SystemService } from '../src/system/system.service.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let owner: Staff;
let support: Staff;
let support2: Staff;
let finance: Staff;
let engineer: Staff;
let c: Customer;
const DAY = 86_400_000;
/** ส่วนที่ใช้คิวจริงรันเมื่อตั้ง VALKEY_URL (แบบเดียวกับ apps/api/test/queue.e2e.test.ts) · `docker compose up -d valkey` */
const VALKEY = process.env.VALKEY_URL;
const PREFIX = `ops-test-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  if (VALKEY) process.env.QUEUE_PREFIX = PREFIX;
  process.env.API_HEALTH_URL = 'http://127.0.0.1:9/healthz'; // ไม่มีอะไรฟัง → ตรวจไม่ผ่าน
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  support2 = await staff(t, 'support2@friday.example.com', 'Sue Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  c = await customer(t, 'ticket-demo', { plan: 'team_m', status: 'active' });
});
afterAll(async () => {
  if (VALKEY) {
    const q = new Queue('jobs', { connection: { url: VALKEY! }, prefix: PREFIX });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
  await t.close();
  delete process.env.QUEUE_PREFIX;
});

describe('ชั่วโมงทำการ', () => {
  it('ศุกร์ 17:00 + 2 ชม. = จันทร์ 10:00 · ก่อน 09:00 เริ่มนับ 09:00 · เสาร์เลื่อนไปจันทร์', () => {
    const bkk = (iso: string) => new Date(`${iso}+07:00`);
    expect(addBusinessHours(bkk('2026-11-13T17:00:00'), 2).toISOString()).toBe(bkk('2026-11-16T10:00:00').toISOString());
    expect(addBusinessHours(bkk('2026-11-10T07:30:00'), 4).toISOString()).toBe(bkk('2026-11-10T13:00:00').toISOString());
    expect(addBusinessHours(bkk('2026-11-14T12:00:00'), 1).toISOString()).toBe(bkk('2026-11-16T10:00:00').toISOString());
    expect(addBusinessHours(bkk('2026-11-10T10:00:00'), 24).toISOString()).toBe(bkk('2026-11-12T16:00:00').toISOString());
  });
});

describe('Ticket', () => {
  let id = '';

  it('สร้าง (T1): SLA ตามแพ็กเกจ · อีเมลยืนยันถึงลูกค้า · เข้าคิวกลาง · การเงินเปิดไม่ได้', async () => {
    const before = mail.sent.length;
    const r = await support.agent.post('/ops/tickets').send({ workspaceId: c.id, requesterEmail: 'Owner@ticket-demo.example.com', channel: 'phone', category: 'notifications', priority: 'high', subject: 'Webhook ไม่ส่งเข้า Discord', body: 'ลูกค้าโทรมาแจ้งว่า Bug ใหม่ไม่เข้า dev-alerts ตั้งแต่เช้า' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    id = r.body.ticket.id;
    expect(r.body.ticket).toMatchObject({ status: 'open', assigneeId: null, requesterEmail: 'owner@ticket-demo.example.com', requesterUserId: c.owner });
    // Team M ตอบภายใน 4 ชม. ทำการ
    expect(new Date(r.body.ticket.firstResponseDueAt).toISOString()).toBe(addBusinessHours(new Date(r.body.ticket.createdAt), 4).toISOString());
    expect(r.body.notified).toBe(true);
    expect(mail.sent.slice(before)[0].subject).toContain(`#${r.body.ticket.number}`);
    const q = await support.agent.get('/ops/tickets?assignee=none');
    expect(q.body.items.map((x: { id: string }) => x.id)).toEqual([id]);
    expect(q.body.summary).toMatchObject({ open: 1, unassigned: 1 });
    expect((await finance.agent.get('/ops/tickets')).status).toBe(403);
    expect((await engineer.agent.post('/ops/tickets').send({ requesterEmail: 'a@example.com', subject: 'xxx', body: 'y' })).status).toBe(403);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'support.ticket_created'`, [c.id])).rows[0].n).toBe(1);
  });

  it('รับเรื่อง · คนอื่นรับซ้ำไม่ได้ · โอน (T2) ให้ Support เท่านั้น · คืนคิวได้เฉพาะเจ้าของ', async () => {
    expect((await support.agent.post(`/ops/tickets/${id}/claim`).send({})).body).toEqual({ id, assigneeId: support.id });
    expect((await support2.agent.post(`/ops/tickets/${id}/claim`).send({})).body.error.code).toBe('ticket_assigned');
    expect((await support.agent.post(`/ops/tickets/${id}/assign`).send({ staffId: finance.id })).body.error.code).toBe('assignee_invalid');
    expect((await support2.agent.post(`/ops/tickets/${id}/assign`).send({ staffId: support2.id })).body.error.code).toBe('not_assignee');
    expect((await support.agent.post(`/ops/tickets/${id}/assign`).send({ staffId: support2.id, note: 'ลูกค้าส่งไฟล์มาแล้ว' })).body).toEqual({ id, assigneeId: support2.id });
    expect((await support.agent.post(`/ops/tickets/${id}/release`).send({})).body.error.code).toBe('not_assignee');
    expect((await support2.agent.get('/ops/tickets?assignee=me')).body.items).toHaveLength(1);
  });

  it('ตอบลูกค้า: ส่งอีเมล นับเวลาตอบครั้งแรก รอลูกค้า · บันทึกภายในไม่ส่ง · ลูกค้าตอบ → เปิด', async () => {
    const before = mail.sent.length;
    const r = await support2.agent.post(`/ops/tickets/${id}/messages`).send({ body: 'ได้รับแล้วครับ กำลังตรวจประวัติการส่ง' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sent).toBe(true);
    const n = await support2.agent.post(`/ops/tickets/${id}/messages`).send({ body: 'ปลายทาง 404 · @Sam ช่วยดู', internal: true });
    expect(n.body.sent).toBe(false);
    expect(mail.sent.length - before).toBe(1);
    let d = (await support.agent.get(`/ops/tickets/${id}`)).body;
    expect(d.ticket).toMatchObject({ status: 'pending_customer', firstRespondedAt: expect.any(String), assignee: { id: support2.id } });
    expect(d.messages.map((m: { authorKind: string; internal: boolean }) => [m.authorKind, m.internal])).toEqual([['customer', false], ['staff', true], ['staff', false], ['staff', true]]);
    expect(d.customer).toMatchObject({ slug: 'ticket-demo', plan: 'team_m', tickets90d: 1, accessGranted: false, sla: { first: 4 } });
    await support2.agent.post(`/ops/tickets/${id}/messages`).send({ body: 'ลูกค้าโทรกลับมาบอกว่าลบช่องใน Discord ไปแล้ว', fromCustomer: true });
    d = (await support.agent.get(`/ops/tickets/${id}`)).body;
    expect(d.ticket.status).toBe('open');
    expect((await support2.agent.post(`/ops/tickets/${id}/messages`).send({ body: 'x', internal: true, fromCustomer: true })).status).toBe(400);
  });

  it('ส่งต่อทีมพัฒนา (T3) · ปิด (T5) พร้อมสาเหตุ · คะแนน · ตอบภายใน 7 วันเปิดใหม่ · เกิน 7 วันปิดถาวร', async () => {
    const e = await support2.agent.post(`/ops/tickets/${id}/escalate`).send({ severity: 'S2', steps: '1. สร้างงานใหม่ 2. ดูช่อง dev-alerts', requestId: 'req_44a1f0' });
    expect(e.body).toMatchObject({ status: 'pending_dev', sent: true });
    expect((await support.agent.post(`/ops/tickets/${id}/csat`).send({ score: 5 })).body.error.code).toBe('ticket_not_solved');
    const before = mail.sent.length;
    const s = await support2.agent.post(`/ops/tickets/${id}/solve`).send({ outcome: 'ลูกค้าเชื่อม Webhook ใหม่แล้ว', cause: 'ปลายทางถูกลบที่ Discord' });
    expect(s.body).toMatchObject({ status: 'solved', sent: true });
    expect(mail.sent.slice(before)[0].text).toContain('1–5');
    expect((await t.owner.query(`SELECT cause FROM support_tickets WHERE id = $1`, [id])).rows[0].cause).toBe('ปลายทางถูกลบที่ Discord');
    expect((await support2.agent.post(`/ops/tickets/${id}/csat`).send({ score: 5 })).body).toEqual({ id, csat: 5 });

    const re = await support2.agent.post(`/ops/tickets/${id}/messages`).send({ body: 'ยังไม่เข้าอีกแล้วค่ะ', fromCustomer: true });
    expect(re.body).toMatchObject({ status: 'open', reopened: true });
    await support2.agent.post(`/ops/tickets/${id}/solve`).send({ outcome: 'เชื่อมใหม่อีกครั้ง', cause: 'ปลายทางถูกลบที่ Discord' });
    await t.owner.query(`UPDATE support_tickets SET solved_at = now() - interval '8 days' WHERE id = $1`, [id]);
    expect((await support2.agent.post(`/ops/tickets/${id}/messages`).send({ body: 'อีกเรื่อง', fromCustomer: true })).body.error.code).toBe('ticket_closed');
    expect(await t.app.get(TicketsService).closeStale()).toEqual({ closed: 1 });
    expect((await support2.agent.post(`/ops/tickets/${id}/messages`).send({ body: 'x' })).body.error.code).toBe('ticket_closed');
    const stats = await owner.agent.get('/ops/tickets/stats');
    expect(stats.body.items[0]).toMatchObject({ name: 'Sue Support', solved: 1, csat: 5, withinSlaPct: expect.any(Number) });
  });

  it('เข้าบัญชีเพื่อช่วยเหลือผูก Ticket ในระบบ: ต้องเป็น Ticket ของ Workspace นั้นและยังเปิด', async () => {
    await t.owner.query(`INSERT INTO support_access_grants (workspace_id, granted_by, until) VALUES ($1, $2, now() + interval '1 day')`, [c.id, c.owner]);
    const open = (await support.agent.post('/ops/tickets').send({ workspaceId: c.id, requesterEmail: 'owner@ticket-demo.example.com', subject: 'นำเข้า Excel แล้ววันที่เลื่อน', body: 'วันที่เลื่อนไป 1 วัน', notify: false })).body.ticket;
    const other = await customer(t, 'ticket-other', { plan: 'team_s', status: 'active' });
    const foreign = (await support.agent.post('/ops/tickets').send({ workspaceId: other.id, requesterEmail: 'owner@ticket-other.example.com', subject: 'เรื่องอื่น', body: 'x', notify: false })).body.ticket;
    const url = `/ops/workspaces/${c.id}/support-sessions`;
    expect((await support.agent.post(url).send({ ticketId: foreign.id, reason: 'ตรวจไฟล์นำเข้าที่ลูกค้าแจ้ง' })).body.error.code).toBe('ticket_other_workspace');
    expect((await support.agent.post(url).send({ ticketId: id, reason: 'ตรวจไฟล์นำเข้าที่ลูกค้าแจ้ง' })).body.error.code).toBe('ticket_not_open');
    expect((await support.agent.post(url).send({ reason: 'ไม่มี Ticket เลยสักอัน' })).status).toBe(400);
    const r = await support.agent.post(url).send({ ticketId: open.id, reason: 'ตรวจไฟล์นำเข้าที่ลูกค้าแจ้ง' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.session).toMatchObject({ ticketId: open.id, ticketNo: `#${open.number}` });
  });
});

describe('สถานะระบบ', () => {
  it('ตรวจ API (ล้ม) → uptime 0% · ฐานข้อมูล · คิว · การส่ง · วิศวกร / Owner เท่านั้น', async () => {
    const svc = t.app.get(SystemService);
    expect((await svc.probe()).ok).toBe(false);
    const r = await engineer.agent.get('/ops/system/status');
    expect(r.status).toBe(200);
    expect(r.body.api).toMatchObject({ probes: 1, uptimePct: 0, errorRate: null });
    expect(r.body.api.hours).toHaveLength(24);
    expect(r.body.database.ok).toBe(true);
    expect(r.body.queue).toMatchObject(VALKEY ? { configured: true, failed: expect.any(Number) } : { configured: false });
    expect(r.body.deliveries).toEqual([]);
    expect((await support.agent.get('/ops/system/status')).status).toBe(403);
  });
});

describe('เหตุขัดข้องและหน้าสถานะสาธารณะ', () => {
  let incident = '';
  const anon = () => request(t.app.getHttpServer());

  it('ติดตามหน้าสถานะ: ยืนยันด้วยรหัสก่อน · ไม่ต้องล็อกอิน', async () => {
    const before = mail.sent.length;
    expect((await anon().post('/status/subscribe').send({ email: 'Watcher@example.com' })).body).toEqual({ ok: true });
    const token = /: (\S+)$/.exec(mail.sent.slice(before)[0].text)![1];
    expect((await anon().post('/status/confirm').send({ token: 'wrong-token-123' })).status).toBe(400);
    expect((await anon().post('/status/confirm').send({ token })).body).toEqual({ confirmed: true });
    await anon().post('/status/subscribe').send({ email: 'quitter@example.com' });
  });

  it('เปิดเหตุ (Y3) → หน้าสถานะเห็นทันที + อีเมลผู้ติดตาม · เหตุภายในไม่ขึ้น · การเงินเปิดไม่ได้', async () => {
    const before = mail.sent.length;
    const r = await engineer.agent.post('/ops/incidents').send({ title: 'LINE ส่งแจ้งเตือนช้า', impact: 'minor', services: ['notifications_line'], message: 'กำลังตรวจสอบ ข้อความทยอยส่ง', showBanner: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    incident = r.body.incident.id;
    expect(r.body.notified).toBe(1);
    expect(mail.sent.slice(before).map((m) => m.to)).toEqual(['watcher@example.com']);
    await engineer.agent.post('/ops/incidents').send({ title: 'DB replica lag', services: ['api'], message: 'ภายใน', internal: true });
    const pub = await anon().get('/status');
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ state: 'degraded', banner: 'กำลังตรวจสอบ ข้อความทยอยส่ง' });
    expect(pub.body.incidents.map((i: { title: string }) => i.title)).toEqual(['LINE ส่งแจ้งเตือนช้า']);
    expect(JSON.stringify(pub.body)).not.toContain('ownerId');
    expect((await finance.agent.post('/ops/incidents').send({ title: 'x', services: ['api'], message: 'xxx' })).status).toBe(403);
    expect((await engineer.agent.post('/ops/incidents').send({ title: 'x', services: ['database_internal'], message: 'xxx' })).status).toBe(400);
  });

  it('อัปเดต (Y4) ตามสถานะจนแก้แล้ว · ปิดแล้วอัปเดตไม่ได้', async () => {
    expect((await engineer.agent.post(`/ops/incidents/${incident}/updates`).send({ status: 'monitoring', message: 'ผู้ให้บริการ LINE กลับมาตอบปกติ' })).body).toMatchObject({ status: 'monitoring', notified: 1 });
    expect((await support.agent.post(`/ops/incidents/${incident}/updates`).send({ status: 'resolved', message: 'ข้อความที่ค้างส่งครบแล้ว', notifySubscribers: false })).body).toMatchObject({ status: 'resolved', notified: 0 });
    expect((await engineer.agent.post(`/ops/incidents/${incident}/updates`).send({ status: 'monitoring', message: 'อีกครั้ง' })).body.error.code).toBe('incident_resolved');
    const pub = (await anon().get('/status')).body;
    expect(pub.state).toBe('operational');
    expect(pub.incidents[0]).toMatchObject({ status: 'resolved', updates: [expect.objectContaining({ status: 'resolved' }), expect.any(Object), expect.any(Object)] });
    const list = (await support.agent.get('/ops/incidents')).body;
    expect(list.subscribers).toBe(1);
    expect(list.items).toHaveLength(2);
  });
});

describe('ปิดปรับปรุง', () => {
  it('ขอเปิดทันที → ต้องอนุมัติ (202) · อนุมัติแล้ว active · หน้าสถานะเป็น maintenance · ปลดได้ทันที', async () => {
    const endsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect((await engineer.agent.post('/ops/maintenance').send({ message: 'ย้ายฐานข้อมูล', endsAt: new Date(Date.now() - 1000).toISOString(), reason: 'ย้ายฐานข้อมูล' })).body.error.code).toBe('invalid_window');
    const r = await engineer.agent.post('/ops/maintenance').send({ scope: 'read_only', message: 'ปิดปรับปรุงชั่วคราว ดูข้อมูลได้ แก้ไขไม่ได้', endsAt, reason: 'ย้ายฐานข้อมูล', notifyPlan: 'none' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'system.maintenance' });
    await reauth(owner);
    const ok = await owner.agent.post(`/ops/approvals/${r.body.pendingApproval.id}/approve`).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const m = ok.body.result.maintenance;
    expect(m).toMatchObject({ status: 'active', scope: 'read_only' });
    expect((await request(t.app.getHttpServer()).get('/status')).body).toMatchObject({ state: 'maintenance', banner: 'ปิดปรับปรุงชั่วคราว ดูข้อมูลได้ แก้ไขไม่ได้' });
    // ซ้อนกันไม่ได้: อนุมัติคำขอที่สองแล้วล้ม คำขอยังรออยู่
    const r2 = await engineer.agent.post('/ops/maintenance').send({ message: 'อีกรอบ', endsAt, reason: 'ซ้อน' });
    expect((await owner.agent.post(`/ops/approvals/${r2.body.pendingApproval.id}/approve`).send({})).body.error.code).toBe('maintenance_active');
    expect((await engineer.agent.get('/ops/maintenance')).body.active.id).toBe(m.id);
    expect((await engineer.agent.post(`/ops/maintenance/${m.id}/end`).send({})).body).toEqual({ id: m.id, status: 'done' });
    expect((await engineer.agent.post(`/ops/maintenance/${m.id}/end`).send({})).body.error.code).toBe('maintenance_closed');
    expect((await support.agent.post('/ops/maintenance').send({ message: 'x', endsAt, reason: 'x' })).status).toBe(403);
  });

  it('ตั้งเวลา: scheduled → ถึงเวลา active → เลยเวลา done', async () => {
    const start = new Date(Date.now() + DAY);
    const r = await engineer.agent.post('/ops/maintenance').send({ message: 'อัปเกรดระบบ', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString(), reason: 'อัปเกรด', notifyPlan: '1d' });
    const before = mail.sent.length;
    const ok = await owner.agent.post(`/ops/approvals/${r.body.pendingApproval.id}/approve`).send({});
    expect(ok.body.result.maintenance.status).toBe('scheduled');
    expect(mail.sent.length - before).toBe(1); // ผู้ติดตามหน้าสถานะ
    const svc = t.app.get(SystemService);
    expect(await svc.tickMaintenance(new Date(start.getTime() + 60_000))).toEqual({ started: 1, ended: 0 });
    expect(await svc.tickMaintenance(new Date(start.getTime() + 2 * 3_600_000))).toEqual({ started: 0, ended: 1 });
  });
});

describe.runIf(Boolean(VALKEY))('งานเบื้องหลังที่ล้ม (Valkey จริง)', () => {
  const ids: string[] = [];

  beforeAll(async () => {
    const q = new Queue('jobs', { connection: { url: VALKEY! }, prefix: PREFIX });
    for (const name of ['payments.etax', 'notify.line']) ids.push((await q.add(name, { workspaceId: c.id, n: name }, { attempts: 1 })).id!);
    const worker = new Worker('jobs', async () => {
      throw new Error('ผู้ให้บริการตอบ 500');
    }, { connection: { url: VALKEY! }, prefix: PREFIX });
    await new Promise<void>((resolve) => {
      let n = 0;
      worker.on('failed', () => ++n === 2 && resolve());
    });
    await worker.close();
    await q.close();
  });

  it('รายการงานที่ล้ม · ลองใหม่ · ทิ้งพร้อมเหตุผล · วิศวกรเท่านั้น', async () => {
    const r = await engineer.agent.get('/ops/jobs/failed');
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(true);
    expect(r.body.items.map((j: { id: string }) => j.id).sort()).toEqual([...ids].sort());
    expect(r.body.items[0]).toMatchObject({ reason: 'ผู้ให้บริการตอบ 500', attempts: 1, workspaceId: c.id });
    expect((await engineer.agent.post(`/ops/jobs/${ids[0]}/retry`).send({})).body).toEqual({ id: ids[0], retried: true });
    expect((await engineer.agent.post(`/ops/jobs/${ids[0]}/retry`).send({})).body.error.code).toBe('job_not_failed');
    expect((await engineer.agent.post(`/ops/jobs/${ids[1]}/discard`).send({})).status).toBe(400);
    expect((await engineer.agent.post(`/ops/jobs/${ids[1]}/discard`).send({ reason: 'ลูกค้ายกเลิก LINE OA แล้ว' })).body).toEqual({ id: ids[1], discarded: true });
    expect((await engineer.agent.get('/ops/jobs/failed')).body.items).toEqual([]);
    expect((await engineer.agent.post('/ops/jobs/retry').send({ ids: ['nope'] })).body.items).toEqual([{ id: 'nope', retried: false, error: 'not_found' }]);
    const log = (await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = 'system.job_discarded'`)).rows[0].reason;
    expect(log).toContain('ลูกค้ายกเลิก LINE OA แล้ว');
    expect((await support.agent.get('/ops/jobs/failed')).status).toBe(403);
  });

});

describe('คิวงานที่ยังไม่เชื่อม', () => {
  it('ไม่ได้ตั้ง VALKEY_URL → แสดงว่ายังไม่เชื่อมคิว', async () => {
    delete process.env.VALKEY_URL;
    try {
      expect((await engineer.agent.get('/ops/jobs/failed')).body).toEqual({ configured: false, items: [] });
      expect((await engineer.agent.post('/ops/jobs/1/retry').send({})).body.error.code).toBe('queue_not_configured');
    } finally {
      if (VALKEY) process.env.VALKEY_URL = VALKEY;
    }
  });
});
