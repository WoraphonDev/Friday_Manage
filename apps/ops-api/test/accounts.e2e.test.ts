// ช่วง 3 · บัญชีลูกค้าระดับบริษัท · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accounts/accounts.module.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let sam: Staff;
let fin: Staff;
let a: Customer;
let b: Customer;
let c: Customer;
let lone: Customer;
const TAX = '0105500000017';
const PDF = Buffer.from('%PDF-1.4\n% สัญญาสมมติ\n%%EOF');

beforeAll(async () => {
  t = await startOps();
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', 'admin');
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  fin = await staff(t, 'fin@friday.example.com', 'ฟิน บัญชี', 'finance');
  a = await customer(t, 'acct-a', { plan: 'team_m', status: 'active' });
  b = await customer(t, 'acct-b', { plan: 'team_l', status: 'active' });
  c = await customer(t, 'acct-c', { plan: 'team_s', status: 'active' });
  lone = await customer(t, 'acct-lone', { plan: 'team_s', status: 'active' });
  await t.owner.query(
    `INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email) VALUES ($1, 'บจก. สยามสมมติ', $4, '1 ถนนสมมติ', 'acc@siam.example.com'), ($2, 'บจก. สยามสมมติ', $4, '1 ถนนสมมติ', 'acc@siam.example.com'), ($3, 'บจก. เดี่ยว', '0105500000025', '2 ถนนสมมติ', 'acc@lone.example.com')`,
    [a.id, b.id, lone.id, TAX],
  );
});
afterAll(() => t.close());

