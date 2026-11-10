// O25 · Friday Ops บนมือถือ + Web Push · ข้อมูลสมมติเท่านั้น
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/mail.js';
import { MobileService } from '../src/mobile/mobile.service.js';
import { PushService } from '../src/push/push.service.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let push: PushService;
let owner: Staff;
let finance: Staff;
let engineer: Staff;
let support: Staff;
let c: Customer;
const delivered: { endpoint: string; payload: Record<string, unknown> }[] = [];
let gone = new Set<string>();

/** กุญแจเบราว์เซอร์สมมติ (P-256) */
const browserKeys = () => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
};
const subscribe = (who: Staff, endpoint: string) => who.agent.post('/ops/push/subscriptions').send({ endpoint, keys: browserKeys(), userAgent: 'iPhone Safari (ทดสอบ)' });

async function exception(reason: string, minutesAgo: number, amount = 321_000) {
  const inv = (await t.owner.query(
    `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, wht_amount, amount_due, status, due_date)
     VALUES ($1,$2,$3,current_date,current_date + 29,300000,21000,321000,0,321000,'open',current_date + 7) RETURNING id`,
    [c.id, c.sub, `FRI-M-${randomUUID().slice(0, 6)}`],
  )).rows[0].id;
  return (await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, exception_reason, slip_file_key, updated_at) VALUES ($1,$2,'transfer',$3,$4,'slips/x.png', now() - make_interval(mins => $5)) RETURNING id`, [c.id, inv, amount, reason, minutesAgo])).rows[0].id as string;
}

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  push = t.app.get(PushService);
  // แทนการส่งจริงไปยัง FCM / APNs · endpoint ใน `gone` ตอบ 410 (เครื่องยกเลิกแล้ว)
  push.sender = async (sub, payload) => {
    if (gone.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    delivered.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201, body: '', headers: {} };
  };
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', ['owner']);
  finance = await staff(t, 'fin@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  support = await staff(t, 'sup@friday.example.com', 'Sam Support', 'support');
  c = await customer(t, 'mobile-demo', { status: 'active' });
});
afterAll(() => t.close());

describe('Web Push', () => {
  it('สมัคร / ยกเลิกของตัวเอง · มีกุญแจ VAPID (dev) · Audit · ปลายทาง 410 ลบทิ้ง', async () => {
    const st = await owner.agent.get('/ops/push');
    expect(st.body).toMatchObject({ enabled: true, publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{80,}$/), devices: 0 });
    expect((await subscribe(owner, 'https://push.example.com/owner-phone')).body.devices).toBe(1);
    // เครื่องเดิมสมัครซ้ำ = แถวเดิม
    expect((await subscribe(owner, 'https://push.example.com/owner-phone')).body.devices).toBe(1);
    expect((await owner.agent.post('/ops/push/subscriptions').send({ endpoint: 'not-a-url', keys: browserKeys() })).status).toBe(400);
    await subscribe(finance, 'https://push.example.com/fin-phone');
    await subscribe(engineer, 'https://push.example.com/eng-phone');
    await subscribe(support, 'https://push.example.com/sup-phone');

    expect((await owner.agent.post('/ops/push/test').send({})).body).toEqual({ devices: 1 });
    expect(delivered.at(-1)).toMatchObject({ endpoint: 'https://push.example.com/owner-phone', payload: { title: 'Friday Ops', url: '/m' } });

    gone = new Set(['https://push.example.com/sup-phone']);
    expect((await support.agent.post('/ops/push/test').send({})).body).toEqual({ devices: 0 });
    expect((await support.agent.get('/ops/push')).body.devices).toBe(0);
    gone = new Set();
    await subscribe(support, 'https://push.example.com/sup-phone');

    await engineer.agent.post('/ops/push/subscriptions/remove').send({ endpoint: 'https://push.example.com/eng-phone' });
    expect((await engineer.agent.get('/ops/push')).body.devices).toBe(0);
    await subscribe(engineer, 'https://push.example.com/eng-phone');
    const a = await t.owner.query(`SELECT action FROM staff_audit_logs WHERE action LIKE 'push.%'`);
    expect(a.rows.filter((r) => r.action === 'push.unsubscribed')).toHaveLength(1);
  });
});

describe('M6.1 อนุมัติ', () => {
  let id = '';
  it('คำขอใหม่ → แจ้ง Owner ในมือถือ · รายการพร้อมข้อมูลลูกค้า · เฉพาะ Owner', async () => {
    const before = delivered.length;
    const r = await finance.agent.post(`/ops/workspaces/${c.id}:discount`).send({ percent: 35, months: 12, reason: 'ต่อสัญญารายปี ลูกค้าเทียบราคา' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    id = r.body.pendingApproval.id;
    expect(delivered.slice(before)).toEqual([{ endpoint: 'https://push.example.com/owner-phone', payload: expect.objectContaining({ title: 'รออนุมัติ', url: `/m/approvals?id=${id}` }) }]);

    const m = await owner.agent.get('/ops/m/approvals');
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.items[0]).toMatchObject({ id, requesterName: 'Fin Finance', reason: 'ต่อสัญญารายปี ลูกค้าเทียบราคา', rule: expect.any(String), summary: { kind: 'discount', percent: 35, months: 12 }, workspace: { name: 'Co mobile-demo', paidInvoices: 0, refunds: 0 } });
    expect(m.body.decidedToday).toEqual([]);
    expect((await finance.agent.get('/ops/m/approvals')).status).toBe(403);
  });

  it('อนุมัติต้องแตะกุญแจ · แจ้งผู้ขอทางอีเมล + มือถือ · ขึ้นใน "ตัดสินแล้ววันนี้"', async () => {
    expect((await owner.agent.post(`/ops/approvals/${id}:approve`).send({})).body.error.code).toBe('reauth_required');
    await reauth(owner);
    const before = { mail: mail.sent.length, push: delivered.length };
    expect((await owner.agent.post(`/ops/approvals/${id}:approve`).send({})).status).toBe(200);
    expect(mail.sent.slice(before.mail).map((x) => [x.to, x.subject])).toEqual([['fin@friday.example.com', '[Friday Ops] อนุมัติแล้ว: workspace.discount']]);
    expect(delivered.slice(before.push)).toEqual([{ endpoint: 'https://push.example.com/fin-phone', payload: expect.objectContaining({ title: 'อนุมัติแล้ว' }) }]);
    const m = (await owner.agent.get('/ops/m/approvals')).body;
    expect(m.items).toEqual([]);
    expect(m.decidedToday).toEqual([expect.objectContaining({ id, status: 'approved', workspace: 'Co mobile-demo', summary: { kind: 'discount', percent: 35, months: 12 } })]);
  });
});

describe('M6.2 เหตุขัดข้อง', () => {
  it('เปิดเหตุ → แจ้งวิศวกร / Support / Owner ในมือถือ ยกเว้นคนเปิด', async () => {
    const before = delivered.length;
    const r = await engineer.agent.post('/ops/incidents').send({ title: 'นำเข้า Excel ช้ากว่าปกติ', impact: 'partial', services: ['import_export'], message: 'กำลังตรวจสอบสาเหตุ' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = delivered.slice(before);
    expect(got.map((d) => d.endpoint).sort()).toEqual(['https://push.example.com/owner-phone', 'https://push.example.com/sup-phone']);
    expect(got[0].payload).toMatchObject({ title: 'เหตุขัดข้อง · นำเข้า Excel ช้ากว่าปกติ', url: `/m/incidents?id=${r.body.incident.id}` });
  });
});

describe('M6.3 คิวชำระ', () => {
  it('เรียงตามเวลาที่เหลือ · บอกว่าทำบนมือถือได้ไหม · ใกล้ครบ SLA แจ้งการเงินครั้งเดียว · สิทธิ์', async () => {
    const dup = await exception('duplicate_slip', 10);
    const name = await exception('payer_name_mismatch', 60 * 24 * 3);
    const unmatched = await exception('unmatched', 30);
    await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, status, verified_by, reviewed_at) SELECT workspace_id, invoice_id, 'promptpay', 1000, 'confirmed', 'slip_api', now() FROM payments WHERE id = $1`, [dup]);
    const r = await finance.agent.get('/ops/m/payments');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.map((x: { id: string }) => x.id)).toEqual([name, expect.any(String), expect.any(String)]);
    const byId = Object.fromEntries(r.body.items.map((x: { id: string }) => [x.id, x]));
    expect(byId[name]).toMatchObject({ reason: 'payer_name_mismatch', nearSla: true, actions: { yes: 'confirm', no: 'reject' }, workspace: { name: 'Co mobile-demo' } });
    expect(byId[unmatched]).toMatchObject({ actions: { yes: null, no: null } });
    expect(byId[dup]).toMatchObject({ actions: { yes: 'confirm', no: 'reject' } });
    expect(r.body.stats).toMatchObject({ autoPct: 100, confirmedToday: 1, nearSla: 1 });
    expect(r.body.slaHours).toBe(4);
    expect((await support.agent.get('/ops/m/payments')).status).toBe(403);

    const svc = t.app.get(MobileService);
    const before = delivered.length;
    expect(await svc.tick()).toEqual({ sent: 1 });
    expect(delivered.slice(before)).toEqual([{ endpoint: 'https://push.example.com/fin-phone', payload: expect.objectContaining({ url: `/m/payments?id=${name}` }) }]);
    expect(await svc.tick()).toEqual({ sent: 0 });

    // ตัดสินบนมือถือด้วย endpoint เดิม
    const ok = await finance.agent.post(`/ops/payments/${name}:confirm`).send({ note: 'ยืนยันบนมือถือ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await finance.agent.get('/ops/m/payments')).body.items.map((x: { id: string }) => x.id)).not.toContain(name);
  });
});
