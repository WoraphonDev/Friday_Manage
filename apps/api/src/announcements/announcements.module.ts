import { Controller, Get, HttpCode, Module, Param, Post, UseGuards } from '@nestjs/common';
import { schema } from '@friday/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantDb, TenantGuard } from '../common/tenant.js';

const { announcementTargets: t, announcementDismissals: d } = schema;

/** แบนเนอร์ที่ยังแสดง: ส่งแล้วและยังไม่หมดเวลา / ไม่ถูกทีม Friday หยุด (เวลาของฐานข้อมูล) */
const showing = and(sql`${t.bannerFrom} <= now()`, sql`${t.bannerUntil} > now()`);

/**
 * แบนเนอร์ประกาศจากทีม Friday (O24 · ส่งจาก Friday Ops › C8) · เฉพาะ Owner / Admin ของ Workspace
 * RLS ของ announcement_targets ให้เห็นเฉพาะ Workspace ปัจจุบันเมื่อเป็น Owner / Admin · ปิดได้ต่อคน (announcement_dismissals)
 */
@Controller('w/:ws/announcements')
@UseGuards(TenantGuard)
export class AnnouncementsController {
  constructor(private readonly db: TenantDb) {}

  /** แบนเนอร์ที่ยังไม่ได้ปิด ล่าสุดก่อน · สมาชิกอื่นได้รายการว่าง (ประกาศส่งถึง Owner / Admin เท่านั้น) */
  @Get()
  async list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') return { items: [] };
    const items = await this.db.run(auth, tenant, (tx) =>
      tx
        .select({ id: t.announcementId, title: t.bannerTitle, message: t.bannerMessage, sentAt: t.bannerFrom })
        .from(t)
        .leftJoin(d, and(eq(d.announcementId, t.announcementId), eq(d.workspaceId, t.workspaceId), eq(d.userId, auth.userId)))
        .where(and(eq(t.workspaceId, tenant.workspaceId), showing, isNull(d.userId)))
        .orderBy(desc(t.bannerFrom)),
    );
    return { items };
  }

  /** ปิดแบนเนอร์ของตัวเอง (คนอื่นใน Workspace ยังเห็น) · ปิดซ้ำได้ผลเดิม */
  @Post(':id/dismiss')
  @HttpCode(200)
  async dismiss(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'announcement_not_found', 'ไม่พบประกาศนี้');
    return this.db.run(auth, tenant, async (tx) => {
      const [banner] = await tx
        .select({ id: t.announcementId })
        .from(t)
        .where(and(eq(t.announcementId, id), eq(t.workspaceId, tenant.workspaceId), sql`${t.bannerFrom} is not null`));
      if (!banner) throw new AppError(404, 'announcement_not_found', 'ไม่พบประกาศนี้');
      await tx.insert(d).values({ announcementId: id, workspaceId: tenant.workspaceId, userId: auth.userId }).onConflictDoNothing();
      return { id, dismissed: true };
    });
  }
}

@Module({ controllers: [AnnouncementsController] })
export class AnnouncementsModule {}
