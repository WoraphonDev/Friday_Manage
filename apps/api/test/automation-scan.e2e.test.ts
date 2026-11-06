// N03 / N04 (full-system-audit-2026-11-06) · สแกนงานเลย Due ให้ถึงงานหลังลำดับ 200 · กฎของบัญชีที่ถูกปิดต้องไม่แก้ข้อมูล
// ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AutomationEngine } from '../src/automation/engine.js';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let engine: AutomationEngine;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  engine = t.app.get(AutomationEngine);
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.owner.query('DELETE FROM automation_rules');
  await t.owner.query('DELETE FROM issues WHERE project_id = $1', [team.project.id]);
});

/** งานยังไม่เสร็จที่เลย Due จำนวน n (Priority low) · คืน id ของงานลำดับสุดท้าย */
async function overdueIssues(n: number) {
  const first = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานสมมติ 1', moduleId: team.project.modules[0].id, priority: 'low' });
  expect(first.status).toBe(201);
  await t.owner.query(`UPDATE issues SET plan_end = '2026-01-01' WHERE id = $1`, [first.body.id]);
  await t.owner.query(
    `INSERT INTO issues (workspace_id, project_id, number, title, issue_type_id, status_id, module_id, priority, plan_end, reporter_id, created_by)
     SELECT workspace_id, project_id, number + g, 'งานสมมติ ' || g, issue_type_id, status_id, module_id, 'low', '2026-01-01', reporter_id, created_by
     FROM issues CROSS JOIN generate_series(1, $2::int - 1) g WHERE id = $1`,
    [first.body.id, n],
  );
  // เลขงานเดินต่อจากรอบก่อน (ลบงานแล้วตัวนับไม่ย้อน) · งานลำดับสุดท้าย = เลขมากสุด
  return (await t.owner.query('SELECT id FROM issues WHERE project_id = $1 ORDER BY number DESC LIMIT 1', [team.project.id])).rows[0].id as string;
}
const rule = async (body: Record<string, unknown>) => {
  const r = await team.lead.post(`${team.ws}/projects/${team.key}/automations`, { trigger: 'overdue', conditions: [{ field: 'priority', op: 'eq', value: 'high' }], ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
};
const priorityOf = async (id: string) => (await t.owner.query('SELECT priority FROM issues WHERE id = $1', [id])).rows[0].priority;

describe('scanOverdue (N03)', () => {
  it('งานที่ตรงเงื่อนไขหลัง 200 งานที่ไม่ตรง ถูกทำครั้งเดียว · สแกนซ้ำไม่ทำซ้ำ', async () => {
    const last = await overdueIssues(201);
    await t.owner.query(`UPDATE issues SET priority = 'high' WHERE id = $1`, [last]);
    await rule({ name: 'เฉพาะ High', actions: [{ type: 'set_priority', priority: 'urgent' }] });
    expect(await engine.scanOverdue()).toEqual({ ran: 1 });
    expect(await priorityOf(last)).toBe('urgent');
    expect(await engine.scanOverdue()).toEqual({ ran: 0 });
  });

  it('200 งานแรกเคยทำแล้ว (มี dedupe) → รอบถัดไปไปถึงงานที่เหลือ', async () => {
    const last = await overdueIssues(250);
    await t.owner.query(`UPDATE issues SET priority = 'high' WHERE project_id = $1`, [team.project.id]);
    const r = await rule({ name: 'ทุกงาน High', actions: [{ type: 'add_label', label: 'ต้องเตือน' }] });
    expect(await engine.scanOverdue()).toEqual({ ran: 200 });
    expect(await engine.scanOverdue()).toEqual({ ran: 50 });
    expect(await engine.scanOverdue()).toEqual({ ran: 0 });
    const labelled = (await t.owner.query(`SELECT count(DISTINCT il.issue_id)::int AS n FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = 'ต้องเตือน'`)).rows[0].n;
    expect(labelled).toBe(250);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = $1`, [last])).rows[0].n).toBe(1);
    expect(r.id).toBeTruthy();
  });
});

describe('ผู้สร้างกฎถูกปิดบัญชี (N04)', () => {
  it('บัญชีปิด → งานไม่เปลี่ยนและบันทึก failed · เปิดบัญชีกลับ → ทำงานได้ · deactivated ใน Workspace ก็ไม่ทำงาน', async () => {
    const issue = await overdueIssues(1);
    await t.owner.query(`UPDATE issues SET priority = 'high' WHERE id = $1`, [issue]);
    const r = await rule({ name: 'กฎของบัญชีที่ปิด', actions: [{ type: 'set_priority', priority: 'urgent' }] });
    await t.owner.query('UPDATE users SET disabled_at = now() WHERE id = $1', [team.leadId]);
    try {
      expect(await engine.scanOverdue()).toEqual({ ran: 0 });
      expect(await priorityOf(issue)).toBe('high');
      const run = (await t.owner.query('SELECT result, detail FROM automation_runs WHERE rule_id = $1 ORDER BY created_at DESC LIMIT 1', [r.id])).rows[0];
      expect(run).toMatchObject({ result: 'failed', detail: { reason: 'creator_inactive' } });
    } finally {
      await t.owner.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [team.leadId]);
    }
    const wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE workspace_id = $1 AND user_id = $2`, [wsId, team.leadId]);
    try {
      expect(await engine.scanOverdue()).toEqual({ ran: 0 });
      expect(await priorityOf(issue)).toBe('high');
    } finally {
      await t.owner.query(`UPDATE workspace_members SET status = 'active' WHERE workspace_id = $1 AND user_id = $2`, [wsId, team.leadId]);
    }
    expect(await engine.scanOverdue()).toEqual({ ran: 1 });
    expect(await priorityOf(issue)).toBe('urgent');
  });
});
