// A41 · ถังขยะ กู้คืนโปรเจกต์ ลบถาวร และ Workspace ที่ลบไว้ · ข้อมูลสมมติเท่านั้น
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { Mailer } from '../src/core/mail.js';
import { LocalStorage } from '../src/files/storage.js';
import { WorkspaceLifecycleService } from '../src/privacy/lifecycle.service.js';
import { TrashPurgeService } from '../src/trash/purge.service.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

const DAY = 86_400_000;
let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsAdmin: Client, projAdmin: Client, guest: Client, outsider: Client;
let wsAdminId: string, projAdminId: string;
let wsId: string, moduleId: string;
let serial = 0;
const events: DomainEvent[] = [];
let mails: { to: string; subject: string; text: string }[] = [];

const trash = (q = '') => `${team.ws}/trash${q}`;
const issueUrl = (key: string) => `${team.ws}/issues/${key}`;
async function mkIssue(extra: Record<string, unknown> = {}, key = 'DP') {
  const module = key === 'DP' ? moduleId : (await team.lead.get(`${team.ws}/projects/${key}`)).body.modules[0].id;
  const r = await team.lead.post(`${team.ws}/projects/${key}/issues`, { title: `งานสมมติ ${++serial}`, moduleId: module, size: 'XS', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; key: string };
}
async function mkProject(key: string, name = `โปรเจกต์ ${key}`) {
  const r = await team.lead.post(`${team.ws}/projects`, { name, key, startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['Web'] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; key: string };
}
async function setPlan(code: string) {
  await team.lead.get(`${team.ws}/usage`);
  await t.owner.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = $2), status = 'active', trial_ends_at = NULL WHERE workspace_id = $1`, [wsId, code]);
}
/** ไฟล์ในโปรเจกต์ + เวอร์ชันที่มีไฟล์จริงในที่เก็บ (ตรวจการคืนพื้นที่) */
async function mkFile(name: string, projectId = team.project.id) {
  const f = (await t.owner.query(`INSERT INTO files (workspace_id, project_id, name, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id`, [wsId, projectId, name, team.leadId])).rows[0].id as string;
  const key = `${wsId}/${projectId}/${f}`;
  const path = new LocalStorage().path(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'เนื้อหาสมมติ');
  const v = (await t.owner.query(`INSERT INTO file_versions (workspace_id, file_id, version_no, storage_key, size_bytes, uploaded_by) VALUES ($1,$2,1,$3,1024,$4) RETURNING id`, [wsId, f, key, team.leadId])).rows[0].id;
  await t.owner.query('UPDATE files SET current_version_id = $2 WHERE id = $1', [f, v]);
  return { id: f, path };
}
const audit = async (action: string) => (await t.owner.query('SELECT * FROM audit_logs WHERE action = $1 ORDER BY created_at', [action])).rows;

beforeAll(async () => {
  process.env.SMTP_HOST = 'smtp.trash-test.example';
  t = await startApp();
  t.app.get(Mailer).transportFactory = () => ({ sendMail: async (m: Record<string, unknown>) => void mails.push(m as (typeof mails)[number]) });
  t.app.get(EventBus).on('*', (e) => void events.push(e));
  team = await seedTeam(t, { slug: 'trash-demo' });
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  moduleId = team.project.modules[0].id;
  wsAdmin = await client(t.app);
  wsAdminId = await signup(wsAdmin, 'admin@trash-demo.example.com', 'ดนัยสมมติ');
  // Admin ของ Workspace ที่เป็นแค่ Member ในโปรเจกต์ (ไม่มี issue.delete / project.trash) · ถังขยะของ Workspace ยังกู้ได้
  await addMember(t.owner, team.slug, wsAdminId, 'admin', { key: 'DP', role: 'member' });
  projAdmin = await client(t.app);
  projAdminId = await signup(projAdmin, 'pm@trash-demo.example.com', 'ปิยะสมมติ');
  await addMember(t.owner, team.slug, projAdminId, 'member', { key: 'DP', role: 'admin' });
  guest = await client(t.app);
  const guestId = await signup(guest, 'guest@trash-demo.example.com', 'ลูกค้าสมมติ');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: 'DP', role: 'viewer' });
  outsider = await client(t.app);
  await signup(outsider, 'outsider@trash-demo.example.com', 'คนนอกสมมติ');
});
afterAll(async () => {
  delete process.env.SMTP_HOST;
  await t.close();
});
beforeEach(() => {
  events.length = 0;
  mails = [];
});

describe('สิทธิ์ดูถังขยะ', () => {
  it('ระดับ Workspace: Owner / Admin เท่านั้น · ระดับโปรเจกต์: สิทธิ์ project.trash (Project Admin) · Guest ไม่ได้', async () => {
    expect((await team.lead.get(trash())).status).toBe(200);
    expect((await wsAdmin.get(trash())).status).toBe(200);
    for (const c of [team.dev, projAdmin, guest]) expect((await c.get(trash())).status).toBe(403);
    expect((await outsider.get(trash())).status).toBe(404);

    const p = `${team.ws}/projects/DP/trash`;
    expect((await projAdmin.get(p)).status).toBe(200);
    expect((await team.lead.get(p)).status).toBe(200);
    for (const c of [team.dev, wsAdmin, guest]) expect((await c.get(p)).status).toBe(403);
    expect((await projAdmin.get(`${p}?type=project`)).status).toBe(400);
    const empty = (await team.lead.get(trash('?type=project'))).body;
    expect(empty).toMatchObject({ type: 'project', trashDays: 30, counts: { project: 0, issue: 0, file: 0 }, items: [], batches: [], nextCursor: null, can: { restore: true, purge: true } });
    expect((await wsAdmin.get(trash())).body.can.purge).toBe(false);
  });
});

describe('งานในถังขยะ · ชุด · กู้คืน', () => {
  let parent: { id: string; key: string }, a: { id: string; key: string }, b: { id: string; key: string }, c: { id: string; key: string }, d: { id: string; key: string };
  let subs: { id: string; key: string }[];

  it('แสดงเฉพาะรากของการลบ พร้อมจำนวน Sub-task ผู้ลบ วันลบถาวร และจัดชุดงานที่คนเดียวกันลบภายใน 2 นาที', async () => {
    parent = await mkIssue({ title: 'ออกแบบหน้าชำระเงิน' });
    subs = [await mkIssue({ parentKey: parent.key }), await mkIssue({ parentKey: parent.key })];
    a = await mkIssue({ title: 'เชื่อม API ธนาคาร' });
    b = await mkIssue({ title: 'ทดสอบการคืนเงิน' });
    c = await mkIssue({ title: 'งานที่ PM ลบ' });
    d = await mkIssue({ title: 'งานที่ลบไว้นานแล้ว' });
    for (const x of [parent, a, b]) expect((await team.lead.delete(issueUrl(x.key))).status).toBe(200);
    expect((await projAdmin.delete(issueUrl(c.key))).status).toBe(200);
    expect((await team.lead.delete(issueUrl(d.key))).status).toBe(200);
    // d ลบก่อนหน้า 10 นาที → ไม่อยู่ในชุดเดียวกัน
    await t.owner.query(`UPDATE issues SET deleted_at = deleted_at - interval '10 minutes' WHERE id = $1`, [d.id]);

    const r = await team.lead.get(trash('?type=issue'));
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ project: 0, issue: 5, file: 0 });
    expect(r.body.items.map((i: { key: string }) => i.key).sort()).toEqual([parent.key, a.key, b.key, c.key, d.key].sort());
    const row = r.body.items.find((i: { key: string }) => i.key === parent.key);
    expect(row).toMatchObject({ type: 'issue', title: 'ออกแบบหน้าชำระเงิน', subtasks: 2, project: { key: 'DP' }, deletedBy: { id: team.leadId, displayName: 'Mick', role: 'owner' }, daysLeft: 30 });
    expect(Date.parse(row.purgeAt) - Date.parse(row.deletedAt)).toBe(30 * DAY);
    expect(r.body.items.find((i: { key: string }) => i.key === c.key).deletedBy).toMatchObject({ id: projAdminId, role: 'member' });
    expect(r.body.batches).toHaveLength(1);
    expect(r.body.batches[0]).toMatchObject({ count: 3, subtasks: 2, deletedBy: { id: team.leadId }, projects: [{ key: 'DP' }] });
    expect(r.body.batches[0].ids.sort()).toEqual([parent.id, a.id, b.id].sort());
    expect(row.batchId).toBe(r.body.batches[0].id);
    expect(r.body.items.find((i: { key: string }) => i.key === d.key).batchId).toBeNull();
    // ชุดนับจากงานทั้งหมดในถังขยะ ไม่ใช่แค่แถวในหน้า: หน้าละ 2 แถว (c ของ PM + งานล่าสุดของชุด) ยังเห็นชุดครบ 3 งาน
    const small = await team.lead.get(trash('?type=issue&limit=2'));
    expect(small.body.items.map((i: { key: string }) => i.key)).toEqual([c.key, b.key]);
    expect(small.body.batches).toHaveLength(1);
    expect(small.body.batches[0]).toMatchObject({ id: r.body.batches[0].id, count: 3 });
    expect(small.body.batches[0].ids.sort()).toEqual([parent.id, a.id, b.id].sort());
    expect(r.body.deleters.map((p: { id: string }) => p.id).sort()).toEqual([team.leadId, projAdminId].sort());
    expect(r.body.projects).toEqual([expect.objectContaining({ key: 'DP' })]);
  });

  it('กรองผู้ลบ / ค้นด้วยชื่อหรือเลขงาน / แบ่งหน้าด้วย cursor', async () => {
    const byPm = (await team.lead.get(trash(`?type=issue&deletedBy=${projAdminId}`))).body;
    expect(byPm.items.map((i: { key: string }) => i.key)).toEqual([c.key]);
    expect((await team.lead.get(trash(`?q=${encodeURIComponent('ธนาคาร')}`))).body.items.map((i: { key: string }) => i.key)).toEqual([a.key]);
    expect((await team.lead.get(trash(`?q=${b.key.toLowerCase()}`))).body.items.map((i: { key: string }) => i.key)).toEqual([b.key]);
    expect((await team.lead.get(trash('?project=DP'))).body.counts.issue).toBe(5);
    expect((await team.lead.get(trash('?project=NOPE'))).status).toBe(404);
    const first = (await team.lead.get(trash('?limit=2'))).body;
    expect(first.items).toHaveLength(2);
    const second = (await team.lead.get(trash(`?limit=2&cursor=${first.nextCursor}`))).body;
    const third = (await team.lead.get(trash(`?limit=2&cursor=${second.nextCursor}`))).body;
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((i: { id: string }) => i.id).sort()).toEqual([parent, a, b, c, d].map((x) => x.id).sort());
    expect((await team.lead.get(trash('?cursor=bad'))).status).toBe(400);
  });

  it('Admin ของ Workspace กู้ทั้งชุดได้แม้ไม่ใช่ Admin ของโปรเจกต์ · Sub-task กลับมาพร้อมแม่', async () => {
    const r = await wsAdmin.post(trash('/issue:restore'), { ids: [parent.id, a.id, b.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.failed).toEqual([]);
    expect(r.body.restored.map((x: { key: string }) => x.key).sort()).toEqual([parent.key, a.key, b.key].sort());
    for (const x of [parent, a, b, ...subs]) expect((await team.lead.get(issueUrl(x.key))).status).toBe(200);
    expect((await audit('issue.restored')).filter((x) => x.actor_id === wsAdminId)).toHaveLength(3);
    expect(events.filter((e) => e.type === 'issue.updated').length).toBe(5);
    // สมาชิกธรรมดากู้ผ่านทางนี้ไม่ได้
    const denied = await team.dev.post(trash('/issue/restore'), { ids: [c.id] });
    expect(denied.status).toBe(403);
  });

  it('ถังขยะของโปรเจกต์: Project Admin เห็นและกู้คืนได้ · ไม่มีปุ่มลบถาวร · หลายงานตอบรายงานรายงาน', async () => {
    const p = (await projAdmin.get(`${team.ws}/projects/DP/trash`)).body;
    expect(p.project).toMatchObject({ key: 'DP' });
    expect(p.counts).toEqual({ issue: 2, file: 0 });
    expect(p.can).toEqual({ restore: true, purge: false });
    const r = await projAdmin.post(trash('/issue:restore'), { ids: [c.id, '00000000-0000-4000-8000-000000000000'] });
    expect(r.status).toBe(200);
    expect(r.body.restored.map((x: { key: string }) => x.key)).toEqual([c.key]);
    expect(r.body.failed).toEqual([expect.objectContaining({ code: 'not_found' })]);
  });

  it('ใช้ trash_days ของ Workspace (90 วัน) กับงานด้วย · เลยกำหนดไม่แสดงและกู้ไม่ได้', async () => {
    await t.owner.query('UPDATE workspace_settings SET trash_days = 90 WHERE workspace_id = $1', [wsId]);
    const e = await mkIssue();
    const del = await team.lead.delete(issueUrl(e.key));
    expect(Date.parse(del.body.restorableUntil) - Date.parse(del.body.deletedAt)).toBe(90 * DAY);
    const list = (await team.lead.get(trash())).body;
    expect(list.trashDays).toBe(90);
    expect(list.items.find((i: { key: string }) => i.key === e.key).daysLeft).toBe(90);
    // 31 วันยังอยู่ (90 วัน) · 91 วันหายและกู้ไม่ได้
    await t.owner.query(`UPDATE issues SET deleted_at = now() - interval '31 days' WHERE id = $1`, [d.id]);
    expect((await team.lead.post(trash('/issue:restore'), { ids: [d.id] })).status).toBe(200);
    await team.lead.delete(issueUrl(d.key));
    await t.owner.query(`UPDATE issues SET deleted_at = now() - interval '91 days' WHERE id = $1`, [d.id]);
    expect((await team.lead.get(trash())).body.items.map((i: { key: string }) => i.key)).not.toContain(d.key);
    const late = await team.lead.post(trash('/issue:restore'), { ids: [d.id] });
    expect(late.status).toBe(410);
    expect(late.body.error).toMatchObject({ code: 'restore_expired', message: 'เกินกำหนดกู้คืน 90 วันแล้ว' });
    await t.owner.query('UPDATE workspace_settings SET trash_days = 30 WHERE workspace_id = $1', [wsId]);
  });
});

describe('ไฟล์ในถังขยะ', () => {
  it('แสดงขนาดและโฟลเดอร์ · กู้คืนกลับที่เดิม · สมาชิกไม่มีสิทธิ์', async () => {
    const f = await mkFile('สเปกสมมติ.pdf');
    const folder = (await t.owner.query(`INSERT INTO folders (workspace_id, project_id, name) VALUES ($1,$2,'Assets') RETURNING id`, [wsId, team.project.id])).rows[0].id;
    await t.owner.query('UPDATE files SET folder_id = $2 WHERE id = $1', [f.id, folder]);
    expect((await team.lead.delete(`${team.ws}/projects/DP/files/${f.id}`, {})).status).toBe(200);
    const list = (await team.lead.get(trash('?type=file'))).body;
    expect(list.items).toEqual([expect.objectContaining({ type: 'file', id: f.id, name: 'สเปกสมมติ.pdf', sizeBytes: 1024, folder: 'Assets', project: expect.objectContaining({ key: 'DP' }), deletedBy: expect.objectContaining({ id: team.leadId }) })]);
    expect((await team.dev.post(trash('/file:restore'), { ids: [f.id] })).status).toBe(403);
    const r = await wsAdmin.post(trash('/file:restore'), { ids: [f.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await t.owner.query('SELECT deleted_at, deleted_by, folder_id FROM files WHERE id = $1', [f.id])).rows[0];
    expect(row).toEqual({ deleted_at: null, deleted_by: null, folder_id: folder });
  });
});

describe('กู้คืนโปรเจกต์ (Z2)', () => {
  let mkt: { id: string; key: string };

  it('Key ของโปรเจกต์ในถังขยะใช้ซ้ำได้ · กู้คืนแล้วชนตอบ 409 project_key_taken พร้อม Key ที่แนะนำ', async () => {
    mkt = await mkProject('MKT', 'Marketing Site 2026');
    await mkIssue({ title: 'หน้าแรกสมมติ' }, 'MKT');
    expect((await team.lead.delete(`${team.ws}/projects/MKT`, { confirmKey: 'MKT' })).status).toBe(200);
    expect((await team.lead.get(`${team.ws}/projects/key-available?key=MKT`)).body.available).toBe(true);
    await mkProject('MKT', 'Marketing 2027');
    expect((await team.lead.get(`${team.ws}/projects/MKT`)).body.name).toBe('Marketing 2027');

    const list = (await wsAdmin.get(trash('?type=project'))).body;
    expect(list.counts.project).toBe(1);
    expect(list.items[0]).toMatchObject({ type: 'project', id: mkt.id, key: 'MKT', name: 'Marketing Site 2026', counts: { issues: 1, files: 0, members: 1 }, keyTaken: { key: 'MKT', name: 'Marketing 2027' }, deletedBy: { id: team.leadId } });

    const taken = await wsAdmin.post(trash(`/project/${mkt.id}:restore`), {});
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: 'project_key_taken', details: { key: 'MKT', suggestedKey: 'MKT2', takenBy: { key: 'MKT', name: 'Marketing 2027' } } });
    const same = await wsAdmin.post(trash(`/project/${mkt.id}:restore`), { newKey: 'DP' });
    expect(same.body.error).toMatchObject({ code: 'key_taken', details: { key: 'DP' } });
    expect((await wsAdmin.post(trash(`/project/${mkt.id}:restore`), { newKey: 'x' })).status).toBe(400);
  });

  it('สิทธิ์เท่าการลบ · ส่ง Key ใหม่แล้วกู้คืนพร้อมงาน · Key เดิมเป็น alias · Audit + event', async () => {
    // มองไม่เห็นโปรเจกต์ Private ที่ไม่ได้เป็นสมาชิก (RLS) → 404 เหมือนไม่มี
    expect((await team.dev.post(trash(`/project/${mkt.id}/restore`), { newKey: 'MKS' })).status).toBe(404);
    const r = await wsAdmin.post(trash(`/project/${mkt.id}:restore`), { newKey: 'mks' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id: mkt.id, key: 'MKS', oldKey: 'MKT', name: 'Marketing Site 2026', restored: true });
    expect((await team.lead.get(`${team.ws}/projects/MKS`)).status).toBe(200);
    expect((await team.lead.get(issueUrl('MKS-1'))).body.title).toBe('หน้าแรกสมมติ');
    expect((await t.owner.query('SELECT project_id FROM project_key_aliases WHERE old_key = $1', ['MKT'])).rows).toEqual([{ project_id: mkt.id }]);
    expect((await t.owner.query('SELECT deleted_by FROM projects WHERE id = $1', [mkt.id])).rows[0].deleted_by).toBeNull();
    expect((await audit('project.restored_from_trash'))[0]).toMatchObject({ actor_id: wsAdminId, target_id: mkt.id, summary: 'MKS · Marketing Site 2026' });
    expect(events.find((e) => e.type === 'project.restored_from_trash')).toMatchObject({ projectId: mkt.id, data: { projectKey: 'MKS', oldKey: 'MKT' } });
    expect((await wsAdmin.post(trash(`/project/${mkt.id}:restore`), {})).body.error.code).toBe('not_deleted');
    // ยกเลิก Archive ของเดิมยังเป็นคนละเส้นทาง
    expect((await team.lead.post(`${team.ws}/projects/MKS/restore`)).body.error.code).toBe('not_archived');
  });

  it('เกินแพ็กเกจตอบ 402 ก่อนกู้ ไม่กู้บางส่วน · โปรเจกต์ที่ Archive กู้ได้เพราะไม่นับ · Project Owner กู้เองได้', async () => {
    const old = await mkProject('OLD');
    await team.lead.delete(`${team.ws}/projects/OLD`, { confirmKey: 'OLD' });
    await setPlan('free'); // 3 โปรเจกต์: DP, MKT, MKS
    const r = await team.lead.post(trash(`/project/${old.id}:restore`), {});
    expect(r.status).toBe(402);
    expect(r.body.error).toMatchObject({ code: 'plan_limit_reached', details: { kind: 'projects', limit: 3, exits: ['archive_project', 'upgrade'] } });
    expect((await t.owner.query('SELECT deleted_at FROM projects WHERE id = $1', [old.id])).rows[0].deleted_at).not.toBeNull();
    await t.owner.query('UPDATE projects SET archived_at = now(), status = $2 WHERE id = $1', [old.id, 'archived']);
    expect((await team.lead.post(trash(`/project/${old.id}:restore`), {})).status).toBe(200);
    await setPlan('team_s');

    // Project Owner ที่เป็นแค่สมาชิกของ Workspace · สมาชิกอื่นเห็นโปรเจกต์ (เปิดทั้ง Workspace) แต่กู้ไม่ได้
    const own = (await projAdmin.post(`${team.ws}/projects`, { name: 'ของ PM', key: 'PMO', startDate: '2026-11-05', goliveDate: '2027-04-21', visibility: 'workspace' })).body;
    await projAdmin.delete(`${team.ws}/projects/PMO`, { confirmKey: 'PMO' });
    expect((await team.dev.post(trash(`/project/${own.id}:restore`), {})).status).toBe(403);
    expect((await projAdmin.post(trash(`/project/${own.id}:restore`), {})).status).toBe(200);
  });
});

describe('ลบถาวร (Z3)', () => {
  it('Owner เท่านั้น · ต้องพิมพ์ "ลบถาวร" · ลบงานพร้อม Sub-task · คืนพื้นที่ไฟล์ · Audit + event', async () => {
    const root = await mkIssue({ title: 'ข้อมูลส่วนบุคคลที่ใส่ผิด' });
    const sub = await mkIssue({ parentKey: root.key });
    await team.lead.delete(issueUrl(root.key));
    expect((await wsAdmin.delete(trash(`/issue/${root.id}`), { confirm: 'ลบถาวร' })).status).toBe(403);
    const bad = await team.lead.delete(trash(`/issue/${root.id}`), { confirm: 'ลบ' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('confirm_required');
    const live = await mkIssue();
    expect((await team.lead.delete(trash(`/issue/${live.id}`), { confirm: 'ลบถาวร' })).status).toBe(404);
    expect((await team.lead.delete(trash(`/nope/${root.id}`), { confirm: 'ลบถาวร' })).status).toBe(400);

    const r = await team.lead.delete(trash(`/issue/${root.id}`), { confirm: 'ลบถาวร' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ purged: 1, type: 'issue', items: [{ id: root.id, label: root.key }] });
    expect((await t.owner.query('SELECT count(*)::int AS n FROM issues WHERE id = ANY($1)', [[root.id, sub.id]])).rows[0].n).toBe(0);
    expect((await audit('trash.purged')).at(-1)).toMatchObject({ actor_id: team.leadId, target_type: 'issue', summary: `ลบถาวรงาน 1 รายการ: ${root.key}` });
    expect(events.find((e) => e.type === 'trash.purged')).toMatchObject({ actorId: team.leadId, data: { source: 'user', type: 'issue', count: 1 } });

    const f1 = await mkFile('ไฟล์ใหญ่สมมติ.zip');
    const f2 = await mkFile('ไฟล์ซ้ำสมมติ.zip');
    for (const f of [f1, f2]) await team.lead.delete(`${team.ws}/projects/DP/files/${f.id}`, {});
    const many = await team.lead.post(trash('/file:purge'), { ids: [f1.id, f2.id], confirm: 'ลบถาวร' });
    expect(many.status, JSON.stringify(many.body)).toBe(200);
    expect(many.body.purged).toBe(2);
    expect(existsSync(f1.path) || existsSync(f2.path)).toBe(false);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM file_versions WHERE file_id = ANY($1)', [[f1.id, f2.id]])).rows[0].n).toBe(0);
  });

  it('ลบโปรเจกต์ถาวรพร้อมงานและไฟล์ในที่เก็บ', async () => {
    const p = await mkProject('GONE');
    await mkIssue({}, 'GONE');
    const f = await mkFile('ของโปรเจกต์สมมติ.png', p.id);
    await team.lead.delete(`${team.ws}/projects/GONE`, { confirmKey: 'GONE' });
    const r = await team.lead.delete(trash(`/project/${p.id}`), { confirm: 'ลบถาวร' });
    expect(r.status).toBe(200);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM issues WHERE project_id = $1', [p.id])).rows[0].n).toBe(0);
    expect(existsSync(f.path)).toBe(false);
  });
});

describe('งานเบื้องหลัง trash.purge', () => {
  it('ลบถาวรเฉพาะที่พ้น trash_days ของแต่ละ Workspace · Audit 1 แถวต่อ Workspace · event trash.purged', async () => {
    const oldIssue = await mkIssue();
    const freshIssue = await mkIssue();
    const oldProject = await mkProject('AGED');
    const oldFile = await mkFile('เก่าสมมติ.txt');
    await team.lead.delete(issueUrl(oldIssue.key));
    await team.lead.delete(issueUrl(freshIssue.key));
    await team.lead.delete(`${team.ws}/projects/AGED`, { confirmKey: 'AGED' });
    await team.lead.delete(`${team.ws}/projects/DP/files/${oldFile.id}`, {});
    await t.owner.query(`UPDATE issues SET deleted_at = now() - interval '31 days' WHERE id = $1`, [oldIssue.id]);
    await t.owner.query(`UPDATE issues SET deleted_at = now() - interval '29 days' WHERE id = $1`, [freshIssue.id]);
    await t.owner.query(`UPDATE projects SET deleted_at = now() - interval '31 days' WHERE id = $1`, [oldProject.id]);
    await t.owner.query(`UPDATE files SET deleted_at = now() - interval '31 days' WHERE id = $1`, [oldFile.id]);
    const before = (await audit('trash.purged')).length;

    const r = await t.app.get(TrashPurgeService).purge();
    expect(r).toMatchObject({ workspaces: 1, projects: 1, files: 1 });
    expect(r.issues).toBeGreaterThanOrEqual(1);
    expect((await t.owner.query('SELECT id FROM issues WHERE id = ANY($1)', [[oldIssue.id, freshIssue.id]])).rows).toEqual([{ id: freshIssue.id }]);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM projects WHERE id = $1', [oldProject.id])).rows[0].n).toBe(0);
    expect(existsSync(oldFile.path)).toBe(false);
    const rows = (await audit('trash.purged')).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: 'system', actor_id: null, workspace_id: wsId });
    expect(rows[0].summary).toContain('AGED');
    expect(events.find((e) => e.type === 'trash.purged')).toMatchObject({ workspaceId: wsId, actorId: null, data: { source: 'schedule', projects: 1, files: 1 } });
    // รอบถัดไปไม่มีอะไรให้ลบ
    expect(await t.app.get(TrashPurgeService).purge()).toEqual({ workspaces: 0, issues: 0, projects: 0, files: 0 });
  });
});

describe('Workspace ที่ลบไว้ (Z5) · purge_after · อีเมลเตือน', () => {
  let other: Awaited<ReturnType<typeof seedTeam>>;
  let otherId: string;

  beforeAll(async () => {
    other = await seedTeam(t, { slug: 'old-orbit', key: 'OA' });
    otherId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [other.slug])).rows[0].id;
    await other.lead.get(`${other.ws}/usage`);
    await t.owner.query(`UPDATE subscriptions SET status = 'canceled', current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 day' WHERE workspace_id = $1`, [otherId]);
  });

  it('ลบแล้วได้ผู้ลบและ purge_after · สมาชิกเห็นหน้า Z5 (ติดต่อ Owner) · Owner กู้คืนได้ · คนนอก 404', async () => {
    const del = await other.lead.delete(other.ws, { confirmSlug: other.slug });
    expect(del.status).toBe(200);
    const row = (await t.owner.query('SELECT deleted_by, purge_after, deleted_at FROM workspaces WHERE id = $1', [otherId])).rows[0];
    expect(row.deleted_by).toBe(other.leadId);
    expect(new Date(row.purge_after).getTime() - new Date(row.deleted_at).getTime()).toBe(30 * DAY);
    expect(Date.parse(del.body.restorableUntil)).toBe(new Date(row.purge_after).getTime());

    const mine = (await other.lead.get(`/workspaces/${other.slug}/deleted`)).body;
    expect(mine).toMatchObject({ slug: other.slug, name: 'Friday', daysLeft: 30, deletedBy: { displayName: 'Mick', role: 'owner' }, counts: { projects: 1, members: 2 }, plan: { code: 'free', status: 'canceled' }, myRole: 'owner', can: { restore: true, export: true } });
    const member = (await other.dev.get(`/workspaces/${other.slug}/deleted`)).body;
    expect(member).toMatchObject({ myRole: 'member', can: { restore: false, export: false }, owners: [{ displayName: 'Mick', email: `lead@${other.slug}.example.com` }] });
    expect((await outsider.get(`/workspaces/${other.slug}/deleted`)).status).toBe(404);
    expect((await team.lead.get(`/workspaces/${team.slug}/deleted`)).status).toBe(404);
    expect((await other.lead.get('/workspaces/deleted')).body.items).toEqual([expect.objectContaining({ slug: other.slug, daysLeft: 30 })]);
  });

  it('Owner ส่งออกข้อมูลระหว่างรอลบถาวรได้ (ไม่ปนข้อมูล Workspace อื่น) · สมาชิกไม่ได้', async () => {
    expect((await other.dev.post(`/workspaces/${other.slug}/deleted/exports`)).status).toBe(403);
    const r = await other.lead.post(`/workspaces/${other.slug}/deleted/exports`);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const list = (await other.lead.get(`/workspaces/${other.slug}/deleted/exports`)).body;
    expect(list.items[0]).toMatchObject({ id: r.body.id, status: 'ready' });
    const zip = await other.lead.agent.get(`/api/v1/workspaces/${other.slug}/deleted/exports/${r.body.id}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const text = (zip.body as Buffer).toString('latin1');
    expect(text).toContain('projects/OA/');
    expect(text).not.toContain('projects/DP/');
  });

  it('เตือน Owner 7 วันและ 1 วันก่อนลบถาวร ไม่ส่งซ้ำ · ยืดเวลาแล้วรอบเตือนเลื่อนตาม', async () => {
    const svc = t.app.get(WorkspaceLifecycleService);
    const purgeAfter = new Date((await t.owner.query('SELECT purge_after FROM workspaces WHERE id = $1', [otherId])).rows[0].purge_after);
    expect((await svc.remind(new Date(purgeAfter.getTime() - 8 * DAY))).reminded).toBe(0);
    expect((await svc.remind(new Date(purgeAfter.getTime() - 6 * DAY))).reminded).toBe(1);
    expect(mails).toEqual([expect.objectContaining({ to: `lead@${other.slug}.example.com`, subject: 'Friday จะถูกลบถาวรใน 6 วัน' })]);
    expect(mails[0]!.text).toContain(`/work/${other.slug}`);
    expect((await svc.remind(new Date(purgeAfter.getTime() - 5 * DAY))).reminded).toBe(0);
    expect((await svc.remind(new Date(purgeAfter.getTime() - 0.5 * DAY))).reminded).toBe(1);
    expect(mails[1]!.subject).toBe('Friday จะถูกลบถาวรใน 1 วัน');
    expect((await svc.remind(new Date(purgeAfter.getTime() - 0.4 * DAY))).reminded).toBe(0);
    expect((await audit('workspace.purge_reminded')).filter((x) => x.workspace_id === otherId)).toHaveLength(2);

    // ทีม Friday ยืดออกไป 14 วัน (O31) → ยังไม่ลบ และรอบ 7 วันมาใหม่
    await t.owner.query(`UPDATE workspaces SET purge_after = purge_after + interval '14 days' WHERE id = $1`, [otherId]);
    expect((await svc.purge(new Date(purgeAfter.getTime() + DAY))).purged).toBe(0);
    expect((await svc.remind(new Date(purgeAfter.getTime() + 8 * DAY))).reminded).toBe(1);
  });

  it('พ้น purge_after แล้วกู้ไม่ได้และงานเบื้องหลังลบถาวร', async () => {
    await t.owner.query(`UPDATE workspaces SET purge_after = now() - interval '1 hour' WHERE id = $1`, [otherId]);
    expect((await other.lead.get(`/workspaces/${other.slug}/deleted`)).body.can).toEqual({ restore: false, export: false });
    const late = await other.lead.post(`/workspaces/${other.slug}/restore`);
    expect(late.status).toBe(410);
    expect((await t.app.get(WorkspaceLifecycleService).purge()).purged).toBe(1);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM workspaces WHERE id = $1', [otherId])).rows[0].n).toBe(0);
  });
});
