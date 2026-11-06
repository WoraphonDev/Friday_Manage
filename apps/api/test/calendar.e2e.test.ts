// A21 · ปฏิทินโปรเจกต์ และ iCal · ข้อมูลสมมติเท่านั้น
// วันหยุดในฐานทดสอบ: จ. 7 และ พฤ. 10 ธ.ค. 2569 (seedHolidays)
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIcs, fold, icsText } from '../src/calendar/ical.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let outsider: Client;
let wsId: string;
let projectId: string;
let moduleId: string;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  guest = await client(t.app);
  const guestId = await signup(guest, 'guest@cal.example.com', 'Guest');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });
  outsider = await client(t.app);
  await signup(outsider, 'outsider@cal.example.com', 'Outsider');
  await t.owner.query('DELETE FROM sprints');
});
afterAll(() => t.close());

async function issue(title: string, start: string | null, end: string | null, assignee?: string, c: Client = team.lead) {
  const r = await c.post(`${team.ws}/projects/${team.key}/issues`, { title, moduleId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await t.owner.query('UPDATE issues SET plan_start = $2, plan_end = $3 WHERE id = $1', [r.body.id, start, end]);
  await t.owner.query('DELETE FROM issue_assignees WHERE issue_id = $1', [r.body.id]);
  if (assignee) await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, r.body.id, assignee]);
  return r.body as { id: string; key: string };
}

describe('GET p/calendar', () => {
  it('งาน (Due และช่วงวัน), Sprint, Milestone, วันหยุด, วันลา ของเดือน ธ.ค. 2569', async () => {
    const due = await issue('ครบกำหนด 15 ธ.ค.', null, '2026-12-15', team.devId);
    const span = await issue('คาบเกี่ยวต้นเดือน', '2026-11-26', '2026-12-02', team.leadId);
    const outside = await issue('อยู่นอกช่อง', '2027-02-01', '2027-02-05');
    const noDate = await issue('ไม่มีวัน', null, null);
    await t.owner.query(`INSERT INTO sprints (workspace_id, project_id, number, name, start_date, end_date, status) VALUES ($1,$2,50,'Sprint ธ.ค.','2026-12-07','2026-12-18','planning')`, [wsId, projectId]);
    await t.owner.query(`INSERT INTO milestones (workspace_id, project_id, name, date) VALUES ($1,$2,'Go-live รอบแรก','2026-12-21')`, [wsId, projectId]);
    await t.owner.query(`INSERT INTO project_holidays (workspace_id, project_id, date, name) VALUES ($1,$2,'2026-12-31','Company outing')`, [wsId, projectId]);
    await t.owner.query(`INSERT INTO leaves (workspace_id, user_id, leave_type, start_date, end_date, status) VALUES ($1,$2,'พักร้อน','2026-12-23','2026-12-25','approved'), ($1,$3,'ลากิจ','2026-12-10','2026-12-10','pending')`, [wsId, team.devId, team.leadId]);

    const r = await team.lead.get(`${team.ws}/projects/${team.key}/calendar?month=2026-12`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ month: '2026-12', range: { from: '2026-11-30', to: '2027-01-03' }, project: { key: team.key } });
    const keys = r.body.issues.map((i: { key: string }) => i.key);
    expect(keys).toContain(due.key);
    expect(keys).toContain(span.key);
    expect(keys).not.toContain(outside.key);
    expect(keys).not.toContain(noDate.key);
    expect(r.body.issues.find((i: { key: string }) => i.key === due.key)).toMatchObject({ planEnd: '2026-12-15', status: { category: 'todo' }, assignees: [{ displayName: 'Kaijeaw' }], version: expect.any(Number) });
    expect(r.body.sprints).toMatchObject([{ number: 50, name: 'Sprint ธ.ค.', startDate: '2026-12-07', endDate: '2026-12-18' }]);
    expect(r.body.milestones).toMatchObject([{ name: 'Go-live รอบแรก', date: '2026-12-21' }]);
    expect(r.body.holidays).toEqual([
      { date: '2026-12-07', name: expect.any(String), scope: 'workspace' },
      { date: '2026-12-10', name: expect.any(String), scope: 'workspace' },
      { date: '2026-12-31', name: 'Company outing', scope: 'project' },
    ]);
    expect(r.body.leaves).toMatchObject([
      { person: { displayName: 'Mick' }, leaveType: 'ลากิจ', startDate: '2026-12-10', status: 'pending' },
      { person: { displayName: 'Kaijeaw' }, leaveType: 'พักร้อน', startDate: '2026-12-23', endDate: '2026-12-25', status: 'approved' },
    ]);
  });

  it('เดือนอื่นไม่เอางานและวันลาของเดือนที่ไม่ทับกัน · month เริ่มต้น = เดือนนี้ · รูปแบบผิด 400', async () => {
    const r = await team.lead.get(`${team.ws}/projects/${team.key}/calendar?month=2027-03`);
    expect(r.body.issues).toEqual([]);
    expect(r.body.leaves).toEqual([]);
    expect(r.body.sprints).toEqual([]);
    const def = await team.lead.get(`${team.ws}/projects/${team.key}/calendar`);
    expect(def.body.month).toBe(def.body.today.slice(0, 7));
    expect((await team.lead.get(`${team.ws}/projects/${team.key}/calendar?month=2026-13`)).status).toBe(400);
  });

  it('สิทธิ์: Guest ไม่เห็น (ไม่มีวันลาและชื่อคนรั่ว) · คนนอกโปรเจกต์ 404/403', async () => {
    const g = await guest.get(`${team.ws}/projects/${team.key}/calendar?month=2026-12`);
    expect(g.status).toBe(403);
    expect(g.body.error.code).toBe('guest_view_limited');
    expect(JSON.stringify(g.body)).not.toContain('Kaijeaw');
    expect([403, 404]).toContain((await outsider.get(`${team.ws}/projects/${team.key}/calendar`)).status);
    expect((await team.dev.get(`${team.ws}/projects/${team.key}/calendar?month=2026-12`)).status).toBe(200);
  });
});

