// QA หลายคน · ตำแหน่งหลายตำแหน่ง (รวม DevOps) · QA Due ใน Excel / Gantt (ผู้ใช้ขอ 2026-11-13) · ข้อมูลสมมติเท่านั้น
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
type St = { id: string; name: string; boardColumnId: string | null };

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
});
afterAll(() => t.close());

async function download(c: Client, url: string) {
  const res = await c.get(url).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (x: Buffer) => chunks.push(x));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  expect(res.status).toBe(200);
  return res.body as Buffer;
}
async function sheet(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return { wb, ws: wb.getWorksheet('Tasks')! };
}
const headersOf = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1).map(String);

describe('ตำแหน่งของสมาชิกโปรเจกต์มีได้หลายตำแหน่ง', () => {
  it('positions เก็บเป็นตัวย่อ ไม่ซ้ำ · position รวมเป็นข้อความ · รับ position แบบเดิมได้ · DevOps เป็นตำแหน่งหนึ่ง', async () => {
    const { ws, lead, devId } = team;
    const r = await lead.patch(`${ws}/projects/DP/members/${devId}`, { positions: ['SA', 'developer', 'DevOps', 'sa'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ positions: ['SA', 'DEV', 'DEVOPS'], position: 'SA, DEV, DEVOPS' });

    const legacy = await lead.patch(`${ws}/projects/DP/members/${team.leadId}`, { position: 'QA Engineer' });
    expect(legacy.body).toMatchObject({ positions: ['QA'], position: 'QA' });

    // ฟอร์มสร้างงาน / Table ได้ตำแหน่งไปกรองช่อง BA / SA / Dev / QA
    const opts = (await lead.get(`${ws}/projects/DP/form-options`)).body;
    expect(opts.members.find((m: { id: string }) => m.id === devId).positions).toEqual(['SA', 'DEV', 'DEVOPS']);
    expect(opts.members.find((m: { id: string }) => m.id === team.leadId).positions).toEqual(['QA']);

    // Workload กรองทีละตำแหน่ง: คนที่มีหลายตำแหน่งตรงตำแหน่งใดก็ได้
    const list = (await lead.get(`${ws}/projects/DP/members`)).body;
    expect((list.items ?? list).find((m: { userId: string }) => m.userId === devId).positions).toEqual(['SA', 'DEV', 'DEVOPS']);
  });
});

describe('QA / Reviewer หลายคน', () => {
  let key = '';
  it('สร้างงานด้วย reviewerIds · คนแรกเป็น reviewerId · QA ทุกคนเห็นงานในแท็บรอ Review และย้ายงานได้', async () => {
    const { ws, lead, dev, project } = team;
    const r = await lead.post(`${ws}/projects/DP/issues`, { title: 'ตรวจสองคน', moduleId: project.modules[0].id, size: 'S', assigneeIds: [team.leadId], reviewerIds: [team.leadId, team.devId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    key = r.body.key;
    expect(r.body).toMatchObject({ reviewerId: team.leadId, reviewerIds: [team.leadId, team.devId] });

    const st = (name: string) => project.statuses.find((s: St) => s.name === name && !s.boardColumnId).id;
    expect((await lead.post(`${ws}/issues/${key}/move`, { statusId: st('Review') })).status).toBe(200);
    // QA คนที่สองไม่ใช่ผู้รับผิดชอบ แต่ย้ายงานได้และเห็นในแท็บ "รอฉัน Review"
    const mine = (await dev.get(`${ws}/my-issues?tab=reviewer`)).body;
    const items = mine.groups ? mine.groups.flatMap((g: { items: unknown[] }) => g.items) : mine.items;
    expect(items.map((x: { key: string }) => x.key)).toContain(key);
    expect((await dev.get(`${ws}/issues/${key}`)).body.canMove).toBe(true);
    const home = (await dev.get(`${ws}/home`)).body;
    expect(home.waiting.reviews.map((x: { key: string }) => x.key)).toContain(key);
  });

  it('แก้ทั้งชุด · reviewerId แบบเดิมยังใช้ได้ · ประวัติบันทึกเป็น reviewerIds · ห้ามชื่อซ้ำ', async () => {
    const { ws, lead } = team;
    let issue = (await lead.get(`${ws}/issues/${key}`)).body;
    expect((await lead.patch(`${ws}/issues/${key}`, { reviewerIds: [team.devId, team.devId] }, issue.version)).status).toBe(400);
    const swap = await lead.patch(`${ws}/issues/${key}`, { reviewerIds: [team.devId] }, issue.version);
    expect(swap.status).toBe(200);
    expect(swap.body).toMatchObject({ reviewerId: team.devId, reviewerIds: [team.devId] });
    issue = swap.body;
    const legacy = await lead.patch(`${ws}/issues/${key}`, { reviewerId: team.leadId }, issue.version);
    expect(legacy.body).toMatchObject({ reviewerId: team.leadId, reviewerIds: [team.leadId] });
    const { rows } = await t.owner.query(`SELECT a.field FROM activities a JOIN issues i ON i.id = a.issue_id JOIN projects p ON p.id = i.project_id WHERE p.key = 'DP' AND i.number = $1 AND a.verb = 'updated'`, [Number(key.split('-')[1])]);
    expect(rows.map((x: { field: string }) => x.field)).toContain('reviewerIds');
    expect(rows.map((x: { field: string }) => x.field)).not.toContain('reviewerId');
  });
});

describe('Excel และ Gantt ของโปรเจกต์ Development + QA', () => {
  it('ส่งออกมีคอลัมน์ QA Due และ QA หลายคน · โปรเจกต์อื่นไม่มี QA Due · นำเข้ากลับแก้ QA Due / QA ได้', async () => {
    const { ws, lead } = team;
    expect((await lead.post(`${ws}/projects`, { name: 'Dev QA Excel', key: 'DQX', startDate: '2026-11-02', goliveDate: '2027-03-31', builtinTemplate: 'development_qa', modules: ['Core'] })).status).toBe(201);
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, $1, 'member' FROM projects WHERE key = 'DQX'`, [team.devId]);
    const p = (await lead.get(`${ws}/projects/DQX`)).body;
    const made = await lead.post(`${ws}/projects/DQX/issues`, { title: 'หน้าสรุป', moduleId: p.modules[0].id, size: 'S', planStart: '2026-11-16', planEnd: '2026-11-18', reviewerIds: [team.leadId, team.devId] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.qaDue).toBe('2026-11-20');

    const { ws: sh } = await sheet(await download(lead, `${ws}/projects/DQX/export.xlsx`));
    const head = headersOf(sh);
    expect(head.slice(head.indexOf('Plan End'), head.indexOf('Plan End') + 2)).toEqual(['Plan End', 'QA Due']);
    const row = sh.getRow(2);
    expect(row.getCell(head.indexOf('QA / Reviewer') + 1).value).toBe('Mick, Kaijeaw');
    expect(row.getCell(head.indexOf('QA Due') + 1).value).toBeNull();
    expect(headersOf((await sheet(await download(lead, `${ws}/projects/DP/export.xlsx`))).ws)).not.toContain('QA Due');

    // นำเข้ากลับ: กรอก QA Due และเหลือ QA คนเดียว
    const { wb, ws: edit } = await sheet(await download(lead, `${ws}/projects/DQX/export.xlsx`));
    edit.getRow(2).getCell(head.indexOf('QA Due') + 1).value = '2026-11-25';
    edit.getRow(2).getCell(head.indexOf('QA / Reviewer') + 1).value = 'Kaijeaw';
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const job = await lead.upload(`${ws}/import-jobs`, file, 'DQX-plan.xlsx', { mode: 'update', projectKey: 'DQX' });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const fields = job.body.diff.changed[0].fields.map((f: { field: string }) => f.field).sort();
    expect(fields).toEqual(['qaEnd', 'reviewer']);
    expect((await lead.post(`${ws}/import-jobs/${job.body.id}/commit`)).status).toBe(201);
    const after = (await lead.get(`${ws}/issues/${made.body.key}`)).body;
    expect(after).toMatchObject({ qaEnd: '2026-11-25', qaDue: '2026-11-25', reviewerIds: [team.devId], reviewerId: team.devId });
  });

  it('Timeline / Gantt ส่ง qaDue ให้วาดช่วง QA · โปรเจกต์อื่นไม่มี', async () => {
    const { ws, lead } = team;
    const rows = (key: string) => lead.get(`${ws}/projects/${key}/timeline`).then((r) => r.body.modules.flatMap((m: { groups: { tasks: Record<string, unknown>[] }[] }) => m.groups.flatMap((g) => g.tasks)));
    expect((await rows('DQX'))[0].qaDue).toBe('2026-11-25');
    expect((await lead.get(`${ws}/projects/DQX/gantt`)).body.modules[0].groups[0].tasks[0].qaDue).toBe('2026-11-25');
    expect((await rows('DP')).every((r: Record<string, unknown>) => !('qaDue' in r))).toBe(true);
  });
});
