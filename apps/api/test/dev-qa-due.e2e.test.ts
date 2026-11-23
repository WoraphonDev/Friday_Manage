// วันครบกำหนดแยก Dev / QA (ผู้ใช้ขอ 2026-11-13) · ข้อมูลสมมติเท่านั้น
// งานที่ Dev ส่งให้ QA แล้วต้องไม่ขึ้นเลยกำหนดตาม Plan End · ตัดสินด้วย QA Due แทน
// QA ตีกลับ: นับความช้าของ Dev ต่อจากเดิม ไม่รวมวันที่อยู่กับ QA (2026-11-23)
// โปรเจกต์ที่ไม่ได้แยก Dev / QA ต้องได้ผลเหมือนเดิมทุกอย่าง
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;

type St = { id: string; name: string; boardColumnId: string | null };
type Keyed = { key: string };

const bangkok = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(d);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const now = bangkok(new Date());
const yesterday = addDays(now, -1);
const longAgo = addDays(now, -30);
const keys = (list: Keyed[]) => list.map((x) => x.key).sort();

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
});
afterAll(() => t.close());

describe('โปรเจกต์ Development + QA: งานที่ส่ง QA แล้วใช้ QA Due', () => {
  const k: Record<string, string> = {};

  beforeAll(async () => {
    const { ws, lead } = team;
    expect((await lead.post(`${ws}/projects`, { name: 'Dev QA Due', key: 'DQD', startDate: addDays(now, -60), goliveDate: addDays(now, 60), builtinTemplate: 'development_qa', modules: ['Core'] })).status).toBe(201);
    await t.owner.query(
      `INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, $1, 'member' FROM projects WHERE key = 'DQD'`,
      [team.devId],
    );
    const p = (await lead.get(`${ws}/projects/DQD`)).body;
    expect(p.progressSplit).toBe(true);
    expect(p.qaBufferDays).toBe(2);
    const st = (name: string) => p.statuses.find((s: St) => s.name === name && !s.boardColumnId).id;
    const mk = async (title: string, planEnd: string, status: string, extra: Record<string, unknown> = {}) => {
      const r = await lead.post(`${ws}/projects/DQD/issues`, { title, moduleId: p.modules[0].id, size: 'S', planStart: addDays(now, -45), planEnd, reviewerId: team.leadId, assigneeIds: [team.devId], ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      if (status !== 'To do') expect((await lead.post(`${ws}/issues/${r.body.key}/move`, { statusId: st(status) })).status).toBe(200);
      return r.body.key as string;
    };
    k.devLate = await mk('Dev ยังไม่ส่ง', yesterday, 'In progress');
    k.waitingQa = await mk('ส่ง QA เมื่อวาน', yesterday, 'Ready for QA');
    k.qaLate = await mk('QA ค้างนาน', longAgo, 'Testing');
    k.qaDueSet = await mk('QA Due ที่กรอกเลยแล้ว', yesterday, 'Ready for QA', { qaEnd: yesterday });
    k.done = await mk('ผ่าน QA แล้ว', longAgo, 'Done');
  });

  it('งานรอ QA ที่ยังไม่เลย QA Due ไม่ขึ้นเลยกำหนด · QA Due ไม่กรอก = Plan End + 2 วันทำการ', async () => {
    const { ws, lead } = team;
    const waiting = (await lead.get(`${ws}/issues/${k.waitingQa}`)).body;
    expect(waiting.qaEnd).toBeNull();
    expect(waiting.dueStage).toBe('qa');
    expect(waiting.qaDue > now).toBe(true);
    expect(waiting.dueDate).toBe(waiting.qaDue);
    const dev = (await lead.get(`${ws}/issues/${k.devLate}`)).body;
    expect(dev).toMatchObject({ dueStage: 'dev', dueDate: yesterday });
    expect((await lead.get(`${ws}/issues/${k.qaDueSet}`)).body).toMatchObject({ qaEnd: yesterday, qaDue: yesterday, dueStage: 'qa' });

    const ov = (await lead.get(`${ws}/projects/DQD/overview`)).body;
    expect(ov.kpis.overdue).toBe(3);
    expect(keys(ov.lists.overdue)).toEqual([k.devLate, k.qaLate, k.qaDueSet].sort());
    expect(ov.lists.overdue.find((x: Keyed) => x.key === k.qaLate).dueStage).toBe('qa');
    expect(ov.modules[0].overdue).toBe(3);

    const table = (await lead.get(`${ws}/projects/DQD/issues?overdue=true`)).body;
    expect(keys(table.items)).toEqual([k.devLate, k.qaLate, k.qaDueSet].sort());
    const notLate = (await lead.get(`${ws}/projects/DQD/issues?overdue=false`)).body;
    expect(keys(notLate.items)).toEqual([k.waitingQa, k.done].sort());

    const tl = (await lead.get(`${ws}/projects/DQD/timeline`)).body;
    const rows = tl.modules.flatMap((m: { groups: { tasks: (Keyed & { lateDays: number })[] }[] }) => m.groups.flatMap((g) => g.tasks));
    const late = (key: string) => rows.find((r: Keyed) => r.key === key)?.lateDays ?? null;
    expect(late(k.waitingQa)).toBe(0);
    expect(late(k.devLate)).toBe(1);
  });

  it('Home / My Tasks / รายงาน: งานเลยกำหนดขั้น QA นับให้ QA / Reviewer ไม่ใช่ Dev', async () => {
    const { ws, lead, dev } = team;
    const home = (await lead.get(`${ws}/home`)).body;
    const dqd = home.projects.find((p: { key: string }) => p.key === 'DQD');
    expect(dqd.overdue).toBe(3);

    const mine = (await dev.get(`${ws}/my-issues?projectKey=DQD`)).body;
    const items = mine.groups ? mine.groups.flatMap((g: { items: unknown[] }) => g.items) : mine.items;
    const due = (key: string) => items.find((x: Keyed) => x.key === key)?.due;
    expect(due(k.waitingQa).state).not.toBe('overdue');
    expect(due(k.qaLate)).toMatchObject({ state: 'overdue', stage: 'qa' });

    const weekly = (await lead.get(`${ws}/projects/DQD/reports/weekly`)).body;
    expect(weekly.totals.overdue).toBe(3);
    const by = new Map(weekly.thisWeek.overdue.byAssignee.map((x: { id: string; count: number }) => [x.id, x.count]));
    // Dev รับผิดชอบเฉพาะงานที่ยังไม่ส่ง QA · งานที่ QA ค้าง 2 งานเป็นของ QA / Reviewer
    expect(by.get(team.devId)).toBe(1);
    expect(by.get(team.leadId)).toBe(2);

    const members = (await lead.get(`${ws}/projects/DQD/members`)).body;
    const devRow = (members.items ?? members).find((m: { userId: string }) => m.userId === team.devId);
    if (devRow && 'overdueIssues' in devRow) expect(devRow.overdueIssues).toBe(1);
  });

  it('กรอก QA Due ได้ · ห้ามก่อน Plan End · ล้างค่ากลับไปใช้ค่าอัตโนมัติ', async () => {
    const { ws, lead } = team;
    const issue = (await lead.get(`${ws}/issues/${k.waitingQa}`)).body;
    const bad = await lead.patch(`${ws}/issues/${k.waitingQa}`, { qaEnd: addDays(yesterday, -1) }, issue.version);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_qa_end');
    const set = await lead.patch(`${ws}/issues/${k.waitingQa}`, { qaEnd: yesterday }, issue.version);
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ qaEnd: yesterday, qaDue: yesterday });
    expect((await lead.get(`${ws}/projects/DQD/overview`)).body.kpis.overdue).toBe(4);
    const cleared = await lead.patch(`${ws}/issues/${k.waitingQa}`, { qaEnd: null }, set.body.version);
    expect(cleared.status).toBe(200);
    expect(cleared.body.qaEnd).toBeNull();
    expect(cleared.body.qaDue > now).toBe(true);
  });

  it('ตั้งวันเผื่อ QA เป็น 0 = QA ต้องเสร็จวันเดียวกับ Dev · ปิดแยก Dev / QA = กลับเป็น Plan End', async () => {
    const { ws, lead } = team;
    let p = (await lead.get(`${ws}/projects/DQD`)).body;
    expect((await lead.patch(`${ws}/projects/DQD`, { qaBufferDays: 31 }, p.version)).status).toBe(400);
    const r = await lead.patch(`${ws}/projects/DQD`, { qaBufferDays: 0 }, p.version);
    expect(r.status).toBe(200);
    expect(r.body.qaBufferDays).toBe(0);
    expect((await lead.get(`${ws}/projects/DQD/overview`)).body.kpis.overdue).toBe(4);

    p = (await lead.get(`${ws}/projects/DQD`)).body;
    expect((await lead.patch(`${ws}/projects/DQD`, { qaBufferDays: 2, progressSplit: false }, p.version)).status).toBe(200);
    const off = (await lead.get(`${ws}/projects/DQD/overview`)).body;
    expect(off.kpis.overdue).toBe(4);
    expect(off.lists.overdue[0].dueStage).toBeUndefined();
    expect((await lead.get(`${ws}/issues/${k.waitingQa}`)).body.dueStage).toBeUndefined();
  });
});

