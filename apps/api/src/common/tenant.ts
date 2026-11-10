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
    assertNotSuspended(row, req.method, req.path);
    req.tenant = row;
    return true;
  }
}

/**
 * ทางที่ยังใช้ได้ตอนถูกระงับ (ต่อจาก /w/:ws/): ชำระเงิน / ใบแจ้งหนี้ / ยกเลิกแพ็กเกจ, ส่งออกข้อมูลและคำขอตาม PDPA, สิทธิ์เข้าช่วยเหลือของทีม Friday
 * ให้ลูกค้าแก้ปัญหาที่ทำให้ถูกระงับและเอาข้อมูลของตัวเองออกได้เสมอ
 */
const SUSPENDED_ALLOWED = /^(billing(\/|$)|usage$|exports(\/|$)|data-requests(\/|$)|support-access$|cancellation-feedback$|events$)/;
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * ระงับ Workspace (C6)
 * - read_only: อ่านได้ทุกอย่าง · เขียนได้เฉพาะทางใน SUSPENDED_ALLOWED
 * - full: เฉพาะ Owner และเฉพาะหน้าข้อมูล Workspace (ไว้แสดงหน้าติดต่อทีม) + ทางใน SUSPENDED_ALLOWED · คนอื่นเข้าไม่ได้เลย
 */
export function assertNotSuspended(tenant: TenantInfo, method: string, path: string) {
  const sus = tenant.suspension;
  if (!sus) return;
  const rest = /\/w\/[^/]+\/?(.*)$/.exec(path)?.[1] ?? '';
  const allowed = SUSPENDED_ALLOWED.test(rest);
  const details = { mode: sus.mode, message: sus.message };
  if (sus.mode === 'full') {
    if (tenant.role !== 'owner') throw new AppError(403, 'workspace_suspended', 'Workspace นี้ถูกระงับ ติดต่อ Owner ของ Workspace', details);
    if (allowed || (rest === '' && READ.has(method))) return;
    throw new AppError(403, 'workspace_suspended', 'Workspace นี้ถูกระงับ กรุณาติดต่อทีม Friday', details);
  }
  if (READ.has(method) || allowed) return;
  throw new AppError(403, 'workspace_suspended', 'Workspace นี้ถูกระงับ ดูและส่งออกข้อมูลได้ แต่แก้ไขไม่ได้จนกว่าจะเปิดใช้งานอีกครั้ง', details);
}

/** Workspace จาก slug ที่ผู้ใช้เป็นสมาชิก active (null = ไม่พบหรือไม่ใช่สมาชิก) */
export async function resolveTenant(db: Db, userId: string, slug: string): Promise<TenantInfo | null> {
  const [row] = await withTenant(db, { userId, workspaceId: null }, (tx) =>
    tx
      .select({ workspaceId: workspaces.id, slug: workspaces.slug, role: workspaceMembers.role, status: workspaces.status, mode: workspaces.suspensionMode, message: workspaces.suspensionMessage })
      .from(workspaces)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
      .where(and(sql`lower(${workspaces.slug}) = ${slug.toLowerCase()}`, eq(workspaceMembers.status, 'active'), sql`${workspaces.deletedAt} is null`)),
  );
  if (!row) return null;
  // ระงับก่อนมีโหมด (ไม่ควรเกิดหลัง migration 0021) ถือเป็นอ่านอย่างเดียว
  const suspension = row.status === 'suspended' ? { mode: (row.mode === 'full' ? 'full' : 'read_only') as 'full' | 'read_only', message: row.message } : null;
  return { workspaceId: row.workspaceId, slug: row.slug, role: row.role, suspension };
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
    // ระงับแบบปิดทั้งหมด: สมาชิกที่ไม่ใช่ Owner อ่านข้อมูลระดับผู้ใช้ของ Workspace นี้ไม่ได้ (เช่น Inbox)
    if (row.suspension?.mode === 'full' && row.role !== 'owner') throw new AppError(403, 'workspace_suspended', 'Workspace นี้ถูกระงับ ติดต่อ Owner ของ Workspace', { mode: 'full', message: row.suspension.message });
    return row;
  }
}
