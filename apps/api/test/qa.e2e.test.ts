// A12 · ผลทดสอบ, สร้าง Bug จากผลทดสอบ และบันทึกเวลา · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { today } from '../src/common/dates.js';
import { EventBus, type DomainEvent } from '../src/core/events.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let viewer: Client;
let guest: Client;
let wsId: string;
let projectId: string;
let moduleId: string;
let base: string;
const events: DomainEvent[] = [];

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  base = `${team.ws}/issues`;
  viewer = await client(t.app);
  await addMember(t.owner, team.slug, await signup(viewer, 'viewer@qa.example.com', 'Viewer'), 'member', { key: team.key, role: 'viewer' });
  guest = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guest, 'guest@qa.example.com', 'Guest'), 'guest', { key: team.key, role: 'viewer' });
  t.app.get(EventBus).on('*', (e) => { events.push(e); });
});
afterAll(() => t.close());

async function issue(title: string, extra: Record<string, unknown> = {}, assignee?: string) {
  const r = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title, moduleId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (assignee) await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, r.body.id, assignee]);
  return r.body as { id: string; key: string };
}

describe('test-runs', () => {
  it('บันทึกผลทดสอบ: เลขรอบเพิ่มเอง · ผลไม่ผ่านส่ง Event test_run.failed · ดูรายการใหม่ก่อน', async () => {
    const task = await issue('ฟอร์มวงเงิน', {}, team.devId);
    events.length = 0;
    const r1 = await team.dev.post(`${base}/${task.key}/test-runs`, { result: 'failed', passedCount: 3, totalCount: 5, environment: 'sit', commitSha: 'e8b1c47', note: 'กดบันทึกแล้วค้าง' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body).toMatchObject({ runNo: 1, result: 'failed', passedCount: 3, totalCount: 5, environment: 'sit', commitSha: 'e8b1c47', note: 'กดบันทึกแล้วค้าง', tester: { displayName: 'Kaijeaw' }, files: [], bugs: [] });
    expect(events.filter((e) => e.type === 'test_run.failed')).toMatchObject([{ projectId, issueId: task.id, actorId: team.devId, data: { issueKey: task.key, runNo: 1, passedCount: 3, totalCount: 5, environment: 'sit', commitSha: 'e8b1c47' } }]);

    const r2 = await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'passed', passedCount: 5, totalCount: 5 });
    expect(r2.body.runNo).toBe(2);
    expect(events.filter((e) => e.type === 'test_run.failed')).toHaveLength(1);
    const blocked = await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'blocked' });
    expect(blocked.body).toMatchObject({ runNo: 3, passedCount: null, totalCount: null });
    expect(events.filter((e) => e.type === 'test_run.failed')).toHaveLength(1);

    const list = await team.dev.get(`${base}/${task.key}/test-runs`);
    expect(list.body.items.map((x: { runNo: number }) => x.runNo)).toEqual([3, 2, 1]);
    expect(list.body.latest).toMatchObject({ runNo: 3, result: 'blocked' });
    expect((await t.owner.query(`SELECT 1 FROM activities WHERE issue_id = $1 AND verb = 'test_run_recorded'`, [task.id])).rowCount).toBe(3);
  });

  it('ผลตรวจของ Reviewer: ระบุผู้ตรวจได้ (ค่าเริ่มต้น = คนบันทึก) · ผู้ตรวจต้องเป็นสมาชิกที่ไม่ใช่ Guest', async () => {
    const task = await issue('ผลตรวจ Reviewer');
    const r = await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'failed', testerId: team.devId, environment: 'uat', note: '1. เปิดหน้า\n2. กดบันทึก → ค้าง' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ result: 'failed', environment: 'uat', tester: { displayName: 'Kaijeaw' }, passedCount: null, commitSha: null });
    expect((await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'passed' })).body.tester).toMatchObject({ displayName: 'Mick' });
    const guestId = (await t.owner.query(`SELECT u.id FROM users u WHERE u.email = 'guest@qa.example.com'`)).rows[0].id;
    const bad = await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'passed', testerId: guestId });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_people');
  });

  it('บันทึกพร้อมกันได้เลขรอบไม่ซ้ำ', async () => {
    const task = await issue('บันทึกพร้อมกัน');
    const rs = await Promise.all([1, 2, 3, 4].map(() => team.lead.post(`${base}/${task.key}/test-runs`, { result: 'passed' })));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(rs.map((r) => r.body.runNo).sort()).toEqual([1, 2, 3, 4]);
  });

  it('ตรวจข้อมูล · สิทธิ์ issue.record_test · Guest · โปรเจกต์ Archive', async () => {
    const task = await issue('ตรวจข้อมูลผลทดสอบ');
    const post = (body: object, c: Client = team.lead) => c.post(`${base}/${task.key}/test-runs`, body);
    for (const body of [{}, { result: 'ok' }, { result: 'passed', passedCount: 6, totalCount: 5 }, { result: 'passed', passedCount: 1 }, { result: 'failed', commitSha: 'not-hex!' }, { result: 'failed', environment: 'staging' }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    const denied = await post({ result: 'passed' }, viewer);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('issue.record_test');
    expect((await viewer.get(`${base}/${task.key}/test-runs`)).status).toBe(200);
    expect([403, 404]).toContain((await post({ result: 'passed' }, guest)).status);
    expect((await team.lead.get(`${base}/ZZ-1/test-runs`)).status).toBe(404);
    await t.owner.query(`UPDATE projects SET archived_at = now(), status = 'archived' WHERE id = $1`, [projectId]);
    expect((await post({ result: 'passed' })).status).toBe(403);
    await t.owner.query(`UPDATE projects SET archived_at = NULL, status = 'active' WHERE id = $1`, [projectId]);
  });

  it('แนบไฟล์หลักฐานของโปรเจกต์เดียวกันกับรอบทดสอบ · ไฟล์ที่ไม่มี / ของโปรเจกต์อื่น 404', async () => {
    const task = await issue('มีหลักฐาน');
    const file = await t.owner.query(`INSERT INTO files (workspace_id, project_id, name, uploaded_by) VALUES ($1,$2,'TestReport_run1.pdf',$3) RETURNING id`, [wsId, projectId, team.leadId]);
    const run = await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'failed', fileIds: [file.rows[0].id] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.files).toEqual([{ id: file.rows[0].id, name: 'TestReport_run1.pdf' }]);
    expect((await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'failed', fileIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(404);
    await team.lead.post(`${team.ws}/projects`, { key: 'QO', name: 'Other', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['M'], sprintLengthWeeks: null });
    const other = await t.owner.query(`INSERT INTO files (workspace_id, project_id, name, uploaded_by) SELECT $1, id, 'ของโปรเจกต์อื่น.pdf', $2 FROM projects WHERE key = 'QO' RETURNING id`, [wsId, team.leadId]);
    expect((await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'failed', fileIds: [other.rows[0].id] })).status).toBe(404);
    // รอบที่ล้มไม่ทิ้งเลขรอบไว้
    expect((await team.lead.get(`${base}/${task.key}/test-runs`)).body.items.map((x: { runNo: number }) => x.runNo)).toEqual([1]);
  });
});