describe('โปรเจกต์ Development + QA: หยุดนาฬิกาของ Dev ระหว่างอยู่กับ QA (ผู้ใช้ขอ 2026-11-23)', () => {
  const k: Record<string, string> = {};
  let st: (name: string) => string;
  const issueRow = async (key: string) => (await t.owner.query(
    `SELECT i.id, i.qa_hold_days AS "holdDays", to_char(i.qa_since, 'YYYY-MM-DD') AS "since" FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key || '-' || i.number = $1`,
    [key],
  )).rows[0] as { id: string; holdDays: number; since: string | null };
  // จำลองว่างานเข้าช่วง QA มาแล้ว n วัน (เวลาจริงในการทดสอบผ่านไม่ถึงวัน)
  const inQaFor = (id: string, days: number) => t.owner.query(`UPDATE issues SET qa_since = $2 WHERE id = $1`, [id, addDays(now, -days)]);
  const move = (key: string, status: string) => team.lead.post(`${team.ws}/issues/${key}/move`, { statusId: st(status) });

  beforeAll(async () => {
    const { ws, lead } = team;
    expect((await lead.post(`${ws}/projects`, { name: 'Dev QA Rework', key: 'DQR', startDate: addDays(now, -60), goliveDate: addDays(now, 60), builtinTemplate: 'development_qa', modules: ['Core'] })).status).toBe(201);
    const p = (await lead.get(`${ws}/projects/DQR`)).body;
    st = (name: string) => p.statuses.find((s: St) => s.name === name && !s.boardColumnId).id;
    const mk = async (title: string, planEnd: string) => {
      const r = await lead.post(`${ws}/projects/DQR/issues`, { title, moduleId: p.modules[0].id, size: 'S', planStart: addDays(now, -45), planEnd, reviewerId: team.leadId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await move(r.body.key, 'In progress')).status).toBe(200);
      return r.body.key as string;
    };
    // ส่ง QA ช้าไป 1 วัน · อยู่กับ QA 4 วัน · ตีกลับ = ยังช้า 1 วันเท่าเดิม (ไม่ใช่ 5)
    k.lateBefore = await mk('ส่ง QA ช้า แล้วถูกตีกลับ', addDays(now, -5));
    // ส่ง QA ก่อนกำหนด 1 วัน · อยู่กับ QA 4 วัน · ตีกลับ = ยังเหลือเวลา 1 วัน
    k.early = await mk('ส่ง QA ก่อนกำหนด แล้วถูกตีกลับ', addDays(now, -3));
    k.never = await mk('ยังไม่เคยส่ง QA', yesterday);
  });

  it('เข้าช่วง QA เริ่มนับ · ย้ายภายในช่วง QA ไม่รีเซ็ต · QA ตีกลับ = เลื่อน Due ของ Dev ตามวันที่อยู่กับ QA', async () => {
    for (const key of [k.lateBefore, k.early]) {
      expect((await move(key, 'Ready for QA')).status).toBe(200);
      const r = await issueRow(key);
      expect(r).toMatchObject({ holdDays: 0, since: now });
      await inQaFor(r.id, 4);
      expect((await move(key, 'Testing')).status).toBe(200);
      expect((await issueRow(key)).since).toBe(addDays(now, -4));
      expect((await move(key, 'Rework')).status).toBe(200);
      expect(await issueRow(key)).toMatchObject({ holdDays: 4, since: null });
    }

    const { ws, lead } = team;
    expect((await lead.get(`${ws}/issues/${k.lateBefore}`)).body).toMatchObject({ dueStage: 'dev', dueDate: yesterday, planEnd: addDays(now, -5) });
    expect((await lead.get(`${ws}/issues/${k.early}`)).body).toMatchObject({ dueStage: 'dev', dueDate: addDays(now, 1) });

    const table = (await lead.get(`${ws}/projects/DQR/issues?overdue=true`)).body;
    expect(keys(table.items)).toEqual([k.lateBefore, k.never].sort());
    const ov = (await lead.get(`${ws}/projects/DQR/overview`)).body;
    expect(keys(ov.lists.overdue)).toEqual([k.lateBefore, k.never].sort());
    expect(ov.lists.overdue.find((x: Keyed) => x.key === k.lateBefore).lateDays).toBe(1);

    const tl = (await lead.get(`${ws}/projects/DQR/timeline`)).body;
    const rows = tl.modules.flatMap((m: { groups: { tasks: (Keyed & { lateDays: number })[] }[] }) => m.groups.flatMap((g) => g.tasks));
    const late = (key: string) => rows.find((r: Keyed) => r.key === key)?.lateDays ?? null;
    expect(late(k.lateBefore)).toBe(1);
    expect(late(k.early)).toBe(0);
  });

  it('ส่ง QA รอบสองแล้วถูกตีกลับอีก = วันที่อยู่กับ QA สะสมต่อ', async () => {
    expect((await move(k.lateBefore, 'Ready for QA')).status).toBe(200);
    await inQaFor((await issueRow(k.lateBefore)).id, 2);
    expect((await move(k.lateBefore, 'In progress')).status).toBe(200);
    expect(await issueRow(k.lateBefore)).toMatchObject({ holdDays: 6, since: null });
    // Plan End -5 + 6 วัน = พรุ่งนี้ · ไม่เลยกำหนดแล้ว
    expect((await team.lead.get(`${team.ws}/issues/${k.lateBefore}`)).body.dueDate).toBe(addDays(now, 1));
  });

  it('ปิดแยก Dev / QA = กลับเป็น Plan End เดิม (ไม่เลื่อน)', async () => {
    const { ws, lead } = team;
    const p = (await lead.get(`${ws}/projects/DQR`)).body;
    expect((await lead.patch(`${ws}/projects/DQR`, { progressSplit: false }, p.version)).status).toBe(200);
    const table = (await lead.get(`${ws}/projects/DQR/issues?overdue=true`)).body;
    expect(keys(table.items)).toEqual([k.lateBefore, k.early, k.never].sort());
  });
});

