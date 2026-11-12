// A04 · ข้อมูลโปรเจกต์, สมาชิกโปรเจกต์, Archive / โอน / ลบ และ Template · ข้อมูลสมมติทั้งหมด
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let qa: Client;
let qaId: string;
let guest: Client;
let guestId: string;
let wsAdmin: Client;
let wsAdminId: string;
let outsiderId: string;
const seen: DomainEvent[] = [];

beforeAll(async () => {
  t = await startApp();
  t.app.get(EventBus).on('*', (e) => {
    seen.push(e);
  });
  team = await seedTeam(t);
  qa = await client(t.app);
  guest = await client(t.app);
  wsAdmin = await client(t.app);
  const outsider = await client(t.app);
  qaId = await signup(qa, 'qa@projects.example.com', 'Somchai Tester');
  guestId = await signup(guest, 'guest@projects.example.com', 'Client Guest');
  wsAdminId = await signup(wsAdmin, 'admin@projects.example.com', 'Ws Admin');
  outsiderId = await signup(outsider, 'outsider@projects.example.com', 'Out Sider');
  // QA เป็นสมาชิก Workspace แต่ยังไม่อยู่ในโปรเจกต์ · Guest เป็น Viewer ของ DP
  await addMember(t.owner, team.slug, qaId, 'member');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: 'DP', role: 'viewer' });
  await addMember(t.owner, team.slug, wsAdminId, 'admin');
});
afterAll(() => t.close());

const p = (key: string, rest = '') => `${team.ws}/projects/${key}${rest}`;