describe('POST test-runs/{id}/create-bug', () => {
  it('Task ที่ทดสอบ → Bug เป็น Sub-task ของ Task นั้น · ผูก found_in_test_run · รับผู้รับผิดชอบและหลักฐานจากผลทดสอบ', async () => {
    const task = await issue('Workflow ส่งกลับแก้ไข', {}, team.devId);
    const file = await t.owner.query(`INSERT INTO files (workspace_id, project_id, name, uploaded_by) VALUES ($1,$2,'evidence.png',$3) RETURNING id`, [wsId, projectId, team.leadId]);
    const run = (await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'failed', passedCount: 2, totalCount: 4, environment: 'sit', commitSha: 'a1b2c3d', note: '1. กดส่งกลับ\n2. สถานะไม่กลับเป็น Draft', fileIds: [file.rows[0].id] })).body;
    events.length = 0;
    const r = await team.lead.post(`${base}/${task.key}/test-runs/${run.id}/create-bug`, { severity: 'critical' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ type: 'Bug', severity: 'critical', priority: 'urgent', parentKey: task.key, environment: 'sit', foundInTestRun: { runNo: 1, issueKey: task.key }, attachedFiles: 1 });
    expect(r.body.title).toBe(`[${task.key} รอบ 1] Workflow ส่งกลับแก้ไข`);
    expect(r.body.description).toContain('รอบที่ 1 (ไม่ผ่าน)');
    expect(r.body.description).toContain('ผ่าน 2 จาก 4 ข้อ');
    expect(r.body.description).toContain('Environment: SIT');
    expect(r.body.description).toContain('Commit: a1b2c3d');
    expect(r.body.description).toContain('2. สถานะไม่กลับเป็น Draft');
    expect(r.body.details).toMatchObject({ steps: expect.stringContaining('กดส่งกลับ'), foundInRun: 1, testedIssue: task.key, commitSha: 'a1b2c3d' });

    const bug = (await t.owner.query('SELECT found_in_test_run_id, parent_id FROM issues WHERE id = $1', [r.body.id])).rows[0];
    expect(bug).toEqual({ found_in_test_run_id: run.id, parent_id: task.id });
    expect((await t.owner.query('SELECT user_id FROM issue_assignees WHERE issue_id = $1', [r.body.id])).rows.map((x) => x.user_id)).toEqual([team.devId]);
    expect((await t.owner.query(`SELECT file_id FROM file_attachments WHERE target_type = 'issue' AND target_id = $1`, [r.body.id])).rows).toEqual([{ file_id: file.rows[0].id }]);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['issue.created', 'bug.created']));

    // รายการผลทดสอบเห็น Bug ที่สร้างจากรอบนั้น และไฟล์หลักฐานกลายเป็น "หลักฐาน" (ลบต้อง confirm)
    const list = await team.lead.get(`${base}/${task.key}/test-runs`);
    expect(list.body.items[0].bugs).toMatchObject([{ key: r.body.key }]);
    const del = await team.lead.delete(`${team.ws}/projects/${team.key}/files/${file.rows[0].id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('file_is_evidence');
  });

  it('Sub-task ที่ทดสอบ → Bug อยู่ใต้งานแม่เดียวกัน (ไม่ซ้อน 3 ชั้น) · ชื่อและผู้รับผิดชอบกำหนดเองได้', async () => {
    const parent = await issue('Task แม่');
    const sub = await issue('Sub-task ที่ทดสอบ', { parentKey: parent.key });
    const run = (await team.lead.post(`${base}/${sub.key}/test-runs`, { result: 'blocked', note: 'ติด environment' })).body;
    const r = await team.lead.post(`${base}/${sub.key}/test-runs/${run.id}:create-bug`, { title: 'Bug ตั้งชื่อเอง', severity: 'minor', assigneeIds: [team.leadId], priority: 'low', steps: 'ขั้นตอนที่ผมเขียนเอง' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ title: 'Bug ตั้งชื่อเอง', parentKey: parent.key, severity: 'minor', priority: 'low' });
    expect(r.body.description).toContain('(ติดขัด)');
    expect(r.body.environment).toBe('sit'); // รอบทดสอบไม่ได้ระบุ → ค่าเริ่มต้น SIT เพราะ Bug บังคับ Environment
    expect(r.body.description).toContain('ขั้นตอนที่ผมเขียนเอง');
    expect((await t.owner.query('SELECT user_id FROM issue_assignees WHERE issue_id = $1', [r.body.id])).rows.map((x) => x.user_id)).toEqual([team.leadId]);
    // สร้างได้หลาย Bug จากรอบเดียวกัน
    expect((await team.lead.post(`${base}/${sub.key}/test-runs/${run.id}/create-bug`, {})).status).toBe(201);
    expect((await team.lead.get(`${base}/${sub.key}/test-runs`)).body.items[0].bugs).toHaveLength(2);
  });

  it('รอบที่ผ่านแล้ว 409 · รอบของงานอื่น / ไม่มี 404 · ต้องมี issue.create · Guest ไม่ได้', async () => {
    const task = await issue('งานสำหรับเคสผิด');
    const other = await issue('งานอื่น');
    const pass = (await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'passed' })).body;
    const fail = (await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'failed' })).body;
    const done = await team.lead.post(`${base}/${task.key}/test-runs/${pass.id}/create-bug`, {});
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('run_passed');
    expect((await team.lead.post(`${base}/${other.key}/test-runs/${fail.id}/create-bug`, {})).status).toBe(404);
    expect((await team.lead.post(`${base}/${task.key}/test-runs/00000000-0000-4000-8000-000000000000/create-bug`, {})).status).toBe(404);
    expect((await team.lead.post(`${base}/${task.key}/test-runs/abc/create-bug`, {})).status).toBe(404);
    const noPerm = await viewer.post(`${base}/${task.key}/test-runs/${fail.id}/create-bug`, {});
    expect(noPerm.status).toBe(403);
    expect([403, 404]).toContain((await guest.post(`${base}/${task.key}/test-runs/${fail.id}/create-bug`, {})).status);
    expect((await team.lead.post(`${base}/${task.key}/test-runs/${fail.id}/create-bug`, { severity: 'fatal' })).status).toBe(400);
  });

  it('Guest Viewer เห็นผลทดสอบของงานที่แชร์ได้ แต่ไม่เห็นชื่อ/UUID ผู้ทดสอบ, Bug, ไฟล์ และบันทึก · Guest Member เห็นครบ (BUG-04)', async () => {
    const task = await issue('งานที่แชร์ให้ลูกค้า');
    await t.owner.query('UPDATE issues SET shared_with_guests = true WHERE id = $1', [task.id]);
    const fail = (await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'failed', note: 'Mick เจอปัญหาตอนกดจ่ายเงิน', commitSha: 'abc1234' })).body;
    const bug = await team.lead.post(`${base}/${task.key}/test-runs/${fail.id}/create-bug`, { title: 'Bug ลับของทีม' });
    expect(bug.status, JSON.stringify(bug.body)).toBe(201);

    const seen = await guest.get(`${base}/${task.key}/test-runs`);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    const text = JSON.stringify(seen.body);
    expect(text).not.toContain(team.leadId);
    expect(text).not.toContain('Bug ลับของทีม');
    expect(text).not.toContain(bug.body.key);
    expect(text).not.toContain('Mick');
    expect(seen.body.items[0]).toMatchObject({ result: 'failed', tester: { displayName: 'ทีมพัฒนา' }, bugs: [], files: [], note: null });
    expect(seen.body.latest).toEqual(seen.body.items[0]);

    // Guest Member (Workspace guest + Project member) ทำงานแบบ Member
    const gm = await client(t.app);
    await addMember(t.owner, team.slug, await signup(gm, 'guest-member@qa.example.com', 'Guest Member'), 'guest', { key: team.key, role: 'member' });
    const full = await gm.get(`${base}/${task.key}/test-runs`);
    expect(full.status).toBe(200);
    expect(full.body.items[0].bugs).toEqual([{ key: bug.body.key, title: 'Bug ลับของทีม' }]);
    expect(full.body.items[0].tester.id).toBe(team.leadId);
  });
});

describe('time-logs', () => {
  it('โปรเจกต์ที่ปิด Time log (ค่าเริ่มต้น) → 404 time_log_disabled ทุก method', async () => {
    const task = await issue('เวลา: ปิดอยู่');
    for (const call of [() => team.lead.get(`${base}/${task.key}/time-logs`), () => team.lead.post(`${base}/${task.key}/time-logs`, { md: 1 }), () => team.lead.delete(`${base}/${task.key}/time-logs/00000000-0000-4000-8000-000000000000`)]) {
      const r = await call();
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('time_log_disabled');
    }
  });

  it('เปิดใช้: บันทึก / รวมต่อคน / ลบเฉพาะของตัวเอง', async () => {
    await t.owner.query('UPDATE projects SET time_log_enabled = true WHERE id = $1', [projectId]);
    const task = await issue('เวลา: เปิดอยู่');
    await t.owner.query('UPDATE issues SET estimate_md = 5 WHERE id = $1', [task.id]);
    const a = await team.dev.post(`${base}/${task.key}/time-logs`, { md: 1.5, note: 'ทำฟอร์ม' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ date: today(), md: 1.5, note: 'ทำฟอร์ม', mine: true, user: { displayName: 'Kaijeaw' } });
    await team.dev.post(`${base}/${task.key}/time-logs`, { md: 0.5, date: '2026-11-02' });
    const b = await team.lead.post(`${base}/${task.key}/time-logs`, { md: 1 });
    expect(b.status).toBe(201);

    const list = await team.lead.get(`${base}/${task.key}/time-logs`);
    expect(list.body).toMatchObject({ totalMd: 3, estimateMd: 5, byUser: [{ user: { displayName: 'Kaijeaw' }, md: 2 }, { user: { displayName: 'Mick' }, md: 1 }] });
    expect(list.body.items.map((i: { md: number; mine: boolean }) => [i.md, i.mine])).toEqual([[1, true], [1.5, false], [0.5, false]]);
    expect(list.body.items).toHaveLength(3);

    const other = await team.lead.delete(`${base}/${task.key}/time-logs/${a.body.id}`);
    expect(other.status).toBe(403);
    expect(other.body.error.details.permission).toBe('issue.time_log');
    expect((await team.dev.delete(`${base}/${task.key}/time-logs/${a.body.id}`)).body).toEqual({ deleted: true });
    expect((await team.dev.delete(`${base}/${task.key}/time-logs/${a.body.id}`)).status).toBe(404);
    expect((await team.lead.get(`${base}/${task.key}/time-logs`)).body.totalMd).toBe(1.5);
  });

  it('ตรวจข้อมูล: md > 0 และ ≤ 3, วันที่ล่วงหน้าไม่ได้, รวมต่อวันไม่เกิน 3 MD · Viewer ดูได้แต่บันทึกไม่ได้ · Guest ไม่ได้', async () => {
    const task = await issue('เวลา: ตรวจข้อมูล');
    const post = (body: object, c: Client = team.lead) => c.post(`${base}/${task.key}/time-logs`, body);
    for (const body of [{}, { md: 0 }, { md: -1 }, { md: 3.5 }, { md: 1, date: '2026-13-01' }, { md: 1, note: 'x'.repeat(1001) }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    const future = await post({ md: 1, date: '2099-01-01' });
    expect(future.status).toBe(400);
    expect(future.body.error.details.fields[0].path).toBe('date');
    expect((await post({ md: 2, date: '2026-11-03' })).status).toBe(201);
    const over = await post({ md: 1.5, date: '2026-11-03' });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'time_log_limit', details: { loggedMd: 2 } });
    expect((await post({ md: 1, date: '2026-11-03' })).status).toBe(201);

    const denied = await post({ md: 1 }, viewer);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('issue.time_log');
    expect((await viewer.get(`${base}/${task.key}/time-logs`)).status).toBe(200);
    expect([403, 404]).toContain((await post({ md: 1 }, guest)).status);
    expect([403, 404]).toContain((await guest.get(`${base}/${task.key}/time-logs`)).status);
  });
});

describe('ผล Unit test ของ Dev (ผู้ใช้เพิ่ม 2026-11-08)', () => {
  it('เลขรอบแยกจาก QA · เก็บ Coverage · latest เป็นผล QA · Unit test ไม่ผ่านไม่ส่ง test_run.failed', async () => {
    const task = await issue('งาน Unit test สมมติ');
    const before = events.length;
    const unit1 = await team.dev.post(`${base}/${task.key}/test-runs`, { kind: 'unit', result: 'failed', passedCount: 45, totalCount: 48, coveragePct: 79.5, commitSha: '9f8e7d6' });
    expect(unit1.status, JSON.stringify(unit1.body)).toBe(201);
    expect(unit1.body).toMatchObject({ kind: 'unit', runNo: 1, coveragePct: 79.5 });
    expect(events.slice(before).some((e) => e.type === 'test_run.failed')).toBe(false);
    const qa1 = await team.lead.post(`${base}/${task.key}/test-runs`, { result: 'passed' });
    expect(qa1.body).toMatchObject({ kind: 'qa', runNo: 1, coveragePct: null });
    const unit2 = await team.dev.post(`${base}/${task.key}/test-runs`, { kind: 'unit', result: 'passed', passedCount: 48, totalCount: 48, coveragePct: 82 });
    expect(unit2.body.runNo).toBe(2);
    const list = (await team.dev.get(`${base}/${task.key}/test-runs`)).body;
    expect(list.items).toHaveLength(3);
    expect(list.latest).toMatchObject({ kind: 'qa', runNo: 1 });
    expect((await team.dev.post(`${base}/${task.key}/test-runs`, { kind: 'unit', result: 'passed', coveragePct: 101 })).status).toBe(400);
  });
});

