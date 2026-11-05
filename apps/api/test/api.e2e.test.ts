// ทดสอบ API กับ PostgreSQL จริง: pnpm db:up && pnpm db:migrate && pnpm db:dev-roles ก่อน
import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap.js';

const OWNER_URL = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';
const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication;

/** ผู้ใช้ 1 คน = agent ที่จำคุกกี้ + CSRF token */
async function client() {
  const agent = request.agent(app.getHttpServer());
  const { body } = await agent.get('/api/v1/auth/csrf');
  const h = { 'x-csrf-token': body.csrfToken as string };
  return {
    agent,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string, data?: object) => agent.post(`/api/v1${url}`).set(h).send(data),
    put: (url: string, data?: object) => agent.put(`/api/v1${url}`).set(h).send(data),
    upload: (url: string, file: Buffer, name: string, fields: Record<string, string> = {}) => {
      const r = agent.post(`/api/v1${url}`).set(h);
      for (const [k, v] of Object.entries(fields)) r.field(k, v);
      return r.attach('file', file, name);
    },
    patch: (url: string, data: object, ifMatch?: string | number) => {
      const r = agent.patch(`/api/v1${url}`).set(h);
      return (ifMatch === undefined ? r : r.set('If-Match', `"${ifMatch}"`)).send(data);
    },
  };
}
type Client = Awaited<ReturnType<typeof client>>;

async function signup(c: Client, email: string, name: string) {
  const r = await c.post('/auth/signup', { email, password: 'Friday2026', displayName: name, acceptTerms: true });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/** ยังไม่มี endpoint เชิญสมาชิก จึงเพิ่มตรงในฐานข้อมูล */
async function addMember(wsSlug: string, userId: string, role: string, project?: { key: string; role: string }) {
  const { rows } = await owner.query('SELECT id FROM workspaces WHERE slug = $1', [wsSlug]);
  await owner.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [rows[0].id, userId, role]);
  if (project) {
    await owner.query(
      `INSERT INTO project_members (workspace_id, project_id, user_id, role)
       SELECT workspace_id, id, $2, $3 FROM projects WHERE workspace_id = $1 AND key = $4`,
      [rows[0].id, userId, project.role, project.key],
    );
  }
}

let mick: Client, kaijeaw: Client, outsider: Client, arm: Client, client_: Client;
let mickId: string, kaijeawId: string, armId: string, clientId: string;
let creditLine: string;

beforeAll(async () => {
  await owner.connect();
  const t = (await owner.query(`SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public'`)).rows[0].t;
  await owner.query(`TRUNCATE ${t} CASCADE`);
  app = await createApp();
  await app.init();
  [mick, kaijeaw, outsider, arm, client_] = await Promise.all([client(), client(), client(), client(), client()]);
});

afterAll(async () => {
  await app.close();
  await owner.end();
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
    const out = await mick.post('/w/friday-dev/projects/DP/issues', { title: 'เกินช่วงแม่', parentKey: 'DP-1', planStart: '2026-12-16', planEnd: '2026-12-17' });
    expect(out.body.warnings.map((w: { code: string }) => w.code)).toContain('outside_parent_range');

    const detail = await mick.get('/w/friday-dev/issues/DP-1');
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
  });

  it('หลังตั้ง Baseline การแก้แผนต้องมีเหตุผล และบันทึกในการแก้ไขแผน', async () => {
    await owner.query(
      `INSERT INTO plan_baselines (workspace_id, project_id, version, source) SELECT workspace_id, id, 1, 'import' FROM projects WHERE key = 'DP'`,
    );
    const noReason = await mick.patch('/w/friday-dev/issues/DP-2', { planEnd: '2026-12-10' }, 4);
    expect(noReason.body.error.code).toBe('plan_change_reason_required');
    const ok = await mick.patch('/w/friday-dev/issues/DP-2', { planEnd: '2026-12-11', planChangeReason: 'BA เพิ่ม Template แบบ Fleet' }, 4);
    expect(ok.status).toBe(200);
    const rows = await owner.query(`SELECT field, reason, new_value FROM plan_changes`);
    expect(rows.rows).toEqual([{ field: 'planEnd', reason: 'BA เพิ่ม Template แบบ Fleet', new_value: '2026-12-11' }]);
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

  it('อัปโหลดแล้วจับคู่คอลัมน์ 17 ช่อง (รวม ID) และตรวจข้อมูลตามหน้า L3', async () => {
    const r = await mick.upload('/w/friday-dev/import-jobs', await planWorkbook(), 'Plan Demo 2026 (2026-11-05).xlsx', { mode: 'create' });
    expect(r.status).toBe(201);
    jobId = r.body.id;
    expect(r.body.columns.filter((c: { field: string | null }) => c.field)).toHaveLength(17);
    expect(r.body.summary).toMatchObject({ rows: 7, modules: 3, ready: 5, backlog: 1, skipped: 1, manDay: 14, planFrom: '2026-11-05', planTo: '2026-12-15' });
    expect(r.body.project).toEqual({ name: 'Plan Demo 2026', key: 'PD' });
    const problems = r.body.findings.map((f: { level: string; no: number | null; problem: string }) => `${f.level}:${f.no ?? '-'}:${f.problem}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        'err:4:ไม่มี BA',
        'warn:3:Plan Start 2026-12-07 ตรงวันหยุด',
        'warn:5:ไม่มี Plan Start / End',
        'warn:6:ไม่มีค่า Status',
        'warn:6:คอลัมน์ Sprint เป็น "Database 4 tables (X, Y)" ดูไม่ใช่ชื่อกลุ่มงาน',
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
    expect(p3.body).toMatchObject({ planStart: '2026-12-08', planEnd: '2026-12-15', size: 'M', estimateMd: 5, assigneeIds: [kaijeawId], description: 'ใช้ร่วมกับ DP-38' });
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
    expect(counts.rows[0]).toEqual({ phases: 5, baseline: 6, reqs: 4, seq: 10 });

    // หลังนำเข้า สร้างงานใหม่ได้เลขถัดจาก No. สูงสุด และแก้แผนต้องมีเหตุผลเพราะมี Baseline
    const next = await mick.post('/w/friday-dev/projects/PLAN/issues', { title: 'งานใหม่', moduleId: p3.body.moduleId });
    expect(next.body.key).toBe('PLAN-11');
    const edit = await mick.patch('/w/friday-dev/issues/PLAN-6', { planEnd: '2026-12-16' }, p3.body.version);
    expect(edit.body.error.code).toBe('plan_change_reason_required');

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