/** parse ไฟล์ .ics แบบง่าย: คลาย folding แล้วแตกเป็น VEVENT */
function parseIcs(text: string) {
  expect(text.endsWith('\r\n')).toBe(true);
  const lines = text.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
  expect(lines[0]).toBe('BEGIN:VCALENDAR');
  expect(lines.at(-1)).toBe('END:VCALENDAR');
  const events: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  const header: Record<string, string> = {};
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { events.push(cur!); cur = null; }
    else {
      const i = l.indexOf(':');
      (cur ?? header)[l.slice(0, i)] = l.slice(i + 1);
    }
  }
  return { header, events };
}

describe('iCal feeds', () => {
  let leadUrl = '';
  let leadFeedId = '';

  it('POST me/calendar-feeds ได้ URL ที่มี token · เก็บเฉพาะ hash · ดูรายการไม่เห็น token', async () => {
    const r = await team.lead.post('/me/calendar-feeds', { workspace: team.slug });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ workspace: team.slug, projectKey: null, id: expect.any(String) });
    expect(r.body.url).toMatch(/\/api\/v1\/ical\/[A-Za-z0-9_-]{43}\.ics$/);
    leadUrl = r.body.url;
    leadFeedId = r.body.id;
    const token = leadUrl.split('/').pop()!.replace('.ics', '');
    const row = (await t.owner.query('SELECT token_hash FROM calendar_feed_tokens WHERE id = $1', [leadFeedId])).rows[0];
    expect(row.token_hash).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const list = await team.lead.get(`/me/calendar-feeds?workspace=${team.slug}`);
    expect(list.body.items).toMatchObject([{ id: leadFeedId, projectKey: null }]);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect((await team.dev.get(`/me/calendar-feeds?workspace=${team.slug}`)).body.items).toEqual([]);
  });

  it('GET ical/{token}.ics (สาธารณะ): งานของฉันทุกโปรเจกต์ parse ได้ · ไม่รวมงานเสร็จ/งานคนอื่น/ไม่มีวัน', async () => {
    await t.owner.query('DELETE FROM issues');
    const a = await issue('งานของ lead, 1 วัน', null, '2026-12-15', team.leadId);
    const b = await issue('งานช่วงวัน; มีอักขระ, พิเศษ\nบรรทัดสอง และชื่อยาวมากมากมากมากมากมากมากมากมากมากมากมากมากมากมากมาก', '2026-12-02', '2026-12-04', team.leadId);
    await issue('งานของ dev', null, '2026-12-15', team.devId);
    await issue('ไม่มีวัน', null, null, team.leadId);
    const done = await issue('เสร็จแล้ว', null, '2026-12-01', team.leadId);
    await t.owner.query(`UPDATE issues SET status_id = (SELECT id FROM workflow_statuses WHERE project_id = $2 AND category = 'done' LIMIT 1) WHERE id = $1`, [done.id, projectId]);

    const res = await request(t.app.getHttpServer()).get(new URL(leadUrl).pathname);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    const { header, events } = parseIcs(res.text);
    expect(header).toMatchObject({ VERSION: '2.0', 'X-WR-CALNAME': expect.stringContaining('Friday') });
    expect(events).toHaveLength(2);
    const one = events.find((e) => e.UID === `${a.id}@friday-manage`)!;
    expect(one).toMatchObject({ 'DTSTART;VALUE=DATE': '20261215', 'DTEND;VALUE=DATE': '20261216', SUMMARY: `[${a.key}] งานของ lead\\, 1 วัน`, CATEGORIES: 'Development Plan' });
    expect(one.URL).toContain(`/w/${team.slug}/p/${team.key}/table?issue=${a.key}`);
    const span = events.find((e) => e.UID === `${b.id}@friday-manage`)!;
    expect(span['DTSTART;VALUE=DATE']).toBe('20261202');
    expect(span['DTEND;VALUE=DATE']).toBe('20261205');
    expect(span.SUMMARY).toContain('\;');
    expect(span.SUMMARY).toContain('\\n');
    for (const line of res.text.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('feed ของโปรเจกต์เดียว · โปรเจกต์ที่เข้าไม่ได้สร้างไม่ได้ · workspace ที่ไม่ใช่สมาชิก 404', async () => {
    const scoped = await team.lead.post('/me/calendar-feeds', { workspace: team.slug, projectKey: team.key });
    expect(scoped.body.projectKey).toBe(team.key);
    const res = await request(t.app.getHttpServer()).get(new URL(scoped.body.url).pathname);
    expect(parseIcs(res.text).events).toHaveLength(2);
    expect((await team.lead.post('/me/calendar-feeds', { workspace: team.slug, projectKey: 'NOPE' })).status).toBe(404);
    expect((await outsider.post('/me/calendar-feeds', { workspace: team.slug })).status).toBe(404);
    expect((await team.lead.post('/me/calendar-feeds', {})).status).toBe(400);
  });

  it('DELETE เพิกถอนลิงก์ทันที · ลบของคนอื่นไม่ได้ · token มั่ว / รูปแบบผิดได้ 404', async () => {
    const path = new URL(leadUrl).pathname;
    expect((await team.dev.delete(`/me/calendar-feeds/${leadFeedId}`)).status).toBe(404);
    expect((await request(t.app.getHttpServer()).get(path)).status).toBe(200);
    expect((await team.lead.delete(`/me/calendar-feeds/${leadFeedId}`)).status).toBe(200);
    expect((await request(t.app.getHttpServer()).get(path)).status).toBe(404);
    expect((await team.lead.delete(`/me/calendar-feeds/${leadFeedId}`)).status).toBe(404);
    expect((await team.lead.get(`/me/calendar-feeds?workspace=${team.slug}`)).body.items).toHaveLength(1);
    expect((await request(t.app.getHttpServer()).get('/api/v1/ical/not-a-token.ics')).status).toBe(404);
    expect((await request(t.app.getHttpServer()).get(`/api/v1/ical/${'a'.repeat(43)}.ics`)).status).toBe(404);
    expect((await team.lead.delete('/me/calendar-feeds/abc')).status).toBe(404);
  });

  it('ออกจาก Workspace แล้วลิงก์เดิมใช้ไม่ได้ · Guest ได้เฉพาะงานที่แชร์', async () => {
    const g = await guest.post('/me/calendar-feeds', { workspace: team.slug });
    const guestId = (await t.owner.query(`SELECT id FROM users WHERE email = 'guest@cal.example.com'`)).rows[0].id;
    const shared = await issue('แชร์ให้ guest', null, '2026-12-16', guestId);
    await t.owner.query('UPDATE issues SET shared_with_guests = true WHERE id = $1', [shared.id]);
    await issue('ไม่แชร์', null, '2026-12-16', guestId);
    const res = await request(t.app.getHttpServer()).get(new URL(g.body.url).pathname);
    expect(parseIcs(res.text).events.map((e) => e.UID)).toEqual([`${shared.id}@friday-manage`]);
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1`, [guestId]);
    expect((await request(t.app.getHttpServer()).get(new URL(g.body.url).pathname)).status).toBe(404);
  });
});

describe('ical.ts', () => {
  it('escape, fold ที่ 75 octets และ DTEND แบบ exclusive', () => {
    expect(icsText('a;b,c\\d\ne')).toBe('a\;b\\,c\\\\d\\ne');
    const folded = fold('X:' + 'ก'.repeat(60));
    for (const l of folded.split('\r\n')) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe('X:' + 'ก'.repeat(60));
    const ics = buildIcs('ทดสอบ', [{ uid: 'u1', start: '2026-12-30', end: '2026-12-31', summary: 'ข้ามปี' }], new Date('2026-12-01T03:04:05Z'));
    expect(ics).toContain('DTSTAMP:20261201T030405Z');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
  });
});
