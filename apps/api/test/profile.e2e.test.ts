// A20 · Profile, การตั้งค่าแจ้งเตือนของฉัน และวันลา · ข้อมูลสมมติเท่านั้น
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type DomainEvent } from '../src/core/events.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let outsider: Client;
let wsId: string;
let moduleId: string;
const events: DomainEvent[] = [];

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  moduleId = team.project.modules[0].id;
  guest = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guest, 'guest@profile.example.com', 'Guest'), 'guest', { key: team.key, role: 'viewer' });
  outsider = await client(t.app);
  await signup(outsider, 'outsider@profile.example.com', 'Outsider');
  t.app.get(EventBus).on('leave.created', (e) => { events.push(e); });
});
afterAll(() => t.close());

describe('PATCH me', () => {
  it('แก้ชื่อ ภาษา ปี พ.ศ. / ค.ศ. timezone และข้อมูลติดต่อ · GET me สะท้อนค่าใหม่', async () => {
    const before = await team.dev.get('/me');
    expect(before.body).toMatchObject({ displayName: 'Kaijeaw', locale: 'th', yearFormat: 'BE', timezone: 'Asia/Bangkok' });
    const r = await team.dev.patch('/me', { displayName: 'Kai', firstName: 'Kai', lastName: 'Jeaw', phone: '081-000-0000', about: 'Backend', locale: 'en', yearFormat: 'CE', timezone: 'Asia/Tokyo' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ displayName: 'Kai', locale: 'en', yearFormat: 'CE', timezone: 'Asia/Tokyo', phone: '081-000-0000' });
    expect((await team.dev.get('/me')).body).toMatchObject({ displayName: 'Kai', firstName: 'Kai', about: 'Backend', locale: 'en' });
    expect((await team.dev.patch('/me', { displayName: 'Kaijeaw', locale: 'th', yearFormat: 'BE', timezone: 'Asia/Bangkok', phone: null })).body.phone).toBeNull();
  });

  it('ข้อมูลผิด → 400 · แก้ของคนอื่นไม่ได้ (แก้ได้เฉพาะของตัวเอง)', async () => {
    for (const body of [{}, { locale: 'fr' }, { yearFormat: 'AD' }, { timezone: 'Mars/Base' }, { displayName: '' }, { displayName: 'x'.repeat(81) }, { avatarUrl: 'not-url' }]) {
      expect((await team.dev.patch('/me', body)).status, JSON.stringify(body)).toBe(400);
    }
    await team.dev.patch('/me', { displayName: 'Hacked Name' });
    expect((await team.lead.get('/me')).body.displayName).toBe('Mick');
    await team.dev.patch('/me', { displayName: 'Kaijeaw' });
  });
});

describe('w/me/membership', () => {
  it('ตำแหน่ง แผนก Capacity เวลาทำงาน · เว้นเวลา = ใช้ของ Workspace', async () => {
    const base = await team.dev.get(`${team.ws}/me/membership`);
    expect(base.body).toMatchObject({ role: 'member', capacityHoursWeek: 40, workStart: null, effective: { workStart: '09:30', workEnd: '18:30', workDays: [1, 2, 3, 4, 5] } });
    const r = await team.dev.patch(`${team.ws}/me/membership`, { jobTitle: 'Backend Dev', department: 'Engineering', capacityHoursWeek: 32, workStart: '09:00', workEnd: '18:00', workDays: [5, 1, 3, 3] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ jobTitle: 'Backend Dev', department: 'Engineering', capacityHoursWeek: 32, workStart: '09:00', workEnd: '18:00', workDays: [1, 3, 5], effective: { workStart: '09:00', workDays: [1, 3, 5] } });
    // กลับไปใช้ค่าของ Workspace
    const reset = await team.dev.patch(`${team.ws}/me/membership`, { workStart: null, workEnd: null, workDays: null });
    expect(reset.body).toMatchObject({ workStart: null, workDays: null, effective: { workStart: '09:30', workDays: [1, 2, 3, 4, 5] } });
  });

  it('ตรวจข้อมูล: เวลาเริ่ม/เลิกต้องคู่กันและเลิกหลังเริ่ม · Capacity 0–80 · แก้ได้เฉพาะของตัวเอง', async () => {
    for (const body of [{}, { workStart: '09:00' }, { workStart: '18:00', workEnd: '09:00' }, { capacityHoursWeek: 81 }, { workStart: '25:00', workEnd: '26:00' }, { workDays: [] }, { workDays: [8] }]) {
      expect((await team.dev.patch(`${team.ws}/me/membership`, body)).status, JSON.stringify(body)).toBe(400);
    }
    await team.dev.patch(`${team.ws}/me/membership`, { jobTitle: 'Dev' });
    expect((await team.lead.get(`${team.ws}/me/membership`)).body.jobTitle).not.toBe('Dev');
    expect((await outsider.get(`${team.ws}/me/membership`)).status).toBe(404);
  });
});

