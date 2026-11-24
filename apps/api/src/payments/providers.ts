import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { QR_TTL_MS } from './providers/card-retry.js';
import { parseStripeEvent } from './providers/stripe-event.js';
import { StripeGateway } from './providers/stripe.js';

export { parseStripeEvent, StripeGateway };

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
  /** รายการเดิมของใบนี้ (ขอ client secret / QR ซ้ำ) → ดึงรายการเดิม ไม่สร้างใหม่ (Idempotency-Key ของ Stripe หมดอายุใน 24 ชม.) */
  providerRef?: string | null;
  /** บัตร: ลูกค้าที่ผู้ให้บริการเก็บบัตรไว้แล้ว (`subscriptions.stripe_customer_id`) · null = สร้างใหม่ */
  customerRef?: string | null;
}
export interface GatewayEvent {
  id: string;
  /** expired = QR หมดอายุ / ถูกแทนด้วย QR ใหม่ (ใบยังเปิด) · canceled = ยกเลิกด้วยเหตุอื่น (ใบ void) */
  type: 'payment.succeeded' | 'payment.failed' | 'payment.canceled' | 'payment.expired' | 'ignored';
  providerRef: string;
  invoiceId: string | null;
  /** ยอดที่รับจริง (สตางค์) · เฉพาะ succeeded */
  amount?: number;
  /** สกุลเงินของรายการ (ตัวเล็กตาม Stripe) · ไม่ใช่ thb = ยอดไม่ตรง */
  currency?: string | null;
  method?: 'card' | 'promptpay' | null;
  /** บัตร: ลูกค้าที่เก็บบัตรไว้ตัดรอบถัดไป */
  customerRef?: string | null;
  /** ล้มเหลว: รหัสของผู้ให้บริการ (ไม่มีข้อมูลบัตร) */
  failureCode?: string | null;
}

/** ตัดบัตรที่เก็บไว้ของใบต่ออายุ (off-session) */
export interface SavedCardCharge {
  /** รายการชำระของใบต่ออายุ (สร้างตอนออกใบ) */
  providerRef: string;
  customerRef: string;
  /** ต่อครั้งที่ตัด: ส่งซ้ำในครั้งเดียวกันไม่ตัดซ้ำ */
  idempotencyKey: string;
}
/** succeeded / processing = รอ Webhook ยืนยัน · requires_action = ธนาคารขอ 3-D Secure ต้องให้ลูกค้ายืนยันเอง · failed = บัตรถูกปฏิเสธ */
export interface ChargeResult {
  status: 'succeeded' | 'processing' | 'requires_action' | 'failed';
  code?: string | null;
}

/** รายการที่ผู้ให้บริการรับเงินสำเร็จ (ใช้กระทบยอดทุกเช้า จับ Webhook ที่หลุด) */
export interface SettledPayment {
  providerRef: string;
  invoiceId: string | null;
  amount: number;
  /** ไม่ใช่ thb = ยอดไม่ตรง · ไม่ส่ง = ไม่รู้ (ตัวปลอม) */
  currency?: string | null;
  method?: 'card' | 'promptpay' | null;
  at: Date;
}

/**
 * ผู้ให้บริการรับชำระ (A35a) · ตัวจริงคือ Stripe (A35b · `providers/stripe.ts`) · โค้ดส่วนอื่นใช้ผ่าน interface นี้เท่านั้น
 */
