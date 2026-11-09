import { schema } from '@friday/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantInfo } from '../src/common/request.js';
import { TenantDb } from '../src/common/tenant.js';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { recalculatePlanEnds } from '../src/project-structure/plan-ends.js';
import { defaultWorkflowRules, SUPPORTED_WORKFLOW_RULE_TYPES, WORKFLOW_RULES } from '../src/project-structure/rules.js';
import { SUPPORTED_WORKFLOW_RULE_TYPES as ISSUE_RULE_TYPES } from '../src/issues/rules.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

// ข้อมูลสมมติเท่านั้น
let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let guestMember: Client;
const seen: { event: DomainEvent; committed: boolean }[] = [];

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  guest = await client(t.app);
  guestMember = await client(t.app);
  const guestId = await signup(guest, 'client@structure.example.com', 'Test Client');
  const guestMemberId = await signup(guestMember, 'outsource@structure.example.com', 'Test Outsource');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: 'DP', role: 'viewer' });
  await addMember(t.owner, team.slug, guestMemberId, 'guest', { key: 'DP', role: 'member' });
  // Event ต้องส่งหลัง commit: connection ของ Owner เห็นค่าใหม่แล้วตอนผู้ฟังทำงาน
  t.app.get(EventBus).on('*', async (event) => {
    if (!event.issueId) return;
    const { rows } = await t.owner.query('SELECT plan_end::text, status_id, module_id FROM issues WHERE id = $1', [event.issueId]);
    let committed = !!rows[0];
    if (event.data.planEnd) committed = rows[0]?.plan_end === (event.data.planEnd as { to: string }).to;
    if (event.type === 'issue.status_changed') committed = rows[0]?.status_id === (event.data.to as { id: string }).id;
    seen.push({ event, committed });
  });
});
afterAll(() => t.close());

const p = (path = '') => `${team.ws}/projects/DP${path}`;

