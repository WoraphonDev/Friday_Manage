// Template Development + QA และความคืบหน้าแยก Dev / QA (ผู้ใช้ขอ 2026-11-11) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;

type St = { id: string; name: string; category: string; workflowId: string; boardColumnId: string | null };

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
});
afterAll(() => t.close());

const DEV_QA = [
  { name: 'To do', category: 'todo' },
  { name: 'In progress', category: 'in_progress' },
  { name: 'Rework', category: 'in_progress' },
  { name: 'Ready for QA', category: 'review' },
  { name: 'Testing', category: 'review' },
  { name: 'Done', category: 'done' },
  { name: 'Rejected', category: 'cancelled' },
];

describe('Template Development + QA', () => {
  it('สร้างโปรเจกต์: ได้ 7 สถานะตามหมวด เปิดแยกความคืบหน้า · Bug ที่ Fixed ไปคอลัมน์ Ready for QA', async () => {
    const { ws, lead } = team;
    // body แบบเดียวกับที่ Wizard ส่ง (ชื่อ + หมวด)
    const r = await lead.post(`${ws}/projects`, { name: 'Dev QA', key: 'DQA', startDate: '2026-11-09', goliveDate: '2027-01-29', builtinTemplate: 'development_qa', modules: ['Core'], workflow: DEV_QA });
    expect(r.status).toBe(201);
    expect(r.body.progressSplit).toBe(true);
    const p = (await lead.get(`${ws}/projects/DQA`)).body;
    expect(p.fieldProfile.template).toEqual({ id: 'development_qa', name: 'Development + QA', builtin: true });
    const std = p.statuses.filter((s: St) => !s.boardColumnId && s.workflowId === p.statuses[0].workflowId);
    expect(std.map((s: St) => ({ name: s.name, category: s.category }))).toEqual(DEV_QA);
    const fixed = p.statuses.find((s: St) => s.name === 'Fixed');
    expect(std.find((s: St) => s.id === fixed.boardColumnId).name).toBe('Ready for QA');

    // ส่งแค่ builtinTemplate (ไม่ส่ง workflow) ก็ได้ชุดเดียวกัน
    const r2 = await lead.post(`${ws}/projects`, { name: 'Dev QA 2', key: 'DQB', startDate: '2026-11-09', goliveDate: '2027-01-29', builtinTemplate: 'development_qa' });
    expect(r2.status).toBe(201);
    const p2 = (await lead.get(`${ws}/projects/DQB`)).body;
    expect(p2.statuses.filter((s: St) => s.workflowId === p2.statuses[0].workflowId).map((s: St) => s.name)).toEqual(DEV_QA.map((x) => x.name));
  });

  it('Dev % = ส่งให้ QA แล้วนับ 100 (ที่เหลือใช้ % ที่กรอก) · QA % = Done เท่านั้น · Rejected ไม่นับ', async () => {
    const { ws, lead } = team;
    const p = (await lead.get(`${ws}/projects/DQA`)).body;
    const st = (name: string) => p.statuses.find((s: St) => s.name === name && !s.boardColumnId).id;
    const moduleId = p.modules[0].id;
    // กฎเดิม: เข้าหมวด Review / QA ต้องมี QA / Reviewer และย้ายจาก QA ไป Done ได้เฉพาะ Reviewer
    const mk = async (title: string) => (await lead.post(`${ws}/projects/DQA/issues`, { title, moduleId, size: 'S', reviewerId: team.leadId })).body;
    const a = await mk('กำลังพัฒนา');
    const b = await mk('รอ QA');
    const c = await mk('กำลังทดสอบ');
    const d = await mk('ผ่าน QA');
    const e = await mk('ตัดออก');
    expect((await lead.post(`${ws}/issues/${a.key}/move`, { statusId: st('In progress') })).status).toBe(200);
    const fresh = (await lead.get(`${ws}/issues/${a.key}`)).body;
    expect((await lead.patch(`${ws}/issues/${a.key}`, { progressPct: 50 }, fresh.version)).status).toBe(200);
    for (const [issue, name] of [[b, 'Ready for QA'], [c, 'Testing'], [d, 'Done'], [e, 'Rejected']] as const) {
      const moved = await lead.post(`${ws}/issues/${issue.key}/move`, { statusId: st(name) });
      expect(moved.status, `${name}: ${JSON.stringify(moved.body)}`).toBe(200);
    }

    // Size เท่ากันทุกงาน: Dev = (50 + 100 + 100 + 100) / 4 = 87.5 → 88 · QA = 100 / 4 = 25
    const ov = (await lead.get(`${ws}/projects/DQA/overview`)).body;
    expect(ov.progress.split).toEqual({ dev: { pct: 88, done: 3, total: 4 }, qa: { pct: 25, done: 1, total: 4 } });
    expect(ov.modules[0].split).toEqual(ov.progress.split);
    // ความคืบหน้าเดิมยังอยู่ (Health ฯลฯ ใช้ต่อ)
    expect(ov.progress.tasks).toEqual({ done: 1, total: 4 });

    const ins = (await lead.get(`${ws}/projects/DQA/insights/modules`)).body;
    expect(ins.modules[0].split).toEqual({ devPct: 75, qaPct: 25 });

    // ปิดแยกความคืบหน้า: กลับเป็นแถบเดียว
    const proj = (await lead.get(`${ws}/projects/DQA`)).body;
    expect((await lead.patch(`${ws}/projects/DQA`, { progressSplit: false }, proj.version)).status).toBe(200);
    const off = (await lead.get(`${ws}/projects/DQA/overview`)).body;
    expect(off.progress.split).toBeNull();
    expect(off.modules[0].split).toBeNull();
  });

  it('โปรเจกต์อื่นไม่เปลี่ยน: ไม่มี split', async () => {
    const ov = (await team.lead.get(`${team.ws}/projects/DP/overview`)).body;
    expect(ov.progress.split).toBeNull();
  });
});