export interface PaymentGateway {
  readonly name: 'stripe' | 'fake';
  createCard(r: GatewayRequest): Promise<GatewayPayment>;
  createPromptPay(r: GatewayRequest): Promise<GatewayPayment>;
  /** ตรวจลายเซ็นของ Webhook ขาเข้า (`Stripe-Signature`) แล้วแปลงเป็นเหตุการณ์ของเรา · ลายเซ็นผิด → throw */
  verifyWebhook(raw: Buffer, signature: string | undefined): GatewayEvent;
  /** รายการที่รับเงินสำเร็จตั้งแต่เวลาที่กำหนด */
  listSettled(since: Date): Promise<SettledPayment[]>;
  /** ตัดบัตรที่เก็บไว้ (ใบต่ออายุ) */
  chargeSaved(c: SavedCardCharge): Promise<ChargeResult>;
  /** ปิดรายการที่ยังไม่ชำระ (QR หมดอายุ / ถูกแทน) · false = ปิดไม่ได้เพราะชำระแล้วหรือกำลังตัดเงิน */
  cancel(providerRef: string, reason: 'expired' | 'replaced'): Promise<boolean>;
  /** QR ครบ 15 นาทีแล้ว → ปิดที่ผู้ให้บริการ · open = ยังไม่หมดอายุ · paid = ชำระแล้ว (รอ Webhook / กระทบยอด) */
  closeExpiredQr(providerRef: string, now: Date): Promise<'open' | 'expired' | 'paid'>;
}
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export type ETaxKind = 'tax_invoice' | 'credit_note' | 'debit_note';
/** เอกสารอ้างอิงที่ส่งคู่กัน: ฉบับเดิมของฉบับที่ออกแทน · ใบกำกับภาษีที่ใบลด / เพิ่มหนี้อ้างถึง */
export interface ETaxReference {
  number: string;
  issuedOn: string;
  /** เลขอ้างอิงของผู้ให้บริการ (null = ฉบับเดิมไม่ได้ออกผ่าน e-Tax) */
  providerRef: string | null;
}
export interface ETaxInput {
  /** id ของเอกสารในระบบ (ใบกำกับภาษี / ใบลดหนี้ / ใบเพิ่มหนี้) */
  documentId: string;
  /** ใบกำกับภาษีเท่านั้น (ชื่อเดิมของ payload · คงไว้ให้ผู้ให้บริการที่ผูกไว้แล้ว) */
  taxDocumentId?: string;
  kind: ETaxKind;
  number: string;
  /** วันที่ของเอกสาร (YYYY-MM-DD) */
  issuedOn: string;
  invoiceNumber: string;
  /** ใบลด / เพิ่มหนี้: ยอดส่วนต่าง (ก่อน VAT · VAT · รวม) */
  amounts: { subtotal: number; vat: number; total: number };
  /** ข้อมูลผู้ซื้อที่ล็อกไว้ในเอกสาร (ไม่ใช่โปรไฟล์ปัจจุบัน) */
  buyer: { companyName: string; taxId: string; branchType: string; branchNo: string | null; address: string; email: string };
  /** ฉบับใหม่ที่ออกแทน: ฉบับเดิมที่ยกเลิก */
  replaces?: ETaxReference | null;
  /** ใบลด / เพิ่มหนี้: ใบกำกับภาษีเดิม (ม.86/9 · 86/10) */
  references?: ETaxReference | null;
  reason?: string | null;
}
export interface ETaxCancelInput {
  documentId: string;
  kind: ETaxKind;
  number: string;
  providerRef: string;
  reason: string;
}
/** ผลของเอกสารที่ถามผู้ให้บริการ · pending = ยังไม่มีผล */
export interface ETaxStatus {
  status: 'pending' | 'issued' | 'cancelled' | 'failed';
  code?: string;
  message?: string;
}
export interface ETaxProvider {
  readonly name: string;
  /** ส่งคำขอออกเอกสาร (ใบกำกับภาษี / ใบลดหนี้ / ใบเพิ่มหนี้ · ผลจริงมาทาง `hooks/etax`) · คืนเลขอ้างอิงของผู้ให้บริการ */
  issue(input: ETaxInput): Promise<{ providerRef: string }>;
  /** แจ้งยกเลิกเอกสารที่ออกไปแล้ว (ผลมาทาง `hooks/etax` เช่นกัน) */
  cancel(input: ETaxCancelInput): Promise<{ providerRef: string }>;
  /** ถามผลของคำขอที่ส่งไปแล้วแต่ยังไม่ได้ webhook (ปุ่ม "ตรวจสถานะ") */
  status(providerRef: string): Promise<ETaxStatus>;
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

const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dev_fake';

/** ตัวปลอมสำหรับ dev / test: ไม่ออกเครือข่าย ผลซ้ำได้ตาม Idempotency-Key · ลายเซ็น Webhook ใช้สูตรเดียวกับ Stripe จริง */
export class FakeGateway implements PaymentGateway {
  readonly name = 'fake' as const;
  readonly calls: { kind: 'card' | 'promptpay'; request: GatewayRequest }[] = [];
  /** test / dev: รายการที่ถือว่าผู้ให้บริการรับเงินแล้ว (จำลองกรณี Webhook หลุด) */
  readonly settled: SettledPayment[] = [];
  /** การตัดบัตรที่เก็บไว้ (ใบต่ออายุ) */
  readonly charges: SavedCardCharge[] = [];
  /** test ตั้งผลการตัดบัตรครั้งถัดไป · ว่าง = สำเร็จ */
  readonly chargeOutcomes: ChargeResult[] = [];
  /** รายการที่ถูกปิด (QR หมดอายุ / ถูกแทน) */
  readonly canceled: { providerRef: string; reason: 'expired' | 'replaced' }[] = [];
  private readonly createdAt = new Map<string, number>();
  private readonly chargeResults = new Map<string, ChargeResult>();

