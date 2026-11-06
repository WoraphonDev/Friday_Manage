import { schema, type Tx, type Db } from '@friday/db';
import type { Staff } from './auth/auth.guard.js';

type Category = (typeof schema.auditLogs.$inferInsert)['category'];

/** ทุกคำขอเขียนของทีม Friday ต้องมีรอยใน audit_logs ของ Workspace ที่ถูกแตะ (actor_kind = friday_staff) · ลูกค้าเห็นในหน้า Audit log */
export async function audit(db: Db | Tx, staff: Staff, workspaceId: string, category: Category, action: string, summary: string, target?: { type: string; id: string }) {
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
}
