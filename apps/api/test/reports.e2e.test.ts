// A09 · Lead Dashboard และ Reports · ข้อมูลสมมติที่รู้คำตอบล่วงหน้า
// วันนี้ในเครื่องจำลอง = พุธ 2 ธ.ค. 2569 → สัปดาห์นี้ 30 พ.ย.–6 ธ.ค., สัปดาห์หน้า 7–13 ธ.ค. (หยุด 7 และ 10 ธ.ค.)
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkCalendar } from '../src/projects/calendar.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let outsider: Client;
let wsId: string;
let pid: string;
let base: string;
const KEY = 'RP1';
const NOW = new Date('2026-12-02T05:00:00Z');
const ids: Record<string, { id: string; key: string }> = {};
const cal = new WorkCalendar(new Set([1, 2, 3, 4, 5]), new Set(['2026-12-07', '2026-12-10']));

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  guest = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guest, 'guest@reports.example.com', 'Guest'), 'guest', { key: team.key, role: 'viewer' });
  outsider = await client(t.app);
  await signup(outsider, 'outsider@reports.example.com', 'Outsider');

  const r = await team.lead.post(`${team.ws}/projects`, { key: KEY, name: 'Report Project', startDate: '2026-11-05', goliveDate: '2027-01-29', modules: ['Alpha', 'Beta'], sprintLengthWeeks: null });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const project = (await team.lead.get(`${team.ws}/projects/${KEY}`)).body;
  pid = project.id;
  base = `${team.ws}/projects/${KEY}`;
  await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES ($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [wsId, pid, team.devId]);
  await t.owner.query('DELETE FROM sprints WHERE project_id = $1', [pid]);
  const alpha = project.modules.find((m: { name: string }) => m.name === 'Alpha').id;
  const beta = project.modules.find((m: { name: string }) => m.name === 'Beta').id;
  await t.owner.query(`INSERT INTO milestones (workspace_id, project_id, module_id, name, date) VALUES ($1,$2,$3,'Alpha Go-live','2026-12-18')`, [wsId, pid, alpha]);

  const status = async (name: string) => (await t.owner.query('SELECT id FROM workflow_statuses WHERE project_id = $1 AND name = $2', [pid, name])).rows[0].id as string;
  const make = async (name: string, moduleId: string, o: { md: number; start?: string; end?: string; status?: string; done?: string; assignee?: string; progress?: number }) => {
    const c = await team.lead.post(`${base}/issues`, { title: `งาน ${name}`, moduleId });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await t.owner.query('UPDATE issues SET estimate_md = $2, plan_start = $3, plan_end = $4, status_id = $5, completed_at = $6, progress_pct = $7 WHERE id = $1', [c.body.id, o.md, o.start ?? null, o.end ?? null, o.status ? await status(o.status) : await status('To do'), o.done ?? null, o.progress ?? null]);
    if (o.assignee) await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, c.body.id, o.assignee]);
    ids[name] = c.body;
  };
  await make('A1', alpha, { md: 5, start: '2026-11-26', end: '2026-11-30', status: 'Done', done: '2026-12-01T03:00:00Z', assignee: team.leadId });
  await make('A2', alpha, { md: 5, start: '2026-11-16', end: '2026-11-20', status: 'Done', done: '2026-11-20T03:00:00Z', assignee: team.devId });
  await make('A3', alpha, { md: 10, start: '2026-11-23', end: '2026-11-27', status: 'In progress', progress: 40, assignee: team.devId });
  await make('A4', alpha, { md: 10, start: '2026-12-08', end: '2026-12-14', assignee: team.leadId });
  await make('B1', beta, { md: 12, start: '2026-12-02', end: '2026-12-03', progress: 10, assignee: team.devId });
  await make('B2', beta, { md: 2, start: '2026-11-09', end: '2026-11-10', status: 'Done', done: '2026-11-10T03:00:00Z', assignee: team.leadId });
  await make('B3', beta, { md: 4, start: '2026-12-07', end: '2026-12-11', status: 'Review' });
  await make('BUG', beta, { md: 0, start: '2026-12-01', end: '2026-12-03', assignee: team.devId });
  await t.owner.query(`UPDATE issues SET issue_type_id = (SELECT id FROM issue_types WHERE project_id = $2 AND name = 'Bug'), created_at = '2026-12-01T03:00:00Z' WHERE id = $1`, [ids.BUG.id, pid]);
  await t.owner.query(`INSERT INTO issue_dependencies (workspace_id, predecessor_id, successor_id) VALUES ($1,$2,$3)`, [wsId, ids.A3.id, ids.A4.id]);
  await t.owner.query(`UPDATE issues SET plan_start = '2026-12-02', plan_end = '2026-12-03' WHERE id = $1`, [ids.B1.id]);

  // คำขอเลื่อน Due ที่รออนุมัติ 1 รายการ (ส่งโดย dev)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const dr = await team.dev.post(`${team.ws}/issues/${ids.A3.key}/due-requests`, { requestedDue: '2026-12-09', reasonCode: 'scope_added', detail: 'ทดสอบ' });
  expect(dr.status, JSON.stringify(dr.body)).toBe(201);
  vi.useRealTimers();
  // createdAt ของคำขอมาจากนาฬิกาฐานข้อมูล (จริง) ส่วนวันนี้ของ test เป็นนาฬิกาจำลอง จึงตั้งให้ตรงกัน
  await t.owner.query(`UPDATE due_change_requests SET created_at = '2026-12-02T03:00:00Z'`);
});
afterAll(() => t.close());
afterEach(() => vi.useRealTimers());