describe('บัญชีลูกค้า', () => {
  let id: string;
  it('ระบบเสนอจากเลขภาษีที่มีตั้งแต่ 2 Workspace · Support สร้างได้ · เพิ่มบริษัทในเครือที่เลขต่างกัน · ผู้ซื้อในหน้า Workspaces บอกบัญชี', async () => {
    const sug = (await sam.agent.get('/ops/accounts/suggestions').expect(200)).body.items;
    expect(sug).toEqual([expect.objectContaining({ taxId: TAX, name: 'บจก. สยามสมมติ', count: 2, key: `t:${TAX}` })]);
    expect((await fin.agent.post('/ops/accounts').send({ name: 'x', workspaceIds: [a.id] })).status).toBe(403);
    const made = (await sam.agent.post('/ops/accounts').send({ name: 'บจก. สยามสมมติ', taxIds: [TAX], managerId: sam.id, workspaceIds: [a.id, b.id] }).expect(201)).body;
    id = made.id;
    expect(made).toMatchObject({ name: 'บจก. สยามสมมติ', managerName: 'Sam Support', kind: 'standard', contractValue: null, numbers: { workspaces: 2, mrr: null } });
    expect((await sam.agent.get('/ops/accounts/suggestions')).body.items).toEqual([]);
    await sam.agent.post(`/ops/accounts/${id}/workspaces`).send({ workspaceIds: [c.id] }).expect(200);
    const other = await sam.agent.post('/ops/accounts').send({ name: 'ซ้ำ', workspaceIds: [c.id] });
    expect(other.body.error.code).toBe('workspace_in_account');
    const list = (await boss.agent.get(`/ops/workspaces?account=${id}&sort=newest`)).body;
    expect(list.total).toBe(3);
    expect(list.items[0].account).toMatchObject({ id, name: 'บจก. สยามสมมติ' });
    const buyer = (await boss.agent.get(`/ops/workspaces?buyer=t:${TAX}`)).body.buyer;
    expect(buyer.account).toMatchObject({ id });
    expect((await boss.agent.get(`/ops/accounts?q=${TAX}`)).body.items.map((x: { id: string }) => x.id)).toEqual([id]);
    expect((await boss.agent.get('/ops/accounts?q=acct-c')).body.total).toBe(1);
  });

  it('สัญญาแก้ได้เฉพาะ Owner / การเงิน · Support ไม่เห็นมูลค่า · SLA ตามสัญญาใช้กับ Ticket ใหม่และแผง Ticket', async () => {
    expect((await sam.agent.put(`/ops/accounts/${id}/contract`).send({ start: '2026-04-01', end: '2027-03-31', value: 21_600_000, seats: 125, sla: null })).status).toBe(403);
    const end = new Date(Date.now() + 45 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
    const sla = { first: { n: 1, unit: 'h' }, resolve: { n: 1, unit: 'd' } };
    const r = (await fin.agent.put(`/ops/accounts/${id}/contract`).send({ start: '2026-04-01', end, value: 21_600_000, seats: 125, sla }).expect(200)).body;
    expect(r).toMatchObject({ kind: 'enterprise', contractValue: 21_600_000, contractSeats: 125, contractSla: sla });
    expect((await sam.agent.get(`/ops/accounts/${id}`)).body.contractValue).toBeNull();
    expect((await fin.agent.put(`/ops/accounts/${id}/contract`).send({ start: '2027-01-01', end: '2026-01-01', value: null, seats: null, sla: null })).status).toBe(400);
    const tk = (await sam.agent.post('/ops/tickets').send({ workspaceId: a.id, requesterEmail: 'owner@acct-a.example.com', channel: 'email', subject: 'LINE หาย', body: 'แจ้งเตือนไม่มา', notify: false })).body.ticket;
    const detail = (await sam.agent.get(`/ops/tickets/${tk.id}`)).body;
    expect(detail.customer).toMatchObject({ slaSource: 'contract', sla, account: { id, name: 'บจก. สยามสมมติ', kind: 'enterprise', managerName: 'Sam Support', workspaces: 3, openTickets: 1 } });
    expect((await sam.agent.get(`/ops/tickets?account=${id}`)).body.total).toBe(1);
  });

  it('ไฟล์สัญญา PDF · วันต่อสัญญาเรียงใกล้หมดก่อน · เตือนผู้ดูแลครั้งเดียวต่อขั้น', async () => {
    expect((await fin.agent.put(`/ops/accounts/${id}/contract-file`).set('Content-Type', 'application/pdf').send(Buffer.from('not a pdf'))).body.error.code).toBe('file_not_pdf');
    await fin.agent.put(`/ops/accounts/${id}/contract-file`).set('Content-Type', 'application/pdf').set('X-File-Name', encodeURIComponent('สัญญา 2569.pdf')).send(PDF).expect(200);
    const f = await fin.agent.get(`/ops/accounts/${id}/contract-file`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (x: Buffer) => chunks.push(x)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(Buffer.compare(f.body as Buffer, PDF)).toBe(0);
    expect((await sam.agent.get(`/ops/accounts/${id}/contract-file`)).status).toBe(403);
    expect((await fin.agent.get(`/ops/accounts/${id}`)).body.file).toMatchObject({ name: 'สัญญา 2569.pdf', size: PDF.length });
    const ren = (await fin.agent.get('/ops/renewals?within=90')).body;
    expect(ren.items).toEqual([expect.objectContaining({ id, daysLeft: 45, contractValue: 21_600_000 })]);
    expect((await fin.agent.get('/ops/renewals?within=30')).body.total).toBe(0);
    const mail = t.app.get(Mailer);
    const svc = t.app.get(AccountsService);
    const before = mail.sent.length;
    expect((await svc.remindRenewals()).sent).toBe(1);
    expect(mail.sent.slice(before)).toEqual([expect.objectContaining({ to: 'sam@friday.example.com', subject: expect.stringContaining('จะหมดใน 45 วัน') })]);
    expect((await svc.remindRenewals()).sent).toBe(0);
    // อีก 20 วันถึงขั้น 30 วัน = เตือนอีกครั้ง
    const later = new Date(Date.now() + 20 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
    expect((await svc.remindRenewals(later)).sent).toBe(1);
  });

  it('เอา Workspace ออก · ลบบัญชีได้เฉพาะ Owner (Workspace ไม่ถูกแตะ) · มีรอยใน audit', async () => {
    await sam.agent.delete(`/ops/accounts/${id}/workspaces/${c.id}`).expect(200);
    expect((await sam.agent.get(`/ops/accounts/${id}`)).body.numbers.workspaces).toBe(2);
    expect((await sam.agent.delete(`/ops/accounts/${id}`)).status).toBe(403);
    await boss.agent.delete(`/ops/accounts/${id}`).expect(200);
    expect((await boss.agent.get(`/ops/workspaces?q=acct-a`)).body.items[0].account).toBeNull();
    const log = await t.owner.query(`SELECT action FROM staff_audit_logs WHERE target_type = 'customer_account' ORDER BY created_at`);
    expect(log.rows.map((x) => x.action)).toEqual(['account.created', 'account.linked', 'account.contract', 'account.contract_file', 'account.unlinked', 'account.deleted']);
  });
});
