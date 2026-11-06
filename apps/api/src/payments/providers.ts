import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** ผู้ให้บริการชำระเงิน (Stripe) และ e-Tax เป็น interface เพื่อให้ test ใช้ตัวปลอมที่ไม่ออกเครือข่าย */

export interface GatewayPayment {
  providerRef: string;
  /** บัตร: ส่งให้ Stripe.js ยืนยันฝั่งหน้าเว็บ */
  clientSecret?: string;
  /** PromptPay: ข้อมูล QR (EMVCo payload) และเวลาหมดอายุ */
  qr?: { payload: string; expiresAt: Date };
}
export interface GatewayRequest {
  amount: number;
  invoiceId: string;
  invoiceNumber: string;
  email: string | null;
  /** ส่งคำขอเดิมซ้ำด้วย key เดิมต้องได้ผลเดิม (Stripe รองรับด้วย Idempotency-Key) */
  idempotencyKey: string;
}
export interface GatewayEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'payment.canceled' | 'ignored';
  providerRef: string;
  invoiceId: string | null;
}

export interface PaymentGateway {
  readonly name: 'stripe' | 'fake';
  createCard(r: GatewayRequest): Promise<GatewayPayment>;
  createPromptPay(r: GatewayRequest): Promise<GatewayPayment>;
  /** ตรวจลายเซ็นของ Webhook ขาเข้า (`Stripe-Signature`) แล้วแปลงเป็นเหตุการณ์ของเรา · ลายเซ็นผิด → throw */
  verifyWebhook(raw: Buffer, signature: string | undefined): GatewayEvent;
}
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface ETaxInput {
  taxDocumentId: string;
  number: string;
  invoiceNumber: string;
  amounts: { subtotal: number; vat: number; total: number };
  buyer: { companyName: string; taxId: string; branchType: string; branchNo: string | null; address: string; email: string };
}
export interface ETaxProvider {
  readonly name: string;
  /** ส่งคำขอออกเอกสาร (ผลจริงมาทาง `hooks/etax`) · คืนเลขอ้างอิงของผู้ให้บริการ */
  issue(input: ETaxInput): Promise<{ providerRef: string }>;
}
export const ETAX_PROVIDER = Symbol('ETAX_PROVIDER');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SIGNATURE_TOLERANCE_S = 300;

/** ตรวจ `Stripe-Signature: t=<unix>,v1=<hmac>` = HMAC-SHA256(secret, "<t>.<raw>") · กัน replay ด้วยเวลา */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()) {
  if (!header) throw new Error('missing_signature');
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) throw new Error('bad_signature');
  if (Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_S) throw new Error('signature_expired');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const given = Buffer.from(parts.v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('bad_signature');
}

/** แปลงเหตุการณ์ของ Stripe (payment_intent.*) เป็นเหตุการณ์ของเรา */
export function parseStripeEvent(raw: Buffer): GatewayEvent {
  const e = JSON.parse(raw.toString('utf8')) as { id: string; type: string; data?: { object?: { id?: string; metadata?: { invoice_id?: string } } } };
  const obj = e.data?.object ?? {};
  const map: Record<string, GatewayEvent['type']> = {
    'payment_intent.succeeded': 'payment.succeeded',
    'payment_intent.payment_failed': 'payment.failed',
    'payment_intent.canceled': 'payment.canceled',
  };
  return { id: e.id, type: map[e.type] ?? 'ignored', providerRef: obj.id ?? '', invoiceId: obj.metadata?.invoice_id ?? null };
}

const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dev_fake';

/** ตัวปลอมสำหรับ dev / test: ไม่ออกเครือข่าย ผลซ้ำได้ตาม Idempotency-Key · ลายเซ็น Webhook ใช้สูตรเดียวกับ Stripe จริง */
export class FakeGateway implements PaymentGateway {
  readonly name = 'fake' as const;
  readonly calls: { kind: 'card' | 'promptpay'; request: GatewayRequest }[] = [];

  async createCard(r: GatewayRequest): Promise<GatewayPayment> {
    this.calls.push({ kind: 'card', request: r });
    const providerRef = `pi_fake_${sha(r.idempotencyKey).slice(0, 16)}`;
    return { providerRef, clientSecret: `${providerRef}_secret_fake` };
  }

  async createPromptPay(r: GatewayRequest): Promise<GatewayPayment> {
    this.calls.push({ kind: 'promptpay', request: r });
    const providerRef = `pi_fake_${sha(`pp:${r.idempotencyKey}`).slice(0, 16)}`;
    // หมดอายุ 15 นาทีนับจากการสร้างครั้งแรก (ซ้ำด้วย key เดิมต้องได้เวลาเดิม จึงคิดจากค่าแฮช ไม่ใช่เวลาปัจจุบัน)
    return { providerRef, qr: { payload: `00020101021229370016A000000677010111FAKE|${r.amount}|${providerRef}`, expiresAt: new Date(Date.now() + 15 * 60_000) } };
  }