describe('โปรเจกต์ที่ไม่ได้แยก Dev / QA: ได้ผลเหมือนเดิม', () => {
  it('งานหมวด Review ที่เลย Plan End ยังขึ้นเลยกำหนด · ไม่มี qaDue / dueStage', async () => {
    const { ws, lead, project } = team;
    const st = (name: string) => project.statuses.find((s: St) => s.name === name && !s.boardColumnId).id;
    const r = await lead.post(`${ws}/projects/DP/issues`, { title: 'รอตรวจ', moduleId: project.modules[0].id, size: 'S', planEnd: yesterday, reviewerId: team.leadId });
    expect(r.status).toBe(201);
    expect((await lead.post(`${ws}/issues/${r.body.key}/move`, { statusId: st('Review') })).status).toBe(200);

    const issue = (await lead.get(`${ws}/issues/${r.body.key}`)).body;
    expect(issue.qaEnd).toBeNull();
    expect(issue.qaDue).toBeUndefined();
    expect(issue.dueStage).toBeUndefined();
    const ov = (await lead.get(`${ws}/projects/DP/overview`)).body;
    expect(keys(ov.lists.overdue)).toContain(r.body.key);
    const table = (await lead.get(`${ws}/projects/DP/issues?overdue=true`)).body;
    expect(keys(table.items)).toContain(r.body.key);
    expect((await lead.get(`${ws}/projects/DP`)).body.progressSplit).toBe(false);
  });
});
