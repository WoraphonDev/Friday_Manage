// ต่อ Gateway จริง (A35b · Stripe): PromptPay QR, บัตร + 3-D Secure, ตัดบัตรตามรอบ, Webhook, กระทบยอด
// ไม่ออกเครือข่าย: StripeGateway (SDK ทางการ) คุยกับตัวจำลอง API ของ Stripe ในเครื่อง (รูปแบบคำขอ / คำตอบตามเอกสาร Stripe)
// และ Webhook เซ็นด้วย stripe.webhooks.generateTestHeaderString · ข้อมูลทั้งหมดเป็นข้อมูลสมมติ
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Mailer } from '../src/core/mail.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { CARD_ATTEMPT_DAYS, cardAttemptDue, nextAttemptOn } from '../src/payments/providers/card-retry.js';
import { GatewayJobs } from '../src/payments/providers/gateway-jobs.js';
import { FakeGateway, gatewayFromEnv, PAYMENT_GATEWAY, StripeGateway } from '../src/payments/providers.js';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

const DAY = 86_400_000;
const MIN = 60_000;

// ---------------------------------------------------------------------------
// ตัวจำลอง API ของ Stripe (เฉพาะ endpoint ที่ StripeGateway ใช้)
// ---------------------------------------------------------------------------

type Outcome = 'succeeded' | 'declined' | 'requires_action';
interface Intent {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  client_secret: string;
  created: number;
  customer: string | null;
  description: string | null;
  metadata: Record<string, string>;
  payment_method: string | null;
  payment_method_types: string[];
  setup_future_usage: string | null;
  payment_method_options: Record<string, unknown>;
  cancellation_reason: string | null;
  last_payment_error: { code: string; decline_code?: string } | null;
  next_action: unknown;
  livemode: false;
}
interface Req {
  method: string;
  path: string;
  body: Record<string, string>;
  idem: string | null;
  auth: string | null;
}

class StripeStub {
  readonly intents = new Map<string, Intent>();
  readonly customers = new Map<string, { id: string; object: 'customer'; email: string | null; metadata: Record<string, string> }>();
  readonly methods = new Map<string, { id: string; object: 'payment_method'; type: 'card'; customer: string; card: { brand: string; last4: string } }[]>();
  readonly requests: Req[] = [];
  /** ผลของการยืนยันบัตรครั้งถัดไป · ว่าง = สำเร็จ */
  readonly outcomes: Outcome[] = [];
  private readonly idem = new Map<string, { status: number; body: unknown }>();
  private seq = 0;
  server!: Server;

