// ทดสอบ API กับ PostgreSQL จริง: pnpm db:up && pnpm db:migrate && pnpm db:dev-roles ก่อน
import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember as addMemberTo, type Client, client as clientOf, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let app: INestApplication;
let owner: pg.Client;
const client = () => clientOf(app);
const addMember = (wsSlug: string, userId: string, role: 'owner' | 'admin' | 'member' | 'guest', project?: { key: string; role: 'admin' | 'member' | 'viewer' }) =>
  addMemberTo(owner, wsSlug, userId, role, project);

let mick: Client, kaijeaw: Client, outsider: Client, arm: Client, client_: Client;
let mickId: string, kaijeawId: string, armId: string, clientId: string;
let creditLine: string;

beforeAll(async () => {
  t = await startApp();
  ({ app, owner } = t);
  [mick, kaijeaw, outsider, arm, client_] = await Promise.all([client(), client(), client(), client(), client()]);
});

afterAll(async () => {
  await t.close();
});

describe('บัญชีและ Session', () => {
  it('สมัครแล้วได้ Session ทันที', async () => {
    mickId = await signup(mick, 'mick@example.com', 'Mick');
    const me = await mick.get('/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: mickId, displayName: 'Mick', emailVerified: false });
  });

  it('รหัสผ่านไม่ผ่านเงื่อนไข → 400 พร้อมช่องที่ผิด', async () => {
    const c = await client();
    const r = await c.post('/auth/signup', { email: 'x@example.com', password: 'short', displayName: 'X', acceptTerms: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_input');
    expect(r.body.error.details.fields[0].path).toBe('password');
    expect(r.body.error.requestId).toMatch(/^req_/);
  });

  it('อีเมลซ้ำ → 409', async () => {
    const c = await client();
    const r = await c.post('/auth/signup', { email: 'MICK@example.com', password: 'Friday2026', displayName: 'X', acceptTerms: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('email_taken');
  });

  it('รหัสผิดบอกจำนวนครั้งที่เหลือก่อนล็อก', async () => {
    const c = await client();
    const r = await c.post('/auth/login', { email: 'mick@example.com', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.body.error.details.attemptsLeft).toBe(4);
    const ok = await c.post('/auth/login', { email: 'mick@example.com', password: 'Friday2026' });
    expect(ok.status).toBe(200);
  });

  it('ไม่มี CSRF token → 403 · ไม่ล็อกอิน → 401', async () => {
    const r = await mick.agent.post('/api/v1/workspaces').send({ name: 'x', slug: 'xx' });
    expect(r.body.error.code).toBe('csrf_failed');
    const anon = await request(app.getHttpServer()).get('/api/v1/me');
    expect(anon.status).toBe(401);
  });
});

describe('Workspace และโปรเจกต์', () => {
  it('สร้าง Workspace แล้วเป็น Owner · URL ซ้ำ → 409', async () => {
    const r = await mick.post('/workspaces', { name: 'Friday', slug: 'friday-dev' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'friday-dev', role: 'owner', status: 'trial' });
    const dup = await mick.post('/workspaces', { name: 'อีกอัน', slug: 'Friday-Dev' });
    expect(dup.body.error.code).toBe('slug_taken');
    const list = await mick.get('/me/workspaces');
    expect(list.body.items.map((w: { slug: string }) => w.slug)).toEqual(['friday-dev']);

    // ปฏิทินวันหยุด ธปท. (ยังไม่มี endpoint นำเข้า)
    const { rows } = await owner.query(`INSERT INTO holiday_calendars (name, source) VALUES ('ธปท. 2569', 'bot') RETURNING id`);
    await owner.query(`INSERT INTO holidays (calendar_id, date, name) VALUES ($1, '2026-12-07', 'ชดเชยวันพ่อ'), ($1, '2026-12-10', 'วันรัฐธรรมนูญ')`, [rows[0].id]);
    await owner.query(`UPDATE workspace_settings SET holiday_calendar_id = $1`, [rows[0].id]);
  });

  it('สร้างโปรเจกต์พร้อม Workflow, ประเภทงาน, Module และ Sprint', async () => {
    const r = await mick.post('/w/friday-dev/projects', {
      name: 'Development Plan 2026-11',
      key: 'dp',
      startDate: '2026-11-05',
      goliveDate: '2027-04-21',
      modules: ['Credit Line', 'Drawdown'],
      milestones: [{ name: 'Credit Line Go-live', date: '2027-01-26' }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ key: 'DP', myRole: 'admin', visibility: 'private', created: { modules: 2, statuses: 4, milestones: 1 } });
    expect(r.body.created.sprints).toBeGreaterThan(10);

    const p = await mick.get('/w/friday-dev/projects/DP');
    expect(p.body.issueTypes.map((t: { name: string }) => t.name)).toEqual(['Story', 'Task', 'Bug', 'Spike']);
    expect(p.body.sprints[0]).toMatchObject({ name: 'Sprint 1', startDate: '2026-11-09', endDate: '2026-11-20' });
    // Bug: Fixed อยู่คอลัมน์ Review ของบอร์ด
    const review = p.body.statuses.find((x: { name: string; boardColumnId: string | null }) => x.name === 'Review' && !x.boardColumnId);
    const fixed = p.body.statuses.find((x: { name: string }) => x.name === 'Fixed');
    expect(fixed.boardColumnId).toBe(review.id);
    creditLine = p.body.modules[0].id;

    // กฎ Workflow ค่าเริ่มต้นตาม catalog (BUG-10) · ไฟล์นี้ทดสอบเรื่องอื่นต่อ จึงล้างกฎออกเหมือน seedTeam
    const rules = (await owner.query(
      `SELECT w.name AS workflow, r.rule_type, r.enabled FROM workflow_rules r JOIN workflows w ON w.id = r.workflow_id WHERE r.project_id = $1 ORDER BY w.name, r.rule_type`,
      [r.body.id],
    )).rows;
    expect(rules).toEqual([
      { workflow: 'Bug', rule_type: 'critical_auto_start', enabled: false },
      { workflow: 'Bug', rule_type: 'fix_reference_required', enabled: true },
      { workflow: 'Bug', rule_type: 'reopen_on_failed_test', enabled: true },
      { workflow: 'Bug', rule_type: 'tester_or_reporter_only_verified', enabled: true },
      { workflow: 'มาตรฐาน', rule_type: 'reviewer_only_done', enabled: false },
      { workflow: 'มาตรฐาน', rule_type: 'reviewer_required', enabled: true },
      { workflow: 'มาตรฐาน', rule_type: 'subtasks_done', enabled: true },
      { workflow: 'มาตรฐาน', rule_type: 'wip_warning', enabled: true },
    ]);
    await owner.query('DELETE FROM workflow_rules WHERE project_id = $1', [r.body.id]);

    const dup = await mick.get('/w/friday-dev/projects/key-available?key=DP');
    expect(dup.body.available).toBe(false);
  });
});

describe('งาน', () => {
  it('Plan Start ตรงวันหยุดเลื่อนเป็นวันทำงานถัดไป และ Plan End นับเฉพาะวันทำการ', async () => {
    // เสาร์ 5 ธ.ค. → จันทร์ 7 ธ.ค. เป็นวันหยุดชดเชย → อังคาร 8 ธ.ค.
    // M = 5 MD, Dev 1 คน: 8, 9, (10 หยุด), 11, 14, 15 → จบ 15 ธ.ค.
    const r = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'ฟอร์มหลักประกัน 5 ประเภท', moduleId: creditLine, size: 'M', planStart: '2026-12-05', assigneeIds: [mickId] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ key: 'DP-1', type: 'Task', estimateMd: 5, planStart: '2026-12-08', planEnd: '2026-12-15', status: { name: 'To do', category: 'todo' }, version: 1 });
    expect(r.body.warnings[0].code).toBe('plan_start_moved');
  });

  it('Dev หลายคนไม่ทำให้ Plan End สั้นลง (Man-Day ของทีมแบ่งเฉพาะตอนคิด Workload)', async () => {
    kaijeawId = await signup(kaijeaw, 'kaijeaw@example.com', 'Kaijeaw');
    await addMember('friday-dev', kaijeawId, 'member', { key: 'DP', role: 'member' });
    const r = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'Collateral framework', moduleId: creditLine, estimateMd: 3, planStart: '2026-12-01', assigneeIds: [mickId, kaijeawId] });
    // 3 MD เริ่ม 1 ธ.ค. → 1, 2, 3 ธ.ค. ไม่ว่า Dev กี่คน (สูตร WORKDAY ในไฟล์แผน)
    expect(r.body).toMatchObject({ key: 'DP-2', planEnd: '2026-12-03' });
    expect(r.body.assigneeIds).toEqual([mickId, kaijeawId]);
  });

  it('Task ต้องมี Module · Bug ต้องมี Severity, Environment และขั้นตอนทำซ้ำ', async () => {
    const r = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'ไม่มี Module' });
    expect(r.body.error).toMatchObject({ code: 'missing_required_fields', details: { fields: ['module'] } });
    const bug = await mick.post('/w/friday-dev/projects/DP/issues', { type: 'Bug', title: 'สถานะค้าง', severity: 'major' });
    expect(bug.body.error.details.fields).toEqual(['environment', 'steps']);
  });

  it('Sub-task สืบทอด Module · ซ้อนเกิน 2 ชั้นไม่ได้', async () => {
    const sub = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'Bank Account', parentKey: 'DP-1', size: 'XS', planStart: '2026-12-08' });
    expect(sub.status).toBe(201);
    expect(sub.body).toMatchObject({ key: 'DP-3', parentKey: 'DP-1', moduleId: creditLine, planEnd: '2026-12-08' });
    const deep = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'ลึกเกิน', parentKey: 'DP-3' });
    expect(deep.body.error.code).toBe('issue_depth_exceeded');
    // วันที่เกินช่วงแม่: ต้องยืนยันก่อน แล้วระบบขยายช่วงของแม่ให้ (ผู้ใช้ตัดสิน 2026-11-08)
    const ask = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'เกินช่วงแม่', parentKey: 'DP-1', planStart: '2026-12-16', planEnd: '2026-12-17' });
    expect(ask.status).toBe(422);
    expect(ask.body.error).toMatchObject({ code: 'subtask_outside_parent', details: { confirmable: true, confirmField: 'extendParent', parentKey: 'DP-1', nextEnd: '2026-12-17' } });
    // ยืนยันแล้วขยายแม่ทดสอบใน issues.e2e · ที่นี่จำลองงานเก่าที่เกินช่วงอยู่แล้ว (เช่น นำเข้า) ให้ Timeline ด้านล่างใช้
    const out = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'เกินช่วงแม่', parentKey: 'DP-1' });
    expect(out.status).toBe(201);
    await owner.query(`UPDATE issues SET plan_start = '2026-12-16', plan_end = '2026-12-17' WHERE id = $1`, [out.body.id]);

    const detail = await mick.get('/w/friday-dev/issues/DP-1');
    expect(detail.body.planEnd).toBe('2026-12-15');
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.body.subtasks.map((x: { key: string }) => x.key)).toEqual(['DP-3', 'DP-4']);
  });

  it('ออกเลขงานไม่ทำให้ version ของโปรเจกต์เพิ่ม', async () => {
    const p = await mick.get('/w/friday-dev/projects/DP');
    expect(p.body.version).toBe(1);
  });

  it('รายการงานกรองตามคนและแบ่งหน้าได้', async () => {
    const mine = await kaijeaw.get('/w/friday-dev/projects/DP/issues?assignee=me');
    expect(mine.body.items.map((x: { key: string }) => x.key)).toEqual(['DP-2']);
    const page = await mick.get('/w/friday-dev/projects/DP/issues?limit=2');
    expect(page.body.items).toHaveLength(2);
    const next = await mick.get(`/w/friday-dev/projects/DP/issues?limit=2&cursor=${page.body.nextCursor}`);
    expect(next.body.items.map((x: { key: string }) => x.key)).toEqual(['DP-3', 'DP-4']);
    expect(next.body.nextCursor).toBeNull();
  });
});

