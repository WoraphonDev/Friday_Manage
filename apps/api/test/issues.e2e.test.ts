// ข้อมูลสมมติ · ฐานข้อมูลแยกและล้างด้วย startApp ตามกติกา lane
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { addMember, client, OWNER_URL, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let viewer: Client, guest: Client, outsider: Client;
let guestId: string;
let workspaceId: string, moduleId: string, phaseId: string, sprintId: string, otherSprintId: string;
let serial = 0;
const seen: DomainEvent[] = [];
const committedDeletes: string[] = [];
const status = (name: string, bug = false) => team.project.statuses.find((s: { name: string; boardColumnId: string | null }) => s.name === name && !!s.boardColumnId === bug).id as string;
const url = (key: string) => `${team.ws}/issues/${key}`;
const projectUrl = () => `${team.ws}/projects/DP`;
async function create(extra: Record<string, unknown> = {}, who?: Client) {
  const r = await (who ?? team.lead).post(`${projectUrl()}/issues`, { title: `งานสมมติ ${++serial}`, moduleId, size: 'XS', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
async function addRule(type: string, bug = false, config: Record<string, unknown> = {}) {
  const workflowId = team.project.issueTypes.find((x: { name: string }) => x.name === (bug ? 'Bug' : 'Task')).workflowId;
  const result = await t.owner.query('INSERT INTO workflow_rules (workspace_id,project_id,workflow_id,rule_type,config) VALUES ($1,$2,$3,$4,$5) RETURNING id', [workspaceId, team.project.id, workflowId, type, config]);
  return result.rows[0].id as string;
}
async function setRuleEnabled(id: string, enabled: boolean) { await t.owner.query('UPDATE workflow_rules SET enabled=$2 WHERE id=$1', [id, enabled]); }

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'issues-synthetic' });
  moduleId = team.project.modules[0].id;
  workspaceId = (await t.owner.query('SELECT workspace_id FROM projects WHERE id=$1', [team.project.id])).rows[0].workspace_id;
  phaseId = (await t.owner.query(`INSERT INTO phases (workspace_id,project_id,module_id,name) VALUES ($1,$2,$3,'กลุ่มงานสมมติ') RETURNING id`, [workspaceId, team.project.id, moduleId])).rows[0].id;
  sprintId = team.project.sprints[0].id;
  otherSprintId = team.project.sprints[1].id;
  await t.owner.query("UPDATE sprints SET status='active' WHERE id=$1", [sprintId]);
  viewer = await client(t.app);
  const viewerId = await signup(viewer, 'viewer@issues-synthetic.example.com', 'ผู้ดูสมมติ');
  await addMember(t.owner, team.slug, viewerId, 'member', { key: 'DP', role: 'viewer' });
  guest = await client(t.app);
  guestId = await signup(guest, 'guest@issues-synthetic.example.com', 'ลูกค้าสมมติ');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: 'DP', role: 'viewer' });
  outsider = await client(t.app);
  await signup(outsider, 'outsider@issues-synthetic.example.com', 'คนนอกสมมติ');
  t.app.get(EventBus).on('*', async (event) => {
    seen.push(event);
    if (event.type === 'issue.deleted') {
      const row = (await t.owner.query('SELECT deleted_at FROM issues WHERE id=$1', [event.issueId])).rows[0];
      if (row?.deleted_at) committedDeletes.push(event.issueId!);
    }
  });
});
afterAll(async () => { await t.close(); });

