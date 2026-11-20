// O41 · ลูกค้าเปลี่ยนแพ็กเกจเอง: อัปเกรดกลางรอบคิดส่วนต่าง · หักเครดิต · ลดแพ็กเกจมีผลรอบถัดไป · ข้อมูลสมมติเท่านั้น
import { createHmac, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let ws: string;
let wsId: string;
const csrf = new Map<Client, string>();
const profile = { companyName: 'บริษัท เปลี่ยนแพ็กเกจ จำกัด', taxId: '0105512340041', branchType: 'head', address: '41 ถนนสมมติ กรุงเทพฯ 10110', taxEmail: 'billing@plan-change.example.com', whtEnabled: false };
const post = (c: Client, url: string, body: object, idem?: string) => c.agent.post(`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!).set(idem ? { 'Idempotency-Key': idem } : {}).send(body);
const del = (c: Client, url: string) => c.agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf.get(c)!);
const key = () => `idem-${randomUUID()}`;
function pay(providerRef: string, invoiceId: string) {
  const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: providerRef, metadata: { invoice_id: invoiceId } } } });
  const ts = Math.floor(Date.now() / 1000);
  return supertest(t.app.getHttpServer()).post('/api/v1/hooks/stripe').set('content-type', 'application/json').set('stripe-signature', `t=${ts},v1=${createHmac('sha256', 'whsec_dev_fake').update(`${ts}.${raw}`).digest('hex')}`).send(raw);
}
const sub = async () => (await t.owner.query(`SELECT p.code, s.cycle, s.status, s.current_period_start AS start, s.current_period_end AS "end", s.pending_plan_id AS pending FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.workspace_id = $1`, [wsId])).rows[0];
/** แพ็กเกจที่จ่ายแล้วและยังอยู่ในรอบ (ผ่านไป 10 จาก 30 วัน) */
async function paidPeriod(plan: string) {
  await t.owner.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = $2), cycle = 'monthly', status = 'active', trial_ends_at = NULL, pending_plan_id = NULL, pending_cycle = NULL,
       current_period_start = date_trunc('day', now()) - interval '10 days', current_period_end = date_trunc('day', now()) + interval '20 days' WHERE workspace_id = $1`,
    [wsId, plan],
  );
}
const credits = async () => Number((await t.owner.query(`SELECT coalesce(sum(amount_satang),0)::int AS b FROM workspace_credits WHERE workspace_id = $1`, [wsId])).rows[0].b);

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'plan-change-demo' });
  ws = team.ws;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', ['plan-change-demo'])).rows[0].id;
  for (const c of [team.lead, team.dev]) csrf.set(c, ((await c.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken);
  await team.lead.get(`${ws}/billing`);
  expect((await team.lead.agent.put(`/api/v1${ws}/billing/profile`).set('x-csrf-token', csrf.get(team.lead)!).send(profile)).status).toBe(200);
});
afterAll(() => t.close());

describe('อัปเกรดกลางรอบ (R5)', () => {
  it('ใบส่วนต่างตามวันที่เหลือ · หักค่าแพ็กเกจเดิมที่ยังไม่ได้ใช้ · ชำระแล้วเปลี่ยนแพ็กเกจโดยรอบบิลเดิม', async () => {
    await paidPeriod('team_s');
    const before = await sub();
    const q = await team.lead.get(`${ws}/billing/quote?plan=team_m&cycle=monthly`);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.change).toMatchObject({ kind: 'upgrade', fromPlan: 'team_s', proration: { total: 30, left: 20 } });
    const p = q.body.change.proration;
    expect(p.diffSatang).toBe(p.newPartSatang - p.oldPartSatang);
    expect(q.body).toMatchObject({ subtotal: p.diffSatang, discount: 0, credit: { balanceSatang: 0, applySatang: 0 }, payNowSatang: q.body.amountDue });
    // คูปองใช้กับส่วนต่างไม่ได้
    expect((await team.lead.get(`${ws}/billing/quote?plan=team_m&cycle=monthly&coupon=WELCOME20`)).body.error.code).toBe('coupon_not_for_upgrade');

    const r = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_m', cycle: 'monthly', method: 'card' }, key());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.invoice.subtotal).toBe(p.diffSatang);
    const ref = (await t.owner.query(`SELECT provider_ref FROM payments WHERE invoice_id = $1`, [r.body.invoice.id])).rows[0].provider_ref;
    expect((await pay(ref, r.body.invoice.id)).status).toBe(200);
    const after = await sub();
    expect(after).toMatchObject({ code: 'team_m', status: 'active' });
    expect(after.start.getTime()).toBe(before.start.getTime());
    expect(after.end.getTime()).toBe(before.end.getTime());
  });
});

