import { schema, type Tx } from '@friday/db';
import { forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';

/** Admin Console ทุกข้อเป็นของ Owner / Admin (`ws.settings`) ยกเว้นที่ระบุ */
export function assertAdmin(tenant: TenantInfo, permission = 'ws.settings') {
  if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden(permission);
}

type Category = (typeof schema.auditLogs.$inferInsert)['category'];

/** ทุกการแก้ใน Admin Console เขียน Audit log (append-only) */
export async function audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, category: Category, action: string, summary: string, target?: { type: string; id: string }) {
  await tx.insert(schema.auditLogs).values({
    workspaceId: tenant.workspaceId,
    actorId: auth.userId,
    actorKind: 'user',
    category,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    summary,
  });
}
