// O53 · สุขภาพและ Playbook · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayBkk } from '../src/billing/ledger.js';
import { Mailer } from '../src/mail.js';
import { SuccessService } from '../src/success/success.service.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let sam: Staff;
let nord: Customer;
let tide: Customer;
let fine: Customer;
let dip: Customer;
let svc: SuccessService;
const today = todayBkk();

/** แถวคะแนนย้อนหลัง (วันก่อนหน้า) ให้ครบเงื่อนไข "ติดกัน 3 วัน" */
async function past(c: Customer, daysAgo: number, score: number, usage: number) {
  await t.owner.query(`INSERT INTO health_daily (workspace_id, date, score, usage, payment, support, growth) VALUES ($1, $2, $3, $4, 100, 100, 50)`, [c.id, addDays(today, -daysAgo), score, usage]);
}
const run = async (c: Customer) => (await t.owner.query(`SELECT r.id, r.status, r.step_index, r.close_reason, st.name AS owner FROM playbook_runs r LEFT JOIN staff_users st ON st.id = r.owner_id JOIN playbooks p ON p.id = r.playbook_id WHERE r.workspace_id = $1 AND p.key = 'usage_drop' ORDER BY r.created_at DESC LIMIT 1`, [c.id])).rows[0];
const pendingStep = async (runId: string) => (await t.owner.query(`SELECT id, step_index, kind, title, due_on::text AS due, status FROM playbook_run_steps WHERE run_id = $1 AND status = 'pending'`, [runId])).rows[0];

beforeAll(async () => {
  t = await startOps();
  svc = t.app.get(SuccessService);
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', ['owner']);
  sam = await staff(t, 'sam@friday.example.com', 'สมหญิง Support', 'support');
  // ใช้งานลดลง: ไม่มีสมาชิกเข้าใช้ใน 30 วัน (usage 0)
  nord = await customer(t, 'nordlight', { plan: 'team_m', status: 'active' });
  tide = await customer(t, 'tidewater', { plan: 'team_s', status: 'active' });
  for (const c of [nord, tide]) for (const d of [1, 2]) await past(c, d, 50, 20);
  // บัญชีลูกค้าที่มีคนดูแล → งานไปที่คนดูแล
  const acct = (await t.owner.query(`INSERT INTO customer_accounts (name, manager_id) VALUES ('บจก. ไทด์วอเตอร์', $1) RETURNING id`, [boss.id])).rows[0].id;
  await t.owner.query(`INSERT INTO customer_account_workspaces (workspace_id, account_id) VALUES ($1, $2)`, [tide.id, acct]);
  // สุขภาพดี: สมาชิกใช้งานล่าสุดวันนี้
  fine = await customer(t, 'fine-co', { plan: 'team_m', status: 'active' });
  await t.owner.query(`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = $1`, [fine.id]);
  // เพิ่งตก: 7 วันก่อน 95 · วันนี้ 53 (คำนวณจริง) · ยังไม่เข้าเงื่อนไขติดกัน 3 วัน
  dip = await customer(t, 'dip-co', { plan: 'team_m', status: 'active' });
  await past(dip, 7, 95, 100);
  // ไม่จ่ายเงิน (ทดลอง) ไม่นับ
  await customer(t, 'trial-co');
});
afterAll(() => t.close());