describe('หักเครดิต (R4 · R5)', () => {
  it('เครดิตไม่พอ: หักบางส่วนแล้วชำระส่วนที่เหลือ · ใบกำกับภาษีเต็มยอด', async () => {
    await paidPeriod('team_s');
    await t.owner.query(`INSERT INTO workspace_credits (workspace_id, amount_satang, source, note) VALUES ($1, 10000, 'goodwill', 'ทดสอบ')`, [wsId]);
    const q = await team.lead.get(`${ws}/billing/quote?plan=team_m&cycle=monthly`);
    expect(q.body.credit).toEqual({ balanceSatang: 10_000, applySatang: 10_000 });
    expect(q.body.payNowSatang).toBe(q.body.amountDue - 10_000);
    const r = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_m', cycle: 'monthly', method: 'promptpay' }, key());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.invoice.amountDue).toBe(q.body.amountDue - 10_000);
    expect(r.body.payment.amount).toBe(q.body.amountDue - 10_000);
    expect(await credits()).toBe(0);
    expect((await t.owner.query(`SELECT credit_applied::int AS c, total::int AS total FROM invoices WHERE id = $1`, [r.body.invoice.id])).rows[0]).toEqual({ c: 10_000, total: q.body.total });
  });

  it('เครดิตพอทั้งใบ: ชำระแล้วทันที เปิดแพ็กเกจ ออกใบกำกับภาษี ไม่ไปผู้ให้บริการรับชำระ', async () => {
    await paidPeriod('team_s');
    await t.owner.query(`INSERT INTO workspace_credits (workspace_id, amount_satang, source, note) VALUES ($1, 5000000, 'goodwill', 'ทดสอบ')`, [wsId]);
    const r = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_l', cycle: 'monthly', method: 'card' }, key());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ payment: null, free: true, invoice: { status: 'paid', amountDue: 0 } });
    expect((await sub()).code).toBe('team_l');
    expect((await t.owner.query(`SELECT doc_type FROM tax_documents WHERE invoice_id = $1`, [r.body.invoice.id])).rows).toEqual([{ doc_type: 'tax_invoice_receipt' }]);
    expect((await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'billing.payment_confirmed' AND target_id = $1`, [r.body.invoice.id])).rows[0].summary).toContain('ชำระด้วยเครดิต');
    expect((await team.lead.get(`${ws}/billing`)).body.creditSatang).toBe(5_000_000 - r.body.invoice.total);
  });
});

describe('ลดแพ็กเกจ / เปลี่ยนรอบมีผลรอบถัดไป (R6 · R7)', () => {
  it('checkout ลดแพ็กเกจ → 409 · ตั้งไว้ล่วงหน้าแล้วเห็นในหน้า Billing · ยกเลิกได้ · Member ทำไม่ได้', async () => {
    await paidPeriod('team_m');
    const q = await team.lead.get(`${ws}/billing/quote?plan=team_s&cycle=monthly`);
    expect(q.body.change).toMatchObject({ kind: 'next_cycle', reason: 'downgrade' });
    const no = await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_s', cycle: 'monthly', method: 'card' }, key());
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('change_next_cycle');
    expect((await post(team.lead, `${ws}/billing/checkout`, { plan: 'team_m', cycle: 'yearly', method: 'card' }, key())).body.error.details.reason).toBe('cycle');

    expect((await post(team.dev, `${ws}/billing/scheduled-change`, { plan: 'team_s', cycle: 'monthly' })).status).toBe(403);
    expect((await post(team.lead, `${ws}/billing/scheduled-change`, { plan: 'team_l', cycle: 'monthly' })).body.error.code).toBe('upgrade_now');
    const s = await post(team.lead, `${ws}/billing/scheduled-change`, { plan: 'team_s', cycle: 'monthly' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.pendingChange).toMatchObject({ plan: 'team_s', cycle: 'monthly', blockers: expect.any(Array) });
    expect((await sub()).pending).not.toBeNull();
    const o = await team.lead.get(`${ws}/billing`);
    expect(o.body.pendingChange).toMatchObject({ plan: 'team_s', cycle: 'monthly' });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'billing.change_scheduled'`, [wsId])).rows[0].n).toBe(1);

    expect((await del(team.lead, `${ws}/billing/scheduled-change`)).body).toEqual({ pendingChange: null });
    expect((await sub()).pending).toBeNull();
    expect((await team.lead.get(`${ws}/billing`)).body.pendingChange).toBeNull();
  });

  it('หน้า Billing บอกสิ่งที่ใช้เกิน Free ไว้ล่วงหน้า (ยกเลิกแพ็กเกจ = เป็น Free เมื่อจบรอบ)', async () => {
    await paidPeriod('team_s');
    expect((await team.lead.get(`${ws}/billing`)).body.freeBlockers).toEqual([]);
    // Free ได้ 3 โปรเจกต์ · มีแล้ว 1 สร้างเพิ่มอีก 3 = 4
    for (const k of ['FA', 'FB', 'FC']) expect((await post(team.lead, `${ws}/projects`, { name: `Free ${k}`, key: k, startDate: '2026-11-05', goliveDate: '2027-04-21' })).status).toBe(201);
    expect((await team.lead.get(`${ws}/billing`)).body.freeBlockers).toEqual([{ key: 'projects', used: 4, limit: 3 }]);
    await t.owner.query(`UPDATE projects SET archived_at = now() WHERE workspace_id = $1 AND key IN ('FA', 'FB', 'FC')`, [wsId]);
  });

  it('ลูกค้าเขียนเครดิตให้ตัวเองไม่ได้ (RLS: friday_app ใส่ได้เฉพาะแถว applied ที่ติดลบ)', async () => {
    const app = new (await import('pg')).default.Client({ connectionString: process.env.DATABASE_APP_URL ?? 'postgres://friday_api:friday_api_dev@localhost:54329/friday' });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)`, [wsId, team.leadId]);
      // แถวที่ checkout เขียนได้: applied ติดลบ ผูกใบแจ้งหนี้ของตัวเอง (ยืนยันว่าบริบทถูก ไม่ใช่ล้มเพราะเหตุอื่น)
      const inv = (await t.owner.query(`SELECT id FROM invoices WHERE workspace_id = $1 LIMIT 1`, [wsId])).rows[0].id;
      await app.query('SAVEPOINT ok');
      await app.query(`INSERT INTO workspace_credits (workspace_id, amount_satang, source, invoice_id) VALUES ($1, -1, 'applied', $2)`, [wsId, inv]);
      await app.query('ROLLBACK TO SAVEPOINT ok');
      // ให้เครดิตตัวเอง / แถวบวก / ไม่ผูกใบ → ปฏิเสธ
      for (const sql of [
        `INSERT INTO workspace_credits (workspace_id, amount_satang, source) VALUES ($1, 100000, 'goodwill')`,
        `INSERT INTO workspace_credits (workspace_id, amount_satang, source) VALUES ($1, -100, 'applied')`,
      ]) {
        await app.query('SAVEPOINT bad');
        await expect(app.query(sql, [wsId])).rejects.toThrow();
        await app.query('ROLLBACK TO SAVEPOINT bad');
      }
    } finally {
      await app.query('ROLLBACK').catch(() => undefined);
      await app.end();
    }
  });
});
