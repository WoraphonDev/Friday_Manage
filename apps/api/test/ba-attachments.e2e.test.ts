// BA หลายคนต่องาน และไอคอนคลิปจำนวนไฟล์ของงาน (ผู้ใช้ขอ 2026-11-18) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId = '';
let base = '';

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  base = `${team.ws}/projects/${team.key}`;
});
afterAll(() => t.close());

const allCards = (board: { columns: { cards: Record<string, unknown>[] }[] }) => board.columns.flatMap((c) => c.cards);

describe('BA หลายคน', () => {
  let key = '';
  it('สร้างงานด้วย baIds · คนแรกเป็น baId · Table / Board / Home ได้ BA ครบ', async () => {
    const { lead, dev, project, leadId, devId } = team;
    const r = await lead.post(`${base}/issues`, { title: 'สเปกสองคน', moduleId: project.modules[0].id, size: 'S', assigneeIds: [leadId], baIds: [devId, leadId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    key = r.body.key;
    expect(r.body).toMatchObject({ baId: devId, baIds: [devId, leadId] });

    const table = (await lead.get(`${base}/issues?view=table&limit=200`)).body;
    const row = table.items.find((x: { key: string }) => x.key === key);
    expect(row.ba.id).toBe(devId);
    expect(row.bas.map((p: { id: string }) => p.id)).toEqual([devId, leadId]);
    // กรอง BA เจองานที่คนนั้นเป็น BA คนใดคนหนึ่ง
    const byLead = (await lead.get(`${base}/issues?view=table&ba=${leadId}`)).body.items.map((x: { key: string }) => x.key);
    expect(byLead).toContain(key);

    const card = allCards((await lead.get(`${base}/board`)).body).find((c) => c.key === key)!;
    expect((card.bas as { id: string }[]).map((p) => p.id)).toEqual([devId, leadId]);
    expect(card.attachments).toBeNull();

    // BA คนที่สองเห็นบทบาท BA ใน My Tasks
    const mine = (await lead.get(`${team.ws}/my-issues?tab=assigned`)).body;
    const item = mine.groups.flatMap((g: { items: { key: string; myRoles: string[] }[] }) => g.items).find((x: { key: string }) => x.key === key);
    expect(item.myRoles).toEqual(expect.arrayContaining(['dev', 'ba']));
    const devMine = (await dev.get(`${team.ws}/my-issues?tab=assigned`)).body;
    expect(devMine.groups.flatMap((g: { items: { key: string }[] }) => g.items).map((x: { key: string }) => x.key)).toContain(key);
  });

  it('แก้ด้วย baIds แทนทั้งชุด · baId แบบเดิมยังใช้ได้ · ประวัติบันทึก baIds', async () => {
    const { lead, devId, leadId } = team;
    const cur = (await lead.get(`${team.ws}/issues/${key}`)).body;
    const p = await lead.patch(`${team.ws}/issues/${key}`, { baIds: [leadId] }, cur.version);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const after = (await lead.get(`${team.ws}/issues/${key}`)).body;
    expect(after).toMatchObject({ baId: leadId, baIds: [leadId] });

    const legacy = await lead.patch(`${team.ws}/issues/${key}`, { baId: devId }, after.version);
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect((await lead.get(`${team.ws}/issues/${key}`)).body).toMatchObject({ baId: devId, baIds: [devId] });

    const dup = await lead.patch(`${team.ws}/issues/${key}`, { baIds: [devId, devId] }, after.version + 1);
    expect(dup.status).toBe(400);

    const acts = (await t.owner.query(`SELECT field FROM activities WHERE issue_id = $1 AND field = 'baIds'`, [after.id])).rows;
    expect(acts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('จำนวนไฟล์ของงาน (ไอคอนคลิป)', () => {
  it('นับไฟล์แนบ + รายงาน Unit test + หลักฐาน QA · ไม่นับคอมเมนต์และไฟล์ที่ลบแล้ว', async () => {
    const { lead, project, leadId } = team;
    const task = (await lead.post(`${base}/issues`, { title: 'งานมีไฟล์', moduleId: project.modules[0].id, size: 'S', assigneeIds: [leadId] })).body;
    const file = async (name: string) => (await t.owner.query(`INSERT INTO files (workspace_id, project_id, name, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id`, [wsId, project.id, name, leadId])).rows[0].id as string;

    const spec = await file('spec.pdf');
    const mock = await file('mockup.png');
    for (const id of [spec, mock]) expect((await lead.post(`${base}/files/${id}/attachments`, { targetType: 'issue', target: task.key })).status).toBe(201);
    const qaEvidence = await file('qa-pass.png');
    expect((await lead.post(`${team.ws}/issues/${task.key}/test-runs`, { result: 'passed', fileIds: [qaEvidence] })).status).toBe(201);
    const unitReport = await file('unit.html');
    expect((await lead.post(`${team.ws}/issues/${task.key}/test-runs`, { kind: 'unit', result: 'passed', passedCount: 3, totalCount: 3, fileIds: [unitReport] })).status).toBe(201);
    // ไฟล์ในคอมเมนต์ไม่นับ
    const shot = await file('screenshot.png');
    const comment = await lead.post(`${team.ws}/issues/${task.key}/comments`, { body: 'ดูภาพนี้' });
    expect(comment.status).toBe(201);
    await t.owner.query(`INSERT INTO file_attachments (workspace_id, file_id, target_type, target_id, created_by) VALUES ($1,$2,'comment',$3,$4)`, [wsId, shot, comment.body.id, leadId]);

    const expected = { total: 4, files: 2, unit: 1, qa: 1 };
    const card = allCards((await lead.get(`${base}/board`)).body).find((c) => c.key === task.key)!;
    expect(card.attachments).toEqual(expected);
    const row = (await lead.get(`${base}/issues?view=table&limit=200`)).body.items.find((x: { key: string }) => x.key === task.key);
    expect(row.attachments).toEqual(expected);
    const backlog = (await lead.get(`${base}/backlog`)).body;
    const inBacklog = [...backlog.backlog.issues, ...backlog.sprints.flatMap((s: { issues: unknown[] }) => s.issues)].find((x: { key: string }) => x.key === task.key);
    expect(inBacklog.attachments).toEqual(expected);
    const mine = (await lead.get(`${team.ws}/my-issues?tab=assigned`)).body;
    expect(mine.groups.flatMap((g: { items: { key: string }[] }) => g.items).find((x: { key: string }) => x.key === task.key).attachments).toEqual(expected);

    // ไฟล์ในถังขยะไม่นับ
    await t.owner.query('UPDATE files SET deleted_at = now() WHERE id = $1', [spec]);
    const after = allCards((await lead.get(`${base}/board`)).body).find((c) => c.key === task.key)!;
    expect(after.attachments).toEqual({ total: 3, files: 1, unit: 1, qa: 1 });
  });
});
