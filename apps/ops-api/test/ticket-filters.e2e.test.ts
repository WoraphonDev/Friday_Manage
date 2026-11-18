// ช่วง 3 · ตัวกรอง Ticket เพิ่ม · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let sam: Staff;
let sue: Staff;
let m: Customer;
let s: Customer;
const ids: Record<string, string> = {};
type Row = { id: string; subject: string };
const subjects = async (q: string) => ((await sam.agent.get(`/ops/tickets?status=active&limit=50${q}`)).body.items as Row[]).map((x) => x.subject).sort();

beforeAll(async () => {
  t = await startOps();
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  sue = await staff(t, 'sue@friday.example.com', 'Sue Support', 'support');
  m = await customer(t, 'filter-m', { plan: 'team_m', status: 'active' });
  s = await customer(t, 'filter-s', { plan: 'team_s', status: 'trialing' });
  const make = async (key: string, ws: Customer, over: Record<string, unknown>) => {
    const r = await sam.agent.post('/ops/tickets').send({ workspaceId: ws.id, requesterEmail: `owner@${ws.slug}.example.com`, channel: 'email', subject: key, body: `รายละเอียดของ ${key}`, notify: false, ...over });
    ids[key] = r.body.ticket.id;
  };
  await make('line-urgent', m, { category: 'notification', priority: 'urgent', channel: 'line' });
  await make('import-normal', s, { category: 'import', priority: 'normal' });
  await make('billing-low', s, { category: 'billing', priority: 'low', channel: 'phone' });
  // ตั้งผู้รับตรง ๆ (กฎแจกงานอัตโนมัติอาจรับไปก่อน)
  await t.owner.query(`UPDATE support_tickets SET assignee_id = CASE WHEN id = $1 THEN $2::uuid ELSE NULL END WHERE id = ANY($3)`, [ids['import-normal'], sue.id, Object.values(ids)]);
  await sam.agent.post(`/ops/tickets/${ids['billing-low']}/messages`).send({ body: 'ลูกค้าแนบ requestId req_abc123 มา', internal: true }).expect(201);
});
afterAll(() => t.close());

describe('ตัวกรอง Ticket (ช่วง 3)', () => {
  it('ผู้รับ · ความสำคัญ · หมวด · ช่องทาง · แพ็กเกจลูกค้า · ค้นในบทสนทนา · เงียบนาน · SLA · เหตุขัดข้อง · การเรียง', async () => {
    expect(await subjects(`&assignees=${sue.id}`)).toEqual(['import-normal']);
    expect(await subjects('&priority=urgent,low')).toEqual(['billing-low', 'line-urgent']);
    expect(await subjects('&category=import,billing')).toEqual(['billing-low', 'import-normal']);
    expect(await subjects('&channel=line')).toEqual(['line-urgent']);
    expect(await subjects('&plan=team_m')).toEqual(['line-urgent']);
    expect(await subjects('&q=req_abc123')).toEqual(['billing-low']);
    await t.owner.query(`UPDATE support_tickets SET updated_at = now() - interval '4 days' WHERE id = $1`, [ids['line-urgent']]);
    expect(await subjects('&quiet=72')).toEqual(['line-urgent']);
    await t.owner.query(`UPDATE support_tickets SET first_response_due_at = now() - interval '1 minute' WHERE id = $1`, [ids['import-normal']]);
    expect(await subjects('&sla=breached')).toEqual(['import-normal']);
    const inc = (await t.owner.query(`INSERT INTO incidents (title) VALUES ('LINE ล่าช้า') RETURNING id`)).rows[0].id;
    await t.owner.query(`INSERT INTO support_ticket_incidents (ticket_id, incident_id) VALUES ($1, $2)`, [ids['line-urgent'], inc]);
    expect(await subjects(`&incident=${inc}`)).toEqual(['line-urgent']);
    expect(await subjects('&incident=none')).toEqual(['billing-low', 'import-normal']);
    const byPriority = (await sam.agent.get('/ops/tickets?status=active&sort=priority')).body.items.map((x: Row) => x.subject);
    expect(byPriority).toEqual(['line-urgent', 'import-normal', 'billing-low']);
    const waiting = (await sam.agent.get('/ops/tickets?status=active&sort=waiting')).body.items.map((x: Row) => x.subject);
    expect(waiting[0]).toBe('line-urgent');
    expect((await sam.agent.get('/ops/tickets?priority=nope')).status).toBe(400);
  });
});

describe('ตัวกรองหน้าอื่น (ช่วง 3) · ตอบได้และกรองจริง', () => {
  it('ผู้ใช้ · ค้างชำระ · ใบแจ้งหนี้ · PDPA · ประวัติการส่ง', async () => {
    const ok = async (path: string) => {
      const r = await sam.agent.get(path);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
      return r.body;
    };
    expect((await ok('/ops/users?activity=never&mfa=off&login=password&lang=th&multi=yes')).items).toEqual([]);
    expect((await ok('/ops/users?line=unbound')).total).toBeGreaterThan(0);
    const fin = await staff(t, 'fin@friday.example.com', 'Fin', 'finance');
    await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date) VALUES ($1,$2,'FRI-F3-0001',current_date - 60,current_date - 30,300000,21000,321000,321000,'open',current_date - 40)`, [m.id, m.sub]);
    const r = (path: string) => fin.agent.get(path).then((x) => (expect(x.status, JSON.stringify(x.body)).toBe(200), x.body));
    expect((await r('/ops/overdue?age=31%2B&human=yes&contacted=no&plan=team_m')).total).toBe(1);
    expect((await r('/ops/overdue?age=1-7')).total).toBe(0);
    expect((await r('/ops/invoices?amountMin=300000&dueTo=2099-01-01')).total).toBe(1);
    expect((await r('/ops/invoices?wht=yes')).total).toBe(0);
    expect((await ok('/ops/privacy/requests?status=all&due=overdue&identity=unverified&hold=yes')).total).toBe(0);
    await ok('/ops/deliveries?from=2026-01-01&to=2099-01-01&event=issue.assigned');
  });
});