describe('สุขภาพและ Playbook', () => {
  it('ทุกเช้า: เก็บคะแนนรายวันเฉพาะลูกค้าที่จ่ายเงิน · เริ่ม Playbook ตามเงื่อนไขติดกัน 3 วัน · ขั้นอีเมลส่งเอง · งานไปที่คนดูแลบัญชี หรือ Support', async () => {
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    expect(await svc.daily(today)).toEqual({ scored: 4, churned: 0, started: 2, advanced: 0 });
    const h = (await t.owner.query(`SELECT w.slug, h.score, h.usage FROM health_daily h JOIN workspaces w ON w.id = h.workspace_id WHERE h.date = $1 ORDER BY w.slug`, [today])).rows;
    expect(h).toEqual([
      { slug: 'dip-co', score: 53, usage: 0 },
      { slug: 'fine-co', score: 93, usage: 100 },
      { slug: 'nordlight', score: 53, usage: 0 },
      { slug: 'tidewater', score: 53, usage: 0 },
    ]);
    expect(mail.sent.slice(before).map((m) => [m.to, m.subject])).toEqual(expect.arrayContaining([['owner@nordlight.example.com', 'เคล็ดลับให้ทีมกลับมาใช้'], ['owner@tidewater.example.com', 'เคล็ดลับให้ทีมกลับมาใช้']]));
    const n = await run(nord);
    expect(n).toMatchObject({ status: 'active', step_index: 1, owner: 'สมหญิง Support' });
    expect(await pendingStep(n.id)).toMatchObject({ kind: 'task', title: 'โทรหา Owner ถามว่าติดอะไร', due: addDays(today, 2) });
    expect((await run(tide)).owner).toBe('บอส ตัวอย่าง');
    // รันซ้ำวันเดียวกันไม่เริ่มซ้ำ
    expect((await svc.daily(today)).started).toBe(0);
  });

  it('ต้องทำวันนี้: งานที่ครบกำหนด · ของฉันขึ้นก่อน · ตัวเลขหัวหน้า', async () => {
    expect((await sam.agent.get('/ops/success/summary').expect(200)).body).toMatchObject({ paying: 4, low: 0, todo: { items: [] }, tabs: { active: 2, dropped: 1 } });
    const s = await svc.summary({ id: sam.id } as never, addDays(today, 2));
    expect(s.todo).toMatchObject({ mine: 1, overdue: 0 });
    expect(s.todo.items.map((x) => x.workspace)).toEqual(['Co nordlight', 'Co tidewater']);
    expect((await boss.agent.get('/ops/overview')).body.tasks.playbookDue).toBe(0);
  });

  it('ตาราง: แท็บ · คนดูแล · ส่วนที่ต่ำ · เพิ่งตก', async () => {
    const act = (await sam.agent.get('/ops/success/runs?tab=active').expect(200)).body;
    expect(act.total).toBe(2);
    expect(act.items[0]).toMatchObject({ playbook: 'ใช้งานลดลง', score: 53, usage: 0, next: { title: 'โทรหา Owner ถามว่าติดอะไร', kind: 'task' } });
    expect((await sam.agent.get('/ops/success/runs?owner=me')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['nordlight']);
    expect((await sam.agent.get('/ops/success/runs?weak=usage')).body.total).toBe(2);
    expect((await sam.agent.get('/ops/success/runs?weak=payment')).body.total).toBe(0);
    expect((await sam.agent.get('/ops/success/runs?plan=team_s')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['tidewater']);
    const dropped = (await sam.agent.get('/ops/success/runs?tab=dropped')).body;
    expect(dropped.items).toEqual([expect.objectContaining({ slug: 'dip-co', score: 53, score7: 95, runId: null })]);
  });

  it('บันทึกผล: ติดต่อได้ → นัดสอนใช้งาน · ไม่รับสาย → รอ 14 วัน · ครบแล้วคะแนนฟื้น = ปิดเอง', async () => {
    const n = await run(nord);
    let step = await pendingStep(n.id);
    expect((await sam.agent.post(`/ops/success/steps/${step.id}/outcome`).send({ outcome: 'reached', note: 'ย้ายไปใช้ Excel ช่วงปิดงบ จะกลับมา ธ.ค.' }).expect(200)).body).toMatchObject({ stepIndex: 2, status: 'active' });
    expect((await sam.agent.post(`/ops/success/steps/${step.id}/outcome`).send({ outcome: 'reached' })).body.error.code).toBe('step_done');
    step = await pendingStep(n.id);
    expect(step.title).toBe('นัดสอนใช้งาน 30 นาที');
    await sam.agent.post(`/ops/success/steps/${step.id}/snooze`).send({ days: 2 }).expect(200);
    expect((await pendingStep(n.id)).due).toBe(addDays(today, 7));
    await sam.agent.post(`/ops/success/steps/${step.id}/outcome`).send({ outcome: 'no_answer' }).expect(200);
    const wait = await pendingStep(n.id);
    expect(wait).toMatchObject({ kind: 'wait', due: addDays(today, 14) });
    const d = (await sam.agent.get(`/ops/success/runs/${n.id}`).expect(200)).body;
    expect(d.steps.map((x: { title: string; outcome: string }) => [x.title, x.outcome])).toEqual([
      ['เคล็ดลับให้ทีมกลับมาใช้', 'sent'],
      ['โทรหา Owner ถามว่าติดอะไร', 'reached'],
      ['นัดสอนใช้งาน 30 นาที', 'no_answer'],
      ['รอ 14 วัน แล้วดูคะแนนอีกครั้ง', null],
    ]);
    expect(d).toMatchObject({ playbook: { key: 'usage_drop' }, health: { score: 53, usage: 0 }, workspace: { slug: 'nordlight', ownerEmail: 'owner@nordlight.example.com' } });
    const log = await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.playbook_step'`, [nord.id]);
    expect(log.rows[0].summary).toContain('ย้ายไปใช้ Excel');
    // ลูกค้ากลับมาใช้จริง → ครบ 14 วันคะแนนถึง 60 = ฟื้นแล้ว
    await t.owner.query(`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = $1`, [nord.id]);
    expect((await svc.daily(addDays(today, 14))).advanced).toBe(1);
    expect(await run(nord)).toMatchObject({ status: 'recovered', close_reason: 'คะแนนฟื้นเป็น 93' });
    expect((await sam.agent.get('/ops/success/runs?tab=recovered')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['nordlight']);
  });

  it('ทางแยก "จะยกเลิก" → เสนอส่วนลด → จะยกเลิกอีก = ปิด Playbook', async () => {
    const r = await run(tide);
    await boss.agent.post(`/ops/success/steps/${(await pendingStep(r.id)).id}/outcome`).send({ outcome: 'will_cancel' }).expect(200);
    const s = await pendingStep(r.id);
    expect(s.title).toBe('เสนอส่วนลด 1 เดือน (ขออนุมัติตามวงเงินเดิม)');
    await boss.agent.post(`/ops/success/steps/${s.id}/outcome`).send({ outcome: 'will_cancel', note: 'ลูกค้าย้ายไปใช้ระบบอื่น' }).expect(200);
    expect(await run(tide)).toMatchObject({ status: 'closed', close_reason: 'ผล: will_cancel' });
  });

  it('เริ่มเองจากแท็บเพิ่งตก · ปิดเอง · ลูกค้ายกเลิกแพ็กเกจ = churned', async () => {
    const pbs = (await sam.agent.get('/ops/success/playbooks').expect(200)).body.items;
    expect(pbs.map((p: { key: string }) => p.key)).toEqual(['usage_drop', 'overdue', 'team_shrink', 'tickets_backlog', 'renewal_low_health']);
    const usage = pbs.find((p: { key: string }) => p.key === 'usage_drop');
    const started = (await sam.agent.post('/ops/success/runs').send({ workspaceId: dip.id, playbookId: usage.id }).expect(201)).body;
    expect(started).toMatchObject({ status: 'active', owner: 'สมหญิง Support' });
    expect((await sam.agent.post('/ops/success/runs').send({ workspaceId: dip.id, playbookId: usage.id })).body.error.code).toBe('run_active');
    await t.owner.query(`UPDATE subscriptions SET status = 'canceled' WHERE workspace_id = $1`, [dip.id]);
    expect((await svc.daily(today)).churned).toBe(1);
    expect((await sam.agent.get('/ops/success/runs?tab=churned')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['dip-co']);
    expect((await sam.agent.post(`/ops/success/runs/${started.id}/close`).send({ reason: 'ปิดซ้ำ' })).body.error.code).toBe('run_closed');
  });

  it('ปุ่มเฟือง: แก้ได้เฉพาะ Owner · ตรวจทางแยก · ปิด Playbook แล้วไม่เริ่มใหม่', async () => {
    const pb = (await boss.agent.get('/ops/success/playbooks')).body.items.find((p: { key: string }) => p.key === 'usage_drop');
    const body = { name: pb.name, enabled: false, trigger: pb.trigger, steps: pb.steps };
    expect((await sam.agent.put(`/ops/success/playbooks/${pb.id}`).send(body)).status).toBe(403);
    expect((await boss.agent.put(`/ops/success/playbooks/${pb.id}`).send({ ...body, steps: [{ kind: 'task', title: 'โทร', days: 1, branches: { reached: 5 } }] })).status).toBe(400);
    await boss.agent.put(`/ops/success/playbooks/${pb.id}`).send(body).expect(200);
    for (const d of [1, 2]) await past(fine, d, 50, 20);
    await t.owner.query(`UPDATE workspace_members SET last_active_at = NULL WHERE workspace_id = $1`, [fine.id]);
    expect((await svc.daily(today)).started).toBe(0);
  });
});
