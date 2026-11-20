// ย้ายงานข้ามโปรเจกต์ (storyboard 2026-11-20) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let outsider: Client;
let outsiderId: string;
let wsId: string;
let parentKey: string;
let subKeys: string[];
let otherKey: string;

const base = () => `${team.ws}/projects/${team.key}`;
const issue = (key: string) => `${team.ws}/issues/${key}`;
const preview = (c: Client, keys: string[], targetProjectKey = 'WEB') => c.post(`${team.ws}/issues/move/preview`, { keys, targetProjectKey });
const move = (c: Client, body: Record<string, unknown>) => c.post(`${team.ws}/issues/move`, { targetProjectKey: 'WEB', ...body });

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'move-ws', key: 'DE' });
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  // ปลายทาง: โปรเจกต์ส่วนตัวที่ dev ไม่ได้เป็นสมาชิก
  const web = await team.lead.post(`${team.ws}/projects`, { name: 'เว็บไซต์บริษัท', key: 'WEB', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['หน้าเว็บ'] });
  expect(web.status, JSON.stringify(web.body)).toBe(201);
  outsider = await client(t.app);
  outsiderId = await signup(outsider, 'other@move.example.com', 'Other');
  await addMember(t.owner, team.slug, outsiderId, 'member', { key: 'DE', role: 'member' });

  const p = await team.lead.post(`${base()}/issues`, { title: 'หน้าชำระเงินผ่าน QR', moduleId: team.project.modules[0].id, assigneeIds: [team.devId], planStart: '2026-12-02', planEnd: '2026-12-09' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  parentKey = p.body.key;
  subKeys = [];
  for (const title of ['สร้าง QR', 'ตรวจยอด']) {
    const c = await team.lead.post(`${base()}/issues`, { title, parentKey });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    subKeys.push(c.body.key);
  }
  const o = await team.lead.post(`${base()}/issues`, { title: 'งานที่ไม่ย้าย', moduleId: team.project.modules[0].id });
  otherKey = o.body.key;
  await team.lead.post(`${issue(parentKey)}/comments`, { body: 'ลูกค้าขอใช้ PromptPay' });

  // ของที่ผูกกับโปรเจกต์เดิม: Label, Custom field, Requirement, Dependency กับงานที่ไม่ย้าย
  const ids = async (key: string) => (await t.owner.query(`SELECT i.id, i.project_id FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key || '-' || i.number = $1`, [key])).rows[0];
  const par = await ids(parentKey);
  const oth = await ids(otherKey);
  const label = (await t.owner.query(`INSERT INTO labels (workspace_id, project_id, name, color) VALUES ($1, $2, 'urgent', '#c8264a') RETURNING id`, [wsId, par.project_id])).rows[0].id;
  await t.owner.query(`INSERT INTO issue_labels (workspace_id, issue_id, label_id) VALUES ($1, $2, $3)`, [wsId, par.id, label]);
  const field = (await t.owner.query(`INSERT INTO custom_fields (workspace_id, project_id, name, field_type) VALUES ($1, $2, 'ลูกค้า', 'text') RETURNING id`, [wsId, par.project_id])).rows[0].id;
  await t.owner.query(`INSERT INTO issue_custom_values (workspace_id, issue_id, field_id, value) VALUES ($1, $2, $3, '"ร้านเอ"')`, [wsId, par.id, field]);
  const req = (await t.owner.query(`INSERT INTO requirements (workspace_id, project_id, code, kind, title) VALUES ($1, $2, 'FR-01.2', 'FR', 'ชำระเงิน') RETURNING id`, [wsId, par.project_id])).rows[0].id;
  await t.owner.query(`INSERT INTO issue_requirements (workspace_id, issue_id, requirement_id) VALUES ($1, $2, $3)`, [wsId, par.id, req]);
  await t.owner.query(`INSERT INTO issue_dependencies (workspace_id, predecessor_id, successor_id) VALUES ($1, $2, $3)`, [wsId, oth.id, par.id]);
  // ปลายทางเรียกสถานะ In Progress ต่างออกไป → ต้องเลือกเอง
  await t.owner.query(`UPDATE workflow_statuses SET name = 'กำลังทำ' WHERE project_id = (SELECT id FROM projects WHERE key = 'WEB') AND name = 'In progress'`);
  const inProgress = (await team.lead.get(`${team.ws}/projects/DE/form-options`)).body.issueTypes.find((x: { name: string }) => x.name === 'Task').statuses.find((x: { name: string }) => x.name === 'In progress');
  const cur = (await team.lead.get(issue(parentKey))).body;
  expect((await team.lead.patch(issue(parentKey), { statusId: inProgress.id }, cur.version)).status).toBe(200);
});
afterAll(() => t.close());

