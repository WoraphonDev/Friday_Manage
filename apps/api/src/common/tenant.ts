import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx, withTenant } from '@friday/db';
import { and, eq, sql } from 'drizzle-orm';
import { APP_DB } from '../db/db.module.js';
import { AppError } from './errors.js';
import type { AppRequest, AuthInfo, TenantInfo } from './request.js';

const { workspaces, workspaceMembers } = schema;

/**
 * ใช้กับ route /w/:ws/... · หา Workspace จาก slug และตรวจว่าเป็นสมาชิก active
 * ไม่ใช่สมาชิกตอบ 404 (ไม่บอกว่ามี Workspace นี้อยู่)
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const row = await resolveTenant(this.db, req.auth!.userId, String(req.params.ws ?? ''));
    if (!row) throw new AppError(404, 'workspace_not_found', 'ไม่พบ Workspace');
    req.tenant = row;
    return true;
  }
}

/** Workspace จาก slug ที่ผู้ใช้เป็นสมาชิก active (null = ไม่พบหรือไม่ใช่สมาชิก) */
export async function resolveTenant(db: Db, userId: string, slug: string): Promise<TenantInfo | null> {
  const [row] = await withTenant(db, { userId, workspaceId: null }, (tx) =>
    tx
      .select({ workspaceId: workspaces.id, slug: workspaces.slug, role: workspaceMembers.role })
      .from(workspaces)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
      .where(and(sql`lower(${workspaces.slug}) = ${slug.toLowerCase()}`, eq(workspaceMembers.status, 'active'), sql`${workspaces.deletedAt} is null`)),
  );
  return row ?? null;
}

/** รันงานใน Workspace ปัจจุบันภายใต้ RLS */
@Injectable()
export class TenantDb {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  run<T>(auth: AuthInfo, tenant: TenantInfo | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { userId: auth.userId, workspaceId: tenant?.workspaceId ?? null }, fn);
  }

  /** สำหรับ route ระดับผู้ใช้ที่รับ ?workspace=slug (เช่น Inbox) · ไม่ใช่สมาชิกตอบ 404 */
  async tenant(auth: AuthInfo, slug: string) {
    const row = await resolveTenant(this.db, auth.userId, slug);
    if (!row) throw new AppError(404, 'workspace_not_found', 'ไม่พบ Workspace');
    return row;
  }
}