describe('me/notification-prefs', () => {
  const q = () => `/me/notification-prefs?workspace=${team.slug}`;
  const cell = (body: { rows: Array<{ eventType: string; channels: Record<string, { enabled: boolean; locked: boolean; custom: boolean }> }> }, event: string, channel: string) => body.rows.find((r) => r.eventType === event)!.channels[channel]!;

  it('ค่าเริ่มต้นตาม Canvas I: In-app เปิด (ล็อกบางแถว) · Email เปิดเฉพาะเรื่องสำคัญ · LINE ตามตาราง · สรุปประจำวันแทนแถวใกล้ครบกำหนด / เลยกำหนด', async () => {
    const r = await team.dev.get(q());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.channels).toEqual(['in_app', 'email', 'line']);
    expect(cell(r.body, 'issue.assigned', 'in_app')).toEqual({ enabled: true, locked: true, custom: false });
    expect(cell(r.body, 'issue.assigned', 'email')).toMatchObject({ enabled: true, locked: false });
    expect(cell(r.body, 'issue.assigned', 'line').enabled).toBe(true);
    expect(cell(r.body, 'issue.commented', 'in_app')).toMatchObject({ enabled: true, locked: false });
    expect(cell(r.body, 'issue.commented', 'email').enabled).toBe(false);
    expect(cell(r.body, 'issue.commented', 'line').enabled).toBe(false);
    expect(cell(r.body, 'digest.daily', 'in_app')).toEqual({ enabled: true, locked: true, custom: false });
    expect(cell(r.body, 'digest.daily', 'email').enabled).toBe(true);
    expect(cell(r.body, 'digest.daily', 'line').enabled).toBe(true);
    expect(cell(r.body, 'issue.mentioned', 'in_app').locked).toBe(true);
    // รวมเข้าสรุปงานประจำวันแล้ว (12 พ.ย. 2026)
    expect(r.body.rows.map((row: { eventType: string }) => row.eventType)).not.toContain('issue.due_soon');
    expect(r.body.rows.map((row: { eventType: string }) => row.eventType)).not.toContain('issue.overdue');
    expect(r.body.rows.every((row: { label: string }) => row.label.length > 0)).toBe(true);
  });

  it('PUT บันทึกเฉพาะที่ส่งมา (upsert) · แถวอื่นยังเป็นค่าเริ่มต้น · dispatcher ของ A25 อ่านตารางเดียวกัน', async () => {
    const r = await team.dev.put('/me/notification-prefs', { workspace: team.slug, prefs: [{ eventType: 'issue.assigned', channel: 'email', enabled: false }, { eventType: 'issue.commented', channel: 'email', enabled: true }, { eventType: 'issue.commented', channel: 'in_app', enabled: false }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(cell(r.body, 'issue.assigned', 'email')).toEqual({ enabled: false, locked: false, custom: true });
    expect(cell(r.body, 'issue.commented', 'email')).toMatchObject({ enabled: true, custom: true });
    expect(cell(r.body, 'issue.commented', 'in_app').enabled).toBe(false);
    expect(cell(r.body, 'issue.review_requested', 'email')).toMatchObject({ enabled: true, custom: false });
    const rows = (await t.owner.query(`SELECT event_type, channel, enabled FROM user_notification_prefs WHERE user_id = $1 ORDER BY event_type, channel`, [team.devId])).rows;
    expect(rows).toEqual([
      { event_type: 'issue.assigned', channel: 'email', enabled: false },
      { event_type: 'issue.commented', channel: 'email', enabled: true },
      { event_type: 'issue.commented', channel: 'in_app', enabled: false },
    ]);
    // เปลี่ยนค่าเดิม ไม่เกิดแถวซ้ำ
    await team.dev.put('/me/notification-prefs', { workspace: team.slug, prefs: [{ eventType: 'issue.assigned', channel: 'email', enabled: true }] });
    expect((await t.owner.query(`SELECT count(*) FROM user_notification_prefs WHERE user_id = $1 AND event_type = 'issue.assigned'`, [team.devId])).rows[0].count).toBe('1');
    // ของคนอื่นไม่ถูกแตะ
    expect(cell((await team.lead.get(q())).body, 'issue.commented', 'in_app').custom).toBe(false);
  });

  it('In-app ที่ล็อกปิดไม่ได้ · เหตุการณ์/ช่องทางที่ไม่รู้จัก 400 · reset กลับค่าเริ่มต้น · คนนอก Workspace 404', async () => {
    const locked = await team.dev.put('/me/notification-prefs', { workspace: team.slug, prefs: [{ eventType: 'issue.mentioned', channel: 'in_app', enabled: false }] });
    expect(locked.status).toBe(400);
    expect(locked.body.error.code).toBe('locked_channel');
    expect((await team.dev.put('/me/notification-prefs', { workspace: team.slug, prefs: [{ eventType: 'issue.nope', channel: 'email', enabled: true }] })).status).toBe(400);
    expect((await team.dev.put('/me/notification-prefs', { workspace: team.slug, prefs: [{ eventType: 'issue.assigned', channel: 'sms', enabled: true }] })).status).toBe(400);
    expect((await team.dev.put('/me/notification-prefs', { workspace: team.slug, prefs: [{ eventType: 'issue.assigned', channel: 'email', enabled: true }], reset: true })).status).toBe(200);
    expect((await t.owner.query(`SELECT count(*) FROM user_notification_prefs WHERE user_id = $1`, [team.devId])).rows[0].count).toBe('1');
    expect((await team.dev.put('/me/notification-prefs', { workspace: team.slug, reset: true })).status).toBe(200);
    expect((await t.owner.query(`SELECT count(*) FROM user_notification_prefs WHERE user_id = $1`, [team.devId])).rows[0].count).toBe('0');
    expect((await outsider.get(q())).status).toBe(404);
    expect((await team.dev.get('/me/notification-prefs')).status).toBe(400);
  });
});

describe('me/notification-settings', () => {
  const q = () => `/me/notification-settings?workspace=${team.slug}`;

  it('ค่าเริ่มต้นตรงกับที่ตัวส่งใช้จริง (งดส่ง 20:00–08:00 + วันหยุด) · บันทึกบางส่วนได้', async () => {
    expect((await team.dev.get(q())).body).toEqual({ workspace: team.slug, dueReminder: '1d_and_today', digest: 'workdays', quietStart: '20:00', quietEnd: '08:00', quietOnHolidays: true, autoWatch: true, custom: false });
    const r = await team.dev.put('/me/notification-settings', { workspace: team.slug, dueReminder: '3d', digest: 'daily', autoWatch: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ dueReminder: '3d', digest: 'daily', autoWatch: false, quietStart: '20:00', quietEnd: '08:00', custom: true });
    const stored = (await t.owner.query('SELECT due_reminder, digest, quiet_start::text, auto_watch FROM user_notification_settings WHERE user_id = $1', [team.devId])).rows;
    expect(stored).toEqual([{ due_reminder: '3d', digest: 'daily', quiet_start: '20:00:00', auto_watch: false }]);
  });

  it('สรุปประจำวันปิดไม่ได้แล้ว: ไม่รับ off · ค่า off เดิมแสดงเป็นวันทำการ', async () => {
    expect((await team.dev.put('/me/notification-settings', { workspace: team.slug, digest: 'off' })).status).toBe(400);
    await t.owner.query(`UPDATE user_notification_settings SET digest = 'off' WHERE user_id = $1`, [team.devId]);
    expect((await team.dev.get(q())).body.digest).toBe('workdays');
  });

  it('ช่วงงดส่ง: เปลี่ยนเวลา / ปิด (null ทั้งคู่) / ต้องคู่กัน', async () => {
    const put = (body: object) => team.dev.put('/me/notification-settings', { workspace: team.slug, ...body });
    expect((await put({ quietStart: '22:00', quietEnd: '07:00', quietOnHolidays: false })).body).toMatchObject({ quietStart: '22:00', quietEnd: '07:00', quietOnHolidays: false });
    expect((await put({ quietStart: null, quietEnd: null })).body).toMatchObject({ quietStart: null, quietEnd: null });
    expect((await put({ quietStart: '21:00' })).status).toBe(400);
    expect((await put({ quietStart: '9pm', quietEnd: '07:00' })).status).toBe(400);
    expect((await put({ digest: 'hourly' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await team.lead.get(q())).body.custom).toBe(false);
    expect((await outsider.get(q())).status).toBe(404);
  });
});

describe('w/leaves', () => {
  it('ลาเอง = รออนุมัติ · เห็นเฉพาะของตัวเอง · ซ้อนกันไม่ได้ · ครึ่งวันคนละช่วงซ้อนได้', async () => {
    const r = await team.dev.post(`${team.ws}/leaves`, { leaveType: 'พักร้อน', startDate: '2026-12-24', endDate: '2026-12-25' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ leaveType: 'พักร้อน', startDate: '2026-12-24', endDate: '2026-12-25', status: 'pending', source: 'manual', halfDay: null, user: { displayName: 'Kaijeaw' } });
    const clash = await team.dev.post(`${team.ws}/leaves`, { leaveType: 'ลากิจ', startDate: '2026-12-25', endDate: '2026-12-28' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: 'leave_overlap', details: { existing: { startDate: '2026-12-24' } } });

    const am = await team.dev.post(`${team.ws}/leaves`, { leaveType: 'ลากิจ', startDate: '2026-11-12', endDate: '2026-11-12', halfDay: 'am' });
    expect(am.status).toBe(201);
    expect((await team.dev.post(`${team.ws}/leaves`, { leaveType: 'ลากิจ', startDate: '2026-11-12', endDate: '2026-11-12', halfDay: 'pm' })).status).toBe(201);
    expect((await team.dev.post(`${team.ws}/leaves`, { leaveType: 'ลากิจ', startDate: '2026-11-12', endDate: '2026-11-12', halfDay: 'am' })).status).toBe(409);

    const list = await team.dev.get(`${team.ws}/leaves`);
    expect(list.body.items.map((l: { startDate: string }) => l.startDate)).toEqual(['2026-11-12', '2026-11-12', '2026-12-24']);
    expect((await team.dev.get(`${team.ws}/leaves?from=2026-12-01&to=2026-12-31`)).body.items).toHaveLength(1);
    expect((await team.lead.get(`${team.ws}/leaves`)).body.items).toEqual([]);
  });

  it('ตรวจข้อมูล · Guest ลาไม่ได้ · คนนอก 404', async () => {
    const bad = [
      { leaveType: '', startDate: '2026-12-01', endDate: '2026-12-01' },
      { leaveType: 'ลา', startDate: '2026-12-05', endDate: '2026-12-01' },
      { leaveType: 'ลา', startDate: '2026-12-01', endDate: '2026-12-02', halfDay: 'am' },
      { leaveType: 'ลา', startDate: '1-12-2026', endDate: '2026-12-02' },
    ];
    for (const b of bad) expect((await team.dev.post(`${team.ws}/leaves`, b)).status, JSON.stringify(b)).toBe(400);
    expect((await guest.post(`${team.ws}/leaves`, { leaveType: 'ลา', startDate: '2027-01-05', endDate: '2027-01-05' })).status).toBe(403);
    expect((await outsider.get(`${team.ws}/leaves`)).status).toBe(404);
  });

  it('ของคนอื่น: ดู / ลงให้ต้องเป็น Admin (ลงให้ = อนุมัติทันที) · Admin อนุมัติวันลาที่รออยู่', async () => {
    expect((await team.dev.get(`${team.ws}/leaves?user=${team.leadId}`)).status).toBe(403);
    expect((await team.dev.get(`${team.ws}/leaves?user=all`)).status).toBe(403);
    expect((await team.dev.post(`${team.ws}/leaves`, { userId: team.leadId, leaveType: 'ลา', startDate: '2027-01-05', endDate: '2027-01-05' })).status).toBe(403);

    const forDev = await team.lead.post(`${team.ws}/leaves`, { userId: team.devId, leaveType: 'ลาป่วย', startDate: '2027-01-12', endDate: '2027-01-13' });
    expect(forDev.status, JSON.stringify(forDev.body)).toBe(201);
    expect(forDev.body).toMatchObject({ status: 'approved', user: { displayName: 'Kaijeaw' } });
    expect((await team.lead.post(`${team.ws}/leaves`, { userId: '00000000-0000-4000-8000-000000000000', leaveType: 'ลา', startDate: '2027-01-12', endDate: '2027-01-12' })).status).toBe(404);

    expect((await team.lead.get(`${team.ws}/leaves?user=${team.devId}`)).body.items.length).toBeGreaterThanOrEqual(3);
    const all = await team.lead.get(`${team.ws}/leaves?user=all`);
    expect(all.body.items.every((l: { user: { displayName: string } }) => l.user.displayName === 'Kaijeaw')).toBe(true);

    const pending = (await team.dev.get(`${team.ws}/leaves`)).body.items.find((l: { status: string }) => l.status === 'pending');
    expect((await team.dev.post(`${team.ws}/leaves/${pending.id}/approve`)).status).toBe(403);
    const ok = await team.lead.post(`${team.ws}/leaves/${pending.id}:approve`);
    expect(ok.body.status).toBe('approved');
    expect((await team.lead.post(`${team.ws}/leaves/00000000-0000-4000-8000-000000000000/approve`)).status).toBe(404);
  });

  it('ลบ: ของตัวเอง หรือ Admin · วันลาจากระบบ HR ลบไม่ได้', async () => {
    const mine = await team.dev.post(`${team.ws}/leaves`, { leaveType: 'ลากิจ', startDate: '2027-03-01', endDate: '2027-03-01' });
    expect((await team.lead.post(`${team.ws}/leaves`, { leaveType: 'ลากิจ', startDate: '2027-03-01', endDate: '2027-03-01' })).status).toBe(201);
    const leadLeave = (await team.lead.get(`${team.ws}/leaves`)).body.items[0];
    expect((await team.dev.delete(`${team.ws}/leaves/${leadLeave.id}`)).status).toBe(403);
    expect((await team.dev.delete(`${team.ws}/leaves/${mine.body.id}`)).body).toEqual({ deleted: true });
    expect((await team.dev.delete(`${team.ws}/leaves/${mine.body.id}`)).status).toBe(404);
    expect((await team.lead.delete(`${team.ws}/leaves/${leadLeave.id}`)).status).toBe(200);

    await t.owner.query(`INSERT INTO leaves (workspace_id, user_id, leave_type, start_date, end_date, status, source, external_ref) VALUES ($1,$2,'พักร้อน','2027-04-01','2027-04-02','approved','hr','HR-1')`, [wsId, team.devId]);
    const hr = (await team.dev.get(`${team.ws}/leaves?from=2027-04-01&to=2027-04-30`)).body.items[0];
    expect(hr.source).toBe('hr');
    const del = await team.dev.delete(`${team.ws}/leaves/${hr.id}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('leave_from_hr');
    expect((await team.lead.delete(`${team.ws}/leaves/${hr.id}`)).status).toBe(403);
    expect((await team.dev.delete(`${team.ws}/leaves/abc`)).status).toBe(404);
  });

  it('Event leave.created + แจ้งคนที่มอบหมายงาน / PM ของงานที่ผู้ลารับผิดชอบช่วงนั้น', async () => {
    const issue = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานของ dev ช่วงลา', moduleId });
    await t.owner.query(`UPDATE issues SET plan_start = '2027-05-04', plan_end = '2027-05-10', created_by = $2 WHERE id = $1`, [issue.body.id, team.leadId]);
    await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, issue.body.id, team.devId]);
    const far = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานนอกช่วงลา', moduleId });
    await t.owner.query(`UPDATE issues SET plan_start = '2027-08-01', plan_end = '2027-08-02' WHERE id = $1`, [far.body.id]);
    await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, far.body.id, team.devId]);
    await t.owner.query('DELETE FROM notifications');
    events.length = 0;

    const r = await team.dev.post(`${team.ws}/leaves`, { leaveType: 'พักร้อน', startDate: '2027-05-05', endDate: '2027-05-07' });
    expect(r.status).toBe(201);
    expect(events).toMatchObject([{ type: 'leave.created', workspaceId: wsId, actorId: team.devId, data: { userId: team.devId, startDate: '2027-05-05', endDate: '2027-05-07', affectedIssues: 1 } }]);
    const notes = (await t.owner.query(`SELECT recipient_id, payload FROM notifications WHERE event_type = 'leave.created'`)).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0].recipient_id).toBe(team.leadId);
    expect(notes[0].payload).toMatchObject({ actorName: 'Kaijeaw', startDate: '2027-05-05', issueCount: 1, issueKeys: [issue.body.key] });
  });
});

describe('รูปโปรไฟล์ (อัปโหลดจากเครื่อง)', () => {
  // PNG 1×1 จริง · ไฟล์ที่หัวไม่ใช่รูปต้องถูกปฏิเสธแม้ Content-Type บอกว่าเป็นรูป
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  // ส่งไฟล์รูปเป็น body ตรง ๆ · ขอ CSRF ใหม่ (token เดิมของ client จะใช้ไม่ได้แล้ว จึงลบผ่านตัวช่วยนี้ด้วย)
  const csrf = async (c: Client) => (await c.agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
  const put = async (c: Client, body: Buffer, type = 'image/png') => {
    const token = await csrf(c);
    return c.agent.put('/api/v1/me/avatar').set('x-csrf-token', token).set('Content-Type', type).send(body);
  };
  const del = async (c: Client) => {
    const token = await csrf(c);
    return c.agent.delete('/api/v1/me/avatar').set('x-csrf-token', token);
  };
  const anon = () => request(t.app.getHttpServer());

  it('อัปโหลดแล้ว avatarUrl ชี้ไปรูปที่เปิดได้ (cache ถาวร) · อัปโหลดใหม่ได้ URL ใหม่ รูปเก่าหาย · ลบแล้วไม่มีรูป', async () => {
    const r = await put(team.dev, png);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.avatarUrl).toMatch(new RegExp(`^/api/v1/avatars/${team.devId}/[\\w-]+$`));
    expect((await team.dev.get('/me')).body.avatarUrl).toBe(r.body.avatarUrl);
    const img = await anon().get(r.body.avatarUrl).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(img.body as Buffer, png)).toBe(0);

    const again = await put(team.dev, png);
    expect(again.body.avatarUrl).not.toBe(r.body.avatarUrl);
    expect((await anon().get(r.body.avatarUrl)).status).toBe(404);
    expect((await anon().get(again.body.avatarUrl)).status).toBe(200);

    expect((await del(team.dev)).body).toEqual({ avatarUrl: null });
    expect((await team.dev.get('/me')).body.avatarUrl).toBeNull();
    expect((await anon().get(again.body.avatarUrl)).status).toBe(404);
  });

  it('ไม่ใช่รูป → 415 · ใหญ่เกิน 512 KB → 413 · ไม่ล็อกอิน → 401 · URL มั่ว → 404', async () => {
    expect((await put(team.dev, Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png')).status).toBe(415);
    expect((await put(team.dev, Buffer.concat([png, Buffer.alloc(600 * 1024)]))).status).toBe(413);
    const stranger = request.agent(t.app.getHttpServer());
    const token = (await stranger.get('/api/v1/auth/csrf')).body.csrfToken as string;
    expect((await stranger.put('/api/v1/me/avatar').set('x-csrf-token', token).set('Content-Type', 'image/png').send(png)).status).toBe(401);
    expect((await anon().get(`/api/v1/avatars/${team.devId}/nope`)).status).toBe(404);
    expect((await anon().get('/api/v1/avatars/not-a-uuid/abcdefgh')).status).toBe(404);
    expect((await team.dev.get('/me')).body.avatarUrl).toBeNull();
  });
});
