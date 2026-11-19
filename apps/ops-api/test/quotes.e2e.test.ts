// O55 · ใบเสนอราคาและสัญญา · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayBkk } from '../src/billing/ledger.js';
import { Mailer } from '../src/mail.js';
import { QuotesService } from '../src/sales/quotes.service.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let fin: Staff;
let sam: Staff;
let lanna: Customer;
let leadId: string;
let quoteId: string;
const today = todayBkk();
const body = { seats: 150, months: 12, pricePerSeatSatang: 33_000, entitlements: { sso: true, api_rpm: 600 }, sla: { first: { n: 1, unit: 'h' }, resolve: { n: 8, unit: 'h' } } };

beforeAll(async () => {
  t = await startOps();
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', ['owner']);
  fin = await staff(t, 'fin@friday.example.com', 'ฟิน บัญชี', 'finance');
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  // วงเงินส่วนลดของการเงินคนนี้ 15%
  await t.owner.query(`UPDATE staff_users SET limits = '{"discountPct": 15}' WHERE id = $1`, [fin.id]);
  leadId = (await t.owner.query(`INSERT INTO leads (company, contact_name, email, source, stage) VALUES ('บริษัท ลานนาเทค จำกัด', 'คุณวรรณา', 'wanna@lannatech.example', 'form', 'contacted') RETURNING id`)).rows[0].id;
  lanna = await customer(t, 'lannatech', { plan: 'team_m', status: 'active' });
  await t.owner.query(`INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email) VALUES ($1, 'บริษัท ลานนาเทค จำกัด', '0505500000011', '1 ถนนสมมติ เชียงใหม่', 'acc@lannatech.example')`, [lanna.id]);
});
afterAll(() => t.close());

