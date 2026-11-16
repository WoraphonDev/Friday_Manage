// Friday Ops รอบ 4 · S1–S6: วันหยุด ธปท. · ออฟไลน์อัตโนมัติและแจกคิวกลางใหม่ · บริบทใน Ticket · ข้อมูลสมมติเท่านั้น
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBotHolidays } from '../src/support/bot-holidays.js';
import { HolidaysService } from '../src/support/holidays.service.js';
import { PresenceService } from '../src/support/presence.service.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let mew: Staff;
let nid: Staff;
let finance: Staff;
let ws: Customer;
let bot: Server;
let botUrl = '';
/** คำตอบของ API ธปท. จำลอง (รูปตาม BOT API Portal: result.data[]) · null = ตอบ 500 */
let botYear: Record<number, { Date: string; HolidayDescriptionThai: string }[] | null> = {};
const uploads = join(tmpdir(), `fm-ops-r4-${process.pid}`);

const audits = async (action: string) => (await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows.map((r) => r.reason as string);
const agent = async (id: string) => (await t.owner.query(`SELECT presence, presence_reason AS reason, presence_note AS note, last_seen_at AS seen FROM support_agents WHERE staff_id = $1`, [id])).rows[0];
const ticket = async (subject: string, assignee: string | null, status = 'open') =>
  (
    await t.owner.query(
      `INSERT INTO support_tickets (workspace_id, requester_email, channel, priority, subject, assignee_id, status, solved_at) VALUES ($1, $2, 'in_app', 'normal', $3, $4, $5, $6) RETURNING id`,
      [ws.id, `owner@${ws.slug}.example.com`, subject, assignee, status, status === 'solved' ? new Date(Date.now() - 86_400_000) : null],
    )
  ).rows[0].id as string;
const assigneeOf = async (id: string) => (await t.owner.query('SELECT assignee_id FROM support_tickets WHERE id = $1', [id])).rows[0].assignee_id as string | null;

beforeAll(async () => {
  bot = createServer((req, res) => {
    const year = Number(new URL(req.url!, 'http://x').searchParams.get('year'));
    if (req.headers.authorization !== 'test-client-id') return void res.writeHead(401).end();
    const data = botYear[year];
    if (data === null) return void res.writeHead(500).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { api: 'Financial Institutions Holidays', data: data ?? [] } }));
  });
  await new Promise<void>((r) => bot.listen(0, '127.0.0.1', r));
  botUrl = `http://127.0.0.1:${(bot.address() as AddressInfo).port}/financial-institutions-holidays/`;
  process.env.UPLOAD_DIR = uploads;
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', ['owner']);
  mew = await staff(t, 'mew@friday.example.com', 'Mew Siri', 'support');
  nid = await staff(t, 'nid@friday.example.com', 'Nid Jaidee', 'support');
  finance = await staff(t, 'fin@friday.example.com', 'Fin Finance', 'finance');
  ws = await customer(t, 'orbit-apps', { plan: 'team_s', status: 'active' });
});
afterAll(async () => {
  delete process.env.BOT_API_CLIENT_ID;
  delete process.env.BOT_HOLIDAYS_URL;
  await t.close();
  await new Promise((r) => bot.close(r));
  await rm(uploads, { recursive: true, force: true });
});