async function get(path: string, c: Client = team.lead) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  return c.get(`${base}/${path}`);
}

describe('GET p/insights/risks', () => {
  it('พบความเสี่ยงทั้ง 5 แบบ เรียงตามความรุนแรง', async () => {
    const r = await get('insights/risks');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ asOf: '2026-12-02', counts: { high: 2, medium: 3, low: 0 }, project: { key: KEY } });
    expect(r.body.items.map((i: { kind: string }) => i.kind)).toEqual(['due_soon_low_progress', 'capacity_over', 'overdue', 'blocked', 'pending_due_requests']);
    const by = Object.fromEntries(r.body.items.map((i: { kind: string }) => [i.kind, i]));
    expect(by.overdue).toMatchObject({ severity: 'medium', count: 1, issueKeys: [ids.A3.key], people: [{ displayName: 'Kaijeaw', count: 1 }] });
    expect(by.overdue.detail).toContain('เลย 5 วัน');
    expect(by.due_soon_low_progress).toMatchObject({ severity: 'high', count: 1, issueKeys: [ids.B1.key] });
    expect(by.capacity_over).toMatchObject({ severity: 'high', count: 1, people: [{ displayName: 'Kaijeaw', md: 12, capacityMd: 5, utilizationPct: 240 }] });
    expect(by.blocked).toMatchObject({ severity: 'medium', count: 1, issueKeys: [ids.A4.key] });
    expect(by.blocked.detail).toContain(`${ids.A4.key} รอ ${ids.A3.key}`);
    expect(by.pending_due_requests).toMatchObject({ severity: 'medium', count: 1, issueKeys: [ids.A3.key] });
  });

  it('สิทธิ์: สมาชิกโปรเจกต์ทุก Role ดูได้ (project.workload.view ตายตัวตาม Role) · Guest 403 · คนนอกเข้าไม่ได้', async () => {
    expect((await get('insights/risks', team.dev)).status).toBe(200);
    expect((await get('insights/modules', team.dev)).status).toBe(200);
    const g = await get('insights/risks', guest);
    expect([403, 404]).toContain(g.status);
    expect([403, 404]).toContain((await get('insights/risks', outsider)).status);
  });
});

