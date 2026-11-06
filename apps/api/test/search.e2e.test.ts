// A22 · ค้นหา, การค้นหาที่บันทึก และ View ที่บันทึก · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let guestId: string;
let wsId: string;
let projectId: string;
let moduleId: string;
const ids: Record<string, { id: string; key: string }> = {};

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  guest = await client(t.app);
  guestId = await signup(guest, 'guest@search.example.com', 'Guest');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });

  const make = async (name: string, title: string, o: { description?: string; shared?: boolean; end?: string; type?: string } = {}) => {
    const r = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title, moduleId, ...(o.type ? { type: o.type } : {}) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await t.owner.query('UPDATE issues SET description = $2, shared_with_guests = $3, plan_end = $4 WHERE id = $1', [r.body.id, o.description ?? null, o.shared ?? false, o.end ?? null]);
    ids[name] = r.body;
  };
  await make('thai', 'ระบบชำระเงินผ่านบัตร', { end: '2026-12-10', shared: true });
  await make('desc', 'งานทั่วไป', { description: 'ต้องรองรับการคำนวณวงเงินตามสัดส่วนหลักประกัน', end: '2026-12-05' });
  await make('secret', 'งานภายในเรื่องวงเงินลับ', { shared: false });
  await make('english', 'Payment gateway integration', { shared: true, end: '2026-12-01' });
  await make('percent', '100% coverage_report');
  await t.owner.query(`INSERT INTO comments (workspace_id, issue_id, author_id, body) VALUES ($1,$2,$3,'คอมเมนต์เรื่องวงเงินที่ BA ยืนยันแล้ว')`, [wsId, ids.thai.id, team.devId]);
  await t.owner.query(`INSERT INTO files (workspace_id, project_id, name, uploaded_by) VALUES ($1,$2,'สเปกวงเงิน.pdf',$3)`, [wsId, projectId, team.leadId]);
});
afterAll(() => t.close());

const search = (qs: string, c: Client = team.lead) => c.get(`${team.ws}/search?${qs}`);
const titles = (r: { body: { items: Array<Record<string, unknown>> } }) => r.body.items.map((i) => (i.title ?? i.name ?? i.displayName ?? i.issueTitle) as string);

