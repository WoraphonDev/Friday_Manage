import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { assertAdmin, assertOwner, audit } from './shared.js';

const s = schema;
export const SupportAccessBody = z
  .object({
    enabled: z.boolean(),
    /** ตลอดจนกว่าจะปิด · 7 วัน · 30 วัน */
    duration: z.enum(['forever', '7d', '30d']).default('forever'),
    /** แก้ไขได้ = ทีมต้องมีผู้อนุมัติ 2 คน (บังคับที่ฝั่งทีม Friday) */
    maxMode: z.enum(['read', 'write']).default('read'),
    notifyAdmins: z.boolean().default(true),
  })
  .strict();

/** การเข้าช่วยเหลือจากทีม Friday (N1 / Q3) · เปิดสิทธิ์ล่วงหน้า อ่านอย่างเดียวเป็นค่าเริ่มต้น */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
  ) {}

  async get(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    const grant = await this.db.run(auth, tenant, async (tx) => {
      const [g] = await tx.select().from(s.supportAccessGrants);
      return g ? { g, by: (await loadPeople(tx, [g.grantedBy])).get(g.grantedBy) ?? null } : null;
    });
    // support_sessions เป็นข้อมูลหลังบ้านของ Friday (เขียนโดยทีมเท่านั้น) · ลูกค้าอ่านได้เฉพาะของ Workspace ตัวเอง จึงอ่านด้วย SYSTEM_DB โดยกรอง workspace_id
    const sessions = await this.sys
      .select({ id: s.supportSessions.id, ticketNo: s.supportSessions.ticketNo, reason: s.supportSessions.reason, mode: s.supportSessions.mode, startedAt: s.supportSessions.startedAt, endedAt: s.supportSessions.endedAt, expiresAt: s.supportSessions.expiresAt, staff: s.staffUsers.name })
      .from(s.supportSessions)
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.supportSessions.staffId))
      .where(eq(s.supportSessions.workspaceId, tenant.workspaceId))
      .orderBy(desc(s.supportSessions.startedAt))
      .limit(20);
    const expired = !!grant?.g.until && grant.g.until.getTime() < Date.now();
    return {
      enabled: !!grant && !expired,
      expired,
      until: grant?.g.until ?? null,
      maxMode: grant?.g.maxMode ?? 'read',
      notifyAdmins: grant?.g.notifyAdmins ?? true,
      grantedBy: grant?.by ?? null,
      sessions: sessions.map((x) => {
        // หมดเวลาแล้วนับว่าจบที่เวลาหมด (หลังบ้านปิดให้เมื่อมีคนเปิดรายการ)
        const endedAt = x.endedAt ?? (x.expiresAt && x.expiresAt.getTime() <= Date.now() ? x.expiresAt : null);
        return { id: x.id, ticketNo: x.ticketNo, reason: x.reason, mode: x.mode, startedAt: x.startedAt, endedAt, expiresAt: x.expiresAt, durationMinutes: endedAt ? Math.round((endedAt.getTime() - x.startedAt.getTime()) / 60_000) : null, staffName: x.staff };
      }),
    };
  }

  /** เปิด / ปิด / แก้สิทธิ์ · Owner เท่านั้น (RLS บังคับซ้ำที่ฐานข้อมูล) · Audit ทุกครั้ง */
  async put(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof SupportAccessBody>) {
    assertOwner(tenant);
    await this.db.run(auth, tenant, async (tx) => {
      const [cur] = await tx.select().from(s.supportAccessGrants);
      if (!input.enabled) {
        if (cur) {
          await tx.delete(s.supportAccessGrants).where(eq(s.supportAccessGrants.id, cur.id));
          await audit(tx, auth, tenant, 'secu', 'support_access.revoked', 'ปิดสิทธิ์เข้าช่วยเหลือของทีม Friday', { type: 'workspace', id: tenant.workspaceId });
        }
        return;
      }
      const until = input.duration === 'forever' ? null : new Date(Date.now() + (input.duration === '7d' ? 7 : 30) * 86_400_000);
      const values = { until, maxMode: input.maxMode, notifyAdmins: input.notifyAdmins, updatedAt: new Date() };
      const [row] = cur
        ? await tx.update(s.supportAccessGrants).set({ ...values, grantedBy: auth.userId }).where(eq(s.supportAccessGrants.id, cur.id)).returning()
        : await tx.insert(s.supportAccessGrants).values({ workspaceId: tenant.workspaceId, grantedBy: auth.userId, ...values }).returning();
      await audit(tx, auth, tenant, 'secu', cur ? 'support_access.updated' : 'support_access.granted', `${cur ? 'แก้' : 'เปิด'}สิทธิ์เข้าช่วยเหลือของทีม Friday · ${input.maxMode === 'write' ? 'แก้ไขได้' : 'อ่านอย่างเดียว'} · ${until ? `ถึง ${until.toISOString().slice(0, 10)}` : 'จนกว่าจะปิด'}`, { type: 'support_access_grant', id: row.id });
    });
    return this.get(auth, tenant);
  }
}