describe('แก้ไขงาน และกติกาการเปลี่ยน Due', () => {
  it('เพิ่ม Dev แล้ว Plan End ไม่เปลี่ยน', async () => {
    const r = await mick.patch('/w/friday-dev/issues/DP-1', { assigneeIds: [mickId, kaijeawId] }, 1);
    expect(r.body).toMatchObject({ planEnd: '2026-12-15', version: 2 });
  });

  it('ไม่ส่ง If-Match → 428 · version ไม่ตรง → 409 พร้อมค่าล่าสุด', async () => {
    const none = await kaijeaw.patch('/w/friday-dev/issues/DP-2', { title: 'x' });
    expect(none.status).toBe(428);
    const ok = await kaijeaw.patch('/w/friday-dev/issues/DP-2', { title: 'Collateral framework (แก้)' }, 1);
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    const stale = await mick.patch('/w/friday-dev/issues/DP-2', { priority: 'high' }, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.latest).toMatchObject({ title: 'Collateral framework (แก้)', version: 2 });
  });

  it('Member เลื่อน Due ออกไปไม่ได้ (ค่าเริ่มต้น) แต่ดึงเข้ามาเร็วขึ้นได้', async () => {
    const later = await kaijeaw.patch('/w/friday-dev/issues/DP-2', { planEnd: '2026-12-09' }, 2);
    expect(later.status).toBe(403);
    expect(later.body.error).toMatchObject({ code: 'due_change_requires_approval', details: { currentDue: '2026-12-03', requestedDue: '2026-12-09' } });
    const earlier = await kaijeaw.patch('/w/friday-dev/issues/DP-2', { planEnd: '2026-12-02' }, 2);
    expect(earlier.status).toBe(200);
    expect(earlier.body.planEnd).toBe('2026-12-02');
  });

  it('แก้ Man-Day จน Plan End เลื่อนออก ก็ต้องขออนุมัติเหมือนกัน', async () => {
    // 5 MD เริ่ม 1 ธ.ค. → 1, 2, 3, 4, 8 (7 หยุด) → จบ 8 ธ.ค. เลยกว่า Due เดิม
    const r = await kaijeaw.patch('/w/friday-dev/issues/DP-2', { estimateMd: 5 }, 3);
    expect(r.body.error.code).toBe('due_change_requires_approval');
  });

  it('PM เปิดสิทธิ์ "เปลี่ยน Due โดยไม่ต้องขออนุมัติ" ให้ Member แล้วเลื่อนได้', async () => {
    const denied = await kaijeaw.put('/w/friday-dev/projects/DP/role-permissions', { role: 'member', permission: 'issue.change_due_directly', allowed: true });
    expect(denied.body.error).toMatchObject({ code: 'forbidden', details: { permission: 'project.settings' } });

    const set = await mick.put('/w/friday-dev/projects/DP/role-permissions', { role: 'member', permission: 'issue.change_due_directly', allowed: true });
    expect(set.status).toBe(200);
    const perms = await kaijeaw.get('/w/friday-dev/projects/DP/my-permissions');
    expect(perms.body.permissions).toContain('issue.change_due_directly');

    const later = await kaijeaw.patch('/w/friday-dev/issues/DP-2', { planEnd: '2026-12-09' }, 3);
    expect(later.status).toBe(200);
    const audit = await owner.query(`SELECT summary FROM audit_logs WHERE action = 'project.role_permission_changed'`);
    expect(audit.rows[0].summary).toContain('issue.change_due_directly');
  });

  it('เปลี่ยนสถานะแล้วตั้ง Actual Start / End อัตโนมัติ และบันทึก Activity', async () => {
    const p = await mick.get('/w/friday-dev/projects/DP');
    const st = (n: string) => p.body.statuses.find((x: { name: string; boardColumnId: string | null }) => x.name === n && !x.boardColumnId).id;
    const prog = await mick.patch('/w/friday-dev/issues/DP-1', { statusId: st('In progress') }, 2);
    expect(prog.body.actualStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(prog.body.actualEnd).toBeNull();
    const done = await mick.patch('/w/friday-dev/issues/DP-1', { statusId: st('Done') }, 3);
    expect(done.body.actualEnd).toBe(done.body.actualStart);

    const bugOpen = p.body.statuses.find((x: { name: string }) => x.name === 'Open').id;
    const wrong = await mick.patch('/w/friday-dev/issues/DP-1', { statusId: bugOpen }, 4);
    expect(wrong.body.error.code).toBe('status_not_in_workflow');

    const acts = await owner.query(`SELECT field FROM activities WHERE verb = 'updated' AND field = 'statusId'`);
    expect(acts.rowCount).toBe(2);
  });

  it('Sub-task แก้ Module เองไม่ได้ · ความคืบหน้าของ Task ที่มี Sub-task กรอกเองไม่ได้', async () => {
    const mod = await mick.patch('/w/friday-dev/issues/DP-3', { moduleId: creditLine }, 1);
    expect(mod.body.error.code).toBe('inherited_field');
    const prog = await mick.patch('/w/friday-dev/issues/DP-1', { progressPct: 50 }, 4);
    expect(prog.body.error.code).toBe('progress_from_subtasks');
    // หน้ารายละเอียดส่งค่าที่คำนวณแล้ว (DP-1 เสร็จแล้วจึงเป็น 100) และบอกว่ากรอกเองไม่ได้
    const parent = await mick.get('/w/friday-dev/issues/DP-1');
    expect(parent.body).toMatchObject({ progressFromSubtasks: true, progressPct: 100 });
    const leaf = await mick.get('/w/friday-dev/issues/DP-3');
    expect(leaf.body.progressFromSubtasks).toBe(false);
  });

  it('หลังตั้ง Baseline การแก้แผนบันทึกในการแก้ไขแผน · เหตุผลไม่บังคับ', async () => {
    await owner.query(
      `INSERT INTO plan_baselines (workspace_id, project_id, version, source) SELECT workspace_id, id, 1, 'import' FROM projects WHERE key = 'DP'`,
    );
    const noReason = await mick.patch('/w/friday-dev/issues/DP-2', { planEnd: '2026-12-10' }, 4);
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(200);
    const ok = await mick.patch('/w/friday-dev/issues/DP-2', { planEnd: '2026-12-11', planChangeReason: 'BA เพิ่ม Template แบบ Fleet' }, noReason.body.version);
    expect(ok.status).toBe(200);
    const rows = await owner.query(`SELECT field, reason, new_value FROM plan_changes ORDER BY changed_at`);
    expect(rows.rows).toEqual([{ field: 'planEnd', reason: null, new_value: '2026-12-10' }, { field: 'planEnd', reason: 'BA เพิ่ม Template แบบ Fleet', new_value: '2026-12-11' }]);
  });
});

describe('การเข้าถึงข้าม Workspace และโปรเจกต์', () => {
  it('คนนอก Workspace ได้ 404 (ไม่บอกว่ามีอยู่)', async () => {
    await signup(outsider, 'other@example.com', 'Other');
    await outsider.post('/workspaces', { name: 'Acme', slug: 'acme' });
    const ws = await outsider.get('/w/friday-dev/projects');
    expect(ws.status).toBe(404);
    expect(ws.body.error.code).toBe('workspace_not_found');
    const issue = await outsider.get('/w/acme/issues/DP-1');
    expect(issue.status).toBe(404);
  });

  it('Workspace Admin เห็นโปรเจกต์ Private ในรายการ แต่ต้องกดเข้าร่วมก่อนเปิดงาน', async () => {
    armId = await signup(arm, 'arm@example.com', 'Arm');
    await addMember('friday-dev', armId, 'admin');
    const list = await arm.get('/w/friday-dev/projects');
    expect(list.body.items[0]).toMatchObject({ key: 'DP', joined: false });
    const blocked = await arm.get('/w/friday-dev/issues/DP-1');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: 'not_project_member', details: { canJoinAsAdmin: true, requestAccess: false } });

    const join = await arm.post('/w/friday-dev/projects/DP/join-as-admin');
    expect(join.status).toBe(200);
    expect((await arm.get('/w/friday-dev/issues/DP-1')).status).toBe(200);
    const note = await owner.query(`SELECT event_type FROM notifications WHERE recipient_id = $1`, [mickId]);
    expect(note.rows.map((r) => r.event_type)).toContain('project.admin_joined');
  });

  it('Member ทั่วไปเข้าร่วมเองไม่ได้', async () => {
    await mick.post('/w/friday-dev/projects', { name: 'Finance', key: 'FG', startDate: '2026-12-01', goliveDate: '2027-03-31' });
    const r = await kaijeaw.post('/w/friday-dev/projects/FG/join-as-admin');
    expect(r.status).toBe(403);
    const view = await kaijeaw.get('/w/friday-dev/projects/FG');
    expect(view.status).toBe(404);
  });

  it('Guest ที่เป็น Viewer เห็นเฉพาะงานที่แชร์ และไม่เห็นข้อมูลคน', async () => {
    clientId = await signup(client_, 'client@example.com', 'Client');
    await addMember('friday-dev', clientId, 'guest', { key: 'DP', role: 'viewer' });
    await owner.query(`UPDATE issues SET shared_with_guests = true WHERE number = 1`);
    const list = await client_.get('/w/friday-dev/projects/DP/issues');
    expect(list.body.items.map((x: { key: string }) => x.key)).toEqual(['DP-1']);
    expect(list.body.items[0].assigneeIds).toBeUndefined();
    const hidden = await client_.get('/w/friday-dev/issues/DP-2');
    expect(hidden.status).toBe(404);
    const create = await client_.post('/w/friday-dev/projects/DP/issues', { title: 'x', moduleId: creditLine });
    expect(create.body.error).toMatchObject({ code: 'forbidden', details: { permission: 'issue.create' } });
    const perms = await client_.get('/w/friday-dev/projects/DP/my-permissions');
    expect(perms.body).toMatchObject({ role: 'viewer', guestViewer: true });
    expect(perms.body.permissions).not.toContain('project.workload.view');
  });
});

