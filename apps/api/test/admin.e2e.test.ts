// A18 · Admin Console · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, ipAllowed } from '../src/admin/admin.service.js';
import { addMember, client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let moduleId: string;
let guestId: string;
let outsiderId: string;
let ws: string;
let botCalendarId: string;

const audit = async (action: string) => (await t.owner.query(`SELECT category, summary, actor_id FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at DESC`, [wsId, action])).rows;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  ws = team.ws;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  moduleId = team.project.modules[0].id;
  const g = await client(t.app);
  guestId = await signup(g, 'guest@admin.example.com', 'Guest');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });
  const o = await client(t.app);
  outsiderId = await signup(o, 'outsider@admin.example.com', 'Outsider');
  botCalendarId = (await t.owner.query(`SELECT holiday_calendar_id AS id FROM workspace_settings WHERE workspace_id = $1`, [wsId])).rows[0].id;
});
afterAll(() => t.close());

describe('สิทธิ์', () => {
  it('ทุก endpoint เป็นของ Owner / Admin: Member และคนนอก Workspace ไม่ได้', async () => {
    const urls = ['admin/overview', 'settings', 'security-policy', 'holiday-calendars', 'holidays', 'project-templates', 'teams', 'audit-log', 'audit-log.csv'];
    for (const u of urls) {
      expect((await team.dev.get(`${ws}/${u}`)).status, u).toBe(403);
      expect((await team.lead.get(`${ws}/${u}`)).status, u).toBe(200);
    }
    const stranger = await client(t.app);
    await signup(stranger, 'stranger@admin.example.com', 'Stranger');
    expect((await stranger.get(`${ws}/settings`)).status).toBe(404);
    expect((await team.dev.patch(`${ws}/settings`, { safeMode: false })).status).toBe(403);
    expect((await team.dev.post(`${ws}/teams`, { name: 'x' })).status).toBe(403);
    expect((await team.dev.get(`${ws}/audit-log`)).body.error.details.permission).toBe('ws.audit.view');
  });

  it('Admin (ไม่ใช่ Owner) ใช้ได้เหมือนกัน', async () => {
    const a = await client(t.app);
    const id = await signup(a, 'admin@admin.example.com', 'Admin');
    await addMember(t.owner, team.slug, id, 'admin');
    expect((await a.get(`${ws}/settings`)).status).toBe(200);
    expect((await a.get(`${ws}/audit-log`)).status).toBe(200);
    expect(outsiderId).toBeTruthy();
    expect(guestId).toBeTruthy();
  });
});

describe('ภาพรวม', () => {
  it('GET admin/overview: ผู้ใช้, โปรเจกต์, งาน, ที่เก็บ, เรื่องที่ต้องดำเนินการ', async () => {
    for (const title of ['A', 'B', 'C']) await team.lead.post(`${ws}/projects/${team.key}/issues`, { title, moduleId });
    await t.owner.query(`INSERT INTO access_requests (workspace_id, user_id) VALUES ($1, $2)`, [wsId, outsiderId]);
    const r = await team.lead.get(`${ws}/admin/overview`);
    expect(r.status).toBe(200);
    expect(r.body.users).toMatchObject({ active: 3, guests: 1 });
    expect(r.body.projects).toMatchObject({ active: 1, archived: 0 });
    expect(r.body.issues).toEqual({ total: 3, open: 3 });
    expect(r.body.weeklyActiveUsers.length).toBeGreaterThanOrEqual(1);
    expect(r.body.storage).toHaveProperty('usedBytes');
    expect(r.body.plan.code).toBeTruthy();
    expect(r.body.mfa).toEqual({ enabled: 0, total: 4 });
    expect(r.body.actions).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'access_requests_pending', count: 1 })]));
    expect(r.body.projectList).toEqual([expect.objectContaining({ key: 'DP', visibility: 'private', status: expect.any(String), memberCount: 3, pm: expect.objectContaining({ displayName: 'Mick' }) })]);
  });
});