  async listen() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  calls(method: string, path: RegExp) {
    return this.requests.filter((r) => r.method === method && path.test(r.path));
  }
  /** ลูกค้าสแกนจ่าย / ยืนยันบัตรสำเร็จที่ Stripe (ยังไม่ส่ง Webhook) */
  pay(id: string) {
    const pi = this.intents.get(id)!;
    Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, next_action: null, payment_method: pi.customer ? this.methods.get(pi.customer)?.[0]?.id ?? 'pm_stub_card' : 'pm_stub_promptpay' });
    return pi;
  }
  /** รายการที่ไม่เกี่ยวกับระบบเรา (ขายผ่านช่องทางอื่น) ใช้ทดสอบการแบ่งหน้าของการกระทบยอด */
  addForeign(n: number) {
    for (let i = 0; i < n; i++) {
      const pi = this.newIntent({ amount: '10000', currency: 'thb' }, []);
      Object.assign(pi, { status: 'succeeded', amount_received: 10000 });
    }
  }

  private newIntent(b: Record<string, string>, types: string[]): Intent {
    const id = `pi_stub_${String(++this.seq).padStart(6, '0')}`;
    const metadata = Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
    const pi: Intent = {
      id, object: 'payment_intent', amount: Number(b.amount), amount_received: 0, currency: b.currency, status: 'requires_payment_method',
      client_secret: `${id}_secret_stub`, created: Math.floor(Date.now() / 1000), customer: b.customer ?? null, description: b.description ?? null, metadata,
      payment_method: null, payment_method_types: types, setup_future_usage: b.setup_future_usage ?? null,
      payment_method_options: b['payment_method_options[card][request_three_d_secure]'] ? { card: { request_three_d_secure: b['payment_method_options[card][request_three_d_secure]'] } } : {},
      cancellation_reason: null, last_payment_error: null, next_action: null, livemode: false,
    };
    this.intents.set(id, pi);
    return pi;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://stub');
    const body = Object.fromEntries(new URLSearchParams(req.method === 'GET' ? url.search : Buffer.concat(chunks).toString('utf8')));
    const idem = (req.headers['idempotency-key'] as string | undefined) ?? null;
    this.requests.push({ method: req.method!, path: url.pathname, body, idem, auth: req.headers.authorization ?? null });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_${this.seq}` });
      res.end(JSON.stringify(json));
    };
    // Idempotency-Key เดิม = คำตอบเดิม (เหมือน Stripe ภายใน 24 ชม.)
    const cacheKey = idem && req.method === 'POST' ? `${url.pathname}:${idem}` : null;
    if (cacheKey && this.idem.has(cacheKey)) {
      const hit = this.idem.get(cacheKey)!;
      return send(hit.status, hit.body);
    }
    const reply = (status: number, json: unknown) => {
      if (cacheKey) this.idem.set(cacheKey, { status, body: structuredClone(json) });
      send(status, json);
    };
    const missing = () => reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } });
    const p = url.pathname;
    let m: RegExpExecArray | null;

    if (req.method === 'POST' && p === '/v1/customers') {
      const id = `cus_stub_${String(++this.seq).padStart(6, '0')}`;
      const metadata = Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
      this.customers.set(id, { id, object: 'customer', email: body.email ?? null, metadata });
      // บัตรที่ลูกค้ากรอกใน Stripe.js ถูกผูกกับ Customer หลังยืนยัน (setup_future_usage) · ตัวจำลองผูกไว้เลย
      this.methods.set(id, [{ id: `pm_stub_${this.seq}`, object: 'payment_method', type: 'card', customer: id, card: { brand: 'visa', last4: '4242' } }]);
      return reply(200, this.customers.get(id));
    }
    if (req.method === 'GET' && (m = /^\/v1\/customers\/([^/]+)\/payment_methods$/.exec(p))) {
      return reply(200, { object: 'list', url: p, has_more: false, data: this.methods.get(m[1]) ?? [] });
    }
    if (req.method === 'POST' && p === '/v1/payment_intents') {
      const types = Object.entries(body).filter(([k]) => k.startsWith('allowed_payment_method_types[')).map(([, v]) => v);
      const pi = this.newIntent(body, types);
      if (types.includes('promptpay') && body.confirm === 'true') {
        pi.status = 'requires_action';
        pi.next_action = { type: 'promptpay_display_qr_code', promptpay_display_qr_code: { data: `00020101021230570016A00000067701011201150107536000315080214STUB${pi.amount}5303764${pi.id}`, hosted_instructions_url: 'https://example.com/qr', image_url_png: 'https://example.com/qr.png', image_url_svg: 'https://example.com/qr.svg' } };
      }
      return reply(200, pi);
    }
    if (req.method === 'GET' && p === '/v1/payment_intents') {
      const gte = Number(body['created[gte]'] ?? 0);
      const all = [...this.intents.values()].filter((x) => x.created >= gte).reverse();
      const start = body.starting_after ? all.findIndex((x) => x.id === body.starting_after) + 1 : 0;
      const limit = Number(body.limit ?? 10);
      return reply(200, { object: 'list', url: p, has_more: start + limit < all.length, data: all.slice(start, start + limit) });
    }
    if ((m = /^\/v1\/payment_intents\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const pi = this.intents.get(m[1]);
      return pi ? reply(200, pi) : missing();
    }
    if (req.method === 'POST' && (m = /^\/v1\/payment_intents\/([^/]+)\/confirm$/.exec(p))) {
      const pi = this.intents.get(m[1]);
      if (!pi) return missing();
      pi.payment_method = body.payment_method ?? null;
      const outcome = this.outcomes.shift() ?? 'succeeded';
      if (outcome === 'succeeded') {
        Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, last_payment_error: null });
        return reply(200, pi);
      }
      if (outcome === 'declined') {
        Object.assign(pi, { status: 'requires_payment_method', last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } });
        return reply(402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.', payment_intent: pi } });
      }
      Object.assign(pi, { status: 'requires_action', next_action: { type: 'use_stripe_sdk' } });
      return reply(402, { error: { type: 'card_error', code: 'authentication_required', message: 'Your card was declined. This transaction requires authentication.', payment_intent: pi } });
    }
    if (req.method === 'POST' && (m = /^\/v1\/payment_intents\/([^/]+)\/cancel$/.exec(p))) {
      const pi = this.intents.get(m[1]);
      if (!pi) return missing();
      if (pi.status === 'succeeded' || pi.status === 'canceled') return reply(400, { error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: `This PaymentIntent's status is ${pi.status}.` } });
      Object.assign(pi, { status: 'canceled', cancellation_reason: body.cancellation_reason ?? null, next_action: null });
      return reply(200, pi);
    }
    reply(404, { error: { type: 'invalid_request_error', message: `stub: ไม่รองรับ ${req.method} ${p}` } });
  }
}

