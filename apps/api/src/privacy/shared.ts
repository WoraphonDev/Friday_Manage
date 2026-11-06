import { schema, type Tx } from '@friday/db';
import { forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';

export function assertAdmin(tenant: TenantInfo, permission = 'ws.settings') {
  if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden(permission);
}
export function assertOwner(tenant: TenantInfo) {
  if (tenant.role !== 'owner') throw forbidden('ws.owner');
}

type Category = (typeof schema.auditLogs.$inferInsert)['category'];
export async function audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, category: Category, action: string, summary: string, target?: { type: string; id: string }) {
  await tx.insert(schema.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category, action, targetType: target?.type ?? null, targetId: target?.id ?? null, summary });
}
