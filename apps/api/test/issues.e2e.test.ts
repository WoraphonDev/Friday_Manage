// ข้อมูลสมมติ · ฐานข้อมูลแยกและล้างด้วย startApp ตามกติกา lane
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

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

  it('Baseline บังคับเหตุผลทั้ง bulk และ PUT Assignees พร้อม plan_changes/event', async () => {
    const issue = await create({ assigneeIds: [team.leadId], planEnd: '2026-12-20' });
    await t.owner.query("INSERT INTO plan_baselines (workspace_id,project_id,version,source,created_by) VALUES ($1,$2,1,'manual',$3)", [workspaceId, team.project.id, team.leadId]);
    const missing = await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: [issue.key], set: { planEnd: '2026-12-15' } });
    expect(missing.body.results[0].error.code).toBe('plan_change_reason_required');
    const assignMissing = await team.lead.put(`${url(issue.key)}/assignees`, { assigneeIds: [team.devId] }).set('If-Match', `"${issue.version}"`);
    expect(assignMissing.body.error.code).toBe('plan_change_reason_required');
    seen.length = 0;
    const r = await team.lead.post(`${projectUrl()}/issues/bulk`, { keys: [issue.key], set: { planEnd: '2026-12-15', assigneeIds: [team.devId], planChangeReason: 'ปรับแผนสมมติ' } });
    expect(r.body.results[0].ok).toBe(true);
    const changes = await t.owner.query('SELECT field,reason FROM plan_changes WHERE issue_id=$1 ORDER BY field', [issue.id]);
    expect(changes.rows).toEqual([{ field: 'assigneeIds', reason: 'ปรับแผนสมมติ' }, { field: 'planEnd', reason: 'ปรับแผนสมมติ' }]);
    expect(seen.find((e) => e.type === 'plan.changed')?.data.reason).toBe('ปรับแผนสมมติ');
  });
});