describe('GET p/insights/modules', () => {
  it('ความคืบหน้าถ่วงด้วย Man-Day และวันจบที่คาดจากอัตราเสร็จจริง 28 วัน เทียบ Milestone', async () => {
    const r = await get('insights/modules');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const alpha = r.body.modules.find((m: { name: string }) => m.name === 'Alpha');
    expect(alpha).toMatchObject({ taskCount: 4, doneCount: 2, totalMd: 30, doneMd: 10, remainingMd: 20, progressPct: 33, overdue: 1, planStart: '2026-11-16', plannedEnd: '2026-12-14', milestone: { name: 'Alpha Go-live', date: '2026-12-18' }, targetDate: '2026-12-18', velocityMdPerWeek: 2.5 });
    // เหลือ 20 MD ÷ 0.5 MD/วันทำการ = 40 วันทำการ นับจากวันนี้ (ข้ามหยุด 7 และ 10 ธ.ค.)
    const end = cal.nthWorkingDay('2026-12-02', 40);
    expect(alpha.forecastEnd).toBe(end);
    expect(alpha.slipDays).toBe(Math.round((Date.parse(end) - Date.parse('2026-12-18')) / 86_400_000));
    expect(alpha.status).toBe('off_track');
    const beta = r.body.modules.find((m: { name: string }) => m.name === 'Beta');
    expect(beta).toMatchObject({ taskCount: 3, totalMd: 18, doneMd: 2, remainingMd: 16, progressPct: 11, milestone: null, targetDate: '2026-12-11', velocityMdPerWeek: 0.5, status: 'off_track' });
    expect(r.body.modules.map((m: { name: string }) => m.name)).toEqual(['Alpha', 'Beta']);
  });

  it('สรุปทั้งโปรเจกต์: Man-Day, capacity ทีม, สัปดาห์ที่ต้องใช้เทียบที่เหลือถึง Go-live', async () => {
    const { summary, project } = (await get('insights/modules')).body;
    expect(project.goliveDate).toBe('2027-01-29');
    expect(summary).toMatchObject({ taskCount: 7, totalMd: 48, doneMd: 12, remainingMd: 36, progressPct: 25 });
    // Dev ที่ยังมีงานค้าง: dev 1 คน, lead 1 คน (A4) → 40 ชม. ต่อคน = 10 MD/สัปดาห์
    expect(summary.capacityMdPerWeek).toBe(10);
    expect(summary.requiredWeeks).toBe(3.6);
    expect(summary.weeksToGoLive).toBeGreaterThan(7);
    expect(summary.gapWeeks).toBe(Math.round((3.6 - summary.weeksToGoLive) * 10) / 10);
    expect(['on_track', 'at_risk', 'off_track']).toContain(summary.status);
  });

  it('ไม่มีงานเสร็จใน 28 วัน → ไม่คาดวันจบ (no_velocity) และ Module ที่เสร็จหมด → done', async () => {
    const proj = await team.lead.post(`${team.ws}/projects`, { key: 'RP2', name: 'Empty Velocity', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['Only'], sprintLengthWeeks: null });
    expect(proj.status).toBe(201);
    const p2 = (await team.lead.get(`${team.ws}/projects/RP2`)).body;
    const c = await team.lead.post(`${team.ws}/projects/RP2/issues`, { title: 'งานเดียว', moduleId: p2.modules[0].id });
    await t.owner.query('UPDATE issues SET estimate_md = 5, plan_start = $2, plan_end = $3 WHERE id = $1', [c.body.id, '2026-12-01', '2026-12-08']);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const none = (await team.lead.get(`${team.ws}/projects/RP2/insights/modules`)).body.modules[0];
    expect(none).toMatchObject({ forecastEnd: null, forecastReason: 'no_velocity', status: 'no_forecast', targetDate: '2026-12-08' });
    await t.owner.query(`UPDATE issues SET status_id = (SELECT id FROM workflow_statuses WHERE project_id = $2 AND category = 'done' LIMIT 1), completed_at = '2026-12-01T03:00:00Z' WHERE id = $1`, [c.body.id, p2.id]);
    const done = (await team.lead.get(`${team.ws}/projects/RP2/insights/modules`)).body.modules[0];
    expect(done).toMatchObject({ status: 'done', progressPct: 100, forecastEnd: '2026-12-01', slipDays: -7 });
  });
});

