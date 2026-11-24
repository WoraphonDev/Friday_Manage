import Stripe from 'stripe';
import type { ChargeResult, GatewayEvent, GatewayPayment, GatewayRequest, PaymentGateway, SavedCardCharge, SettledPayment } from '../providers.js';
import { parseStripeEvent } from './stripe-event.js';
import { QR_TTL_MS } from './card-retry.js';

/** Webhook ที่เก่ากว่านี้ไม่รับ (กัน replay) · เท่ากับค่าเดิมของ A33 */
const SIGNATURE_TOLERANCE_S = 300;
/** ดึงรายการย้อนหลังได้สูงสุดเท่านี้ต่อรอบ (กันวนไม่จบเมื่อผู้ให้บริการตอบผิดปกติ) */
const LIST_LIMIT = 2000;

export interface StripeOptions {
  /**
   * ปลายทาง API (ไม่ตั้ง = api.stripe.com) · ใช้กับ stripe-mock หรือตัวจำลองใน test เท่านั้น
   * ตั้งได้เฉพาะนอก production (ดู gatewayFromEnv)
   */
  apiUrl?: string;
}

/** ข้อมูลของ PaymentIntent ที่เราใช้ (ไม่อ่าน / ไม่เก็บข้อมูลบัตร) */
type Intent = Stripe.PaymentIntent;

/**
 * Stripe จริง (A35b · ผู้ใช้เลือก Stripe 24 พ.ย. 2569) ผ่าน SDK ทางการ
 * - PromptPay: PaymentIntent ผูกยอด + ใบแจ้งหนี้ (metadata) · QR ใช้ได้ 15 นาทีนับจากสร้าง (Stripe ไม่ส่งเวลาหมดอายุมา เราจึงคิดเองและปิดรายการเมื่อครบ)
 * - บัตร: PaymentIntent ผูกกับ Customer + `setup_future_usage=off_session` เพื่อเก็บบัตรไว้ตัดรอบถัดไป · 3-D Secure ตามที่ธนาคารขอ (`automatic`) ยืนยันด้วย Stripe.js หน้าเว็บ
 * - รอบถัดไป: ยืนยัน PaymentIntent ของใบต่ออายุแบบ off_session ด้วยบัตรที่เก็บไว้ · ธนาคารขอ 3-D Secure → ส่งลิงก์ให้ลูกค้ายืนยันเอง
 * ไม่บันทึกข้อมูลบัตรหรือ secret ลง log · ข้อความ error ส่งต่อเฉพาะรหัสของ Stripe
 */
