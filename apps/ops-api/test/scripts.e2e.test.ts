// O56 · สคริปต์ดูแลข้อมูล · ข้อมูลสมมติเท่านั้น
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderInvitationEmail as apiInvitationEmail } from '../../api/src/invitations/invitation-mail.js';
import { Mailer } from '../src/mail.js';
import { renderInvitationEmail } from '../src/scripts/invitation-mail.js';
import { ScriptsService } from '../src/scripts/scripts.service.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let eng: Staff;
let sam: Staff;
let nord: Customer;
let held: Customer;
let runId: string;

const waitRun = async (id: string) => {
  const p = t.app.get(ScriptsService).running.get(id);
  if (p) await p;
};

beforeAll(async () => {
  t = await startOps();
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', ['owner']);
  eng = await staff(t, 'eng@friday.example.com', 'วิศวกร เอ', ['engineer']);
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  nord = await customer(t, 'nordlight', { plan: 'team_m', status: 'active' });
  // session ของสมาชิก: เก่า 3 (ใช้ล่าสุด 60 วันก่อน) · ใหม่ 1 · ยกเลิกแล้ว 1
  for (const [days, revoked] of [[60, false], [61, false], [90, false], [1, false], [100, true]] as const) {
    await t.owner.query(`INSERT INTO user_sessions (user_id, token_hash, last_seen_at, revoked_at) VALUES ($1, $2, now() - ($3 || ' days')::interval, $4)`, [nord.owner, randomUUID(), days, revoked ? new Date() : null]);
  }
  // คำเชิญที่หมดอายุแล้วแต่ยังค้าง pending
  await t.owner.query(`INSERT INTO invitations (workspace_id, email, token_hash, expires_at, invited_by) VALUES ($1, 'old@nordlight.example.com', $2, now() - interval '3 days', $3), ($1, 'fresh@nordlight.example.com', $4, now() + interval '3 days', $3)`, [nord.id, randomUUID(), nord.owner, randomUUID()]);
  held = await customer(t, 'held-co', { plan: 'team_s', status: 'active' });
  await t.owner.query(`INSERT INTO legal_holds (workspace_id, reason, reference, created_by) VALUES ($1, 'คดีความ', 'LH-01', $2)`, [held.id, boss.id]);
});
afterAll(() => t.close());