describe('ตั้งค่า Workspace', () => {
  it('GET ค่าเริ่มต้น · PATCH ตรวจข้อมูลและเขียน Audit', async () => {
    const g = await team.lead.get(`${ws}/settings`);
    expect(g.body).toMatchObject({ workStart: '09:30', workEnd: '18:30', workDays: [1, 2, 3, 4, 5], sizeMdMap: { XS: 1, S: 3, M: 5, L: 8, XL: 12 }, allowProjectOverride: true, safeMode: true, trashDays: 30, archiveRetentionYears: null, dataRegion: 'th-bangkok' });
    const bad = async (body: object, code = 400) => expect((await team.lead.patch(`${ws}/settings`, body)).status, JSON.stringify(body)).toBe(code);
    await bad({ workStart: '9:30' });
    await bad({ workEnd: '09:00' }); // เลิกก่อนเริ่ม (เริ่ม 09:30)
    await bad({ workDays: [] });
    await bad({ workDays: [0, 1] });
    await bad({ sizeMdMap: { XS: 1, S: 3, M: 2, L: 8, XL: 12 } });
    await bad({ sizeMdMap: { XS: 1, S: 3, M: 5, L: 8 } });
    await bad({ trashDays: 45 });
    await bad({ holidayCalendarId: '00000000-0000-4000-8000-000000000000' });
    await bad({ unknown: true });

    const ok = await team.lead.patch(`${ws}/settings`, { safeMode: false, trashDays: 90, archiveRetentionYears: 3, sizeMdMap: { XS: 0.5, S: 2, M: 4, L: 8, XL: 13 }, allowProjectOverride: false });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ safeMode: false, trashDays: 90, archiveRetentionYears: 3, allowProjectOverride: false, sizeMdMap: { XS: 0.5, XL: 13 }, recalculated: { projects: 0, issues: 0 } });
    expect((await team.lead.get(`${ws}/settings`)).body.safeMode).toBe(false);
    const rows = await audit('workspace.settings_updated');
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain('safeMode');
    expect(rows[0].category).toBe('notify'); // Safe mode เกี่ยวกับข้อความที่ส่งออกนอกแอป
    // ไม่มีอะไรเปลี่ยน = ไม่เขียน Audit ซ้ำ
    await team.lead.patch(`${ws}/settings`, { safeMode: false });
    expect(await audit('workspace.settings_updated')).toHaveLength(1);
    await team.lead.patch(`${ws}/settings`, { safeMode: true, trashDays: 30, archiveRetentionYears: null, allowProjectOverride: true, sizeMdMap: { XS: 1, S: 3, M: 5, L: 8, XL: 12 } });
  });

  it('เปลี่ยนวันทำงาน → คำนวณ Plan End ของงานที่คร่อมวันใหม่ + plan_change เมื่อมี Baseline', async () => {
    const a = await team.lead.post(`${ws}/projects/${team.key}/issues`, { title: 'คร่อมสุดสัปดาห์', moduleId, estimateMd: 5, planStart: '2026-11-12' });
    expect(a.body).toMatchObject({ planEnd: '2026-11-18' }); // พฤ. ศ. จ. อ. พ.
    expect((await team.lead.post(`${ws}/projects/${team.key}/baselines`, {})).status).toBe(201);
    const r = await team.lead.patch(`${ws}/settings`, { workDays: [6, 1, 2, 3, 4, 5, 6] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.workDays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.body.recalculated).toEqual({ projects: 1, issues: 1 });
    expect((await team.lead.get(`${ws}/issues/${a.body.key}`)).body.planEnd).toBe('2026-11-17'); // เสาร์ 14 เป็นวันทำงาน
    const pcs = await t.owner.query(`SELECT field, reason, source FROM plan_changes pc JOIN issues i ON i.id = pc.issue_id WHERE i.title = 'คร่อมสุดสัปดาห์' AND pc.field = 'planEnd'`);
    expect(pcs.rows).toEqual([{ field: 'planEnd', reason: 'วันหยุดเปลี่ยน', source: 'manual' }]);
    const back = await team.lead.patch(`${ws}/settings`, { workDays: [1, 2, 3, 4, 5] });
    expect(back.body.recalculated.issues).toBe(1);
    expect((await team.lead.get(`${ws}/issues/${a.body.key}`)).body.planEnd).toBe('2026-11-18');
    expect((await audit('workspace.settings_updated')).some((x: { summary: string }) => x.summary.includes('workDays') && x.summary.includes('คำนวณแผนใหม่ 1 งาน'))).toBe(true);
  });
});

