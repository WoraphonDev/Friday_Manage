import type { GatewayEvent } from '../providers.js';

/** ส่วนของ PaymentIntent ใน Webhook ที่เราอ่าน · ไม่อ่านข้อมูลบัตร (payment_method_details) */
interface IntentPayload {
  id?: string;
  amount?: number;
  amount_received?: number;
  customer?: string | { id?: string } | null;
  payment_method_types?: string[];
  cancellation_reason?: string | null;
  last_payment_error?: { code?: string; decline_code?: string } | null;
  metadata?: { invoice_id?: string };
}

const TYPES: Record<string, GatewayEvent['type']> = {
  'payment_intent.succeeded': 'payment.succeeded',
  'payment_intent.payment_failed': 'payment.failed',
  'payment_intent.canceled': 'payment.canceled',
};

/**
 * แปลงเหตุการณ์ของ Stripe (payment_intent.*) เป็นเหตุการณ์ของเรา · เรียกหลังตรวจลายเซ็นแล้วเท่านั้น
 * ยกเลิกเพราะ QR หมดอายุ (`abandoned`) หรือถูกแทนด้วย QR ใหม่ (`duplicate`) = `payment.expired` (ใบแจ้งหนี้ยังเปิดให้จ่ายต่อ)
 * ยกเลิกด้วยเหตุอื่น = `payment.canceled` (ใบแจ้งหนี้ void ตาม A33)
 */
export function parseStripeEvent(raw: Buffer): GatewayEvent {
  const e = JSON.parse(raw.toString('utf8')) as { id: string; type: string; data?: { object?: IntentPayload } };
  const obj = e.data?.object ?? {};
  let type = TYPES[e.type] ?? 'ignored';
  if (type === 'payment.canceled' && (obj.cancellation_reason === 'abandoned' || obj.cancellation_reason === 'duplicate')) type = 'payment.expired';
  const methods = obj.payment_method_types ?? [];
  const customer = typeof obj.customer === 'string' ? obj.customer : (obj.customer?.id ?? null);
  return {
    id: e.id,
    type,
    providerRef: obj.id ?? '',
    invoiceId: obj.metadata?.invoice_id ?? null,
    ...(obj.amount_received !== undefined && type === 'payment.succeeded' ? { amount: obj.amount_received } : {}),
    method: methods.includes('promptpay') ? 'promptpay' : methods.includes('card') ? 'card' : null,
    customerRef: customer,
    failureCode: obj.last_payment_error?.decline_code ?? obj.last_payment_error?.code ?? null,
  };
}