async function createIssue(body: Record<string, unknown>, by: Client = team.lead) {
  const r = await by.post(p('/issues'), { title: 'งานทดสอบโครงสร้าง', moduleId: team.project.modules[0].id, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; key: string; version: number; planStart: string | null; planEnd: string | null };
}

const issue = async (key: string) => (await team.lead.get(`${team.ws}/issues/${key}`)).body;
const standardWorkflow = () => team.project.statuses.find((x: { name: string }) => x.name === 'To do').workflowId as string;
const bugWorkflow = () => team.project.statuses.find((x: { name: string }) => x.name === 'Open').workflowId as string;
const statusId = (name: string, workflowId = standardWorkflow()) =>
  team.project.statuses.find((x: { name: string; workflowId: string }) => x.name === name && x.workflowId === workflowId).id as string;

describe('สิทธิ์ของหน้า L2', () => {
  it('อ่านได้ด้วย project.view · แก้ต้องมี project.settings · Guest ไม่เห็น Settings แต่เห็น Milestone', async () => {
    expect((await team.dev.get(p('/modules'))).status).toBe(200);
    expect((await team.dev.get(p('/workflows'))).status).toBe(200);
    const denied = await team.dev.post(p('/labels'), { name: 'frontend' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'forbidden', details: { permission: 'project.settings' } });

    for (const c of [guest, guestMember]) {
      for (const path of ['/modules', '/workflows', '/issue-types', '/custom-fields', '/labels', '/holidays']) {
        const r = await c.get(p(path));
        expect(r.status, path).toBe(403);
        expect(r.body.error.code).toBe('guest_settings_hidden');
      }
      expect((await c.get(p('/milestones'))).status).toBe(200);
    }
  });

  it('โปรเจกต์ที่เก็บถาวรแก้ตั้งค่าไม่ได้ แต่ยังอ่านได้', async () => {
    await t.owner.query(`UPDATE projects SET status = 'archived' WHERE key = 'DP'`);
    try {
      const r = await team.lead.post(p('/labels'), { name: 'archived-test' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('project_archived');
      expect((await team.lead.get(p('/labels'))).status).toBe(200);
    } finally {
      await t.owner.query(`UPDATE projects SET status = 'planning' WHERE key = 'DP'`);
    }
  });
});

describe('Module และกลุ่มงาน', () => {
  it('สร้าง แก้ เรียงลำดับ Module พร้อมเจ้าของ (Dev หลัก) และจำนวนงาน', async () => {
    const list = await team.lead.get(p('/modules'));
    expect(list.body.items.map((m: { name: string }) => m.name)).toEqual(['Credit Line', 'Drawdown']);

    const created = await team.lead.post(p('/modules'), { name: 'Repayment', color: '#0369A1', ownerUserId: team.devId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Repayment', color: '#0369A1', sort: 2, issueCount: 0, phases: [], owner: { id: team.devId, displayName: 'Kaijeaw', initials: 'KA' } });

    const outsider = await client(t.app);
    const outsiderId = await signup(outsider, 'nobody@structure.example.com', 'Test Nobody');
    const badOwner = await team.lead.patch(p(`/modules/${created.body.id}`), { ownerUserId: outsiderId });
    expect(badOwner.status).toBe(400);
    expect((await team.lead.post(p('/modules'), { name: 'X', color: 'red' })).status).toBe(400);

    const renamed = await team.lead.patch(p(`/modules/${created.body.id}`), { name: 'Repayment รับชำระเงิน', ownerUserId: null });
    expect(renamed.body).toMatchObject({ name: 'Repayment รับชำระเงิน', owner: null });

    const ids = list.body.items.map((m: { id: string }) => m.id);
    const reordered = await team.lead.post(p('/modules/reorder'), { ids: [created.body.id, ids[1], ids[0]] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.items.map((m: { name: string; sort: number }) => [m.name, m.sort])).toEqual([
      ['Repayment รับชำระเงิน', 0], ['Drawdown', 1], ['Credit Line', 2],
    ]);
    const missing = await team.lead.post(p('/modules/reorder'), { ids: [created.body.id] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('invalid_reorder');
  });

  it('กลุ่มงาน: CRUD + เรียงลำดับ · ลบกลุ่มงานที่มีงานต้องส่ง moveTo (หรือ none)', async () => {
    const moduleId = team.project.modules[1].id;
    const a = (await team.lead.post(p(`/modules/${moduleId}/phases`), { name: 'Sprint 1' })).body;
    const b = (await team.lead.post(p(`/modules/${moduleId}/phases`), { name: 'Sprint 2' })).body;
    expect([a.sort, b.sort]).toEqual([0, 1]);
    expect((await team.lead.patch(p(`/modules/${moduleId}/phases/${b.id}`), { name: 'Sprint 2 (UAT)' })).body.name).toBe('Sprint 2 (UAT)');
    const order = await team.lead.post(p(`/modules/${moduleId}/phases/reorder`), { ids: [b.id, a.id] });
    expect(order.body.items.map((x: { name: string }) => x.name)).toEqual(['Sprint 2 (UAT)', 'Sprint 1']);
    // กลุ่มงานของ Module อื่นใช้ path นี้ไม่ได้
    expect((await team.lead.patch(p(`/modules/${team.project.modules[0].id}/phases/${a.id}`), { name: 'x' })).status).toBe(404);

    const task = await createIssue({ moduleId, phaseId: a.id });
    const sub = await createIssue({ parentKey: task.key });
    expect((await team.lead.get(p(`/modules/${moduleId}/phases`))).body.items.find((x: { id: string }) => x.id === a.id).issueCount).toBe(2);

    const blocked = await team.lead.delete(p(`/modules/${moduleId}/phases/${a.id}`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'phase_has_issues', details: { issueCount: 2 } });
    const moved = await team.lead.delete(p(`/modules/${moduleId}/phases/${a.id}?moveTo=${b.id}`));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ movedIssues: 2, moveTo: b.id });
    expect((await issue(task.key)).phaseId).toBe(b.id);
    expect((await issue(sub.key)).phaseId).toBe(b.id);

    const none = await team.lead.delete(p(`/modules/${moduleId}/phases/${b.id}`), { moveTo: 'none' });
    expect(none.body).toMatchObject({ movedIssues: 2, moveTo: null });
    const { rows } = await t.owner.query('SELECT count(*)::int AS n FROM issues WHERE phase_id IS NOT NULL AND module_id = $1', [moduleId]);
    expect(rows[0].n).toBe(0);
  });

  it('กลุ่ม: คนที่สร้าง Task ได้ (ไม่มี project.settings) สร้างกลุ่มใหม่ได้ แต่เปลี่ยนชื่อ / ลบไม่ได้ · ย้าย Task ข้ามกลุ่มแล้ว Sub-task ตาม', async () => {
    const moduleId = team.project.modules[0].id;
    const made = await team.dev.post(p(`/modules/${moduleId}/phases`), { name: 'กลุ่ม A' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await team.dev.patch(p(`/modules/${moduleId}/phases/${made.body.id}`), { name: 'x' })).status).toBe(403);
    expect((await team.dev.delete(p(`/modules/${moduleId}/phases/${made.body.id}`), { moveTo: 'none' })).status).toBe(403);
    expect((await guest.post(p(`/modules/${moduleId}/phases`), { name: 'x' })).status).toBe(403);
    const other = (await team.lead.post(p(`/modules/${moduleId}/phases`), { name: 'กลุ่ม B' })).body;
    const task = await createIssue({ moduleId, phaseId: made.body.id });
    const sub = await createIssue({ parentKey: task.key });
    expect((await issue(sub.key)).phaseId).toBe(made.body.id);
    const current = await issue(task.key);
    expect((await team.lead.patch(`${team.ws}/issues/${task.key}`, { phaseId: other.id }, current.version)).status).toBe(200);
    expect((await issue(sub.key)).phaseId).toBe(other.id);
    expect((await team.lead.patch(`${team.ws}/issues/${task.key}`, { phaseId: null }, (await issue(task.key)).version)).status).toBe(200);
    expect((await issue(sub.key)).phaseId).toBeNull();
  });

  it('ลบ Module ที่มีงานต้องส่ง moveTo · งานและ Sub-task ย้ายตาม, กลุ่มงานถูกลบ, Milestone เลิกผูก', async () => {
    const from = (await team.lead.post(p('/modules'), { name: 'Campaign' })).body;
    const to = team.project.modules[0].id;
    const phase = (await team.lead.post(p(`/modules/${from.id}/phases`), { name: 'กลุ่มงาน A' })).body;
    const task = await createIssue({ moduleId: from.id, phaseId: phase.id });
    const sub = await createIssue({ parentKey: task.key });
    const trashed = await createIssue({ moduleId: from.id });
    expect((await team.lead.delete(`${team.ws}/issues/${trashed.key}`)).status).toBeLessThan(300);
    const ms = (await team.lead.post(p('/milestones'), { name: 'Campaign Go-live', date: '2027-02-15', moduleId: from.id })).body;

    const blocked = await team.lead.delete(p(`/modules/${from.id}`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'module_has_issues', details: { issueCount: 2 } });
    expect((await team.lead.delete(p(`/modules/${from.id}?moveTo=${from.id}`))).status).toBe(400);

    seen.length = 0;
    const r = await team.lead.delete(p(`/modules/${from.id}`), { moveTo: to });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ movedIssues: 2, moveTo: to });
    const { rows } = await t.owner.query(`SELECT number, module_id, phase_id FROM issues WHERE id = ANY($1) ORDER BY number`, [[task.id, sub.id, trashed.id]]);
    expect(rows.every((x) => x.module_id === to && x.phase_id === null)).toBe(true);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM phases WHERE id = $1', [phase.id])).rows[0].n).toBe(0);
    const milestone = (await team.lead.get(p('/milestones'))).body.items.find((m: { id: string }) => m.id === ms.id);
    expect(milestone).toMatchObject({ moduleId: null, module: null });
    // ประวัติและ Event เฉพาะงานที่ไม่อยู่ในถังขยะ
    const acts = await t.owner.query(`SELECT issue_id, field FROM activities WHERE verb = 'updated' AND field IN ('moduleId', 'phaseId') AND issue_id = ANY($1)`, [[task.id, sub.id, trashed.id]]);
    expect(acts.rows.filter((a) => a.field === 'moduleId').map((a) => a.issue_id).sort()).toEqual([task.id, sub.id].sort());
    expect(seen.filter((e) => e.event.type === 'issue.updated').map((e) => e.event.issueId).sort()).toEqual([task.id, sub.id].sort());
    expect(seen.every((e) => e.committed)).toBe(true);
  });
});

describe('Milestone', () => {
  it('CRUD และผูกงานเพื่อคิด % · Guest ที่เป็น Viewer ไม่เห็น Bug', async () => {
    const created = await team.lead.post(p('/milestones'), { name: 'Drawdown UAT', date: '2027-03-01', moduleId: team.project.modules[1].id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Drawdown UAT', date: '2027-03-01', module: { name: 'Drawdown' }, issueCount: 0, progressPct: 0 });
    expect((await team.lead.post(p('/milestones'), { name: 'x', date: '2027-02-30' })).status).toBe(400);
    expect((await team.dev.post(p('/milestones'), { name: 'x', date: '2027-02-01' })).status).toBe(403);

    const doneId = statusId('Done');
    const a = await createIssue({ title: 'งานที่เสร็จแล้ว', statusId: doneId, sharedWithGuests: true });
    const b = await createIssue({ title: 'งานที่ยังไม่เสร็จ' });
    const bug = await createIssue({ type: 'Bug', title: 'Bug ทดสอบ', severity: 'minor', environment: 'sit', details: { steps: '1. เปิดหน้า' } });
    const linked = await team.lead.post(p(`/milestones/${created.body.id}/issues`), { keys: [a.key, b.key, bug.key, a.key] });
    expect(linked.status).toBe(200);
    expect(linked.body.items.map((x: { key: string }) => x.key)).toEqual([a.key, b.key, bug.key]);
    expect((await team.lead.post(p(`/milestones/${created.body.id}/issues`), { keys: ['DP-9999'] })).status).toBe(404);

    const lead = (await team.lead.get(p('/milestones'))).body.items.find((m: { id: string }) => m.id === created.body.id);
    expect(lead).toMatchObject({ issueCount: 3, doneCount: 1, progressPct: 33 });
    const asGuest = (await guest.get(p('/milestones'))).body.items.find((m: { id: string }) => m.id === created.body.id);
    expect(asGuest).toMatchObject({ issueCount: 2, doneCount: 1, progressPct: 50 });
    const guestIssues = (await guest.get(p(`/milestones/${created.body.id}/issues`))).body.items;
    expect(guestIssues).toEqual([
      expect.objectContaining({ key: a.key, canOpen: true }),
      expect.objectContaining({ key: b.key, canOpen: false }),
    ]);

    const moved = await team.lead.patch(p(`/milestones/${created.body.id}`), { date: '2027-03-08', moduleId: null });
    expect(moved.body).toMatchObject({ date: '2027-03-08', moduleId: null });
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'project.milestone_moved'`);
    expect(audit.rows[0].summary).toContain('2027-03-01 → 2027-03-08');

    expect((await team.lead.delete(p(`/milestones/${created.body.id}/issues/${b.key}`))).status).toBe(204);
    expect((await team.lead.delete(p(`/milestones/${created.body.id}/issues/${b.key}`))).status).toBe(404);
    expect((await team.lead.get(p(`/milestones/${created.body.id}/issues`))).body.items).toHaveLength(2);
    expect((await team.lead.delete(p(`/milestones/${created.body.id}`))).status).toBe(204);
    expect((await team.lead.get(p(`/milestones/${created.body.id}/issues`))).status).toBe(404);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM milestone_issues WHERE milestone_id = $1', [created.body.id])).rows[0].n).toBe(0);
  });
});

describe('Workflow และสถานะ', () => {
  it('GET workflows แยกมาตรฐานกับ Bug พร้อมสถานะ จำนวนงาน และรายการกฎ', async () => {
    const r = await team.lead.get(p('/workflows'));
    expect(r.status).toBe(200);
    const [std, bug] = r.body.items;
    expect(std).toMatchObject({ kind: 'standard', issueTypes: expect.arrayContaining([expect.objectContaining({ name: 'Task' })]) });
    expect(std.statuses.map((x: { name: string }) => x.name)).toEqual(['To do', 'In progress', 'Review', 'Done']);
    expect(bug.kind).toBe('bug');
    expect(bug.statuses.find((x: { name: string }) => x.name === 'Fixed').boardColumnId).toBe(statusId('Review'));
    expect(std.catalog.map((c: { ruleType: string }) => c.ruleType)).toEqual(['subtasks_done', 'reviewer_required', 'wip_warning', 'reviewer_only_done']);
    // ยังไม่มีแถวกฎ: สถานะที่มีผลตรงกับ fallback ของ issues/rules.ts
    expect(std.catalog.find((c: { ruleType: string }) => c.ruleType === 'subtasks_done')).toMatchObject({ configured: false, enabled: true });
    expect(std.catalog.find((c: { ruleType: string }) => c.ruleType === 'reviewer_required')).toMatchObject({ configured: false, enabled: false, defaultEnabled: true });
    expect(bug.catalog.map((c: { ruleType: string }) => c.ruleType)).toEqual(['fix_reference_required', 'tester_or_reporter_only_verified', 'reopen_on_failed_test', 'critical_auto_start']);
  });

  it('เพิ่ม แก้ (หมวด, WIP limit, คอลัมน์บอร์ด) และเรียงสถานะ', async () => {
    const wf = standardWorkflow();
    const qa = await team.lead.post(p(`/workflows/${wf}/statuses`), { name: 'QA', category: 'in_progress', wipLimit: 3 });
    expect(qa.status).toBe(201);
    expect(qa.body).toMatchObject({ name: 'QA', category: 'in_progress', wipLimit: 3, boardColumnId: null, sort: 4, issueCount: 0 });
    expect((await team.lead.post(p(`/workflows/${wf}/statuses`), { name: 'qa', category: 'todo' })).body.error.code).toBe('status_name_taken');
    expect((await team.lead.post(p(`/workflows/${wf}/statuses`), { name: 'X', category: 'blocked' })).status).toBe(400);
    expect((await team.lead.patch(p(`/workflows/${wf}/statuses/${qa.body.id}`), { wipLimit: 0 })).status).toBe(400);
    expect((await team.lead.patch(p(`/workflows/${wf}/statuses/${qa.body.id}`), { wipLimit: null, name: 'QA Test' })).body).toMatchObject({ wipLimit: null, name: 'QA Test' });

    // คอลัมน์บอร์ดใช้กับ Workflow ของ Bug: ต้องชี้ไปสถานะของ Workflow มาตรฐาน
    const bugWf = bugWorkflow();
    const retest = await team.lead.post(p(`/workflows/${bugWf}/statuses`), { name: 'Retest', category: 'in_progress', boardColumnId: qa.body.id });
    expect(retest.status).toBe(201);
    expect(retest.body.boardColumnId).toBe(qa.body.id);
    const sameWf = await team.lead.patch(p(`/workflows/${bugWf}/statuses/${retest.body.id}`), { boardColumnId: statusId('Open', bugWf) });
    expect(sameWf.body.error.code).toBe('invalid_board_column');
    expect((await team.lead.patch(p(`/workflows/${bugWf}/statuses/${retest.body.id}`), { boardColumnId: statusId('Fixed', bugWf) })).body.error.code).toBe('invalid_board_column');
    const nested = await team.lead.patch(p(`/workflows/${wf}/statuses/${qa.body.id}`), { boardColumnId: statusId('Open', bugWf) });
    expect(nested.status).toBe(422);
    const board = await team.lead.get(p('/board?type=bug'));
    expect(board.body.columns.map((c: { name: string }) => c.name)).toContain('Retest');

    const ids = (await team.lead.get(p(`/workflows/${wf}/statuses`))).body.items.map((x: { id: string }) => x.id);
    const reordered = await team.lead.post(p(`/workflows/${wf}/statuses/reorder`), { ids: [ids[0], ids[1], ids[4], ids[2], ids[3]] });
    expect(reordered.body.items.map((x: { name: string }) => x.name)).toEqual(['To do', 'In progress', 'QA Test', 'Review', 'Done']);
    const std = await team.lead.get(p('/board'));
    expect(std.body.columns.map((c: { name: string }) => c.name)).toEqual(['To do', 'In progress', 'QA Test', 'Review', 'Done']);
  });

  it('Workflow ต้องมีหมวด To do และ Done อย่างน้อยอย่างละ 1', async () => {
    const wf = standardWorkflow();
    const done = await team.lead.delete(p(`/workflows/${wf}/statuses/${statusId('Done')}`), { moveTo: statusId('Review') });
    expect(done.status).toBe(422);
    expect(done.body.error).toMatchObject({ code: 'workflow_needs_todo_done', details: { missing: ['done'] } });
    const todo = await team.lead.patch(p(`/workflows/${wf}/statuses/${statusId('To do')}`), { category: 'in_progress' });
    expect(todo.status).toBe(422);
    expect(todo.body.error.details.missing).toEqual(['todo']);
  });

  it('ลบสถานะที่มีงานต้องส่ง moveTo · งานย้ายพร้อมประวัติ, คอลัมน์บอร์ดของ Bug และกฎที่อ้างถึงถูกจัดการ', async () => {
    const wf = standardWorkflow();
    const bugWf = bugWorkflow();
    const staging = (await team.lead.post(p(`/workflows/${wf}/statuses`), { name: 'Staging', category: 'in_progress' })).body;
    const verify = (await team.lead.post(p(`/workflows/${bugWf}/statuses`), { name: 'Verify on staging', category: 'in_progress', boardColumnId: staging.id })).body;
    const rule = (await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'reviewer_required', config: { toStatusId: staging.id } })).body;
    const keep = (await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'subtasks_done' })).body;
    const a = await createIssue({ statusId: staging.id });
    const b = await createIssue({ statusId: staging.id });

    const blocked = await team.lead.delete(p(`/workflows/${wf}/statuses/${staging.id}`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'status_has_issues', details: { issueCount: 2 } });
    expect((await team.lead.delete(p(`/workflows/${wf}/statuses/${staging.id}`), { moveTo: statusId('Open', bugWf) })).body.error.code).toBe('status_not_in_workflow');

    seen.length = 0;
    const review = statusId('Review');
    const r = await team.lead.delete(p(`/workflows/${wf}/statuses/${staging.id}?moveTo=${review}`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ movedIssues: 2, moveTo: review, removedRules: [rule.id] });
    expect((await issue(a.key)).status.id).toBe(review);
    expect((await issue(b.key)).version).toBe(b.version + 1);
    const bugStatuses = (await team.lead.get(p(`/workflows/${bugWf}/statuses`))).body.items;
    expect(bugStatuses.find((x: { id: string }) => x.id === verify.id).boardColumnId).toBe(review);
    const rules = (await team.lead.get(p(`/workflows/${wf}/rules`))).body.items.map((x: { id: string }) => x.id);
    expect(rules).toEqual([keep.id]);
    expect(seen.filter((e) => e.event.type === 'issue.status_changed').map((e) => e.event.data.to)).toEqual([
      expect.objectContaining({ id: review }), expect.objectContaining({ id: review }),
    ]);
    expect((await team.lead.delete(p(`/workflows/${wf}/rules/${keep.id}`))).status).toBe(204);
  });
});

describe('กฎการย้ายสถานะ (ตรวจจริงโดย issues/rules.ts ของ A03)', () => {
  it('rules.ts ใช้รายชื่อเดียวกับ A03 และมีค่าเริ่มต้นตามหน้าจอให้ Workflow ใหม่', () => {
    expect(SUPPORTED_WORKFLOW_RULE_TYPES).toBe(ISSUE_RULE_TYPES);
    expect(Object.keys(WORKFLOW_RULES).sort()).toEqual([...ISSUE_RULE_TYPES].sort());
    expect(defaultWorkflowRules('standard')).toEqual([
      { ruleType: 'subtasks_done', enabled: true, config: {} },
      { ruleType: 'reviewer_required', enabled: true, config: {} },
      { ruleType: 'wip_warning', enabled: true, config: {} },
      { ruleType: 'reviewer_only_done', enabled: false, config: {} },
    ]);
    expect(defaultWorkflowRules('bug').map((r) => [r.ruleType, r.enabled])).toEqual([
      ['fix_reference_required', true], ['tester_or_reporter_only_verified', true], ['reopen_on_failed_test', true], ['critical_auto_start', false],
    ]);
  });

  it('สร้าง เปิด / ปิด และลบกฎ · การย้ายสถานะใช้กฎตามที่ตั้ง', async () => {
    const wf = standardWorkflow();
    const review = statusId('Review');
    const task = await createIssue({});

    expect((await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'no_such_rule' })).status).toBe(400);
    expect((await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'reviewer_required', config: { toStatusId: statusId('Open', bugWorkflow()) } })).body.error.code).toBe('status_not_in_workflow');
    expect((await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'reviewer_required', config: { extra: 1 } })).status).toBe(400);
    expect((await team.dev.post(p(`/workflows/${wf}/rules`), { ruleType: 'reviewer_required' })).status).toBe(403);

    const created = await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'reviewer_required', config: { toStatusId: review } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ruleType: 'reviewer_required', enabled: true, kind: 'transition', title: 'ย้ายไป Review ต้องมี Reviewer', config: { toStatusId: review } });
    const dup = await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'reviewer_required', config: { toStatusId: review } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'rule_exists', details: { ruleId: created.body.id } });

    const blocked = await team.dev.post(`${team.ws}/issues/${task.key}/move`, { statusId: review });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toMatchObject({ code: 'reviewer_required', details: { ruleId: created.body.id } });

    const off = await team.lead.patch(p(`/workflows/${wf}/rules/${created.body.id}`), { enabled: false });
    expect(off.body.enabled).toBe(false);
    const list = (await team.lead.get(p(`/workflows/${wf}/rules`))).body;
    expect(list.catalog.find((c: { ruleType: string }) => c.ruleType === 'reviewer_required')).toMatchObject({ configured: true, enabled: false });
    expect((await team.dev.post(`${team.ws}/issues/${task.key}/move`, { statusId: review })).status).toBe(200);

    expect((await team.lead.delete(p(`/workflows/${wf}/rules/${created.body.id}`))).status).toBe(204);
    expect((await team.lead.delete(p(`/workflows/${wf}/rules/${created.body.id}`))).status).toBe(404);
    const audits = await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'project.workflow_rule_changed'`);
    expect(audits.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('ปิดกฎ Sub-task ด้วยแถว disabled แล้วย้ายไป Done ได้โดยไม่ต้องยืนยัน', async () => {
    const wf = standardWorkflow();
    const parent = await createIssue({});
    await createIssue({ parentKey: parent.key });
    expect((await team.lead.post(`${team.ws}/issues/${parent.key}/move`, { statusId: statusId('Done') })).body.error.code).toBe('subtasks_incomplete');
    const rule = (await team.lead.post(p(`/workflows/${wf}/rules`), { ruleType: 'subtasks_done', enabled: false })).body;
    expect((await team.lead.post(`${team.ws}/issues/${parent.key}/move`, { statusId: statusId('Done') })).status).toBe(200);
    await team.lead.delete(p(`/workflows/${wf}/rules/${rule.id}`));
  });
});

describe('ประเภทงาน', () => {
  it('อ่านรายการและรายตัว · เปิดปิดประเภท · ตั้งฟิลด์บังคับที่การสร้างงานตรวจจริง', async () => {
    const list = await team.lead.get(p('/issue-types'));
    expect(list.body.items.map((x: { name: string }) => x.name)).toEqual(['Story', 'Task', 'Bug', 'Spike']);
    expect(list.body.requiredFieldOptions.map((f: { key: string }) => f.key)).toContain('module');
    const types = Object.fromEntries(list.body.items.map((x: { name: string; id: string }) => [x.name, x]));
    expect(types.Bug).toMatchObject({ workflow: { name: 'Bug' }, requiredFields: ['title', 'severity', 'environment', 'steps'], enabled: true });
    expect((await team.lead.get(p(`/issue-types/${types.Task.id}`))).body.name).toBe('Task');

    const off = await team.lead.patch(p(`/issue-types/${types.Spike.id}`), { enabled: false });
    expect(off.body.enabled).toBe(false);
    const spike = await team.lead.post(p('/issues'), { type: 'Spike', title: 'Spike ทดสอบ', details: { question: 'ทำได้ไหม', timebox_hours: 4 } });
    expect(spike.body.error.code).toBe('issue_type_disabled');
    await team.lead.patch(p(`/issue-types/${types.Spike.id}`), { enabled: true });

    const req = await team.lead.patch(p(`/issue-types/${types.Task.id}`), { requiredFields: ['size', 'module', 'size'] });
    expect(req.body.requiredFields).toEqual(['title', 'module', 'size']);
    const missing = await team.lead.post(p('/issues'), { title: 'ไม่มี Size', moduleId: team.project.modules[0].id });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'missing_required_fields', details: { fields: ['size'] } });
    await team.lead.patch(p(`/issue-types/${types.Task.id}`), { requiredFields: ['module'] });
    expect((await team.lead.patch(p(`/issue-types/${types.Task.id}`), { requiredFields: ['salary'] })).status).toBe(400);

    for (const name of ['Story', 'Bug', 'Spike']) await team.lead.patch(p(`/issue-types/${types[name].id}`), { enabled: false });
    const last = await team.lead.patch(p(`/issue-types/${types.Task.id}`), { enabled: false });
    expect(last.status).toBe(422);
    expect(last.body.error.code).toBe('last_issue_type');
    for (const name of ['Story', 'Bug', 'Spike']) await team.lead.patch(p(`/issue-types/${types[name].id}`), { enabled: true });
  });
});

describe('Custom field และ Label', () => {
  it('Custom field: CRUD · ตัวเลือกมี id คงที่ · ห้ามเอาตัวเลือกที่มีงานใช้ออก / เปลี่ยนชนิดเมื่อมีค่า', async () => {
    expect((await team.lead.post(p('/custom-fields'), { name: 'Release version', fieldType: 'select' })).status).toBe(400);
    expect((await team.lead.post(p('/custom-fields'), { name: 'Customer request', fieldType: 'text', options: { choices: [{ label: 'x' }] } })).status).toBe(400);
    const text = await team.lead.post(p('/custom-fields'), { name: 'Customer request', fieldType: 'text' });
    expect(text.status).toBe(201);
    expect(text.body).toMatchObject({ fieldType: 'text', options: null, sort: 0 });
    expect((await team.lead.post(p('/custom-fields'), { name: 'customer REQUEST', fieldType: 'number' })).body.error.code).toBe('custom_field_exists');

    const sel = (await team.lead.post(p('/custom-fields'), { name: 'Release version', fieldType: 'select', options: { choices: [{ label: '1.0' }, { label: '1.1' }] } })).body;
    expect(sel.sort).toBe(1);
    const [v10, v11] = sel.options.choices;
    expect(v10.id).toEqual(expect.any(String));

    const renamed = await team.lead.patch(p(`/custom-fields/${sel.id}`), { options: { choices: [{ id: v10.id, label: '1.0.0' }, v11, { label: '2.0' }] } });
    expect(renamed.body.options.choices.map((c: { id: string; label: string }) => c.label)).toEqual(['1.0.0', '1.1', '2.0']);
    expect(renamed.body.options.choices[0].id).toBe(v10.id);

    const task = await createIssue({});
    await t.owner.query('INSERT INTO issue_custom_values (workspace_id, issue_id, field_id, value) SELECT workspace_id, id, $2, to_jsonb($3::text) FROM issues WHERE id = $1', [task.id, sel.id, v10.id]);
    const inUse = await team.lead.patch(p(`/custom-fields/${sel.id}`), { options: { choices: [v11] } });
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toMatchObject({ code: 'choice_in_use', details: { choices: ['1.0.0'] } });
    expect((await team.lead.patch(p(`/custom-fields/${sel.id}`), { fieldType: 'text' })).body.error.code).toBe('custom_field_in_use');
    expect((await team.lead.patch(p(`/custom-fields/${text.body.id}`), { fieldType: 'number', name: 'Effort ทีมลูกค้า' })).body).toMatchObject({ fieldType: 'number', name: 'Effort ทีมลูกค้า' });

    expect((await team.dev.get(p('/custom-fields'))).body.items).toHaveLength(2);
    expect((await team.lead.delete(p(`/custom-fields/${sel.id}`))).status).toBe(204);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM issue_custom_values WHERE field_id = $1', [sel.id])).rows[0].n).toBe(0);
    expect((await team.lead.delete(p(`/custom-fields/${sel.id}`))).status).toBe(404);
  });

  it('Label: CRUD · ชื่อซ้ำ (ไม่สนตัวพิมพ์) ตอบ 409 · ลบแล้วหลุดจากงาน', async () => {
    const fe = await team.lead.post(p('/labels'), { name: 'frontend', color: '#1D4ED8' });
    expect(fe.status).toBe(201);
    expect(fe.body).toMatchObject({ name: 'frontend', color: '#1D4ED8', issueCount: 0 });
    const be = (await team.lead.post(p('/labels'), { name: 'backend' })).body;
    expect((await team.lead.post(p('/labels'), { name: 'Frontend' })).body.error.code).toBe('label_exists');
    expect((await team.lead.patch(p(`/labels/${be.id}`), { name: 'FRONTEND' })).status).toBe(409);
    expect((await team.lead.patch(p(`/labels/${be.id}`), { name: 'hotfix', color: '#DC2626' })).body).toMatchObject({ name: 'hotfix', color: '#DC2626' });

    const task = await createIssue({});
    await t.owner.query('INSERT INTO issue_labels (workspace_id, issue_id, label_id) SELECT workspace_id, id, $2 FROM issues WHERE id = $1', [task.id, fe.body.id]);
    const list = (await team.lead.get(p('/labels'))).body.items;
    expect(list.map((l: { name: string; issueCount: number }) => [l.name, l.issueCount])).toEqual([['frontend', 1], ['hotfix', 0]]);
    expect((await team.lead.delete(p(`/labels/${fe.body.id}`))).status).toBe(204);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM issue_labels WHERE issue_id = $1', [task.id])).rows[0].n).toBe(0);
  });
});

describe('วันหยุดของโปรเจกต์ และคำนวณ Plan End ใหม่', () => {
  it('GET แสดงวันหยุดของโปรเจกต์และของปฏิทินหลักในช่วงโปรเจกต์', async () => {
    const r = await team.lead.get(p('/holidays'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ range: { from: '2026-11-05', to: '2027-04-21' }, calendar: { name: 'ธปท. 2569', source: 'bot' }, items: [] });
    expect(r.body.calendarHolidays.map((h: { date: string }) => h.date)).toEqual(['2026-12-07', '2026-12-10']);
    expect((await team.lead.get(p('/holidays?from=2026-12-08&to=2026-12-31'))).body.calendarHolidays).toHaveLength(1);
    expect((await team.lead.get(p('/holidays?from=2026-12-31&to=2026-12-01'))).status).toBe(400);
  });

  it('เพิ่มวันหยุดแล้ว Plan End ของงานที่ยังไม่เสร็จและคร่อมวันนั้นเลื่อน · ลบแล้วกลับ · หลัง Baseline เขียนการแก้ไขแผน', async () => {
    // จ. 14 – ศ. 18 ธ.ค. 2569 = 5 วันทำการ
    const spanning = await createIssue({ title: 'งานคร่อมวันหยุด', planStart: '2026-12-14', estimateMd: 5 });
    expect(spanning.planEnd).toBe('2026-12-18');
    const manual = await createIssue({ title: 'กำหนดวันจบเอง', planStart: '2026-12-15', planEnd: '2026-12-16' });
    const startsOnHoliday = await createIssue({ title: 'เริ่มวันหยุด', planStart: '2026-12-16', estimateMd: 2 });
    const before = await createIssue({ title: 'จบก่อนวันหยุด', planStart: '2026-12-14', estimateMd: 2 });
    const done = await createIssue({ title: 'เสร็จแล้ว', planStart: '2026-12-14', estimateMd: 5, statusId: statusId('Done') });
    const parent = await createIssue({ title: 'งานแม่', planStart: '2026-12-14', planEnd: '2026-12-18' });
    const sub = await createIssue({ parentKey: parent.key, planStart: '2026-12-14', estimateMd: 3 });

    seen.length = 0;
    const added = await team.lead.post(p('/holidays'), { date: '2026-12-16', name: 'Company outing' });
    expect(added.status).toBe(201);
    expect(added.body.holiday).toMatchObject({ date: '2026-12-16', name: 'Company outing' });
    expect(added.body.warnings).toEqual([]);
    const byKey = Object.fromEntries(added.body.recalculated.map((c: { key: string }) => [c.key, c]));
    expect(Object.keys(byKey).sort()).toEqual([spanning.key, manual.key, startsOnHoliday.key, parent.key, sub.key].sort());
    expect(byKey[spanning.key]).toMatchObject({ planStart: null, planEnd: { from: '2026-12-18', to: '2026-12-21' } });
    expect(byKey[manual.key].planEnd).toEqual({ from: '2026-12-16', to: '2026-12-17' });
    expect(byKey[startsOnHoliday.key]).toMatchObject({ planStart: { from: '2026-12-16', to: '2026-12-17' }, planEnd: { from: '2026-12-17', to: '2026-12-18' } });
    expect(byKey[sub.key].planEnd.to).toBe('2026-12-17');
    expect((await issue(spanning.key))).toMatchObject({ planEnd: '2026-12-21', version: spanning.version + 1 });
    expect((await issue(before.key)).planEnd).toBe('2026-12-15');
    expect((await issue(done.key)).planEnd).toBe('2026-12-18');
    // ยังไม่มี Baseline: ไม่เขียน plan_changes · มีประวัติในงาน · Event หลัง commit
    expect((await t.owner.query('SELECT count(*)::int AS n FROM plan_changes')).rows[0].n).toBe(0);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM activities WHERE issue_id = $1 AND field = 'planEnd'`, [spanning.id])).rows[0].n).toBe(1);
    const updates = seen.filter((e) => e.event.type === 'issue.updated');
    expect(updates).toHaveLength(5);
    expect(updates[0].event.data).toMatchObject({ reason: 'วันหยุดเปลี่ยน', fields: expect.arrayContaining(['planEnd']) });
    expect(seen.some((e) => e.event.type === 'plan.changed')).toBe(false);
    expect(seen.every((e) => e.committed)).toBe(true);

    expect((await team.lead.post(p('/holidays'), { date: '2026-12-16', name: 'ซ้ำ' })).body.error.code).toBe('holiday_exists');
    const weekend = await team.lead.post(p('/holidays'), { date: '2026-12-19', name: 'วันเสาร์' });
    expect(weekend.body).toMatchObject({ recalculated: [], warnings: [{ code: 'already_non_working' }] });
    expect((await team.dev.post(p('/holidays'), { date: '2026-12-22', name: 'x' })).status).toBe(403);

    // ตั้ง Baseline แล้วลบวันหยุด: Plan End กลับ และบันทึกในแท็บการแก้ไขแผน
    await t.owner.query(`INSERT INTO plan_baselines (workspace_id, project_id, version, name, source) SELECT workspace_id, id, 1, 'Baseline v1', 'manual' FROM projects WHERE key = 'DP'`);
    seen.length = 0;
    const removed = await team.lead.delete(p(`/holidays/${added.body.holiday.id}`));
    expect(removed.status).toBe(200);
    expect(removed.body.recalculated.find((c: { key: string }) => c.key === spanning.key).planEnd).toEqual({ from: '2026-12-21', to: '2026-12-18' });
    expect((await issue(spanning.key)).planEnd).toBe('2026-12-18');
    expect((await issue(manual.key)).planEnd).toBe('2026-12-16');
    // Plan Start ที่เลื่อนแล้วไม่ย้อนกลับเอง (วันเริ่มเป็นวันทำการอยู่แล้ว)
    expect((await issue(startsOnHoliday.key))).toMatchObject({ planStart: '2026-12-17', planEnd: '2026-12-18' });
    const changes = await t.owner.query(`SELECT field, old_value, new_value, reason, source, changed_by, baseline_id FROM plan_changes WHERE issue_id = $1`, [spanning.id]);
    expect(changes.rows).toEqual([expect.objectContaining({ field: 'planEnd', old_value: '2026-12-21', new_value: '2026-12-18', reason: 'วันหยุดเปลี่ยน', changed_by: team.leadId, baseline_id: expect.any(String) })]);
    expect(seen.filter((e) => e.event.type === 'plan.changed')).toHaveLength(removed.body.recalculated.length);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('project.holiday_added', 'project.holiday_removed')`)).rows[0].n).toBe(3);
    expect((await team.lead.delete(p(`/holidays/${added.body.holiday.id}`))).status).toBe(404);
  });

  it('recalculatePlanEnds(tx, project) ไม่ส่งปฏิทินเดิม: คิดใหม่จาก Man-Day เฉพาะงานที่ไม่มี Sub-task (ให้ A18 ใช้)', async () => {
    const leaf = await createIssue({ title: 'งานใบ', planStart: '2027-01-11', estimateMd: 3 });
    const noEstimate = await createIssue({ title: 'ไม่มี Man-Day', planStart: '2027-01-11', planEnd: '2027-01-13' });
    const parent = await createIssue({ title: 'งานแม่มี Man-Day', planStart: '2027-01-11', estimateMd: 3 });
    await createIssue({ parentKey: parent.key, planStart: '2027-01-11', estimateMd: 1 });
    expect(leaf.planEnd).toBe('2027-01-13');
    // วันหยุดของ Workspace เปลี่ยน (จำลองงาน A18): เพิ่ม 12 ม.ค. ในปฏิทินหลัก
    await t.owner.query(`INSERT INTO holidays (calendar_id, date, name) SELECT holiday_calendar_id, '2027-01-12', 'วันหยุดสมมติ' FROM workspace_settings`);
    const { rows } = await t.owner.query(`SELECT id, workspace_id FROM projects WHERE key = 'DP'`);
    const tenant: TenantInfo = { workspaceId: rows[0].workspace_id, slug: team.slug, role: 'owner' };
    const result = await t.app.get(TenantDb).run({ userId: team.leadId, sessionId: 'test' }, tenant, async (tx) => {
      const [row] = await tx.select().from(schema.projects).where(eq(schema.projects.id, rows[0].id));
      return recalculatePlanEnds(tx, row);
    });
    expect(result.changes.map((c) => c.key)).toEqual([leaf.key]);
    expect(result.changes[0].planEnd).toEqual({ from: '2027-01-13', to: '2027-01-14' });
    expect(result.events.map((e) => e.type)).toEqual(['issue.updated', 'plan.changed']);
    expect((await issue(noEstimate.key)).planEnd).toBe('2027-01-13');
    expect((await issue(parent.key)).planEnd).toBe('2027-01-13');
    const sys = await t.owner.query(`SELECT actor_id, actor_kind FROM activities WHERE issue_id = $1 AND field = 'planEnd'`, [leaf.id]);
    expect(sys.rows).toEqual([{ actor_id: null, actor_kind: 'system' }]);
  });
});
