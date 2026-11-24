import { type Db, schema as s } from '@friday/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * QR หมดอายุ / ถูกแทน: รายการนี้ปิด (rejected) แต่ใบแจ้งหนี้ยังเปิด ลูกค้ากดสร้าง QR ใหม่ได้ (`pay` + `renew`)
 * ใช้ทั้งงานกวาด QR และ Webhook `payment_intent.canceled` · เรียกซ้ำได้ (ครั้งที่สองไม่เปลี่ยนอะไร)
 */
export async function markQrExpired(db: Db, p: { id: string; workspaceId: string; invoiceId: string; providerRef: string | null }) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.payments)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(eq(s.payments.id, p.id), eq(s.payments.status, 'pending_review'), isNull(s.payments.exceptionReason), p.providerRef ? eq(s.payments.providerRef, p.providerRef) : isNull(s.payments.providerRef)))
      .returning({ id: s.payments.id });
    if (!row) return false;
    await tx.insert(s.auditLogs).values({ workspaceId: p.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.qr_expired', targetType: 'invoice', targetId: p.invoiceId, summary: `promptpay ${p.providerRef} · QR หมดอายุ (15 นาที)` });
    return true;
  });
}