async function mkProject(c: Client, key: string, extra: Record<string, unknown> = {}) {
  const r = await c.post(`${team.ws}/projects`, { name: `โปรเจกต์ ${key}`, key, startDate: '2026-11-02', goliveDate: '2027-02-26', modules: ['Core'], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

async function mkIssue(c: Client, key: string, body: Record<string, unknown>) {
  const detail = (await c.get(p(key))).body;
  const r = await c.post(p(key, '/issues'), { title: 'งานทดสอบ', moduleId: detail.modules[0].id, ...body });
  expect(r.status).toBe(201);
  return r.body as { id: string; key: string; version: number };
}

describe('แคช HTTP ของ GET', () => {
  it('ETag ใช้กับ If-Match เท่านั้น: เพิ่ม Module แล้ว GET ซ้ำด้วย If-None-Match ยังได้ข้อมูลใหม่ ไม่ใช่ 304', async () => {
    const before = await team.lead.get(p('DP'));
    expect(before.headers['cache-control']).toBe('no-store');
    const created = await team.lead.post(p('DP', '/modules'), { name: 'Module หลังแคช', color: '#1d4ed8' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const again = await team.lead.agent.get(`/api/v1${p('DP')}`).set('If-None-Match', before.headers.etag);
    expect(again.status).toBe(200);
    expect(again.body.modules.map((m: { id: string }) => m.id)).toContain(created.body.id);
  });
});

describe('PATCH p/ (L2 › ทั่วไป)', () => {
  it('ต้องส่ง If-Match · version ไม่ตรงได้ 409 · แก้สำเร็จได้ ETag ใหม่ และบันทึก Audit', async () => {
    const got = await team.lead.get(p('DP'));
    expect(got.headers.etag).toBe(`"${got.body.version}"`);
    const v = got.body.version;

    expect((await team.lead.patch(p('DP'), { name: 'x' })).status).toBe(428);
    const stale = await team.lead.patch(p('DP'), { name: 'x' }, v + 5);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'conflict', details: { latest: { key: 'DP', version: v } } });

    const r = await team.lead.patch(
      p('DP'),
      { name: 'Development Plan 2026-11', clientName: 'ลูกค้าสมมติ', visibility: 'workspace', sizeMdMap: { XS: 1, S: 2, M: 4, L: 8, XL: 12 }, workStart: '09:00', workEnd: '18:00', timeLogEnabled: true },
      v,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Development Plan 2026-11', clientName: 'ลูกค้าสมมติ', visibility: 'workspace', sizeMdMap: { S: 2 }, workStart: '09:00', workEnd: '18:00', timeLogEnabled: true, version: v + 1, warnings: [] });
    expect(r.headers.etag).toBe(`"${v + 1}"`);
    // Size → MD ของโปรเจกต์ใช้กับงานใหม่ทันที
    const issue = await mkIssue(team.lead, 'DP', { size: 'S', planStart: '2026-11-09' });
    expect((await team.lead.get(`${team.ws}/issues/${issue.key}`)).body.estimateMd).toBe(2);
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'project.updated'`);
    expect(audit.rows[0].summary).toContain('sizeMdMap');

    // ไม่มีอะไรเปลี่ยน → version เดิม
    const same = await team.lead.patch(p('DP'), { name: 'Development Plan 2026-11' }, v + 1);
    expect(same.body.version).toBe(v + 1);
  });

  it('ตรวจสิทธิ์ project.settings วันที่ และ Workspace ที่ปิดการตั้งค่าเอง', async () => {
    const v = (await team.lead.get(p('DP'))).body.version;
    const dev = await team.dev.patch(p('DP'), { name: 'x' }, v);
    expect(dev.status).toBe(403);
    expect(dev.body.error.details.permission).toBe('project.settings');
    const dates = await team.lead.patch(p('DP'), { goliveDate: '2026-10-01' }, v);
    expect(dates.status).toBe(400);
    expect(dates.body.error.code).toBe('invalid_dates');
    expect((await team.lead.patch(p('DP'), { workStart: '18:00', workEnd: '09:00' }, v)).body.error.code).toBe('invalid_work_hours');
    expect((await team.lead.patch(p('DP'), {}, v)).status).toBe(400);

    await t.owner.query('UPDATE workspace_settings SET allow_project_override = false');
    const blocked = await team.lead.patch(p('DP'), { sizeMdMap: { XS: 1, S: 3, M: 5, L: 8, XL: 13 } }, v);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'project_override_disabled', details: { fields: ['sizeMdMap'] } });
    // ล้างกลับไปใช้ค่าของ Workspace ได้เสมอ
    const reset = await team.lead.patch(p('DP'), { sizeMdMap: null }, v);
    expect(reset.status).toBe(200);
    expect(reset.body.sizeMdMap).toBeNull();
    await t.owner.query('UPDATE workspace_settings SET allow_project_override = true');

    const cal = await t.owner.query(`SELECT id FROM holiday_calendars LIMIT 1`);
    const withCal = await team.lead.patch(p('DP'), { holidayCalendarId: cal.rows[0].id }, reset.body.version);
    expect(withCal.status).toBe(200);
    expect(withCal.body.warnings.map((w: { code: string }) => w.code)).toEqual(['plan_end_not_recalculated']);
    expect((await team.lead.patch(p('DP'), { holidayCalendarId: '00000000-0000-4000-8000-000000000000' }, withCal.body.version)).body.error.code).toBe('holiday_calendar_not_found');
  });
});

describe('เปลี่ยน Key และ 301 project_moved', () => {
  it('Key เก่าตอบ 301 พร้อม details.key ทุก endpoint ที่โหลดผ่าน ProjectsService.load', async () => {
    await mkProject(team.lead, 'KEY', { visibility: 'private' });
    const issue = await mkIssue(team.lead, 'KEY', {});
    const v = (await team.lead.get(p('KEY'))).body.version;

    const renamed = await team.lead.patch(p('KEY'), { key: 'kx' }, v);
    expect(renamed.status).toBe(200);
    expect(renamed.body.key).toBe('KX');

    for (const url of [p('KEY'), p('key', '/my-permissions'), p('KEY', '/board'), p('KEY', '/issues'), `${team.ws}/issues/${issue.key}`, `${team.ws}/issues/${issue.key}/comments`]) {
      const r = await team.lead.get(url);
      expect(r.status, url).toBe(301);
      expect(r.body.error).toMatchObject({ code: 'project_moved', details: { key: 'KX', oldKey: 'KEY' } });
    }
    expect((await team.lead.post(p('KEY', '/issues'), { title: 'x' })).status).toBe(301);
    expect((await team.lead.get(`${team.ws}/issues/KX-1`)).status).toBe(200);
    // คนที่ไม่ได้อยู่ในโปรเจกต์ Private ไม่รู้ว่ามี Key ใหม่
    expect((await qa.get(p('KEY'))).status).toBe(404);

    // Key เก่าถูกจองไว้ · โปรเจกต์อื่นใช้ไม่ได้ แต่เปลี่ยนกลับเองได้
    expect((await team.lead.get(`${team.ws}/projects/key-available?key=KEY`)).body.available).toBe(false);
    const other = await mkProject(team.lead, 'OTH');
    expect((await team.lead.patch(p('OTH'), { key: 'KEY' }, other.version)).body.error.code).toBe('key_taken');
    expect((await team.lead.patch(p('OTH'), { key: 'DP' }, other.version)).body.error.code).toBe('key_taken');
    const back = await team.lead.patch(p('KX'), { key: 'KEY' }, renamed.body.version);
    expect(back.status).toBe(200);
    expect((await team.lead.get(p('KEY'))).status).toBe(200);
    expect((await team.lead.get(p('KX'))).body.error).toMatchObject({ code: 'project_moved', details: { key: 'KEY' } });
    const aliases = await t.owner.query(`SELECT old_key FROM project_key_aliases ORDER BY old_key`);
    expect(aliases.rows.map((r) => r.old_key)).toEqual(['KX']);
    const changed = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'project.key_changed' ORDER BY created_at`);
    expect(changed.rows.map((r) => r.summary)).toEqual(['KEY → KX', 'KX → KEY']);
  });
});

describe('สมาชิกโปรเจกต์ (p/members)', () => {
  it('รายชื่อเรียง Owner ก่อน พร้อมงานค้าง / เลยกำหนด และ capacity เป็น MD · Guest Viewer ไม่เห็น', async () => {
    await mkIssue(team.lead, 'DP', { assigneeIds: [team.devId], size: 'M', planStart: '2026-11-09' });
    await mkIssue(team.lead, 'DP', { assigneeIds: [team.devId, team.leadId], estimateMd: 4, planStart: '2026-01-05', planEnd: '2026-01-06' });
    await t.owner.query(`UPDATE project_members SET capacity_hours_week = 40, position = 'Backend' WHERE user_id = $1`, [team.devId]);

    const r = await team.lead.get(p('DP', '/members'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ canInvite: true, canManage: true });
    const [owner, dev, g] = r.body.items;
    expect(owner).toMatchObject({ userId: team.leadId, isOwner: true, role: 'admin', email: 'lead@friday-dev.example.com', initials: 'MI' });
    expect(dev).toMatchObject({ userId: team.devId, role: 'member', position: 'Backend', capacityHoursWeek: 40, capacityMdWeek: 5, openIssues: 2, overdueIssues: 1, openMd: 7, isGuest: false });
    expect(g).toMatchObject({ userId: guestId, role: 'viewer', isGuest: true });

    const forGuest = await guest.get(p('DP', '/members'));
    expect(forGuest.status).toBe(403);
    expect((await team.dev.get(p('DP', '/members'))).body).toMatchObject({ canInvite: false, canManage: false });
  });

  it('เพิ่มสมาชิก Workspace เข้าโปรเจกต์ · ตรวจสิทธิ์ project.invite, Guest และการตั้งเป็น Admin', async () => {
    seen.length = 0;
    const devAdd = await team.dev.post(p('DP', '/members'), { userId: qaId });
    expect(devAdd.status).toBe(403);
    expect(devAdd.body.error.details.permission).toBe('project.invite');

    expect((await team.lead.post(p('DP', '/members'), { userId: outsiderId })).body.error.code).toBe('not_workspace_member');
    expect((await team.lead.post(p('DP', '/members'), { userId: guestId, role: 'admin' })).body.error.code).toBe('guest_role_limit');
    expect((await team.lead.post(p('DP', '/members'), { userId: guestId, role: 'viewer' })).body.error.code).toBe('already_project_member');

    const r = await team.lead.post(p('DP', '/members'), { userId: qaId, role: 'member', position: 'QA', capacityHoursWeek: 20 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ userId: qaId, role: 'member', position: 'QA', capacityMdWeek: 2.5, openIssues: 0 });
    expect(seen.map((e) => [e.type, e.data.userId])).toEqual([['member.joined', qaId]]);
    expect((await qa.get(p('DP'))).status).toBe(200);
    expect((await team.lead.post(p('DP', '/members'), { userId: qaId })).status).toBe(409);

    // Member ที่ PM เปิด "เชิญสมาชิก" ให้ เชิญได้ แต่ตั้งเป็น Admin ไม่ได้
    await team.lead.put(p('DP', '/role-permissions'), { role: 'member', permission: 'project.invite', allowed: true });
    const wsAdminAsAdmin = await team.dev.post(p('DP', '/members'), { userId: wsAdminId, role: 'admin' });
    expect(wsAdminAsAdmin.status).toBe(403);
    expect(wsAdminAsAdmin.body.error.details.permission).toBe('project.settings');
    expect((await team.dev.post(p('DP', '/members'), { userId: wsAdminId, role: 'viewer' })).status).toBe(201);
    await team.lead.put(p('DP', '/role-permissions'), { role: 'member', permission: 'project.invite', allowed: false });
  });

  it('แก้ Role / ตำแหน่ง / capacity · Owner เป็น Admin เสมอ · Guest เป็น Admin ไม่ได้', async () => {
    const r = await team.lead.patch(p('DP', `/members/${qaId}`), { role: 'viewer', capacityHoursWeek: 16, position: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'viewer', capacityHoursWeek: 16, position: null });
    expect((await qa.get(p('DP', '/my-permissions'))).body.role).toBe('viewer');
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'project.member_role_changed'`);
    expect(audit.rows[0].summary).toContain('member → viewer');

    expect((await team.lead.patch(p('DP', `/members/${team.leadId}`), { role: 'member' })).body.error.code).toBe('owner_role_fixed');
    expect((await team.lead.patch(p('DP', `/members/${guestId}`), { role: 'admin' })).body.error.code).toBe('guest_role_limit');
    expect((await team.dev.patch(p('DP', `/members/${qaId}`), { role: 'member' })).status).toBe(403);
    expect((await team.lead.patch(p('DP', `/members/${outsiderId}`), { role: 'member' })).status).toBe(404);
    expect((await team.lead.patch(p('DP', '/members/not-a-uuid'), { role: 'member' })).status).toBe(400);
  });

  it('ลบคนที่มีงานค้างต้องเลือก reassignTo · โอนเฉพาะงานที่ยังไม่เสร็จ พร้อม version, Activity และ Event', async () => {
    await mkProject(team.lead, 'RM');
    await team.lead.post(p('RM', '/members'), { userId: team.devId });
    await team.lead.post(p('RM', '/members'), { userId: qaId });
    const a = await mkIssue(team.lead, 'RM', { assigneeIds: [team.devId], size: 'S', planStart: '2026-11-09' });
    const b = await mkIssue(team.lead, 'RM', { assigneeIds: [team.devId, qaId], size: 'M', planStart: '2026-11-09' });
    const sub = await mkIssue(team.lead, 'RM', { parentKey: a.key, assigneeIds: [team.devId], size: 'XS', planStart: '2026-11-09' });
    const done = await mkIssue(team.lead, 'RM', { assigneeIds: [team.devId], size: 'XS', planStart: '2026-11-09' });
    const doneStatus = (await team.lead.get(p('RM'))).body.statuses.find((s: { category: string; boardColumnId: string | null }) => s.category === 'done' && !s.boardColumnId).id;
    await team.lead.post(`${team.ws}/issues/${done.key}/move`, { statusId: doneStatus });

    const ask = await team.lead.delete(p('RM', `/members/${team.devId}`));
    expect(ask.status).toBe(409);
    expect(ask.body.error).toMatchObject({ code: 'member_has_open_issues', details: { openIssues: 3, openSubtasks: 1, openMd: 3 + 2.5 + 1 } });
    expect((await team.lead.delete(p('RM', `/members/${team.devId}`), { reassignTo: outsiderId })).body.error.code).toBe('reassign_target_invalid');
    expect((await team.lead.delete(p('RM', `/members/${team.devId}`), { reassignTo: team.devId })).body.error.code).toBe('reassign_target_invalid');
    expect((await team.dev.delete(p('RM', `/members/${qaId}`), { reassignTo: null })).status).toBe(403);

    seen.length = 0;
    const r = await team.lead.delete(p('RM', `/members/${team.devId}`), { reassignTo: qaId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ removed: true, reassigned: 3, reassignTo: qaId });

    const assignees = async (key: string) => (await team.lead.get(`${team.ws}/issues/${key}`)).body;
    const ia = await assignees(a.key);
    expect(ia.assigneeIds).toEqual([qaId]);
    expect(ia.version).toBe(a.version + 1);
    expect((await assignees(b.key)).assigneeIds).toEqual([qaId]);
    expect((await assignees(sub.key)).assigneeIds).toEqual([qaId]);
    // งานที่เสร็จแล้วยังแสดงชื่อเดิม
    expect((await assignees(done.key)).assigneeIds).toEqual([team.devId]);
    expect(seen.filter((e) => e.type === 'issue.assigned').map((e) => [e.data.issueKey, e.data.userIds, e.data.removedUserIds])).toEqual([
      [a.key, [qaId], [team.devId]],
      [b.key, [], [team.devId]],
      [sub.key, [qaId], [team.devId]],
    ]);
    const act = await t.owner.query(`SELECT count(*)::int AS n FROM activities WHERE field = 'assigneeIds' AND actor_id = $1 AND verb = 'updated'`, [team.leadId]);
    expect(act.rows[0].n).toBe(3);
    expect((await team.dev.get(p('RM'))).status).toBe(404);
  });

  it('ลบโดยไม่ระบุผู้รับผิดชอบ · ออกจากโปรเจกต์เอง · Owner ถูกนำออกไม่ได้', async () => {
    const i = await mkIssue(team.lead, 'RM', { assigneeIds: [qaId], size: 'XS', planStart: '2026-11-09' });
    expect((await team.lead.delete(p('RM', `/members/${team.leadId}`))).body.error.code).toBe('owner_cannot_be_removed');
    const left = await qa.delete(p('RM', `/members/${qaId}`), { reassignTo: null });
    expect(left.status).toBe(200);
    expect(left.body.reassigned).toBe(4);
    expect((await team.lead.get(`${team.ws}/issues/${i.key}`)).body.assigneeIds).toEqual([]);
    expect((await team.lead.delete(p('RM', `/members/${qaId}`))).status).toBe(404);
  });

  it('Guest ที่เป็น Member เห็นรายชื่อในโปรเจกต์แต่ไม่เห็นอีเมล', async () => {
    await mkProject(team.lead, 'GM');
    expect((await team.lead.post(p('GM', '/members'), { userId: guestId, role: 'admin' })).body.error.code).toBe('guest_role_limit');
    expect((await team.lead.post(p('GM', '/members'), { userId: guestId, role: 'member' })).status).toBe(201);
    const r = await guest.get(p('GM', '/members'));
    expect(r.status).toBe(200);
    expect(r.body.items.every((m: { email: string | null }) => m.email === null)).toBe(true);
    expect(r.body.canInvite).toBe(false);
  });
});

describe('Archive / Restore', () => {
  it('Archive แล้วอ่านอย่างเดียว · เขียนได้ 403 project_archived · Restore แล้วแก้ได้อีก', async () => {
    await mkProject(team.lead, 'ARC');
    await team.lead.post(p('ARC', '/members'), { userId: team.devId });
    const issue = await mkIssue(team.lead, 'ARC', { size: 'S', planStart: '2026-11-09' });

    expect((await team.dev.post(p('ARC', '/archive'))).body.error.details.permission).toBe('project.archive');
    const r = await team.lead.post(p('ARC', '/archive'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'archived', archivedAt: expect.any(String) });
    expect((await team.lead.post(p('ARC', '/archive'))).body.error.code).toBe('already_archived');

    const perms = (await team.dev.get(p('ARC', '/my-permissions'))).body.permissions;
    expect(perms).toEqual(['project.reports.view', 'project.view', 'project.workload.view']);
    expect((await team.lead.get(p('ARC', '/my-permissions'))).body.permissions).toEqual(['project.archive', 'project.reports.view', 'project.view', 'project.workload.view']);
    expect((await team.dev.get(p('ARC', '/board'))).status).toBe(200);
    expect((await team.lead.get(`${team.ws}/issues/${issue.key}`)).status).toBe(200);

    const blocked = [
      await team.dev.post(p('ARC', '/issues'), { title: 'x' }),
      await team.lead.patch(`${team.ws}/issues/${issue.key}`, { title: 'x' }, issue.version),
      await team.lead.post(`${team.ws}/issues/${issue.key}/comments`, { body: 'ทดสอบ' }),
      await team.lead.patch(p('ARC'), { name: 'x' }, r.body.version),
      await team.lead.post(p('ARC', '/members'), { userId: qaId }),
    ];
    for (const b of blocked) {
      expect(b.status).toBe(403);
      expect(b.body.error.code).toBe('project_archived');
    }

    const listed = await team.lead.get(`${team.ws}/projects?status=archived`);
    expect(listed.body.items.map((x: { key: string }) => x.key)).toEqual(['ARC']);
    expect((await team.lead.get(`${team.ws}/projects?status=done`)).status).toBe(400);

    const restored = await team.lead.post(p('ARC', '/restore'));
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ archivedAt: null });
    expect(['planning', 'active']).toContain(restored.body.status);
    expect((await team.lead.post(p('ARC', '/restore'))).body.error.code).toBe('not_archived');
    expect((await team.dev.post(p('ARC', '/issues'), { title: 'กลับมาแก้ได้', moduleId: (await team.dev.get(p('ARC'))).body.modules[0].id })).status).toBe(201);
    const audit = await t.owner.query(`SELECT action FROM audit_logs WHERE action IN ('project.archived', 'project.restored') ORDER BY created_at`);
    expect(audit.rows.map((x) => x.action)).toEqual(['project.archived', 'project.restored']);
  });
});

describe('โอนความเป็นเจ้าของ', () => {
  it('Project Owner โอนให้สมาชิก (ไม่ใช่ Guest) · ผู้รับเป็น Admin · เจ้าของเดิมยังเป็น Admin · แจ้งผู้รับ', async () => {
    await mkProject(team.lead, 'TRF');
    await team.lead.post(p('TRF', '/members'), { userId: team.devId });
    await team.lead.post(p('TRF', '/members'), { userId: guestId });

    expect((await team.dev.post(p('TRF', '/transfer'), { userId: team.devId })).body.error.details.permission).toBe('project.owner');
    expect((await team.lead.post(p('TRF', '/transfer'), { userId: qaId })).body.error.code).toBe('transfer_target_invalid');
    expect((await team.lead.post(p('TRF', '/transfer'), { userId: guestId })).body.error.code).toBe('guest_cannot_own');
    expect((await team.lead.post(p('TRF', '/transfer'), { userId: team.leadId })).body.error.code).toBe('already_owner');

    const r = await team.lead.post(p('TRF', '/transfer'), { userId: team.devId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ownerUserId: team.devId, myRole: 'admin' });
    expect((await team.dev.get(p('TRF', '/my-permissions'))).body.role).toBe('admin');
    const members = (await team.dev.get(p('TRF', '/members'))).body.items;
    expect(members[0]).toMatchObject({ userId: team.devId, isOwner: true });
    expect(members.find((m: { userId: string }) => m.userId === team.leadId).role).toBe('admin');
    const note = await t.owner.query(`SELECT reason FROM notifications WHERE event_type = 'project.transferred' AND recipient_id = $1`, [team.devId]);
    expect(note.rowCount).toBe(1);
    // เจ้าของคนใหม่นำเจ้าของเดิมออกได้ · คนที่ไม่ใช่ Owner (และไม่ใช่ Admin ของ Workspace) โอนไม่ได้
    expect((await team.dev.delete(p('TRF', `/members/${team.leadId}`))).status).toBe(200);
    await team.dev.post(p('TRF', '/members'), { userId: qaId, role: 'admin' });
    expect((await qa.post(p('TRF', '/transfer'), { userId: qaId })).body.error.details.permission).toBe('project.owner');
  });

  it('Workspace Admin ที่เข้าร่วมแล้วโอนโปรเจกต์กำพร้าได้', async () => {
    await mkProject(team.dev, 'ORP');
    await team.dev.post(p('ORP', '/members'), { userId: qaId });
    expect((await wsAdmin.post(p('ORP', '/transfer'), { userId: qaId })).body.error.code).toBe('not_project_member');
    expect((await wsAdmin.post(p('ORP', '/join-as-admin'))).status).toBe(200);
    const r = await wsAdmin.post(p('ORP', '/transfer'), { userId: qaId });
    expect(r.status).toBe(200);
    expect(r.body.ownerUserId).toBe(qaId);
  });
});

describe('ลบโปรเจกต์ (soft delete 30 วัน)', () => {
  it('delete-impact บอกจำนวน · ต้องพิมพ์ Key ให้ตรง · ลบแล้วได้ 410 และ Key ว่างให้โปรเจกต์ใหม่', async () => {
    await mkProject(team.lead, 'DEL');
    await team.lead.post(p('DEL', '/members'), { userId: team.devId });
    await mkIssue(team.lead, 'DEL', {});
    await mkIssue(team.lead, 'DEL', {});

    const impact = await team.lead.get(p('DEL', '/delete-impact'));
    expect(impact.status).toBe(200);
    expect(impact.body).toEqual({ key: 'DEL', name: 'โปรเจกต์ DEL', issues: 2, files: 0, members: 2, trashDays: 30, canDelete: true });
    expect((await team.dev.get(p('DEL', '/delete-impact'))).status).toBe(403);
    expect((await team.dev.delete(p('DEL'), { confirmKey: 'DEL' })).status).toBe(403);
    expect((await team.lead.delete(p('DEL'), {})).status).toBe(400);
    const wrong = await team.lead.delete(p('DEL'), { confirmKey: 'DP' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('confirm_key_mismatch');

    const r = await team.lead.delete(p('DEL'), { confirmKey: 'del' });
    expect(r.status).toBe(200);
    expect(new Date(r.body.restorableUntil).getTime() - new Date(r.body.deletedAt).getTime()).toBe(30 * 86_400_000);

    const gone = await team.dev.get(p('DEL'));
    expect(gone.status).toBe(410);
    expect(gone.body.error).toMatchObject({ code: 'project_deleted', details: { restorableUntil: r.body.restorableUntil } });
    expect((await team.dev.get(`${team.ws}/issues/DEL-1`)).status).toBe(410);
    expect((await team.lead.get(`${team.ws}/projects`)).body.items.map((x: { key: string }) => x.key)).not.toContain('DEL');
    // Key ของโปรเจกต์ในถังขยะใช้ซ้ำได้ (O30 · A41) · กู้คืนแล้วชนจึงเลือก Key ใหม่ (Z2)
    expect((await team.lead.get(`${team.ws}/projects/key-available?key=DEL`)).body.available).toBe(true);
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'project.deleted'`);
    expect(audit.rows[0].summary).toBe('DEL · โปรเจกต์ DEL');
  });

  it('Workspace Admin ลบโปรเจกต์ที่เข้าร่วมแล้วได้ แม้ไม่ใช่ Project Owner', async () => {
    await mkProject(team.dev, 'DEL2');
    await wsAdmin.post(p('DEL2', '/join-as-admin'));
    expect((await wsAdmin.get(p('DEL2', '/delete-impact'))).body.canDelete).toBe(true);
    expect((await wsAdmin.delete(p('DEL2'), { confirmKey: 'DEL2' })).status).toBe(200);
  });
});

describe('สร้างโปรเจกต์จาก Template และข้อมูลจาก Wizard', () => {
  it('ใช้ Workflow, ประเภทงาน, Field, Label, Module และค่าตั้งของ Template · ค่าที่ส่งมาชนะ Template', async () => {
    const ws = await t.owner.query(`SELECT id FROM workspaces WHERE slug = $1`, [team.slug]);
    const config = {
      workflow: ['Backlog', { name: 'Doing', wipLimit: 4 }, { name: 'QA', category: 'in_progress' }, 'Shipped'],
      issueTypes: [{ name: 'Spike', enabled: false }, { name: 'Task', requiredFields: ['title'] }, { name: 'Incident', color: '#000000', bug: true }],
      customFields: [{ name: 'Release version', fieldType: 'select', options: ['1.0', '1.1'] }],
      labels: [{ name: 'frontend', color: '#1D4ED8' }, { name: 'backend' }],
      modules: ['หน้าร้าน', 'หลังบ้าน'],
      sprintLengthWeeks: 1,
      progressMethod: 'count',
      sizeMdMap: { XS: 0.5, S: 2, M: 4, L: 6, XL: 10 },
      timeLogEnabled: true,
    };
    const tpl = await t.owner.query(`INSERT INTO project_templates (workspace_id, name, config) VALUES ($1, 'Agency', $2) RETURNING id`, [ws.rows[0].id, JSON.stringify(config)]);
    const templateId = tpl.rows[0].id;

    const r = await team.lead.post(`${team.ws}/projects`, { name: 'เว็บร้านค้า', key: 'TPL', startDate: '2026-11-02', goliveDate: '2026-12-25', templateId, sprintLengthWeeks: 2 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ templateId, sprintLengthWeeks: 2, progressMethod: 'count', timeLogEnabled: true, sizeMdMap: { XS: 0.5 } });
    expect(r.body.created).toMatchObject({ modules: 2, statuses: 4, customFields: 1, labels: 2 });

    const d = (await team.lead.get(p('TPL'))).body;
    expect(d.modules.map((m: { name: string }) => m.name)).toEqual(['หน้าร้าน', 'หลังบ้าน']);
    const std = d.statuses.filter((s: { boardColumnId: string | null; workflowId: string }) => s.workflowId === d.statuses[0].workflowId);
    expect(std.map((s: { name: string; category: string; wipLimit: number | null }) => [s.name, s.category, s.wipLimit])).toEqual([
      ['Backlog', 'todo', null],
      ['Doing', 'in_progress', 4],
      ['QA', 'in_progress', null],
      ['Shipped', 'done', null],
    ]);
    const col = (name: string) => d.statuses.find((s: { name: string; boardColumnId: string | null }) => s.name === name && s.boardColumnId)?.boardColumnId;
    const byName = new Map(std.map((s: { name: string; id: string }) => [s.name, s.id]));
    expect([col('Open'), col('Fixed'), col('Closed')]).toEqual([byName.get('Backlog'), byName.get('QA'), byName.get('Shipped')]);
    expect(d.issueTypes.map((x: { name: string; enabled: boolean }) => [x.name, x.enabled])).toEqual([
      ['Story', true],
      ['Task', true],
      ['Bug', true],
      ['Spike', false],
      ['Incident', true],
    ]);
    expect(d.issueTypes.find((x: { name: string }) => x.name === 'Incident').workflowId).toBe(d.issueTypes.find((x: { name: string }) => x.name === 'Bug').workflowId);
    expect(d.sprints[0]).toMatchObject({ startDate: '2026-11-02', endDate: '2026-11-13' });
    const usage = await t.owner.query(`SELECT usage_count FROM project_templates WHERE id = $1`, [templateId]);
    expect(usage.rows[0].usage_count).toBe(1);
    const fields = await t.owner.query(`SELECT name, field_type FROM custom_fields WHERE project_id = $1`, [r.body.id]);
    expect(fields.rows).toEqual([{ name: 'Release version', field_type: 'select' }]);

    // Module จาก Wizard ชนะ Template
    const own = await team.lead.post(`${team.ws}/projects`, { name: 'อีกโปรเจกต์', key: 'TPL2', startDate: '2026-11-02', goliveDate: '2026-12-25', templateId, modules: ['API'] });
    expect(own.body.created.modules).toBe(1);

    const bad = await t.owner.query(`INSERT INTO project_templates (workspace_id, name, config) VALUES ($1, 'Broken', '{"workflow": "x"}') RETURNING id`, [ws.rows[0].id]);
    const broken = await team.lead.post(`${team.ws}/projects`, { name: 'x', key: 'BRK', startDate: '2026-11-02', goliveDate: '2026-12-25', templateId: bad.rows[0].id });
    expect(broken.status).toBe(422);
    expect(broken.body.error.code).toBe('template_invalid');
    const missing = await team.lead.post(`${team.ws}/projects`, { name: 'x', key: 'BRK', startDate: '2026-11-02', goliveDate: '2026-12-25', templateId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe(404);
    expect((await team.lead.get(`${team.ws}/projects/key-available?key=BRK`)).body.available).toBe(true);
  });

  it('รับสมาชิก, วันหยุดเพิ่ม, Scope, ปฏิทินวันหยุด และ Workflow จาก Wizard ในธุรกรรมเดียว', async () => {
    const cal = await t.owner.query(`SELECT id FROM holiday_calendars LIMIT 1`);
    const r = await team.lead.post(`${team.ws}/projects`, {
      name: 'ระบบจองคิว',
      key: 'WIZ',
      startDate: '2026-11-02',
      goliveDate: '2027-01-29',
      holidayCalendarId: cal.rows[0].id,
      extraHolidays: [{ date: '2026-12-31', name: 'วันหยุดบริษัท' }],
      scope: { in: ['จองคิวออนไลน์'], out: ['ชำระเงิน'], deliverables: ['เว็บแอป'] },
      members: [{ userId: team.devId, role: 'member', position: 'Frontend', capacityHoursWeek: 32 }, { userId: team.leadId, role: 'viewer' }],
      workflow: ['รอทำ', 'กำลังทำ', 'เสร็จ'],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ holidayCalendarId: cal.rows[0].id, sprintLengthWeeks: 2, estimateUnit: 'man_day', progressMethod: 'weighted' });
    expect(r.body.created).toMatchObject({ members: 2, holidays: 1, scopeItems: 3, statuses: 3 });
    const members = (await team.dev.get(p('WIZ', '/members'))).body.items;
    expect(members.map((m: { userId: string; role: string }) => [m.userId, m.role])).toEqual([
      [team.leadId, 'admin'],
      [team.devId, 'member'],
    ]);
    const scope = await t.owner.query(`SELECT kind, text FROM project_scope_items WHERE project_id = $1 ORDER BY kind`, [r.body.id]);
    expect(scope.rows).toEqual([
      { kind: 'in_scope', text: 'จองคิวออนไลน์' },
      { kind: 'out_scope', text: 'ชำระเงิน' },
      { kind: 'deliverable', text: 'เว็บแอป' },
    ]);

    const bad = [
      { members: [{ userId: outsiderId }], code: 'not_workspace_member', status: 400 },
      { members: [{ userId: guestId, role: 'admin' }], code: 'guest_role_limit', status: 409 },
      { workflow: [{ name: 'A', category: 'in_progress' }, { name: 'B', category: 'done' }], code: 'workflow_invalid', status: 400 },
      { holidayCalendarId: '00000000-0000-4000-8000-000000000000', code: 'holiday_calendar_not_found', status: 400 },
    ];
    for (const { code, status, ...extra } of bad) {
      const x = await team.lead.post(`${team.ws}/projects`, { name: 'x', key: 'BAD', startDate: '2026-11-02', goliveDate: '2026-12-25', ...extra });
      expect([x.status, x.body.error.code]).toEqual([status, code]);
    }
    expect((await team.lead.get(`${team.ws}/projects/key-available?key=BAD`)).body.available).toBe(true);
  });
});

describe('โปรเจกต์ตัวอย่าง (POST w/projects/sample)', () => {
  it('สร้างโปรเจกต์ข้อมูลสมมติพร้อมงาน · Key ถัดไปเมื่อซ้ำ · Guest สร้างไม่ได้', async () => {
    const r = await qa.post(`${team.ws}/projects/sample`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ key: 'DEMO', sample: true, ownerUserId: qaId, created: { modules: 3, issues: 9 } });
    const issues = (await qa.get(p('DEMO', '/issues'))).body.items;
    expect(issues.length).toBeGreaterThan(0);
    const bug = await qa.get(`${team.ws}/issues/DEMO-9`);
    expect(bug.body).toMatchObject({ type: 'Bug', severity: 'major' });
    expect(bug.body.assigneeIds).toEqual([qaId]);
    expect((await qa.get(`${team.ws}/issues/DEMO-2`)).body.parentKey).toBe('DEMO-1');

    expect((await qa.post(`${team.ws}/projects/sample`)).body.key).toBe('DEMO2');
    expect((await qa.post(`${team.ws}/projects/sample`, { key: 'TRY' })).body.key).toBe('TRY');
    expect((await guest.post(`${team.ws}/projects/sample`)).status).toBe(403);
  });
});
