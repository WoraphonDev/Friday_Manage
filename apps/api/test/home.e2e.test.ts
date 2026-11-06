// A10 · Home และ My Tasks · ข้อมูลสมมติเท่านั้น
// วันนี้ในเครื่องจำลองเป็น พุธ 2 ธ.ค. 2569 12:00 (เวลาไทย) → สัปดาห์นี้ 30 พ.ย.–6 ธ.ค., สัปดาห์หน้า 7–13 ธ.ค.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let guestId: string;
let wsId: string;
let projectId: string;
let moduleId: string;
const NOW = new Date('2026-12-02T05:00:00Z');

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  guest = await client(t.app);
  guestId = await signup(guest, 'guest@home.example.com', 'Guest');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });
});
afterAll(() => t.close());
afterEach(() => vi.useRealTimers());

const statusId = async (name: string, project = projectId) => (await t.owner.query('SELECT id FROM workflow_statuses WHERE project_id = $1 AND name = $2', [project, name])).rows[0].id as string;

interface Opts { end?: string | null; start?: string | null; assignee?: string[]; status?: string; reviewer?: string; completedAt?: string; shared?: boolean; client?: Client; project?: string; projectId?: string; moduleId?: string; parentKey?: string }
async function issue(title: string, o: Opts = {}) {
  const c = o.client ?? team.lead;
  const r = await c.post(`${team.ws}/projects/${o.project ?? team.key}/issues`, { title, moduleId: o.moduleId ?? moduleId, ...(o.parentKey ? { parentKey: o.parentKey } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as string;
  await t.owner.query('UPDATE issues SET plan_start = $2, plan_end = $3, reviewer_id = $4, shared_with_guests = $5 WHERE id = $1', [id, o.start ?? null, o.end ?? null, o.reviewer ?? null, o.shared ?? false]);
  if (o.status) await t.owner.query('UPDATE issues SET status_id = $2, completed_at = $3 WHERE id = $1', [id, await statusId(o.status, o.projectId ?? projectId), o.completedAt ?? null]);
  await t.owner.query('DELETE FROM issue_assignees WHERE issue_id = $1', [id]);
  for (const [n, u] of (o.assignee ?? []).entries()) await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,$4)', [wsId, id, u, n]);
  return r.body as { id: string; key: string };
}
const titles = (r: { body: { groups: Array<{ key: string; items: Array<{ title: string }> }> } }, group: string) => r.body.groups.find((g) => g.key === group)!.items.map((i) => i.title);

describe('GET w/my-issues', () => {
  let seeded = false;
  let watched: { id: string };
  async function seed() {
    if (seeded) return;
    seeded = true;
    const lead = [team.leadId];
    await issue('L-เลยกำหนด', { end: '2026-11-27', start: '2026-11-25', assignee: lead });
    await issue('T-วันนี้', { end: '2026-12-02', start: '2026-12-01', assignee: lead });
    await issue('W-สัปดาห์นี้', { end: '2026-12-04', start: '2026-12-03', assignee: lead, status: 'In progress' });
    await issue('N-สัปดาห์หน้า', { end: '2026-12-08', start: '2026-12-07', assignee: lead });
    await issue('X-ภายหลัง', { end: '2026-12-20', assignee: lead });
    await issue('Z-ไม่มีวัน', { assignee: lead });
    await issue('D-เสร็จวันนี้', { end: '2026-12-01', assignee: lead, status: 'Done', completedAt: '2026-12-02T03:00:00Z' });
    await issue('D-เสร็จเมื่อวาน', { end: '2026-12-01', assignee: lead, status: 'Done', completedAt: '2026-12-01T03:00:00Z' });
    await issue('R-รอ Review', { end: '2026-12-03', assignee: [team.devId], reviewer: team.leadId, status: 'Review' });
    watched = await issue('K-ติดตามงานของ dev', { end: '2026-12-09', assignee: [team.devId], client: team.dev });
    await issue('DEV-งานของ dev', { end: '2026-12-02', assignee: [team.devId], client: team.dev });
    await issue('DEV-เลยกำหนด', { end: '2026-12-01', assignee: [team.devId], client: team.dev });
    await t.owner.query('DELETE FROM issue_watchers');
    await t.owner.query('INSERT INTO issue_watchers (workspace_id, issue_id, user_id) VALUES ($1,$2,$3)', [wsId, watched.id, team.leadId]);
  }
  const get = async (qs: string, c: Client = team.lead) => {
    await seed();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    return c.get(`${team.ws}/my-issues${qs}`);
  };

  it('tab=assigned & group=due: แบ่งเลยกำหนด / วันนี้ / สัปดาห์นี้ / สัปดาห์หน้า / ภายหลัง / ไม่มีวันที่ / เสร็จวันนี้', async () => {
    const r = await get('?tab=assigned&group=due');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.groups.map((g: { key: string; count: number }) => [g.key, g.count])).toEqual([['late', 1], ['today', 1], ['this_week', 1], ['next_week', 1], ['later', 1], ['none', 1], ['done_today', 1]]);
    expect(titles(r, 'late')).toEqual(['L-เลยกำหนด']);
    expect(titles(r, 'done_today')).toEqual(['D-เสร็จวันนี้']);
    expect(JSON.stringify(r.body)).not.toContain('เสร็จเมื่อวาน');
    const g = (k: string) => r.body.groups.find((x: { key: string }) => x.key === k);
    expect(g('this_week').range).toEqual({ from: '2026-12-03', to: '2026-12-06' });
    expect(g('next_week').range).toEqual({ from: '2026-12-07', to: '2026-12-13' });
    expect(g('later').range).toEqual({ from: '2026-12-14', to: '' });
    expect(r.body).toMatchObject({ today: '2026-12-02', tab: 'assigned', group: 'due', total: 6 });
    expect(r.body.counts).toEqual({ assigned: 6, reviewer: 1, watching: 1, created: 7 });
    const late = g('late').items[0];
    expect(late).toMatchObject({ key: expect.stringMatching(/^DP-\d+$/), project: { key: 'DP' }, status: { category: 'todo' }, planEnd: '2026-11-27', due: { state: 'overdue', days: 5 } });
    expect(g('today').items[0].due).toEqual({ state: 'today', days: 0 });
    expect(g('done_today').items[0].due.state).toBe('done');
    expect(g('none').items[0].due).toEqual({ state: 'none', days: null });
  });

  it('tab=reviewer / watching / created', async () => {
    const reviewer = await get('?tab=reviewer&group=status');
    expect(reviewer.body.groups.map((g: { key: string }) => g.key)).toEqual(['Review']);
    expect(titles(reviewer, 'Review')).toEqual(['R-รอ Review']);

    const watching = await get('?tab=watching');
    expect(watching.body.groups.flatMap((g: { items: Array<{ title: string }> }) => g.items.map((i) => i.title))).toEqual(['K-ติดตามงานของ dev']);
    expect(watching.body.groups.find((g: { key: string }) => g.key === 'next_week').count).toBe(1);

    const created = await get('?tab=created&group=project');
    expect(created.body.groups.map((g: { key: string }) => g.key)).toEqual(['DP']);
    expect(created.body.groups[0].count).toBe(8); // ที่ lead สร้างและยังไม่เสร็จ 7 + เสร็จวันนี้ 1 (ไม่รวมของ dev และงานที่เสร็จนานแล้ว)
    expect(JSON.stringify(created.body)).not.toContain('DEV-งานของ dev');
  });

  it('group=status เรียงตามหมวดและลำดับของ Workflow · group=project · กรอง assignee/โปรเจกต์', async () => {
    const byStatus = await get('?tab=assigned&group=status');
    expect(byStatus.body.groups.map((g: { key: string }) => g.key)).toEqual(['To do', 'In progress', 'Done']);
    expect(titles(byStatus, 'In progress')).toEqual(['W-สัปดาห์นี้']);
    expect(titles(byStatus, 'Done')).toEqual(['D-เสร็จวันนี้']);
    expect(titles(byStatus, 'To do')).toEqual(['L-เลยกำหนด', 'T-วันนี้', 'N-สัปดาห์หน้า', 'X-ภายหลัง', 'Z-ไม่มีวัน']);

    const byProject = await get('?tab=assigned&group=project');
    expect(byProject.body.groups.map((g: { key: string; count: number }) => [g.key, g.count])).toEqual([['DP', 7]]);
    expect((await get('?tab=assigned&projectKey=nope')).status).toBe(404);
    expect((await get(`?tab=created&assignee=${team.devId}`)).body.groups.flatMap((g: { items: unknown[] }) => g.items)).toHaveLength(1); // lead สร้างและมอบให้ dev: R-รอ Review
  });

  it('dev เห็นเฉพาะงานของตัวเอง · พารามิเตอร์ผิด → 400', async () => {
    const r = await get('?tab=assigned&group=due', team.dev);
    expect(r.body.groups.flatMap((g: { items: Array<{ title: string }> }) => g.items.map((i) => i.title)).sort()).toEqual(['DEV-งานของ dev', 'DEV-เลยกำหนด', 'K-ติดตามงานของ dev', 'R-รอ Review']);
    expect((await get('?tab=everyone')).status).toBe(400);
    expect((await get('?group=week')).status).toBe(400);
    expect((await get('?assignee=abc')).status).toBe(400);
    expect((await team.lead.get(`${team.ws}/my-issues`)).body.tab).toBe('assigned');
  });

  it('ข้ามทุกโปรเจกต์ที่เข้าถึงได้ · โปรเจกต์ Private ที่ไม่ได้เป็นสมาชิกไม่โผล่', async () => {
    await seed();
    const mk = async (key: string, visibility: 'workspace' | 'private') => {
      const r = await team.lead.post(`${team.ws}/projects`, { key, name: `Other ${key}`, startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['M'], sprintLengthWeeks: null, visibility });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const p = (await team.lead.get(`${team.ws}/projects/${key}`)).body;
      return { key, id: p.id as string, moduleId: p.modules[0].id as string };
    };
    const open = await mk('HM2', 'workspace');
    const secret = await mk('HM3', 'private');
    await issue('HM2-ของ lead', { project: open.key, projectId: open.id, moduleId: open.moduleId, end: '2026-12-05', assignee: [team.leadId] });
    await issue('HM3-ลับ', { project: secret.key, projectId: secret.id, moduleId: secret.moduleId, end: '2026-12-05', assignee: [team.devId] });
    const mineDev = await get('?tab=assigned&group=project', team.dev);
    expect(mineDev.body.groups.map((g: { key: string }) => g.key)).not.toContain('HM3');
    const lead = await get('?tab=assigned&group=project');
    expect(lead.body.groups.map((g: { key: string }) => g.key)).toEqual(['DP', 'HM2']);
    expect((await get('?tab=assigned&projectKey=hm2')).body.total).toBe(1);
  });

  it('Guest เห็นเฉพาะงานที่แชร์ให้ ไม่เห็น Bug และไม่เห็นชื่อคน', async () => {
    await seed();
    const shared = await issue('G-งานที่แชร์', { end: '2026-12-03', assignee: [guestId], shared: true });
    await issue('G-ไม่แชร์', { end: '2026-12-03', assignee: [guestId], shared: false });
    const bug = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'G-bug ที่แชร์', moduleId, type: 'Bug', severity: 'major' });
    if (bug.status === 201) {
      await t.owner.query('UPDATE issues SET plan_end = $2, shared_with_guests = true WHERE id = $1', [bug.body.id, '2026-12-03']);
      await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, bug.body.id, guestId]);
    }
    const r = await get('?tab=assigned&group=due', guest);
    const all = r.body.groups.flatMap((g: { items: Array<{ title: string; assignees: unknown[] }> }) => g.items);
    expect(all.map((i: { title: string }) => i.title)).toEqual(['G-งานที่แชร์']);
    expect(all[0].assignees).toEqual([]);
    expect(shared.key).toBeTruthy();
  });
});