describe('วันหยุดของระบบ (S1–S2)', () => {
  it('ยังไม่ตั้ง Client ID: แสดงสถานะ · ดึงไม่ได้ · เพิ่มเองได้ · การเงินเปิดไม่ได้', async () => {
    const r = await mew.agent.get('/ops/support/holidays');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ configured: false, syncedAt: null, failure: null, items: [] });
    expect((await mew.agent.post('/ops/support/holidays/bot/preview').send({ year: 2027 })).body.error.code).toBe('bot_not_configured');
    expect((await finance.agent.get('/ops/support/holidays')).status).toBe(403);
    expect(await t.app.get(HolidaysService).daily(new Date('2026-12-01T00:30:00Z'))).toEqual({ ran: false });
  });

  it('เพิ่มเอง: ตรวจผลกระทบ · ป้าย "เพิ่มเอง" · ต่อคิวคำนวณ Plan End · ซ้ำไม่ได้ · ลบได้เฉพาะที่เพิ่มเอง', async () => {
    // โปรเจกต์ของลูกค้าที่ใช้ปฏิทินของระบบเป็นค่าเริ่มต้น
    const list = await mew.agent.get('/ops/support/holidays');
    expect(list.status).toBe(200);
    const imp = await mew.agent.post('/ops/support/holidays/impact').send({ dates: ['2027-01-02'] });
    expect(imp.body).toEqual({ projects: 0, workspaces: 0, issues: 0 });
    const add = await mew.agent.post('/ops/support/holidays').send({ date: '2027-01-02', name: 'หยุดพิเศษ (ครม.)' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.holiday).toEqual({ date: '2027-01-02', name: 'หยุดพิเศษ (ครม.)', origin: 'manual' });
    const year = await owner.agent.get('/ops/support/holidays?year=2027');
    expect(year.body.items).toEqual([{ date: '2027-01-02', name: 'หยุดพิเศษ (ครม.)', origin: 'manual' }]);
    const q = (await t.owner.query(`SELECT value FROM ops_settings WHERE key = 'holiday_recalc'`)).rows[0].value;
    expect(q.pending).toEqual([expect.objectContaining({ added: ['2027-01-02'], removed: [], done: [], by: 'Mew Siri' })]);
    expect((await mew.agent.post('/ops/support/holidays').send({ date: '2027-01-02', name: 'ซ้ำ' })).body.error.code).toBe('holiday_exists');
    expect((await mew.agent.post('/ops/support/holidays').send({ date: '2027-02-30', name: 'ผิด' })).status).toBe(400);
    expect(await audits('support.holiday_added')).toEqual(['เพิ่มวันหยุดของระบบ 2027-01-02 หยุดพิเศษ (ครม.) · คำนวณ Plan End ใหม่']);
    // ลบโดยไม่คำนวณใหม่ → คิวไม่เพิ่ม
    await mew.agent.post('/ops/support/holidays').send({ date: '2027-03-03', name: 'ทดลองลบ', recalc: false });
    const del = await mew.agent.delete('/ops/support/holidays/2027-03-03?recalc=0&sla=0');
    expect(del.body).toMatchObject({ date: '2027-03-03', deleted: true, slaUpdated: 0 });
    expect((await t.owner.query(`SELECT jsonb_array_length(value->'pending') AS n FROM ops_settings WHERE key = 'holiday_recalc'`)).rows[0].n).toBe(1);
  });

  it('ดึงจาก ธปท.: ตรวจก่อนบันทึก (ใหม่ / เลื่อน / ยกเลิก) · บันทึกแล้วป้ายเปลี่ยนเป็น ธปท. · SLA คิดใหม่', async () => {
    process.env.BOT_API_CLIENT_ID = 'test-client-id';
    process.env.BOT_HOLIDAYS_URL = botUrl;
    const cal = (await t.owner.query(`SELECT id FROM holiday_calendars WHERE workspace_id IS NULL`)).rows[0].id;
    // ของเดิมจาก ธปท.: วันจักรี 6 เม.ย. (จะเลื่อนเป็น 7) และวันที่ประกาศยกเลิก
    await t.owner.query(`INSERT INTO holidays (calendar_id, date, name, origin) VALUES ($1, '2027-04-06', 'วันจักรี (ชดเชย)', 'bot'), ($1, '2027-05-04', 'วันที่ถูกยกเลิก', 'bot')`, [cal]);
    botYear = {
      2027: [
        { Date: '2027-01-01', HolidayDescriptionThai: 'วันขึ้นปีใหม่' },
        { Date: '2027-01-02', HolidayDescriptionThai: 'วันหยุดพิเศษ' },
        { Date: '2027-02-12', HolidayDescriptionThai: 'วันมาฆบูชา' },
        { Date: '2027-04-07', HolidayDescriptionThai: 'วันจักรี (ชดเชย)' },
        { Date: '2026-12-31', HolidayDescriptionThai: 'ปีอื่นไม่รับ' },
      ],
    };
    const tk = await ticket('SLA ต้องคิดใหม่', mew.id);
    await t.owner.query(`UPDATE support_tickets SET first_response_due_at = now() - interval '1 year' WHERE id = $1`, [tk]);
    const p = await mew.agent.post('/ops/support/holidays/bot/preview').send({ year: 2027 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ year: 2027, total: 4, counts: { new: 2, changed: 1, removed: 1, origin: 1, same: 0 }, changedDates: 5, impact: { projects: 0 } });
    expect(p.body.items.slice(0, 4)).toEqual([
      { kind: 'new', date: '2027-01-01', name: 'วันขึ้นปีใหม่' },
      { kind: 'new', date: '2027-02-12', name: 'วันมาฆบูชา' },
      { kind: 'changed', date: '2027-04-07', name: 'วันจักรี (ชดเชย)', from: '2027-04-06' },
      { kind: 'removed', date: '2027-05-04', name: 'วันที่ถูกยกเลิก' },
    ]);
    // ตรวจก่อนบันทึกยังไม่เขียน
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM holidays WHERE date = '2027-01-01'`)).rows[0].n).toBe(0);
    const a = await mew.agent.post('/ops/support/holidays/bot/apply').send({ year: 2027 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ saved: 4, added: ['2027-01-01', '2027-02-12', '2027-04-07'], removed: ['2027-04-06', '2027-05-04'] });
    expect(a.body.slaUpdated).toBeGreaterThanOrEqual(1);
    const l = await mew.agent.get('/ops/support/holidays?year=2027');
    expect(l.body.items).toEqual([
      { date: '2027-01-01', name: 'วันขึ้นปีใหม่', origin: 'bot' },
      { date: '2027-01-02', name: 'วันหยุดพิเศษ', origin: 'bot' },
      { date: '2027-02-12', name: 'วันมาฆบูชา', origin: 'bot' },
      { date: '2027-04-07', name: 'วันจักรี (ชดเชย)', origin: 'bot' },
    ]);
    expect(l.body.syncedAt).not.toBeNull();
    expect(new Date((await t.owner.query('SELECT first_response_due_at AS d FROM support_tickets WHERE id = $1', [tk])).rows[0].d).getTime()).toBeGreaterThan(Date.now() - 400 * 86_400_000);
    expect((await audits('support.holidays_synced'))[0]).toContain('ปี 2027 ตามประกาศ ธปท. · ใหม่ 3 · ยกเลิก 2 · ทั้งหมด 4 วัน');
    // วันจาก ธปท. ลบเองไม่ได้
    expect((await mew.agent.delete('/ops/support/holidays/2027-01-01')).body.error.code).toBe('holiday_from_bot');
    // บันทึกซ้ำไม่มีอะไรเปลี่ยน
    expect((await mew.agent.post('/ops/support/holidays/bot/apply').send({ year: 2027 })).body).toMatchObject({ added: [], removed: [], changed: 0 });
  });

  it('ดึงไม่สำเร็จ: ป้ายแดง "ตั้งแต่" คงเวลาแรก · ข้อมูลเดิมยังอยู่ · ดึงได้อีกครั้งล้างป้าย', async () => {
    botYear[2028] = null;
    const r = await mew.agent.post('/ops/support/holidays/bot/preview').send({ year: 2028 });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('bot_fetch_failed');
    const first = (await mew.agent.get('/ops/support/holidays')).body.failure;
    expect(first.message).toBe('ธปท. ตอบ HTTP 500');
    await mew.agent.post('/ops/support/holidays/bot/preview').send({ year: 2028 });
    expect((await mew.agent.get('/ops/support/holidays')).body.failure.since).toBe(first.since);
    botYear[2028] = [];
    expect((await mew.agent.post('/ops/support/holidays/bot/apply').send({ year: 2028 })).status).toBe(200);
    expect((await mew.agent.get('/ops/support/holidays')).body.failure).toBeNull();
  });

  it('งาน 06:00: ก่อน 06:00 ไม่ทำ · ธ.ค. ดึงปีถัดไปด้วย · วันเดียวกันไม่ทำซ้ำ · มีวันเปลี่ยนแจ้งหัวหน้าทีม', async () => {
    const svc = t.app.get(HolidaysService);
    await t.owner.query(`UPDATE holiday_calendars SET synced_at = now() - interval '3 days' WHERE workspace_id IS NULL`);
    botYear[2026] = [{ Date: '2026-12-10', HolidayDescriptionThai: 'วันรัฐธรรมนูญ' }];
    botYear[2027] = [...(botYear[2027] ?? []), { Date: '2027-12-31', HolidayDescriptionThai: 'วันสิ้นปี' }];
    // 05:30 เวลาไทย 1 ธ.ค. 2569
    expect(await svc.daily(new Date('2026-11-30T22:30:00Z'))).toEqual({ ran: false });
    const r = await svc.daily(new Date('2026-11-30T23:05:00Z'));
    expect(r.ran).toBe(true);
    expect(r.changes).toEqual(['ปี 2026: ใหม่ 2026-12-10 · ยกเลิก —', 'ปี 2027: ใหม่ 2027-12-31 · ยกเลิก —']);
    expect(await svc.daily(new Date('2026-11-30T23:15:00Z'))).toEqual({ ran: false });
  });
});

describe('สถานะพนักงานและคิวกลาง (S3–S5)', () => {
  it('team?seen=1 นับเป็นการใช้งาน · seen ไม่ส่ง = ไม่นับ · คิวกลางบอกเหตุที่รอ', async () => {
    await mew.agent.get('/ops/support/team?seen=1');
    const seen = (await agent(mew.id)).seen;
    expect(seen).not.toBeNull();
    await mew.agent.get('/ops/support/team');
    expect((await agent(mew.id)).seen).toEqual(seen);
    const r = await owner.agent.get('/ops/support/team');
    expect(r.body).toMatchObject({ idleMinutes: 15, me: null, queue: { items: [], waiting: null, redispatch: true } });
  });

  it('ไม่มีการใช้งาน 15 นาที → ออฟไลน์อัตโนมัติ · คืนเรื่องเข้าคิว · แจกให้คนที่ออนไลน์ทันที · Toast ตอนกลับมา', async () => {
    const a = await ticket('#544 ชำระแล้วแต่แพ็กเกจยังไม่เปลี่ยน', nid.id);
    const b = await ticket('#545 ส่งออก Excel ไม่ได้', nid.id);
    const now = new Date();
    await t.owner.query(`UPDATE support_agents SET last_seen_at = $2 WHERE staff_id = $1`, [mew.id, now]);
    await t.owner.query(`INSERT INTO support_agents (staff_id, presence, last_seen_at) VALUES ($1, 'online', $2) ON CONFLICT (staff_id) DO UPDATE SET presence = 'online', last_seen_at = $2`, [nid.id, new Date(now.getTime() - 16 * 60_000)]);
    const svc = t.app.get(PresenceService);
    expect(await svc.tick(now)).toEqual({ offline: 1, assigned: 2 });
    expect(await agent(nid.id)).toMatchObject({ presence: 'offline', reason: 'idle', note: 'ไม่มีการใช้งาน 15 นาที' });
    expect(await assigneeOf(a)).toBe(mew.id);
    expect(await assigneeOf(b)).toBe(mew.id);
    expect((await audits('support.presence_auto'))[0]).toBe('Nid Jaidee: สถานะ online → offline · อัตโนมัติ (ไม่มีการใช้งาน ไม่มีการใช้งาน 15 นาที) · คืนงานเข้าคิว 2 เรื่อง');
    expect(await audits('support.ticket_auto_assigned')).toHaveLength(2);
    // ทีมตอนนี้ + คิวกลาง (S3) และข้อมูล Toast ของคนที่ถูกเปลี่ยน (S5)
    const team = (await nid.agent.get('/ops/support/team')).body;
    expect(team.items.find((x: { staffId: string }) => x.staffId === nid.id)).toMatchObject({ presence: 'offline', presenceReason: 'idle', released: 2, load: 0 });
    expect(team.me).toMatchObject({ presence: 'offline', presenceReason: 'idle', released: 2 });
    expect(team.queue.items.map((k: { subject: string; autoAssigned: { name: string } | null }) => [k.subject, k.autoAssigned?.name])).toEqual([
      ['#544 ชำระแล้วแต่แพ็กเกจยังไม่เปลี่ยน', 'Mew Siri'],
      ['#545 ส่งออก Excel ไม่ได้', 'Mew Siri'],
    ]);
    // ภายในเวลาที่ตั้ง ไม่เปลี่ยน · ลา ไม่ถูกเปลี่ยน
    expect((await svc.tick(new Date(now.getTime() + 60_000))).offline).toBe(0);
  });

  it('คนเต็มทุกคน → รอ · กลับมาออนไลน์ = แจกทันที (ไม่ต้องรอรอบ 1 นาที)', async () => {
    const cfg = (await owner.agent.get('/ops/support/settings')).body.config;
    await owner.agent.put('/ops/support/settings').send({ config: { ...cfg, defaultCap: 2 }, agents: [] });
    const c = await ticket('#546 บันทึกงานไม่ได้', null);
    await t.app.get(PresenceService).redispatch();
    expect(await assigneeOf(c)).toBeNull();
    expect((await mew.agent.get('/ops/support/team')).body.queue).toMatchObject({ waiting: 'all_full' });
    const back = await nid.agent.put('/ops/support/presence').send({ presence: 'online' });
    expect(back.body).toMatchObject({ presence: 'online', redispatched: 1 });
    expect(await assigneeOf(c)).toBe(nid.id);
    expect(await agent(nid.id)).toMatchObject({ presence: 'online', reason: 'manual' });
  });

  it('ไม่ว่างนานก็ออฟไลน์ · ลา ระบบไม่แตะ · ไม่เห็นเกิน 8 ชม. ตอนปิดตรวจไม่มีการใช้งาน = หมดเวลาเข้าระบบ', async () => {
    const svc = t.app.get(PresenceService);
    const cfg = (await owner.agent.get('/ops/support/settings')).body.config;
    await owner.agent.put('/ops/support/settings').send({ config: { ...cfg, idleOffline: false }, agents: [] });
    const now = Date.now();
    await t.owner.query(`UPDATE support_agents SET presence = 'busy', last_seen_at = $2 WHERE staff_id = $1`, [nid.id, new Date(now - 9 * 3_600_000)]);
    await t.owner.query(`UPDATE support_agents SET presence = 'leave', last_seen_at = $2 WHERE staff_id = $1`, [mew.id, new Date(now - 9 * 3_600_000)]);
    expect((await svc.tick(new Date(now))).offline).toBe(1);
    expect(await agent(nid.id)).toMatchObject({ presence: 'offline', reason: 'session', note: 'หมดเวลาเข้าระบบ' });
    expect((await agent(mew.id)).presence).toBe('leave');
    await owner.agent.put('/ops/support/settings').send({ config: { ...cfg, idleOffline: true }, agents: [] });
    const saved = await audits('support.settings_updated');
    expect(saved.at(-1)).toBe('ไม่มีการใช้งาน 15 นาทีเป็นออฟไลน์');
  });

  it('ออกจากระบบ → ออฟไลน์ · ปิดในตั้งค่าแล้วไม่เปลี่ยน', async () => {
    await nid.agent.put('/ops/support/presence').send({ presence: 'online' });
    expect((await nid.agent.post('/ops/auth/logout')).status).toBe(200);
    expect(await agent(nid.id)).toMatchObject({ presence: 'offline', reason: 'logout' });
    // คนที่ไม่ใช่ Support ออกจากระบบได้ตามปกติ
    const eng = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
    expect((await eng.agent.post('/ops/auth/logout')).status).toBe(200);
  });

  it('ลูกค้าตอบเรื่องที่ปิดแล้ว แต่คนเดิมออฟไลน์ → คืนเข้าคิว (ทีมบันทึกข้อความแทนลูกค้า)', async () => {
    await t.owner.query(`UPDATE support_agents SET presence = 'online' WHERE staff_id = $1`, [mew.id]);
    const cfg = (await owner.agent.get('/ops/support/settings')).body.config;
    await owner.agent.put('/ops/support/settings').send({ config: { ...cfg, defaultCap: 20 }, agents: [] });
    const k = await ticket('เรื่องที่ปิดแล้ว', nid.id, 'solved');
    const r = await mew.agent.post(`/ops/tickets/${k}/messages`).send({ body: 'ลูกค้าโทรมาบอกว่ายังไม่หาย', fromCustomer: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ reopened: true, requeued: true });
    expect(await assigneeOf(k)).toBe(mew.id);
    const detail = (await mew.agent.get(`/ops/tickets/${k}`)).body;
    expect(detail.messages.filter((m: { internal: boolean }) => m.internal).map((m: { body: string }) => m.body)).toEqual(['ลูกค้าตอบหลังปิดเรื่อง · Nid Jaidee ออฟไลน์ จึงคืนเข้าคิวกลาง', 'แจกให้ Mew Siri อัตโนมัติจากคิวกลาง']);
  });
});

describe('ไฟล์แนบและบริบทใน Ticket (S6)', () => {
  it('รายละเอียดแสดงบริบท + รายการไฟล์ (ไม่มี key ของที่เก็บ) · ดาวน์โหลดผ่าน ops-api · ไฟล์นอก Workspace ไม่ได้', async () => {
    const k = await ticket('กดบันทึกงานแล้วขึ้นข้อผิดพลาด', mew.id);
    const key = `support/${ws.id}/shot-1.png`;
    await mkdir(dirname(join(uploads, 'files', key)), { recursive: true });
    await writeFile(join(uploads, 'files', key), Buffer.from('89504e470d0a1a0a', 'hex'));
    const attachments = [
      { kind: 'file', key, name: 'ภาพหน้าจอ.png', size: 8, mime: 'image/png' },
      { kind: 'file', key: 'support/other-ws/secret.xlsx', name: 'export-error.xlsx', size: 18, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { kind: 'context', page: 'บอร์ด', path: '/work/orbit-apps/p/DP/board', requestId: 'req_7f3a9c2e', impact: 'blocked', browser: 'Chrome 131 · macOS' },
      { kind: 'article', slug: 'save-failed', title: 'บันทึกงานไม่ได้' },
    ];
    const m = (await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, body, attachments) VALUES ($1, 'customer', 'ลองหลายรอบแล้ว', $2) RETURNING id`, [k, JSON.stringify(attachments)])).rows[0].id;
    const d = await mew.agent.get(`/ops/tickets/${k}`);
    expect(d.body.context).toEqual({ page: 'บอร์ด', path: '/work/orbit-apps/p/DP/board', requestId: 'req_7f3a9c2e', impact: 'blocked', browser: 'Chrome 131 · macOS', article: { slug: 'save-failed', title: 'บันทึกงานไม่ได้' } });
    const msg = d.body.messages.find((x: { id: string }) => x.id === m);
    expect(msg.files).toEqual([
      { index: 0, name: 'ภาพหน้าจอ.png', size: 8, mime: 'image/png' },
      { index: 1, name: 'export-error.xlsx', size: 18, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ]);
    expect(JSON.stringify(d.body)).not.toContain('shot-1.png');
    const f = await mew.agent.get(`/ops/tickets/${k}/messages/${m}/files/0`);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toBe('image/png');
    expect(f.headers['x-content-type-options']).toBe('nosniff');
    expect((await mew.agent.get(`/ops/tickets/${k}/messages/${m}/files/1`)).status).toBe(404);
    expect((await mew.agent.get(`/ops/tickets/${k}/messages/${m}/files/2`)).status).toBe(404);
    expect((await finance.agent.get(`/ops/tickets/${k}/messages/${m}/files/0`)).status).toBe(403);
  });
});

describe('ตัวอ่านคำตอบของ ธปท.', () => {
  it('รับ result.data[] หรือ data[] · ตัดแถวผิดรูปและปีอื่น · รูปไม่ตรงเลย = error', () => {
    expect(parseBotHolidays({ data: [{ Date: '2027-01-01T00:00:00', HolidayDescription: "New Year's Day" }, { Date: 'x', HolidayDescriptionThai: 'ผิด' }] }, 2027)).toEqual([{ date: '2027-01-01', name: "New Year's Day" }]);
    expect(() => parseBotHolidays({ result: {} }, 2027)).toThrow();
  });
});
