// A43 · Onboarding checklist ของลูกค้า (V1–V4) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type DomainEvent } from '../src/core/events.js';
import { OnboardingService } from '../src/onboarding/onboarding.service.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let moduleId: string;
const events: DomainEvent[] = [];
const q = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows;

type StepView = { key: string; done: boolean; doneAt: string | null; current: number; target: number; action: { kind: string; path: string } | null; detail: Record<string, unknown> | null };
const get = async (c: Client, ws = team.ws) => {
  const r = await c.get(`${ws}/onboarding`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { scope: string; eligible: boolean; steps: StepView[]; doneCount: number; total: number; next: string | null; completed: boolean; hidden: boolean; never: boolean; completionSeen: boolean; invitedBy?: { name: string } | null };
};
const step = (body: { steps: StepView[] }, key: string) => body.steps.find((x) => x.key === key)!;
const createIssue = async (c: Client, extra: Record<string, unknown> = {}) => {
  const r = await c.post(`${team.ws}/projects/${team.key}/issues`, { title: `งานสมมติ ${Math.random().toString(36).slice(2, 7)}`, moduleId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { key: string; version: number };
};

beforeAll(async () => {
  t = await startApp();
  t.app.get(EventBus).on('*', (e) => void events.push(e));
  team = await seedTeam(t, { slug: 'orbit-apps', key: 'OMA' });
  wsId = (await q('SELECT id FROM workspaces WHERE slug = $1', [team.slug]))[0].id;
  moduleId = team.project.modules[0].id;
});
afterAll(() => t.close());

describe('ขั้นของ Workspace (Owner / Admin)', () => {
  it('Workspace ใหม่: 6 ขั้น · โปรเจกต์แรกเสร็จแล้ว · ขั้นถัดไปคืองาน ≥ 10 · ตัวเลขประกอบและลิงก์ปุ่ม', async () => {
    const body = await get(team.lead);
    expect(body).toMatchObject({ scope: 'workspace', eligible: true, total: 6, doneCount: 1, next: 'issues', completed: false, hidden: false, never: false });
    expect(body.steps.map((x) => x.key)).toEqual(['first_project', 'issues', 'team', 'assign_due', 'status_update', 'notifications']);
    expect(step(body, 'first_project')).toMatchObject({ done: true, detail: { projectKey: 'OMA', projectName: 'Development Plan' } });
    expect(step(body, 'issues')).toMatchObject({ done: false, current: 0, target: 10, action: { kind: 'import', path: 'import' } });
    // Lead + Dev = 2 คน → เพื่อนร่วมทีม 1 / 2
    expect(step(body, 'team')).toMatchObject({ done: false, current: 1, target: 2, action: { kind: 'invite', path: 'members' }, detail: { pendingInvites: [], pendingCount: 0 } });
    expect(step(body, 'assign_due').action).toEqual({ kind: 'table', path: 'p/OMA/table' });
    expect(step(body, 'status_update').action).toEqual({ kind: 'kanban', path: 'p/OMA/board' });
    expect(step(body, 'notifications').action).toEqual({ kind: 'notify_settings', path: 'profile?tab=notify' });
    // บันทึกครั้งแรกที่เสร็จ + เหตุการณ์ธุรกิจ (05 › 1.2) ครั้งเดียว แม้เรียกซ้ำ
    await get(team.lead);
    expect(await q(`SELECT step, user_id FROM onboarding_progress WHERE workspace_id = $1`, [wsId])).toEqual([{ step: 'first_project', user_id: null }]);
    expect(await q(`SELECT props FROM product_events WHERE workspace_id = $1 AND name = 'onboarding.step_done'`, [wsId])).toEqual([{ props: { step: 'first_project', version: 1 } }]);
    expect(events.filter((e) => e.type === 'onboarding.step_done').map((e) => e.data.step)).toEqual(['first_project']);
  });

  it('สร้างงานครบ 10 งาน → ขั้นงานเสร็จทันทีจากเหตุการณ์ issue.created (ไม่ต้องเปิด Home) · โปรเจกต์ตัวอย่างไม่นับ', async () => {
    const sample = await team.lead.post(`${team.ws}/projects/sample`, {});
    expect(sample.status, JSON.stringify(sample.body)).toBe(201);
    expect((await get(team.lead)).steps.find((x) => x.key === 'issues')!.current).toBe(0);
    for (let i = 0; i < 9; i++) await createIssue(team.lead);
    expect(await q(`SELECT step FROM onboarding_progress WHERE workspace_id = $1 AND step = 'issues'`, [wsId])).toEqual([]);
    await createIssue(team.dev);
    const [row] = await q(`SELECT meta FROM onboarding_progress WHERE workspace_id = $1 AND step = 'issues'`, [wsId]);
    expect(row.meta).toEqual({ count: 10 });
    // บันทึกในนามผู้สร้างงานคนที่ทำให้ครบ
    expect((await q(`SELECT user_id FROM product_events WHERE workspace_id = $1 AND props->>'step' = 'issues'`, [wsId]))[0].user_id).toBe(team.devId);
    const body = await get(team.lead);
    expect(step(body, 'issues')).toMatchObject({ done: true, current: 10 });
    expect(body.next).toBe('team');
  });

  it('คำเชิญที่ยังไม่ตอบรับแสดงในขั้นชวนทีม · สมาชิกคนที่ 3 (ไม่นับ Guest) ทำให้ขั้นเสร็จ', async () => {
    expect((await team.lead.post(`${team.ws}/invitations`, { emails: ['qa@orbit.example.com'] })).status).toBe(201);
    let body = await get(team.lead);
    expect(step(body, 'team').detail).toEqual({ pendingInvites: ['qa@orbit.example.com'], pendingCount: 1 });
    const guest = await client(t.app);
    await addMember(t.owner, team.slug, await signup(guest, 'guest@orbit.example.com', 'แขก'), 'guest');
    expect(step(await get(team.lead), 'team')).toMatchObject({ done: false, current: 1 });
    const third = await client(t.app);
    await addMember(t.owner, team.slug, await signup(third, 'pm@orbit.example.com', 'ปิยะ'), 'admin');
    body = await get(team.lead);
    expect(step(body, 'team')).toMatchObject({ done: true, current: 2, detail: null });
    // Admin เห็นรายการเดียวกับ Owner
    expect(await get(third)).toMatchObject({ scope: 'workspace', doneCount: 3 });
  });

  it('งานที่มีผู้รับผิดชอบและ Due ≥ 5 · เปลี่ยนสถานะ ≥ 1 ผ่านการแก้งานจริง', async () => {
    for (let i = 0; i < 5; i++) await createIssue(team.lead, { assigneeIds: [team.devId], planStart: '2026-11-16', size: 'S' });
    expect(await q(`SELECT 1 FROM onboarding_progress WHERE workspace_id = $1 AND step = 'assign_due'`, [wsId])).toHaveLength(1);
    const issue = await createIssue(team.lead);
    const doing = team.project.statuses.find((x: { category: string; boardColumnId: string | null }) => x.category === 'in_progress' && !x.boardColumnId).id;
    const r = await team.lead.patch(`${team.ws}/issues/${issue.key}`, { statusId: doing }, issue.version);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const body = await get(team.lead);
    expect(step(body, 'assign_due')).toMatchObject({ done: true, current: 5 });
    expect(step(body, 'status_update')).toMatchObject({ done: true });
    expect(body).toMatchObject({ doneCount: 5, next: 'notifications', completed: false });
  });

  it('สมาชิกตั้งค่าแจ้งเตือน → ขั้น LINE / อีเมลเสร็จเมื่อสมาชิกเปิด Home · ครบ 6 ขั้นส่ง onboarding.completed ครั้งเดียว', async () => {
    expect((await team.dev.put('/me/notification-settings', { workspace: team.slug, dueReminder: '3d', digest: 'workdays', quietStart: null, quietEnd: null })).status).toBe(200);
    // Owner มองไม่เห็นการตั้งค่าของคนอื่นผ่าน RLS แต่ตัวเลขนับรวมทั้ง Workspace
    const body = await get(team.lead);
    expect(step(body, 'notifications')).toMatchObject({ done: true, current: 1 });
    expect(body).toMatchObject({ doneCount: 6, next: null, completed: true, completionSeen: false });
    await get(team.dev);
    expect(events.filter((e) => e.type === 'onboarding.completed' && e.data.scope === 'workspace')).toHaveLength(1);
    expect((await q(`SELECT count(*)::int AS n FROM product_events WHERE workspace_id = $1 AND name = 'onboarding.step_done' AND props->>'step' NOT LIKE 'member.%'`, [wsId]))[0].n).toBe(6);
  });

  it('ขั้นที่เสร็จแล้วไม่ย้อนกลับ แม้ลบงานจนเหลือน้อยกว่าเป้าหมาย', async () => {
    await q(`UPDATE issues SET deleted_at = now() WHERE workspace_id = $1`, [wsId]);
    const body = await get(team.lead);
    expect(step(body, 'issues')).toMatchObject({ done: true, current: 0 });
    expect(body.completed).toBe(true);
    await q(`UPDATE issues SET deleted_at = null WHERE workspace_id = $1`, [wsId]);
  });
});

describe('ซ่อน / แสดง / ไม่ต้องแสดงอีก (ต่อคน)', () => {
  it('ซ่อนของ Owner ไม่กระทบ Admin · แสดงอีกครั้งล้างทั้งซ่อนและไม่ต้องแสดงอีก · เห็นการ์ดครบแล้วครั้งเดียว', async () => {
    expect((await team.lead.post(`${team.ws}/onboarding:hide`)).body).toEqual({ hidden: true, never: false, completionSeen: false });
    expect(await get(team.lead)).toMatchObject({ hidden: true, never: false });
    // ซ่อนต่อคน: คนอื่นใน Workspace (สมาชิก Dev) ยังไม่ได้ซ่อน
    expect(await get(team.dev)).toMatchObject({ hidden: false });
    expect((await team.lead.post(`${team.ws}/onboarding:never`)).body).toEqual({ hidden: true, never: true, completionSeen: false });
    expect((await team.lead.post(`${team.ws}/onboarding:show`)).body).toEqual({ hidden: false, never: false, completionSeen: false });
    expect((await team.lead.post(`${team.ws}/onboarding:complete-seen`)).body).toMatchObject({ completionSeen: true });
    expect(await get(team.lead)).toMatchObject({ completed: true, completionSeen: true, hidden: false });
  });
});

describe('รายการส่วนตัวของสมาชิก (V3)', () => {
  let member: Client;
  let memberId: string;

  beforeAll(async () => {
    member = await client(t.app);
    memberId = await signup(member, 'new.dev@orbit.example.com', 'สมาชิกใหม่');
    // เข้าร่วมผ่านคำเชิญจริง เพื่อให้รู้ว่าใครชวน
    const inv = await team.lead.post(`${team.ws}/invitations`, { emails: ['new.dev@orbit.example.com'], projectKey: team.key, projectRole: 'member' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    await q(`UPDATE invitations SET status = 'accepted', accepted_user_id = $2 WHERE workspace_id = $1 AND email = 'new.dev@orbit.example.com'`, [wsId, memberId]);
    await addMember(t.owner, team.slug, memberId, 'member', { key: team.key, role: 'member' });
  });

  it('3 ขั้น · ยังไม่มีงานที่ได้รับมอบหมาย = ไม่มีปุ่มเปิดงาน · รู้ชื่อผู้ชวน', async () => {
    const body = await get(member);
    expect(body).toMatchObject({ scope: 'member', eligible: true, total: 3, doneCount: 0, next: 'profile', invitedBy: { name: 'Mick' } });
    expect(body.steps.map((x) => x.key)).toEqual(['profile', 'open_assigned', 'notify_channel']);
    expect(step(body, 'profile')).toMatchObject({ detail: { avatar: false, hours: false }, action: { kind: 'profile_hours', path: 'profile?tab=hours' } });
    expect(step(body, 'open_assigned')).toMatchObject({ done: false, action: null, detail: null });
  });

  it('ตั้งรูปและเวลาทำงาน · เปิดงานที่ได้รับมอบหมายจากปุ่ม · เลือกช่องทางแจ้งเตือน → ครบ 3 ขั้น', async () => {
    await q(`UPDATE users SET avatar_url = 'https://example.com/a.png' WHERE id = $1`, [memberId]);
    expect(step(await get(member), 'profile')).toMatchObject({ done: false, detail: { avatar: true, hours: false } });
    await q(`UPDATE workspace_members SET work_start = '09:00', work_end = '18:00' WHERE user_id = $1 AND workspace_id = $2`, [memberId, wsId]);
    expect(step(await get(member), 'profile').done).toBe(true);

    const other = await createIssue(team.lead);
    const mine = await createIssue(team.lead, { assigneeIds: [memberId] });
    const body = await get(member);
    expect(step(body, 'open_assigned')).toMatchObject({ done: false, detail: { issueKey: mine.key }, action: { kind: 'open_issue', path: `p/OMA?issue=${mine.key}` } });
    // งานที่ไม่ได้มอบหมายให้ตัวเองบันทึกไม่ได้
    expect((await member.post(`${team.ws}/onboarding:task-opened`, { issueKey: other.key })).status).toBe(404);
    expect((await member.post(`${team.ws}/onboarding:task-opened`, { issueKey: 'bad key' })).status).toBe(400);
    expect((await member.post(`${team.ws}/onboarding:task-opened`, { issueKey: mine.key })).body).toEqual({ recorded: true });
    expect((await member.post(`${team.ws}/onboarding:task-opened`, { issueKey: mine.key })).body).toEqual({ recorded: false });

    expect((await member.put('/me/notification-prefs', { workspace: team.slug, prefs: [{ eventType: 'issue.assigned', channel: 'email', enabled: true }] })).status).toBe(200);
    const done = await get(member);
    expect(done).toMatchObject({ doneCount: 3, completed: true, next: null });
    expect(events.filter((e) => e.type === 'onboarding.completed' && e.data.scope === 'member')).toHaveLength(1);
    expect((await q(`SELECT props FROM product_events WHERE user_id = $1 AND name = 'onboarding.step_done' ORDER BY occurred_at`, [memberId])).map((r) => r.props.step)).toEqual(['member.profile', 'member.open_assigned', 'member.notify_channel']);
  });

  it('ขั้นส่วนตัวไม่ปนกับขั้นของ Workspace และ Owner ไม่เห็นขั้นส่วนตัวของสมาชิก', async () => {
    expect((await get(team.lead)).steps.map((x) => x.key)).not.toContain('profile');
    const rows = await q(`SELECT count(*)::int AS n FROM onboarding_progress WHERE workspace_id = $1 AND user_id = $2`, [wsId, memberId]);
    expect(rows[0].n).toBe(3);
  });

  it('Guest ไม่เห็นรายการ (403) และซ่อนไม่ได้', async () => {
    const guest = await client(t.app);
    await addMember(t.owner, team.slug, await signup(guest, 'guest2@orbit.example.com', 'แขก 2'), 'guest');
    const r = await guest.get(`${team.ws}/onboarding`);
    expect(r.status).toBe(403);
    expect((await guest.post(`${team.ws}/onboarding:hide`)).status).toBe(403);
    // คนนอก Workspace ไม่รู้ว่ามี Workspace นี้
    const stranger = await client(t.app);
    await signup(stranger, 'stranger@orbit.example.com', 'คนนอก');
    expect((await stranger.get(`${team.ws}/onboarding`)).status).toBe(404);
  });
});

describe('Workspace เก่า และงานทุกคืน', () => {
  it('Workspace ที่สร้างก่อนเปิดฟีเจอร์และเริ่มใช้จริงแล้วไม่เห็นการ์ด · ยังไม่เริ่มใช้จริงยังเห็น · สมาชิกเก่าไม่เห็นรายการส่วนตัว', async () => {
    const owner = await client(t.app);
    await signup(owner, 'owner@legacy.example.com', 'เจ้าของเก่า');
    expect((await owner.post('/workspaces', { name: 'Legacy', slug: 'legacy-co' })).status).toBe(201);
    const [{ id }] = await q(`UPDATE workspaces SET created_at = '2026-06-01' WHERE slug = 'legacy-co' RETURNING id`);
    expect(await get(owner, '/w/legacy-co')).toMatchObject({ eligible: true });
    // เริ่มใช้จริงแล้ว: สมาชิก 3 คน + งาน 10 งาน (ใส่ตรงในฐานข้อมูล)
    const p = await owner.post('/w/legacy-co/projects', { name: 'งานเดิม', key: 'OLD', startDate: '2026-06-01', goliveDate: '2026-12-31', modules: ['หลัก'] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    await q(`DELETE FROM onboarding_progress WHERE workspace_id = $1`, [id]);
    const old: Client[] = [];
    for (const n of [1, 2]) {
      const c = await client(t.app);
      await addMember(t.owner, 'legacy-co', await signup(c, `m${n}@legacy.example.com`, `สมาชิก ${n}`), 'member');
      old.push(c);
    }
    await q(`UPDATE workspace_members SET joined_at = '2026-06-02' WHERE workspace_id = $1`, [id]);
    await q(
      `INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title)
       SELECT p.workspace_id, p.id, g, (SELECT id FROM issue_types WHERE project_id = p.id LIMIT 1), (SELECT id FROM workflow_statuses WHERE project_id = p.id LIMIT 1), 'งานเดิม ' || g
       FROM projects p, generate_series(1, 10) g WHERE p.workspace_id = $1`,
      [id],
    );
    expect(await get(owner, '/w/legacy-co')).toEqual({ scope: 'workspace', version: 1, eligible: false });
    expect(await get(old[0], '/w/legacy-co')).toEqual({ scope: 'member', version: 1, eligible: false });
    // ไม่บันทึกอะไรของ Workspace เก่า แม้มีเหตุการณ์หรืองานทุกคืน
    await t.app.get(OnboardingService).reconcile();
    expect(await q(`SELECT 1 FROM onboarding_progress WHERE workspace_id = $1`, [id])).toEqual([]);
    // สมาชิกใหม่ที่เข้าร่วมหลังเปิดฟีเจอร์ยังเห็นรายการส่วนตัว
    const fresh = await client(t.app);
    await addMember(t.owner, 'legacy-co', await signup(fresh, 'fresh@legacy.example.com', 'สมาชิกใหม่'), 'member');
    expect(await get(fresh, '/w/legacy-co')).toMatchObject({ scope: 'member', eligible: true, total: 3 });
  });

  it('งานทุกคืนบันทึกขั้นที่ไม่มีเหตุการณ์ (เช่น สร้างโปรเจกต์แล้วไม่กลับมาเปิด Home) พร้อมเวลาที่ทำจริง', async () => {
    const owner = await client(t.app);
    await signup(owner, 'quiet@kanit.example.com', 'เงียบ');
    expect((await owner.post('/workspaces', { name: 'Kanit Labs', slug: 'kanit-labs' })).status).toBe(201);
    const p = await owner.post('/w/kanit-labs/projects', { name: 'แอปสมมติ', key: 'KL', startDate: '2026-11-10', goliveDate: '2026-12-31', modules: ['หลัก'] });
    expect(p.status).toBe(201);
    const [{ id }] = await q(`SELECT id FROM workspaces WHERE slug = 'kanit-labs'`);
    await q(`UPDATE projects SET created_at = '2026-11-10T03:00:00Z' WHERE workspace_id = $1`, [id]);
    expect(await q(`SELECT 1 FROM onboarding_progress WHERE workspace_id = $1`, [id])).toEqual([]);
    const r = await t.app.get(OnboardingService).reconcile();
    expect(r.recorded).toBeGreaterThanOrEqual(1);
    const [row] = await q(`SELECT step, done_at, user_id FROM onboarding_progress WHERE workspace_id = $1`, [id]);
    expect(row).toEqual({ step: 'first_project', done_at: new Date('2026-11-10T03:00:00Z'), user_id: null });
    // Workspace ที่ครบแล้วไม่ถูกตรวจซ้ำ
    expect((await q(`SELECT count(*)::int AS n FROM onboarding_progress WHERE workspace_id = $1`, [wsId]))[0].n).toBeGreaterThanOrEqual(6);
  });
});