describe('เปลี่ยน Workflow ของโปรเจกต์เดิมเป็นชุด Development + QA', () => {
  it('เปลี่ยนชื่อแทนการลบ · รวมสถานะที่จับคู่ซ้ำและย้ายงาน · สร้างสถานะที่ขาด · เปิดแยกความคืบหน้า', async () => {
    const { ws, lead, project } = team;
    const p = (path = '') => `${ws}/projects/DP${path}`;
    const std = project.statuses.filter((s: St) => !s.boardColumnId);
    const wf = std[0].workflowId;
    const bugWf = project.statuses.find((s: St) => s.boardColumnId).workflowId;
    const id = (name: string) => std.find((s: St) => s.name === name).id;
    const blocked = (await lead.post(p(`/workflows/${wf}/statuses`), { name: 'Blocked', category: 'blocked' })).body;
    const issue = (await lead.post(p('/issues'), { title: 'งานที่ติดอยู่', moduleId: project.modules[0].id, size: 'S' })).body;
    expect((await lead.post(`${ws}/issues/${issue.key}/move`, { statusId: blocked.id })).status).toBe(200);

    const mapping = { [id('To do')]: 'todo', [id('In progress')]: 'in_progress', [id('Review')]: 'ready_for_qa', [id('Done')]: 'done', [blocked.id]: 'in_progress' };
    // ต้องจับคู่ครบทุกสถานะ · Workflow ของ Bug ใช้ไม่ได้
    const partial = await lead.post(p(`/workflows/${wf}/apply-dev-qa`), { mapping: { [id('To do')]: 'todo' } });
    expect(partial.status).toBe(422);
    expect(partial.body.error.code).toBe('mapping_incomplete');
    expect((await lead.post(p(`/workflows/${bugWf}/apply-dev-qa`), { mapping: {} })).body.error.code).toBe('workflow_not_standard');

    const r = await lead.post(p(`/workflows/${wf}/apply-dev-qa`), { mapping });
    expect(r.status).toBe(200);
    expect(r.body.movedIssues).toBe(1);
    expect(r.body.created).toEqual(['Rework', 'Testing', 'Rejected']);
    expect(r.body.items.map((s: St) => ({ name: s.name, category: s.category }))).toEqual(DEV_QA);
    // id เดิมคงอยู่ (Review → Ready for QA) · Blocked ถูกรวมเข้า In progress
    const after = new Map(r.body.items.map((s: St) => [s.name, s.id]));
    expect(after.get('Ready for QA')).toBe(id('Review'));
    expect(after.get('In progress')).toBe(id('In progress'));
    expect([...after.values()]).not.toContain(blocked.id);
    expect((await lead.get(`${ws}/issues/${issue.key}`)).body.status.id).toBe(id('In progress'));

    const proj = (await lead.get(p())).body;
    expect(proj.progressSplit).toBe(true);
    // Bug ที่ Fixed ยังอยู่คอลัมน์เดิม (id ของ Review เดิม = Ready for QA)
    expect(proj.statuses.find((s: St) => s.name === 'Fixed').boardColumnId).toBe(id('Review'));
  });
});