describe('GET w/search', () => {
  it('คำค้นภาษาไทย 3 ตัวอักษร ค้นชื่อ รายละเอียด คอมเมนต์ และชื่อไฟล์', async () => {
    const r = await search(`q=${encodeURIComponent('วงเงิน')}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.counts).toMatchObject({ task: 2, comment: 1, file: 1, bug: 0, project: 0, person: 0 });
    expect(r.body.total).toBe(4);
    const byType = (type: string) => r.body.items.filter((i: { type: string }) => i.type === type);
    expect(byType('task').map((i: { title: string }) => i.title).sort()).toEqual(['งานทั่วไป', 'งานภายในเรื่องวงเงินลับ']);
    expect(byType('task').find((i: { title: string }) => i.title === 'งานทั่วไป')).toMatchObject({ matchedIn: 'description', snippet: expect.stringContaining('วงเงิน'), project: { key: team.key } });
    expect(byType('comment')[0]).toMatchObject({ issueKey: ids.thai.key, snippet: expect.stringContaining('วงเงิน') });
    expect(byType('file')[0]).toMatchObject({ name: 'สเปกวงเงิน.pdf' });
    // ตรงที่ชื่อมาก่อนตรงที่รายละเอียด
    expect(r.body.items[0].title).toBe('งานภายในเรื่องวงเงินลับ');
  });

  it('Issue key (#DP-39) ตรงตัวมาก่อน · ไม่สนตัวพิมพ์ · ไม่มี # ก็ได้', async () => {
    for (const q of [`%23${ids.english.key}`, ids.english.key.toLowerCase()]) {
      const r = await search(`q=${q}`);
      expect(r.body.items[0]).toMatchObject({ type: 'task', key: ids.english.key, title: 'Payment gateway integration' });
    }
    expect((await search('q=%23ZZ-999')).body.items).toEqual([]);
  });

  it('@ชื่อ ค้นคน · ค้นโปรเจกต์ด้วยชื่อ/Key · ตัวกรอง type และ project', async () => {
    const people = await search(`q=${encodeURIComponent('@Kai')}`);
    expect(people.body.items).toMatchObject([{ type: 'person', displayName: 'Kaijeaw', initials: 'KA' }]);
    expect(JSON.stringify(people.body)).not.toContain('Guest');
    const project = await search('q=Development');
    expect(project.body.items[0]).toMatchObject({ type: 'project', key: team.key, name: 'Development Plan', archived: false });
    expect((await search(`q=${encodeURIComponent('วงเงิน')}&type=file`)).body.items).toHaveLength(1);
    expect(titles(await search(`q=${encodeURIComponent('วงเงิน')}&type=task&project=dp`))).toHaveLength(2);
    expect((await search('q=x&project=NOPE')).status).toBe(404);
    expect((await search('q=x&type=video')).status).toBe(400);
  });

  it('limit (Command palette ใช้ 8) · เรียงตามวันอัปเดต / Due · อักขระพิเศษของ LIKE ถูกมองเป็นตัวอักษรธรรมดา', async () => {
    expect((await search('q=a&limit=2')).body.items).toHaveLength(2);
    const byDue = await search('q=e&type=task&sort=due');
    const ends = byDue.body.items.map((i: { planEnd: string | null }) => i.planEnd ?? '9999');
    expect([...ends].sort()).toEqual(ends);
    expect(titles(await search('q=100%25'))).toEqual(['100% coverage_report']);
    expect(titles(await search('q=coverage_r'))).toEqual(['100% coverage_report']);
    expect((await search('q=%25')).body.total).toBe(1);
    expect((await search('q=')).status).toBe(400);
    expect((await search('q=a&limit=500')).status).toBe(400);
  });

  it('Guest เห็นเฉพาะงานที่แชร์ · ไม่เห็นคอมเมนต์ ไฟล์ และรายชื่อคน', async () => {
    const r = await search(`q=${encodeURIComponent('วงเงิน')}`, guest);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    const shared = await search('q=Payment', guest);
    expect(titles(shared)).toEqual(['Payment gateway integration']);
    const thai = await search(`q=${encodeURIComponent('ระบบ')}`, guest);
    expect(titles(thai)).toEqual(['ระบบชำระเงินผ่านบัตร']);
    expect(thai.body.counts).toMatchObject({ comment: 0, file: 0, person: 0 });
    expect((await search('q=Kai', guest)).body.items.filter((i: { type: string }) => i.type === 'person')).toEqual([]);
    expect((await search(`q=${encodeURIComponent('@Kai')}`, guest)).body.items).toEqual([]);
  });

  it('โปรเจกต์ที่ Archive ไม่รวมจนกว่าจะขอ · โปรเจกต์ Private ที่ไม่ได้เป็นสมาชิกไม่โผล่', async () => {
    const mk = async (key: string, visibility: string) => {
      const r = await team.lead.post(`${team.ws}/projects`, { key, name: `ลับ ${key}`, startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['M'], sprintLengthWeeks: null, visibility });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return key;
    };
    await mk('SA1', 'workspace');
    await mk('SP1', 'private');
    expect((await search(`q=${encodeURIComponent('ลับ SA1')}&type=project`)).body.total).toBe(1);
    expect((await search(`q=${encodeURIComponent('ลับ SP1')}&type=project`, team.dev)).body.total).toBe(0);
    await t.owner.query(`UPDATE projects SET archived_at = now(), status = 'archived' WHERE key = 'SA1'`);
    expect((await search(`q=${encodeURIComponent('ลับ SA1')}&type=project`)).body.total).toBe(0);
    const withArchived = await search(`q=${encodeURIComponent('ลับ SA1')}&type=project&archived=true`);
    expect(withArchived.body.items).toMatchObject([{ key: 'SA1', archived: true }]);
  });

  it('งานที่ลบแล้วไม่ขึ้น', async () => {
    await t.owner.query('UPDATE issues SET deleted_at = now() WHERE id = $1', [ids.english.id]);
    expect((await search('q=Payment')).body.total).toBe(0);
  });
});

describe('saved-searches', () => {
  let id = '';
  it('CRUD เฉพาะของตัวเอง', async () => {
    const created = await team.lead.post(`${team.ws}/saved-searches`, { name: 'Bug ที่ยังเปิด', query: 'bug', filters: { type: 'bug', archived: false } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'Bug ที่ยังเปิด', query: 'bug', filters: { type: 'bug', archived: false } });
    id = created.body.id;
    expect((await team.lead.get(`${team.ws}/saved-searches`)).body.items).toHaveLength(1);
    expect((await team.dev.get(`${team.ws}/saved-searches`)).body.items).toEqual([]);
    expect((await team.lead.patch(`${team.ws}/saved-searches/${id}`, { name: 'Bug เปิดอยู่' })).body.name).toBe('Bug เปิดอยู่');
    expect((await team.dev.patch(`${team.ws}/saved-searches/${id}`, { name: 'x' })).status).toBe(404);
    expect((await team.dev.delete(`${team.ws}/saved-searches/${id}`)).status).toBe(404);
    expect((await team.lead.post(`${team.ws}/saved-searches`, { name: '', query: 'x' })).status).toBe(400);
    expect((await team.lead.patch(`${team.ws}/saved-searches/${id}`, {})).status).toBe(400);
    expect((await team.lead.delete(`${team.ws}/saved-searches/${id}`)).status).toBe(200);
    expect((await team.lead.delete(`${team.ws}/saved-searches/${id}`)).status).toBe(404);
  });

  it('จำกัด 50 รายการต่อคน', async () => {
    await t.owner.query(`INSERT INTO saved_searches (workspace_id, user_id, name, query) SELECT $1, $2, 'S' || g, 'q' FROM generate_series(1, 50) g`, [wsId, team.devId]);
    const r = await team.dev.post(`${team.ws}/saved-searches`, { name: 'เกิน', query: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('saved_search_limit');
  });
});

describe('saved-views', () => {
  const base = () => `${team.ws}/projects/${team.key}/saved-views`;
  it('ของตัวเอง + แชร์ทั้งโปรเจกต์ (ต้องมี project.views.share) · รายการแสดงของฉันกับที่แชร์', async () => {
    const mine = await team.dev.post(base(), { name: 'งานของฉัน', filters: { assignee: 'me' }, groupBy: 'status', sort: [{ field: 'planEnd', dir: 'asc' }], columns: ['key', 'title'] });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body).toMatchObject({ name: 'งานของฉัน', viewType: 'table', groupBy: 'status', shared: false, mine: true, sort: [{ field: 'planEnd', dir: 'asc' }] });

    const denied = await team.dev.post(base(), { name: 'แชร์', shared: true });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('project.views.share');
    const shared = await team.lead.post(base(), { name: 'Overdue ทั้งทีม', shared: true, filters: { overdue: true } });
    expect(shared.status).toBe(201);
    expect(shared.body).toMatchObject({ shared: true, mine: false });
    await team.lead.post(base(), { name: 'ส่วนตัวของ lead' });

    const devList = await team.dev.get(base());
    expect(devList.body.items.map((v: { name: string }) => v.name)).toEqual(['Overdue ทั้งทีม', 'งานของฉัน']);
    expect(devList.body.items[0]).toMatchObject({ shared: true, mine: false });
    const leadList = await team.lead.get(base());
    expect(leadList.body.items.map((v: { name: string }) => v.name)).toEqual(['Overdue ทั้งทีม', 'ส่วนตัวของ lead']);
    expect(JSON.stringify(leadList.body)).not.toContain('งานของฉัน');
  });

  it('แก้ / ลบ: เจ้าของแก้ของตัวเองได้ · ของคนอื่นไม่เห็น · View ที่แชร์แก้ได้เฉพาะผู้มีสิทธิ์แชร์', async () => {
    const list = (await team.dev.get(base())).body.items as Array<{ id: string; name: string }>;
    const mine = list.find((v) => v.name === 'งานของฉัน')!;
    const shared = list.find((v) => v.name === 'Overdue ทั้งทีม')!;
    expect((await team.dev.patch(`${base()}/${mine.id}`, { name: 'งานของฉัน v2', viewType: 'board' })).body).toMatchObject({ name: 'งานของฉัน v2', viewType: 'board' });
    expect((await team.lead.patch(`${base()}/${mine.id}`, { name: 'แอบแก้' })).status).toBe(404);
    expect((await team.lead.delete(`${base()}/${mine.id}`)).status).toBe(404);
    const noShare = await team.dev.patch(`${base()}/${shared.id}`, { name: 'แก้ของส่วนกลาง' });
    expect(noShare.status).toBe(403);
    expect((await team.dev.delete(`${base()}/${shared.id}`)).status).toBe(403);
    expect((await team.dev.patch(`${base()}/${mine.id}`, { shared: true })).status).toBe(403);
    expect((await team.lead.patch(`${base()}/${shared.id}`, { name: 'Overdue v2', shared: false })).body).toMatchObject({ name: 'Overdue v2', shared: false, mine: true });
    expect((await team.lead.delete(`${base()}/${shared.id}`)).status).toBe(200);
    expect((await team.dev.delete(`${base()}/${mine.id}`)).status).toBe(200);
    expect((await team.dev.delete(`${base()}/${mine.id}`)).status).toBe(404);
  });

  it('ตรวจข้อมูล · Guest ใช้ไม่ได้ · โปรเจกต์ที่ Archive แก้ไม่ได้', async () => {
    expect((await team.lead.post(base(), { name: 'x', viewType: 'pie' })).status).toBe(400);
    expect((await team.lead.post(base(), { name: 'x', sort: Array.from({ length: 6 }, () => ({ field: 'a' })) })).status).toBe(400);
    expect((await team.lead.post(base(), { name: 'x', columns: 'key' })).status).toBe(400);
    expect((await guest.get(base())).status).toBe(403);
    expect((await team.lead.get(`${team.ws}/projects/NOPE/saved-views`)).status).toBe(404);
    await t.owner.query(`UPDATE projects SET archived_at = now(), status = 'archived' WHERE key = $1`, [team.key]);
    const r = await team.lead.post(base(), { name: 'หลัง Archive' });
    expect(r.status).toBe(403);
    expect((await team.lead.get(base())).status).toBe(200);
    await t.owner.query(`UPDATE projects SET archived_at = NULL, status = 'active' WHERE key = $1`, [team.key]);
  });
});
