// A08 · Overview โปรเจกต์ และ Workload · ข้อมูลสมมติเท่านั้น
// วันที่ใน Workload ใช้ช่วงตายตัว (ธ.ค. 2569 ที่มีวันหยุด 7 และ 10 ธ.ค. จาก seedHolidays)
// Health ใช้งานในปี 2563 (ผ่านไปแล้ว = แผน 100%) คู่กับงานในปี 2642 (ยังไม่ถึง = แผน 0%) จึงไม่ขึ้นกับวันที่รัน test
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { today } from '../src/common/dates.js';
import { healthLevel } from '../src/overview/health.js';
import { buckets, computeWorkload, weekOf } from '../src/overview/workload.js';
import { addDays, WorkCalendar } from '../src/projects/calendar.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let pond: Client;
let pondId: string;
let guest: Client;
let guestId: string;
let creditLine: string;
let drawdown: string;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  pond = await client(t.app);
  pondId = await signup(pond, 'pond@friday-dev.example.com', 'Pond');
  await addMember(t.owner, team.slug, pondId, 'member', { key: 'DP', role: 'member' });
  guest = await client(t.app);
  guestId = await signup(guest, 'client@customer.example.com', 'Client');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: 'DP', role: 'viewer' });
  creditLine = team.project.modules.find((m: { name: string }) => m.name === 'Credit Line').id;
  drawdown = team.project.modules.find((m: { name: string }) => m.name === 'Drawdown').id;
});
afterAll(() => t.close());