describe('GET p/reports/weekly', () => {
  it('รายงานสัปดาห์นี้ (ร่าง): สัปดาห์นี้ / สัปดาห์หน้า / ความเสี่ยง / ขอความช่วยเหลือ + ข้อความสำหรับคัดลอก', async () => {
    const r = await get('reports/weekly');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.week).toEqual({ start: '2026-11-30', end: '2026-12-06', label: '2026-11-30 – 2026-12-04', draft: true, asOf: '2026-12-02' });
    expect(['on_track', 'at_risk', 'off_track']).toContain(r.body.status);
    expect(r.body.totals).toEqual({ doneCount: 3, taskCount: 7, usedMd: 12, totalMd: 48, overdue: 1 });
    expect(r.body.thisWeek.done).toMatchObject({ count: 1, md: 5, keys: [ids.A1.key] });
    // งานใน Review (หมวด review ของโปรเจกต์ใหม่) ไม่นับซ้ำเป็น In progress
    expect(r.body.thisWeek).toMatchObject({ inProgress: 1, inReview: 1, overdue: { count: 1, byAssignee: [{ displayName: 'Kaijeaw', count: 1 }] }, newBugs: [{ key: ids.BUG.key, title: 'งาน BUG' }], fixedBugs: [] });
    expect(r.body.nextWeek).toMatchObject({ start: '2026-12-07', end: '2026-12-13', starting: { count: 2, md: 14, byModule: expect.arrayContaining([{ name: 'Alpha', count: 1 }, { name: 'Beta', count: 1 }]) }, sprintEvents: [] });
    expect(r.body.nextWeek.holidays.map((h: { date: string }) => h.date)).toEqual(['2026-12-07', '2026-12-10']);
    expect(r.body.risks.map((k: { kind: string }) => k.kind)).toEqual(['due_soon_low_progress', 'capacity_over', 'overdue', 'blocked', 'pending_due_requests']);
    expect(r.body.needsHelp.unassigned).toEqual({ count: 1, keys: [ids.B3.key] });
    expect(r.body.text).toContain('รายงานประจำสัปดาห์ · Report Project');
    expect(r.body.text).toContain('เสร็จ 3/7 งาน');
    expect(r.body.text).toContain('เสร็จแล้ว 1 งาน (5 MD) · กำลังทำ 1 งาน · รอ Review 1 งาน');
    expect(r.body.text).toContain('Kaijeaw 1');
    expect(r.body.text).toContain(`Bug ใหม่ 1 (${ids.BUG.key}`);
  });

  it('เลือกสัปดาห์ย้อนหลังด้วย ?week= (วันใดก็ได้ในสัปดาห์) · สัปดาห์ที่ผ่านแล้วไม่ใช่ร่าง', async () => {
    const r = await get('reports/weekly?week=2026-11-18');
    expect(r.body.week).toMatchObject({ start: '2026-11-16', end: '2026-11-22', draft: false, asOf: '2026-11-22' });
    expect(r.body.thisWeek.done).toMatchObject({ count: 1, md: 5, keys: [ids.A2.key] });
    expect(r.body.thisWeek.overdue.count).toBe(0);
    expect((await get('reports/weekly?week=2026-13-40')).status).toBe(400);
  });

  it('Member ดูได้ (project.view) · Guest 403', async () => {
    expect((await get('reports/weekly', team.dev)).status).toBe(200);
    const g = await get('reports/weekly', guest);
    expect([403, 404]).toContain(g.status);
  });
});

describe('GET p/reports/module-forecast', () => {
  it('Plan vs Actual รายสัปดาห์ย้อนหลัง ทั้งโปรเจกต์และราย Module', async () => {
    const r = await get('reports/module-forecast');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.weekly).toHaveLength(8);
    expect(r.body.weekly.at(-1)).toEqual({ weekStart: '2026-11-30', weekEnd: '2026-12-06', plannedMd: 17, doneMd: 5 });
    const w = (k: string) => r.body.weekly.find((x: { weekStart: string }) => x.weekStart === k);
    expect(w('2026-11-16')).toMatchObject({ plannedMd: 5, doneMd: 5 }); // A2
    expect(w('2026-11-09')).toMatchObject({ plannedMd: 2, doneMd: 2 }); // B2
    const alpha = r.body.modules.find((m: { name: string }) => m.name === 'Alpha');
    expect(alpha.weekly.at(-1)).toMatchObject({ plannedMd: 5, doneMd: 5 });
    expect(r.body.modules.find((m: { name: string }) => m.name === 'Beta').weekly.at(-1)).toMatchObject({ plannedMd: 12, doneMd: 0 });
    expect(alpha).toMatchObject({ progressPct: 33, status: 'off_track' });
    expect((await get('reports/module-forecast?weeks=3')).body.weekly).toHaveLength(3);
    expect((await get('reports/module-forecast?weeks=99')).status).toBe(400);
  });
});