describe('เชิญสมาชิก (H, J4)', () => {
  let token = '';

  it('Owner เชิญเข้า Workspace + โปรเจกต์ แล้วได้ลิงก์เชิญ (ส่งอีเมลปิดไว้ช่วงแรก)', async () => {
    const r = await mick.post('/w/friday-dev/invitations', { emails: ['new.dev@example.com', 'kaijeaw@example.com'], projectKey: 'DP', projectRole: 'member', jobTitle: 'Backend Dev', capacityHoursWeek: 40 });
    expect(r.status).toBe(201);
    expect(r.body.items.map((x: { status: string }) => x.status)).toEqual(['invited', 'already_member']);
    token = r.body.items[0].inviteUrl.split('/join/')[1];
    // ลิงก์ชี้ไปที่เว็บ (APP_URL / WEB_URL) ไม่ใช่ Host ของคำขอที่วิ่งผ่าน proxy ของเว็บ
    expect(r.body.items[0].inviteUrl.split('/join/')[0]).toBe((process.env.APP_URL ?? process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, ''));
    const anon = await request(app.getHttpServer()).get(`/api/v1/invitations/${token}`);
    expect(anon.body).toMatchObject({ status: 'pending', email: 'new.dev@example.com', workspace: { slug: 'friday-dev' }, invitedBy: 'Mick', project: { key: 'DP' }, projectRole: 'member' });
  });

  it('Member ที่ไม่มีสิทธิ์เชิญ → 403', async () => {
    const proj = await kaijeaw.post('/w/friday-dev/invitations', { emails: ['x@example.com'], projectKey: 'DP' });
    expect(proj.body.error.details.permission).toBe('project.invite');
    const ws = await kaijeaw.post('/w/friday-dev/invitations', { emails: ['x@example.com'] });
    expect(ws.body.error.details.permission).toBe('ws.members.manage');
  });

  it('ตอบรับได้เฉพาะบัญชีที่ถูกเชิญ แล้วเข้าโปรเจกต์ได้ทันที', async () => {
    const wrong = await outsider.post(`/invitations/${token}/accept`);
    expect(wrong.body.error.code).toBe('invitation_email_mismatch');

    const nd = await client();
    await signup(nd, 'new.dev@example.com', 'New Dev');
    const ok = await nd.post(`/invitations/${token}/accept`);
    expect(ok.status).toBe(200);
    expect((await nd.get('/me/workspaces')).body.items.map((w: { slug: string }) => w.slug)).toEqual(['friday-dev']);
    expect((await nd.get('/w/friday-dev/projects/DP/issues')).status).toBe(200);
    const again = await nd.post(`/invitations/${token}/accept`);
    expect(again.body.error.code).toBe('invitation_not_pending');
    const note = await owner.query(`SELECT 1 FROM notifications WHERE event_type = 'member.joined' AND recipient_id = $1`, [mickId]);
    expect(note.rowCount).toBe(1);
  });

  it('ยกเลิกคำเชิญแล้วลิงก์ใช้ไม่ได้ (410)', async () => {
    const r = await mick.post('/w/friday-dev/invitations', { emails: ['late@example.com'] });
    const t = r.body.items[0].inviteUrl.split('/join/')[1];
    await mick.post(`/w/friday-dev/invitations/${r.body.items[0].invitationId}/revoke`);
    const late = await client();
    await signup(late, 'late@example.com', 'Late');
    const res = await late.post(`/invitations/${t}/accept`);
    expect(res.status).toBe(410);
    expect(res.body.error.details.invitedBy).toBe('Mick');
  });

  it('รายชื่อสมาชิก: Guest ไม่เห็น', async () => {
    expect((await client_.get('/w/friday-dev/members')).body.error.details.permission).toBe('ws.directory.view');
    const list = await mick.get('/w/friday-dev/members');
    expect(list.body.items.map((m: { displayName: string }) => m.displayName)).toContain('New Dev');
  });
});