async function createIssue(body: Record<string, unknown>) {
  const r = await team.lead.post(`${team.ws}/projects/DP/issues`, { moduleId: creditLine, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { key: string; version: number; id: string };
}

/** สร้างโปรเจกต์ใหม่แล้วโหลดรายละเอียด (Module, สถานะ) */
async function newProject(body: Record<string, unknown>) {
  const r = await team.lead.post(`${team.ws}/projects`, { startDate: '2026-11-05', goliveDate: '2027-04-21', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (await team.lead.get(`${team.ws}/projects/${body.key}`)).body;
}

/** เพิ่มคนที่เป็นสมาชิก Workspace แล้วเข้าโปรเจกต์ (ตรงในฐานข้อมูล) */
async function joinProject(userId: string, key: string, role: 'admin' | 'member' | 'viewer', capacityHoursWeek: number | null = null) {
  await t.owner.query(
    `INSERT INTO project_members (workspace_id, project_id, user_id, role, capacity_hours_week)
     SELECT workspace_id, id, $1, $2, $3 FROM projects WHERE key = $4`,
    [userId, role, capacityHoursWeek, key],
  );
}

async function addLeave(userId: string, startDate: string, endDate: string, halfDay: 'am' | 'pm' | null = null) {
  await t.owner.query(
    `INSERT INTO leaves (workspace_id, user_id, leave_type, start_date, end_date, half_day, status)
     SELECT id, $1, 'vacation', $2, $3, $4, 'approved' FROM workspaces WHERE slug = $5`,
    [userId, startDate, endDate, halfDay, team.slug],
  );
}

describe('workload.ts (คำนวณล้วน)', () => {
  it('แบ่งช่วงเป็นสัปดาห์จันทร์–อาทิตย์และเดือน', () => {
    expect(weekOf('2026-12-02')).toEqual({ start: '2026-11-30', end: '2026-12-06' });
    expect(buckets('2026-12-02', '2026-12-15', 'week')).toEqual([
      { start: '2026-12-02', end: '2026-12-06' },
      { start: '2026-12-07', end: '2026-12-13' },
      { start: '2026-12-14', end: '2026-12-15' },
    ]);
    expect(buckets('2026-11-20', '2027-01-05', 'month').map((b) => b.end)).toEqual(['2026-11-30', '2026-12-31', '2027-01-05']);
  });

  it('Man-Day ของงาน 2 Dev แบ่งครึ่ง และวันลาครึ่งวันลด capacity ครึ่งวัน', () => {
    const cal = new WorkCalendar(new Set([1, 2, 3, 4, 5]), new Set());
    const r = computeWorkload({
      from: '2026-11-30',
      to: '2026-12-06',
      group: 'week',
      items: [{ id: 'i1', projectId: 'p', key: 'DP-1', title: 'ฟอร์มวงเงิน', moduleId: null, estimateMd: 3, planStart: '2026-11-30', planEnd: '2026-12-02', assigneeIds: ['a', 'b'] }],
      people: [
        { userId: 'a', capacityHoursWeek: 40 },
        { userId: 'b', capacityHoursWeek: 40 },
      ],
      leaves: [{ userId: 'b', startDate: '2026-12-04', endDate: '2026-12-04', halfDay: 'pm' }],
      calendarOf: () => cal,
      capacityCalendar: cal,
    });
    expect(r.rows.get('a')![0]).toMatchObject({ md: 1.5, capacityMd: 5, leaveDays: 0 });
    expect(r.rows.get('b')![0]).toMatchObject({ md: 1.5, capacityMd: 4.5, leaveDays: 0.5 });
  });

  it('Workload 2 ชุด: plan กระจายตามแผน · actual ใช้วันที่ทำจริงของงานที่เสร็จ และส่วนที่เหลือจากวันนี้', () => {
    const cal = new WorkCalendar(new Set([1, 2, 3, 4, 5]), new Set());
    const base = { projectId: 'p', moduleId: null, assigneeIds: ['a'] };
    const items = [
      // แผน 30 พ.ย.–4 ธ.ค. แต่ทำจริง 7–8 ธ.ค.
      { ...base, id: 'late', key: 'DP-1', title: 'เสร็จช้ากว่าแผน', estimateMd: 2, planStart: '2026-11-30', planEnd: '2026-12-04', done: true, actualStart: '2026-12-07', actualEnd: '2026-12-08' },
      // ยังไม่เสร็จ คืบหน้า 50% · วันนี้ 9 ธ.ค. · ส่วนที่ทำแล้วอยู่ก่อนวันนี้ ส่วนที่เหลือ 9–11 ธ.ค.
      { ...base, id: 'open', key: 'DP-2', title: 'ทำอยู่', estimateMd: 4, planStart: '2026-12-01', planEnd: '2026-12-11', progressPct: 50, actualStart: '2026-12-01' },
    ];
    const run = (basis: 'plan' | 'actual') =>
      computeWorkload({ from: '2026-11-30', to: '2026-12-13', group: 'week', items, people: [{ userId: 'a', capacityHoursWeek: 40 }], leaves: [], calendarOf: () => cal, capacityCalendar: cal, basis, today: '2026-12-09' });
    const plan = run('plan').rows.get('a')!;
    const actual = run('actual').rows.get('a')!;
    // plan: DP-1 ทั้ง 2 MD ในสัปดาห์แรก · DP-2 4 MD ใน 9 วันทำการ (1–11 ธ.ค.) → 4 วันแรก 1.78, 5 วันหลัง 2.22
    expect(plan.map((c) => c.md)).toEqual([3.78, 2.22]);
    // actual: DP-1 ย้ายไปสัปดาห์ที่สอง · DP-2 2 MD ที่ทำแล้วกระจาย 1–8 ธ.ค. (6 วันทำการ) + 2 MD ที่เหลือ 9–11 ธ.ค.
    expect(actual.map((c) => c.md)).toEqual([1.33, 4.67]);
    expect(actual[1].items.map((i) => i.key).sort()).toEqual(['DP-1', 'DP-2']);
  });

  it('Health: ช้ากว่าแผนไม่เกิน 5 = on track · ไม่เกิน 15 = at risk · เกิน = off track', () => {
    expect(healthLevel(-20)).toBe('on_track');
    expect(healthLevel(5)).toBe('on_track');
    expect(healthLevel(5.1)).toBe('at_risk');
    expect(healthLevel(15)).toBe('at_risk');
    expect(healthLevel(15.1)).toBe('off_track');
  });
});

describe('GET p/workload', () => {
  it('งาน 2 Dev แบ่ง Man-Day ครึ่งต่อคน · วันหยุดและวันลาลด capacity · เกิน capacity', async () => {
    const { ws, devId } = team;
    // 4 MD · จ. 30 พ.ย. – พฤ. 3 ธ.ค. (4 วันทำการ) · 2 Dev → คนละ 0.5 MD/วัน
    await createIssue({ title: 'หน้าจอวงเงินรวม', estimateMd: 4, planStart: '2026-11-30', planEnd: '2026-12-03', assigneeIds: [devId, pondId] });
    // 7 ธ.ค. เป็นวันหยุด → Plan Start เลื่อนเป็น 8 ธ.ค. · วันทำการ 8, 9, 11 = 3 วัน
    await createIssue({ title: 'คำนวณดอกเบี้ย', estimateMd: 3, planStart: '2026-12-07', planEnd: '2026-12-11', assigneeIds: [devId] });
    await createIssue({ title: 'รายงานวงเงินคงเหลือ', estimateMd: 2, planStart: '2026-12-08', planEnd: '2026-12-09', assigneeIds: [devId] });
    // Pond ลาเต็มวัน 1 ธ.ค. และครึ่งวันเช้า 2 ธ.ค.
    await addLeave(pondId, '2026-12-01', '2026-12-01');
    await addLeave(pondId, '2026-12-02', '2026-12-02', 'am');

    const r = await team.lead.get(`${ws}/projects/DP/workload?from=2026-11-30&to=2026-12-13&group=week&unit=md`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.buckets).toEqual([
      { start: '2026-11-30', end: '2026-12-06' },
      { start: '2026-12-07', end: '2026-12-13' },
    ]);
    const byName = (name: string) => r.body.people.find((p: { person: { displayName: string } }) => p.person.displayName === name);
    const kaijeaw = byName('Kaijeaw');
    const pondRow = byName('Pond');
    expect(byName('Mick')).toBeUndefined(); // PM ที่ไม่มีงานเป็น Dev ไม่อยู่ในกราฟ

    expect(kaijeaw.cells[0]).toMatchObject({ value: 2, capacity: 5, over: false, utilizationPct: 40 });
    expect(kaijeaw.cells[0].issues).toEqual([{ key: 'DP-1', title: 'หน้าจอวงเงินรวม', value: 2 }]);
    // สัปดาห์ 7–13 ธ.ค. มีวันหยุด 2 วัน → capacity 3 MD · งาน 3 + 2 MD → เกิน
    expect(kaijeaw.cells[1]).toMatchObject({ value: 5, capacity: 3, over: true, utilizationPct: 167 });
    expect(pondRow.cells[0]).toMatchObject({ value: 2, capacity: 3.5, leaveDays: 1.5, over: false });
    expect(pondRow.capacityHoursWeek).toBe(40);
    expect(r.body.team[1]).toMatchObject({ value: 5, capacity: 6 });

    const hours = await team.lead.get(`${ws}/projects/DP/workload?from=2026-11-30&to=2026-12-06&unit=hour`);
    expect(hours.body.people.find((p: { person: { id: string } }) => p.person.id === devId).cells[0]).toMatchObject({ value: 16, capacity: 40 });
    const count = await team.lead.get(`${ws}/projects/DP/workload?from=2026-12-07&to=2026-12-13&unit=count`);
    expect(count.body.people.find((p: { person: { id: string } }) => p.person.id === devId).cells[0]).toMatchObject({ value: 2, capacity: null });
    const days = await team.lead.get(`${ws}/projects/DP/workload?from=2026-12-07&to=2026-12-08&group=day`);
    expect(days.body.people.find((p: { person: { id: string } }) => p.person.id === devId).cells.map((c: { value: number; capacity: number }) => [c.value, c.capacity])).toEqual([
      [0, 0],
      [2, 1],
    ]);
  });

  it('Task ที่มี Sub-task นับเฉพาะ Sub-task (ไม่นับ Man-Day ซ้ำ) และกรองตาม Module ได้', async () => {
    const { ws, devId } = team;
    const parent = await createIssue({ title: 'Drawdown Entry', moduleId: drawdown, estimateMd: 10, planStart: '2026-12-14', planEnd: '2026-12-25', assigneeIds: [devId] });
    await createIssue({ title: 'บันทึกรายการเบิก', parentKey: parent.key, estimateMd: 1, planStart: '2026-12-14', planEnd: '2026-12-14', assigneeIds: [devId] });
    // Bug ใต้ Task ไม่ได้แบ่ง Man-Day ของ Task: Task ยังนับ 2 MD ตามปกติ
    const withBug = await createIssue({ title: 'ยืนยันรายการเบิก', moduleId: drawdown, estimateMd: 2, planStart: '2026-12-17', planEnd: '2026-12-18', assigneeIds: [devId] });
    await createIssue({ type: 'Bug', parentKey: withBug.key, title: 'ปุ่มยืนยันกดซ้ำได้', severity: 'minor', environment: 'sit', details: { steps: '1. กดยืนยัน 2 ครั้ง' }, assigneeIds: [devId] });
    const r = await team.lead.get(`${ws}/projects/DP/workload?from=2026-12-14&to=2026-12-20`);
    const row = r.body.people.find((p: { person: { id: string } }) => p.person.id === devId);
    expect(row.cells[0].value).toBe(3);
    expect(row.cells[0].issues.map((i: { title: string }) => i.title)).toEqual(['ยืนยันรายการเบิก', 'บันทึกรายการเบิก']);

    const onlyCredit = await team.lead.get(`${ws}/projects/DP/workload?from=2026-12-14&to=2026-12-20&moduleId=${creditLine}`);
    expect(onlyCredit.body.people.find((p: { person: { id: string } }) => p.person.id === devId).cells[0].value).toBe(0);
    expect(r.body.unscheduled).toMatchObject({ count: 1, noDates: 1 }); // Bug ที่ยังไม่มีวันในแผน
  });

  it('capacity ใช้ชั่วโมงที่แบ่งให้โปรเจกต์ก่อนเวลาทั้งหมดของคน', async () => {
    await t.owner.query(`UPDATE project_members SET capacity_hours_week = 20, position = 'Backend' WHERE user_id = $1`, [pondId]);
    const r = await team.lead.get(`${team.ws}/projects/DP/workload?from=2026-12-14&to=2026-12-20&position=backend`);
    expect(r.body.people.map((p: { person: { displayName: string } }) => p.person.displayName)).toEqual(['Pond']);
    expect(r.body.people[0]).toMatchObject({ position: 'Backend', capacityHoursWeek: 20 });
    expect(r.body.people[0].cells[0].capacity).toBe(2.5);
  });

  it('ตรวจข้อมูลขาเข้า และ Guest ที่เป็น Viewer ได้ 403', async () => {
    expect((await team.lead.get(`${team.ws}/projects/DP/workload?from=2026-12-10&to=2026-12-01`)).status).toBe(400);
    expect((await team.lead.get(`${team.ws}/projects/DP/workload?from=2026-01-01&to=2027-06-01`)).status).toBe(400);
    expect((await team.lead.get(`${team.ws}/projects/DP/workload?unit=day`)).status).toBe(400);
    expect((await team.lead.get(`${team.ws}/projects/DP/workload?basis=done`)).status).toBe(400);
    const def = await team.dev.get(`${team.ws}/projects/DP/workload`);
    expect(def.status).toBe(200);
    expect(def.body.buckets).toHaveLength(8);
    expect(def.body.range.from).toBe(weekOf(today()).start);
    const g = await guest.get(`${team.ws}/projects/DP/workload`);
    expect(g.status).toBe(403);
    expect(g.body.error.details).toEqual({ permission: 'project.workload.view' });
  });
});

describe('GET w/workload', () => {
  it('รวมทุกโปรเจกต์ แยกตามโปรเจกต์ · capacity จากเวลาทั้งหมดของคน · กรองตามทีม', async () => {
    const { ws, lead, devId } = team;
    const p = await newProject({ name: 'Mobile App', key: 'MA', modules: ['Login'] });
    await joinProject(devId, 'MA', 'member', 30);
    await t.owner.query(`UPDATE project_members SET capacity_hours_week = 20 WHERE user_id = $1 AND project_id = $2`, [devId, team.project.id]);
    const r1 = await lead.post(`${ws}/projects/MA/issues`, { title: 'หน้า Login', moduleId: p.modules[0].id, estimateMd: 2, planStart: '2026-11-30', planEnd: '2026-12-01', assigneeIds: [devId] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);

    const r = await lead.get(`${ws}/workload?from=2026-11-30&to=2026-12-06`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const kj = r.body.people.find((x: { person: { id: string } }) => x.person.id === devId);
    expect(kj.cells[0]).toMatchObject({ value: 4, capacity: 5, over: false });
    expect(kj.cells[0].byProject).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'DP', value: 2 }), expect.objectContaining({ key: 'MA', value: 2 })]),
    );
    expect(kj.cells[0].byProject).toHaveLength(2);
    expect(kj).toMatchObject({ capacityHoursWeek: 40, allocatedHoursWeek: 50, overAllocated: true });

    // ทีม: เฉพาะสมาชิกของทีม แม้ยังไม่มีงาน
    const { rows } = await t.owner.query(`INSERT INTO teams (workspace_id, name) SELECT id, 'ทีม Dev' FROM workspaces WHERE slug = $1 RETURNING id, workspace_id`, [team.slug]);
    await t.owner.query(`INSERT INTO team_members (workspace_id, team_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4)`, [rows[0].workspace_id, rows[0].id, pondId, team.leadId]);
    const byTeam = await lead.get(`${ws}/workload?from=2026-11-30&to=2026-12-06&team=${rows[0].id}`);
    expect(byTeam.body.people.map((x: { person: { displayName: string } }) => x.person.displayName)).toEqual(['Mick', 'Pond']);
    expect(byTeam.body.people[0].cells[0]).toMatchObject({ value: 0, capacity: 5 });

    expect((await lead.get(`${ws}/workload?team=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    const member = await team.dev.get(`${ws}/workload`);
    expect(member.status).toBe(403);
    expect(member.body.error.details).toEqual({ permission: 'ws.workload.view' });
    expect((await guest.get(`${ws}/workload`)).status).toBe(403);
  });
});

describe('GET p/overview', () => {
  it('Health 3 ระดับ: เทียบ % MD ตามแผน ณ วันนี้ กับ % ที่เสร็จจริง', async () => {
    const { ws, lead, devId } = team;
    const p = await newProject({ name: 'Health Check', key: 'HC', modules: ['Core'] });
    const core = p.modules[0].id;
    await joinProject(devId, 'HC', 'member');
    const past = await lead.post(`${ws}/projects/HC/issues`, { title: 'งานที่ควรเสร็จแล้ว', moduleId: core, estimateMd: 10, planStart: '2020-01-06', planEnd: '2020-01-10', assigneeIds: [devId] });
    const future = await lead.post(`${ws}/projects/HC/issues`, { title: 'งานในอนาคต', moduleId: core, estimateMd: 10, planStart: '2099-01-05', planEnd: '2099-01-09', assigneeIds: [devId] });
    expect([past.status, future.status]).toEqual([201, 201]);

    let version = past.body.version;
    const healthAt = async (progressPct: number) => {
      const r = await lead.patch(`${ws}/issues/${past.body.key}`, { progressPct }, version);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      version = r.body.version;
      const o = await lead.get(`${ws}/projects/HC/overview`);
      expect(o.status, JSON.stringify(o.body)).toBe(200);
      return o.body.health;
    };
    // แผน ณ วันนี้ = 10 / 20 MD = 50%
    expect(await healthAt(92)).toMatchObject({ level: 'on_track', plannedPct: 50, actualPct: 46, gapPct: 4 });
    expect(await healthAt(90)).toMatchObject({ level: 'on_track', gapPct: 5 });
    expect(await healthAt(80)).toMatchObject({ level: 'at_risk', actualPct: 40, gapPct: 10 });
    expect(await healthAt(70)).toMatchObject({ level: 'at_risk', gapPct: 15 });
    const off = await healthAt(60);
    expect(off).toMatchObject({ level: 'off_track', plannedPct: 50, actualPct: 30, gapPct: 20, thresholds: { onTrack: 5, atRisk: 15 }, behindPlan: 1 });
    expect(off.overdue).toMatchObject({ count: 1, topAssignee: { person: { id: devId }, count: 1 } });
    expect(off.capacity).toMatchObject({ remainingMd: 14, teamMdPerWeek: 5, weeksNeeded: 2.8 });
  });

  it('KPI, รายการ, Burn-up, Module, Milestone, Workload สัปดาห์นี้ และ Activity', async () => {
    // โปรเจกต์แยก เพื่อไม่ให้งานเดือน ธ.ค. 2569 ด้านบนกลายเป็น Overdue เมื่อ test รันหลังวันนั้น
    const { ws, lead, devId } = team;
    const now = today();
    const fp = await newProject({ name: 'Floor Plan', key: 'FP', modules: ['Credit Line', 'Drawdown'], milestones: [{ name: 'Credit Line Go-live', date: '2027-01-26' }] });
    const [credit, draw] = fp.modules.map((m: { id: string }) => m.id);
    await joinProject(devId, 'FP', 'member');
    await joinProject(pondId, 'FP', 'member');
    await joinProject(guestId, 'FP', 'viewer');
    const create = async (body: Record<string, unknown>) => {
      const r = await lead.post(`${ws}/projects/FP/issues`, { moduleId: credit, ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { key: string };
    };
    const late = await create({ title: 'ตรวจเอกสารวงเงิน', estimateMd: 1, planEnd: addDays(now, -3), assigneeIds: [devId] });
    await create({ title: 'อนุมัติวงเงิน', estimateMd: 1, planEnd: now, assigneeIds: [pondId] });
    const finished = await create({ title: 'ตั้งค่า Product', estimateMd: 2, assigneeIds: [devId] });
    await create({ title: 'หน้าจอเบิกใช้', moduleId: draw, estimateMd: 3, planStart: '2099-02-02', planEnd: '2099-02-04', assigneeIds: [pondId] });
    const done = fp.statuses.find((x: { name: string; boardColumnId: string | null }) => x.name === 'Done' && !x.boardColumnId).id;
    expect((await lead.post(`${ws}/issues/${finished.key}/move`, { statusId: done })).status).toBe(200);
    const bug = await create({ type: 'Bug', title: 'ยอดวงเงินไม่ตรง', severity: 'major', environment: 'sit', details: { steps: '1. เปิดหน้าวงเงิน' }, assigneeIds: [devId] });

    const r = await lead.get(`${ws}/projects/FP/overview`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const o = r.body;
    expect(o.today).toBe(now);
    expect(o.project).toMatchObject({ key: 'FP', name: 'Floor Plan', owner: { id: team.leadId, displayName: 'Mick' }, progressMethod: 'weighted', memberCount: 4 });
    expect(o.kpis).toMatchObject({ total: 5, done: 1, overdue: 1, dueToday: 1, doneLast7Days: 1, md: { done: 2, total: 7 } });
    expect(o.progress).toMatchObject({ tasks: { done: 1, total: 4 }, md: { done: 2, total: 7, pct: 29 }, lastPlanEnd: '2099-02-04' });
    expect(o.lists.overdue).toHaveLength(1);
    expect(o.lists.overdue[0]).toMatchObject({ key: late.key, lateDays: 3, assignees: [{ id: devId, displayName: 'Kaijeaw' }], module: { name: 'Credit Line' } });
    expect(o.lists.dueToday.map((i: { title: string }) => i.title)).toEqual(['อนุมัติวงเงิน']);
    expect(o.lists.doneLast7Days[0]).toMatchObject({ key: finished.key, completedOn: now });
    expect(o.doneDaily).toHaveLength(7);
    expect(o.doneDaily[6]).toMatchObject({ date: now, count: 1 });
    expect(o.burnup).toMatchObject({ unit: 'md', total: 7 });
    expect(o.burnup.points[0].weekStart).toBe(weekOf('2026-11-05').start);
    expect(o.burnup.points.find((x: { weekEnd: string }) => x.weekEnd >= now).done).toBe(2);
    expect(o.burnup.points.at(-1).done).toBeNull();
    expect(o.modules.map((m: { name: string; total: number; overdue: number }) => [m.name, m.total, m.overdue])).toEqual([
      ['Credit Line', 3, 1],
      ['Drawdown', 1, 0],
    ]);
    expect(o.modules[1]).toMatchObject({ notStarted: true, startDate: '2099-02-02', pct: 0 });
    expect(o.statusBreakdown.columns.map((c: { name: string; count: number }) => [c.name, c.count])).toEqual([
      ['To do', 4],
      ['In progress', 0],
      ['Review', 0],
      ['Done', 1],
    ]);
    expect(o.milestones[0]).toMatchObject({ name: 'Credit Line Go-live', date: '2027-01-26', basis: 'project', linkedIssues: 0, donePct: o.progress.pct });
    expect(o.workloadThisWeek.from).toBe(weekOf(now).start);
    expect(o.activity.length).toBeGreaterThan(0);
    expect(o.activity.length).toBeLessThanOrEqual(10);
    expect(o.activity[0]).toMatchObject({ actor: { displayName: 'Mick' }, issue: { key: bug.key }, verb: 'created' });
    expect(o.counts).toEqual({ openBugs: 1, pendingDueRequests: 0 });

    // งานของฉัน: Dev เห็นเฉพาะงานที่ตัวเองเป็นผู้รับผิดชอบ
    const mine = await team.dev.get(`${ws}/projects/FP/overview?scope=mine`);
    expect(mine.body.kpis).toMatchObject({ total: 3, overdue: 1, dueToday: 0 });
    expect(mine.body.workloadThisWeek.people.every((x: { person: { id: string } }) => x.person.id === devId)).toBe(true);
    const drawdownOnly = await lead.get(`${ws}/projects/FP/overview?moduleId=${draw}`);
    expect(drawdownOnly.body.kpis).toMatchObject({ total: 1, overdue: 0 });
    expect((await lead.get(`${ws}/projects/FP/overview?scope=team`)).status).toBe(400);

    // Guest ที่เป็น Viewer: ไม่เห็นชื่อคน, Bug และ Workload
    const g = await guest.get(`${ws}/projects/FP/overview`);
    expect(g.status).toBe(200);
    expect(g.body.kpis.total).toBe(4);
    expect(g.body.statusBreakdown.total).toBe(4);
    expect(g.body.workloadThisWeek).toBeNull();
    expect(g.body.counts).toBeNull();
    expect(g.body.project.owner).toEqual({ displayName: 'ทีมพัฒนา', initials: '', avatarUrl: null });
    expect(g.body.health.overdue).toEqual({ count: 1 });
    expect(g.body.lists.overdue[0]).not.toHaveProperty('assignees');
    expect(g.body.lists.overdue[0]).toHaveProperty('canOpen', false);
    expect(g.body.activity.length).toBeGreaterThan(0);
    expect(g.body.activity.every((a: { actor: { displayName: string } | null }) => !a.actor || a.actor.displayName === 'ทีมพัฒนา')).toBe(true);
    const text = JSON.stringify(g.body);
    for (const hidden of ['Kaijeaw', 'Pond', 'Mick', bug.key, 'ยอดวงเงินไม่ตรง']) expect(text).not.toContain(hidden);
  });
});