describe('ปฏิทินวันหยุด', () => {
  let custom = '';
  let holidayId = '';

  it('รายการปฏิทิน: ของระบบ (ธปท.) แก้ไม่ได้ ต้องคัดลอกก่อน', async () => {
    const list = await team.lead.get(`${ws}/holiday-calendars`);
    expect(list.body.items).toEqual([{ id: botCalendarId, name: 'ธปท. 2569', source: 'bot', holidayCount: 2, isDefault: true, editable: false }]);
    const direct = await team.lead.post(`${ws}/holidays`, { date: '2026-11-17', name: 'วันหยุดบริษัท' });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('calendar_readonly');

    const copy = await team.lead.post(`${ws}/holiday-calendars`, { name: 'ปฏิทินบริษัท', copyFromId: botCalendarId });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body).toMatchObject({ source: 'custom', holidayCount: 2, editable: true, isDefault: false });
    custom = copy.body.id;
    expect((await team.lead.post(`${ws}/holiday-calendars`, { name: 'ปฏิทินบริษัท' })).body.error.code).toBe('calendar_name_taken');
    expect((await team.lead.post(`${ws}/holiday-calendars`, { name: 'x', copyFromId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('ตั้งเป็นปฏิทินเริ่มต้น · เพิ่ม / ลบวันหยุด → Plan End ของทุกโปรเจกต์ที่ใช้คำนวณใหม่', async () => {
    const set = await team.lead.patch(`${ws}/settings`, { holidayCalendarId: custom });
    expect(set.body.holidayCalendarId).toBe(custom);
    const issue = (await team.lead.post(`${ws}/projects/${team.key}/issues`, { title: 'เจอวันหยุด', moduleId, estimateMd: 5, planStart: '2026-11-12' })).body;
    expect(issue.planEnd).toBe('2026-11-18');

    const add = await team.lead.post(`${ws}/holidays`, { date: '2026-11-17', name: 'วันหยุดบริษัท' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.holiday).toMatchObject({ calendarId: custom, date: '2026-11-17', kind: 'company' });
    expect(add.body.recalculated.issues).toBeGreaterThanOrEqual(1);
    expect((await team.lead.get(`${ws}/issues/${issue.key}`)).body.planEnd).toBe('2026-11-19');
    holidayId = add.body.holiday.id;

    expect((await team.lead.post(`${ws}/holidays`, { date: '2026-11-17', name: 'ซ้ำ' })).body.error.code).toBe('holiday_exists');
    expect((await team.lead.post(`${ws}/holidays`, { date: '17/11/2026', name: 'ผิดรูปแบบ' })).status).toBe(400);

    const del = await team.lead.delete(`${ws}/holidays/${holidayId}`);
    expect(del.status).toBe(200);
    expect(del.body.recalculated.issues).toBeGreaterThanOrEqual(1);
    expect((await team.lead.get(`${ws}/issues/${issue.key}`)).body.planEnd).toBe('2026-11-18');
    expect((await team.lead.delete(`${ws}/holidays/${holidayId}`)).status).toBe(404);
    // ลบวันหยุดของปฏิทินระบบไม่ได้
    const sysHoliday = (await t.owner.query(`SELECT id FROM holidays WHERE calendar_id = $1 LIMIT 1`, [botCalendarId])).rows[0].id;
    expect((await team.lead.delete(`${ws}/holidays/${sysHoliday}`)).body.error.code).toBe('calendar_readonly');
    expect((await audit('holiday.added'))[0].summary).toContain('วันหยุดบริษัท');
    expect(await audit('holiday.removed')).toHaveLength(1);
  });

  it('GET holidays กรองตามปี / ช่วง · เปลี่ยนปฏิทินเริ่มต้นกลับ → แผนคำนวณใหม่', async () => {
    const all = await team.lead.get(`${ws}/holidays`);
    expect(all.body.calendarId).toBe(custom);
    expect(all.body.items.map((h: { date: string }) => h.date)).toEqual(['2026-12-07', '2026-12-10']);
    expect((await team.lead.get(`${ws}/holidays?year=2027`)).body.items).toEqual([]);
    expect((await team.lead.get(`${ws}/holidays?calendarId=${botCalendarId}&from=2026-12-08`)).body).toMatchObject({ editable: false, items: [{ date: '2026-12-10' }] });
    // ย้ายปฏิทินที่ใช้: งานที่ช่วงคร่อมวันหยุดของปฏิทินเดิมต้องเปลี่ยน
    await team.lead.post(`${ws}/holidays`, { date: '2026-11-17', name: 'วันหยุดบริษัท' });
    const probe = (await team.lead.post(`${ws}/projects/${team.key}/issues`, { title: 'ย้ายปฏิทิน', moduleId, estimateMd: 5, planStart: '2026-11-12' })).body;
    expect(probe.planEnd).toBe('2026-11-19');
    const back = await team.lead.patch(`${ws}/settings`, { holidayCalendarId: botCalendarId });
    expect(back.body.recalculated.issues).toBeGreaterThanOrEqual(1);
    expect((await team.lead.get(`${ws}/issues/${probe.key}`)).body.planEnd).toBe('2026-11-18');
  });

  it('ลบปฏิทิน: ค่าเริ่มต้น / ที่โปรเจกต์ใช้ / ของระบบ ลบไม่ได้', async () => {
    expect((await team.lead.delete(`${ws}/holiday-calendars/${botCalendarId}`)).body.error.code).toBe('calendar_readonly');
    await t.owner.query(`UPDATE projects SET holiday_calendar_id = $1 WHERE workspace_id = $2`, [custom, wsId]);
    const used = await team.lead.delete(`${ws}/holiday-calendars/${custom}`);
    expect(used.status).toBe(409);
    expect(used.body.error).toMatchObject({ code: 'calendar_in_use', details: { projects: 1 } });
    await t.owner.query(`UPDATE projects SET holiday_calendar_id = NULL WHERE workspace_id = $1`, [wsId]);
    await team.lead.patch(`${ws}/settings`, { holidayCalendarId: custom });
    expect((await team.lead.delete(`${ws}/holiday-calendars/${custom}`)).body.error.code).toBe('calendar_in_use');
    await team.lead.patch(`${ws}/settings`, { holidayCalendarId: botCalendarId });
    expect((await team.lead.delete(`${ws}/holiday-calendars/${custom}`)).status).toBe(200);
    expect((await team.lead.delete(`${ws}/holiday-calendars/${custom}`)).status).toBe(404);
    expect(await audit('calendar.deleted')).toHaveLength(1);
  });
});

describe('Template โปรเจกต์', () => {
  it('CRUD + ตรวจ config + ชื่อซ้ำ · สร้างโปรเจกต์จาก Template แล้วนับการใช้', async () => {
    const config = { labels: [{ name: 'ด่วน', color: '#e11' }], issueTypes: [{ name: 'Task' }, { name: 'Bug' }] };
    const c = await team.lead.post(`${ws}/project-templates`, { name: 'มาตรฐานธนาคาร', description: 'ใช้กับงานสินเชื่อ', config });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ name: 'มาตรฐานธนาคาร', usageCount: 0, config });
    const id = c.body.id;
    expect((await team.lead.post(`${ws}/project-templates`, { name: 'มาตรฐานธนาคาร' })).body.error.code).toBe('template_name_taken');
    expect((await team.lead.post(`${ws}/project-templates`, { name: 'ผิด', config: { issueTypes: [{ name: '' }] } })).status).toBe(400);
    expect((await team.lead.post(`${ws}/project-templates`, { name: '' })).status).toBe(400);
    expect((await team.lead.get(`${ws}/project-templates`)).body.items.map((x: { name: string }) => x.name)).toEqual(['มาตรฐานธนาคาร']);
    expect((await team.lead.get(`${ws}/project-templates/${id}`)).body.description).toBe('ใช้กับงานสินเชื่อ');

    const p = await team.lead.patch(`${ws}/project-templates/${id}`, { name: 'มาตรฐานธนาคาร v2', description: null, config: { labels: [] } });
    expect(p.body).toMatchObject({ name: 'มาตรฐานธนาคาร v2', description: null, config: { labels: [] } });
    expect((await team.lead.patch(`${ws}/project-templates/${id}`, { usageCount: 99 })).status).toBe(400);
    await team.lead.post(`${ws}/project-templates`, { name: 'อีกอัน' });
    expect((await team.lead.patch(`${ws}/project-templates/${id}`, { name: 'อีกอัน' })).body.error.code).toBe('template_name_taken');

    const proj = await team.lead.post(`${ws}/projects`, { name: 'From Template', key: 'FT', startDate: '2026-11-05', goliveDate: '2027-03-01', templateId: id });
    expect(proj.status, JSON.stringify(proj.body)).toBe(201);
    expect((await team.lead.get(`${ws}/project-templates/${id}`)).body.usageCount).toBe(1);

    expect((await team.lead.delete(`${ws}/project-templates/${id}`)).status).toBe(200);
    expect((await team.lead.get(`${ws}/project-templates/${id}`)).status).toBe(404);
    expect((await team.lead.get(`${ws}/projects/FT`)).status).toBe(200); // โปรเจกต์ที่สร้างไปแล้วไม่หาย
    expect((await audit('template.created')).length).toBe(2);
    expect(await audit('template.deleted')).toHaveLength(1);
  });
});

describe('นโยบายความปลอดภัย', () => {
  it('GET ค่าเริ่มต้น + จำนวนคนเปิด 2FA · PATCH ตรวจข้อมูล', async () => {
    const g = await team.lead.get(`${ws}/security-policy`);
    expect(g.body).toMatchObject({ passwordMinLength: 10, passwordRequireSpecial: true, passwordRotationDays: null, lockoutAttempts: 5, lockoutMinutes: 15, sessionIdleHours: 8, mfaEnforcement: 'none', allowedEmailDomains: [], ipAllowlist: [] });
    expect(g.body.mfa).toMatchObject({ enabled: 0, total: 4 });
    expect(g.body.mfa.missing.map((m: { displayName: string }) => m.displayName).sort()).toEqual(['Admin', 'Guest', 'Kaijeaw', 'Mick']);

    const bad = async (body: object) => expect((await team.lead.patch(`${ws}/security-policy`, body)).status, JSON.stringify(body)).toBe(400);
    await bad({ passwordMinLength: 4 });
    await bad({ lockoutAttempts: 1 });
    await bad({ sessionIdleHours: 0 });
    await bad({ mfaEnforcement: 'sometimes' });
    await bad({ allowedEmailDomains: ['not a domain'] });
    await bad({ passwordRotationDays: 7 });
    await bad({ ipAllowlist: ['999.1.1.1'] });
    await bad({ nope: 1 });

    const ok = await team.lead.patch(`${ws}/security-policy`, { passwordMinLength: 12, passwordRotationDays: 90, lockoutAttempts: 3, sessionIdleHours: 1, mfaEnforcement: 'admin', allowedEmailDomains: ['Example.com', 'example.com', 'corp.example.org'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ passwordMinLength: 12, passwordRotationDays: 90, lockoutAttempts: 3, sessionIdleHours: 1, mfaEnforcement: 'admin', allowedEmailDomains: ['example.com', 'corp.example.org'] });
    const rows = await audit('security_policy.updated');
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('secu');
    // mfaEnforcement ≠ none + มีคนยังไม่เปิด → ขึ้นในเรื่องที่ต้องดำเนินการ
    const ov = await team.lead.get(`${ws}/admin/overview`);
    expect(ov.body.actions.some((a: { code: string }) => a.code === 'mfa_missing')).toBe(true);
    await team.lead.patch(`${ws}/security-policy`, { passwordMinLength: 10, passwordRotationDays: null, lockoutAttempts: 5, sessionIdleHours: 8, mfaEnforcement: 'none', allowedEmailDomains: [] });
  });

  it('IP Allowlist: ต้องมี IP ของผู้แก้เอง (กันล็อกตัวเองออก) · รองรับ CIDR', async () => {
    const locked = await team.lead.patch(`${ws}/security-policy`, { ipAllowlist: ['203.0.113.10'] });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('ip_allowlist_locks_you_out');
    const ok = await team.lead.patch(`${ws}/security-policy`, { ipAllowlist: ['203.0.113.10', '127.0.0.0/8', '127.0.0.0/8'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.ipAllowlist).toEqual(['203.0.113.10', '127.0.0.0/8']);
    expect((await team.lead.patch(`${ws}/security-policy`, { ipAllowlist: [] })).body.ipAllowlist).toEqual([]);

    expect(ipAllowed([], '1.2.3.4')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '10.20.30.40')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '::ffff:10.1.1.1')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '11.0.0.1')).toBe(false);
    expect(ipAllowed(['2001:db8::/32'], '2001:db8::1')).toBe(true);
    expect(ipAllowed(['10.0.0.1'], undefined)).toBe(false);
  });
});

describe('ทีม', () => {
  let teamId = '';

  it('สร้างทีมพร้อมหัวหน้าและสมาชิก · ตัวเลขทีมคำนวณจากสมาชิก', async () => {
    const r = await team.lead.post(`${ws}/teams`, { name: 'ทีม BA', color: '#2563eb', leadUserId: team.leadId, memberIds: [team.leadId, team.devId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    teamId = r.body.id;
    expect(r.body).toMatchObject({ name: 'ทีม BA', color: '#2563eb', lead: { id: team.leadId, displayName: 'Mick' }, memberCount: 2, capacityMdWeek: 10, projectCount: 2 }); // DP + FT (สร้างจาก Template ในข้อก่อนหน้า)
    expect(r.body.members.map((m: { displayName: string }) => m.displayName)).toEqual(['Kaijeaw', 'Mick']);
    const list = await team.lead.get(`${ws}/teams`);
    expect(list.body.items).toEqual([expect.objectContaining({ id: teamId, memberCount: 2, capacityMdWeek: 10 })]);
    expect((await team.lead.get(`${ws}/teams/${teamId}`)).body.members).toHaveLength(2);
    expect((await team.lead.get(`${ws}/teams/nope`)).status).toBe(404);
  });

  it('ตรวจชื่อซ้ำ · สมาชิกต้องเป็นสมาชิก active ที่ไม่ใช่ Guest', async () => {
    expect((await team.lead.post(`${ws}/teams`, { name: 'ทีม ba' })).body.error.code).toBe('team_name_taken');
    for (const bad of [guestId, outsiderId]) {
      const r = await team.lead.post(`${ws}/teams`, { name: 'ผิด', memberIds: [bad] });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_team_members');
      expect((await team.lead.post(`${ws}/teams/${teamId}/members`, { userIds: [bad] })).status).toBe(400);
    }
    expect((await team.lead.post(`${ws}/teams`, { name: 'หัวหน้าไม่ใช่สมาชิก', leadUserId: outsiderId })).status).toBe(400);
    expect((await team.lead.post(`${ws}/teams`, { name: '' })).status).toBe(400);
  });

  it('แก้ทีม · เพิ่ม / เอาสมาชิกออก (หัวหน้าที่ออกจากทีม = ไม่มีหัวหน้า) · ลบทีม', async () => {
    const p = await team.lead.patch(`${ws}/teams/${teamId}`, { name: 'ทีม Business Analyst', leadUserId: team.devId });
    expect(p.body).toMatchObject({ name: 'ทีม Business Analyst', lead: { id: team.devId } });
    const adminId = (await t.owner.query(`SELECT id FROM users WHERE email = 'admin@admin.example.com'`)).rows[0].id;
    const add = await team.lead.post(`${ws}/teams/${teamId}/members`, { userIds: [adminId, team.devId] });
    expect(add.body.memberCount).toBe(3);
    const out = await team.lead.delete(`${ws}/teams/${teamId}/members/${team.devId}`);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ memberCount: 2, lead: null });
    expect((await team.lead.delete(`${ws}/teams/${teamId}/members/${team.devId}`)).status).toBe(404);
    expect((await team.lead.delete(`${ws}/teams/${teamId}`)).status).toBe(200);
    expect((await team.lead.get(`${ws}/teams/${teamId}`)).status).toBe(404);
    expect((await team.lead.get(`${ws}/teams`)).body.items).toEqual([]);
    for (const a of ['team.created', 'team.updated', 'team.members_added', 'team.member_removed', 'team.deleted']) expect((await audit(a)).length, a).toBe(1);
  });
});

describe('Audit log', () => {
  it('กรองตามหมวด / ผู้ใช้ / การกระทำ / ช่วงเวลา · แบ่งหน้า', async () => {
    const all = await team.lead.get(`${ws}/audit-log?limit=200`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThan(10);
    expect(all.body.items[0]).toMatchObject({ actor: { kind: 'user' }, category: expect.any(String), action: expect.any(String) });
    const times = all.body.items.map((x: { at: string }) => Date.parse(x.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const secu = await team.lead.get(`${ws}/audit-log?category=secu`);
    expect(secu.body.items.length).toBeGreaterThan(0);
    expect(secu.body.items.every((x: { category: string }) => x.category === 'secu')).toBe(true);
    const byUser = await team.lead.get(`${ws}/audit-log?user=${team.devId}`);
    expect(byUser.body.items).toEqual([]);
    const byAction = await team.lead.get(`${ws}/audit-log?action=team.created`);
    expect(byAction.body.items.map((x: { action: string }) => x.action)).toEqual(['team.created']);
    expect(byAction.body.items[0].actor.displayName).toBe('Mick');

    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    expect((await team.lead.get(`${ws}/audit-log?from=${day(-1)}&to=${day(1)}&limit=200`)).body.items.length).toBe(all.body.items.length);
    expect((await team.lead.get(`${ws}/audit-log?to=${day(-2)}`)).body.items).toEqual([]);
    expect((await team.lead.get(`${ws}/audit-log?from=${day(2)}`)).body.items).toEqual([]);

    const p1 = await team.lead.get(`${ws}/audit-log?limit=3`);
    expect(p1.body.items).toHaveLength(3);
    expect(p1.body.nextCursor).toBe(p1.body.items[2].at);
    const p2 = await team.lead.get(`${ws}/audit-log?limit=3&before=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items.every((x: { at: string }) => Date.parse(x.at) < Date.parse(p1.body.nextCursor))).toBe(true);
    expect((await team.lead.get(`${ws}/audit-log?category=bogus`)).status).toBe(400);
    expect((await team.lead.get(`${ws}/audit-log?limit=1000`)).status).toBe(400);
  });

  it('audit-log.csv: UTF-8 BOM, หัวภาษาไทย, escape, และการ export ถูกบันทึกด้วย', async () => {
    const r = await team.lead.get(`${ws}/audit-log.csv?category=plan`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('audit-log-friday-dev.csv');
    const text = r.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.replace(/\r\n$/, '').split('\r\n');
    expect(lines[0]).toBe('﻿เวลา,ผู้ใช้,ประเภทผู้กระทำ,หมวด,การกระทำ,ชนิดรายการ,รหัสรายการ,รายละเอียด,IP');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(1).every((l) => l.split(',')[3] === 'plan')).toBe(true);
    expect((await audit('audit_log.exported'))[0].summary).toContain('Export Audit log');

    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('ปกติ')).toBe('ปกติ');
  });
});
