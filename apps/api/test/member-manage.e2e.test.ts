// จัดการสมาชิก Workspace (ผู้ใช้เลือก storyboard 2026-11-16): แก้ตำแหน่ง/แผนก/Capacity และปิดการใช้งานพร้อมส่งต่องานแยกตามโปรเจกต์
// ข้อมูลสมมติทั้งหมด
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type DomainEvent } from '../src/core/events.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let kaijeaw: { c: Client; id: string };
let pond: { c: Client; id: string };
let naa: { c: Client; id: string };
let viewer: { c: Client; id: string };
const events: DomainEvent[] = [];

async function person(name: string) {
  const c = await client(t.app);
  const id = await signup(c, `${name.toLowerCase()}@manage.example.com`, name);
  await addMember(t.owner, team.slug, id, 'member');
  return { c, id };
}
async function join(key: string, userId: string, role: 'admin' | 'member' | 'viewer' = 'member') {
  await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, $2, $3 FROM projects WHERE key = $1`, [key, userId, role]);
}
async function mkProject(key: string) {
  const r = await team.lead.post(`${team.ws}/projects`, { name: `โปรเจกต์ ${key}`, key, startDate: '2026-11-02', goliveDate: '2027-02-26', modules: ['Core'] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; modules: { id: string }[] };
}
async function assigned(key: string, userId: string, title: string, planEnd = '2027-01-20') {
  const detail = (await team.lead.get(`${team.ws}/projects/${key}`)).body;
  const r = await team.lead.post(`${team.ws}/projects/${key}/issues`, { title, moduleId: detail.modules[0].id, assigneeIds: [userId], estimateMd: 2 });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await t.owner.query('UPDATE issues SET plan_end = $2 WHERE id = $1', [r.body.id, planEnd]);
  return r.body as { id: string; key: string };
}
const positionsIn = async (key: string, userId: string) =>
  (await t.owner.query('SELECT pm.positions, pm.position FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.key = $1 AND pm.user_id = $2', [key, userId])).rows[0];
const assigneesOf = async (issueId: string) => (await t.owner.query('SELECT user_id FROM issue_assignees WHERE issue_id = $1 ORDER BY sort', [issueId])).rows.map((r) => r.user_id);

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'manage-ws', key: 'KLX' });
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  t.app.get(EventBus).on('*', (e) => { events.push(e); });
  kaijeaw = await person('Somsak');
  pond = await person('Pond');
  naa = await person('Naa');
  viewer = await person('Viewer');
  await mkProject('KLF');
  await mkProject('OLD');
  for (const key of ['KLX', 'KLF', 'OLD']) await join(key, kaijeaw.id);
  await join('KLX', pond.id);
  await join('KLF', naa.id);
  await join('KLF', viewer.id, 'viewer');
});
afterAll(() => t.close());

describe('แก้ข้อมูลสมาชิกจากหน้า Workspace members', () => {
  it('ตำแหน่งหลายค่า + แผนก + Capacity · ใช้กับโปรเจกต์ที่อยู่ (ไม่รวมที่ Archive)', async () => {
    expect((await team.lead.post(`${team.ws}/projects/OLD/archive`)).status).toBe(200);
    const r = await team.lead.patch(`${team.ws}/members/${kaijeaw.id}`, { positions: ['dev', 'Backend Developer'], applyToProjects: true, department: 'Development', capacityHoursWeek: 32 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ jobTitle: 'DEV, BE', department: 'Development', capacityHoursWeek: 32, projectsUpdated: 2 });
    expect(await positionsIn('KLX', kaijeaw.id)).toEqual({ positions: ['DEV', 'BE'], position: 'DEV, BE' });
    expect(await positionsIn('KLF', kaijeaw.id)).toEqual({ positions: ['DEV', 'BE'], position: 'DEV, BE' });
    expect((await positionsIn('OLD', kaijeaw.id)).positions).toEqual([]);
    const list = (await team.lead.get(`${team.ws}/members`)).body.items.find((m: { userId: string }) => m.userId === kaijeaw.id);
    expect(list).toMatchObject({ jobTitle: 'DEV, BE', department: 'Development', capacityHoursWeek: 32 });
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'member.profile_updated' AND target_id = $1`, [kaijeaw.id]);
    expect(audit.rows[0].summary).toContain('ใช้กับ 2 โปรเจกต์');
  });

  it('ไม่ติ๊กใช้กับโปรเจกต์ = ตำแหน่งในโปรเจกต์คงเดิม · Member แก้ไม่ได้ · ค่าเกินช่วงตอบ 400', async () => {
    const r = await team.lead.patch(`${team.ws}/members/${kaijeaw.id}`, { positions: ['QA'], applyToProjects: false });
    expect(r.body).toMatchObject({ jobTitle: 'QA', projectsUpdated: 0 });
    expect((await positionsIn('KLX', kaijeaw.id)).positions).toEqual(['DEV', 'BE']);
    expect((await team.dev.patch(`${team.ws}/members/${kaijeaw.id}`, { positions: ['PM'] })).status).toBe(403);
    expect((await team.lead.patch(`${team.ws}/members/${kaijeaw.id}`, { capacityHoursWeek: 120 })).status).toBe(400);
  });
});

