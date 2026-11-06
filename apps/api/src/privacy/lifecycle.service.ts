import { rm } from 'node:fs/promises';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { LocalStorage } from '../files/storage.js';
import { Jobs } from '../queue/jobs.js';
import { assertOwner } from './shared.js';

const s = schema;
/** กู้คืนได้ภายใน 30 วันหลังลบ (03-api › DELETE w/) */
export const RESTORE_DAYS = 30;
const DAY = 86_400_000;

export const DeleteWorkspaceBody = z.object({ confirmSlug: z.string().trim().min(1).max(63) }).strict();

/** ลบ / กู้คืน / ลบถาวรของ Workspace */
@Injectable()
export class WorkspaceLifecycleService implements OnModuleInit {
  private readonly log = new Logger('WorkspaceLifecycle');

  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    this.jobs.define('privacy.purge-workspaces', () => this.purge());
    await this.jobs.every('privacy.purge-workspaces', '0 4 * * *');
  }

  /** Owner เท่านั้น · ต้องพิมพ์ slug ยืนยัน · แพ็กเกจที่ชำระอยู่ต้องยกเลิกก่อน */
  async remove(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof DeleteWorkspaceBody>) {
    assertOwner(tenant);
    await this.db.run(auth, tenant, async (tx) => {
      if (input.confirmSlug.toLowerCase() !== tenant.slug.toLowerCase()) throw new AppError(400, 'confirm_required', 'พิมพ์ slug ของ Workspace เพื่อยืนยันการลบ', { slug: tenant.slug });
      const [sub] = await tx.select({ status: s.subscriptions.status }).from(s.subscriptions);
      if (sub && (sub.status === 'active' || sub.status === 'past_due')) {
        throw new AppError(409, 'subscription_active', 'ยกเลิกแพ็กเกจก่อนลบ Workspace', { status: sub.status, next: 'cancel_subscription' });
      }
    });
    // นโยบาย RLS ซ่อนแถว Workspace ที่ deleted_at ไม่ว่าง จึงเขียนผ่านแอปไม่ได้ (WITH CHECK ไม่ผ่าน) · ตรวจสิทธิ์ Owner ข้างบนแล้ว จึงเขียนด้วย SYSTEM_DB พร้อม Audit ในธุรกรรมเดียว
    const deletedAt = new Date();
    const restorableUntil = new Date(deletedAt.getTime() + RESTORE_DAYS * DAY);
    await this.sys.transaction(async (tx) => {
      await tx.update(s.workspaces).set({ deletedAt, status: 'pending_delete', updatedAt: deletedAt }).where(eq(s.workspaces.id, tenant.workspaceId));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'workspace.deleted', targetType: 'workspace', targetId: tenant.workspaceId, summary: `ลบ Workspace ${tenant.slug} · กู้คืนได้ถึง ${restorableUntil.toISOString().slice(0, 10)}` });
    });
    return { slug: tenant.slug, deleted: true, deletedAt, restorableUntil };
  }

  /** Workspace ที่ฉันเป็น Owner และถูกลบไว้ (ยังกู้คืนได้) · ผู้ใช้ไม่มี Workspace ปัจจุบันให้ตรวจ จึงอ่านด้วย SYSTEM_DB โดยกรอง Owner ของผู้เรียก */
  async deleted(auth: AuthInfo) {
    const rows = await this.sys
      .select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name, deletedAt: s.workspaces.deletedAt })
      .from(s.workspaces)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.workspaces.id), eq(s.workspaceMembers.userId, auth.userId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')))
      .where(and(isNotNull(s.workspaces.deletedAt), sql`${s.workspaces.deletedAt} > now() - make_interval(days => ${RESTORE_DAYS})`));
    return { items: rows.map((r) => ({ slug: r.slug, name: r.name, deletedAt: r.deletedAt, restorableUntil: new Date(r.deletedAt!.getTime() + RESTORE_DAYS * DAY) })) };
  }

  async restore(auth: AuthInfo, slug: string) {
    const [ws] = await this.sys
      .select({ id: s.workspaces.id, slug: s.workspaces.slug, deletedAt: s.workspaces.deletedAt })
      .from(s.workspaces)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.workspaces.id), eq(s.workspaceMembers.userId, auth.userId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')))
      .where(and(sql`lower(${s.workspaces.slug}) = ${slug.toLowerCase()}`, isNotNull(s.workspaces.deletedAt)));
    if (!ws) throw notFound('Workspace ที่ถูกลบ');
    if (ws.deletedAt!.getTime() + RESTORE_DAYS * DAY < Date.now()) throw new AppError(410, 'restore_expired', `เกินกำหนดกู้คืน ${RESTORE_DAYS} วันแล้ว`);
    await this.sys.update(s.workspaces).set({ deletedAt: null, status: 'active', updatedAt: new Date() }).where(eq(s.workspaces.id, ws.id));
    await this.sys.insert(s.auditLogs).values({ workspaceId: ws.id, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'workspace.restored', targetType: 'workspace', targetId: ws.id, summary: `กู้คืน Workspace ${ws.slug}` });
    return { slug: ws.slug, restored: true };
  }

  /** ลบถาวรเมื่อพ้น 30 วัน (cascade ลบข้อมูลทั้งหมดของ Workspace) + ไฟล์ในที่เก็บ · รันด้วย SYSTEM_DB เพราะไม่มีผู้ใช้ในบริบท */
  async purge() {
    const old = await this.sys.select({ id: s.workspaces.id, slug: s.workspaces.slug }).from(s.workspaces).where(and(isNotNull(s.workspaces.deletedAt), lt(s.workspaces.deletedAt, new Date(Date.now() - RESTORE_DAYS * DAY))));
    const storage = new LocalStorage();
    let purged = 0;
    for (const ws of old) {
      try {
        const keys = await this.sys.select({ key: s.fileVersions.storageKey }).from(s.fileVersions).where(eq(s.fileVersions.workspaceId, ws.id));
        await this.sys.transaction(async (tx) => {
          // audit_logs เป็น append-only สำหรับแอป แต่ cascade จากการลบ Workspace ต้องเก็บกวาดด้วย
          await tx.delete(s.workspaces).where(and(eq(s.workspaces.id, ws.id), isNotNull(s.workspaces.deletedAt)));
        });
        for (const k of keys) await rm(storage.path(k.key), { force: true }).catch(() => undefined);
        purged++;
        this.log.log(`ลบถาวร Workspace ${ws.slug}`);
      } catch (err) {
        this.log.error(`ลบถาวร ${ws.slug} ไม่สำเร็จ: ${(err as Error).message}`);
      }
    }
    return { purged };
  }
}