// ---------------------------------------------------------------------------

const stub = new StripeStub();
const WEBHOOK_SECRET = `whsec_test_${randomBytes(16).toString('hex')}`;
const SECRET_KEY = 'sk_test_local_stub_only';
const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_URL'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const sdk = new Stripe('sk_test_signing_only');

let t: TestApp;
let jobs: GatewayJobs;
let payments: PaymentsService;
const mail: { to: string; subject: string; text?: string }[] = [];
const csrf = new Map<Client, string>();
const profile = { companyName: 'บริษัท ทดสอบเกตเวย์ จำกัด', taxId: '0105599999999', branchType: 'head', address: '9 ถนนสมมติ กรุงเทพฯ 10110', taxEmail: 'billing@example.com', whtEnabled: false };

async function workspace(slug: string) {
  const team = await seedTeam(t, { slug });
  csrf.set(team.lead, ((await team.lead.agent.get('/api/v1/auth/csrf')).body as { csrfToken: string }).csrfToken);
  const wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [slug])).rows[0].id as string;
  await team.lead.get(`${team.ws}/billing`);
  expect((await team.lead.agent.put(`/api/v1${team.ws}/billing/profile`).set('x-csrf-token', csrf.get(team.lead)!).send(profile)).status).toBe(200);
  return { lead: team.lead, ws: team.ws, wsId, slug };
}
type W = Awaited<ReturnType<typeof workspace>>;
const post = (w: W, url: string, body: object, key?: string) => {
  const r = w.lead.agent.post(`/api/v1${w.ws}${url}`).set('x-csrf-token', csrf.get(w.lead)!);
  return (key ? r.set('Idempotency-Key', key) : r).send(body);
};
async function checkout(w: W, method: 'card' | 'promptpay', key = `idem-${randomUUID()}`) {
  const r = await post(w, '/billing/checkout', { plan: 'team_m', cycle: 'monthly', method }, key);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const [p] = await rows(r.body.invoice.id);
  return { body: r.body, invoice: r.body.invoice as { id: string; number: string; amountDue: number }, ref: p.provider_ref as string, key };
}
const rows = async (invoiceId: string) => (await t.owner.query('SELECT id, status, exception_reason, provider_ref, method, amount FROM payments WHERE invoice_id = $1 ORDER BY created_at', [invoiceId])).rows;
const invoiceRow = async (id: string) => (await t.owner.query('SELECT status, period_start::text AS start, amount_due FROM invoices WHERE id = $1', [id])).rows[0];
const sub = async (wsId: string) => (await t.owner.query('SELECT status, payment_method, stripe_customer_id, current_period_end FROM subscriptions WHERE workspace_id = $1', [wsId])).rows[0];
const auditCount = async (invoiceId: string, action: string) => Number((await t.owner.query('SELECT count(*) FROM audit_logs WHERE target_id = $1 AND action = $2', [invoiceId, action])).rows[0].count);
const taxDocs = async (invoiceId: string) => Number((await t.owner.query('SELECT count(*) FROM tax_documents WHERE invoice_id = $1', [invoiceId])).rows[0].count);

/** เหตุการณ์ตามรูปแบบ Stripe (snapshot event) · object = PaymentIntent ปัจจุบันของตัวจำลอง */
const event = (type: string, ref: string, id = `evt_${randomUUID().replace(/-/g, '')}`) => ({ id, object: 'event', api_version: '2026-01-28', created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object: structuredClone(stub.intents.get(ref)) } });
function hook(payload: string, header: string | undefined) {
  const r = supertest(t.app.getHttpServer()).post('/api/v1/hooks/stripe').set('content-type', 'application/json');
  return (header ? r.set('stripe-signature', header) : r).send(payload);
}
const signed = (e: object, opts: { secret?: string; timestamp?: number } = {}) => {
  const payload = JSON.stringify(e);
  return hook(payload, sdk.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WEBHOOK_SECRET, ...(opts.timestamp ? { timestamp: opts.timestamp } : {}) }));
};