describe('ปิดการใช้งานพร้อมส่งต่องานแยกตามโปรเจกต์', () => {
  let a1: { id: string; key: string };
  let a2: { id: string; key: string };
  let b1: { id: string; key: string };

  it('handover สรุปตามโปรเจกต์: จำนวน, MD, เลยกำหนด และคนรับงานได้ (ไม่รวม Viewer และตัวเอง)', async () => {
    a1 = await assigned('KLX', kaijeaw.id, 'วางผังชั้น 3', '2026-01-05');
    a2 = await assigned('KLX', kaijeaw.id, 'ตรวจทางหนีไฟ');
    b1 = await assigned('KLF', kaijeaw.id, 'แบบเฟอร์นิเจอร์');
    const r = await team.lead.get(`${team.ws}/members/${kaijeaw.id}/handover`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.assignedIssues.total).toBe(3);
    expect(r.body.overdue).toBe(1);
    const byKey = Object.fromEntries(r.body.projects.map((p: { key: string }) => [p.key, p]));
    expect(byKey.KLX).toMatchObject({ open: 2, md: 4, overdue: 1, canTransfer: true });
    expect(byKey.KLX.items.map((i: { key: string }) => i.key).sort()).toEqual([a1.key, a2.key].sort());
    expect(byKey.KLX.candidates.map((c: { displayName: string }) => c.displayName).sort()).toEqual(['Kaijeaw', 'Mick', 'Pond']);
    expect(byKey.KLF.candidates.map((c: { displayName: string }) => c.displayName)).not.toContain('Viewer');
    expect(byKey.KLF.candidates.map((c: { displayName: string }) => c.displayName)).toContain('Naa');
  });

  it('คนรับงานไม่ได้อยู่ในโปรเจกต์ = 400 และไม่ปิด ไม่ย้ายอะไรเลย', async () => {
    const klf = (await t.owner.query(`SELECT id FROM projects WHERE key = 'KLF'`)).rows[0].id;
    const r = await team.lead.post(`${team.ws}/members/${kaijeaw.id}/deactivate`, { transfers: [{ projectId: klf, to: pond.id }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('reassign_target_invalid');
    expect(await assigneesOf(b1.id)).toEqual([kaijeaw.id]);
    expect((await t.owner.query('SELECT status FROM workspace_members WHERE user_id = $1', [kaijeaw.id])).rows[0].status).toBe('active');
  });

  it('โปรเจกต์หนึ่งโอนให้ Pond อีกโปรเจกต์ไม่ระบุผู้รับผิดชอบ · บันทึก Activity และส่ง Event', async () => {
    const ids = Object.fromEntries((await t.owner.query(`SELECT key, id FROM projects WHERE key IN ('KLX','KLF')`)).rows.map((r) => [r.key, r.id]));
    events.length = 0;
    const r = await team.lead.post(`${team.ws}/members/${kaijeaw.id}/deactivate`, { transfers: [{ projectId: ids.KLX, to: pond.id }, { projectId: ids.KLF, to: null }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('deactivated');
    expect(r.body.transferred).toEqual(expect.arrayContaining([{ projectKey: 'KLX', to: pond.id, count: 2 }, { projectKey: 'KLF', to: null, count: 1 }]));
    expect(await assigneesOf(a1.id)).toEqual([pond.id]);
    expect(await assigneesOf(a2.id)).toEqual([pond.id]);
    expect(await assigneesOf(b1.id)).toEqual([]);
    const act = await t.owner.query(`SELECT count(*)::int AS n FROM activities WHERE field = 'assigneeIds' AND issue_id = ANY($1)`, [[a1.id, a2.id, b1.id]]);
    expect(act.rows[0].n).toBe(3);
    expect(events.filter((e) => e.type === 'issue.assigned').length).toBe(3);
  });
});