describe('ลบ กู้คืน และผลกระทบ', () => {
  it('ลบแม่พร้อมลูก, 410 มีผู้ลบและกำหนด 30 วัน, event หลัง commit และกู้คืนเฉพาะ batch นี้', async () => {
    const parent = await create();
    const child = await create({ parentKey: parent.key });
    const oldChild = await create({ parentKey: parent.key });
    expect((await team.lead.delete(url(oldChild.key))).status).toBe(200);
    seen.length = 0;
    const removed = await team.lead.delete(url(parent.key));
    expect(removed.status).toBe(200);
    expect(removed.body.subtasks).toBe(1);
    expect(Date.parse(removed.body.restorableUntil) - Date.parse(removed.body.deletedAt)).toBe(30 * 86400000);
    expect(seen.filter((e) => e.type === 'issue.deleted').map((e) => e.issueId)).toEqual([parent.id, child.id]);
    expect(committedDeletes).toEqual(expect.arrayContaining([parent.id, child.id]));
    const gone = await team.lead.get(url(parent.key));
    expect(gone.status).toBe(410);
    expect(gone.body.error.details).toMatchObject({ deletedBy: { id: team.leadId }, deletedAt: removed.body.deletedAt, restorableUntil: removed.body.restorableUntil });
    expect((await team.lead.get(url(child.key))).status).toBe(410);
    expect((await team.lead.post(`${url(child.key)}/restore`)).body.error.code).toBe('parent_deleted');
    const restored = await team.lead.post(`${url(parent.key)}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.headers.etag).toBe(`"${restored.body.version}"`);
    expect(restored.body.version).toBeGreaterThan(parent.version);
    expect((await team.lead.get(url(child.key))).status).toBe(200);
    expect((await team.lead.get(url(oldChild.key))).status).toBe(410);
    const audit = await t.owner.query("SELECT action FROM audit_logs WHERE target_id=$1 AND action IN ('issue.deleted','issue.restored') ORDER BY created_at", [parent.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['issue.deleted', 'issue.restored']);
    const again = await team.lead.post(`${url(parent.key)}/restore`);
    expect(again.body.version).toBe(restored.body.version);
  });

  it('P3 เก็บ Sub-task: ลูกเป็น Task เดี่ยวใน Module ของแม่ ลบเฉพาะแม่ และกู้คืนแม่ไม่ผูกลูกกลับ', async () => {
    const parent = await create();
    const child = await create({ parentKey: parent.key });
    seen.length = 0;
    const removed = await team.lead.delete(`${url(parent.key)}?subtasks=keep`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ subtasks: 0, keptSubtasks: 1 });
    const kept = await team.lead.get(url(child.key));
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ parentKey: null, moduleId: parent.moduleId });
    expect(kept.body.version).toBeGreaterThan(child.version);
    expect(seen.filter((e) => e.type === 'issue.deleted').map((e) => e.issueId)).toEqual([parent.id]);
    expect(seen.some((e) => e.type === 'issue.updated' && e.issueId === child.id)).toBe(true);
    const activity = await t.owner.query("SELECT old_value FROM activities WHERE issue_id=$1 AND field='parentId'", [child.id]);
    expect(activity.rows[0].old_value).toBe(parent.key);
    expect((await team.lead.post(`${url(parent.key)}/restore`)).status).toBe(200);
    expect((await team.lead.get(url(child.key))).body.parentKey).toBeNull();
    expect((await team.lead.delete(`${url(parent.key)}?subtasks=nope`)).status).toBe(400);
  });

  it('กู้คืนเมื่อเกิน 30 วันไม่ได้ และไม่เปลี่ยนข้อมูลหรือส่ง event', async () => {
    const issue = await create();
    await team.lead.delete(url(issue.key));
    await t.owner.query("UPDATE issues SET deleted_at=now()-interval '31 days' WHERE id=$1", [issue.id]);
    seen.length = 0;
    const r = await team.lead.post(`${url(issue.key)}/restore`);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('restore_expired');
    expect(seen).toEqual([]);
    expect((await team.lead.get(url(issue.key))).status).toBe(410);
  });

  it('delete-impact นับลูก ไฟล์หลักฐานจากงาน/ผลทดสอบ/คอมเมนต์ และ dependency โดยไม่ซ้ำ', async () => {
    const root = await create();
    const child = await create({ parentKey: root.key });
    const other = await create();
    const file = (await t.owner.query("INSERT INTO files (workspace_id,project_id,name,uploaded_by) VALUES ($1,$2,'หลักฐานสมมติ.txt',$3) RETURNING id", [workspaceId, team.project.id, team.leadId])).rows[0].id;
    const run = (await t.owner.query("INSERT INTO test_runs (workspace_id,issue_id,run_no,result) VALUES ($1,$2,1,'passed') RETURNING id", [workspaceId, child.id])).rows[0].id;
    const comment = (await t.owner.query("INSERT INTO comments (workspace_id,issue_id,author_id,body) VALUES ($1,$2,$3,'สมมติ') RETURNING id", [workspaceId, root.id, team.leadId])).rows[0].id;
    for (const [type, id] of [['issue', root.id], ['test_run', run], ['comment', comment]]) await t.owner.query('INSERT INTO file_attachments (workspace_id,file_id,target_type,target_id) VALUES ($1,$2,$3,$4)', [workspaceId, file, type, id]);
    await t.owner.query('INSERT INTO issue_dependencies (workspace_id,predecessor_id,successor_id) VALUES ($1,$2,$3)', [workspaceId, other.id, child.id]);
    const impact = await team.lead.get(`${url(root.key)}/delete-impact`);
    expect(impact.status, JSON.stringify(impact.body)).toBe(200);
    expect(impact.body.counts).toEqual({ subtasks: 1, files: 1, dependencies: 1 });
    expect(impact.body.files).toEqual([{ id: file, name: 'หลักฐานสมมติ.txt' }]);
    await team.lead.delete(url(root.key));
    const stillThere = await t.owner.query('SELECT deleted_at FROM files WHERE id=$1', [file]);
    expect(stillThere.rows[0].deleted_at).toBeNull();
  });

  it('ตรวจสิทธิ์ลบ/กู้คืนและข้าม Workspace ก่อนเปิดเผยข้อมูล', async () => {
    const issue = await create();
    expect((await team.dev.delete(url(issue.key))).status).toBe(403);
    expect((await viewer.get(`${url(issue.key)}/delete-impact`)).status).toBe(403);
    expect((await outsider.delete(url(issue.key))).status).toBe(404);
    await team.lead.delete(url(issue.key));
    expect((await team.dev.post(`${url(issue.key)}/restore`)).status).toBe(403);
    expect((await outsider.get(url(issue.key))).status).toBe(404);
    expect((await team.lead.delete(`${team.ws}/issues/XX-1`)).status).toBe(404);
  });
});

describe('Bug และ Assignees', () => {
  it('Reopen Bug จาก Fixed/Closed กลับสถานะแรก เพิ่มครั้ง เปิด Actual End และ Event หลัง commit', async () => {
    const bug = await create({ type: 'Bug', severity: 'major', environment: 'sit', details: { steps: 'ทดสอบสมมติ' }, statusId: status('Closed', true) });
    // สร้างด้วย Closed ยังไม่ตั้ง actual; ใช้ค่าจำลองสถานะที่ปิดเสร็จแล้ว
    await t.owner.query("UPDATE issues SET actual_start='2026-11-05', actual_end='2026-11-06', completed_at=now() WHERE id=$1", [bug.id]);
    seen.length = 0;
    const r = await team.dev.post(`${url(bug.key)}/reopen`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reopenCount: 1, status: { id: status('Open', true), category: 'todo' }, actualEnd: null, actualStart: '2026-11-05' });
    expect(seen.find((e) => e.type === 'bug.reopened')).toMatchObject({ issueId: bug.id, data: { reopenCount: 1 } });
    expect(seen.some((e) => e.type === 'issue.status_changed')).toBe(true);
    expect((await team.dev.post(`${url(bug.key)}/reopen`)).body.error.code).toBe('bug_already_open');
    const task = await create();
    expect((await team.lead.post(`${url(task.key)}/reopen`)).body.error.code).toBe('not_a_bug');
    expect((await viewer.post(`${url(bug.key)}/reopen`)).status).toBe(403);
  });

  it('PUT Assignees บังคับ If-Match ตรวจคน เปลี่ยน version และ emit added/removed', async () => {
    const issue = await create({ assigneeIds: [team.leadId] });
    const request = (ids: string[], match?: number) => {
      const r = team.dev.put(`${url(issue.key)}/assignees`, { assigneeIds: ids });
      return match === undefined ? r : r.set('If-Match', `"${match}"`);
    };
    expect((await request([team.devId])).status).toBe(428);
    expect((await request([team.devId, team.devId], issue.version)).status).toBe(400);
    expect((await request(['00000000-0000-4000-8000-000000000001'], issue.version)).body.error.code).toBe('invalid_people');
    seen.length = 0;
    const r = await request([team.devId], issue.version);
    expect(r.status).toBe(200);
    expect(r.body.assigneeIds).toEqual([team.devId]);
    expect(r.headers.etag).toBe(`"${r.body.version}"`);
    expect(r.body.version).toBeGreaterThan(issue.version);
    expect(seen.find((e) => e.type === 'issue.assigned')?.data).toMatchObject({ userIds: [team.devId], removedUserIds: [team.leadId] });
    expect((await request([team.leadId], issue.version)).body.error.code).toBe('conflict');
  });
  it('แก้ Actual Start เองได้ บันทึก Activity · ห้ามเกินวันนี้หรือหลัง Actual End', async () => {
    const issue = await create();
    const r = await team.lead.patch(url(issue.key), { actualStart: '2026-11-02' }, issue.version);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.actualStart).toBe('2026-11-02');
    const activity = await t.owner.query("SELECT old_value, new_value FROM activities WHERE issue_id=$1 AND field='actualStart'", [issue.id]);
    expect(activity.rows).toEqual([{ old_value: null, new_value: '2026-11-02' }]);
    expect((await team.lead.patch(url(issue.key), { actualStart: '2099-01-01' }, r.body.version)).body.error.code).toBe('invalid_dates');
    await t.owner.query("UPDATE issues SET actual_end='2026-11-03' WHERE id=$1", [issue.id]);
    const current = (await team.lead.get(url(issue.key))).body;
    expect((await team.lead.patch(url(issue.key), { actualStart: '2026-11-04' }, current.version)).body.error.code).toBe('invalid_dates');
  });
});

describe('Table และ form-options', () => {
  it('คืน form-options เฉพาะโปรเจกต์ คน active และ size map ของโปรเจกต์ override Workspace', async () => {
    await t.owner.query('UPDATE projects SET size_md_map=$2 WHERE id=$1', [team.project.id, { XS: 0.5, S: 2, M: 4, L: 7, XL: 10 }]);
    await t.owner.query("INSERT INTO labels (workspace_id,project_id,name) VALUES ($1,$2,'ป้ายสมมติ')", [workspaceId, team.project.id]);
    const opts = await team.dev.get(`${projectUrl()}/form-options`);
    expect(opts.status).toBe(200);
    expect(opts.body.modules[0].phases[0].id).toBe(phaseId);
    expect(opts.body.sprints.some((s: { id: string }) => s.id === sprintId)).toBe(true);
    expect(opts.body.members.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([team.leadId, team.devId]));
    expect(opts.body.members.every((m: { initials: string }) => !!m.initials)).toBe(true);
    expect(opts.body.sizeMdMap.XS).toBe(0.5);
    expect(opts.body.labels[0].name).toBe('ป้ายสมมติ');
    expect(opts.body.issueTypes.find((x: { name: string }) => x.name === 'Bug').requiredFields).toContain('severity');
    expect((await viewer.get(`${projectUrl()}/form-options`)).status).toBe(403);
    expect((await guest.get(`${projectUrl()}/form-options`)).status).toBe(403);
  });

  it('Requirement / Screen / Label / Watcher: สร้างรหัสที่ยังไม่มี แทนทั้งชุดตอน PATCH และแสดงใน Table', async () => {
    const label = (await t.owner.query("INSERT INTO labels (workspace_id,project_id,name,color) VALUES ($1,$2,'ป้ายอ้างอิงสมมติ','#0ea5e9') RETURNING id", [workspaceId, team.project.id])).rows[0].id as string;
    const before = seen.length;
    const issue = await create({ requirements: ['fr-02.3', 'FR-02.3', 'NFR-01'], screens: ['SCR-203'], labelIds: [label], watcherIds: [team.devId, team.leadId] });
    expect(issue).toMatchObject({ requirements: ['FR-02.3', 'NFR-01'], screens: ['SCR-203'], labels: [{ id: label, name: 'ป้ายอ้างอิงสมมติ', color: '#0ea5e9' }] });
    const kinds = (await t.owner.query('SELECT code, kind FROM requirements WHERE project_id=$1 ORDER BY code', [team.project.id])).rows;
    expect(kinds).toEqual(expect.arrayContaining([{ code: 'FR-02.3', kind: 'FR' }, { code: 'NFR-01', kind: 'NFR' }]));
    const watchers = (await t.owner.query('SELECT user_id, source FROM issue_watchers WHERE issue_id=$1 ORDER BY source::text', [issue.id])).rows;
    expect(watchers).toEqual([{ user_id: team.leadId, source: 'auto_create' }, { user_id: team.devId, source: 'manual' }]);

    // งานที่สองใช้รหัสเดิม: ไม่สร้างซ้ำ
    const second = await create({ requirements: ['FR-02.3'] });
    expect(second.requirements).toEqual(['FR-02.3']);
    expect((await t.owner.query("SELECT count(*)::int AS n FROM requirements WHERE project_id=$1 AND code='FR-02.3'", [team.project.id])).rows[0].n).toBe(1);

    const p = await team.lead.patch(url(issue.key), { requirements: ['FR-07'], screens: [], labelIds: [] }, issue.version);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ requirements: ['FR-07'], screens: [], labels: [], version: issue.version + 1 });
    const updated = seen.slice(before).find((e) => e.type === 'issue.updated' && e.issueId === issue.id);
    expect(updated?.data.fields).toEqual(['requirements', 'screens', 'labelIds']);
    const acts = (await t.owner.query("SELECT field, old_value, new_value FROM activities WHERE issue_id=$1 AND verb='updated' ORDER BY field", [issue.id])).rows;
    expect(acts).toEqual([
      { field: 'labelIds', old_value: [label], new_value: [] },
      { field: 'requirements', old_value: ['FR-02.3', 'NFR-01'], new_value: ['FR-07'] },
      { field: 'screens', old_value: ['SCR-203'], new_value: [] },
    ]);
    // ส่งชุดเดิมซ้ำ: ไม่เพิ่ม version
    const same = await team.lead.patch(url(issue.key), { requirements: ['FR-07'] }, p.body.version);
    expect(same.body.version).toBe(p.body.version);

    const table = await team.lead.get(`${projectUrl()}/issues?view=table&fields=key,requirements,screens,labels&q=${second.key}`);
    expect(table.body.items).toEqual([{ key: second.key, requirements: ['FR-02.3'], screens: [], labels: [] }]);
    // ค้นด้วยรหัส FR / SCR ตาม placeholder ของ Canvas
    const byFr = await team.lead.get(`${projectUrl()}/issues?fields=key&q=fr-07`);
    expect(byFr.body.items).toEqual([{ key: issue.key }]);
    await team.lead.patch(url(second.key), { screens: ['SCR-404'] }, second.version);
    const byScreen = await team.lead.get(`${projectUrl()}/issues?fields=key&q=SCR-404`);
    expect(byScreen.body.items).toEqual([{ key: second.key }]);
    const opts = await team.dev.get(`${projectUrl()}/form-options`);
    expect(opts.body.requirements.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['FR-02.3', 'FR-07', 'NFR-01']));
    expect(opts.body.screens).toEqual(expect.arrayContaining([{ code: 'SCR-203', name: null }]));
  });

  it('Requirement / Screen / Label ที่ไม่ถูกต้องถูกปฏิเสธโดยไม่สร้างงาน', async () => {
    const otherProject = await team.lead.post(`${team.ws}/projects`, { name: 'โปรเจกต์อื่นสมมติ', key: 'ORF', startDate: '2026-11-05', goliveDate: '2027-03-01' });
    expect(otherProject.status).toBe(201);
    const foreign = (await t.owner.query("INSERT INTO labels (workspace_id,project_id,name) VALUES ($1,$2,'ป้ายโปรเจกต์อื่น') RETURNING id", [workspaceId, otherProject.body.id])).rows[0].id;
    const badCode = await team.lead.post(`${projectUrl()}/issues`, { title: 'รหัสผิดสมมติ', moduleId, requirements: ['REQ 1'] });
    expect(badCode.status).toBe(400);
    const badScreen = await team.lead.post(`${projectUrl()}/issues`, { title: 'รหัสผิดสมมติ', moduleId, screens: ['FR-01'] });
    expect(badScreen.status).toBe(400);
    const r = await team.lead.post(`${projectUrl()}/issues`, { title: 'ป้ายข้ามโปรเจกต์สมมติ', moduleId, labelIds: [foreign] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_reference');
    const outsiderWatch = await team.lead.post(`${projectUrl()}/issues`, { title: 'คนนอกสมมติ', moduleId, watcherIds: ['00000000-0000-4000-8000-000000000001'] });
    expect(outsiderWatch.body.error.code).toBe('invalid_people');
    expect((await t.owner.query("SELECT count(*)::int AS n FROM issues WHERE title IN ('รหัสผิดสมมติ','ป้ายข้ามโปรเจกต์สมมติ','คนนอกสมมติ')")).rows[0].n).toBe(0);
  });

  it('ใช้ตัวกรอง Table ทุกช่องร่วมกัน รวม sprint=current, q ตาม key/title และ overdue', async () => {
    const match = await create({ title: 'ค้นหาสมมติ_100%', moduleId, phaseId, sprintId, priority: 'high', baId: team.devId, assigneeIds: [team.devId], planStart: '2020-01-01', planEnd: '2020-01-02' });
    await create({ title: 'ค้นหาสมมติX100x', sprintId: otherSprintId, priority: 'low', planEnd: '2099-12-31' });
    const filters = `module=${moduleId}&phase=${phaseId}&sprint=current&status=todo&type=task&assignee=me&ba=me&priority=high&overdue=true&q=${encodeURIComponent('สมมติ_100%')}`;
    const r = await team.dev.get(`${projectUrl()}/issues?${filters}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { key: string }) => i.key)).toEqual([match.key]);
    const keySearch = await team.lead.get(`${projectUrl()}/issues?q=${match.key}&status=${match.status.id}`);
    expect(keySearch.body.items.map((i: { key: string }) => i.key)).toEqual([match.key]);
    const otherSprint = await team.lead.get(`${projectUrl()}/issues?sprint=${otherSprintId}&overdue=false`);
    expect(otherSprint.body.items.length).toBeGreaterThan(0);
    expect(otherSprint.body.items.some((i: { key: string }) => i.key === match.key)).toBe(false);
    expect((await team.lead.get(`${projectUrl()}/issues?status=unknown`)).status).toBe(400);
  });

  it('ตัวกรอง none, level, type และไม่รวมงานที่ลบ', async () => {
    const parent = await create({ title: 'ไม่มี sprint สมมติ' });
    const sub = await create({ parentKey: parent.key });
    const deleted = await create();
    await team.lead.delete(url(deleted.key));
    const list = await team.lead.get(`${projectUrl()}/issues?sprint=none&assignee=none&ba=none&phase=none&level=task&type=Task`);
    expect(list.body.items.some((i: { key: string }) => i.key === parent.key)).toBe(true);
    expect(list.body.items.some((i: { key: string }) => i.key === sub.key || i.key === deleted.key)).toBe(false);
    const subs = await team.lead.get(`${projectUrl()}/issues?level=subtask`);
    expect(subs.body.items.some((i: { key: string }) => i.key === sub.key)).toBe(true);
    expect(subs.body.items.every((i: { parentKey: string | null }) => i.parentKey !== null)).toBe(true);
  });

  it('เรียงหลายหน้าแบบ cursor: ค่าซ้ำและ null ไม่ตกหล่น, fields จำกัด payload และตรวจ input', async () => {
    const a = await create({ title: 'ZZ-pagination-synthetic', planEnd: '2090-01-01' });
    const b = await create({ title: 'ZZ-pagination-synthetic', planEnd: '2090-01-01' });
    const c = await create({ title: 'ZZ-pagination-synthetic' });
    const path = `${projectUrl()}/issues?q=ZZ-pagination-synthetic&sort=-planEnd&limit=1&fields=key,title,planEnd`;
    const first = await team.lead.get(path);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items[0].key).toBe(a.key);
    expect(Object.keys(first.body.items[0]).sort()).toEqual(['key', 'planEnd', 'title']);
    const second = await team.lead.get(`${path}&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0].key).toBe(b.key);
    const third = await team.lead.get(`${path}&cursor=${second.body.nextCursor}`);
    expect(third.body.items[0].key).toBe(c.key);
    expect(third.body.nextCursor).toBeNull();
    expect((await team.lead.get(`${projectUrl()}/issues?sort=drop_table`)).body.error.code).toBe('invalid_sort');
    expect((await team.lead.get(`${projectUrl()}/issues?fields=secret`)).body.error.code).toBe('invalid_fields');
    expect((await team.lead.get(`${path}&cursor=malformed`)).body.error.code).toBe('invalid_cursor');
    expect((await team.lead.get(`${projectUrl()}/issues?sort=title&cursor=${first.body.nextCursor}`)).status).toBe(400);
    const numbered = await team.lead.get(`${projectUrl()}/issues?limit=1`);
    const next = await team.lead.get(`${projectUrl()}/issues?limit=1&cursor=${numbered.body.nextCursor}`);
    expect(next.body.items[0].number).toBeGreaterThan(numbered.body.items[0].number);
  });

  it('Table รวม MD ระดับแม่ไม่ซ้ำลูก, progress ถ่วง MD และ aggregate ไม่จำกัดตาม page', async () => {
    const phase = (await t.owner.query("INSERT INTO phases (workspace_id,project_id,module_id,name) VALUES ($1,$2,$3,'กลุ่มรวมสมมติ') RETURNING id", [workspaceId, team.project.id, moduleId])).rows[0].id;
    const parent = await create({ phaseId: phase, estimateMd: 8 });
    await create({ parentKey: parent.key, estimateMd: 2, statusId: status('Done') });
    await create({ parentKey: parent.key, estimateMd: 6 });
    await create({ phaseId: phase, estimateMd: 2, statusId: status('Done') });
    const r = await team.lead.get(`${projectUrl()}/issues?view=table&phase=${phase}&limit=1`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].progressPct).toBe(25);
    expect(r.body.summary).toEqual({ taskCount: 2, subtaskCount: 2, doneCount: 1, estimateMd: 10, progressPct: 40 });
    const module = r.body.modules.find((m: { id: string }) => m.id === moduleId);
    expect(module.phases.find((p: { id: string }) => p.id === phase).estimateMd).toBe(10);
    expect(r.body.items[0]).toHaveProperty('assignees');
    const filtered = await team.lead.get(`${projectUrl()}/issues?view=table&phase=${phase}&status=todo`);
    expect(filtered.body.items.find((i: { key: string }) => i.key === parent.key).progressPct).toBe(25);
  });

  it('Guest Viewer ไม่เห็น Bug แม้แชร์, งานส่วนตัว, คน หรือหน้า Table', async () => {
    const shared = await create({ sharedWithGuests: true, assigneeIds: [team.devId], baId: team.leadId });
    const hidden = await create();
    const bug = await create({ type: 'Bug', severity: 'minor', environment: 'sit', details: { steps: 'สมมติ' }, sharedWithGuests: true });
    const r = await guest.get(`${projectUrl()}/issues?fields=key,assigneeIds,baId,reporterId,title`);
    expect(r.body.items).toEqual([{ key: shared.key, title: shared.title }]);
    expect((await guest.get(url(hidden.key))).status).toBe(404);
    expect((await guest.get(url(bug.key))).status).toBe(404);
    expect((await guest.get(`${projectUrl()}/issues?view=table`)).status).toBe(403);
    await team.lead.delete(url(shared.key));
    const gone = await guest.get(url(shared.key));
    expect(gone.body.error.details.deletedBy).toEqual({ displayName: 'ทีมพัฒนา' });
  });
});

describe('Workflow rules ที่เปิดอยู่', () => {
  it('PATCH และ move ต้องมี Reviewer แต่แก้ Reviewer พร้อมสถานะได้ และ disabled ไม่บล็อก', async () => {
    const id = await addRule('reviewer_required');
    const issue = await create();
    expect((await team.dev.patch(url(issue.key), { statusId: status('Review') }, issue.version)).body.error.code).toBe('reviewer_required');
    expect((await team.dev.post(`${url(issue.key)}/move`, { statusId: status('Review') })).body.error.code).toBe('reviewer_required');
    const r = await team.lead.patch(url(issue.key), { statusId: status('Review'), reviewerId: team.devId }, issue.version);
    expect(r.status).toBe(200);
    await setRuleEnabled(id, false);
    const another = await create();
    expect((await team.lead.patch(url(another.key), { statusId: status('Review') }, another.version)).status).toBe(200);
  });

  it('เฉพาะ Reviewer ปิด Review และ rule config จำกัดคู่สถานะ', async () => {
    const id = await addRule('reviewer_only_done', false, { fromStatusId: status('Review'), toStatusId: status('Done') });
    const issue = await create({ reviewerId: team.devId, statusId: status('Review') });
    expect((await team.lead.post(`${url(issue.key)}/move`, { statusId: status('Done') })).body.error.code).toBe('reviewer_only_done');
    expect((await team.dev.patch(url(issue.key), { statusId: status('Done') }, issue.version)).status).toBe(200);
    await setRuleEnabled(id, false);
  });

  it('กฎ Sub-task ใช้กับ PATCH และ move confirm', async () => {
    const id = await addRule('subtasks_done');
    const parent = await create();
    await create({ parentKey: parent.key });
    const patch = await team.lead.patch(url(parent.key), { statusId: status('Done') }, parent.version);
    expect(patch.status).toBe(422);
    expect(patch.body.error).toMatchObject({ code: 'subtasks_incomplete', details: { open: 1, confirmable: true } });
    const move = await team.lead.post(`${url(parent.key)}/move`, { statusId: status('Done'), confirm: true });
    expect(move.status).toBe(200);
    expect(move.body.warnings[0].code).toBe('subtasks_incomplete');
    await setRuleEnabled(id, false);
    const disabledParent = await create();
    await create({ parentKey: disabledParent.key });
    expect((await team.lead.post(`${url(disabledParent.key)}/move`, { statusId: status('Done') })).status).toBe(200);
  });

  it('Bug Fixed ต้องมี Commit/PR และ Verified เฉพาะ Tester/Reporter โดยไม่ข้าม rule ที่ไม่รู้จัก', async () => {
    const reference = await addRule('fix_reference_required', true);
    const verification = await addRule('tester_or_reporter_only_verified', true);
    const bug = await create({ type: 'Bug', severity: 'major', environment: 'sit', details: { steps: 'สมมติ' }, testerId: team.devId });
    expect((await team.lead.post(`${url(bug.key)}/move`, { statusId: status('Fixed', true) })).body.error.code).toBe('fix_reference_required');
    const install = (await t.owner.query("INSERT INTO git_installations (workspace_id,provider,account_name,external_installation_id) VALUES ($1,'github','synthetic','synthetic-a03') RETURNING id", [workspaceId])).rows[0].id;
    const repo = (await t.owner.query("INSERT INTO git_repositories (workspace_id,installation_id,full_name) VALUES ($1,$2,'synthetic/repo') RETURNING id", [workspaceId, install])).rows[0].id;
    const commit = (await t.owner.query("INSERT INTO git_commits (workspace_id,repository_id,sha,message,committed_at,url) VALUES ($1,$2,'abcdef123','สมมติ',now(),'https://example.com/commit/abcdef123') RETURNING id", [workspaceId, repo])).rows[0].id;
    await t.owner.query("INSERT INTO issue_git_links (workspace_id,issue_id,commit_id,link_source) VALUES ($1,$2,$3,'manual')", [workspaceId, bug.id, commit]);
    const fixed = await team.lead.post(`${url(bug.key)}/move`, { statusId: status('Fixed', true) });
    expect(fixed.status).toBe(200);
    // เพิ่มสมาชิกอีกคนที่แก้ได้ แต่ไม่ใช่ Tester/Reporter
    const another = await client(t.app);
    const anotherId = await signup(another, 'other-dev@issues-synthetic.example.com', 'ผู้พัฒนาสมมติ');
    await addMember(t.owner, team.slug, anotherId, 'member', { key: 'DP', role: 'member' });
    expect((await another.patch(url(bug.key), { statusId: status('Verified', true) }, fixed.body.version)).body.error.code).toBe('tester_or_reporter_only_verified');
    expect((await team.dev.post(`${url(bug.key)}/move`, { statusId: status('Verified', true) })).status).toBe(200);
    await setRuleEnabled(reference, false); await setRuleEnabled(verification, false);
    const unknown = await addRule('future_unknown_rule');
    const issue = await create();
    expect((await team.lead.post(`${url(issue.key)}/move`, { statusId: status('Review') })).body.error.code).toBe('unsupported_workflow_rule');
    await setRuleEnabled(unknown, false);
  });
});

describe('Bulk ใช้กติกา PATCH ต่อรายงาน', () => {
  it('รายงานบางงานเลื่อน Due ต้องอนุมัติ แต่งานดึง Due เข้าและงานอื่นยังสำเร็จ', async () => {
    const early = await create({ planEnd: '2026-12-01' });
    const later = await create({ planEnd: '2026-12-20' });
    const r = await team.dev.post(`${projectUrl()}/issues/bulk`, { keys: [early.key, later.key, 'DP-999999'], set: { planEnd: '2026-12-10' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results).toMatchObject([
      { key: early.key, ok: false, error: { code: 'due_change_requires_approval', status: 403 } },
      { key: later.key, ok: true },
      { key: 'DP-999999', ok: false, error: { code: 'not_found' } },
    ]);
    expect((await team.lead.get(url(early.key))).body.planEnd).toBe('2026-12-01');
    expect((await team.lead.get(url(later.key))).body.planEnd).toBe('2026-12-10');
    expect((await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: ['XX-1'], set: { sprintId } })).status).toBe(400);
  });

  it('ย้าย Module/Sprint ส่งต่อลูก, ลบ bulk ต้องพิมพ์ตาม Canvas และ restore ได้', async () => {
    const parent = await create();
    const child = await create({ parentKey: parent.key });
    const targetModule = team.project.modules[1].id;
    const moved = await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: [parent.key], set: { moduleId: targetModule, sprintId, assigneeIds: [team.devId] } });
    expect(moved.body.results).toEqual([{ key: parent.key, ok: true }]);
    expect((await team.lead.get(url(child.key))).body).toMatchObject({ moduleId: targetModule, sprintId });
    expect((await viewer.post(`${projectUrl()}/issues/bulk`, { keys: [parent.key], set: { sprintId } })).status).toBe(403);
    expect((await team.dev.post(`${projectUrl()}/issues/bulk`, { keys: [parent.key], delete: true, confirmText: 'ลบ 1 งาน' })).status).toBe(403);
    expect((await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: [parent.key], delete: true, confirmText: 'ใช่' })).body.error.code).toBe('confirmation_required');
    const removed = await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: [parent.key, child.key], delete: true, confirmText: 'ลบ 2 งาน' });
    expect(removed.body.results).toEqual([{ key: parent.key, ok: true }, { key: child.key, ok: true }]);
    expect((await team.lead.get(url(child.key))).status).toBe(410);
    expect((await team.lead.post(`${url(parent.key)}/restore`)).status).toBe(200);
  });

  it('Baseline: แก้แผนได้โดยไม่ต้องใส่เหตุผล (บันทึกใน plan_changes / Activity) · ใส่เหตุผลได้ถ้าต้องการ', async () => {
    const issue = await create({ assigneeIds: [team.leadId], planEnd: '2026-12-20' });
    await t.owner.query("INSERT INTO plan_baselines (workspace_id,project_id,version,source,created_by) VALUES ($1,$2,1,'manual',$3)", [workspaceId, team.project.id, team.leadId]);
    // ผู้ใช้ขอ 2026-11-08: ไม่ต้องเตือนให้ใส่เหตุผล
    const quiet = await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: [issue.key], set: { planEnd: '2026-12-15' } });
    expect(quiet.body.results[0].ok).toBe(true);
    const current = (await team.lead.get(url(issue.key))).body;
    const assign = await team.lead.put(`${url(issue.key)}/assignees`, { assigneeIds: [team.devId] }).set('If-Match', `"${current.version}"`);
    expect(assign.status, JSON.stringify(assign.body)).toBe(200);
    const acts = await t.owner.query(`SELECT field FROM activities WHERE issue_id=$1 AND verb='updated' ORDER BY field`, [issue.id]);
    expect(acts.rows.map((x: { field: string }) => x.field)).toEqual(expect.arrayContaining(['assigneeIds', 'planEnd']));
    seen.length = 0;
    const r = await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: [issue.key], set: { planEnd: '2026-12-14', planChangeReason: 'ปรับแผนสมมติ' } });
    expect(r.body.results[0].ok).toBe(true);
    const changes = await t.owner.query('SELECT field,reason FROM plan_changes WHERE issue_id=$1 ORDER BY changed_at, field', [issue.id]);
    expect(changes.rows).toEqual([{ field: 'planEnd', reason: null }, { field: 'assigneeIds', reason: null }, { field: 'planEnd', reason: 'ปรับแผนสมมติ' }]);
    expect(seen.find((e) => e.type === 'plan.changed')?.data.reason).toBe('ปรับแผนสมมติ');
  });
});

// Regression ของ A06: ใช้ API จริงปิด Sprint และบังคับลำดับคำขอด้วย lock ของ PostgreSQL
async function sprintFixture() {
  const key = `SG${++serial}`;
  const base = `${team.ws}/projects/${key}`;
  expect((await team.lead.post(`${team.ws}/projects`, { key, name: 'Sprint guard test', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['Demo'] })).status).toBe(201);
  const project = (await team.lead.get(base)).body;
  await t.owner.query('DELETE FROM sprints WHERE project_id=$1', [project.id]);
  const first = await team.lead.post(`${base}/sprints`, { name: 'Current sprint', startDate: '2026-11-30', endDate: '2026-12-11' });
  const next = await team.lead.post(`${base}/sprints`, { name: 'Next sprint', startDate: '2026-12-14', endDate: '2026-12-25' });
  expect(first.status).toBe(201); expect(next.status).toBe(201);
  expect((await team.lead.post(`${base}/sprints/${first.body.id}/start`)).status).toBe(200);
  async function issue(input: Record<string, unknown> = {}) {
    const response = await team.lead.post(`${base}/issues`, { title: 'Sprint issue', moduleId: project.modules[0].id, size: 'XS', ...input });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }
  return { base, project, sprint: first.body, next: next.body, issue };
}

/** ต่อคิว complete ก่อน operation โดยรอหลักฐานว่า request รอ lock จริง ไม่อาศัยการหน่วงเวลา */
async function completeBefore<T>(f: Awaited<ReturnType<typeof sprintFixture>>, operation: () => PromiseLike<T>) {
  const locker = new pg.Client({ connectionString: OWNER_URL });
  await locker.connect();
  let completion: Promise<Awaited<ReturnType<Client['post']>>> | undefined;
  let pending: Promise<T> | undefined;
  try {
    await locker.query('BEGIN');
    const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [f.project.id]);
    async function waitForBlocked(count: number) {
      await vi.waitFor(async () => {
        const result = await t.owner.query("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT count(*)::int AS n FROM blocked", [pid]);
        expect(result.rows[0].n).toBeGreaterThanOrEqual(count);
      }, { timeout: 5000, interval: 10 });
    }
    completion = team.lead.post(`${f.base}/sprints/${f.sprint.id}/complete`, { moveIncompleteTo: f.next.id }).then((response) => response);
    await waitForBlocked(1);
    pending = Promise.resolve(operation());
    await waitForBlocked(2);
    await locker.query('COMMIT');
    const [completed, response] = await Promise.all([completion, pending]);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    return response;
  } finally {
    await locker.query('ROLLBACK');
    await Promise.allSettled([completion, pending]);
    await locker.end();
  }
}

describe('Sprint ที่จบแล้วและการปิด Sprint พร้อมเปลี่ยนแผน', () => {
  it('ปฏิเสธ create/PATCH/move/bulk ที่ใส่งานเข้า completed โดยไม่เปลี่ยนงานหรือส่ง Event', async () => {
    const f = await sprintFixture(); const one = await f.issue(); const two = await f.issue();
    expect((await team.lead.post(`${f.base}/sprints/${f.sprint.id}/complete`, { moveIncompleteTo: 'backlog' })).status).toBe(200);
    const beforeEvents = seen.length;
    const beforeCount = (await t.owner.query('SELECT count(*)::int AS n FROM issues WHERE project_id=$1', [f.project.id])).rows[0].n;
    const created = await team.lead.post(`${f.base}/issues`, { title: 'Must not create', moduleId: f.project.modules[0].id, size: 'XS', sprintId: f.sprint.id });
    const patched = await team.lead.patch(url(one.key), { title: 'Must roll back', sprintId: f.sprint.id }, one.version);
    const moved = await team.lead.post(`${url(one.key)}/move`, { sprintId: f.sprint.id });
    for (const response of [created, patched, moved]) { expect(response.status, JSON.stringify(response.body)).toBe(422); expect(response.body.error).toMatchObject({ code: 'sprint_completed', details: { sprintId: f.sprint.id } }); }
    const bulk = await team.lead.post(`${f.base}/issues/bulk`, { keys: [one.key, two.key], set: { sprintId: f.sprint.id } });
    expect(bulk.status).toBe(200); expect(bulk.body.results).toMatchObject([{ key: one.key, ok: false, error: { status: 422, code: 'sprint_completed' } }, { key: two.key, ok: false, error: { status: 422, code: 'sprint_completed' } }]);
    expect(seen).toHaveLength(beforeEvents);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM issues WHERE project_id=$1', [f.project.id])).rows[0].n).toBe(beforeCount);
    for (const issue of [one, two]) expect((await team.lead.get(url(issue.key))).body).toMatchObject({ sprintId: null, version: issue.version, title: issue.title });
  });

  it('ห้ามเพิ่ม Sub-task เข้าแม่ใน completed แต่ยังแก้รายละเอียดเดิมหรือย้ายออกได้', async () => {
    const f = await sprintFixture();
    const done = f.project.statuses.find((row: { name: string; boardColumnId: string | null }) => row.name === 'Done' && !row.boardColumnId).id;
    const parent = await f.issue({ sprintId: f.sprint.id, statusId: done });
    await team.lead.post(`${f.base}/sprints/${f.sprint.id}/complete`, { moveIncompleteTo: 'backlog' });
    const child = await team.lead.post(`${f.base}/issues`, { title: 'Must not create child', parentKey: parent.key, size: 'XS', sprintId: f.next.id });
    expect(child.status).toBe(422); expect(child.body.error.code).toBe('sprint_completed');
    const patch = await team.lead.patch(url(parent.key), { title: 'Historical edit', sprintId: f.sprint.id }, parent.version);
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((await team.lead.post(`${url(parent.key)}/move`, { sprintId: f.sprint.id })).status).toBe(200);
    const moved = await team.lead.post(`${url(parent.key)}/move`, { sprintId: f.next.id });
    expect(moved.status).toBe(200); expect(moved.body.sprintId).toBe(f.next.id);
    const backlog = await team.lead.patch(url(parent.key), { sprintId: null }, moved.body.version);
    expect(backlog.status).toBe(200); expect(backlog.body.sprintId).toBeNull();
  });

  it.each(['create', 'patch', 'move', 'bulk'] as const)('%s รอ complete แล้วตรวจปลายทางใหม่ ไม่ใส่งานเข้า Sprint ที่เพิ่งจบ', async (method) => {
    const f = await sprintFixture(); const issue = await f.issue();
    const response = await completeBefore(f, () => {
      if (method === 'create') return team.lead.post(`${f.base}/issues`, { title: 'Race create', moduleId: f.project.modules[0].id, size: 'XS', sprintId: f.sprint.id });
      if (method === 'patch') return team.lead.patch(url(issue.key), { sprintId: f.sprint.id }, issue.version);
      if (method === 'move') return team.lead.post(`${url(issue.key)}/move`, { sprintId: f.sprint.id });
      return team.lead.post(`${f.base}/issues/bulk`, { keys: [issue.key], set: { sprintId: f.sprint.id } });
    });
    if (method === 'bulk') { expect(response.status).toBe(200); expect(response.body.results[0]).toMatchObject({ ok: false, error: { code: 'sprint_completed', status: 422 } }); }
    else { expect(response.status, JSON.stringify(response.body)).toBe(422); expect(response.body.error.code).toBe('sprint_completed'); }
    expect((await team.lead.get(url(issue.key))).body.sprintId).toBeNull();
    expect((await t.owner.query('SELECT count(*)::int AS n FROM issues WHERE project_id=$1 AND sprint_id=$2', [f.project.id, f.sprint.id])).rows[0].n).toBe(0);
  });

  it('สร้างลูกที่แข่งกับ complete อ่าน Sprint ที่แม่ย้ายไปใหม่ โดยไม่ deadlock', async () => {
    const f = await sprintFixture(); const parent = await f.issue({ sprintId: f.sprint.id });
    const child = await completeBefore(f, () => team.lead.post(`${f.base}/issues`, { title: 'Child after complete', parentKey: parent.key, size: 'XS' }));
    expect(child.status, JSON.stringify(child.body)).toBe(201); expect(child.body.sprintId).toBe(f.next.id);
    expect((await team.lead.get(url(parent.key))).body.sprintId).toBe(child.body.sprintId);
  });

  it('PATCH ที่รอ complete ยังคง If-Match และไม่เขียนทับ version ที่ complete เปลี่ยน', async () => {
    const f = await sprintFixture(); const issue = await f.issue({ sprintId: f.sprint.id });
    const response = await completeBefore(f, () => team.lead.patch(url(issue.key), { sprintId: null }, issue.version));
    expect(response.status, JSON.stringify(response.body)).toBe(409); expect(response.body.error.code).toBe('conflict');
    expect((await team.lead.get(url(issue.key))).body.sprintId).toBe(f.next.id);
  });

  it('move ที่ไม่มี If-Match อ่าน version หลัง complete แล้วจึงย้ายออกได้', async () => {
    const f = await sprintFixture(); const issue = await f.issue({ sprintId: f.sprint.id }); const child = await f.issue({ parentKey: issue.key });
    const response = await completeBefore(f, () => team.lead.post(`${url(issue.key)}/move`, { sprintId: null }));
    expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body.sprintId).toBeNull();
    expect((await team.lead.get(url(child.key))).body.sprintId).toBeNull();
  });
});

describe('หน้า Task v2 (ผู้ใช้ตัดสิน 2026-11-08)', () => {
  it('System Analyst สร้าง แก้ และซ่อนจาก Guest Viewer', async () => {
    const task = await create({ saId: team.devId, sharedWithGuests: true });
    expect(task.saId).toBe(team.devId);
    const patched = await team.lead.patch(url(task.key), { saId: team.leadId }, task.version);
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.saId).toBe(team.leadId);
    expect((await guest.get(url(task.key))).body.saId).toBeUndefined();
    const bad = await team.lead.patch(url(task.key), { saId: '00000000-0000-4000-8000-000000000000' }, patched.body.version);
    expect(bad.body.error.code).toBe('invalid_people');
  });

  it('หมายเหตุ (Remark): สร้าง แก้ ล้างเป็น null บันทึก Activity แสดงใน Table และซ่อนจาก Guest Viewer', async () => {
    const task = await create({ remark: 'รอข้อมูลสมมติจากทีมบัญชี', sharedWithGuests: true });
    expect(task.remark).toBe('รอข้อมูลสมมติจากทีมบัญชี');
    const child = await create({ parentKey: task.key, remark: 'Sub-task มีหมายเหตุของตัวเอง' });
    expect(child.remark).toBe('Sub-task มีหมายเหตุของตัวเอง');
    const patched = await team.lead.patch(url(task.key), { remark: 'บรรทัดแรก\nบรรทัดที่สอง' }, task.version);
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.remark).toBe('บรรทัดแรก\nบรรทัดที่สอง');
    const rows = (await team.lead.get(`${projectUrl()}/issues?view=table&q=${task.key}`)).body.items;
    expect(rows.find((row: { key: string }) => row.key === task.key).remark).toBe('บรรทัดแรก\nบรรทัดที่สอง');
    const activity = await t.owner.query("SELECT old_value, new_value FROM activities WHERE issue_id=$1 AND field='remark'", [task.id]);
    expect(activity.rows).toEqual([{ old_value: 'รอข้อมูลสมมติจากทีมบัญชี', new_value: 'บรรทัดแรก\nบรรทัดที่สอง' }]);
    expect((await guest.get(url(task.key))).body.remark).toBeUndefined();
    const cleared = await team.lead.patch(url(task.key), { remark: '' }, patched.body.version);
    expect(cleared.body.remark).toBeNull();
    const tooLong = await team.lead.patch(url(task.key), { remark: 'ก'.repeat(10_001) }, cleared.body.version);
    expect(tooLong.status).toBe(400);
  });

  it('ย้าย Sub-task ไปใต้ Task อื่นได้เฉพาะ Module เดียวกัน และบันทึกประวัติทั้งสามงาน', async () => {
    const a = await create();
    const b = await create();
    const child = await create({ parentKey: a.key });
    const otherModule = (await t.owner.query(`INSERT INTO modules (workspace_id,project_id,name) VALUES ($1,$2,'Module สมมติอื่น') RETURNING id`, [workspaceId, team.project.id])).rows[0].id;
    const elsewhere = await create({ moduleId: otherModule });
    const blocked = await team.lead.patch(url(child.key), { parentKey: elsewhere.key }, child.version);
    expect(blocked.body.error.code).toBe('parent_other_module');
    expect((await team.lead.patch(url(a.key), { parentKey: b.key }, a.version)).body.error.code).toBe('not_a_subtask');
    const moved = await team.lead.patch(url(child.key), { parentKey: b.key }, child.version);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.parentKey).toBe(b.key);
    expect((await team.lead.get(url(a.key))).body.subtasks).toHaveLength(0);
    expect((await team.lead.get(url(b.key))).body.subtasks.map((x: { key: string }) => x.key)).toEqual([child.key]);
    const verbs = (await t.owner.query('SELECT verb FROM activities WHERE issue_id = ANY($1) ORDER BY created_at', [[a.id, b.id]])).rows.map((r: { verb: string }) => r.verb);
    expect(verbs).toEqual(expect.arrayContaining(['subtask_moved_out', 'subtask_moved_in']));
  });

  it('PATCH วันที่ Sub-task เกิน Task แม่: 422 ให้ยืนยัน แล้วขยายแม่ทั้งวันเริ่มและวันจบ', async () => {
    const parent = await create({ planStart: '2026-12-01', planEnd: '2026-12-04' });
    const child = await create({ parentKey: parent.key, planStart: '2026-12-02', planEnd: '2026-12-03' });
    const ask = await team.lead.patch(url(child.key), { planStart: '2026-11-30', planEnd: '2026-12-08', planChangeReason: 'ทดสอบขยายช่วง' }, child.version);
    expect(ask.status).toBe(422);
    expect(ask.body.error.details).toMatchObject({ confirmField: 'extendParent', nextStart: '2026-11-30', nextEnd: '2026-12-08' });
    // ชุด test นี้ตั้ง Baseline ไว้ก่อนหน้า จึงต้องมีเหตุผลการแก้แผน
    const ok = await team.lead.patch(url(child.key), { planStart: '2026-11-30', planEnd: '2026-12-08', extendParent: true, planChangeReason: 'ทดสอบขยายช่วง' }, child.version);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = (await team.lead.get(url(parent.key))).body;
    expect(after).toMatchObject({ planStart: '2026-11-30', planEnd: '2026-12-08' });
    // แก้ช่องอื่นของ Sub-task ไม่ต้องยืนยันซ้ำ
    expect((await team.lead.patch(url(child.key), { title: 'เปลี่ยนชื่อสมมติ' }, ok.body.version)).status).toBe(200);
    const changes = (await t.owner.query('SELECT reason FROM plan_changes WHERE issue_id = $1', [parent.id])).rows.map((r: { reason: string }) => r.reason);
    expect(changes).toContain(`ขยายช่วงตาม Sub-task ${child.key}`);
  });

  it('Acceptance criteria ยังไม่ครบ: move และ PATCH ไป Done ต้องยืนยันก่อน', async () => {
    const task = await create();
    const item = await team.lead.post(`${url(task.key)}/checklist`, { text: 'เกณฑ์สมมติ', kind: 'acceptance' });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    await team.lead.post(`${url(task.key)}/checklist`, { text: 'ขั้นตอนสมมติ', kind: 'checklist' });
    const done = status('Done');
    const ask = await team.lead.post(`${url(task.key)}/move`, { statusId: done });
    expect(ask.status).toBe(422);
    expect(ask.body.error).toMatchObject({ code: 'acceptance_incomplete', details: { open: 1, total: 1, confirmable: true, confirmField: 'confirm' } });
    const latest = (await team.lead.get(url(task.key))).body;
    const patchAsk = await team.lead.patch(url(task.key), { statusId: done }, latest.version);
    expect(patchAsk.body.error.code).toBe('acceptance_incomplete');
    const moved = await team.lead.post(`${url(task.key)}/move`, { statusId: done, confirm: true });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.warnings.map((w: { code: string }) => w.code)).toContain('acceptance_incomplete');
  });
});


describe('ย้ายการ์ด: งานของคนอื่นดูได้อย่างเดียว (04-permissions ข้อ 3.3)', () => {
  let other: Client, otherId: string;
  beforeAll(async () => {
    other = await client(t.app);
    otherId = await signup(other, 'dev2@issues-synthetic.example.com', 'ผู้พัฒนาสองสมมติ');
    await addMember(t.owner, team.slug, otherId, 'member', { key: 'DP', role: 'member' });
  });

  it('Member ย้าย / เปลี่ยนสถานะงานของ Dev อีกคนไม่ได้ · เจ้าของงานและ Admin ย้ายได้ · ยังแก้ฟิลด์อื่นได้ตามสิทธิ์ issue.edit', async () => {
    const issue = await create({ assigneeIds: [team.devId] });
    const denied = await other.post(`${url(issue.key)}/move`, { statusId: status('In progress') });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('not_issue_assignee');
    const patchDenied = await other.patch(url(issue.key), { statusId: status('In progress') }, issue.version);
    expect(patchDenied.body.error.code).toBe('not_issue_assignee');
    // ใส่ชื่อตัวเองพร้อมเปลี่ยนสถานะในคำขอเดียวก็ไม่ผ่าน
    expect((await other.patch(url(issue.key), { statusId: status('In progress'), assigneeIds: [otherId] }, issue.version)).body.error.code).toBe('not_issue_assignee');
    expect((await other.post(`${url(issue.key)}/move`, { afterKey: issue.key })).status).toBe(403);
    const unchanged = (await team.lead.get(url(issue.key))).body;
    expect(unchanged.status.id).toBe(issue.status.id);
    expect(unchanged.version).toBe(issue.version);

    const viewOnly = (await other.get(url(issue.key))).body;
    expect(viewOnly.canMove).toBe(false);
    const board = (await other.get(`${projectUrl()}/board`)).body;
    const card = board.columns.flatMap((c: { cards: { key: string; canMove: boolean }[] }) => c.cards).find((c: { key: string }) => c.key === issue.key);
    expect(card.canMove).toBe(false);
    const titled = await other.patch(url(issue.key), { title: 'แก้ชื่อสมมติ' }, issue.version);
    expect(titled.status, JSON.stringify(titled.body)).toBe(200);

    expect((await team.dev.get(url(issue.key))).body.canMove).toBe(true);
    const own = await team.dev.post(`${url(issue.key)}/move`, { statusId: status('In progress') });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const admin = await team.lead.post(`${url(issue.key)}/move`, { statusId: status('To do') });
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(admin.body.canMove).toBe(true);
  });

  it('งานที่ยังไม่มีผู้รับผิดชอบย้ายได้ · Reviewer / Tester ของงานย้ายได้ · Backlog ส่ง canMove ต่องาน', async () => {
    const open = await create();
    expect((await other.post(`${url(open.key)}/move`, { statusId: status('In progress') })).status).toBe(200);
    const reviewing = await create({ assigneeIds: [team.devId], reviewerId: otherId });
    const byReviewer = await other.post(`${url(reviewing.key)}/move`, { statusId: status('In progress') });
    expect(byReviewer.status, JSON.stringify(byReviewer.body)).toBe(200);
    const testing = await create({ assigneeIds: [team.devId], testerId: otherId });
    expect((await other.post(`${url(testing.key)}/move`, { statusId: status('In progress') })).status).toBe(200);

    const foreign = await create({ assigneeIds: [team.devId] });
    const backlog = (await other.get(`${projectUrl()}/backlog`)).body;
    const all = [...backlog.backlog.issues, ...backlog.sprints.flatMap((sp: { issues: unknown[] }) => sp.issues)] as { key: string; canMove: boolean }[];
    expect(all.find((i) => i.key === foreign.key)?.canMove).toBe(false);
    expect(all.find((i) => i.key === open.key)?.canMove).toBe(true);
  });
});