describe('ใบเสนอราคาและสัญญา', () => {
  it('สร้างจาก Lead: สร้างบัญชีลูกค้าให้ · เลขที่ QT-ปปดด-0001 · คิดยอด + VAT · ส่วนลดเทียบราคาปกติ · Lead เป็นเสนอราคา', async () => {
    expect((await sam.agent.get('/ops/quotes/summary')).status).toBe(403);
    const q = (await fin.agent.post('/ops/quotes').send({ ...body, leadId }).expect(201)).body;
    quoteId = q.id;
    expect(q).toMatchObject({ number: `QT-${today.slice(2, 4)}${today.slice(5, 7)}-0001`, status: 'draft', company: 'บริษัท ลานนาเทค จำกัด', subtotalSatang: 59_400_000, vatSatang: 4_158_000, totalSatang: 63_558_000, discountPct: 17.5, validUntil: addDays(today, 30) });
    expect((await t.owner.query(`SELECT stage, account_id IS NOT NULL AS acct FROM leads WHERE id = $1`, [leadId])).rows[0]).toEqual({ stage: 'proposal', acct: true });
  });

  it('ส่วนลดเกินวงเงิน → ขออนุมัติ (202) ขึ้นแถบต้องทำ · Owner อนุมัติแล้วส่งได้ · ลิงก์ + อีเมลถึงผู้ลงนาม', async () => {
    const r = await fin.agent.post(`/ops/quotes/${quoteId}/send`);
    expect(r.status).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'quote.discount' });
    const sum = (await boss.agent.get('/ops/quotes/summary').expect(200)).body;
    expect(sum.todo).toEqual([expect.objectContaining({ id: quoteId, reason: 'approval', approvalStatus: 'pending' })]);
    expect((await boss.agent.get('/ops/overview')).body.tasks.quotesDue).toBe(1);
    await reauth(boss);
    await boss.agent.post(`/ops/approvals/${r.body.pendingApproval.id}/approve`).send({}).expect(200);
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    const sent = (await fin.agent.post(`/ops/quotes/${quoteId}/send`).expect(200)).body;
    expect(sent).toMatchObject({ status: 'sent', approvedBy: 'บอส ตัวอย่าง', emailed: 1, link: expect.stringMatching(/\/quote\/[A-Za-z0-9_-]{30,}$/) });
    expect(mail.sent.slice(before)).toEqual([expect.objectContaining({ to: 'wanna@lannatech.example', subject: expect.stringContaining('QT-'), text: expect.stringContaining(sent.link) })]);
    expect((await fin.agent.put(`/ops/quotes/${quoteId}`).send({ ...body, leadId })).body.error.code).toBe('quote_not_draft');
  });

  it('แก้ราคาหลังอนุมัติต้องขอใหม่', async () => {
    const q2 = (await fin.agent.post('/ops/quotes').send({ ...body, leadId, seats: 20 }).expect(201)).body;
    await t.owner.query(`UPDATE quotes SET approved_at = now(), approved_by = $2 WHERE id = $1`, [q2.id, boss.id]);
    const u = (await fin.agent.put(`/ops/quotes/${q2.id}`).send({ ...body, leadId, seats: 25 }).expect(200)).body;
    expect(u.approvedAt).toBeNull();
    expect(u.subtotalSatang).toBe(25 * 12 * 33_000);
  });

  it('ลูกค้าตอบรับ → ขั้นตั้งค่า: สัญญา · SLA · เตือนต่อสัญญา · Lead ชนะ · สิทธิ์และใบแจ้งหนี้รอ Workspace', async () => {
    await t.owner.query(`UPDATE quotes SET view_count = 3, status = 'accepted', accepted_at = now(), acceptance = '{"name": "คุณสมชาย", "title": "CFO", "po": "PO-88213"}' WHERE id = $1`, [quoteId]);
    const svc = t.app.get(QuotesService);
    expect((await svc.tick(today)).setup).toBe(1);
    const q = (await fin.agent.get(`/ops/quotes/${quoteId}`)).body;
    expect(Object.fromEntries(Object.entries(q.setup as Record<string, { status: string }>).map(([k, v]) => [k, v.status]))).toEqual({ contract: 'done', entitlements: 'waiting', sla: 'done', invoice: 'waiting', renewal: 'done', lead: 'done' });
    const acct = (await t.owner.query(`SELECT kind, contract_seats, contract_value::float8 AS value, contract_sla, contract_end - contract_start AS days FROM customer_accounts WHERE id = $1`, [q.accountId])).rows[0];
    expect(acct).toMatchObject({ kind: 'enterprise', contract_seats: 150, value: 59_400_000, contract_sla: body.sla });
    expect(acct.days).toBeGreaterThanOrEqual(364);
    expect((await t.owner.query(`SELECT stage FROM leads WHERE id = $1`, [leadId])).rows[0].stage).toBe('won');
    expect((await boss.agent.get('/ops/quotes/summary')).body.todo.find((x: { id: string }) => x.id === quoteId).reason).toBe('setup');
  });

  it('ผูก Workspace → สิทธิ์ตามสัญญา (ไม่มีวันหมด · contract_ref) และใบแจ้งหนี้ยอดเท่าใบเสนอราคา', async () => {
    const q = (await fin.agent.post(`/ops/quotes/${quoteId}/workspace`).send({ workspaceId: lanna.id }).expect(200)).body;
    expect(Object.values(q.setup as Record<string, { status: string }>).every((v) => v.status === 'done')).toBe(true);
    const ov = await t.owner.query(`SELECT key, value, contract_ref, expires_at FROM entitlement_overrides WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY key`, [lanna.id]);
    expect(ov.rows).toEqual([
      { key: 'api_rpm', value: 600, contract_ref: q.number, expires_at: null },
      { key: 'seats', value: 150, contract_ref: q.number, expires_at: null },
      { key: 'sso', value: true, contract_ref: q.number, expires_at: null },
    ]);
    const inv = await t.owner.query(`SELECT total::float8 AS total, po_number FROM invoices WHERE workspace_id = $1`, [lanna.id]);
    expect(inv.rows).toEqual([{ total: 63_558_000, po_number: 'PO-88213' }]);
    expect((await boss.agent.get('/ops/overview')).body.tasks.quotesDue).toBe(0);
  });

  it('รายการ: แท็บ · ค้น · หมดอายุ → ต่ออายุ · ทำสำเนาเป็นร่างใหม่', async () => {
    expect((await fin.agent.get('/ops/quotes?tab=accepted')).body.items.map((x: { id: string; viewCount: number }) => [x.id, x.viewCount])).toEqual([[quoteId, 3]]);
    expect((await fin.agent.get('/ops/quotes?tab=draft&q=ลานนา')).body.total).toBe(1);
    const accountId = (await fin.agent.get(`/ops/quotes/${quoteId}`)).body.accountId;
    const q3 = (await boss.agent.post('/ops/quotes').send({ ...body, accountId, pricePerSeatSatang: 38_000 }).expect(201)).body;
    await boss.agent.post(`/ops/quotes/${q3.id}/send`).expect(200);
    await t.owner.query(`UPDATE quotes SET valid_until = $2 WHERE id = $1`, [q3.id, addDays(today, -1)]);
    expect((await t.app.get(QuotesService).tick(today)).expired).toBe(1);
    expect((await fin.agent.get('/ops/quotes?tab=closed')).body.total).toBe(1);
    const ext = (await fin.agent.post(`/ops/quotes/${q3.id}/extend`).send({ days: 14 }).expect(200)).body;
    expect(ext).toMatchObject({ status: 'sent', validUntil: addDays(today, 14) });
    const copy = (await fin.agent.post(`/ops/quotes/${q3.id}/copy`).expect(201)).body;
    expect(copy).toMatchObject({ status: 'draft', pricePerSeatSatang: 38_000, number: expect.stringMatching(/-0004$/) });
  });
});
