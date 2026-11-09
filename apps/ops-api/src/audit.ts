import { schema, type Tx, type Db } from '@friday/db';
import { effectiveRoles, type Staff } from './auth/auth.guard.js';

type Category = (typeof schema.auditLogs.$inferInsert)['category'];

/** ใครอนุมัติรายการนี้ (เมื่อทำเกินวงเงิน) */
export interface Approval {
  approvedBy: string;
  selfApproved: boolean;
}

/**
 * ทุกคำขอเขียนของทีม Friday ต้องมีรอยใน audit_logs ของ Workspace ที่ถูกแตะ (actor_kind = friday_staff · ลูกค้าเห็นในหน้า Audit log)
 * และใน staff_audit_logs (บทบาทตอนทำ ผู้อนุมัติ อนุมัติตัวเองหรือไม่) สำหรับหน้า Audit log ของทีม
 */
export async function audit(db: Db | Tx, staff: Staff, workspaceId: string, category: Category, action: string, summary: string, target?: { type: string; id: string }, approval?: Approval) {
  await db.insert(schema.auditLogs).values({
    workspaceId,
    actorId: staff.id,
    actorKind: 'friday_staff',
    category,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    summary: `[Friday ${staff.name}] ${summary}`,
  });
  await staffAudit(db, staff, action, summary, target, workspaceId, approval);
}

/** การกระทำของทีม Friday ที่ไม่ผูก Workspace (พนักงาน บทบาท ตั้งค่า) · append-only */
export async function staffAudit(db: Db | Tx, staff: Staff | null, action: string, reason: string, target?: { type: string; id: string }, workspaceId?: string, approval?: Approval) {
  await db.insert(schema.staffAuditLogs).values({
    staffId: staff?.id ?? null,
    roles: staff ? effectiveRoles(staff) : [],
    action,
    reason,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    workspaceId: workspaceId ?? null,
    approvedBy: approval?.approvedBy ?? null,
    selfApproved: approval?.selfApproved ?? false,
  });
}
