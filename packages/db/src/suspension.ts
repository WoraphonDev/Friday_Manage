// ระงับ Workspace (C6) · ใช้ร่วมกันระหว่าง apps/api (ชำระผ่าน Gateway) และ apps/ops-api (ทีมยืนยันการชำระ)
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from './client.ts';
import { auditLogs } from './schema/audit.ts';
import { invoices } from './schema/billing.ts';
import { workspaces } from './schema/workspace.ts';

/**
 * หลังชำระใบแจ้งหนี้: Workspace ที่ระงับแบบ "เปิดเองเมื่อชำระ" และไม่เหลือใบที่เลยกำหนด → เปิดใช้งาน
 * ต้องเรียกด้วยการเชื่อมต่อที่ข้าม RLS (SYSTEM_DB / ops) ในธุรกรรมเดียวกับที่ตั้งใบแจ้งหนี้เป็น paid · คืน true ถ้าเปิด
 */
export async function resumeIfPaid(tx: Tx, workspaceId: string): Promise<boolean> {
  const [ws] = await tx.select({ status: workspaces.status, autoResume: workspaces.suspensionAutoResume }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
  if (!ws || ws.status !== 'suspended' || !ws.autoResume) return false;
  const today = sql`(now() at time zone 'Asia/Bangkok')::date`;
  const [late] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.workspaceId, workspaceId), inArray(invoices.status, ['open', 'pending_review']), lt(invoices.dueDate, today)))
    .limit(1);
  if (late) return false;
  await tx.update(workspaces).set({ status: 'active', suspensionMode: null, suspensionMessage: null, suspensionAutoResume: false, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  await tx.insert(auditLogs).values({ workspaceId, actorKind: 'system', category: 'secu', action: 'billing.resumed_paid', targetType: 'workspace', targetId: workspaceId, summary: 'เปิดใช้งาน Workspace อีกครั้งหลังชำระใบแจ้งหนี้ที่ค้างครบ' });
  return true;
}