/** ไฟล์แผนตัวอย่าง (ข้อมูลสมมติ) ที่มีหัวคอลัมน์เหมือนไฟล์แผนจริง */
async function planWorkbook() {
  const wb = new ExcelJS.Workbook();
  const t = wb.addWorksheet('Table');
  t.addRow(['ID', 'No.', 'Module', 'Sprint', 'Module Task', 'Screen', 'FR / NFR', 'BA', 'Status', 'Dev', 'Size', 'Man-Day', 'Plan Start', 'Plan End', 'Actual Start', 'Actual End', 'Remark', 'แก้ไขบนเว็บ']);
  const d = (x: string) => new Date(`${x}T00:00:00Z`);
  const rows: unknown[][] = [
    [4, 1, 'Credit Line', 'Sprint 0 : Foundation', 'Database', '-', 'NFR-09', 'Donut', 'Not Start', 'Zo', 'S', 3, d('2026-11-05'), d('2026-11-09'), null, null, null],
    [5, 2, 'Credit Line', 'Sprint 0 : Foundation', 'Master data', '-', 'SRS', 'Donut', 'Not Start', 'Pond, Zo', 'S', 3, d('2026-11-05'), d('2026-11-09'), null, null, null],
    [6, 3, 'Credit Line', 'Sprint 1 : หลักประกัน', 'ฟอร์มหลักประกัน', 'SCR-107', 'FR-06.2', 'Donut', 'Not Start', 'Kaijeaw', { formula: 'IF(L4<=5,"M","L")', result: 'M' }, 5, d('2026-12-07'), d('2026-12-15'), null, null, 'ใช้ร่วมกับ DP-38'],
    [7, 4, 'Drawdown', 'Sprint 0 : Foundation', 'ไม่มี BA', '-', '-', null, 'Not Start', 'Pond', 'XS', 1, d('2026-11-05'), d('2026-11-05'), null, null, null],
    [8, 5, 'Interface FP/HP/KL', 'Provider : Floor Plan', 'Interface ยังไม่ลงแผน', '-', '-', null, 'Not Start', null, null, null, null, null, null, null, null],
    [9, 6, 'Drawdown', 'Database 4 tables (X, Y)', 'งานที่ Sprint ผิดช่อง', '-', '-', 'Donut', null, 'Tung', 'XS', 1, d('2026-11-10'), d('2026-11-10'), null, null, null],
    [10, 7, 'Drawdown', 'Sprint 1 : รับข้อมูลรถ', 'Upload รถ', '-', 'FR-01.1, FR-01.2', 'Donut', 'In Progress', 'Pond', 'XS', 1, d('2026-11-10'), d('2026-11-10'), d('2026-11-10'), null, null],
  ];
  rows.forEach((r) => t.addRow(r));
  const h = wb.addWorksheet('Holidays');
  h.addRow(['วันหยุด', 'ชื่อวันหยุด']);
  h.addRow([d('2026-12-07'), 'ชดเชยวันพ่อแห่งชาติ']);
  h.addRow([d('2026-12-10'), 'วันรัฐธรรมนูญ']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Import Excel (L3)', () => {
  let jobId = '';

  // คอลัมน์ Sprint ในไฟล์ไม่ถูกจับคู่แล้ว (เลิกใช้กลุ่มงาน · ผู้ใช้ตัดสิน 2026-11-08)
  it('อัปโหลดแล้วจับคู่คอลัมน์ 16 ช่อง (รวม ID) และตรวจข้อมูลตามหน้า L3', async () => {
    const r = await mick.upload('/w/friday-dev/import-jobs', await planWorkbook(), 'Plan Demo 2026 (2026-11-05).xlsx', { mode: 'create' });
    expect(r.status).toBe(201);
    jobId = r.body.id;
    expect(r.body.columns.filter((c: { field: string | null }) => c.field)).toHaveLength(16);
    expect(r.body.columns.find((c: { header: string }) => c.header === 'Sprint')?.field).toBeNull();
    expect(r.body.summary).toMatchObject({ rows: 7, modules: 3, ready: 5, backlog: 1, skipped: 1, manDay: 14, planFrom: '2026-11-05', planTo: '2026-12-15' });
    expect(r.body.project).toEqual({ name: 'Plan Demo 2026', key: 'PD' });
    const problems = r.body.findings.map((f: { level: string; no: number | null; problem: string }) => `${f.level}:${f.no ?? '-'}:${f.problem}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        'err:4:ไม่มี BA',
        'warn:3:Plan Start 2026-12-07 ตรงวันหยุด',
        'warn:5:ไม่มี Plan Start / End',
        'warn:6:ไม่มีค่า Status',
        'warn:-:ไม่พบ "Tung" ในรายชื่อสมาชิก (1 แถว)',
      ]),
    );
    const kj = r.body.people.find((p: { name: string }) => p.name === 'Kaijeaw');
    expect(kj.target).toEqual({ userId: kaijeawId });
  });

  it('แก้การจับคู่คน / ข้อมูลโปรเจกต์ แล้วตรวจซ้ำ', async () => {
    const bad = await mick.patch(`/w/friday-dev/import-jobs/${jobId}`, { columnMapping: { Dev: 'ไม่มีฟิลด์นี้' } });
    expect(bad.status).toBe(400);
    const r = await mick.patch(`/w/friday-dev/import-jobs/${jobId}`, {
      project: { key: 'PLAN', name: 'แผนตัวอย่าง' },
      personMapping: { donut: { email: 'donut@example.com' }, zo: { userId: kaijeawId }, pond: null },
    });
    expect(r.status).toBe(200);
    expect(r.body.project).toEqual({ key: 'PLAN', name: 'แผนตัวอย่าง' });
    const notFoundPeople = r.body.findings.filter((f: { problem: string }) => f.problem.startsWith('ไม่พบ')).map((f: { problem: string }) => f.problem);
    expect(notFoundPeople).toEqual(['ไม่พบ "Tung" ในรายชื่อสมาชิก (1 แถว)']);
    expect((await kaijeaw.get(`/w/friday-dev/import-jobs/${jobId}`)).status).toBe(404);
  });

  it('นำเข้าแล้วได้โปรเจกต์, งาน (เลขงาน = ID), Baseline v1 และคำเชิญ', async () => {
    const r = await mick.post(`/w/friday-dev/import-jobs/${jobId}/commit`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ project: { key: 'PLAN' }, imported: 6, scheduled: 5, backlog: 1, skipped: 1, baseline: true });
    expect(r.body.invitations.map((i: { email: string; status: string }) => `${i.email}:${i.status}`)).toEqual(['donut@example.com:invited']);

    const p3 = await mick.get('/w/friday-dev/issues/PLAN-6'); // No. 3 · ID 6
    expect(p3.body).toMatchObject({ planStart: '2026-12-08', planEnd: '2026-12-15', size: 'M', estimateMd: 5, assigneeIds: [kaijeawId], description: null, remark: 'ใช้ร่วมกับ DP-38' }); // คอลัมน์ Remark ของไฟล์เดิมเข้าช่อง Remark (ผู้ใช้ตัดสิน 2026-11-09)
    const p2 = await mick.get('/w/friday-dev/issues/PLAN-5');
    expect(p2.body.assigneeIds).toEqual([kaijeawId]);
    expect(p2.body.details).toMatchObject({ requirementText: 'SRS', importedPeople: { devs: ['Pond'], ba: 'Donut' } });
    const p7 = await mick.get('/w/friday-dev/issues/PLAN-10');
    expect(p7.body).toMatchObject({ status: { name: 'In progress' }, actualStart: '2026-11-10' });
    expect((await mick.get('/w/friday-dev/issues/PLAN-7')).status).toBe(404);
    expect((await mick.get('/w/friday-dev/issues/PLAN-8')).body.planStart).toBeNull();

    const counts = await owner.query(`
      SELECT (SELECT count(*)::int FROM phases ph JOIN projects p ON p.id = ph.project_id WHERE p.key = 'PLAN') AS phases,
             (SELECT count(*)::int FROM baseline_items bi JOIN plan_baselines b ON b.id = bi.baseline_id JOIN projects p ON p.id = b.project_id WHERE p.key = 'PLAN') AS baseline,
             (SELECT count(*)::int FROM issue_requirements ir JOIN issues i ON i.id = ir.issue_id JOIN projects p ON p.id = i.project_id WHERE p.key = 'PLAN') AS reqs,
             (SELECT issue_seq FROM projects WHERE key = 'PLAN') AS seq`);
    expect(counts.rows[0]).toEqual({ phases: 0, baseline: 6, reqs: 4, seq: 10 });

    // หลังนำเข้า สร้างงานใหม่ได้เลขถัดจาก No. สูงสุด · แก้แผนได้เลย (มี Baseline จึงลงการแก้ไขแผน)
    const next = await mick.post('/w/friday-dev/projects/PLAN/issues', { title: 'งานใหม่', moduleId: p3.body.moduleId });
    expect(next.body.key).toBe('PLAN-11');
    const edit = await mick.patch('/w/friday-dev/issues/PLAN-6', { planEnd: '2026-12-16' }, p3.body.version);
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const again = await mick.post(`/w/friday-dev/import-jobs/${jobId}/commit`);
    expect(again.body.error.code).toBe('import_not_editable');
  });

  it('ไฟล์ที่ไม่ใช่ .xlsx หรือไม่มีตารางงาน → 400', async () => {
    const txt = await mick.upload('/w/friday-dev/import-jobs', Buffer.from('hello'), 'plan.csv');
    expect(txt.body.error.code).toBe('invalid_file');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['a', 'b']);
    const empty = await mick.upload('/w/friday-dev/import-jobs', Buffer.from(await wb.xlsx.writeBuffer()), 'empty.xlsx');
    expect(empty.body.error.code).toBe('no_table_sheet');
  });
});

describe('คำขอเลื่อน Due (K3) และ Inbox (G)', () => {
  const ws = '/w/friday-dev';
  let requestId = '';
  const inbox = (c: Client, filter = 'all') => c.get(`/me/notifications?workspace=friday-dev&filter=${filter}`);

  it('เตรียม: ปิดสิทธิ์แก้ Due ตรงของ Member · งานของ Kaijeaw 2 งานที่ช่วงวันต่อกัน', async () => {
    await mick.put(`${ws}/projects/DP/role-permissions`, { role: 'member', permission: 'issue.change_due_directly', allowed: false });
    // M = 5 MD เริ่ม พ. 25 พ.ย. → 25, 26, 27, 30 พ.ย., 1 ธ.ค. (เหมือน DP-30 ใน Prototype)
    const a = await mick.post(`${ws}/projects/DP/issues`, { title: 'Curtailment Information + Plan Template', moduleId: creditLine, size: 'M', planStart: '2026-11-25', assigneeIds: [kaijeawId] });
    expect(a.body).toMatchObject({ key: 'DP-5', planEnd: '2026-12-01' });
    const b = await mick.post(`${ws}/projects/DP/issues`, { title: 'Credit / Sub / Shared Limit', moduleId: creditLine, estimateMd: 3, planStart: '2026-12-02', assigneeIds: [kaijeawId] });
    expect(b.body).toMatchObject({ key: 'DP-6', planEnd: '2026-12-04' });
  });

  it('Member แก้ Due ตรงไม่ได้ · 403 บอกรายชื่อผู้อนุมัติให้หน้าจอเปิดฟอร์ม K3', async () => {
    const issue = await kaijeaw.get(`${ws}/issues/DP-5`);
    const r = await kaijeaw.patch(`${ws}/issues/DP-5`, { planEnd: '2026-12-04' }, issue.body.version);
    expect(r.status).toBe(403);
    expect(r.body.error.details.canRequest).toBe(true);
    expect(r.body.error.details.approvers.map((p: { displayName: string }) => p.displayName).sort()).toEqual(['Arm', 'Mick']);
    expect(r.body.error.details.approvers[0]).toHaveProperty('initials');
  });

  it('ผลกระทบที่ระบบคำนวณ: วันทำการที่เพิ่ม, Workload ที่ชน, Milestone และผู้อนุมัติ', async () => {
    const r = await kaijeaw.get(`${ws}/issues/DP-5/due-requests/preview?due=2026-12-04`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ currentDue: '2026-12-01', requestedDue: '2026-12-04', addedWorkingDays: 3, dependents: [], goLive: { onTime: true }, parent: null });
    // ช่วงที่เลื่อนออกไป 2–4 ธ.ค. (3 วันทำการ) · capacity 40 ชม./สัปดาห์ = 1 MD/วัน × 3 วัน
    // DP-6: 3 MD คนเดียว อยู่ในช่วงทั้งหมด = 3 · DP-2: 3 MD แบ่ง 2 คน = 1.5 กระจาย 7 วันทำการ (1–11 ธ.ค.) ตรงช่วง 3 วัน = 0.64
    expect(r.body.workload[0]).toMatchObject({ person: { id: kaijeawId }, otherWorkMd: 3.64, capacityMd: 3, overloaded: true });
    expect(r.body.workload[0].overlapping.map((x: { key: string }) => x.key)).toEqual(['DP-2', 'DP-6']);
    expect(r.body.milestones).toEqual([expect.objectContaining({ name: 'Credit Line Go-live', onTime: true })]);
    expect(r.body.approvers.map((p: { id: string }) => p.id)).not.toContain(kaijeawId);

    const earlier = await kaijeaw.get(`${ws}/issues/DP-5/due-requests/preview?due=2026-11-30`);
    expect(earlier.body.error.code).toBe('not_a_postponement');
  });

  it('ส่งคำขอได้ทีละ 1 ต่องาน · Admin ไม่ต้องขอ · Guest ขอไม่ได้', async () => {
    const other = await kaijeaw.post(`${ws}/issues/DP-5/due-requests`, { requestedDue: '2026-12-04', reasonCode: 'other' });
    expect(other.body.error.details.fields[0].path).toBe('detail');

    const r = await kaijeaw.post(`${ws}/issues/DP-5/due-requests`, { requestedDue: '2026-12-04', reasonCode: 'scope_added', detail: 'BA Donut ยืนยันเพิ่ม Plan Template แบบ Fleet (30 พ.ย.)' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', issueKey: 'DP-5', currentDue: '2026-12-01', requestedDue: '2026-12-04', reasonLabel: 'ขอบเขตงานเพิ่ม', requester: { displayName: 'Kaijeaw' } });
    expect(r.body.impact.addedWorkingDays).toBe(3);
    requestId = r.body.id;

    const dup = await kaijeaw.post(`${ws}/issues/DP-5/due-requests`, { requestedDue: '2026-12-08', reasonCode: 'estimate_wrong' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'due_request_pending', details: { id: requestId } });
    const admin = await mick.post(`${ws}/issues/DP-5/due-requests`, { requestedDue: '2026-12-08', reasonCode: 'estimate_wrong' });
    expect(admin.body.error.code).toBe('due_change_allowed_directly');
    const guest = await client_.post(`${ws}/issues/DP-1/due-requests`, { requestedDue: '2026-12-31', reasonCode: 'estimate_wrong' });
    expect(guest.status).toBe(403);

    const issue = await kaijeaw.get(`${ws}/issues/DP-5`);
    expect(issue.body.pendingDueRequest).toMatchObject({ id: requestId, requestedDue: '2026-12-04' });
  });

  it('ผู้อนุมัติเห็นคำขอใน Inbox พร้อมปุ่มอนุมัติ · ผู้ขอไม่ได้รับแจ้งเรื่องที่ตัวเองทำ', async () => {
    const r = await inbox(mick, 'activity');
    expect(r.status).toBe(200);
    const item = r.body.items.find((x: { eventType: string }) => x.eventType === 'due_request.created');
    expect(item).toMatchObject({
      category: 'activity',
      actor: { displayName: 'Kaijeaw' },
      reason: 'คุณเป็นผู้อนุมัติ (Project Owner)',
      issue: { key: 'DP-5', status: { name: 'To do' }, planEnd: '2026-12-01', moduleName: 'Credit Line' },
      dueRequest: { id: requestId, status: 'pending', requestedDue: '2026-12-04', canDecide: true },
    });
    expect(item.readAt).toBeNull();
    expect(r.body.counts.unread).toBeGreaterThanOrEqual(1);
    expect((await inbox(arm)).body.items.some((x: { eventType: string }) => x.eventType === 'due_request.created')).toBe(true);
    // ผู้ขอไม่ได้รับแจ้งคำขอของตัวเอง (หลัง A23 Inbox ของผู้ขอมีแจ้งเตือนอื่นที่ถูกต้อง เช่น ได้รับมอบหมายงาน)
    expect((await inbox(kaijeaw)).body.items.filter((x: { eventType: string }) => x.eventType.startsWith('due_request.'))).toEqual([]);

    const bell = await mick.get('/me/notifications/summary');
    expect(bell.body.workspaces).toEqual([expect.objectContaining({ slug: 'friday-dev' })]);
    expect(bell.body.total).toBe(r.body.counts.unread);

    const home = await mick.get(`${ws}/due-requests?scope=to_approve`);
    expect(home.body.items.map((x: { id: string; canDecide: boolean }) => [x.id, x.canDecide])).toEqual([[requestId, true]]);
    expect((await kaijeaw.get(`${ws}/due-requests?scope=to_approve`)).body.items).toEqual([]);
  });

  it('อนุมัติคำขอของตัวเองไม่ได้ แม้ได้รับสิทธิ์อนุมัติ', async () => {
    const noPerm = await kaijeaw.post(`${ws}/due-requests/${requestId}/approve`);
    expect(noPerm.body.error.details.permission).toBe('due_request.approve');
    await mick.put(`${ws}/projects/DP/role-permissions`, { role: 'member', permission: 'due_request.approve', allowed: true });
    const own = await kaijeaw.post(`${ws}/due-requests/${requestId}/approve`);
    expect(own.body.error.code).toBe('cannot_decide_own_request');
    await mick.put(`${ws}/projects/DP/role-permissions`, { role: 'member', permission: 'due_request.approve', allowed: false });
  });

  it('อนุมัติแล้วแก้ Due, บันทึกการแก้ไขแผนด้วยเหตุผลในคำขอ และแจ้งผู้ขอ', async () => {
    const before = await mick.get(`${ws}/issues/DP-5`);
    const r = await mick.post(`${ws}/due-requests/${requestId}/approve`, { note: 'โอเค ยังทัน Go-live' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'approved', decidedBy: { displayName: 'Mick' }, decidedVia: 'in_app', decisionNote: 'โอเค ยังทัน Go-live', issue: { key: 'DP-5', planEnd: '2026-12-04', version: before.body.version + 1 } });
    expect((await mick.get(`${ws}/issues/DP-5`)).body).toMatchObject({ planEnd: '2026-12-04', pendingDueRequest: null });

    const again = await arm.post(`${ws}/due-requests/${requestId}/reject`);
    expect(again.body.error).toMatchObject({ code: 'already_decided', details: { status: 'approved' } });

    const pc = await owner.query(`SELECT source, reason, impact, new_value FROM plan_changes WHERE source = 'due_request'`);
    expect(pc.rows).toEqual([{ source: 'due_request', reason: 'ขอบเขตงานเพิ่ม: BA Donut ยืนยันเพิ่ม Plan Template แบบ Fleet (30 พ.ย.)', impact: 'เพิ่ม 3 วันทำการ', new_value: '2026-12-04' }]);
    const act = await owner.query(`SELECT verb FROM activities WHERE verb LIKE 'due_request%' OR verb = 'due_requested' ORDER BY created_at`);
    expect(act.rows.map((x) => x.verb)).toEqual(['due_requested', 'due_request_approved']);

    const note = (await inbox(kaijeaw)).body.items[0];
    expect(note).toMatchObject({ eventType: 'due_request.decided', reason: 'คุณเป็นผู้ขอเลื่อน Due', dueRequest: { status: 'approved', decisionNote: 'โอเค ยังทัน Go-live', canDecide: false } });
    // แจ้งเตือนเดิมของผู้อนุมัติแสดงผลการตัดสินล่าสุด
    const mine = (await inbox(mick, 'activity')).body.items.find((x: { eventType: string }) => x.eventType === 'due_request.created');
    expect(mine.dueRequest).toMatchObject({ status: 'approved', canDecide: false });
  });

  it('ปฏิเสธพร้อมเหตุผล Due ไม่เปลี่ยน · ผู้ขอยกเลิกคำขอของตัวเองได้', async () => {
    const r1 = await kaijeaw.post(`${ws}/issues/DP-5/due-requests`, { requestedDue: '2026-12-08', reasonCode: 'waiting_input' });
    const rej = await arm.post(`${ws}/due-requests/${r1.body.id}/reject`, { note: 'ย้ายไป Sprint หน้าแทน' });
    expect(rej.body).toMatchObject({ status: 'rejected', decidedBy: { displayName: 'Arm' }, issue: { planEnd: '2026-12-04' } });
    expect((await inbox(kaijeaw)).body.items[0].dueRequest).toMatchObject({ status: 'rejected', decisionNote: 'ย้ายไป Sprint หน้าแทน' });

    const r2 = await kaijeaw.post(`${ws}/issues/DP-5/due-requests`, { requestedDue: '2026-12-09', reasonCode: 'estimate_wrong' });
    expect((await mick.post(`${ws}/due-requests/${r2.body.id}/cancel`)).status).toBe(403);
    const cancel = await kaijeaw.post(`${ws}/due-requests/${r2.body.id}/cancel`);
    expect(cancel.body).toMatchObject({ status: 'cancelled', decidedBy: null });

    const history = await kaijeaw.get(`${ws}/issues/DP-5/due-requests`);
    expect(history.body.items.map((x: { status: string }) => x.status)).toEqual(['cancelled', 'rejected', 'approved']);
    expect((await kaijeaw.get(`${ws}/due-requests?scope=mine&status=all`)).body.items).toHaveLength(3);
  });

  it('Due ถูกแก้หลังส่งคำขอ → อนุมัติไม่ได้ (409) ต้องตัดสินใหม่', async () => {
    const r = await kaijeaw.post(`${ws}/issues/DP-5/due-requests`, { requestedDue: '2026-12-11', reasonCode: 'blocked_by_dependency' });
    const issue = await mick.get(`${ws}/issues/DP-5`);
    await mick.patch(`${ws}/issues/DP-5`, { planEnd: '2026-12-08', planChangeReason: 'Lead เลื่อนให้เอง' }, issue.body.version);
    const ok = await mick.post(`${ws}/due-requests/${r.body.id}/approve`);
    expect(ok.body.error).toMatchObject({ code: 'due_changed_since_request', details: { currentDue: '2026-12-08', dueWhenRequested: '2026-12-04' } });
    expect((await mick.post(`${ws}/due-requests/${r.body.id}/reject`)).status).toBe(200);
  });

  it('Inbox: อ่าน / ทำเสร็จ / เตือนพรุ่งนี้ / อ่านทั้งหมด · แก้ของคนอื่นไม่ได้', async () => {
    const items = (await inbox(mick)).body.items;
    const [a, b, c] = items;
    expect((await mick.post(`/me/notifications/${a.id}/read`)).body.readAt).not.toBeNull();
    expect((await kaijeaw.post(`/me/notifications/${a.id}/read`)).status).toBe(404);

    await mick.post(`/me/notifications/${b.id}/done`);
    const snooze = await mick.post(`/me/notifications/${c.id}/snooze`, { preset: 'tomorrow' });
    expect(new Date(snooze.body.snoozedUntil).getTime()).toBeGreaterThan(Date.now());
    const after = (await inbox(mick)).body;
    expect(after.items.map((x: { id: string }) => x.id)).not.toContain(b.id);
    expect(after.items.map((x: { id: string }) => x.id)).not.toContain(c.id);
    expect(after.counts.all).toBe(items.length - 2);

    const unreadOnly = (await inbox(mick, 'unread')).body.items;
    expect(unreadOnly.every((x: { readAt: string | null }) => x.readAt === null)).toBe(true);
    await mick.post('/me/notifications/read-all', { workspace: 'friday-dev' });
    expect((await mick.get('/me/notifications/summary')).body.total).toBe(0);

    // แบ่งหน้า
    const p1 = (await mick.get('/me/notifications?workspace=friday-dev&limit=1')).body;
    const p2 = (await mick.get(`/me/notifications?workspace=friday-dev&limit=1&cursor=${p1.nextCursor}`)).body;
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
  });
});

describe('Kanban (3) และ Timeline (4)', () => {
  const ws = '/w/friday-dev';
  let statuses: { id: string; name: string; boardColumnId: string | null }[] = [];
  const std = (name: string) => statuses.find((x) => x.name === name && !x.boardColumnId)!.id;
  const column = (board: { columns: { name: string; cards: { key: string }[] }[] }, name: string) =>
    board.columns.find((c) => c.name === name)!.cards.map((c) => c.key);

  it('บอร์ดมาตรฐาน: คอลัมน์ของ Workflow มาตรฐาน · การ์ด Bug วางตามคอลัมน์ที่ผูกไว้และแสดงสถานะจริง', async () => {
    statuses = (await mick.get(`${ws}/projects/DP`)).body.statuses;
    const bug = await mick.post(`${ws}/projects/DP/issues`, { type: 'Bug', title: 'Workflow ส่งกลับแก้ไข: สถานะไม่กลับเป็น Draft', moduleId: creditLine, severity: 'major', environment: 'sit', details: { steps: '1. LO ส่งคืน' }, assigneeIds: [kaijeawId] });
    expect(bug.body.key).toBe('DP-7');

    const r = await mick.get(`${ws}/projects/DP/board`);
    expect(r.status).toBe(200);
    expect(r.body.columns.map((c: { name: string }) => c.name)).toEqual(['To do', 'In progress', 'Review', 'Done']);
    expect(column(r.body, 'Done')).toEqual(['DP-1']);
    expect(column(r.body, 'To do')).toEqual(['DP-2', 'DP-3', 'DP-4', 'DP-5', 'DP-6', 'DP-7']);
    const card = r.body.columns[0].cards.find((c: { key: string }) => c.key === 'DP-7');
    expect(card).toMatchObject({ type: { name: 'Bug' }, status: { name: 'Open' }, module: { name: 'Credit Line' }, assignees: [{ id: kaijeawId, displayName: 'Kaijeaw' }] });
    const parent = r.body.columns[3].cards[0];
    expect(parent.subtasks).toEqual({ total: 2, done: 0 });
    expect(r.body.bugStatusColumns).toContainEqual({ status: 'Fixed', column: 'Review' });
  });

  it('ลาก Bug ไปคอลัมน์ Review → สถานะ Fixed · บอร์ด Bug แยกคอลัมน์ตามสถานะจริง', async () => {
    const r = await kaijeaw.post(`${ws}/issues/DP-7/move`, { statusId: std('Review') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: { name: 'Fixed', category: 'in_progress' } });
    expect(r.body.actualStart).not.toBeNull();
    expect(column((await mick.get(`${ws}/projects/DP/board`)).body, 'Review')).toEqual(['DP-7']);

    const bugBoard = (await mick.get(`${ws}/projects/DP/board?type=bug`)).body;
    expect(bugBoard.columns.map((c: { name: string }) => c.name)).toEqual(['Open', 'In progress', 'Fixed', 'Verified', 'Closed']);
    expect(column(bugBoard, 'Fixed')).toEqual(['DP-7']);
    expect(bugBoard.columns.flatMap((c: { cards: unknown[] }) => c.cards)).toHaveLength(1);
  });

  it('ย้ายไป Done ทั้งที่ Sub-task ยังไม่ครบ ต้องยืนยัน', async () => {
    await mick.post(`${ws}/issues/DP-1/move`, { statusId: std('In progress') });
    const blocked = await mick.post(`${ws}/issues/DP-1/move`, { statusId: std('Done') });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toMatchObject({ code: 'subtasks_incomplete', details: { open: 2, confirmable: true } });
    const ok = await mick.post(`${ws}/issues/DP-1/move`, { statusId: std('Done'), confirm: true });
    expect(ok.body.status.name).toBe('Done');
    expect(ok.body.warnings[0].code).toBe('subtasks_incomplete');
  });

  it('เรียงลำดับในคอลัมน์ไม่ทำให้ version เพิ่ม · ตำแหน่งต้องสมเหตุสมผล', async () => {
    const before = await mick.get(`${ws}/issues/DP-6`);
    const r = await mick.post(`${ws}/issues/DP-6/move`, { beforeKey: 'DP-2' });
    expect(r.body.version).toBe(before.body.version);
    const r2 = await mick.post(`${ws}/issues/DP-4/move`, { afterKey: 'DP-6', beforeKey: 'DP-2' });
    expect(r2.status).toBe(200);
    expect(column((await mick.get(`${ws}/projects/DP/board`)).body, 'To do')).toEqual(['DP-6', 'DP-4', 'DP-2', 'DP-3', 'DP-5']);

    const wrong = await mick.post(`${ws}/issues/DP-5/move`, { afterKey: 'DP-2', beforeKey: 'DP-6' });
    expect(wrong.body.error.code).toBe('invalid_neighbor');
  });

  it('งานจาก Import (ลำดับเดิมซ้ำกัน) ลากครั้งแรกจัดลำดับใหม่ทั้งโปรเจกต์', async () => {
    const before = column((await mick.get(`${ws}/projects/PLAN/board`)).body, 'To do');
    expect(before[0]).toBe('PLAN-4');
    const last = before[before.length - 1];
    await mick.post(`${ws}/issues/${last}/move`, { beforeKey: 'PLAN-4' });
    const after = column((await mick.get(`${ws}/projects/PLAN/board`)).body, 'To do');
    expect(after).toEqual([last, ...before.slice(0, -1)]);
    const legacy = await owner.query(`SELECT count(*)::int AS n FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key = 'PLAN' AND i.rank LIKE '%|%'`);
    expect(legacy.rows[0].n).toBe(0);
  });

  it('เกิน WIP limit เตือนแต่ไม่บล็อก · ตัวกรองงานของฉัน / ระดับงาน', async () => {
    await owner.query(`UPDATE workflow_statuses SET wip_limit = 1 WHERE id = $1`, [std('In progress')]);
    await kaijeaw.post(`${ws}/issues/DP-5/move`, { statusId: std('In progress') });
    const second = await kaijeaw.post(`${ws}/issues/DP-6/move`, { statusId: std('In progress') });
    expect(second.body.warnings).toContainEqual(expect.objectContaining({ code: 'wip_exceeded' }));
    const board = (await kaijeaw.get(`${ws}/projects/DP/board?assignee=me&level=task`)).body;
    const prog = board.columns.find((c: { name: string }) => c.name === 'In progress');
    expect(prog.wip).toEqual({ limit: 1, current: 2, exceeded: true });
    const keys = board.columns.flatMap((c: { cards: { key: string }[] }) => c.cards.map((x) => x.key));
    expect(keys.sort()).toEqual(['DP-1', 'DP-2', 'DP-5', 'DP-6', 'DP-7']); // ไม่มี Sub-task DP-3, DP-4
  });

  it('Guest ที่เป็น Viewer เปิดบอร์ดไม่ได้', async () => {
    const r = await client_.get(`${ws}/projects/DP/board`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('guest_view_limited');
    expect((await client_.post(`${ws}/issues/DP-1/move`, { statusId: std('To do') })).status).toBe(403);
  });

  it('Timeline: Module › กลุ่มงาน › Task › Sub-task + Sprint, Milestone และงานที่ยังไม่มีวันที่', async () => {
    const r = await mick.get(`${ws}/projects/DP/timeline`);
    expect(r.status).toBe(200);
    const cl = r.body.modules.find((m: { name: string }) => m.name === 'Credit Line');
    expect(cl).toMatchObject({ start: '2026-11-25', end: '2026-12-15', taskCount: 4 });
    expect(cl.groups).toHaveLength(1);
    expect(cl.groups[0]).toMatchObject({ phase: null, name: 'ไม่ระบุกลุ่มงาน' });
    const tasks = cl.groups[0].tasks;
    expect(tasks.map((t: { key: string }) => t.key)).toEqual(['DP-5', 'DP-2', 'DP-6', 'DP-1']);
    const dp1 = tasks.find((t: { key: string }) => t.key === 'DP-1');
    expect(dp1).toMatchObject({ progressPct: 100, status: { category: 'done' } });
    expect(dp1.subtasks.map((x: { key: string }) => x.key)).toEqual(['DP-3', 'DP-4']);
    expect(dp1.assignees.map((p: { displayName: string }) => p.displayName)).toEqual(['Mick', 'Kaijeaw']);
    // BA / SA ใช้กรองใน Timeline · ไม่ได้ระบุ = null
    expect(dp1).toHaveProperty('ba');
    expect(dp1).toHaveProperty('sa');
    expect(r.body.unscheduled.map((x: { key: string }) => x.key)).toEqual(['DP-7']);
    expect(r.body.milestones).toEqual([expect.objectContaining({ name: 'Credit Line Go-live', date: '2027-01-26' })]);
    expect(r.body.sprints.length).toBeGreaterThan(5);
    expect(r.body.range).toEqual({ from: '2026-11-25', to: '2027-04-21' });
    // ปฏิทินวันทำการให้หน้าเว็บทำแถบบางลงช่วงวันหยุด
    expect(r.body.calendar.workDays).toEqual([1, 2, 3, 4, 5]);
    expect(r.body.calendar.holidays).toEqual(expect.arrayContaining(['2026-12-07', '2026-12-10']));

    const late = await mick.get(`${ws}/projects/DP/timeline?from=2026-12-16`);
    const keys = late.body.modules.flatMap((m: { groups: { tasks: { key: string }[] }[] }) => m.groups.flatMap((g) => g.tasks.map((t) => t.key)));
    expect(keys).toEqual(['DP-1']); // DP-1 จบ 15 ธ.ค. แต่ Sub-task DP-4 อยู่ 16–17 ธ.ค.
  });

  it('Timeline ของ Guest: ไม่มีชื่อคน ไม่มี Bug และบอกว่างานไหนเปิดได้', async () => {
    const r = await client_.get(`${ws}/projects/DP/timeline`);
    expect(r.status).toBe(200);
    const tasks = r.body.modules[0].groups[0].tasks;
    expect(tasks[0].assignees).toBeUndefined();
    expect(tasks[0].ba).toBeUndefined();
    expect(tasks.find((t: { key: string }) => t.key === 'DP-1').canOpen).toBe(true);
    expect(tasks.find((t: { key: string }) => t.key === 'DP-2').canOpen).toBe(false);
    expect(r.body.unscheduled).toEqual([]);
  });
});
