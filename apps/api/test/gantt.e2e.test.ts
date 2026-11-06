// A07 · Gantt, Baseline, การแก้ไขแผน และ Auto-schedule · ข้อมูลสมมติเท่านั้น
// วันหยุดในฐานทดสอบ: จ. 7 ธ.ค. และ พฤ. 10 ธ.ค. 2569 (seedHolidays)
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkCalendar } from '../src/projects/calendar.js';
import { Axis, autoSchedule, criticalPath } from '../src/gantt/cpm.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let viewer: Client;
let guest: Client;
let seq = 0;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  viewer = await client(t.app);
  guest = await client(t.app);
  const viewerId = await signup(viewer, 'viewer@gantt.example.com', 'Viewer');
  const guestId = await signup(guest, 'guest@gantt.example.com', 'Guest');
  await addMember(t.owner, team.slug, viewerId, 'member', { key: team.key, role: 'viewer' });
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });
});
afterAll(() => t.close());

/** โปรเจกต์ใหม่ต่อกรณี เพื่อไม่ให้แผนของกรณีหนึ่งปนกับอีกกรณี */
async function fixture() {
  const key = `G${++seq}`;
  const r = await team.lead.post(`${team.ws}/projects`, { key, name: `Gantt ${seq}`, startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['Demo'], sprintLengthWeeks: null });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const project = (await team.lead.get(`${team.ws}/projects/${key}`)).body;
  const base = `${team.ws}/projects/${key}`;
  const make = async (title: string, start: string | null, end: string | null) => {
    const c = await team.lead.post(`${team.ws}/projects/${key}/issues`, { title, moduleId: project.modules[0].id });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await t.owner.query('UPDATE issues SET plan_start = $1, plan_end = $2 WHERE id = $3', [start, end, c.body.id]);
    return c.body as { id: string; key: string };
  };
  const dep = async (pred: { key: string }, succ: { key: string }, type = 'FS', lagDays = 0) => {
    const d = await team.lead.post(`${team.ws}/issues/${succ.key}/dependencies`, { predecessorKey: pred.key, type, lagDays });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
  };
  const addViewer = async (email: string) => {
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, (SELECT id FROM users WHERE email = $2), 'viewer' FROM projects WHERE key = $1 ON CONFLICT DO NOTHING`, [key, email]);
  };
  const markDone = async (i: { id: string }) => {
    await t.owner.query(`UPDATE issues SET status_id = (SELECT id FROM workflow_statuses WHERE project_id = $2 AND category = 'done' LIMIT 1) WHERE id = $1`, [i.id, project.id]);
  };
  return { key, base, project, make, dep, markDone, addViewer, gantt: (qs = '') => team.lead.get(`${base}/gantt${qs}`) };
}

/** Task ทั้งหมดใน Gantt เรียงเป็นแผนที่ key → แถว */
function rowsOf(body: { modules: Array<{ groups: Array<{ tasks: Array<Record<string, unknown> & { key: string; subtasks: Array<Record<string, unknown> & { key: string }> }> }> }> }) {
  const out = new Map<string, Record<string, unknown>>();
  for (const m of body.modules) for (const g of m.groups) for (const task of g.tasks) { out.set(task.key, task); for (const sub of task.subtasks) out.set(sub.key, sub); }
  return out;
}

describe('GET p/gantt · Critical path', () => {
  it('งาน 4 งานที่มีทางแยก: A→B→D วิกฤต, C มี slack 2 วัน', async () => {
    const f = await fixture();
    const a = await f.make('A', '2026-11-09', '2026-11-13'); // จ.–ศ. 5 วัน
    const b = await f.make('B', '2026-11-16', '2026-11-18'); // 3 วัน
    const c = await f.make('C', '2026-11-16', '2026-11-16'); // 1 วัน
    const d = await f.make('D', '2026-11-19', '2026-11-20'); // 2 วัน
    await f.dep(a, b); await f.dep(a, c); await f.dep(b, d); await f.dep(c, d);

    const r = await f.gantt();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = rowsOf(r.body);
    expect([a, b, c, d].map((x) => rows.get(x.key)!.critical)).toEqual([true, true, false, true]);
    expect([a, b, c, d].map((x) => rows.get(x.key)!.slackDays)).toEqual([0, 0, 2, 0]);
    expect(r.body.criticalPath).toEqual({ keys: [a.key, b.key, d.key], startDate: '2026-11-09', endDate: '2026-11-20' });
    const flag = (from: { key: string }, to: { key: string }) => r.body.dependencies.find((x: { from: string; to: string }) => x.from === from.key && x.to === to.key).critical;
    expect([flag(a, b), flag(a, c), flag(b, d), flag(c, d)]).toEqual([true, false, true, false]);
    expect(r.body.baseline).toBeNull();
    expect(r.body.modules[0].groups[0].tasks).toHaveLength(4);
  });

  it('คิดเฉพาะงานที่ยังไม่เสร็จและมีวันที่ · งานเสร็จแล้วและงานไม่มีวันที่ไม่อยู่ในเส้นวิกฤต', async () => {
    const f = await fixture();
    const a = await f.make('A', '2026-11-09', '2026-11-13');
    const b = await f.make('B', '2026-11-16', '2026-11-18');
    const c = await f.make('C', '2026-11-16', '2026-11-16');
    const d = await f.make('D', '2026-11-19', '2026-11-20');
    const nodate = await f.make('ยังไม่ลงแผน', null, null);
    await f.dep(a, b); await f.dep(a, c); await f.dep(b, d); await f.dep(c, d); await f.dep(nodate, d);
    await f.markDone(a);
    const r = await f.gantt();
    const rows = rowsOf(r.body);
    expect(r.body.criticalPath.keys).toEqual([b.key, d.key]);
    expect(rows.get(a.key)).toMatchObject({ critical: false, slackDays: null });
    expect(rows.get(c.key)).toMatchObject({ slackDays: 2 });
    expect(r.body.unscheduled.map((x: { key: string }) => x.key)).toContain(nodate.key);
  });

  it('นับวันทำการ: ข้ามวันหยุด 7 และ 10 ธ.ค. · lag ถูกนับเข้า slack', async () => {
    const f = await fixture();
    const a = await f.make('A', '2026-12-03', '2026-12-04'); // พฤ.–ศ.
    const b = await f.make('B', '2026-12-08', '2026-12-09'); // อ.–พ. (7 ธ.ค. หยุด) ต่อจาก A ทันที
    const c = await f.make('C', '2026-12-08', '2026-12-08'); // 1 วัน
    const d = await f.make('D', '2026-12-14', '2026-12-14'); // หลัง 10 ธ.ค. หยุด + lag 1
    await f.dep(a, b); await f.dep(a, c); await f.dep(b, d, 'FS', 1); await f.dep(c, d, 'FS', 1);
    const rows = rowsOf((await f.gantt()).body);
    // B จบ 9 ธ.ค. → วันทำการถัดไป 11 ธ.ค. (lag 1 = เว้น 1 วันทำการ) → D เริ่มได้ 14 ธ.ค. พอดี
    expect(rows.get(b.key)).toMatchObject({ critical: true, slackDays: 0 });
    expect(rows.get(d.key)).toMatchObject({ critical: true });
    expect(rows.get(c.key)).toMatchObject({ critical: false, slackDays: 1 });
  });

  it('Dependency วนเป็นวง → 422 บอกงานที่วน', async () => {
    const f = await fixture();
    const a = await f.make('A', '2026-11-09', '2026-11-10');
    const b = await f.make('B', '2026-11-11', '2026-11-12');
    await f.dep(a, b);
    await t.owner.query('INSERT INTO issue_dependencies (workspace_id, predecessor_id, successor_id) SELECT workspace_id, $2, $1 FROM issues WHERE id = $1', [a.id, b.id]);
    const r = await f.gantt();
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'dependency_cycle', details: { keys: expect.arrayContaining([a.key, b.key]) } });
  });

  it('Dependency ที่ผูกกับงานแม่ถูกข้ามและแจ้งจำนวน · Sub-task เป็นโหนดแทน', async () => {
    const f = await fixture();
    const parent = await f.make('งานแม่', '2026-11-09', '2026-11-13');
    const other = await f.make('งานอื่น', '2026-11-16', '2026-11-17');
    const sub = await team.lead.post(`${team.ws}/projects/${f.key}/issues`, { title: 'งานย่อย', moduleId: f.project.modules[0].id, parentKey: parent.key });
    await t.owner.query(`UPDATE issues SET plan_start = '2026-11-09', plan_end = '2026-11-10' WHERE id = $1`, [sub.body.id]);
    await f.dep(parent, other);
    const r = await f.gantt();
    expect(r.body.ignoredDependencies).toBe(1);
    expect(r.body.criticalPath.keys).toEqual([]);
    expect(rowsOf(r.body).get(sub.body.key)).toBeDefined();
  });

  it('Guest ดู Gantt ไม่ได้ · สมาชิกที่เป็น Viewer ดูได้ · ช่วง from/to ใช้กรองแถว', async () => {
    const f = await fixture();
    await f.make('ต้นเดือน', '2026-11-09', '2026-11-10');
    await f.make('ปลายเดือน', '2026-11-26', '2026-11-27');
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, (SELECT id FROM users WHERE email = 'guest@gantt.example.com'), 'viewer' FROM projects WHERE key = $1`, [f.key]);
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, (SELECT id FROM users WHERE email = 'viewer@gantt.example.com'), 'viewer' FROM projects WHERE key = $1`, [f.key]);
    const g = await guest.get(`${f.base}/gantt`);
    expect(g.status).toBe(403);
    expect(g.body.error.code).toBe('guest_view_limited');
    expect((await viewer.get(`${f.base}/gantt`)).status).toBe(200);
    const ranged = await f.gantt('?from=2026-11-20&to=2026-11-30');
    expect([...rowsOf(ranged.body).keys()]).toHaveLength(1);
    expect((await f.gantt('?from=2026-12-01&to=2026-11-01')).status).toBe(400);
    expect((await f.gantt('?baseline=latest')).status).toBe(400);
  });
});

describe('Baseline', () => {
  it('ตั้ง Baseline v1 และ v2: เลขขึ้นทีละ 1, เก็บวันของทุกงาน, เทียบกับแผนปัจจุบันใน Gantt', async () => {
    const f = await fixture();
    const a = await f.make('A', '2026-11-09', '2026-11-13');
    const b = await f.make('B', '2026-11-16', '2026-11-18');
    const none = await f.make('ยังไม่ลงแผน', null, null);
    await t.owner.query(`INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) SELECT workspace_id, id, $2, 0 FROM issues WHERE id = $1`, [a.id, team.devId]);

    const v1 = await team.lead.post(`${f.base}/baselines`, { name: 'แผนตั้งต้น' });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, name: 'แผนตั้งต้น', source: 'manual', itemCount: 3 });
    const items = await t.owner.query('SELECT plan_start::text, plan_end::text, assignee_ids FROM baseline_items i JOIN plan_baselines b ON b.id = i.baseline_id WHERE b.project_id = $1 AND i.issue_id = $2', [f.project.id, a.id]);
    expect(items.rows[0]).toEqual({ plan_start: '2026-11-09', plan_end: '2026-11-13', assignee_ids: [team.devId] });
    expect((await t.owner.query('SELECT plan_start FROM baseline_items WHERE issue_id = $1', [none.id])).rows[0].plan_start).toBeNull();

    // เลื่อน B ออกไป 2 วัน แล้วตั้ง v2
    await t.owner.query(`UPDATE issues SET plan_end = '2026-11-20' WHERE id = $1`, [b.id]);
    const v2 = await team.lead.post(`${f.base}/baselines`, {});
    expect(v2.body).toMatchObject({ version: 2, name: 'Baseline v2', itemCount: 3 });

    const list = await team.lead.get(`${f.base}/baselines`);
    expect(list.body.items.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    expect(list.body.items[1]).toMatchObject({ itemCount: 3, createdBy: { displayName: 'Mick' } });

    const against1 = rowsOf((await f.gantt('?baseline=v1')).body);
    expect(against1.get(b.key)).toMatchObject({ baseline: { start: '2026-11-16', end: '2026-11-18' }, slipDays: 2 });
    expect(against1.get(a.key)).toMatchObject({ slipDays: 0 });
    const against2 = rowsOf((await f.gantt('?baseline=2')).body);
    expect(against2.get(b.key)).toMatchObject({ slipDays: 0 });
    const body = (await f.gantt('?baseline=v1')).body;
    expect(body.baseline).toMatchObject({ version: 1, name: 'แผนตั้งต้น' });
    expect(body.baselines.map((x: { version: number }) => x.version)).toEqual([1, 2]);
    const missing = await f.gantt('?baseline=v9');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'baseline_not_found', details: { versions: [1, 2] } });
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'baseline.created' AND summary LIKE $1`, [`${f.key} ·%`])).rowCount).toBe(2);
  });

  it('ตั้งพร้อมกันไม่ได้เลขซ้ำ · สิทธิ์: ต้องมี project.baseline', async () => {
    const f = await fixture();
    await f.make('A', '2026-11-09', '2026-11-10');
    const both = await Promise.all([team.lead.post(`${f.base}/baselines`, {}), team.lead.post(`${f.base}/baselines`, {})]);
    expect(both.map((x) => x.status)).toEqual([201, 201]);
    expect(both.map((x) => x.body.version).sort()).toEqual([1, 2]);

    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, $2, 'member' FROM projects WHERE key = $1`, [f.key, team.devId]);
    const denied = await team.dev.post(`${f.base}/baselines`, {});
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('project.baseline');
    expect((await team.dev.get(`${f.base}/baselines`)).status).toBe(200);
    await f.addViewer('guest@gantt.example.com');
    expect((await guest.get(`${f.base}/baselines`)).status).toBe(403);
    expect((await team.lead.post(`${f.base}/baselines`, { name: '' })).status).toBe(400);
  });
});

describe('การแก้ไขแผน (Plan vs Baseline)', () => {
  async function withChanges() {
    const f = await fixture();
    const a = await f.make('งาน A', '2026-11-09', '2026-11-13');
    const b = await f.make('งาน B', '2026-11-16', '2026-11-18');
    const v1 = (await team.lead.post(`${f.base}/baselines`, {})).body;
    const v2 = (await team.lead.post(`${f.base}/baselines`, {})).body;
    const add = (issue: { id: string }, baselineId: string, field: string, from: unknown, to: unknown, reason: string, at: string, source = 'manual') =>
      t.owner.query(
        `INSERT INTO plan_changes (workspace_id, project_id, issue_id, baseline_id, field, old_value, new_value, reason, impact, source, changed_by, changed_at)
         SELECT workspace_id, project_id, id, $2, $3, $4::jsonb, $5::jsonb, $6, 'เพิ่ม 2 วันทำการ', $8, $9, $7 FROM issues WHERE id = $1`,
        [issue.id, baselineId, field, JSON.stringify(from), JSON.stringify(to), reason, at, source, team.leadId],
      );
    await add(a, v1.id, 'planEnd', '2026-11-13', '2026-11-17', 'BA ขอเพิ่มฟอร์ม', '2026-11-10T03:00:00Z', 'due_request');
    await add(b, v1.id, 'estimateMd', 3, 5, 'ประเมินใหม่', '2026-11-11T03:00:00Z');
    await add(b, v2.id, 'planStart', '2026-11-16', '2026-11-18', 'รอ API', '2026-11-12T03:00:00Z');
    return { f, a, b, v1, v2 };
  }

  it('GET p/plan-changes: เรียงใหม่ก่อน, กรองตาม Baseline, แบ่งหน้า', async () => {
    const { f, a, b } = await withChanges();
    const all = await team.lead.get(`${f.base}/plan-changes`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.items.map((x: { field: string }) => x.field)).toEqual(['planStart', 'estimateMd', 'planEnd']);
    expect(all.body.items[2]).toMatchObject({ issueKey: a.key, title: 'งาน A', fieldLabel: 'Plan End', oldValue: '2026-11-13', newValue: '2026-11-17', reason: 'BA ขอเพิ่มฟอร์ม', impact: 'เพิ่ม 2 วันทำการ', source: 'due_request', baselineVersion: 1, changedBy: { displayName: 'Mick' } });
    expect(all.body.items[1]).toMatchObject({ issueKey: b.key, fieldLabel: 'Man-Day', oldValue: 3, newValue: 5 });

    expect((await team.lead.get(`${f.base}/plan-changes?baseline=v1`)).body.items).toHaveLength(2);
    expect((await team.lead.get(`${f.base}/plan-changes?baseline=2`)).body.items).toHaveLength(1);
    expect((await team.lead.get(`${f.base}/plan-changes?baseline=v7`)).status).toBe(404);

    const page1 = await team.lead.get(`${f.base}/plan-changes?limit=2`);
    expect(page1.body.items).toHaveLength(2);
    const page2 = await team.lead.get(`${f.base}/plan-changes?limit=2&before=${encodeURIComponent(page1.body.nextCursor)}`);
    expect(page2.body.items.map((x: { field: string }) => x.field)).toEqual(['planEnd']);
    expect(page2.body.nextCursor).toBeNull();
    await f.addViewer('guest@gantt.example.com');
    expect((await guest.get(`${f.base}/plan-changes`)).status).toBe(403);
  });

  it('GET p/plan-changes.xlsx: ไฟล์ Excel ไฮไลต์ค่าเดิม / ค่าใหม่', async () => {
    const { f, a } = await withChanges();
    const res = await team.lead.get(`${f.base}/plan-changes.xlsx?baseline=v1`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain(`${f.key}-plan-changes-v1.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('การแก้ไขแผน')!;
    expect(ws.rowCount).toBe(3);
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual(['No.', 'งาน', 'ฟิลด์', 'เดิม', 'ใหม่', 'เหตุผล', 'ผลกระทบ', 'โดย', 'เมื่อ']);
    const row = ws.getRow(3);
    expect(row.getCell(1).value).toBe(a.key);
    expect([row.getCell(4).value, row.getCell(5).value, row.getCell(8).value]).toEqual(['2026-11-13', '2026-11-17', 'Mick']);
    expect((row.getCell(5).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFDE68A');
    expect((row.getCell(4).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFEE2E2');
    await f.addViewer('guest@gantt.example.com');
    expect((await guest.get(`${f.base}/plan-changes.xlsx`)).status).toBe(403);
  });
});

describe('POST p/schedule:preview · Auto-schedule', () => {
  const preview = (f: { base: string }, c: Client = team.lead) => c.post(`${f.base}/schedule:preview`);

  it('เลื่อนงานตาม FS ข้ามวันหยุด 7 / 10 ธ.ค. และเลื่อนต่อเป็นทอด โดยไม่บันทึก', async () => {
    const f = await fixture();
    const p = await f.make('P', '2026-12-01', '2026-12-04'); // อ.–ศ. 4 วัน
    const q = await f.make('Q', '2026-12-02', '2026-12-03'); // เริ่มก่อน P จบ (ผิด FS) 2 วัน
    const r = await f.make('R', '2026-12-09', '2026-12-11'); // 9 และ 11 ธ.ค. (10 หยุด) = 2 วัน · FS lag 1
    const ok = await f.make('ไม่เกี่ยว', '2026-12-01', '2026-12-02');
    await f.dep(p, q); await f.dep(q, r, 'FS', 1);

    const res = await preview(f);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Q ต้องเริ่มหลัง P จบ 4 ธ.ค. → 7 ธ.ค. หยุด → 8 ธ.ค. · R: Q จบ 9 ธ.ค. + lag 1 วันทำการ (10 หยุด, 11 เว้น) → 14 ธ.ค. จบ 15 ธ.ค.
    expect(res.body.items).toEqual([
      { key: q.key, title: 'Q', planStart: '2026-12-08', planEnd: '2026-12-09', previousStart: '2026-12-02', previousEnd: '2026-12-03', shiftDays: 3, because: [p.key] },
      { key: r.key, title: 'R', planStart: '2026-12-14', planEnd: '2026-12-15', previousStart: '2026-12-09', previousEnd: '2026-12-11', shiftDays: 2, because: [q.key] },
    ]);
    expect(res.body.summary).toEqual({ moved: 2, checked: 4 });
    expect(res.body.projectEnd).toEqual({ before: '2026-12-11', after: '2026-12-15' });
    expect(res.body.items.map((x: { key: string }) => x.key)).not.toContain(ok.key);
    // ไม่บันทึก
    const stored = await t.owner.query('SELECT plan_start::text, plan_end::text FROM issues WHERE id = $1', [q.id]);
    expect(stored.rows[0]).toEqual({ plan_start: '2026-12-02', plan_end: '2026-12-03' });
    // เมื่อใช้ผลนี้จริงแล้ว preview ถัดไปต้องไม่มีอะไรให้เลื่อนอีก
    for (const [issue, item] of [[q, res.body.items[0]], [r, res.body.items[1]]] as const) {
      await t.owner.query('UPDATE issues SET plan_start = $2, plan_end = $3 WHERE id = $1', [issue.id, item.planStart, item.planEnd]);
    }
    expect((await preview(f)).body.items).toEqual([]);
  });

  it('SS / FF / SF + lag และไม่ดึงงานให้เร็วขึ้น', async () => {
    const f = await fixture();
    const a = await f.make('A', '2026-11-16', '2026-11-18'); // 3 วัน
    const ss = await f.make('SS+1', '2026-11-16', '2026-11-17'); // ต้องเริ่ม ≥ A.start + 1 = 17
    const ff = await f.make('FF', '2026-11-16', '2026-11-17'); // ต้องจบ ≥ A.end = 18 → เริ่ม ≥ 17
    const early = await f.make('FS ที่เว้นไว้ไกล', '2026-11-30', '2026-11-30'); // เริ่มหลัง A จบอยู่แล้ว → คงเดิม
    await f.dep(a, ss, 'SS', 1); await f.dep(a, ff, 'FF', 0); await f.dep(a, early, 'FS', 0);
    const res = await preview(f);
    const by = new Map(res.body.items.map((x: { key: string; planStart: string; planEnd: string }) => [x.key, x]));
    expect(by.get(ss.key)).toMatchObject({ planStart: '2026-11-17', planEnd: '2026-11-18', shiftDays: 1 });
    expect(by.get(ff.key)).toMatchObject({ planStart: '2026-11-17', planEnd: '2026-11-18' });
    expect(by.has(early.key)).toBe(false);
  });

  it('งานที่เสร็จแล้วเป็นตัวยึด ไม่ถูกเลื่อน · เลย Go-live → warning', async () => {
    const f = await fixture();
    await t.owner.query(`UPDATE projects SET golive_date = '2026-12-04' WHERE key = $1`, [f.key]);
    const done = await f.make('เสร็จแล้ว', '2026-12-01', '2026-12-02');
    await f.markDone(done);
    const next = await f.make('ต่อจากงานเสร็จ', '2026-12-01', '2026-12-03'); // ผิด FS กับ done (จบ 2 ธ.ค.)
    await f.dep(done, next);
    const late = await f.make('ผูกกับงานที่ยังไม่ลงแผน', null, null);
    await f.dep(late, next);
    const res = await preview(f);
    expect(res.body.items).toEqual([expect.objectContaining({ key: next.key, planStart: '2026-12-03', planEnd: '2026-12-08', because: [done.key] })]);
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain('golive_exceeded');
    expect(res.body.items.map((x: { key: string }) => x.key)).not.toContain(done.key);
  });

  it('สิทธิ์: ต้องมี issue.edit · Guest ใช้ไม่ได้ · Dependency วงกลม → 422', async () => {
    const f = await fixture();
    const a = await f.make('A', '2026-11-09', '2026-11-10');
    const b = await f.make('B', '2026-11-11', '2026-11-12');
    await f.dep(a, b);
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, (SELECT id FROM users WHERE email = 'viewer@gantt.example.com'), 'viewer' FROM projects WHERE key = $1`, [f.key]);
    const denied = await preview(f, viewer);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('issue.edit');
    await f.addViewer('guest@gantt.example.com');
    expect((await preview(f, guest)).status).toBe(403);
    await t.owner.query('INSERT INTO issue_dependencies (workspace_id, predecessor_id, successor_id) SELECT workspace_id, $2, $1 FROM issues WHERE id = $1', [a.id, b.id]);
    const cyc = await preview(f);
    expect(cyc.status).toBe(422);
    expect(cyc.body.error.code).toBe('dependency_cycle');
  });
});

describe('cpm · หน่วยคำนวณ', () => {
  const cal = new WorkCalendar(new Set([1, 2, 3, 4, 5]), new Set(['2026-12-07', '2026-12-10']));

  it('Axis: แปลงวัน ↔ ลำดับวันทำการ ข้ามเสาร์อาทิตย์และวันหยุด', () => {
    const axis = new Axis(cal, '2026-12-03');
    expect([axis.at(0), axis.at(1), axis.at(2), axis.at(3), axis.at(4), axis.at(5)]).toEqual(['2026-12-03', '2026-12-04', '2026-12-08', '2026-12-09', '2026-12-11', '2026-12-14']);
    expect(axis.idx('2026-12-07', 'next')).toBe(2); // วันหยุด → วันทำการถัดไป
    expect(axis.idx('2026-12-07', 'prev')).toBe(1); // วันหยุด → วันทำการก่อนหน้า
    expect(axis.idx('2026-12-12', 'prev')).toBe(4);
  });

  it('SF และ lag ติดลบ (lead)', () => {
    const axis = new Axis(cal, '2026-11-09');
    const nodes = [
      { id: 'a', start: '2026-11-09', end: '2026-11-13' },
      { id: 'b', start: '2026-11-11', end: '2026-11-12' },
    ];
    // FS lag -2: b เริ่มได้ ≥ a.จบ + 1 - 2 = ศ.13 - 1 = พฤ.12 → ณ แผนที่ 11 ต้องเลื่อน 1 วัน
    const shifts = autoSchedule(axis, nodes, [{ pred: 'a', succ: 'b', type: 'FS', lag: -2 }], new Set());
    expect(shifts).toMatchObject([{ id: 'b', start: '2026-11-12', end: '2026-11-13', shiftDays: 1 }]);
    const cp = criticalPath(axis, nodes, [{ pred: 'a', succ: 'b', type: 'SF', lag: 0 }]);
    expect(cp.slack.get('a')).toBeLessThanOrEqual(0);
  });
});