describe('ย้ายงานข้ามโปรเจกต์', () => {
  it('ดูก่อนย้าย: เลือก Sub-task แล้วดึงแม่และพี่น้องมาด้วย · เลขใหม่ · จับคู่ตามชื่อ · สิ่งที่ตามไปไม่ได้ · คนนอกโปรเจกต์ส่วนตัว', async () => {
    const r = await preview(team.lead, [subKeys[0]]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.issues.map((x: { key: string; newKey: string }) => [x.key, x.newKey])).toEqual([[parentKey, 'WEB-1'], [subKeys[0], 'WEB-2'], [subKeys[1], 'WEB-3']]);
    expect(r.body).toMatchObject({ count: 3, subtasks: 2, pulled: [parentKey, subKeys[1]], target: { key: 'WEB', visibility: 'private' } });
    expect(r.body.types.every((x: { byName: boolean }) => x.byName)).toBe(true);
    const progress = r.body.statuses.find((x: { from: { name: string } }) => x.from.name === 'In progress');
    expect(progress).toMatchObject({ to: null, suggested: { name: 'กำลังทำ' } });
    expect(r.body.labels.create).toEqual(['urgent']);
    expect(r.body.dropped).toMatchObject({ requirements: ['FR-01.2'], customFields: ['ลูกค้า'], dependencies: [{ issue: parentKey, other: otherKey, side: 'predecessor' }] });
    expect(r.body.people.outside.map((x: { name: string }) => x.name)).toEqual(['Kaijeaw']);
    expect(r.body.people.canInvite).toBe(true);
  });

  it('สิทธิ์: ต้องเข้าโปรเจกต์ปลายทางและสร้างงานได้ · ย้ายเข้าโปรเจกต์เดิมไม่ได้ · ข้ามหลายโปรเจกต์ในครั้งเดียวไม่ได้', async () => {
    expect([403, 404]).toContain((await preview(outsider, [parentKey])).status);
    expect((await preview(team.lead, [parentKey], 'DE')).body.error.code).toBe('same_project');
    expect((await preview(team.lead, [parentKey, 'WEB-9'])).body.error.code).toBe('invalid_reference');
  });

  it('จับคู่สถานะไม่ครบ → 422 พร้อมสิ่งที่ต้องเลือก', async () => {
    const r = await move(team.lead, { keys: [parentKey] });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'mapping_required', details: { count: 3 } });
  });

  it('ย้ายจริง: Key ใหม่ · Key เดิมพาไปงานใหม่ (404 issue_moved) · Comment / Label ตามไป · ของโปรเจกต์เดิมหลุดและบันทึกในประวัติ · เพิ่มคนเป็นสมาชิก · แจ้งเตือน', async () => {
    const p = (await preview(team.lead, [parentKey])).body;
    const statusMap = Object.fromEntries(p.statuses.map((x: { key: string; to: { id: string } | null; suggested: { id: string } }) => [x.key, (x.to ?? x.suggested).id]));
    const webModule = p.modules[0].id;
    const startedAt = (await t.owner.query(`SELECT clock_timestamp()::text AS now`)).rows[0].now;
    const r = await move(team.lead, { keys: [parentKey], statusMap, moduleId: webModule });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ key: 'WEB-1', moved: [{ from: parentKey, to: 'WEB-1' }, { from: subKeys[0], to: 'WEB-2' }, { from: subKeys[1], to: 'WEB-3' }], membersAdded: 1 });

    const old = await team.lead.get(issue(parentKey));
    expect(old.status).toBe(404);
    expect(old.body.error).toMatchObject({ code: 'issue_moved', details: { key: 'WEB-1', oldKey: parentKey } });
    expect((await team.lead.get(issue(subKeys[1]))).body.error.details.key).toBe('WEB-3');

    const moved = (await team.lead.get(issue('WEB-1'))).body;
    expect(moved).toMatchObject({ key: 'WEB-1', title: 'หน้าชำระเงินผ่าน QR', status: { name: 'กำลังทำ' }, moduleId: webModule, sprintId: null });
    const comments = await team.lead.get(`${issue('WEB-1')}/comments`);
    expect(comments.body.items.map((c: { body: string }) => c.body)).toEqual(['ลูกค้าขอใช้ PromptPay']);
    const labels = (await t.owner.query(`SELECT l.name, p.key FROM issue_labels il JOIN labels l ON l.id = il.label_id JOIN projects p ON p.id = l.project_id JOIN issues i ON i.id = il.issue_id WHERE i.id = $1`, [moved.id])).rows;
    expect(labels).toEqual([{ name: 'urgent', key: 'WEB' }]);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM issue_requirements WHERE issue_id = $1`, [moved.id])).rows[0].n).toBe(0);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM issue_custom_values WHERE issue_id = $1`, [moved.id])).rows[0].n).toBe(0);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM issue_dependencies WHERE successor_id = $1`, [moved.id])).rows[0].n).toBe(0);
    const act = (await t.owner.query(`SELECT verb, old_value, new_value, project_id = (SELECT id FROM projects WHERE key = 'WEB') AS in_web FROM activities WHERE issue_id = $1 ORDER BY created_at`, [moved.id])).rows;
    expect(act.every((a) => a.in_web)).toBe(true);
    expect(act.at(-1)).toMatchObject({ verb: 'moved', old_value: { key: parentKey, projectKey: 'DE' }, new_value: { key: 'WEB-1', withSubtasks: 2, dropped: { requirements: ['FR-01.2'], customFields: ['ลูกค้า'], dependencies: [otherKey] } } });
    expect((await t.owner.query(`SELECT role FROM project_members WHERE user_id = $1 AND project_id = (SELECT id FROM projects WHERE key = 'WEB')`, [team.devId])).rows).toEqual([{ role: 'member' }]);
    // dev (ผู้รับผิดชอบ) เห็นงานในโปรเจกต์ใหม่และได้แจ้งเตือนครั้งเดียวต่อก้อน
    expect((await team.dev.get(issue('WEB-1'))).status).toBe(200);
    const notes = (await t.owner.query(`SELECT event_type, payload->>'oldKey' AS old FROM notifications WHERE recipient_id = $1 AND event_type = 'issue.moved' AND created_at > $2`, [team.devId, startedAt])).rows;
    expect(notes).toEqual([{ event_type: 'issue.moved', old: parentKey }]);
    const audit = (await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'issue.moved'`)).rows;
    expect(audit).toEqual([{ summary: `ย้าย ${parentKey} → WEB-1 พร้อม Sub-task 2 งาน` }]);
  });

  it('ค้นหา Key เดิมเจองานใหม่เป็นผลแรก · ย้ายกลับได้และ Key ทุกตัวยังพาไปถูก', async () => {
    const found = await team.lead.get(`${team.ws}/search?q=${parentKey}`);
    expect(found.body.items[0]).toMatchObject({ type: 'task', key: 'WEB-1' });
    const p = (await preview(team.lead, ['WEB-1'], 'DE')).body;
    const statusMap = Object.fromEntries(p.statuses.map((x: { key: string; to: { id: string } | null; suggested: { id: string } }) => [x.key, (x.to ?? x.suggested).id]));
    const back = await move(team.lead, { keys: ['WEB-1'], targetProjectKey: 'DE', statusMap });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const newKey = back.body.key;
    expect(newKey).not.toBe(parentKey);
    expect((await team.lead.get(issue(parentKey))).body.error.details.key).toBe(newKey);
    expect((await team.lead.get(issue('WEB-1'))).body.error.details.key).toBe(newKey);
  });
});