describe('สคริปต์ดูแลข้อมูล', () => {
  it('รายการสคริปต์ (ในโค้ด) · Support ไม่มีสิทธิ์', async () => {
    expect((await sam.agent.get('/ops/scripts')).status).toBe(403);
    const o = (await eng.agent.get('/ops/scripts').expect(200)).body;
    expect(o.scripts.map((x: { key: string; undoable: boolean }) => [x.key, x.undoable])).toEqual([
      ['revoke_stale_sessions', true],
      ['expire_stale_invitations', true],
      ['shift_plan_dates', true],
      ['shift_off_holidays', true],
      ['resend_failed_invitations', false],
    ]);
  });

  it('ทดลองรัน: ไม่เขียนข้อมูล · จำนวนและตัวอย่างก่อน / หลัง · ค่าผิดหรือติด Legal hold ไม่ได้', async () => {
    expect((await eng.agent.post('/ops/scripts/revoke_stale_sessions/dry-run').send({ workspaceId: nord.id, params: { days: 2 } })).body.error.code).toBe('invalid_params');
    expect((await eng.agent.post('/ops/scripts/revoke_stale_sessions/dry-run').send({ workspaceId: held.id, params: { days: 30 } })).body.error.code).toBe('legal_hold');
    expect((await eng.agent.post('/ops/scripts/drop_tables/dry-run').send({ workspaceId: nord.id, params: {} })).status).toBe(404);
    const r = (await eng.agent.post('/ops/scripts/revoke_stale_sessions/dry-run').send({ workspaceId: nord.id, params: { days: 30 } }).expect(200)).body;
    runId = r.id;
    expect(r).toMatchObject({ status: 'dry_run', total: 3, workspaceSlug: 'nordlight', dryResult: { count: 3 } });
    expect(r.dryResult.sample[0]).toMatchObject({ label: expect.stringContaining('owner@nordlight.example.com'), before: { revoked_at: null }, after: { revoked_at: expect.any(String) } });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM user_sessions WHERE revoked_at IS NULL`)).rows[0].n).toBe(4);
  });

  it('ขอรันจริงต้องเป็นคนทดลอง · คนที่สองอนุมัติ (แตะกุญแจ) แล้วรันในพื้นหลัง · บันทึก Audit ของ Workspace', async () => {
    expect((await boss.agent.post(`/ops/scripts/runs/${runId}/request`).send({ reason: 'ลูกค้าขอให้ล้าง session เก่าหลังพนักงานลาออก' })).status).toBe(403);
    const r = (await eng.agent.post(`/ops/scripts/runs/${runId}/request`).send({ reason: 'ลูกค้าขอให้ล้าง session เก่าหลังพนักงานลาออก', ticketRef: '#1907' }).expect(202)).body;
    expect(r).toMatchObject({ status: 'pending_approval', ticketRef: '#1907', pendingApproval: { kind: 'script.run' } });
    expect((await boss.agent.get('/ops/scripts')).body.todo.map((x: { id: string }) => x.id)).toEqual([runId]);
    expect((await boss.agent.get('/ops/overview')).body.tasks.scriptsPending).toBe(1);
    expect((await eng.agent.post(`/ops/approvals/${r.pendingApproval.id}/approve`).send({})).status).toBe(403);
    await reauth(boss);
    await boss.agent.post(`/ops/approvals/${r.pendingApproval.id}/approve`).send({}).expect(200);
    await waitRun(runId);
    const done = (await eng.agent.get(`/ops/scripts/runs/${runId}`)).body;
    expect(done).toMatchObject({ status: 'done', changed: 3, progress: 3, approvedBy: 'บอส ตัวอย่าง', hasChanges: true });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM user_sessions WHERE revoked_at IS NULL`)).rows[0].n).toBe(1);
    const log = await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.script_run'`, [nord.id]);
    expect(log.rows[0].summary).toContain('เปลี่ยน 3 แถว');
    expect((await eng.agent.post(`/ops/scripts/runs/${runId}/request`).send({ reason: 'ขอรันซ้ำโดยไม่ทดลองใหม่' })).body.error.code).toBe('not_dry_run');
  });

  it('ย้อนกลับ: ขออนุมัติแบบเดียวกัน · คืนค่าเดิมทุกแถว · การรันเดิมเป็น "ย้อนกลับแล้ว"', async () => {
    const u = (await eng.agent.post(`/ops/scripts/runs/${runId}/undo`).send({ reason: 'ลูกค้าแจ้งว่ายังต้องใช้ session บนเครื่องสาขา' }).expect(202)).body;
    await boss.agent.post(`/ops/approvals/${u.pendingApproval.id}/approve`).send({}).expect(200);
    await waitRun(u.id);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM user_sessions WHERE revoked_at IS NULL`)).rows[0].n).toBe(4);
    expect((await eng.agent.get(`/ops/scripts/runs/${runId}`)).body.status).toBe('undone');
    expect((await eng.agent.get(`/ops/scripts/runs/${u.id}`)).body).toMatchObject({ status: 'done', undoOf: runId, changed: 3 });
    expect((await eng.agent.post(`/ops/scripts/runs/${runId}/undo`).send({ reason: 'ย้อนซ้ำอีกครั้งหนึ่งนะ' })).body.error.code).toBe('not_undoable');
  });

  it('เลื่อนวันแผนของงานในโปรเจกต์ (เริ่ม / จบเท่ากัน) · ปฏิเสธคำขอแล้วไม่รัน (สถานะ "ไม่อนุมัติ" ไม่ค้างในงานต้องทำ) · ประวัติการรันค้นได้', async () => {
    const wf = await t.owner.query(`INSERT INTO projects (workspace_id, key, name, start_date, golive_date, owner_user_id) VALUES ($1, 'NLO', 'Ops', '2026-11-01', '2027-03-01', $2) RETURNING id`, [nord.id, nord.owner]);
    const pid = wf.rows[0].id;
    const flow = (await t.owner.query(`INSERT INTO workflows (workspace_id, project_id, name) VALUES ($1, $2, 'w') RETURNING id`, [nord.id, pid])).rows[0].id;
    const st = (await t.owner.query(`INSERT INTO workflow_statuses (workspace_id, project_id, workflow_id, name, category) VALUES ($1, $2, $3, 'To do', 'todo') RETURNING id`, [nord.id, pid, flow])).rows[0].id;
    const ty = (await t.owner.query(`INSERT INTO issue_types (workspace_id, project_id, workflow_id, name) VALUES ($1, $2, $3, 'Task') RETURNING id`, [nord.id, pid, flow])).rows[0].id;
    for (const n of [1, 2]) await t.owner.query(`INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title, plan_start, plan_end) VALUES ($1, $2, $3, $4, $5, $6, '2026-11-10', '2026-11-12')`, [nord.id, pid, n, ty, st, `งานนำเข้า ${n}`]);
    const dry = (await eng.agent.post('/ops/scripts/shift_plan_dates/dry-run').send({ workspaceId: nord.id, params: { projectKey: 'nlo', days: 7 } }).expect(200)).body;
    expect(dry.dryResult.sample[0]).toMatchObject({ label: 'NLO-1 งานนำเข้า 1', before: { plan_start: '2026-11-10', plan_end: '2026-11-12' }, after: { plan_start: '2026-11-17', plan_end: '2026-11-19' } });
    const r = (await eng.agent.post(`/ops/scripts/runs/${dry.id}/request`).send({ reason: 'ลูกค้านำเข้าวันผิดไปหนึ่งสัปดาห์' }).expect(202)).body;
    await boss.agent.post(`/ops/approvals/${r.pendingApproval.id}/reject`).send({ note: 'ให้ลูกค้าแก้เองใน Gantt' }).expect(200);
    expect((await t.owner.query(`SELECT plan_start::text FROM issues WHERE project_id = $1 ORDER BY number`, [pid])).rows[0].plan_start).toBe('2026-11-10');
    // ปฏิเสธแล้วไม่ค้างในงานต้องทำและตัวนับ
    expect((await boss.agent.get('/ops/scripts')).body.todo).toEqual([]);
    expect((await boss.agent.get('/ops/overview')).body.tasks.scriptsPending).toBe(0);
    expect((await eng.agent.get(`/ops/scripts/runs/${dry.id}`)).body).toMatchObject({ status: 'rejected', decisionNote: 'ให้ลูกค้าแก้เองใน Gantt' });
    const hist = (await eng.agent.get('/ops/scripts/runs?q=nordlight').expect(200)).body;
    expect(hist.items.map((x: { scriptKey: string; status: string }) => [x.scriptKey, x.status])).toEqual([
      ['shift_plan_dates', 'rejected'],
      ['revoke_stale_sessions', 'done'],
      ['revoke_stale_sessions', 'undone'],
    ]);
  });
});

/** โปรเจกต์ + Workflow ขั้นต่ำสำหรับใส่งาน · คืน id ของโปรเจกต์ สถานะ To do / Done และตัวเพิ่มงาน */
async function project(ws: Customer, key: string, calendarId: string | null = null) {
  const pid = (await t.owner.query(`INSERT INTO projects (workspace_id, key, name, start_date, golive_date, owner_user_id, holiday_calendar_id) VALUES ($1, $2, $2, '2026-11-01', '2027-03-01', $3, $4) RETURNING id`, [ws.id, key, ws.owner, calendarId])).rows[0].id as string;
  const flow = (await t.owner.query(`INSERT INTO workflows (workspace_id, project_id, name) VALUES ($1, $2, 'w') RETURNING id`, [ws.id, pid])).rows[0].id;
  const st = async (name: string, category: string) => (await t.owner.query(`INSERT INTO workflow_statuses (workspace_id, project_id, workflow_id, name, category) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [ws.id, pid, flow, name, category])).rows[0].id as string;
  const todo = await st('To do', 'todo');
  const done = await st('Done', 'done');
  const type = (await t.owner.query(`INSERT INTO issue_types (workspace_id, project_id, workflow_id, name) VALUES ($1, $2, $3, 'Task') RETURNING id`, [ws.id, pid, flow])).rows[0].id as string;
  let n = 0;
  const issue = async (start: string, end: string, status = todo) =>
    void (await t.owner.query(`INSERT INTO issues (workspace_id, project_id, number, issue_type_id, status_id, title, plan_start, plan_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [ws.id, pid, ++n, type, status, `งาน ${n}`, start, end]));
  return { pid, todo, done, issue };
}
const plans = async (pid: string) => (await t.owner.query(`SELECT number, plan_start::text AS s, plan_end::text AS e FROM issues WHERE project_id = $1 ORDER BY number`, [pid])).rows.map((r) => [r.number, r.s, r.e]);

describe('สคริปต์ชุดที่ 2', () => {
  it('เลื่อนวันแผนที่ตกวันหยุด: ปฏิทินของ Workspace + วันหยุดเฉพาะโปรเจกต์ + เสาร์อาทิตย์ · ไม่แตะงานที่เสร็จและวันที่ก่อน from · ย้อนกลับได้', async () => {
    const ws = await customer(t, 'harbor', { plan: 'team_m', status: 'active' });
    const cal = (await t.owner.query(`INSERT INTO holiday_calendars (workspace_id, name) VALUES ($1, 'ปฏิทินบริษัท') RETURNING id`, [ws.id])).rows[0].id;
    // วันหยุดพิเศษที่เพิ่งประกาศ: จ. 7 และ อ. 8 ธ.ค. 2569
    await t.owner.query(`INSERT INTO holidays (calendar_id, date, name) VALUES ($1, '2026-12-07', 'วันหยุดพิเศษ'), ($1, '2026-12-08', 'วันหยุดพิเศษ')`, [cal]);
    await t.owner.query(`INSERT INTO workspace_settings (workspace_id, holiday_calendar_id) VALUES ($1, $2) ON CONFLICT (workspace_id) DO UPDATE SET holiday_calendar_id = $2`, [ws.id, cal]);
    const p = await project(ws, 'HBR');
    await t.owner.query(`INSERT INTO project_holidays (workspace_id, project_id, date, name) VALUES ($1, $2, '2026-12-10', 'ปิดออฟฟิศ')`, [ws.id, p.pid]);
    await p.issue('2026-12-03', '2026-12-07'); // 1 จบวันหยุด → พ. 9
    await p.issue('2026-12-05', '2026-12-10'); // 2 เริ่ม ส. → พ. 9 (จ.–อ. หยุด) · จบวันหยุดโปรเจกต์ → ศ. 11
    await p.issue('2026-12-09', '2026-12-09'); // 3 วันทำการอยู่แล้ว ไม่เปลี่ยน
    await p.issue('2026-12-07', '2026-12-07', p.done); // 4 เสร็จแล้ว ไม่แตะ
    await p.issue('2026-11-28', '2026-12-07'); // 5 เริ่ม ส. ก่อน from ไม่แตะ · จบเลื่อน
    const dry = (await eng.agent.post('/ops/scripts/shift_off_holidays/dry-run').send({ workspaceId: ws.id, params: { projectKey: 'hbr', from: '2026-12-01' } }).expect(200)).body;
    expect(dry.dryResult.count).toBe(3);
    expect(dry.dryResult.sample.map((x: { label: string; after: Record<string, string> }) => [x.label, x.after.plan_start, x.after.plan_end])).toEqual([
      ['HBR-1 งาน 1', '2026-12-03', '2026-12-09'],
      ['HBR-2 งาน 2', '2026-12-09', '2026-12-11'],
      ['HBR-5 งาน 5', '2026-11-28', '2026-12-09'],
    ]);
    const r = (await eng.agent.post(`/ops/scripts/runs/${dry.id}/request`).send({ reason: 'ครม. ประกาศวันหยุดพิเศษเพิ่ม 2 วัน' }).expect(202)).body;
    await boss.agent.post(`/ops/approvals/${r.pendingApproval.id}/approve`).send({}).expect(200);
    await waitRun(dry.id);
    expect(await plans(p.pid)).toEqual([
      [1, '2026-12-03', '2026-12-09'],
      [2, '2026-12-09', '2026-12-11'],
      [3, '2026-12-09', '2026-12-09'],
      [4, '2026-12-07', '2026-12-07'],
      [5, '2026-11-28', '2026-12-09'],
    ]);
    const u = (await eng.agent.post(`/ops/scripts/runs/${dry.id}/undo`).send({ reason: 'ประกาศวันหยุดถูกยกเลิก คืนวันเดิม' }).expect(202)).body;
    await boss.agent.post(`/ops/approvals/${u.pendingApproval.id}/approve`).send({}).expect(200);
    await waitRun(u.id);
    expect((await plans(p.pid)).map((x) => x[2])).toEqual(['2026-12-07', '2026-12-10', '2026-12-09', '2026-12-07', '2026-12-07']);
  });

  it('ส่งอีเมลคำเชิญที่ส่งไม่ผ่านซ้ำ: ต้องตั้ง SMTP · ย้อนไม่ได้จึงต้องพิมพ์ slug · ออกลิงก์ใหม่ (token เดิมใช้ไม่ได้) · ต่ออายุ · บันทึกผลส่งทั้งผ่านและไม่ผ่าน', async () => {
    const ws = await customer(t, 'lumen', { plan: 'team_s', status: 'active' });
    const oldHash = randomUUID();
    const inv = (await t.owner.query(
      `INSERT INTO invitations (workspace_id, email, token_hash, expires_at, created_at, invited_by, message, email_status, email_error, email_attempted_at)
       VALUES ($1, 'new@lumen.example.com', $2, now() + interval '4 days', now() - interval '10 days', $3, 'ยินดีต้อนรับ', 'failed', 'connect ETIMEDOUT', now() - interval '1 day') RETURNING id`,
      [ws.id, oldHash, ws.owner],
    )).rows[0].id;
    await t.owner.query(`INSERT INTO invitations (workspace_id, email, token_hash, expires_at, invited_by, email_status) VALUES ($1, 'broken@lumen.example.com', $2, now() + interval '2 days', $3, 'failed')`, [ws.id, randomUUID(), ws.owner]);
    // ส่งผ่านแล้ว / ไม่ได้รอตอบรับ ไม่ส่งซ้ำ
    await t.owner.query(`INSERT INTO invitations (workspace_id, email, token_hash, expires_at, invited_by, email_status) VALUES ($1, 'ok@lumen.example.com', $2, now() + interval '7 days', $3, 'sent')`, [ws.id, randomUUID(), ws.owner]);
    await t.owner.query(`INSERT INTO invitations (workspace_id, email, token_hash, expires_at, invited_by, email_status, status) VALUES ($1, 'gone@lumen.example.com', $2, now() + interval '7 days', $3, 'failed', 'revoked')`, [ws.id, randomUUID(), ws.owner]);
    // ยังไม่ตั้ง SMTP: รันไปก็ไม่มีอีเมลออก จึงทดลองรันไม่ได้
    expect((await eng.agent.post('/ops/scripts/resend_failed_invitations/dry-run').send({ workspaceId: ws.id, params: {} })).body.error.code).toBe('mail_disabled');
    const mail = t.app.get(Mailer);
    const transport = mail.transportFactory;
    process.env.SMTP_HOST = 'smtp.example.com';
    // ส่งถึง broken@ ไม่ผ่าน (กล่องเต็ม) · ที่เหลือผ่าน
    mail.transportFactory = (() => ({ sendMail: async (m: { to: string }) => { if (m.to.startsWith('broken@')) throw new Error('550 mailbox full'); return {}; } })) as never;
    try {
      const dry = (await eng.agent.post('/ops/scripts/resend_failed_invitations/dry-run').send({ workspaceId: ws.id, params: {} }).expect(200)).body;
      expect(dry.dryResult).toMatchObject({ count: 2, sample: [{ label: 'broken@lumen.example.com · ส่งไม่ผ่าน -' }, { label: expect.stringContaining('new@lumen.example.com · ส่งไม่ผ่าน') }] });
      expect((await eng.agent.post(`/ops/scripts/runs/${dry.id}/request`).send({ reason: 'SMTP ล่มเมื่อวาน ลูกค้าไม่ได้รับคำเชิญ' })).body.error).toMatchObject({ code: 'confirm_required', details: { slug: 'lumen' } });
      const r = (await eng.agent.post(`/ops/scripts/runs/${dry.id}/request`).send({ reason: 'SMTP ล่มเมื่อวาน ลูกค้าไม่ได้รับคำเชิญ', confirmSlug: 'lumen' }).expect(202)).body;
      const before = mail.sent.length;
      await boss.agent.post(`/ops/approvals/${r.pendingApproval.id}/approve`).send({}).expect(200);
      await waitRun(dry.id);
      // ขั้นอนุมัติส่งอีเมลแจ้งพนักงานด้วย · นับเฉพาะที่ถึงผู้รับคำเชิญ
      const toInvitee = mail.sent.slice(before).filter((m) => m.to === 'new@lumen.example.com');
      expect(toInvitee).toHaveLength(1);
      const sent = toInvitee[0];
      expect(sent).toMatchObject({ replyTo: 'owner@lumen.example.com', subject: expect.stringContaining('Co lumen') });
      expect(sent.html).toContain('รับคำเชิญ');
      const token = /\/join\/([A-Za-z0-9_-]+)/.exec(sent.text)![1];
      const row = (await t.owner.query(`SELECT token_hash, email_status, email_error, expires_at > now() + interval '13 days' AS extended FROM invitations WHERE id = $1`, [inv])).rows[0];
      expect(row).toMatchObject({ token_hash: createHash('sha256').update(token).digest('hex'), email_status: 'sent', email_error: null, extended: true });
      expect(row.token_hash).not.toBe(oldHash);
      // ส่งไม่ผ่านอีกรอบ: การรันไม่ล้ม แต่บันทึกสาเหตุไว้ให้รันซ้ำได้
      expect((await t.owner.query(`SELECT email_status, email_error FROM invitations WHERE email = 'broken@lumen.example.com'`)).rows[0]).toEqual({ email_status: 'failed', email_error: '550 mailbox full' });
      expect((await eng.agent.get(`/ops/scripts/runs/${dry.id}`)).body).toMatchObject({ status: 'done', changed: 2 });
      expect((await eng.agent.post(`/ops/scripts/runs/${dry.id}/undo`).send({ reason: 'ขอย้อนการส่งอีเมลซ้ำ' })).body.error.code).toBe('not_undoable');
    } finally {
      delete process.env.SMTP_HOST;
      mail.transportFactory = transport;
    }
  });

  it('อีเมลคำเชิญของ Ops ตรงกับของ API ทุกตัวอักษร (สำเนาไฟล์ต้องไม่หลุดจากกัน)', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = { to: 'a@example.com', inviteUrl: 'https://app.example.com/join/x', expiresAt: new Date('2026-12-01T03:00:00Z'), workspaceName: 'Co <A>', inviterName: 'คุณเอ', projectName: 'Web', message: 'สวัสดี\nทีม', locale };
      expect(renderInvitationEmail(m)).toEqual(apiInvitationEmail(m));
    }
  });

  it('สคริปต์ที่ล้มขึ้นในงานเบื้องหลังที่ล้มของหน้าสถานะระบบ (7 วัน)', async () => {
    await t.owner.query(`INSERT INTO script_runs (script_key, workspace_id, params, status, requested_by, changed, error, finished_at) VALUES ('shift_off_holidays', $1, '{}', 'failed', $2, 500, 'deadlock detected', now()), ('shift_off_holidays', $1, '{}', 'failed', $2, 0, 'เก่าเกิน', now() - interval '8 days')`, [nord.id, eng.id]);
    const body = (await eng.agent.get('/ops/jobs/failed').expect(200)).body;
    expect(body.scripts).toEqual([expect.objectContaining({ scriptKey: 'shift_off_holidays', workspaceName: 'Co nordlight', error: 'deadlock detected', changed: 500 })]);
  });
});