/** Workspace ที่จ่ายรอบแรกด้วยบัตรแล้ว (มีบัตรเก็บไว้) · รอบบิลจบแล้วพร้อมตัดรอบใหม่ */
async function cardCustomer(slug: string) {
  const w = await workspace(slug);
  const first = await checkout(w, 'card');
  stub.pay(first.ref);
  expect((await signed(event('payment_intent.succeeded', first.ref))).body).toEqual({ received: true });
  const s = await sub(w.wsId);
  expect(s).toMatchObject({ status: 'active', payment_method: 'card' });
  await t.owner.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE workspace_id = $1`, [w.wsId]);
  return { ...w, customer: s.stripe_customer_id as string };
}
async function renewalInvoice(wsId: string) {
  const r = (await t.owner.query(`SELECT target_id FROM audit_logs WHERE workspace_id = $1 AND action = 'billing.card_renewal_invoice' ORDER BY created_at DESC LIMIT 1`, [wsId])).rows[0];
  const invoiceId = r.target_id as string;
  const [p] = await rows(invoiceId);
  return { invoiceId, ref: p.provider_ref as string };
}

beforeAll(async () => {
  const apiUrl = await stub.listen();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_SECRET_KEY = SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_API_URL = apiUrl;
  t = await startApp();
  jobs = t.app.get(GatewayJobs);
  payments = t.app.get(PaymentsService);
  vi.spyOn(t.app.get(Mailer), 'send').mockImplementation(async (m) => void mail.push(m));
});
afterAll(async () => {
  await t?.close();
  await stub.close();
  for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
});

describe('ตั้งค่าผ่าน environment', () => {
  it('มี STRIPE_SECRET_KEY = Stripe จริง · ต้องมี STRIPE_WEBHOOK_SECRET คู่กัน · STRIPE_API_URL ห้ามใช้ใน production', () => {
    expect(t.app.get(PAYMENT_GATEWAY)).toBeInstanceOf(StripeGateway);
    expect(gatewayFromEnv({})).toBeInstanceOf(FakeGateway);
    expect(gatewayFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toBeInstanceOf(StripeGateway);
    expect(() => gatewayFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => gatewayFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_API_URL: 'http://127.0.0.1:1', NODE_ENV: 'production' })).toThrow(/STRIPE_API_URL/);
  });

  it('ตารางลองตัดบัตร: วันที่ 0 แล้วลองใหม่วันที่ 1, 3, 5', () => {
    expect(CARD_ATTEMPT_DAYS).toEqual([0, 1, 3, 5]);
    expect(cardAttemptDue(0, 0)).toEqual({ due: true, attempt: 1, final: false });
    expect(cardAttemptDue(1, 0)?.due).toBe(false);
    expect(cardAttemptDue(1, 1)?.due).toBe(true);
    expect(cardAttemptDue(2, 2)?.due).toBe(false);
    expect(cardAttemptDue(3, 5)).toEqual({ due: true, attempt: 4, final: true });
    expect(cardAttemptDue(4, 9)).toBeNull();
    expect(nextAttemptOn('2026-12-01', 1)).toBe('2026-12-02');
    expect(nextAttemptOn('2026-12-01', 2)).toBe('2026-12-04');
    expect(nextAttemptOn('2026-12-31', 3)).toBe('2027-01-05');
    expect(nextAttemptOn('2026-12-01', 4)).toBeNull();
  });
});

describe('PromptPay', () => {
  it('QR ผูกยอดและใบแจ้งหนี้ · หมดอายุ 15 นาทีนับจากสร้าง · ส่งซ้ำด้วย key เดิมได้รายการเดิม', async () => {
    const w = await workspace('gw-qr');
    const before = stub.calls('POST', /^\/v1\/payment_intents$/).length;
    const c = await checkout(w, 'promptpay');
    const [create] = stub.calls('POST', /^\/v1\/payment_intents$/).slice(before);
    expect(create.auth).toBe(`Bearer ${SECRET_KEY}`);
    expect(create.idem).toMatch(/^[0-9a-f]{64}$/);
    expect(create.body).toMatchObject({ amount: String(c.invoice.amountDue), currency: 'thb', confirm: 'true', 'allowed_payment_method_types[0]': 'promptpay', 'metadata[invoice_id]': c.invoice.id, 'metadata[invoice_number]': c.invoice.number, 'payment_method_data[type]': 'promptpay' });
    const pi = stub.intents.get(c.ref)!;
    expect(c.body.promptpay.qrPayload).toBe((pi.next_action as { promptpay_display_qr_code: { data: string } }).promptpay_display_qr_code.data);
    expect(new Date(c.body.promptpay.expiresAt).getTime()).toBe(pi.created * 1000 + 15 * MIN);

    // ส่งซ้ำ: ไม่สร้างรายการใหม่ (ดึงรายการเดิมด้วยเลขอ้างอิง) · QR เดิม เวลาหมดอายุเดิม
    const again = await post(w, '/billing/checkout', { plan: 'team_m', cycle: 'monthly', method: 'promptpay' }, c.key);
    expect(again.body).toMatchObject({ replayed: true, invoice: { id: c.invoice.id }, promptpay: { qrPayload: c.body.promptpay.qrPayload, expiresAt: c.body.promptpay.expiresAt } });
    expect(stub.calls('POST', /^\/v1\/payment_intents$/).length).toBe(before + 1);
  });

  it('QR ครบ 15 นาที: ปิดที่ Stripe (abandoned) · ใบยังเปิด · Webhook ยกเลิกที่ตามมาไม่ void ใบ · สร้าง QR ใหม่ได้', async () => {
    const w = await workspace('gw-expire');
    const c = await checkout(w, 'promptpay');
    expect(await jobs.expireQrs(new Date(Date.now() + 5 * MIN))).toMatchObject({ expired: 0 });
    expect(stub.intents.get(c.ref)!.status).toBe('requires_action');

    const r = await jobs.expireQrs(new Date(Date.now() + 16 * MIN));
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(stub.intents.get(c.ref)).toMatchObject({ status: 'canceled', cancellation_reason: 'abandoned' });
    expect((await rows(c.invoice.id))[0].status).toBe('rejected');
    expect(await auditCount(c.invoice.id, 'billing.qr_expired')).toBe(1);

    expect((await signed(event('payment_intent.canceled', c.ref))).body).toEqual({ received: true, duplicate: true });
    expect((await invoiceRow(c.invoice.id)).status).toBe('open');
    expect(await auditCount(c.invoice.id, 'billing.qr_expired')).toBe(1);

    const renew = await post(w, `/billing/invoices/${c.invoice.id}/pay`, { renew: true });
    expect(renew.status, JSON.stringify(renew.body)).toBe(200);
    const [p] = await rows(c.invoice.id);
    expect(p.provider_ref).not.toBe(c.ref);
    expect(p.status).toBe('pending_review');
    expect(renew.body.promptpay.qrPayload).toContain(p.provider_ref);
  });

  it('จ่ายอีกครั้ง (สร้าง QR ใหม่): ปิด QR เดิม · QR เดิมยังจ่ายเข้ามาหลังใบชำระแล้ว = เข้าคิวจ่ายซ้ำ ไม่ออกเอกสารซ้ำ', async () => {
    const w = await workspace('gw-double');
    const c = await checkout(w, 'promptpay');
    const renew = await post(w, `/billing/invoices/${c.invoice.id}/pay`, { renew: true });
    expect(renew.status).toBe(200);
    const fresh = (await rows(c.invoice.id))[0].provider_ref as string;
    expect(fresh).not.toBe(c.ref);
    expect(stub.intents.get(c.ref)).toMatchObject({ status: 'canceled', cancellation_reason: 'duplicate' });
    // Webhook ยกเลิกของ QR เดิม: ไม่ใช่รายการปัจจุบันแล้ว ไม่กระทบใบ
    expect((await signed(event('payment_intent.canceled', c.ref))).body).toMatchObject({ received: true });
    expect((await invoiceRow(c.invoice.id)).status).toBe('open');

    stub.pay(fresh);
    expect((await signed(event('payment_intent.succeeded', fresh))).body).toEqual({ received: true });
    expect((await invoiceRow(c.invoice.id)).status).toBe('paid');

    // ลูกค้าสแกน QR เดิมทันก่อนถูกปิด (Stripe รับเงินแล้ว) → บันทึกเป็นรายการของใบเดิม และเข้าคิวกรณีผิดปกติ "จ่ายซ้ำ"
    Object.assign(stub.intents.get(c.ref)!, { status: 'succeeded', amount_received: c.invoice.amountDue, cancellation_reason: null });
    expect((await signed(event('payment_intent.succeeded', c.ref))).body).toEqual({ received: true, exception: 'double_payment' });
    const all = await rows(c.invoice.id);
    expect(all).toHaveLength(2);
    expect(all.find((x) => x.provider_ref === c.ref)).toMatchObject({ status: 'pending_review', exception_reason: 'double_payment', amount: String(c.invoice.amountDue) });
    expect(await auditCount(c.invoice.id, 'billing.payment_adopted')).toBe(1);
    expect(await taxDocs(c.invoice.id)).toBe(1);
    // Webhook เดิมซ้ำ: ไม่สร้างรายการเพิ่ม
    expect((await signed(event('payment_intent.succeeded', c.ref))).body).toEqual({ received: true, exception: 'double_payment' });
    expect(await rows(c.invoice.id)).toHaveLength(2);
  });

  it('QR เดิมจ่ายเข้ามาขณะใบยังเปิด: ปิดใบด้วยรายการนั้น และปิด QR ปัจจุบันที่ Stripe', async () => {
    const w = await workspace('gw-old-qr');
    const c = await checkout(w, 'promptpay');
    await post(w, `/billing/invoices/${c.invoice.id}/pay`, { renew: true });
    const current = (await rows(c.invoice.id))[0].provider_ref as string;
    Object.assign(stub.intents.get(c.ref)!, { status: 'succeeded', amount_received: c.invoice.amountDue, cancellation_reason: null });
    expect((await signed(event('payment_intent.succeeded', c.ref))).body).toEqual({ received: true });
    expect((await invoiceRow(c.invoice.id)).status).toBe('paid');
    expect(stub.intents.get(current)).toMatchObject({ status: 'canceled', cancellation_reason: 'duplicate' });
    expect(await taxDocs(c.invoice.id)).toBe(1);
  });
});

describe('Webhook', () => {
  it('ตรวจลายเซ็นก่อนเขียนฐานข้อมูล: ไม่มี / secret ผิด / เนื้อหาถูกแก้ / เก่าเกิน 5 นาที → 400 และไม่เปลี่ยนอะไร', async () => {
    const w = await workspace('gw-sig');
    const c = await checkout(w, 'promptpay');
    stub.pay(c.ref);
    const e = event('payment_intent.succeeded', c.ref);
    const payload = JSON.stringify(e);
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const tampered = JSON.stringify({ ...e, data: { object: { ...e.data.object, amount_received: 1 } } });
    const bad = [
      await hook(payload, undefined),
      await signed(e, { secret: 'whsec_attacker' }),
      await hook(tampered, header),
      await signed(e, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
    ];
    for (const r of bad) expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(bad.map((r) => r.body.error?.code)).toEqual(Array(4).fill("invalid_signature"));
    expect((await rows(c.invoice.id))[0]).toMatchObject({ status: 'pending_review', exception_reason: null });
    expect((await invoiceRow(c.invoice.id)).status).toBe('open');
    expect(await auditCount(c.invoice.id, 'billing.payment_confirmed')).toBe(0);

    expect((await hook(payload, header)).body).toEqual({ received: true });
    expect((await invoiceRow(c.invoice.id)).status).toBe('paid');
  });

  it('กันประมวลผลซ้ำ: event เดิมส่งซ้ำ / หลาย event พร้อมกัน → ปิดใบ ต่ออายุ ออกเอกสารครั้งเดียว', async () => {
    const w = await workspace('gw-idem');
    const c = await checkout(w, 'card');
    stub.pay(c.ref);
    const e = event('payment_intent.succeeded', c.ref);
    const results = await Promise.all([signed(e), signed(e), signed(event('payment_intent.succeeded', c.ref))]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => r.body.duplicate).length).toBe(2);
    expect((await invoiceRow(c.invoice.id)).status).toBe('paid');
    expect(await taxDocs(c.invoice.id)).toBe(1);
    expect(await auditCount(c.invoice.id, 'billing.payment_confirmed')).toBe(1);
    expect(Number((await t.owner.query(`SELECT count(*) FROM etax_jobs WHERE doc_id IN (SELECT id FROM tax_documents WHERE invoice_id = $1)`, [c.invoice.id])).rows[0].count)).toBe(1);
    expect((await sub(w.wsId)).status).toBe('active');
    // ล้มเหลวที่มาทีหลังไม่ย้อนการชำระ
    expect((await signed(event('payment_intent.payment_failed', c.ref))).body).toEqual({ received: true, ignored: true });
  });

  it('ยอดที่ Stripe รับไม่ตรงกับรายการ → เข้าคิว amount_mismatch ไม่เปิดแพ็กเกจ', async () => {
    const w = await workspace('gw-amount');
    const c = await checkout(w, 'promptpay');
    stub.pay(c.ref);
    stub.intents.get(c.ref)!.amount_received = c.invoice.amountDue - 100;
    expect((await signed(event('payment_intent.succeeded', c.ref))).body).toEqual({ received: true, exception: 'amount_mismatch' });
    expect((await invoiceRow(c.invoice.id)).status).toBe('open');
  });
  it('QR เดิมจ่ายเข้ามาด้วยยอดไม่ตรง → amount_mismatch · ใบยังเปิด และไม่ปิด QR ปัจจุบัน', async () => {
    const w = await workspace('gw-old-amount');
    const c = await checkout(w, 'promptpay');
    await post(w, `/billing/invoices/${c.invoice.id}/pay`, { renew: true });
    const current = (await rows(c.invoice.id))[0].provider_ref as string;
    Object.assign(stub.intents.get(c.ref)!, { status: 'succeeded', amount_received: 100, cancellation_reason: null });
    expect((await signed(event('payment_intent.succeeded', c.ref))).body).toEqual({ received: true, exception: 'amount_mismatch' });
    expect((await invoiceRow(c.invoice.id)).status).toBe('open');
    expect(stub.intents.get(current)!.status).toBe('requires_action');
    expect((await rows(c.invoice.id)).find((x) => x.provider_ref === c.ref)).toMatchObject({ exception_reason: 'amount_mismatch', amount: String(c.invoice.amountDue) });
  });
});

describe('บัตร', () => {
  it('ชำระครั้งแรก: เก็บบัตรไว้กับ Customer (off_session) · 3-D Secure ตามธนาคาร · Webhook สำเร็จบันทึก Customer ไว้ตัดรอบถัดไป', async () => {
    const w = await workspace('gw-card');
    const before = stub.calls('POST', /^\/v1\/customers$/).length;
    const c = await checkout(w, 'card');
    expect(stub.calls('POST', /^\/v1\/customers$/).length).toBe(before + 1);
    const pi = stub.intents.get(c.ref)!;
    expect(pi).toMatchObject({ amount: c.invoice.amountDue, currency: 'thb', setup_future_usage: 'off_session', payment_method_types: ['card'], payment_method_options: { card: { request_three_d_secure: 'automatic' } }, metadata: { invoice_id: c.invoice.id } });
    expect(pi.customer).toMatch(/^cus_stub_/);
    expect(c.body.card.clientSecret).toBe(pi.client_secret);
    // หน้าชำระขอ client secret อีกครั้ง (เช่นหลังยืนยัน 3-D Secure ไม่ผ่าน): ได้ intent เดิม ไม่สร้างใหม่
    const n = stub.calls('POST', /^\/v1\/payment_intents$/).length;
    expect((await post(w, `/billing/invoices/${c.invoice.id}/pay`, {})).body.card.clientSecret).toBe(pi.client_secret);
    expect(stub.calls('POST', /^\/v1\/payment_intents$/).length).toBe(n);

    stub.pay(c.ref);
    expect((await signed(event('payment_intent.succeeded', c.ref))).body).toEqual({ received: true });
    expect(await sub(w.wsId)).toMatchObject({ status: 'active', payment_method: 'card', stripe_customer_id: pi.customer });
  });

  it('ตัดตามรอบ: ล้มแล้วลองใหม่วันที่ 1, 3, 5 · ครั้งที่ 4 ผ่าน → Webhook ปิดใบ ต่ออายุ ออกเอกสาร', async () => {
    const w = await cardCustomer('gw-renew');
    stub.outcomes.push('declined', 'declined', 'declined', 'succeeded');
    const day = (n: number) => new Date(Date.now() + n * DAY);
    const mails = mail.length;

    expect(await jobs.renewCards(day(0))).toMatchObject({ invoices: 1, attempts: 1, failed: 1 });
    const { invoiceId, ref } = await renewalInvoice(w.wsId);
    const inv = await invoiceRow(invoiceId);
    expect(inv.status).toBe('open');
    // ใบต่ออายุผูกกับ Customer เดิม · ยืนยันแบบ off_session ด้วยบัตรที่เก็บไว้
    expect(stub.intents.get(ref)).toMatchObject({ customer: w.customer, setup_future_usage: 'off_session', amount: Number(inv.amount_due) });
    const confirms = () => stub.calls('POST', new RegExp(`^/v1/payment_intents/${ref}/confirm$`));
    expect(confirms()[0].body).toMatchObject({ off_session: 'true', payment_method: stub.methods.get(w.customer)![0].id });
    expect(mail.slice(mails).map((m) => m.subject)).toEqual([expect.stringMatching(/^ตัดบัตรไม่ผ่าน/)]);
    expect(mail[mails].text).toContain(nextAttemptOn(inv.start, 1)!);
    expect(mail[mails].text).not.toMatch(/4242|pm_stub/);

    // วันเดียวกันรันซ้ำ / วันที่ 2 / 4: ไม่ตัด
    expect(await jobs.renewCards(day(0))).toMatchObject({ invoices: 0, attempts: 0 });
    expect(await jobs.renewCards(day(1))).toMatchObject({ attempts: 1, failed: 1 });
    expect(await jobs.renewCards(day(2))).toMatchObject({ attempts: 0 });
    expect(await jobs.renewCards(day(3))).toMatchObject({ attempts: 1, failed: 1 });
    expect(await jobs.renewCards(day(4))).toMatchObject({ attempts: 0 });
    expect(await jobs.renewCards(day(5))).toMatchObject({ attempts: 1, pending: 1 });
    expect(confirms()).toHaveLength(4);
    // แต่ละครั้งใช้ Idempotency-Key ของตัวเอง (ส่งซ้ำในครั้งเดียวกันไม่ตัดซ้ำ)
    expect(new Set(confirms().map((r) => r.idem)).size).toBe(4);
    expect(await auditCount(invoiceId, 'billing.card_charge_attempt')).toBe(4);
    expect(await auditCount(invoiceId, 'billing.card_charge_failed')).toBe(3);
    // ผลของคำขอยังไม่ปิดใบ · รอ Webhook
    expect((await invoiceRow(invoiceId)).status).toBe('open');

    expect((await signed(event('payment_intent.succeeded', ref))).body).toEqual({ received: true });
    expect((await invoiceRow(invoiceId)).status).toBe('paid');
    expect(await taxDocs(invoiceId)).toBe(1);
    const s = await sub(w.wsId);
    expect(new Date(s.current_period_end).getTime()).toBeGreaterThan(Date.now() + 20 * DAY);
    expect(await jobs.renewCards(day(6))).toMatchObject({ invoices: 0, attempts: 0 });
  });

  it('ตัดไม่ผ่านครบ 4 ครั้ง → หยุดตัด ส่งลิงก์ชำระ และบันทึกให้ทีมการเงินตาม', async () => {
    const w = await cardCustomer('gw-exhaust');
    stub.outcomes.push('declined', 'declined', 'declined', 'declined');
    for (const d of [0, 1, 3, 5]) await jobs.renewCards(new Date(Date.now() + d * DAY));
    const { invoiceId } = await renewalInvoice(w.wsId);
    expect(await auditCount(invoiceId, 'billing.card_charge_attempt')).toBe(4);
    expect(await auditCount(invoiceId, 'billing.card_renewal_failed')).toBe(1);
    const last = mail.at(-1)!;
    expect(last).toMatchObject({ to: profile.taxEmail, subject: expect.stringMatching(/^ชำระค่าบริการ/) });
    expect(last.text).toContain(`/work/${w.slug}/billing/invoices/${invoiceId}`);
    expect(await jobs.renewCards(new Date(Date.now() + 8 * DAY))).toMatchObject({ attempts: 0 });
    expect((await invoiceRow(invoiceId)).status).toBe('open');
  });

  it('ธนาคารขอ 3-D Secure ตอนตัดรอบใหม่ → ส่งลิงก์ให้ลูกค้ายืนยันเอง ไม่ลองตัดซ้ำ · หน้าชำระได้ intent เดิมไปยืนยัน', async () => {
    const w = await cardCustomer('gw-3ds');
    stub.outcomes.push('requires_action');
    expect(await jobs.renewCards(new Date())).toMatchObject({ attempts: 1, actionRequired: 1 });
    const { invoiceId, ref } = await renewalInvoice(w.wsId);
    expect(await auditCount(invoiceId, 'billing.card_action_required')).toBe(1);
    expect(mail.at(-1)!.subject).toMatch(/^ยืนยันการชำระ/);
    expect(mail.at(-1)!.text).toContain(`/billing/invoices/${invoiceId}`);
    expect(await jobs.renewCards(new Date(Date.now() + DAY))).toMatchObject({ attempts: 0 });

    const page = await post(w, `/billing/invoices/${invoiceId}/pay`, {});
    expect(page.status).toBe(200);
    expect(page.body.card.clientSecret).toBe(stub.intents.get(ref)!.client_secret);
    // ลูกค้ายืนยัน 3-D Secure สำเร็จใน Stripe.js → Webhook
    stub.pay(ref);
    expect((await signed(event('payment_intent.succeeded', ref))).body).toEqual({ received: true });
    expect((await invoiceRow(invoiceId)).status).toBe('paid');
  });
});

describe('กระทบยอดทุกเช้า', () => {
  it('ดึงรายการย้อนหลังจาก Stripe (แบ่งหน้า) · Webhook หลุด → ยืนยันให้ · รายการที่ไม่รู้จักคืนให้ทีมตรวจ', async () => {
    const w = await workspace('gw-reconcile');
    const since = new Date(Date.now() - 1000);
    const c = await checkout(w, 'promptpay');
    stub.pay(c.ref);
    stub.addForeign(130);
    const pages = stub.calls('GET', /^\/v1\/payment_intents$/).length;
    const r = await payments.reconcile(since);
    expect(stub.calls('GET', /^\/v1\/payment_intents$/).length - pages).toBeGreaterThanOrEqual(2);
    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect(r.unmatched.length).toBeGreaterThanOrEqual(130);
    expect((await invoiceRow(c.invoice.id)).status).toBe('paid');
    expect((await rows(c.invoice.id))[0].status).toBe('confirmed');
    // รอบถัดไปไม่ยืนยันซ้ำ
    expect((await payments.reconcile(since)).settled).toBe(0);
    expect(await taxDocs(c.invoice.id)).toBe(1);
  });
});
