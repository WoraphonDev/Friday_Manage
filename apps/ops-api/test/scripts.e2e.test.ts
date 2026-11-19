// O56 · สคริปต์ดูแลข้อมูล · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('เลื่อนวันแผนของงานในโปรเจกต์ (เริ่ม / จบเท่ากัน) · ปฏิเสธคำขอแล้วไม่รัน · ประวัติการรันค้นได้', async () => {
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
    const hist = (await eng.agent.get('/ops/scripts/runs?q=nordlight').expect(200)).body;
    expect(hist.items.map((x: { scriptKey: string; status: string }) => [x.scriptKey, x.status])).toEqual([
      ['shift_plan_dates', 'pending_approval'],
      ['revoke_stale_sessions', 'done'],
      ['revoke_stale_sessions', 'undone'],
    ]);
  });
});
