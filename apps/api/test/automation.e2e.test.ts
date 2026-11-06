// A26 · Automation (เมื่อ … ถ้า … ให้ …) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomationEngine, type Facts, matches } from '../src/automation/engine.js';
import { type Condition } from '../src/automation/rules.js';
import { EventBus } from '../src/core/events.js';
import { addMember, client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let ws: string;
let wsId: string;
let projectId: string;
let moduleId: string;
let drawdownId: string;
const statusId = new Map<string, string>();
const base = () => `${ws}/projects/${team.key}`;

async function newRule(body: object, c = team.lead) {
  const r = await c.post(`${base()}/automations`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; sentence: string };
}
async function issue(title: string, extra: Record<string, unknown> = {}) {
  const r = await team.lead.post(`${base()}/issues`, { title, moduleId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; key: string; version: number };
}
async function moveTo(key: string, status: string) {
  const cur = (await team.lead.get(`${ws}/issues/${key}`)).body;
  const r = await team.lead.patch(`${ws}/issues/${key}`, { statusId: statusId.get(status) }, cur.version);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const statusOf = async (key: string) => (await team.lead.get(`${ws}/issues/${key}`)).body.status.name as string;
const runs = async (ruleId: string) => (await t.owner.query(`SELECT result, depth, detail, issue_ids FROM automation_runs WHERE rule_id = $1 ORDER BY depth, ran_at, created_at`, [ruleId])).rows;
const labelsOf = async (id: string) => (await t.owner.query(`SELECT l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = $1 ORDER BY l.name`, [id])).rows.map((r: { name: string }) => r.name);
const resetRules = () => t.owner.query(`DELETE FROM automation_rules WHERE workspace_id = $1`, [wsId]);

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  ws = team.ws;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  drawdownId = team.project.modules[1].id;
  const taskWf = (await t.owner.query(`SELECT workflow_id FROM issue_types WHERE project_id = $1 AND name = 'Task'`, [projectId])).rows[0].workflow_id;
  // สถานะเพิ่มสำหรับทดสอบสายโซ่ยาว
  await t.owner.query(
    `INSERT INTO workflow_statuses (workspace_id, project_id, workflow_id, name, category, sort)
     SELECT $1, $2, $3, 'S' || g, 'in_progress', 10 + g FROM generate_series(1, 5) g`,
    [wsId, projectId, taskWf],
  );
  for (const r of (await t.owner.query(`SELECT id, name FROM workflow_statuses WHERE workflow_id = $1`, [taskWf])).rows) statusId.set(r.name, r.id);
});
afterAll(() => t.close());

describe('CRUD และสิทธิ์', () => {
  it('สร้าง / ดู / แก้ / เปิด-ปิด / ลบ พร้อมประโยคอ่านง่ายและ Audit', async () => {
    const r = await newRule({ name: 'งาน Review แจ้งผู้แจ้ง', trigger: 'status_changed', triggerConfig: { to: 'Review' }, conditions: [{ field: 'priority', op: 'eq', value: 'high' }], actions: [{ type: 'comment', body: 'อยู่ระหว่าง Review' }] });
    expect(r.sentence).toBe('เมื่อ สถานะงานเปลี่ยน เป็น Review ถ้า Priority เป็น high ให้ เพิ่มคอมเมนต์ "อยู่ระหว่าง Review"');
    const g = await team.lead.get(`${base()}/automations/${r.id}`);
    expect(g.body).toMatchObject({ name: 'งาน Review แจ้งผู้แจ้ง', enabled: true, trigger: 'status_changed' });

    const list = await team.lead.get(`${base()}/automations`);
    expect(list.body.usage).toEqual({ runsThisMonth: 0, quota: 1000 });
    expect(list.body.items).toEqual([expect.objectContaining({ id: r.id, createdBy: expect.objectContaining({ displayName: 'Mick' }), stats30d: { runs: 0, failed: 0, lastRunAt: null } })]);

    const off = await team.lead.patch(`${base()}/automations/${r.id}`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    const edit = await team.lead.patch(`${base()}/automations/${r.id}`, { name: 'แก้ชื่อ', conditions: [], actions: [{ type: 'set_priority', priority: 'low' }] });
    expect(edit.body).toMatchObject({ name: 'แก้ชื่อ', conditions: [], actions: [{ type: 'set_priority', priority: 'low' }] });
    const audits = (await t.owner.query(`SELECT action FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'automation.%' ORDER BY created_at`, [wsId])).rows.map((x: { action: string }) => x.action);
    expect(audits).toEqual(['automation.created', 'automation.disabled', 'automation.updated']);

    expect((await team.lead.delete(`${base()}/automations/${r.id}`)).status).toBe(200);
    expect((await team.lead.get(`${base()}/automations/${r.id}`)).status).toBe(404);
    expect((await team.lead.get(`${base()}/automations/not-a-uuid`)).status).toBe(404);
  });

  it('ตรวจข้อมูล: trigger / เงื่อนไข / การกระทำ / สถานะที่ไม่มี / ผู้ใช้ที่ไม่ใช่สมาชิก', async () => {
    const bad = async (body: object, status = 400, code?: string) => {
      const r = await team.lead.post(`${base()}/automations`, { name: 'x', trigger: 'issue_created', actions: [{ type: 'set_priority', priority: 'low' }], ...body });
      expect(r.status, JSON.stringify(body)).toBe(status);
      if (code) expect(r.body.error.code).toBe(code);
    };
    await bad({ name: '' });
    await bad({ trigger: 'nope' });
    await bad({ actions: [] });
    await bad({ actions: [{ type: 'delete_everything' }] });
    await bad({ trigger: 'schedule', triggerConfig: { frequency: 'weekly', time: '09:00' } }); // ขาด weekday
    await bad({ trigger: 'schedule', triggerConfig: { frequency: 'daily', time: '25:00' } });
    await bad({ trigger: 'status_changed', triggerConfig: { to: 'ไม่มีสถานะนี้' } }, 422, 'automation_status_not_found');
    await bad({ actions: [{ type: 'set_status', status: 'ไม่มี' }] }, 422, 'automation_status_not_found');
    await bad({ conditions: [{ field: 'priority', op: 'in', value: 'high' }] });
    await bad({ conditions: [{ field: 'estimateMd', op: 'gt', value: 'many' }] });
    await bad({ conditions: [{ field: 'secret', op: 'eq', value: 1 }] });
    await bad({ actions: [{ type: 'assign', mode: 'add', user: '00000000-0000-4000-8000-000000000000' }] }, 422, 'automation_user_not_member');
    await bad({ actions: [{ type: 'notify', to: 'users', message: 'x' }] }, 422, 'automation_users_required');
    await bad({ extra: true });
  });

  it('เฉพาะ Project Admin: Member / Viewer / Guest ได้ 403 · แม่แบบดูได้ทุกสมาชิกที่ไม่ใช่ Guest', async () => {
    expect((await team.dev.get(`${base()}/automations`)).status).toBe(403);
    expect((await team.dev.post(`${base()}/automations`, { name: 'x', trigger: 'issue_created', actions: [{ type: 'set_priority', priority: 'low' }] })).status).toBe(403);
    expect((await team.dev.get(`${base()}/automations/runs`)).status).toBe(403);
    const guest = await client(t.app);
    const gid = await signup(guest, 'guest@auto.example.com', 'Guest');
    await addMember(t.owner, team.slug, gid, 'guest', { key: team.key, role: 'viewer' });
    expect((await guest.get(`${base()}/automations`)).status).toBe(403);
    expect((await guest.get(`${ws}/automation-templates`)).status).toBe(403);

    const tpl = await team.dev.get(`${ws}/automation-templates`);
    expect(tpl.status).toBe(200);
    expect(tpl.body.items.length).toBeGreaterThanOrEqual(6);
    expect(tpl.body.items[0]).toMatchObject({ id: expect.any(String), category: expect.any(String), sentence: expect.stringContaining('เมื่อ') });
    // แม่แบบทุกอันต้องสร้างเป็นกฎได้จริง
    for (const item of tpl.body.items) {
      const r = await team.lead.post(`${base()}/automations`, item.rule);
      expect(r.status, `${item.id}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    await resetRules();
  });
});

describe('เครื่องยนต์', () => {
  it('issue_created: ตั้งฟิลด์ · Label · Watcher · คอมเมนต์ · แจ้งเตือน ตามเงื่อนไข · กิจกรรมลงชื่อ Automation', async () => {
    await resetRules();
    const r = await newRule({
      name: 'งาน Credit Line ใหม่',
      trigger: 'issue_created',
      conditions: [{ field: 'module', op: 'eq', value: 'Credit Line' }],
      actions: [
        { type: 'set_priority', priority: 'urgent' },
        { type: 'add_label', label: 'ใหม่' },
        { type: 'add_watcher', user: 'creator' },
        { type: 'comment', body: 'รับงานแล้ว' },
        { type: 'notify', to: 'assignees', message: 'มีงานใหม่ในโมดูลของคุณ' },
      ],
    });
    const hit = await issue('ตรงเงื่อนไข', { assigneeIds: [team.devId] });
    const after = (await team.lead.get(`${ws}/issues/${hit.key}`)).body;
    expect(after.priority).toBe('urgent');
    expect(await labelsOf(hit.id)).toEqual(['ใหม่']);

    const comments = await team.lead.get(`${ws}/issues/${hit.key}/comments`);
    expect(JSON.stringify(comments.body)).toContain('[Automation: งาน Credit Line ใหม่] รับงานแล้ว');
    expect((await t.owner.query(`SELECT 1 FROM issue_watchers WHERE issue_id = $1 AND user_id = $2`, [hit.id, team.leadId])).rowCount).toBe(1);
    const notif = await t.owner.query(`SELECT recipient_id, payload FROM notifications WHERE issue_id = $1 AND event_type = 'automation.notified'`, [hit.id]);
    expect(notif.rows).toHaveLength(1);
    expect(notif.rows[0]).toMatchObject({ recipient_id: team.devId, payload: expect.objectContaining({ message: 'มีงานใหม่ในโมดูลของคุณ', issueKey: hit.key }) });
    const inbox = await team.dev.get(`/me/notifications?workspace=${team.slug}`);
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).toContain('มีงานใหม่ในโมดูลของคุณ');

    // กิจกรรมที่กฎทำลงชื่อ Automation ไม่ใช่ผู้สร้างกฎ
    const act = await t.owner.query(`SELECT actor_kind, actor_id, field FROM activities WHERE issue_id = $1 AND field = 'priority'`, [hit.id]);
    expect(act.rows).toEqual([{ actor_kind: 'automation', actor_id: null, field: 'priority' }]);

    const log = await runs(r.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ result: 'success', depth: 0, issue_ids: [hit.id] });
    expect(log[0].detail.steps.map((s: { action: string; ok: boolean }) => `${s.action}:${s.ok}`)).toEqual(['set_priority:true', 'add_label:true', 'add_watcher:true', 'comment:true', 'notify:true']);
    const audit = await t.owner.query(`SELECT actor_kind, summary FROM audit_logs WHERE workspace_id = $1 AND action = 'automation.run'`, [wsId]);
    expect(audit.rows[0].actor_kind).toBe('automation');

    // เงื่อนไขไม่ตรง (Module Drawdown) = กฎไม่ทำงาน ไม่บันทึกประวัติ
    const miss = await issue('ไม่ตรงเงื่อนไข', { moduleId: drawdownId });
    expect((await team.lead.get(`${ws}/issues/${miss.key}`)).body.priority).toBe('medium');
    expect(await runs(r.id)).toHaveLength(1);

    const list = await team.lead.get(`${base()}/automations`);
    expect(list.body.items[0].stats30d).toMatchObject({ runs: 1, failed: 0 });
    expect(list.body.usage.runsThisMonth).toBe(1);
  });

  it('status_changed: กฎย้ายสถานะทำงาน · ตัวกรองจาก/เป็น และเงื่อนไขใช้งานได้', async () => {
    await resetRules();
    const r = await newRule({ name: 'เริ่มทำ → Review', trigger: 'status_changed', triggerConfig: { to: 'In progress' }, conditions: [{ field: 'priority', op: 'eq', value: 'high' }], actions: [{ type: 'set_status', status: 'Review' }] });
    const high = await issue('ลำดับสูง', { priority: 'high' });
    const low = await issue('ลำดับต่ำ', { priority: 'low' });
    await moveTo(high.key, 'In progress');
    await moveTo(low.key, 'In progress');
    expect(await statusOf(high.key)).toBe('Review');
    expect(await statusOf(low.key)).toBe('In progress');
    await moveTo(high.key, 'Done'); // ไม่ใช่ "เป็น In progress" จึงไม่ทำงาน
    expect(await statusOf(high.key)).toBe('Done');
    const log = await runs(r.id);
    expect(log.map((x: { result: string }) => x.result)).toEqual(['success']);
    const act = await t.owner.query(`SELECT actor_kind FROM activities WHERE issue_id = $1 AND field = 'statusId' ORDER BY created_at`, [high.id]);
    expect(act.rows.map((x: { actor_kind: string }) => x.actor_kind)).toEqual(['user', 'automation', 'user']);
  });

  it('subtasks_done: Sub-task ครบทุกตัว → ย้าย Task แม่', async () => {
    await resetRules();
    const r = await newRule({ name: 'ลูกครบ → Review', trigger: 'subtasks_done', actions: [{ type: 'set_status', status: 'Review' }] });
    const parent = await issue('งานแม่');
    const a = await issue('ลูก 1', { parentKey: parent.key });
    const b = await issue('ลูก 2', { parentKey: parent.key });
    await moveTo(a.key, 'Done');
    expect(await statusOf(parent.key)).toBe('To do');
    await moveTo(b.key, 'Done');
    expect(await statusOf(parent.key)).toBe('Review');
    expect((await runs(r.id)).map((x: { result: string }) => x.result)).toEqual(['success']);
  });

  it('create_subtask / assign / clear: การกระทำอื่นของ IssuesService', async () => {
    await resetRules();
    await newRule({ name: 'งานด่วน → มอบหมาย + Sub-task', trigger: 'issue_created', conditions: [{ field: 'priority', op: 'eq', value: 'urgent' }, { field: 'isSubtask', op: 'eq', value: false }], actions: [{ type: 'assign', mode: 'set', user: team.devId }, { type: 'create_subtask', title: 'ตรวจรับงาน', assignee: team.devId }] });
    const p = await issue('ด่วนมาก', { priority: 'urgent' });
    const got = (await team.lead.get(`${ws}/issues/${p.key}`)).body;
    expect(got.assigneeIds).toEqual([team.devId]);
    expect(JSON.stringify(got.subtasks)).toContain('ตรวจรับงาน');
    await resetRules();
    await newRule({ name: 'ล้างผู้รับผิดชอบ', trigger: 'status_changed', triggerConfig: { to: 'Done' }, actions: [{ type: 'assign', mode: 'clear' }] });
    await moveTo(p.key, 'Done');
    expect((await team.lead.get(`${ws}/issues/${p.key}`)).body.assigneeIds).toEqual([]);
  });

  it('test_attached (ผลทดสอบไม่ผ่าน) → ย้ายสถานะ', async () => {
    await resetRules();
    const r = await newRule({ name: 'ทดสอบไม่ผ่าน → กลับไปแก้', trigger: 'test_attached', actions: [{ type: 'set_status', status: 'In progress' }] });
    const i = await issue('รอทดสอบ');
    await moveTo(i.key, 'Review');
    await t.app.get(EventBus).publish({ type: 'test_run.failed', workspaceId: wsId, projectId, issueId: i.id, actorId: team.devId, data: {}, at: new Date() });
    expect(await statusOf(i.key)).toBe('In progress');
    expect(await runs(r.id)).toHaveLength(1);
  });
});

describe('Dry run', () => {
  it('คืนงานที่ตรงเงื่อนไขและสิ่งที่จะทำ โดยไม่บันทึกอะไร', async () => {
    await resetRules();
    const a = await issue('ลำดับสูง A', { priority: 'high' });
    await issue('ลำดับต่ำ', { priority: 'low' });
    const r = await newRule({ name: 'ปิดงานด่วน', trigger: 'status_changed', triggerConfig: { to: 'Review' }, conditions: [{ field: 'priority', op: 'eq', value: 'high' }], actions: [{ type: 'set_status', status: 'Done' }, { type: 'notify', to: 'reporter', message: 'ปิดแล้ว' }] });
    const before = (await t.owner.query(`SELECT (SELECT count(*)::int FROM activities) AS act, (SELECT count(*)::int FROM notifications) AS n, (SELECT count(*)::int FROM automation_runs) AS runs, (SELECT count(*)::int FROM audit_logs WHERE action = 'automation.run') AS audit`)).rows[0];
    const d = await team.lead.post(`${base()}/automations/${r.id}:dry-run`, {});
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ dryRun: true, ruleId: r.id });
    expect(d.body.matched).toBeGreaterThanOrEqual(1);
    expect(d.body.items.map((x: { key: string }) => x.key)).toContain(a.key);
    expect(d.body.items.every((x: { key: string }) => x.key !== undefined)).toBe(true);
    const mine = d.body.items.find((x: { key: string }) => x.key === a.key);
    expect(mine.wouldDo.map((w: { action: string }) => w.action)).toEqual(['set_status', 'notify']);
    expect(d.body.notes).toContain('ไม่มีการเปลี่ยนข้อมูลหรือส่งแจ้งเตือนจริง');
    // ใช้รูปแบบ /dry-run ได้ด้วย · ระบุงานเดียว
    const one = await team.lead.post(`${base()}/automations/${r.id}/dry-run`, { issueKey: a.key });
    expect(one.body.items).toHaveLength(1);
    expect((await team.lead.post(`${base()}/automations/${r.id}/dry-run`, { issueKey: 'DP-9999' })).status).toBe(404);

    expect(await statusOf(a.key)).toBe('To do');
    const after = (await t.owner.query(`SELECT (SELECT count(*)::int FROM activities) AS act, (SELECT count(*)::int FROM notifications) AS n, (SELECT count(*)::int FROM automation_runs) AS runs, (SELECT count(*)::int FROM audit_logs WHERE action = 'automation.run') AS audit`)).rows[0];
    expect(after).toEqual(before);
    expect((await team.dev.post(`${base()}/automations/${r.id}:dry-run`, {})).status).toBe(403);
  });

  it('เตือนเมื่อการกระทำใช้ไม่ได้กับงานนั้น', async () => {
    await resetRules();
    const i = await issue('ลูกค้างาน');
    const sub = await issue('งานลูก', { parentKey: i.key });
    const r = await newRule({ name: 'สร้างลูกทุกงาน', trigger: 'issue_created', actions: [{ type: 'create_subtask', title: 'ซ้ำ' }, { type: 'set_status', status: 'To do' }] });
    const d = await team.lead.post(`${base()}/automations/${r.id}:dry-run`, { issueKey: sub.key });
    expect(d.body.items[0].wouldDo.map((w: { warning?: string }) => w.warning)).toEqual(['Sub-task สร้าง Sub-task ซ้อนไม่ได้', 'งานอยู่ในสถานะนี้แล้ว ไม่มีอะไรเปลี่ยน']);
  });
});

describe('กันวนซ้ำ', () => {
  it('กฎ A ↔ B วนกลับมางานเดิมในสายเดียวกัน ถูกหยุดและบันทึกเป็น skipped', async () => {
    await resetRules();
    const a = await newRule({ name: 'A', trigger: 'status_changed', triggerConfig: { to: 'In progress' }, actions: [{ type: 'set_status', status: 'Review' }] });
    const b = await newRule({ name: 'B', trigger: 'status_changed', triggerConfig: { to: 'Review' }, actions: [{ type: 'set_status', status: 'In progress' }] });
    const i = await issue('วนไปวนมา');
    await moveTo(i.key, 'In progress');
    expect(await statusOf(i.key)).toBe('In progress'); // A → Review, B → กลับ In progress, A ซ้ำถูกหยุด
    expect((await runs(a.id)).map((x: { result: string; depth: number }) => `${x.result}:${x.depth}`)).toEqual(['success:0', 'skipped:2']);
    expect((await runs(b.id)).map((x: { result: string; depth: number }) => `${x.result}:${x.depth}`)).toEqual(['success:1']);
    const skipped = (await runs(a.id))[1];
    expect(skipped.detail.reason).toBe('loop');
  });

  it('กฎที่เรียกต่อกันเกิน 3 ชั้นถูกหยุด (สายโซ่ 5 กฎ)', async () => {
    await resetRules();
    const chain = [['In progress', 'S1'], ['S1', 'S2'], ['S2', 'S3'], ['S3', 'S4'], ['S4', 'S5']];
    const ids: string[] = [];
    for (const [i, [from, to]] of chain.entries()) ids.push((await newRule({ name: `R${i + 1}`, trigger: 'status_changed', triggerConfig: { to: from }, actions: [{ type: 'set_status', status: to }] })).id);
    const i = await issue('โซ่ยาว');
    await moveTo(i.key, 'In progress');
    expect(await statusOf(i.key)).toBe('S4'); // R1..R4 ทำงาน (depth 0..3) · R5 ถูกหยุด
    const results = await Promise.all(ids.map(async (id) => (await runs(id)).map((x: { result: string; depth: number }) => `${x.result}:${x.depth}`)));
    expect(results).toEqual([['success:0'], ['success:1'], ['success:2'], ['success:3'], ['skipped:3']]);
    expect((await runs(ids[4]))[0].detail).toMatchObject({ reason: 'depth_exceeded', attemptedDepth: 4 });
  });

  it('create_subtask ที่ trigger ตัวเองซ้ำ: Sub-task สร้างซ้อนไม่ได้ → run ล้มเหลวและหยุดสาย', async () => {
    await resetRules();
    const r = await newRule({ name: 'ลูกไม่รู้จบ', trigger: 'issue_created', actions: [{ type: 'create_subtask', title: 'ลูกอีก' }] });
    const p = await issue('ต้นทาง');
    const log = await runs(r.id);
    expect(log.map((x: { result: string; depth: number }) => `${x.result}:${x.depth}`)).toEqual(['success:0', 'failed:1']);
    expect(log[1].detail.steps[0]).toMatchObject({ ok: false, code: 'issue_depth_exceeded' });
    const count = await t.owner.query(`SELECT count(*)::int AS n FROM issues WHERE parent_id = $1`, [p.id]);
    expect(count.rows[0].n).toBe(1);
  });
});

describe('ตามเวลาและเลย Due', () => {
  it('overdue: ทำงานครั้งเดียวต่องานต่อ Due · เปลี่ยน Due แล้วเลยอีกถึงจะทำใหม่', async () => {
    await resetRules();
    const r = await newRule({ name: 'เลย Due → Label', trigger: 'overdue', actions: [{ type: 'add_label', label: 'เลยกำหนด' }] });
    const late = await issue('ค้างนาน', { planStart: '2026-01-05', estimateMd: 2 });
    const ok = await issue('ยังไม่ถึง', { planStart: '2030-01-07', estimateMd: 2 });
    const done = await issue('เสร็จแล้ว', { planStart: '2026-01-05', estimateMd: 2 });
    await moveTo(done.key, 'Done');
    const engine = t.app.get(AutomationEngine);
    expect((await engine.scanOverdue()).ran).toBe(1);
    expect(await labelsOf(late.id)).toEqual(['เลยกำหนด']);
    expect(await labelsOf(ok.id)).toEqual([]);
    expect((await engine.scanOverdue()).ran).toBe(0);
    expect(await runs(r.id)).toHaveLength(1);
    await t.owner.query(`UPDATE issues SET plan_end = '2026-01-14' WHERE id = $1`, [late.id]);
    expect((await engine.scanOverdue()).ran).toBe(1);
  });

  it('schedule: ถึงเวลา (เวลาไทย) ทำกับงานที่ยังไม่เสร็จและตรงเงื่อนไข วันละครั้ง', async () => {
    await resetRules();
    const r = await newRule({ name: 'จันทร์ 09:00', trigger: 'schedule', triggerConfig: { frequency: 'weekly', weekday: 1, time: '09:00' }, conditions: [{ field: 'assignee', op: 'empty' }, { field: 'statusCategory', op: 'eq', value: 'in_progress' }], actions: [{ type: 'notify', to: 'project_owner', message: 'งานไม่มีเจ้าของ' }] });
    const orphan = await issue('ไม่มีเจ้าของ');
    await moveTo(orphan.key, 'S1');
    const owned = await issue('มีเจ้าของ', { assigneeIds: [team.devId] });
    await moveTo(owned.key, 'S1');
    const engine = t.app.get(AutomationEngine);
    expect((await engine.runSchedules(new Date('2026-11-09T01:30:00Z'))).ran).toBe(0); // 08:30 ยังไม่ถึง
    expect((await engine.runSchedules(new Date('2026-11-10T02:02:00Z'))).ran).toBe(0); // วันอังคาร
    const ran = await engine.runSchedules(new Date('2026-11-09T02:02:00Z')); // จันทร์ 09:02 เวลาไทย
    expect(ran.ran).toBeGreaterThanOrEqual(1);
    const log = await runs(r.id);
    expect(log.some((x: { detail: { issueKey?: string; slot?: string } }) => x.detail.issueKey === orphan.key && x.detail.slot === '2026-11-09T09:00')).toBe(true);
    expect(log.some((x: { detail: { issueKey?: string } }) => x.detail.issueKey === owned.key)).toBe(false);
    const n = log.length;
    expect((await engine.runSchedules(new Date('2026-11-09T02:03:00Z'))).ran).toBe(0); // slot เดิม ไม่ทำซ้ำ
    expect(await runs(r.id)).toHaveLength(n);
  });
});

describe('ประวัติการทำงาน', () => {
  it('GET automations/runs: กรองตามกฎ / ผล · แบ่งหน้า · ผู้สร้างกฎถูกปิดบัญชี = failed', async () => {
    await resetRules();
    const admin = await client(t.app);
    const adminId = await signup(admin, 'proj-admin@auto.example.com', 'ProjAdmin');
    await addMember(t.owner, team.slug, adminId, 'member', { key: team.key, role: 'admin' });
    const r = await newRule({ name: 'โดยแอดมินโปรเจกต์', trigger: 'issue_created', actions: [{ type: 'set_priority', priority: 'high' }] }, admin);
    const mine = await newRule({ name: 'ของ Mick', trigger: 'issue_created', actions: [{ type: 'add_label', label: 'x' }] });
    for (const n of ['1', '2', '3']) await issue(`ประวัติ ${n}`);
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1`, [adminId]);
    await issue('หลังปิดบัญชี');

    const all = await team.lead.get(`${base()}/automations/runs?limit=200`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBe(8);
    expect(all.body.items[0]).toMatchObject({ rule: { name: expect.any(String) }, issueKeys: expect.any(Array), depth: 0 });
    const failed = await team.lead.get(`${base()}/automations/runs?result=failed`);
    expect(failed.body.items).toHaveLength(1);
    expect(failed.body.items[0]).toMatchObject({ rule: { id: r.id }, result: 'failed', detail: { reason: 'creator_inactive' } });
    const byRule = await team.lead.get(`${base()}/automations/runs?ruleId=${mine.id}`);
    expect(byRule.body.items.every((x: { rule: { id: string } }) => x.rule.id === mine.id)).toBe(true);
    const p1 = await team.lead.get(`${base()}/automations/runs?limit=3`);
    expect(p1.body.items).toHaveLength(3);
    const p2 = await team.lead.get(`${base()}/automations/runs?limit=3&before=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items.length).toBeGreaterThan(0);
    expect(p2.body.items.every((x: { ranAt: string }) => Date.parse(x.ranAt) < Date.parse(p1.body.nextCursor))).toBe(true);
    expect((await team.lead.get(`${base()}/automations/runs?result=bogus`)).status).toBe(400);
  });
});

describe('ตรวจเงื่อนไข (หน่วย)', () => {
  const f = (over: Partial<Facts> = {}): Facts => ({ id: 'i', key: 'DP-1', projectKey: 'DP', projectId: 'p', workspaceId: 'w', title: 't', version: 1, parentId: null, type: 'Task', status: 'To do', statusCategory: 'todo', priority: 'high', severity: null, estimateMd: 3, planEnd: null, module: 'Credit Line', reporterId: null, assigneeIds: ['u1', 'u2'], labels: ['a', 'b'], ...over });
  const c = (x: Partial<Condition> & Pick<Condition, 'field'>) => ({ op: 'eq', not: false, ...x }) as Condition;
  it('ตัวดำเนินการ eq / in / gt / lt / empty / not_empty / not', () => {
    expect(matches([c({ field: 'priority', value: 'HIGH' })], f())).toBe(true);
    expect(matches([c({ field: 'priority', value: 'low' })], f())).toBe(false);
    expect(matches([c({ field: 'priority', value: 'low', not: true })], f())).toBe(true);
    expect(matches([c({ field: 'status', op: 'in', value: ['Review', 'to do'] })], f())).toBe(true);
    expect(matches([c({ field: 'estimateMd', op: 'gt', value: 2 })], f())).toBe(true);
    expect(matches([c({ field: 'estimateMd', op: 'lt', value: 2 })], f())).toBe(false);
    expect(matches([c({ field: 'estimateMd', op: 'gt', value: 2 })], f({ estimateMd: null }))).toBe(false);
    expect(matches([c({ field: 'assignee', op: 'empty' })], f({ assigneeIds: [] }))).toBe(true);
    expect(matches([c({ field: 'assignee', value: 'u2' })], f())).toBe(true);
    expect(matches([c({ field: 'label', op: 'not_empty' })], f())).toBe(true);
    expect(matches([c({ field: 'severity', op: 'empty' })], f())).toBe(true);
    expect(matches([c({ field: 'isSubtask', value: true })], f({ parentId: 'x' }))).toBe(true);
    expect(matches([c({ field: 'daysToDue', op: 'lt', value: 0 })], f({ planEnd: '2020-01-01' }))).toBe(true);
    expect(matches([c({ field: 'priority', value: 'high' }), c({ field: 'module', value: 'Other' })], f())).toBe(false); // AND
    expect(matches([], f())).toBe(true);
  });
});