  async createCard(r: GatewayRequest): Promise<GatewayPayment> {
    this.calls.push({ kind: 'card', request: r });
    const providerRef = r.providerRef ?? `pi_fake_${sha(r.idempotencyKey).slice(0, 16)}`;
    return { providerRef, clientSecret: `${providerRef}_secret_fake` };
  }

  async createPromptPay(r: GatewayRequest): Promise<GatewayPayment> {
    this.calls.push({ kind: 'promptpay', request: r });
    const providerRef = r.providerRef ?? `pi_fake_${sha(`pp:${r.idempotencyKey}`).slice(0, 16)}`;
    // หมดอายุ 15 นาทีนับจากการสร้างครั้งแรก (ขอซ้ำได้เวลาเดิม)
    if (!this.createdAt.has(providerRef)) this.createdAt.set(providerRef, Date.now());
    return { providerRef, qr: { payload: `00020101021229370016A000000677010111FAKE|${r.amount}|${providerRef}`, expiresAt: new Date(this.createdAt.get(providerRef)! + QR_TTL_MS) } };
  }

  verifyWebhook(raw: Buffer, signature: string | undefined) {
    verifyStripeSignature(raw, signature, webhookSecret());
    return parseStripeEvent(raw);
  }

  async listSettled(since: Date) {
    return this.settled.filter((p) => p.at >= since);
  }

  async chargeSaved(c: SavedCardCharge): Promise<ChargeResult> {
    const seen = this.chargeResults.get(c.idempotencyKey);
    if (seen) return seen;
    this.charges.push(c);
    const result = this.chargeOutcomes.shift() ?? { status: 'succeeded' as const };
    this.chargeResults.set(c.idempotencyKey, result);
    return result;
  }

  async cancel(providerRef: string, reason: 'expired' | 'replaced') {
    if (this.settled.some((p) => p.providerRef === providerRef)) return false;
    if (!this.canceled.some((x) => x.providerRef === providerRef)) this.canceled.push({ providerRef, reason });
    return true;
  }

