import { rm } from 'node:fs/promises';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { webUrl } from '../auth/auth.config.js';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { Mailer } from '../core/mail.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { LocalStorage } from '../files/storage.js';
import { Jobs } from '../queue/jobs.js';
import { assertOwner } from './shared.js';

const s = schema;
/** กู้คืนได้ภายใน 30 วันหลังลบ (03-api › DELETE w/) · ทีม Friday ยืด purge_after ได้ (O31 · Z7) */
export const RESTORE_DAYS = 30;
const DAY = 86_400_000;
/** อีเมลเตือน Owner ก่อนลบถาวร (Z5): 7 วัน และ 1 วัน */
export const PURGE_REMINDERS = [7, 1] as const;

export const DeleteWorkspaceBody = z.object({ confirmSlug: z.string().trim().min(1).max(63) }).strict();

const thaiDate = (d: Date) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(d);

/** ลบ / กู้คืน / ลบถาวรของ Workspace · วันลบถาวรอยู่ที่ workspaces.purge_after (O30) */
@Injectable()
export class WorkspaceLifecycleService implements OnModuleInit {
  private readonly log = new Logger('WorkspaceLifecycle');

  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly jobs: Jobs,
    private readonly mailer: Mailer,
  ) {}

  async onModuleInit() {
    // เตือนก่อน แล้วค่อยลบ: รอบเดียวกันจะไม่เตือน Workspace ที่กำลังจะลบไปแล้ว
    this.jobs.define('privacy.purge-workspaces', async () => ({ ...(await this.remind()), ...(await this.purge()) }));
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
    // SYSTEM_DB ไม่มี app.user_id ให้ trigger soft_delete จึงส่งผู้ลบและวันลบถาวรไปเอง
    const deletedAt = new Date();
    const purgeAfter = new Date(deletedAt.getTime() + RESTORE_DAYS * DAY);
    await this.sys.transaction(async (tx) => {
      await tx.update(s.workspaces).set({ deletedAt, deletedBy: auth.userId, purgeAfter, status: 'pending_delete', updatedAt: deletedAt }).where(eq(s.workspaces.id, tenant.workspaceId));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'workspace.deleted', targetType: 'workspace', targetId: tenant.workspaceId, summary: `ลบ Workspace ${tenant.slug} · กู้คืนได้ถึง ${purgeAfter.toISOString().slice(0, 10)}` });
    });
    return { slug: tenant.slug, deleted: true, deletedAt, restorableUntil: purgeAfter };
  }

  /** Workspace ที่ฉันเป็น Owner และถูกลบไว้ (ยังกู้คืนได้) · ผู้ใช้ไม่มี Workspace ปัจจุบันให้ตรวจ จึงอ่านด้วย SYSTEM_DB โดยกรอง Owner ของผู้เรียก */
  async deleted(auth: AuthInfo) {
    const rows = await this.sys
      .select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name, deletedAt: s.workspaces.deletedAt, purgeAfter: s.workspaces.purgeAfter })
      .from(s.workspaces)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.workspaces.id), eq(s.workspaceMembers.userId, auth.userId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')))
      .where(and(isNotNull(s.workspaces.deletedAt), sql`${s.workspaces.purgeAfter} > now()`))
      .orderBy(s.workspaces.purgeAfter);
    return {
      items: rows.map((r) => ({ slug: r.slug, name: r.name, deletedAt: r.deletedAt, restorableUntil: r.purgeAfter, daysLeft: Math.max(0, Math.ceil((r.purgeAfter!.getTime() - Date.now()) / DAY)) })),
    };
  }

  async restore(auth: AuthInfo, slug: string) {
    const [ws] = await this.sys
      .select({ id: s.workspaces.id, slug: s.workspaces.slug, deletedAt: s.workspaces.deletedAt, purgeAfter: s.workspaces.purgeAfter })
      .from(s.workspaces)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.workspaces.id), eq(s.workspaceMembers.userId, auth.userId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')))
      .where(and(sql`lower(${s.workspaces.slug}) = ${slug.toLowerCase()}`, isNotNull(s.workspaces.deletedAt)));
    if (!ws) throw notFound('Workspace ที่ถูกลบ');
    if (purgeAt(ws).getTime() <= Date.now()) throw new AppError(410, 'restore_expired', 'เกินกำหนดกู้คืนแล้ว · ข้อมูลกำลังถูกลบถาวร');
    // trigger soft_delete ล้าง deleted_by, purge_after, purge_reminded_at ให้เอง
    await this.sys.update(s.workspaces).set({ deletedAt: null, status: 'active', updatedAt: new Date() }).where(eq(s.workspaces.id, ws.id));
    await this.sys.insert(s.auditLogs).values({ workspaceId: ws.id, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'workspace.restored', targetType: 'workspace', targetId: ws.id, summary: `กู้คืน Workspace ${ws.slug}` });
    return { slug: ws.slug, restored: true };
  }

  /**
   * อีเมลเตือน Owner 7 วันและ 1 วันก่อนลบถาวร (Z5) · purge_reminded_at กันส่งซ้ำ
   * รอบ N วันส่งเมื่อ now ≥ purge_after − N วัน และยังไม่เคยเตือนหลังเวลานั้น · ทีม Friday ยืดเวลาแล้วรอบเตือนเลื่อนตามเอง
   * ข้ามหลายรอบในคราวเดียว (เช่น งานไม่ได้รัน) ส่งเฉพาะรอบที่ใกล้ที่สุด · รันด้วย SYSTEM_DB เพราะไม่มีผู้ใช้ในบริบท
   */
  async remind(now = new Date()) {
    const due = await this.sys
      .select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name, purgeAfter: s.workspaces.purgeAfter, remindedAt: s.workspaces.purgeRemindedAt })
      .from(s.workspaces)
      .where(and(isNotNull(s.workspaces.deletedAt), isNotNull(s.workspaces.purgeAfter), lte(s.workspaces.purgeAfter, new Date(now.getTime() + PURGE_REMINDERS[0] * DAY)), sql`${s.workspaces.purgeAfter} > ${now.toISOString()}::timestamptz`));
    let reminded = 0;
    for (const ws of due) {
      const purge = ws.purgeAfter!;
      // รอบที่ถึงแล้ว (ใกล้ที่สุดก่อน) และยังไม่ได้เตือนหลังจุดเริ่มของรอบนั้น
      const round = [...PURGE_REMINDERS].reverse().find((d) => now.getTime() >= purge.getTime() - d * DAY);
      if (round === undefined) continue;
      const start = purge.getTime() - round * DAY;
      if (ws.remindedAt && ws.remindedAt.getTime() >= start) continue;
      const owners = await this.sys
        .select({ email: s.users.email, name: s.users.displayName })
        .from(s.workspaceMembers)
        .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
        .where(and(eq(s.workspaceMembers.workspaceId, ws.id), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')));
      const daysLeft = Math.max(1, Math.ceil((purge.getTime() - now.getTime()) / DAY));
      const link = `${webUrl()}/work/${ws.slug}`;
      for (const o of owners) {
        try {
          await this.mailer.send({
            to: o.email,
            subject: `${ws.name} จะถูกลบถาวรใน ${daysLeft} วัน`,
            text: `สวัสดี ${o.name}\n\nข้อมูลทั้งหมดของ Workspace ${ws.name} จะถูกลบวันที่ ${thaiDate(purge)} และกู้คืนไม่ได้\nถ้าลบผิด กู้คืนได้ที่ลิงก์ด้านล่าง หรือส่งออกข้อมูลก่อนลบได้จากหน้าเดียวกัน\n\n${link}\n\nFriday Manage`,
          });
        } catch (err) {
          this.log.error(`ส่งอีเมลเตือนลบถาวร ${ws.slug} ไม่สำเร็จ: ${(err as Error).message}`);
        }
      }
      await this.sys.update(s.workspaces).set({ purgeRemindedAt: now }).where(eq(s.workspaces.id, ws.id));
      await this.sys.insert(s.auditLogs).values({ workspaceId: ws.id, actorId: null, actorKind: 'system', category: 'secu', action: 'workspace.purge_reminded', targetType: 'workspace', targetId: ws.id, summary: `เตือน Owner ${owners.length} คน · ลบถาวรใน ${daysLeft} วัน (${thaiDate(purge)})` });
      reminded++;
    }
    return { reminded };
  }

  /** ลบถาวรเมื่อพ้น purge_after (cascade ลบข้อมูลทั้งหมดของ Workspace) + ไฟล์ในที่เก็บ · รันด้วย SYSTEM_DB เพราะไม่มีผู้ใช้ในบริบท */
  async purge(now = new Date()) {
    const old = await this.sys.select({ id: s.workspaces.id, slug: s.workspaces.slug }).from(s.workspaces).where(and(isNotNull(s.workspaces.deletedAt), lt(s.workspaces.purgeAfter, now)));
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

/** วันลบถาวร · แถวเก่าก่อน O30 ที่ไม่มี purge_after ใช้ deleted_at + 30 วัน */
export function purgeAt(ws: { deletedAt: Date | null; purgeAfter: Date | null }) {
  return ws.purgeAfter ?? new Date(ws.deletedAt!.getTime() + RESTORE_DAYS * DAY);
}
