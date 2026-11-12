// A23 · กระจายแจ้งเตือนจาก Event และแจ้งเตือนตามเวลา · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { dueSoonInSummary } from '../src/notifications/reminders.js';
import { JOBS, REASONS } from '../src/notifications/rules.js';
import { WorkCalendar } from '../src/projects/calendar.js';
import { Jobs } from '../src/queue/jobs.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
const people: Record<'reviewer' | 'ba' | 'watcher' | 'guest' | 'outsider', { c: Client; id: string }> = {} as never;
let workspaceId: string;
let creditLine: string;
let statuses: { id: string; name: string; boardColumnId: string | null; category: string }[];
let inAppEnum = false;

interface Row {
  event_type: string;
  recipient: string;
  reason: string;
  payload: Record<string, unknown>;
  actor: string | null;
  issue_key: string | null;
}
const name = (id: string) =>
  ({ [team.leadId]: 'lead', [team.devId]: 'dev', ...Object.fromEntries(Object.entries(people).map(([k, v]) => [v.id, k])) })[id] ?? id;

/** แจ้งเตือนที่สร้างหลังจุดเริ่ม (ไม่รวมของ test ก่อนหน้า) */
async function since(mark: string): Promise<Row[]> {
  const { rows } = await t.owner.query(
    `SELECT event_type, recipient_id, reason, payload, actor_id, payload->>'issueKey' AS issue_key
     FROM notifications WHERE created_at > $1 AND in_app ORDER BY created_at, recipient_id`,
    [mark],
  );
  return rows.map((r) => ({ event_type: r.event_type, recipient: name(r.recipient_id), reason: r.reason, payload: r.payload, actor: r.actor_id && name(r.actor_id), issue_key: r.issue_key }));
}
const mark = async () => (await t.owner.query(`SELECT clock_timestamp()::text AS now`)).rows[0].now as string;
const pairs = (rows: Row[]) => rows.map((r) => `${r.event_type}→${r.recipient}`).sort();
const status = (n: string, bug = false) => statuses.find((s) => s.name === n && (bug ? !!s.boardColumnId || n === 'Open' : !s.boardColumnId))!.id;

