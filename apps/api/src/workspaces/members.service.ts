import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SessionService } from '../auth/sessions.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../common/tenant.js';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { openStatus } from '../common/status-category.js';

const s = schema;
type Role = 'owner' | 'admin' | 'member' | 'guest';
const UserId = z.uuid();

export const PatchWorkspaceBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    logoUrl: z.url().max(500).nullable(),
    defaultLocale: z.enum(['th', 'en']),
    allowDomainJoin: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

export const PatchMemberBody = z
  .object({
    role: z.enum(['owner', 'admin', 'member', 'guest']),
    jobTitle: z.string().trim().max(80).nullable(),
    department: z.string().trim().max(80).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

const isAdmin = (t: TenantInfo) => t.role === 'owner' || t.role === 'admin';

/** H · จัดการ Workspace และสมาชิก (04-permissions ข้อ 2) */
@Injectable()
export class MembersService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly limits: PlanLimits,
    private readonly sessions: SessionService,
  ) {}

  // ---------------------------------------------------------------------------
  // w/
  // ---------------------------------------------------------------------------
  async get(auth: AuthInfo, tenant: TenantInfo) {
    const [w] = await this.db.run(auth, tenant, (tx) => tx.select().from(s.workspaces));
    if (!w) throw notFound('Workspace');
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      logoUrl: w.logoUrl,
      dataRegion: w.dataRegion,
      defaultLocale: w.defaultLocale,
      allowDomainJoin: w.allowDomainJoin,
      status: w.status,
      /** ถูกระงับ (C6): หน้าเว็บแสดงแถบอ่านอย่างเดียว หรือหน้าติดต่อทีม */
      suspension: tenant.suspension ?? null,
      role: tenant.role,
      createdAt: w.createdAt,
    };
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof PatchWorkspaceBody>) {
    if (!isAdmin(tenant)) throw forbidden('ws.settings');
    await this.db.run(auth, tenant, async (tx) => {
      await tx.update(s.workspaces).set(body).where(eq(s.workspaces.id, tenant.workspaceId));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'workspace.updated', targetType: 'workspace', targetId: tenant.workspaceId, summary: Object.keys(body).join(', ') });
    });
    return this.get(auth, tenant);
  }

  // ---------------------------------------------------------------------------
  // w/members/{userId}
  // ---------------------------------------------------------------------------
  private async target(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], userId: string) {
    const [row] = await tx
      .select({ userId: s.workspaceMembers.userId, role: s.workspaceMembers.role, status: s.workspaceMembers.status, email: s.users.email, displayName: s.users.displayName })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(eq(s.workspaceMembers.userId, userId));
    if (!row) throw notFound('สมาชิก');
    return row;
  }

  private async activeOwners(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], exceptUserId?: string) {
    const rows = await tx
      .select({ id: s.workspaceMembers.userId })
      .from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active'), exceptUserId ? ne(s.workspaceMembers.userId, exceptUserId) : undefined));
    return rows.length;
  }

  /** เปลี่ยน Role · Owner คนสุดท้ายลดไม่ได้ · Admin ตั้ง/แก้ Owner ไม่ได้ · Guest → ผู้ใช้ Seat ตรวจ Seat (402) */
  async patchMember(auth: AuthInfo, tenant: TenantInfo, userIdRaw: string, body: z.infer<typeof PatchMemberBody>) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    const userId = parse(UserId, userIdRaw);
    return this.db.run(auth, tenant, async (tx) => {
      const t = await this.target(tx, userId);
      const next = body.role as Role | undefined;
      if (next && next !== t.role) {
        if (tenant.role === 'admin' && (t.role === 'owner' || next === 'owner')) throw new AppError(403, 'forbidden', 'Admin เปลี่ยน Role ของ Owner หรือตั้งใครเป็น Owner ไม่ได้', { permission: 'ws.owner' });
        if (t.role === 'owner' && (await this.activeOwners(tx, userId)) === 0) throw new AppError(409, 'last_owner', 'Workspace ต้องมี Owner อย่างน้อย 1 คน · ตั้ง Owner คนใหม่ก่อน');
        // Guest ไม่นับ Seat · เปลี่ยนเป็น Member / Admin / Owner ต้องมี Seat ว่าง (เฉพาะคนที่ยัง active)
        if (t.role === 'guest' && t.status === 'active') await this.limits.assert(tx, tenant.workspaceId, 'seats');
      }
      const [row] = await tx
        .update(s.workspaceMembers)
        .set({ ...(next ? { role: next } : {}), ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle } : {}), ...(body.department !== undefined ? { department: body.department } : {}) })
        .where(eq(s.workspaceMembers.userId, userId))
        .returning();
      if (next && next !== t.role) {
        await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action: 'perm.role_changed', targetType: 'user', targetId: userId, summary: `${t.email}: ${t.role} → ${next}` });
      }
      return { userId, role: row.role, status: row.status, jobTitle: row.jobTitle, department: row.department };
    });
  }

  /** งานค้างของคนที่จะปิดการใช้งาน (หน้า P3 โอนงาน) */
  async handover(auth: AuthInfo, tenant: TenantInfo, userIdRaw: string) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    const userId = parse(UserId, userIdRaw);
    return this.db.run(auth, tenant, async (tx) => {
      const t = await this.target(tx, userId);
      const issues = await tx
        .select({ key: sql<string>`${s.projects.key} || '-' || ${s.issues.number}`, title: s.issues.title, project: s.projects.key, planEnd: s.issues.planEnd, category: s.workflowStatuses.category })
        .from(s.issueAssignees)
        .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
        .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .where(and(eq(s.issueAssignees.userId, userId), isNull(s.issues.deletedAt), isNull(s.projects.deletedAt), openStatus()))
        .orderBy(asc(s.issues.planEnd), asc(s.issues.number))
        .limit(200);
      const owned = await tx.select({ key: s.projects.key, name: s.projects.name }).from(s.projects).where(and(eq(s.projects.ownerUserId, userId), isNull(s.projects.deletedAt)));
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.issueAssignees)
        .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .where(and(eq(s.issueAssignees.userId, userId), isNull(s.issues.deletedAt), openStatus()));
      return {
        member: { userId, displayName: t.displayName, role: t.role },
        assignedIssues: { total: n, items: issues.map(({ category: _c, ...i }) => i) },
        ownedProjects: owned,
      };
    });
  }

  /**
   * ปิดการใช้งานใน Workspace นี้ · Session และการผูก LINE เป็นของบัญชี (ใช้ข้าม Workspace)
   * จึงยกเลิกเฉพาะเมื่อคนนี้ไม่เหลือ Workspace อื่นที่ยัง active (สเปกเขียนยกเลิกทั้งหมดโดยไม่คิดกรณีหลาย Workspace)
   */
  async deactivate(auth: AuthInfo, tenant: TenantInfo, userIdRaw: string) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    const userId = parse(UserId, userIdRaw);
    if (userId === auth.userId) throw new AppError(409, 'cannot_deactivate_self', 'ปิดการใช้งานตัวเองไม่ได้');
    const handover = await this.handover(auth, tenant, userId);
    await this.db.run(auth, tenant, async (tx) => {
      const t = await this.target(tx, userId);
      if (t.status === 'deactivated') throw new AppError(409, 'already_deactivated', 'สมาชิกนี้ถูกปิดการใช้งานอยู่แล้ว');
      if (tenant.role === 'admin' && t.role === 'owner') throw new AppError(403, 'forbidden', 'Admin ปิดการใช้งานของ Owner ไม่ได้', { permission: 'ws.owner' });
      if (t.role === 'owner' && (await this.activeOwners(tx, userId)) === 0) throw new AppError(409, 'last_owner', 'Workspace ต้องมี Owner อย่างน้อย 1 คน');
      await tx.update(s.workspaceMembers).set({ status: 'deactivated' }).where(eq(s.workspaceMembers.userId, userId));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action: 'perm.member_deactivated', targetType: 'user', targetId: userId, summary: t.email });
    });
    const [other] = await this.system
      .select({ id: s.workspaceMembers.workspaceId })
      .from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.userId, userId), eq(s.workspaceMembers.status, 'active')))
      .limit(1);
    let signedOut = false;
    if (!other) {
      await this.sessions.revokeAll(userId);
      await this.system.delete(s.lineBindings).where(eq(s.lineBindings.userId, userId));
      signedOut = true;
    }
    return { userId, status: 'deactivated' as const, signedOut, handover };
  }

  async reactivate(auth: AuthInfo, tenant: TenantInfo, userIdRaw: string) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    const userId = parse(UserId, userIdRaw);
    return this.db.run(auth, tenant, async (tx) => {
      const t = await this.target(tx, userId);
      if (t.status === 'active') throw new AppError(409, 'already_active', 'สมาชิกนี้ใช้งานอยู่แล้ว');
      if (t.role !== 'guest') await this.limits.assert(tx, tenant.workspaceId, 'seats');
      await tx.update(s.workspaceMembers).set({ status: 'active' }).where(eq(s.workspaceMembers.userId, userId));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action: 'perm.member_reactivated', targetType: 'user', targetId: userId, summary: t.email });
      return { userId, status: 'active' as const };
    });
  }
}

