// O54 · Lead และดีล · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayBkk } from '../src/billing/ledger.js';
import { LeadsService } from '../src/sales/leads.service.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let sam: Staff;
let riverbank: Customer;
let formLead: string;
const today = todayBkk();

beforeAll(async () => {
  t = await startOps();
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', ['owner']);
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  // ทดลองใช้ 22 ที่นั่งใช้งานจริง (เกณฑ์ 20)
  riverbank = await customer(t, 'riverbank', { plan: 'team_m', status: 'trialing' });
  for (let i = 0; i < 21; i++) {
    const u = (await t.owner.query(`INSERT INTO users (email, display_name) VALUES ($1, $1) RETURNING id`, [`m${i}@riverbank.example.com`])).rows[0].id;
    await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role, last_active_at) VALUES ($1, $2, 'member', now())`, [riverbank.id, u]);
  }
  await t.owner.query(`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = $1`, [riverbank.id]);
  const small = await customer(t, 'small-trial');
  await t.owner.query(`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = $1`, [small.id]);
  // Lead จากฟอร์ม (API ลูกค้าเขียน) · สร้างเมื่อ 2 วันทำการก่อน
  formLead = (await t.owner.query(`INSERT INTO leads (company, contact_name, email, team_size, seats, needs, source, consent_at, created_at) VALUES ('บริษัท ลานนาเทค จำกัด', 'คุณวรรณา', 'wanna@lannatech.example', 150, 150, '{sso,annual_contract}', 'form', now(), now() - interval '4 days') RETURNING id`)).rows[0].id;
});
afterAll(() => t.close());

describe('Lead และดีล', () => {
  it('งานรายวัน: ลูกค้าทดลองที่ใช้งานจริงถึงเกณฑ์เป็น Lead (ไม่ซ้ำ) · ปรับเกณฑ์ได้', async () => {
    const svc = t.app.get(LeadsService);
    expect(await svc.daily(today)).toEqual({ created: 1, purged: 0 });
    expect((await svc.daily(today)).created).toBe(0);
    const trial = (await t.owner.query(`SELECT company, seats, source, workspace_id FROM leads WHERE source = 'trial'`)).rows;
    expect(trial).toEqual([{ company: 'Co riverbank', seats: 22, source: 'trial', workspace_id: riverbank.id }]);
    expect((await sam.agent.get('/ops/leads/summary')).status).toBe(403);
    await boss.agent.put('/ops/leads/settings').send({ trialSeats: 1 }).expect(200);
    expect((await svc.daily(today)).created).toBe(1);
  });

  it('ต้องทำตอนนี้: Lead ใหม่ที่ยังไม่ติดต่อ (เกิน 1 วันทำการ = เลยเกณฑ์) · ตัวเลขต่อขั้น', async () => {
    const s = (await boss.agent.get('/ops/leads/summary').expect(200)).body;
    expect(s).toMatchObject({ open: 3, todo: { uncontacted: 3, due: 0 }, stages: { new: { n: 3 } } });
    expect(s.todo.items[0]).toMatchObject({ id: formLead, company: 'บริษัท ลานนาเทค จำกัด', source: 'form', late: true });
    expect((await boss.agent.get('/ops/overview')).body.tasks.leadsDue).toBe(3);
  });

  it('รับเรื่อง → บันทึกการคุยต้องกำหนดทำต่อ → ขั้นเป็นติดต่อแล้ว · ทำต่อถึงวันนี้ขึ้นแถบต้องทำ', async () => {
    await boss.agent.post(`/ops/leads/${formLead}/claim`).expect(200);
    expect((await boss.agent.post(`/ops/leads/${formLead}/notes`).send({ kind: 'call', body: 'ต้องการทดลอง 30 วัน 20 คนก่อน' })).status).toBe(400);
    const d = (await boss.agent.post(`/ops/leads/${formLead}/notes`).send({ kind: 'call', body: 'ต้องการทดลอง 30 วัน 20 คนก่อน ขอใบเสนอราคา 150 ที่นั่ง 1 ปี', nextAction: 'ส่งใบเสนอราคา', nextAt: today }).expect(201)).body;
    expect(d).toMatchObject({ stage: 'contacted', owner: 'บอส ตัวอย่าง', nextAction: 'ส่งใบเสนอราคา', nextAt: today, contactedAt: expect.any(String) });
    expect(d.notes.map((n: { kind: string }) => n.kind)).toEqual(['call', 'system']);
    expect((await boss.agent.get('/ops/leads/summary')).body.todo).toMatchObject({ uncontacted: 2, due: 1 });
  });

  it('ตารางตามขั้น · ค้น · ตัวกรอง · ส่งออก CSV', async () => {
    await boss.agent.patch(`/ops/leads/${formLead}`).send({ stage: 'proposal', valueSatang: 59_400_000 }).expect(200);
    expect((await boss.agent.get('/ops/leads?stage=proposal')).body.items.map((x: { company: string }) => x.company)).toEqual(['บริษัท ลานนาเทค จำกัด']);
    expect((await boss.agent.get('/ops/leads?q=riverbank')).body.total).toBe(1);
    expect((await boss.agent.get('/ops/leads?source=trial')).body.total).toBe(2);
    expect((await boss.agent.get('/ops/leads?owner=me')).body.total).toBe(1);
    expect((await boss.agent.get('/ops/leads?minValue=50000000')).body.total).toBe(1);
    expect((await boss.agent.get('/ops/leads/summary')).body.pipelineSatang).toBe(59_400_000);
    const csv = (await boss.agent.get('/ops/leads/export?stage=proposal').expect(200)).text;
    expect(csv).toContain('บริษัท ลานนาเทค จำกัด');
    expect(csv).toContain('594000');
  });

  it('แผงขวาแสดงการใช้งาน Workspace ทดลอง · ชนะ = สร้างบัญชีลูกค้าและผูก Workspace · แพ้ต้องมีเหตุผล', async () => {
    const trial = (await boss.agent.get('/ops/leads?q=riverbank')).body.items[0];
    const d = (await boss.agent.get(`/ops/leads/${trial.id}`).expect(200)).body;
    expect(d.trial).toMatchObject({ slug: 'riverbank', seats: 22, active14: 22, status: 'trialing' });
    const won = (await boss.agent.patch(`/ops/leads/${trial.id}`).send({ stage: 'won', note: 'เซ็นสัญญา 1 ปี' }).expect(200)).body;
    expect(won).toMatchObject({ stage: 'won', closedAt: expect.any(String), accountId: expect.any(String) });
    const acct = await t.owner.query(`SELECT a.name, a.kind, w.workspace_id FROM customer_accounts a JOIN customer_account_workspaces w ON w.account_id = a.id WHERE a.id = $1`, [won.accountId]);
    expect(acct.rows).toEqual([{ name: 'Co riverbank', kind: 'enterprise', workspace_id: riverbank.id }]);
    const small = (await boss.agent.get('/ops/leads?q=small')).body.items[0];
    expect((await boss.agent.patch(`/ops/leads/${small.id}`).send({ stage: 'lost' })).status).toBe(400);
    await boss.agent.patch(`/ops/leads/${small.id}`).send({ stage: 'lost', lostReason: 'no_budget' }).expect(200);
    const s = (await boss.agent.get('/ops/leads/summary')).body;
    expect(s).toMatchObject({ open: 1, won90: 1, lost90: 1 });
    expect((await boss.agent.post(`/ops/leads/${small.id}/notes`).send({ kind: 'note', body: 'ลองใหม่', nextAction: 'โทร', nextAt: today })).body.error.code).toBe('lead_closed');
  });

  it('เพิ่ม Lead เอง · แพ้เกิน 2 ปีลบตามนโยบาย', async () => {
    const r = (await boss.agent.post('/ops/leads').send({ company: 'Orchid Insurance', contactName: 'คุณสมศรี', email: 'somsri@orchid.example', seats: 220, valueSatang: 79_200_000, nextAction: 'ส่งเอกสาร security', nextAt: addDays(today, 1) }).expect(201)).body;
    expect(r).toMatchObject({ source: 'manual', stage: 'new', owner: 'บอส ตัวอย่าง' });
    await t.owner.query(`UPDATE leads SET closed_at = now() - interval '800 days' WHERE stage = 'lost'`);
    expect((await t.app.get(LeadsService).daily(today)).purged).toBe(1);
  });
});