  async closeExpiredQr(providerRef: string, now: Date) {
    if (this.settled.some((p) => p.providerRef === providerRef)) return 'paid' as const;
    if (this.canceled.some((x) => x.providerRef === providerRef)) return 'expired' as const;
    if ((this.createdAt.get(providerRef) ?? 0) + QR_TTL_MS > now.getTime()) return 'open' as const;
    await this.cancel(providerRef, 'expired');
    return 'expired' as const;
  }
}

/** ข้อผิดพลาดจากผู้ให้บริการ e-Tax (รหัส + ข้อความ) · เก็บใน etax_jobs.last_error ให้ทีมเห็น */
export class ETaxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** ข้อความที่เก็บในคิว: "E-102 · ข้อความ" */
export const etaxErrorText = (e: unknown) => (e instanceof ETaxError ? `${e.code} · ${e.message}` : (e as Error)?.message ?? String(e)).slice(0, 500);

/** ตัวปลอมของ e-Tax: บันทึกคำขอไว้ให้ test ตรวจ · `failNext` จำลองผู้ให้บริการล่ม */
export class FakeETax implements ETaxProvider {
  readonly name = 'fake';
  readonly issued: ETaxInput[] = [];
  readonly cancelled: ETaxCancelInput[] = [];
  /** ผลที่ตอบเมื่อถามสถานะ (test ตั้งเอง) · ไม่ตั้ง = pending */
  readonly statuses = new Map<string, ETaxStatus>();
  private failures: ETaxError[] = [];
  /** n ครั้งถัดไปตอบผิดพลาด */
  failNext(n = 1, error = new ETaxError('503', 'ผู้ให้บริการปิดปรับปรุง')) {
    this.failures.push(...Array.from({ length: n }, () => error));
  }
  private maybeFail() {
    const e = this.failures.shift();
    if (e) throw e;
  }
  async issue(input: ETaxInput) {
    this.maybeFail();
    this.issued.push(input);
    return { providerRef: `etax_${input.number}` };
  }
  async cancel(input: ETaxCancelInput) {
    this.maybeFail();
    this.cancelled.push(input);
    return { providerRef: `etax_cancel_${input.number}` };
  }
  async status(providerRef: string): Promise<ETaxStatus> {
    this.maybeFail();
    return this.statuses.get(providerRef) ?? { status: 'pending' as const };
  }
}

/**
 * ผู้ให้บริการ e-Tax จริง: ส่ง JSON ไป `ETAX_API_URL` (รูปแบบเฉพาะผู้ให้บริการปรับที่นี่ที่เดียวเมื่อเลือกเจ้า)
 * ออกเอกสาร POST {url} · แจ้งยกเลิก POST {url}/cancel · ถามผล GET {url}/{providerRef}
 * ตอบผิดพลาด: `{ error: { code, message } }` หรือ `{ code, message }` → ETaxError
 */
export class HttpETax implements ETaxProvider {
  readonly name = 'http';
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}
  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch(`${this.url.replace(/\/$/, '')}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { id?: string; reference?: string; status?: string; code?: string; message?: string; error?: { code?: string; message?: string } };
    if (!res.ok) throw new ETaxError(json.error?.code ?? json.code ?? String(res.status), json.error?.message ?? json.message ?? `HTTP ${res.status}`);
    return json;
  }
  async issue(input: ETaxInput) {
    const json = await this.call('POST', '', input);
    return { providerRef: json.id ?? json.reference ?? input.number };
  }
  async cancel(input: ETaxCancelInput) {
    const json = await this.call('POST', '/cancel', input);
    return { providerRef: json.id ?? json.reference ?? input.providerRef };
  }
  async status(providerRef: string): Promise<ETaxStatus> {
    const json = await this.call('GET', `/${encodeURIComponent(providerRef)}`);
    const status: ETaxStatus['status'] = (['issued', 'cancelled', 'failed'] as const).find((x) => x === json.status) ?? 'pending';
    return { status, code: json.error?.code ?? json.code, message: json.error?.message ?? json.message };
  }
}

export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentGateway {
  if (env.STRIPE_SECRET_KEY) {
    // ไม่มี secret ของ Webhook = ใครก็ปลอม Webhook มาปิดใบแจ้งหนี้ได้ → ไม่ยอมเริ่ม
    if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('ตั้ง STRIPE_WEBHOOK_SECRET (whsec_… จาก Stripe Dashboard หรือ stripe listen) คู่กับ STRIPE_SECRET_KEY');
    // ปลายทาง API อื่น (stripe-mock / ตัวจำลองใน test) ใช้ได้เฉพาะนอก production กันคีย์จริงถูกส่งไปที่อื่น
    // คีย์ live ก็ห้ามเช่นกัน แม้ NODE_ENV ไม่ใช่ production (เช่นรันเครื่องตัวเองด้วยคีย์จริง)
    if (env.STRIPE_API_URL && (env.NODE_ENV === 'production' || /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY))) throw new Error('STRIPE_API_URL ใช้ได้เฉพาะ dev / test กับคีย์ทดสอบ');
    return new StripeGateway(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, { apiUrl: env.STRIPE_API_URL || undefined });
  }
  if (env.NODE_ENV === 'production') {
    // staging (VPS) รันแบบ production โดยยังไม่ตั้งคีย์ Stripe · ต้องขอตัวปลอมตรง ๆ และตั้งลายเซ็น Webhook ของตัวเอง
    // ไม่งั้นใครก็ส่ง Webhook ที่เซ็นด้วยค่า dev ใน repo มาปิดใบแจ้งหนี้ได้
    if (env.PAYMENT_GATEWAY === 'fake' && (env.STRIPE_WEBHOOK_SECRET ?? '').length >= 32) return new FakeGateway();
    throw new Error('ตั้ง STRIPE_SECRET_KEY และ STRIPE_WEBHOOK_SECRET ก่อนเปิด production (staging: PAYMENT_GATEWAY=fake + STRIPE_WEBHOOK_SECRET ≥ 32 ตัวอักษร)');
  }
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