  verifyWebhook(raw: Buffer, signature: string | undefined) {
    verifyStripeSignature(raw, signature, webhookSecret());
    return parseStripeEvent(raw);
  }
}

/** Stripe จริง (REST โดยตรง ไม่ใช้ SDK) · เปิดเมื่อมี `STRIPE_SECRET_KEY` */
export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;

  constructor(
    private readonly secretKey: string,
    private readonly whSecret: string,
  ) {}

  private async intent(r: GatewayRequest, extra: Record<string, string>) {
    const body = new URLSearchParams({
      amount: String(r.amount),
      currency: 'thb',
      description: `Friday Manage ${r.invoiceNumber}`,
      'metadata[invoice_id]': r.invoiceId,
      'metadata[invoice_number]': r.invoiceNumber,
      ...(r.email ? { receipt_email: r.email } : {}),
      ...extra,
    });
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': r.idempotencyKey },
      body,
    });
    const json = (await res.json()) as { id?: string; client_secret?: string; next_action?: { promptpay_display_qr_code?: { data?: string; expires_at?: number } }; error?: { message?: string } };
    if (!res.ok || !json.id) throw new Error(`stripe_error: ${json.error?.message ?? res.status}`);
    return json;
  }

  async createCard(r: GatewayRequest): Promise<GatewayPayment> {
    const j = await this.intent(r, { 'payment_method_types[]': 'card' });
    return { providerRef: j.id!, clientSecret: j.client_secret };
  }

  async createPromptPay(r: GatewayRequest): Promise<GatewayPayment> {
    const j = await this.intent(r, { 'payment_method_types[]': 'promptpay', confirm: 'true', 'payment_method_data[type]': 'promptpay', 'payment_method_data[billing_details][email]': r.email ?? 'billing@example.com' });
    const qr = j.next_action?.promptpay_display_qr_code;
    if (!qr?.data) throw new Error('stripe_error: ไม่ได้รับ QR');
    return { providerRef: j.id!, qr: { payload: qr.data, expiresAt: new Date((qr.expires_at ?? Math.floor(Date.now() / 1000) + 900) * 1000) } };
  }

  verifyWebhook(raw: Buffer, signature: string | undefined) {
    verifyStripeSignature(raw, signature, this.whSecret);
    return parseStripeEvent(raw);
  }
}

/** ตัวปลอมของ e-Tax: บันทึกคำขอไว้ให้ test ตรวจ */
export class FakeETax implements ETaxProvider {
  readonly name = 'fake';
  readonly issued: ETaxInput[] = [];
  async issue(input: ETaxInput) {
    this.issued.push(input);
    return { providerRef: `etax_${input.number}` };
  }
}

/** ผู้ให้บริการ e-Tax จริง: ส่ง JSON ไป `ETAX_API_URL` (รูปแบบเฉพาะผู้ให้บริการปรับที่นี่ที่เดียวเมื่อเลือกเจ้า) */
export class HttpETax implements ETaxProvider {
  readonly name = 'http';
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}
  async issue(input: ETaxInput) {
    const res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` }, body: JSON.stringify(input) });
    const json = (await res.json().catch(() => ({}))) as { id?: string; reference?: string };
    if (!res.ok) throw new Error(`etax_error: ${res.status}`);
    return { providerRef: json.id ?? json.reference ?? input.number };
  }
}

export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentGateway {
  if (env.STRIPE_SECRET_KEY) return new StripeGateway(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET ?? '');
  if (env.NODE_ENV === 'production') throw new Error('ตั้ง STRIPE_SECRET_KEY และ STRIPE_WEBHOOK_SECRET ก่อนเปิด production');
  return new FakeGateway();
}
export function etaxFromEnv(env: NodeJS.ProcessEnv = process.env): ETaxProvider {
  if (env.ETAX_API_URL && env.ETAX_API_KEY) return new HttpETax(env.ETAX_API_URL, env.ETAX_API_KEY);
  return new FakeETax();
}

/** ตรวจลายเซ็น `x-etax-signature: sha256=<hex>` = HMAC-SHA256(ETAX_WEBHOOK_SECRET, raw) */
export function verifyETaxSignature(raw: Buffer, header: string | undefined, secret = process.env.ETAX_WEBHOOK_SECRET ?? 'etax_dev_fake') {
  const given = Buffer.from((header ?? '').replace(/^sha256=/, ''), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