export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly whSecret: string,
    opts: StripeOptions = {},
  ) {
    const api = opts.apiUrl ? new URL(opts.apiUrl) : null;
    this.stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 20_000,
      telemetry: false,
      appInfo: { name: 'Friday Work Management' },
      ...(api ? { host: api.hostname, port: api.port || (api.protocol === 'http:' ? 80 : 443), protocol: api.protocol === 'http:' ? 'http' : 'https' } : {}),
    });
  }

  private base(r: GatewayRequest) {
    return {
      amount: r.amount,
      currency: 'thb',
      description: `Friday Work Management ${r.invoiceNumber}`,
      metadata: { invoice_id: r.invoiceId, invoice_number: r.invoiceNumber },
      ...(r.email ? { receipt_email: r.email } : {}),
    };
  }

  /** รายการเดิมของใบ (ขอ client secret / QR ซ้ำ) · Idempotency-Key ของ Stripe หมดอายุใน 24 ชม. จึงดึงด้วยเลขอ้างอิงแทนการสร้างซ้ำ */
  private retrieve(ref: string) {
    return this.call(() => this.stripe.paymentIntents.retrieve(ref));
  }

  async createCard(r: GatewayRequest): Promise<GatewayPayment> {
    if (r.providerRef) {
      const pi = await this.retrieve(r.providerRef);
      return { providerRef: pi.id, clientSecret: pi.client_secret ?? undefined };
    }
    // เก็บบัตรไว้กับ Customer ของ Workspace (ครั้งแรกสร้างใหม่ด้วย key ที่ผูกกับคำขอนี้ ส่งซ้ำได้ Customer เดิม)
    const customer = r.customerRef ?? (await this.call(() => this.stripe.customers.create({ ...(r.email ? { email: r.email } : {}), metadata: { first_invoice_id: r.invoiceId } }, { idempotencyKey: `cus:${r.idempotencyKey}` }))).id;
    const pi = await this.call(() =>
      this.stripe.paymentIntents.create(
        {
          ...this.base(r),
          customer,
          allowed_payment_method_types: ['card'],
          setup_future_usage: 'off_session',
          payment_method_options: { card: { request_three_d_secure: 'automatic' } },
        },
        { idempotencyKey: r.idempotencyKey },
      ),
    );
    return { providerRef: pi.id, clientSecret: pi.client_secret ?? undefined };
  }

  async createPromptPay(r: GatewayRequest): Promise<GatewayPayment> {
    const pi = r.providerRef
      ? await this.retrieve(r.providerRef)
      : await this.call(() =>
          this.stripe.paymentIntents.create(
            {
              ...this.base(r),
              allowed_payment_method_types: ['promptpay'],
              // PromptPay ของ Stripe ต้องมีอีเมลผู้จ่าย · ไม่มีอีเมลภาษีใช้ที่อยู่สมมติ (ไม่ส่งใบเสร็จของ Stripe)
              payment_method_data: { type: 'promptpay', billing_details: { email: r.email ?? 'billing@example.com' } },
              confirm: true,
            },
            { idempotencyKey: r.idempotencyKey },
          ),
        );
    const expiresAt = new Date(pi.created * 1000 + QR_TTL_MS);
    const data = pi.next_action?.promptpay_display_qr_code?.data;
    // รายการที่ปิดแล้ว (หมดอายุ / ชำระแล้ว) ไม่มี QR · คืนเวลาหมดอายุเดิมให้หน้าเว็บขึ้นปุ่มสร้าง QR ใหม่
    if (!data && !r.providerRef) throw new Error('stripe_error: ไม่ได้รับ QR PromptPay');
    return { providerRef: pi.id, qr: { payload: data ?? '', expiresAt } };
  }

  async chargeSaved(c: SavedCardCharge): Promise<ChargeResult> {
    const pms = await this.call(() => this.stripe.customers.listPaymentMethods(c.customerRef, { type: 'card', limit: 1 }));
    const pm = pms.data[0];
    if (!pm) return { status: 'failed', code: 'no_saved_card' };
    try {
      const pi = await this.stripe.paymentIntents.confirm(c.providerRef, { payment_method: pm.id, off_session: true }, { idempotencyKey: c.idempotencyKey });
      return { status: intentResult(pi) };
    } catch (e) {
      if (e instanceof Stripe.errors.StripeCardError) {
        // ธนาคารขอยืนยันตัวตน (3-D Secure) ตัดเองไม่ได้ ต้องให้ลูกค้ายืนยันที่หน้าชำระ
        if (e.code === 'authentication_required' || e.payment_intent?.status === 'requires_action') return { status: 'requires_action', code: e.code ?? 'authentication_required' };
        return { status: 'failed', code: e.decline_code ?? e.code ?? 'card_declined' };
      }
      throw stripeError(e);
    }
  }

  async cancel(providerRef: string, reason: 'expired' | 'replaced') {
    try {
      await this.stripe.paymentIntents.cancel(providerRef, { cancellation_reason: reason === 'expired' ? 'abandoned' : 'duplicate' });
      return true;
    } catch (e) {
      // ปิดไม่ได้เพราะสถานะเปลี่ยนไปแล้ว: ยกเลิกอยู่แล้ว = ปิดแล้ว · ชำระแล้ว / กำลังตัดเงิน = ปิดไม่ได้
      if (e instanceof Stripe.errors.StripeInvalidRequestError) return (await this.retrieve(providerRef)).status === 'canceled';
      throw stripeError(e);
    }
  }

  async closeExpiredQr(providerRef: string, now: Date) {
    const pi = await this.retrieve(providerRef);
    if (pi.status === 'succeeded' || pi.status === 'processing') return 'paid' as const;
    if (pi.status === 'canceled') return 'expired' as const;
    if (pi.created * 1000 + QR_TTL_MS > now.getTime()) return 'open' as const;
    return (await this.cancel(providerRef, 'expired')) ? ('expired' as const) : ('paid' as const);
  }

  /** ตรวจลายเซ็นด้วย SDK ของ Stripe ก่อนอ่านเนื้อหา · secret ว่างไม่ยอมรับ (ใครก็เซ็นด้วยค่าว่างได้) */
  verifyWebhook(raw: Buffer, signature: string | undefined): GatewayEvent {
    if (!signature) throw new Error('missing_signature');
    if (!this.whSecret) throw new Error('webhook_secret_missing');
    try {
      this.stripe.webhooks.constructEvent(raw, signature, this.whSecret, SIGNATURE_TOLERANCE_S);
    } catch {
      throw new Error('bad_signature');
    }
    return parseStripeEvent(raw);
  }

  async listSettled(since: Date) {
    const out: SettledPayment[] = [];
    let seen = 0;
    // SDK แบ่งหน้าให้เอง (starting_after) · ดึงเฉพาะที่สร้างหลังเวลาที่กำหนด
    for await (const p of this.stripe.paymentIntents.list({ created: { gte: Math.floor(since.getTime() / 1000) }, limit: 100 })) {
      if (++seen > LIST_LIMIT) break;
      if (p.status === 'succeeded') out.push({ providerRef: p.id, invoiceId: p.metadata?.invoice_id ?? null, amount: p.amount_received, at: new Date(p.created * 1000) });
    }
    return out;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw stripeError(e);
    }
  }
}

function intentResult(pi: Intent): ChargeResult['status'] {
  if (pi.status === 'succeeded') return 'succeeded';
  if (pi.status === 'processing') return 'processing';
  if (pi.status === 'requires_action') return 'requires_action';
  return 'failed';
}

/** เหลือเฉพาะชนิด / รหัส / ข้อความของ Stripe (ไม่มีข้อมูลบัตร) · ไม่ส่งต่อ object error ทั้งก้อนเพราะมี header ของคำขอ */
function stripeError(e: unknown) {
  if (e instanceof Stripe.errors.StripeError) return new Error(`stripe_error: ${e.type}${e.code ? ` ${e.code}` : ''} · ${e.message}`.slice(0, 300));
  return e instanceof Error ? e : new Error(String(e));
}
