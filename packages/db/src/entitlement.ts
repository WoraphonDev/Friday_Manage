// สิทธิ์แพ็กเกจจากใบแจ้งหนี้ (N01/N02 · full-system-audit-2026-11-06) · ใช้ร่วมกันระหว่าง apps/api และ apps/ops-api
// กติกา: ใบที่ใหม่กว่า (created_at, id) และยังมีผล (ชำระแล้ว / รอตรวจสลิป) ชนะเสมอ ใบเก่าที่มาทีหลังเปิดสิทธิ์ทับไม่ได้
// ทุกฟังก์ชันต้องเรียกในธุรกรรม และล็อกแถว subscription ก่อน (lockSubscription) ให้ลำดับเหตุการณ์ที่มาพร้อมกันเรียงกัน
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from './client.ts';
import { invoices, subscriptions } from './schema/billing.ts';

type Invoice = typeof invoices.$inferSelect;
const LIVE = ['paid', 'pending_review'] as const;

const newer = (a: Invoice, b: Invoice) => a.createdAt.getTime() > b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id > b.id);

export async function lockSubscription(tx: Tx, subscriptionId: string) {
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for('update');
  return sub ?? null;
}

/** ใบนี้เปิด/เปลี่ยนสิทธิ์ได้ไหม · false = มีใบที่ใหม่กว่าและยังมีผลเป็นแหล่งสิทธิ์อยู่ (ใบนี้ถูกแทนที่แล้ว) */
export async function canGrant(tx: Tx, invoice: Invoice): Promise<boolean> {
  const sub = await lockSubscription(tx, invoice.subscriptionId);
  if (!sub?.sourceInvoiceId || sub.sourceInvoiceId === invoice.id) return true;
  const [source] = await tx.select().from(invoices).where(eq(invoices.id, sub.sourceInvoiceId));
  if (!source || !(LIVE as readonly string[]).includes(source.status)) return true;
  return !newer(source, invoice);
}

/** ใบนี้เป็นแหล่งสิทธิ์ปัจจุบันจริงหรือไม่ (ใช้ตอนปฏิเสธสลิป) */
export async function isGrantSource(tx: Tx, invoice: Invoice): Promise<boolean> {
  const sub = await lockSubscription(tx, invoice.subscriptionId);
  return !!sub && sub.status === 'active' && sub.sourceInvoiceId === invoice.id;
}

/** ใบที่ชำระแล้วล่าสุด (ยกเว้นใบที่ระบุ) ที่รอบยังไม่จบ · ใช้คืนสิทธิ์เมื่อแหล่งสิทธิ์เดิมถูกปฏิเสธ */
export async function fallbackGrant(tx: Tx, subscriptionId: string, exceptInvoiceId: string): Promise<Invoice | null> {
  const [row] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, subscriptionId), ne(invoices.id, exceptInvoiceId), inArray(invoices.status, ['paid']), gte(invoices.periodEnd, sql`(now() AT TIME ZONE 'Asia/Bangkok')::date`)))
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(1);
  return row ?? null;
}