async function createIssue(body: Record<string, unknown>, by = team.lead) {
  const r = await by.post(`${team.ws}/projects/DP/issues`, { moduleId: creditLine, size: 'S', planStart: '2026-12-01', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { key: string; id: string; version: number };
}
async function patch(key: string, body: Record<string, unknown>, by = team.lead) {
  const cur = await by.get(`${team.ws}/issues/${key}`);
  const r = await by.patch(`${team.ws}/issues/${key}`, body, cur.body.version);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function move(key: string, statusId: string, by = team.lead) {
  const r = await by.post(`${team.ws}/issues/${key}/move`, { statusId, confirm: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
async function publish(e: Partial<DomainEvent> & Pick<DomainEvent, 'type'>) {
  await t.app.get(EventBus).publish({ workspaceId, projectId: team.project.id, actorId: team.leadId, data: {}, at: new Date(), ...e } as DomainEvent);
}

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  workspaceId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  creditLine = team.project.modules.find((m: { name: string }) => m.name === 'Credit Line').id;
  statuses = team.project.statuses;
  for (const [key, role] of [['reviewer', 'member'], ['ba', 'member'], ['watcher', 'member'], ['guest', 'guest'], ['outsider', 'member']] as const) {
    const c = await client(t.app);
    const id = await signup(c, `${key}@fanout.example.com`, key);
    // outsider เป็นสมาชิก Workspace แต่ไม่อยู่ในโปรเจกต์ Private
    await addMember(t.owner, team.slug, id, role, key === 'outsider' ? undefined : { key: 'DP', role: key === 'guest' ? 'viewer' : 'member' });
    people[key] = { c, id };
  }
  inAppEnum = (await t.owner.query(`SELECT 'in_app' = ANY(enum_range(NULL::notification_channel)::text[]) AS ok`)).rows[0].ok;
});
afterAll(() => t.close());

describe('ผู้รับตาม 03-api › Event ที่ระบบส่งต่อ', () => {
  it('issue.assigned → Assignee ใหม่ · ถอดออกได้แจ้ง (I · Profile) · ผู้ทำเองไม่ได้รับ', async () => {
    const m = await mark();
    const issue = await createIssue({ title: 'ฟอร์มสมัครสินเชื่อ', assigneeIds: [team.devId, team.leadId] });
    let rows = await since(m);
    expect(pairs(rows)).toEqual(['issue.assigned→dev']);
    expect(rows[0]).toMatchObject({ reason: 'คุณได้รับมอบหมายงานนี้', actor: 'lead', issue_key: issue.key });
    expect(rows[0].payload).toMatchObject({ projectKey: 'DP', projectName: 'Development Plan', issueKey: issue.key, issueTitle: 'ฟอร์มสมัครสินเชื่อ', actorName: 'Mick' });

    const m2 = await mark();
    await patch(issue.key, { assigneeIds: [people.reviewer.id] });
    rows = await since(m2);
    expect(pairs(rows)).toEqual(['issue.assigned→dev', 'issue.assigned→reviewer']);
    expect(rows.find((r) => r.recipient === 'dev')).toMatchObject({ reason: 'คุณถูกถอดออกจากงานนี้', payload: expect.objectContaining({ removed: true }) });
  });

  it('issue.status_changed → Watcher และผู้รับผิดชอบ Task แม่เมื่อ Sub-task เปลี่ยน', async () => {
    const parent = await createIssue({ title: 'งานแม่', assigneeIds: [people.ba.id] });
    const child = await createIssue({ title: 'งานลูก', parentKey: parent.key, assigneeIds: [team.devId] });
    expect((await people.watcher.c.post(`${team.ws}/issues/${child.key}/watch`)).status).toBeLessThan(300);
    const m = await mark();
    await move(child.key, status('In progress'));
    const rows = await since(m);
    expect(pairs(rows.filter((r) => r.event_type === 'issue.status_changed'))).toEqual(['issue.status_changed→ba', 'issue.status_changed→watcher']);
    expect(rows.find((r) => r.recipient === 'ba')!.reason).toBe('คุณรับผิดชอบงานแม่ของ Sub-task นี้');
    expect(rows.find((r) => r.recipient === 'watcher')!.payload).toMatchObject({ from: { name: 'To do' }, to: { name: 'In progress' } });
  });

  it('ย้ายเข้า Review → Reviewer ได้ issue.review_requested แทนการแจ้งเปลี่ยนสถานะ', async () => {
    const issue = await createIssue({ title: 'รอตรวจ', assigneeIds: [team.devId], reviewerId: people.reviewer.id });
    await people.reviewer.c.post(`${team.ws}/issues/${issue.key}/watch`);
    const m = await mark();
    await move(issue.key, status('Review'), team.dev);
    const rows = await since(m);
    expect(pairs(rows)).toEqual(['issue.review_requested→reviewer', 'issue.status_changed→lead']);
    expect(rows.find((r) => r.event_type === 'issue.review_requested')!.reason).toBe('คุณเป็น Reviewer ของงานนี้');
  });

  it('issue.updated → Watcher เฉพาะ Due / Priority / ชื่อ · ฟิลด์อื่นไม่แจ้ง', async () => {
    const issue = await createIssue({ title: 'งานที่มีคนติดตาม' });
    await people.watcher.c.post(`${team.ws}/issues/${issue.key}/watch`);
    let m = await mark();
    await patch(issue.key, { priority: 'high' });
    let rows = await since(m);
    expect(pairs(rows)).toEqual(['issue.updated→watcher']);
    expect(rows[0].payload.fields).toEqual(['priority']);
    m = await mark();
    await patch(issue.key, { description: 'แก้รายละเอียด' });
    expect(await since(m)).toEqual([]);
  });

  it('issue.commented → Watcher (ยกเว้นคนที่ถูก mention) · issue.mentioned → คนที่ถูก mention', async () => {
    const issue = await createIssue({ title: 'คุยกันในงาน' });
    await people.watcher.c.post(`${team.ws}/issues/${issue.key}/watch`);
    await people.reviewer.c.post(`${team.ws}/issues/${issue.key}/watch`);
    const m = await mark();
    const r = await team.dev.post(`${team.ws}/issues/${issue.key}/comments`, { body: 'ช่วยดูหน่อย @reviewer' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rows = await since(m);
    expect(pairs(rows)).toEqual(['issue.commented→lead', 'issue.commented→watcher', 'issue.mentioned→reviewer']);
    expect(rows.find((x) => x.event_type === 'issue.commented')!.payload).toMatchObject({ excerpt: 'ช่วยดูหน่อย @reviewer' });
  });

  it('bug.created → BA (Assignee ได้ issue.assigned รายการเดียว) · bug.reopened → Assignee และ BA', async () => {
    const m = await mark();
    const bug = await createIssue({ type: 'Bug', title: 'ปุ่มบันทึกไม่ทำงาน', assigneeIds: [team.devId], baId: people.ba.id, severity: 'critical', environment: 'uat', details: { steps: '1. กดบันทึก' } });
    let rows = await since(m);
    expect(pairs(rows)).toEqual(['bug.created→ba', 'issue.assigned→dev']);
    expect(rows.find((x) => x.event_type === 'bug.created')).toMatchObject({ reason: 'คุณเป็น BA ของงานนี้', payload: expect.objectContaining({ severity: 'critical' }) });

    const bugStatuses = (await team.lead.get(`${team.ws}/projects/DP`)).body.statuses as { id: string; name: string; workflowId: string }[];
    const bugWorkflow = bugStatuses.find((s) => s.name === 'Fixed')!.workflowId;
    await move(bug.key, bugStatuses.find((s) => s.name === 'Fixed' && s.workflowId === bugWorkflow)!.id, team.dev);
    const m2 = await mark();
    const reopened = await team.lead.post(`${team.ws}/issues/${bug.key}/reopen`, {});
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    rows = await since(m2);
    expect(pairs(rows.filter((x) => x.event_type === 'bug.reopened'))).toEqual(['bug.reopened→ba', 'bug.reopened→dev']);
  });

  it('plan.changed → PM เมื่อแก้แผนหลังมี Baseline', async () => {
    const issue = await createIssue({ title: 'งานตามแผน', assigneeIds: [team.devId] });
    await t.owner.query(`INSERT INTO plan_baselines (workspace_id, project_id, version, source, created_by) VALUES ($1, $2, 1, 'manual', $3)`, [
      workspaceId,
      team.project.id,
      team.leadId,
    ]);
    try {
      const m = await mark();
      // Member แก้ผู้รับผิดชอบได้เอง (เลื่อน Due ต้องขออนุมัติ) · หลัง Baseline ถือเป็นการแก้แผน
      await patch(issue.key, { assigneeIds: [team.devId, people.reviewer.id], planChangeReason: 'เพิ่มคนช่วยเพราะรอ API ฝั่งธนาคาร' }, team.dev);
      const plan = (await since(m)).filter((x) => x.event_type === 'plan.changed');
      expect(pairs(plan)).toEqual(['plan.changed→lead']);
      expect(plan[0]).toMatchObject({
        reason: 'คุณเป็น PM (Project Owner) ของโปรเจกต์นี้',
        payload: expect.objectContaining({ reason: 'เพิ่มคนช่วยเพราะรอ API ฝั่งธนาคาร', fields: ['assigneeIds'] }),
      });
    } finally {
      await t.owner.query('DELETE FROM plan_changes WHERE project_id = $1', [team.project.id]);
      await t.owner.query('DELETE FROM plan_baselines WHERE project_id = $1', [team.project.id]);
    }
  });

  it('member.joined → คนที่ถูกเพิ่มเข้าโปรเจกต์และ PM (ผู้เพิ่มเองไม่ได้รับ)', async () => {
    const m = await mark();
    const r = await team.lead.post(`${team.ws}/projects/DP/members`, { userId: people.outsider.id, role: 'member' });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const rows = await since(m);
    expect(pairs(rows)).toEqual(['member.joined→outsider']);
    expect(rows[0].reason).toBe('คุณถูกเพิ่มเข้าโปรเจกต์นี้');
    await t.owner.query('DELETE FROM project_members WHERE user_id = $1', [people.outsider.id]);
  });

  it('Event ที่ยังไม่มีต้นทางส่ง (Sprint, ผลทดสอบ, Health, เชิญ, นำเข้า, Due) ได้ผู้รับตามตาราง', async () => {
    const issue = await createIssue({ title: 'งานสำหรับ Event อื่น', assigneeIds: [team.devId] });
    const m = await mark();
    const issueEvent = { issueId: issue.id, data: { issueKey: issue.key, title: 'งานสำหรับ Event อื่น' } };
    await publish({ type: 'test_run.failed', ...issueEvent, actorId: people.reviewer.id });
    await publish({ type: 'sprint.started', data: { sprintName: 'Sprint 1' } });
    await publish({ type: 'project.health_changed', actorId: null, data: { from: 'on_track', to: 'at_risk' } });
    await publish({ type: 'member.invited', actorId: team.devId, data: { email: 'new@fanout.example.com' } });
    await publish({ type: 'import.completed', actorId: team.devId, data: { fileName: 'plan.xlsx' } });
    await publish({ type: 'issue.due_soon', ...issueEvent, actorId: null, data: { ...issueEvent.data, planEnd: '2026-12-02' } });
    await publish({ type: 'issue.overdue', ...issueEvent, actorId: null });
    const got = pairs(await since(m));
    expect(got).toEqual(
      [
        'test_run.failed→dev',
        // สมาชิกโปรเจกต์ทั้งหมดยกเว้นผู้เริ่ม Sprint (lead)
        'sprint.started→ba',
        'sprint.started→dev',
        'sprint.started→guest',
        'sprint.started→reviewer',
        'sprint.started→watcher',
        'project.health_changed→lead',
        'member.invited→lead',
        'import.completed→dev',
        'issue.due_soon→dev',
        'issue.overdue→dev',
        'issue.overdue→lead',
      ].sort(),
    );
  });

  it('แจ้งเตือนแบบ PM ส่งถึง Owner + Admin + ผู้ทำแทน PM · ผู้ทำแทนอนุมัติคำขอเลื่อน Due ได้ · Guest ทำแทนไม่ได้', async () => {
    const members = `${team.ws}/projects/DP/members`;
    expect((await team.lead.patch(`${members}/${people.watcher.id}`, { role: 'admin' })).status).toBe(200);
    const set = await team.lead.patch(`${members}/${people.ba.id}`, { pmDeputy: true });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ pmDeputy: true, role: 'member' });
    expect((await team.lead.patch(`${members}/${people.guest.id}`, { pmDeputy: true })).body.error.code).toBe('guest_cannot_be_pm_deputy');
    // คนอื่นที่ไม่มี project.settings ตั้งผู้ทำแทนไม่ได้
    expect((await people.reviewer.c.patch(`${members}/${people.reviewer.id}`, { pmDeputy: true })).status).toBe(403);

    try {
      const m = await mark();
      await publish({ type: 'project.health_changed', actorId: null, data: { from: 'on_track', to: 'at_risk' } });
      const rows = await since(m);
      expect(pairs(rows)).toEqual(['project.health_changed→ba', 'project.health_changed→lead', 'project.health_changed→watcher']);
      expect(Object.fromEntries(rows.map((r) => [r.recipient, r.reason]))).toEqual({
        lead: 'คุณเป็น PM (Project Owner) ของโปรเจกต์นี้',
        watcher: 'คุณเป็น Admin ของโปรเจกต์นี้',
        ba: 'คุณได้รับมอบหมายให้ทำแทน PM ในโปรเจกต์นี้',
      });

      // ผู้ทำแทน PM ได้รับคำขอเลื่อน Due และอนุมัติได้
      const issue = await createIssue({ title: 'ขอเลื่อนให้ผู้ทำแทนอนุมัติ', assigneeIds: [team.devId] });
      const m2 = await mark();
      const req = await team.dev.post(`${team.ws}/issues/${issue.key}/due-requests`, { requestedDue: '2026-12-15', reasonCode: 'scope_added', detail: 'เพิ่มขอบเขต' });
      expect(req.status, JSON.stringify(req.body)).toBe(201);
      expect(pairs(await since(m2)).filter((x) => x.startsWith('due_request.created'))).toContain('due_request.created→ba');
      const ok = await people.ba.c.post(`${team.ws}/due-requests/${req.body.id}/approve`, {});
      expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    } finally {
      await team.lead.patch(`${members}/${people.ba.id}`, { pmDeputy: false });
      await team.lead.patch(`${members}/${people.watcher.id}`, { role: 'member' });
    }
  });

  it('issue.created, issue.deleted, report.weekly ไม่มีผู้รับเริ่มต้น · due_request.* และ project.admin_joined ไม่ส่งซ้ำ', async () => {
    const issue = await createIssue({ title: 'ขอเลื่อน', assigneeIds: [team.devId] });
    const m = await mark();
    const r = await team.dev.post(`${team.ws}/issues/${issue.key}/due-requests`, { requestedDue: '2026-12-15', reasonCode: 'scope_added', detail: 'ลูกค้าเพิ่มฟิลด์' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await publish({ type: 'issue.deleted', issueId: issue.id });
    await publish({ type: 'report.weekly' });
    const rows = await since(m);
    expect(pairs(rows)).toEqual(['due_request.created→lead']);
  });
});

describe('สิทธิ์และการตั้งค่าของผู้รับ', () => {
  it('ไม่แจ้งคนที่เปิดงานไม่ได้: Guest Viewer กับ Bug / งานที่ไม่แชร์, คนนอกโปรเจกต์ Private, สมาชิกที่ถูกปิด', async () => {
    const bug = await createIssue({ type: 'Bug', title: 'Bug ภายใน', severity: 'minor', environment: 'uat', details: { steps: '1. เปิดหน้า' } });
    const shared = await createIssue({ title: 'งานที่แชร์ให้ลูกค้า', sharedWithGuests: true });
    for (const key of [bug.key, shared.key]) {
      const id = (await t.owner.query(`SELECT i.id FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key || '-' || i.number = $1`, [key])).rows[0].id;
      for (const who of [people.guest.id, people.outsider.id, people.watcher.id])
        await t.owner.query(`INSERT INTO issue_watchers (workspace_id, issue_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [workspaceId, id, who]);
    }
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1`, [people.watcher.id]);
    const m = await mark();
    await patch(bug.key, { priority: 'urgent' });
    await patch(shared.key, { priority: 'urgent' });
    const rows = await since(m);
    expect(rows.map((r) => `${r.issue_key}→${r.recipient}`)).toEqual([`${shared.key}→guest`]);
    await t.owner.query(`UPDATE workspace_members SET status = 'active' WHERE user_id = $1`, [people.watcher.id]);
  });

  it('ปิด Email ไม่กระทบ In-app · เหตุการณ์ที่ล็อก In-app ส่งเสมอ', async () => {
    const issue = await createIssue({ title: 'ตั้งค่าแจ้งเตือน' });
    await people.watcher.c.post(`${team.ws}/issues/${issue.key}/watch`);
    for (const event of ['issue.updated', 'issue.assigned'])
      await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1, $2, $3, 'email', false)`, [workspaceId, people.watcher.id, event]);
    const m = await mark();
    await patch(issue.key, { priority: 'low', assigneeIds: [people.watcher.id] });
    expect(pairs(await since(m))).toEqual(['issue.assigned→watcher', 'issue.updated→watcher']);
  });

  // enum notification_channel ยังไม่มี in_app (คำขอนอก lane ถึงงาน DB) · รันเมื่อเพิ่มแล้ว
  it('ปิด In-app ใน Profile แล้วไม่ได้รับ (ยกเว้นเหตุการณ์ที่ล็อก)', async (ctx) => {
    if (!inAppEnum) ctx.skip();
    const issue = await createIssue({ title: 'ปิด In-app' });
    await people.ba.c.post(`${team.ws}/issues/${issue.key}/watch`);
    for (const event of ['issue.updated', 'issue.assigned'])
      await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1, $2, $3, 'in_app', false)`, [workspaceId, people.ba.id, event]);
    const m = await mark();
    await patch(issue.key, { priority: 'low', assigneeIds: [people.ba.id] });
    expect(pairs(await since(m))).toEqual(['issue.assigned→ba']);
  });
});

describe('สรุปงานประจำวัน 08:30 (A16)', () => {
  // 2026-12-09 (พ.) · วันหยุดใน seedTeam: 7 และ 10 ธ.ค.
  const D = '2026-12-09';
  const run = async (date: string) => t.app.get(Jobs).enqueue(JOBS.digest, { date });
  async function planned(title: string, planEnd: string, assigneeIds: string[], extra: Record<string, unknown> = {}) {
    const issue = await createIssue({ title, assigneeIds, ...extra });
    await t.owner.query('UPDATE issues SET plan_end = $1 WHERE id = $2', [planEnd, issue.id]);
    return issue;
  }
  const daily = (rows: Row[], who: string) => rows.filter((r) => r.event_type === 'digest.daily' && r.recipient === who);
  const keys = (list: unknown) => ((list ?? []) as { issueKey: string }[]).map((i) => i.issueKey);
  const setting = (userId: string, values: Record<string, string>) =>
    t.owner.query(
      `INSERT INTO user_notification_settings (workspace_id, user_id, due_reminder, digest) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET due_reminder = EXCLUDED.due_reminder, digest = EXCLUDED.digest`,
      [workspaceId, userId, values.dueReminder ?? '1d_and_today', values.digest ?? 'workdays'],
    );

  it('ลงทะเบียนงานเดียว 08:30 (เวลาไทย) · งาน 08:00 และ 09:30 เดิมเลิกใช้', () => {
    const scheduled = [...t.app.get(Jobs).scheduled].filter(([name]) => name.startsWith('notifications.'));
    expect(scheduled).toEqual([[JOBS.digest, '30 8 * * *']]);
  });

  it('หัวข้อใกล้ครบกำหนดนับวันทำการ: ภายใน 1 วันทำการ · ภายใน 3 วันทำการ · เฉพาะวันครบกำหนด', () => {
    const cal = new WorkCalendar(new Set([1, 2, 3, 4, 5]), new Set(['2026-12-07', '2026-12-10']));
    // 9 ธ.ค. (พ.) · วันทำการถัดไปคือ ศ. 11 (10 เป็นวันหยุด)
    expect(dueSoonInSummary('1d_and_today', '2026-12-11', D, cal)).toBe(true);
    expect(dueSoonInSummary('1d_and_today', '2026-12-14', D, cal)).toBe(false);
    // 11, 14, 15 = 3 วันทำการ
    expect(dueSoonInSummary('3d', '2026-12-15', D, cal)).toBe(true);
    expect(dueSoonInSummary('3d', '2026-12-16', D, cal)).toBe(false);
    expect(dueSoonInSummary('today_only', '2026-12-11', D, cal)).toBe(false);
    // ครบกำหนดวันนี้อยู่อีกหัวข้อ
    expect(dueSoonInSummary('1d_and_today', D, D, cal)).toBe(false);
  });

  it('รวมเป็นรายการเดียวต่อคน: ใกล้ครบกำหนดตามค่าของแต่ละคน + วันนี้ + เลยกำหนด · งานเสร็จไม่รวม · รันซ้ำไม่ซ้ำ', async () => {
    await setting(people.reviewer.id, { dueReminder: 'today_only' });
    await setting(people.ba.id, { dueReminder: '3d' });
    const tomorrow = await planned('ส่งพรุ่งนี้ (วันทำการถัดไป)', '2026-12-11', [team.devId, people.reviewer.id]);
    const today = await planned('ส่งวันนี้', D, [people.reviewer.id]);
    const soon = await planned('อีก 3 วันทำการ', '2026-12-15', [people.ba.id]);
    const late = await planned('เลยกำหนด', '2026-12-04', [team.devId]);
    const done = await planned('เสร็จแล้ว', '2026-12-04', [people.reviewer.id]);
    await move(done.key, status('Done'));

    const m = await mark();
    await run(D);
    await run(D);
    const rows = await since(m);
    // ไม่มีแจ้งเตือนทีละงานอีกแล้ว
    expect(rows.filter((r) => r.event_type === 'issue.due_soon' || r.event_type === 'issue.overdue')).toEqual([]);
    const [dev] = daily(rows, 'dev');
    expect(daily(rows, 'dev')).toHaveLength(1);
    expect(dev).toMatchObject({ reason: REASONS.daily, actor: null });
    expect(keys(dev.payload.dueSoon)).toContain(tomorrow.key);
    expect(keys(dev.payload.overdue)).toContain(late.key);
    expect((dev.payload.overdue as { issueKey: string; daysLate: number }[]).find((i) => i.issueKey === late.key)?.daysLate).toBe(5);
    expect(dev.payload).toMatchObject({ date: D, overdueCount: expect.any(Number), count: expect.any(Number) });

    const [reviewer] = daily(rows, 'reviewer');
    expect(keys(reviewer.payload.dueToday)).toContain(today.key);
    expect(keys(reviewer.payload.dueSoon)).not.toContain(tomorrow.key);
    expect(keys(reviewer.payload.overdue)).not.toContain(done.key);
    expect(keys(daily(rows, 'ba')[0].payload.dueSoon)).toContain(soon.key);
  });

  it('PM ได้งานเลยกำหนดของทีมในสรุปเดียวกัน (ไม่ซ้ำกับงานของตัวเอง) · วันหยุดไม่ส่ง · ตั้ง "ทุกวัน" ส่งวันหยุดด้วย', async () => {
    const mine = await planned('PM เลยกำหนดเอง', '2026-12-02', [team.leadId]);
    const theirs = await planned('ทีมเลยกำหนด', '2026-12-02', [team.devId]);

    let m = await mark();
    await run('2026-12-10');
    expect((await since(m)).filter((r) => r.event_type === 'digest.daily')).toEqual([]);

    m = await mark();
    await run('2026-12-08');
    const lead = daily(await since(m), 'lead');
    expect(lead).toHaveLength(1);
    expect(keys(lead[0].payload.overdue)).toContain(mine.key);
    const team_ = lead[0].payload.team as { projectKey: string; count: number; issues: { issueKey: string; assignees: string[] }[] }[];
    const dp = team_.find((p) => p.projectKey === 'DP')!;
    expect(keys(dp.issues)).toContain(theirs.key);
    expect(keys(dp.issues)).not.toContain(mine.key);
    expect(dp.issues.find((i) => i.issueKey === theirs.key)!.assignees).toHaveLength(1);
    expect(dp.count).toBe(dp.issues.length);

    // ส. 12 ธ.ค.: dev ตั้ง "ทุกวัน" จึงได้ · lead ใช้ค่าเริ่มต้น (วันทำการ) จึงไม่ได้
    await setting(team.devId, { digest: 'daily' });
    m = await mark();
    await run('2026-12-12');
    const sat = await since(m);
    expect(daily(sat, 'dev')).toHaveLength(1);
    expect(daily(sat, 'lead')).toEqual([]);
    // เสร็จแล้วไม่อยู่ในสรุปอีก
    await move(theirs.key, status('Done'));
    m = await mark();
    await run('2026-12-14');
    const after = daily(await since(m), 'lead')[0];
    expect(((after?.payload.team ?? []) as { issues: unknown }[]).flatMap((p) => keys(p.issues))).not.toContain(theirs.key);
  });

  it('งานที่รอ Review อยู่ในสรุปของ Reviewer แม้ยังไม่ใกล้ครบกำหนด', async () => {
    const issue = await planned('รอตรวจ (ยังไม่ใกล้ Due)', '2027-01-29', [team.devId], { reviewerId: people.reviewer.id });
    await move(issue.key, status('Review'), team.dev);
    const m = await mark();
    await run('2026-12-15');
    expect(keys(daily(await since(m), 'reviewer')[0].payload.review)).toContain(issue.key);
  });

  it('ไม่มีงานให้สรุป → ไม่ส่ง', async () => {
    const m = await mark();
    await run('2026-12-16');
    expect(daily(await since(m), 'outsider')).toEqual([]);
  });
});