describe('GET p/reports/traceability', () => {
  beforeAll(async () => {
    const req = async (code: string, kind: string, title: string, issues: string[]) => {
      const r = await t.owner.query('INSERT INTO requirements (workspace_id, project_id, code, kind, title) VALUES ($1,$2,$3,$4,$5) RETURNING id', [wsId, pid, code, kind, title]);
      for (const i of issues) await t.owner.query('INSERT INTO issue_requirements (workspace_id, issue_id, requirement_id) VALUES ($1,$2,$3)', [wsId, ids[i]!.id, r.rows[0].id]);
    };
    await req('FR-01', 'FR', 'ผู้ใช้เข้าสู่ระบบ', ['A1']);
    await req('FR-02', 'FR', 'คำนวณวงเงิน', ['A3']);
    await req('FR-03', 'FR', 'รายงาน', ['B1']);
    await req('FR-04', 'FR', 'ยังไม่มีงาน', []);
    await req('NFR-01', 'NFR', 'ตอบสนองภายใน 2 วินาที', ['A1', 'A2']);
    const run = (issue: string, no: number, result: string, at: string) =>
      t.owner.query(`INSERT INTO test_runs (workspace_id, issue_id, run_no, result, passed_count, total_count, environment, created_at) VALUES ($1,$2,$3,$4,$5,10,'sit',$6)`, [wsId, ids[issue]!.id, no, result, result === 'passed' ? 10 : 6, at]);
    await run('A1', 1, 'passed', '2026-11-28T03:00:00Z');
    await run('A3', 1, 'passed', '2026-11-27T03:00:00Z');
    await run('A3', 2, 'failed', '2026-11-30T03:00:00Z');
    const sc = await t.owner.query(`INSERT INTO screens (workspace_id, project_id, code, name) VALUES ($1,$2,'SCR-1','หน้าวงเงิน') RETURNING id`, [wsId, pid]);
    await t.owner.query('INSERT INTO issue_screens (workspace_id, issue_id, screen_id) VALUES ($1,$2,$3)', [wsId, ids.A3!.id, sc.rows[0].id]);
  });

  it('FR / NFR → งาน → ผลทดสอบล่าสุด พร้อมสรุปความครอบคลุม', async () => {
    const r = await get('reports/traceability');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary.requirements).toEqual({ total: 5, uncovered: 1, untested: 1, partial: 1, passed: 1, failed: 1, blocked: 0 });
    expect(r.body.summary.issuesWithoutRequirement).toMatchObject({ count: 3 });
    expect(r.body.summary.issuesWithoutRequirement.keys.sort()).toEqual([ids.A4!.key, ids.B2!.key, ids.B3!.key].sort());
    const req = (code: string) => r.body.requirements.find((x: { code: string }) => x.code === code);
    expect(req('FR-01')).toMatchObject({ result: 'passed', issues: [{ key: ids.A1!.key, latestTest: { result: 'passed', runNo: 1, environment: 'sit', passed: 10, total: 10 } }] });
    // งานเดียวกันมีผล 2 รอบ → ใช้รอบล่าสุด (failed)
    expect(req('FR-02')).toMatchObject({ result: 'failed', issues: [{ key: ids.A3!.key, latestTest: { result: 'failed', runNo: 2 } }] });
    expect(req('FR-03')).toMatchObject({ result: 'untested', issues: [{ latestTest: null }] });
    expect(req('FR-04')).toMatchObject({ result: 'uncovered', issues: [] });
    expect(req('NFR-01')).toMatchObject({ kind: 'NFR', result: 'partial' });
    expect(r.body.screens).toMatchObject([{ code: 'SCR-1', name: 'หน้าวงเงิน', result: 'failed', issues: [{ key: ids.A3!.key }] }]);
    expect(r.body.requirements.map((x: { code: string }) => x.code)).toEqual(['FR-01', 'FR-02', 'FR-03', 'FR-04', 'NFR-01']);
  });

  it('กรองตามชนิด / ผล · พารามิเตอร์ผิด 400 · Guest ไม่ได้', async () => {
    expect((await get('reports/traceability?kind=NFR')).body.requirements.map((x: { code: string }) => x.code)).toEqual(['NFR-01']);
    expect((await get('reports/traceability?result=failed')).body.requirements.map((x: { code: string }) => x.code)).toEqual(['FR-02']);
    expect((await get('reports/traceability?result=bogus')).status).toBe(400);
    expect((await get('reports/traceability?kind=SRS')).status).toBe(400);
    expect([403, 404]).toContain((await get('reports/traceability', guest)).status);
    expect((await get('reports/traceability', team.dev)).status).toBe(200);
  });
});