describe('GET w/home', () => {
  let ready = false;
  async function prepare() {
    if (ready) return;
    ready = true;
    // เริ่มจากโปรเจกต์ DP ที่ว่าง: ล้างงานและโปรเจกต์อื่นที่กรณีก่อนหน้าสร้างไว้
    await t.owner.query('DELETE FROM issues');
    await t.owner.query(`DELETE FROM projects WHERE key <> 'DP'`);
    await t.owner.query('DELETE FROM sprints');
    await t.owner.query('DELETE FROM notifications');
    const lead = [team.leadId];
    await issue('H-L เลยกำหนด', { end: '2026-11-27', assignee: lead });
    await issue('H-T วันนี้', { end: '2026-12-02', start: '2026-12-01', assignee: lead, status: 'In progress' });
    await issue('H-W สัปดาห์นี้', { end: '2026-12-04', start: '2026-12-03', assignee: lead });
    await issue('H-R รอ Review', { end: '2026-12-03', assignee: [team.devId], reviewer: team.leadId, status: 'Review' });
    await issue('H-DEV-วันนี้', { end: '2026-12-02', assignee: [team.devId], client: team.dev });
    await issue('H-DEV-late', { end: '2026-12-01', assignee: [team.devId], client: team.dev });
    const dueIssue = await issue('H-ขอเลื่อน', { end: '2026-12-04', start: '2026-12-03', assignee: [team.devId], client: team.dev });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const dr = await team.dev.post(`${team.ws}/issues/${dueIssue.key}/due-requests`, { requestedDue: '2026-12-09', reasonCode: 'scope_added', detail: 'ทดสอบ' });
    expect(dr.status, JSON.stringify(dr.body)).toBe(201);
    vi.useRealTimers();
    await t.owner.query(
      `INSERT INTO notifications (workspace_id, recipient_id, event_type, project_id, payload, reason) VALUES ($1,$2,'issue.mentioned',$3,'{"actorName":"Kaijeaw"}'::jsonb,'ทดสอบ'), ($1,$2,'issue.mentioned',$3,'{"actorName":"Kaijeaw"}'::jsonb,'ทดสอบ')`,
      [wsId, team.leadId, projectId],
    );
    await t.owner.query(`UPDATE notifications SET read_at = now() WHERE id = (SELECT id FROM notifications WHERE event_type = 'issue.mentioned' LIMIT 1)`);
    await t.owner.query(`UPDATE projects SET golive_date = '2026-12-25' WHERE id = $1`, [projectId]);
    await t.owner.query(`INSERT INTO sprints (workspace_id, project_id, number, name, start_date, end_date, status) VALUES ($1,$2,90,'Sprint ทดสอบ','2026-12-07','2026-12-18','planning')`, [wsId, projectId]);
    await t.owner.query(`INSERT INTO milestones (workspace_id, project_id, name, date) VALUES ($1,$2,'Milestone ทดสอบ','2026-12-15')`, [wsId, projectId]);
  }
  const home = async (c: Client = team.lead) => {
    await prepare();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    return c.get(`${team.ws}/home`);
  };

  it('สรุปวันนี้: ทีม / ของฉัน / Overdue ต่อคน / สัปดาห์นี้ / กำลังทำ / Review / Mentions', async () => {
    const r = await home();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.today).toBe('2026-12-02');
    expect(r.body.week).toEqual({ start: '2026-11-30', end: '2026-12-06' });
    const s = r.body.summary;
    expect(s.dueToday).toMatchObject({ team: 2, mine: 1 });
    expect(s.dueToday.keys).toHaveLength(2);
    expect(s.overdue).toMatchObject({ team: 2, mine: 1 });
    expect(s.overdue.byAssignee).toEqual(expect.arrayContaining([{ person: expect.objectContaining({ displayName: 'Mick' }), count: 1 }, { person: expect.objectContaining({ displayName: 'Kaijeaw' }), count: 1 }]));
    expect(s.dueThisWeek).toMatchObject({ team: 5, mine: 2, until: '2026-12-04' });
    expect(s.inProgress).toEqual({ mine: 1 });
    expect(s.waitingReview).toBe(1);
    expect(s.unreadMentions).toEqual({ count: 1, latestFrom: 'Kaijeaw' });
    expect(s.pendingApprovals).toBe(1);
  });

  it('รออนุมัติ + รอ Review', async () => {
    const r = await home();
    expect(r.body.waiting.approvals).toMatchObject([{ status: 'pending', canDecide: true, issue: { title: 'H-ขอเลื่อน' }, project: { key: 'DP' } }]);
    expect(r.body.waiting.reviews).toMatchObject([{ title: 'H-R รอ Review', status: { name: 'Review' }, project: { key: 'DP' }, from: { displayName: 'Mick' } }]);
    // dev ไม่มีสิทธิ์อนุมัติ ไม่มีของรอ Review
    const d = await home(team.dev);
    expect(d.body.waiting.approvals).toEqual([]);
    expect(d.body.waiting.reviews).toEqual([]);
    expect(d.body.summary.pendingApprovals).toBe(0);
  });

  it('โปรเจกต์ของฉันพร้อมความคืบหน้า Overdue งานของฉัน Go-live และ Health', async () => {
    const r = await home();
    expect(r.body.projects).toHaveLength(1);
    expect(r.body.projects[0]).toMatchObject({ key: 'DP', name: 'Development Plan', goliveDate: '2026-12-25', daysToGolive: 23, overdue: 2, myTasks: 3, health: { level: expect.stringMatching(/on_track|at_risk|off_track/) } });
    expect(r.body.projects[0].progressPct).toBeGreaterThanOrEqual(0);
    expect(r.body.projects[0].progressPct).toBeLessThanOrEqual(100);
  });

  it('เปิดล่าสุดจาก activities (ไม่ซ้ำงาน) และ 30 วันข้างหน้า', async () => {
    const lead = await team.lead.get(`${team.ws}/projects/${team.key}/issues`);
    expect(lead.status).toBe(200);
    const first = (await team.lead.get(`${team.ws}/issues/${team.project.key ? 'DP-1' : 'DP-1'}`)).body;
    await team.lead.patch(`${team.ws}/issues/DP-1`, { title: 'แก้ชื่อ 1' }, first.version);
    await team.lead.patch(`${team.ws}/issues/DP-1`, { title: 'แก้ชื่อ 2' }, first.version + 1);
    const r = await home();
    const keys = r.body.recent.map((x: { key: string }) => x.key);
    expect(keys.filter((k: string) => k === 'DP-1').length).toBeLessThanOrEqual(1);
    expect(r.body.recent.length).toBeLessThanOrEqual(8);

    const byType = (type: string) => r.body.upcoming.filter((e: { type: string }) => e.type === type);
    expect(byType('sprint_start')).toMatchObject([{ date: '2026-12-07', title: 'Sprint ทดสอบ', project: 'Development Plan' }]);
    expect(byType('sprint_end')).toMatchObject([{ date: '2026-12-18' }]);
    expect(byType('milestone')).toMatchObject([{ date: '2026-12-15', title: 'Milestone ทดสอบ' }]);
    expect(byType('holiday').map((e: { date: string }) => e.date)).toEqual(['2026-12-07', '2026-12-10']);
    const dates = r.body.upcoming.map((e: { date: string }) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('Workload สัปดาห์นี้ของทีมและของฉัน', async () => {
    const r = await home();
    expect(r.body.workload.week).toEqual({ start: '2026-11-30', end: '2026-12-06' });
    expect(r.body.workload.team.capacityMd).toBeGreaterThan(0);
    expect(r.body.workload.people.length).toBeGreaterThan(0);
    expect(r.body.workload.people[0]).toEqual(expect.objectContaining({ md: expect.any(Number), capacityMd: expect.any(Number) }));
  });

  it('Guest: เห็นเฉพาะงานที่แชร์ ไม่มีชื่อคน ไม่มี Workload และการอนุมัติ', async () => {
    const r = await home(guest);
    expect(r.status).toBe(200);
    expect(r.body.workload).toBeNull();
    expect(r.body.waiting).toEqual({ approvals: [], reviews: [] });
    expect(r.body.summary.overdue.byAssignee).toEqual([]);
    expect(JSON.stringify(r.body.summary)).not.toContain('H-');
  });
});
