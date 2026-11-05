import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hashToken, newToken } from '../auth/sessions.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService } from '../projects/projects.service.js';

const s = schema;

export const CreateInvitationsBody = z.object({
  emails: z.array(z.email().max(254)).min(1).max(50),
  workspaceRole: z.enum(['admin', 'member', 'guest']).default('member'),
  projectKey: z.string().optional(),
  projectRole: z.enum(['admin', 'member', 'viewer']).default('member'),
  jobTitle: z.string().trim().max(80).optional(),
  capacityHoursWeek: z.number().int().min(0).max(80).optional(),
  message: z.string().trim().max(1000).optional(),
  /** H: ลิงก์หมดอายุ 1 / 7 / 30 วัน */
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
});

@Injectable()
export class InvitationsService {
  private readonly log = new Logger('Invitations');

  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * H / 7 · เชิญหลายอีเมลในครั้งเดียว
   * Owner / Admin เชิญได้ทุกแบบ · คนที่มีสิทธิ์ project.invite เชิญเข้าโปรเจกต์ตัวเองได้ แต่ตั้งเป็น Admin ของ Workspace ไม่ได้
   * ส่งอีเมลปิดไว้ช่วงแรก (docs/tech-stack.md) จึงคืน inviteUrl ให้ผู้เชิญส่งต่อเอง
   */
  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateInvitationsBody>, baseUrl: string) {
    const isWsAdmin = tenant.role === 'owner' || tenant.role === 'admin';
    return this.db.run(auth, tenant, async (tx) => {
      let project: { id: string; key: string } | null = null;
      if (input.projectKey) {
        const loaded = await this.projects.load(tx, auth, tenant, input.projectKey);
        if (!isWsAdmin) requirePerm(loaded.access, 'project.invite');
        project = loaded.project;
      } else if (!isWsAdmin) {
        throw forbidden('ws.members.manage');
      }
      if (!isWsAdmin && input.workspaceRole === 'admin') throw forbidden('ws.members.manage');

      const results = [];
      for (const raw of [...new Set(input.emails.map((e) => e.toLowerCase()))]) {
        const [member] = await tx
          .select({ userId: s.workspaceMembers.userId, status: s.workspaceMembers.status })
          .from(s.workspaceMembers)
          .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
          .where(and(sql`lower(${s.users.email}) = ${raw}`, eq(s.workspaceMembers.status, 'active')));
        if (member) {
          results.push({ email: raw, status: 'already_member' as const });
          continue;
        }
        const token = newToken();
        const values = {
          workspaceId: tenant.workspaceId,
          email: raw,
          workspaceRole: input.workspaceRole,
          projectId: project?.id ?? null,
          projectRole: project ? input.projectRole : null,
          jobTitle: input.jobTitle,
          capacityHoursWeek: input.capacityHoursWeek,
          message: input.message,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
          invitedBy: auth.userId,
        };
        // มีคำเชิญที่รออยู่แล้ว = ส่งใหม่ (ออก token ใหม่ ของเดิมใช้ไม่ได้)
        const [pending] = await tx
          .select({ id: s.invitations.id })
          .from(s.invitations)
          .where(and(sql`lower(${s.invitations.email}) = ${raw}`, eq(s.invitations.status, 'pending')));
        const [inv] = pending
          ? await tx.update(s.invitations).set({ ...values, createdAt: new Date() }).where(eq(s.invitations.id, pending.id)).returning({ id: s.invitations.id })
          : await tx.insert(s.invitations).values(values).returning({ id: s.invitations.id });
        await tx.insert(s.auditLogs).values({
          workspaceId: tenant.workspaceId,
          actorId: auth.userId,
          actorKind: 'user',
          category: 'perm',
          action: 'member.invited',
          targetType: 'invitation',
          targetId: inv.id,
          summary: `${raw} · ${input.workspaceRole}${project ? ` · ${project.key} ${input.projectRole}` : ''}`,
        });
        this.log.log(`invitation ${inv.id} for ${raw} (email sending disabled)`);
        results.push({ email: raw, status: 'invited' as const, invitationId: inv.id, inviteUrl: `${baseUrl}/join/${token}`, expiresAt: values.expiresAt });
      }
      return { items: results };
    });
  }

  async listPending(auth: AuthInfo, tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.members.manage');
    return this.db.run(auth, tenant, async (tx) => ({
      items: await tx
        .select({
          id: s.invitations.id,
          email: s.invitations.email,
          workspaceRole: s.invitations.workspaceRole,
          projectId: s.invitations.projectId,
          projectRole: s.invitations.projectRole,
          invitedBy: s.invitations.invitedBy,
          expiresAt: s.invitations.expiresAt,
          createdAt: s.invitations.createdAt,
        })
        .from(s.invitations)
        .where(eq(s.invitations.status, 'pending'))
        .orderBy(desc(s.invitations.createdAt)),
    }));
  }

  async revoke(auth: AuthInfo, tenant: TenantInfo, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const [inv] = await tx.select().from(s.invitations).where(eq(s.invitations.id, id));
      if (!inv) throw notFound('คำเชิญ');
      const isWsAdmin = tenant.role === 'owner' || tenant.role === 'admin';
      if (!isWsAdmin && inv.invitedBy !== auth.userId) throw forbidden('ws.members.manage');
      if (inv.status !== 'pending') throw new AppError(409, 'invitation_not_pending', 'คำเชิญนี้ไม่ได้รอตอบรับแล้ว');
      await tx.update(s.invitations).set({ status: 'revoked' }).where(eq(s.invitations.id, id));
      return { id, status: 'revoked' };
    });
  }

  // ---------------------------------------------------------------------------
  // J4 · ฝั่งผู้ได้รับเชิญ (ใช้ friday_system เพราะยังไม่ได้เป็นสมาชิกของ Workspace)
  // ---------------------------------------------------------------------------
  private async byToken(token: string) {
    const [row] = await this.system
      .select({
        inv: s.invitations,
        workspace: { id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug },
        inviter: { displayName: s.users.displayName },
      })
      .from(s.invitations)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.invitations.workspaceId))
      .innerJoin(s.users, eq(s.users.id, s.invitations.invitedBy))
      .where(eq(s.invitations.tokenHash, hashToken(token)));
    if (!row) throw notFound('คำเชิญ');
    const expired = row.inv.status === 'pending' && row.inv.expiresAt < new Date();
    return { ...row, status: expired ? ('expired' as const) : row.inv.status };
  }

  /** ข้อมูลเท่าที่จำเป็นสำหรับหน้า J4 (ไม่ต้องล็อกอิน) */
  async preview(token: string) {
    const r = await this.byToken(token);
    let project = null;
    if (r.inv.projectId) {
      const [p] = await this.system.select({ key: s.projects.key, name: s.projects.name }).from(s.projects).where(eq(s.projects.id, r.inv.projectId));
      project = p ?? null;
    }
    return {
      status: r.status,
      email: r.inv.email,
      workspace: { name: r.workspace.name, slug: r.workspace.slug },
      invitedBy: r.inviter.displayName,
      workspaceRole: r.inv.workspaceRole,
      project,
      projectRole: r.inv.projectRole,
      message: r.inv.message,
      expiresAt: r.inv.expiresAt,
    };
  }

  async accept(auth: AuthInfo, token: string) {
    const r = await this.usable(auth, token);
    await this.system.transaction(async (tx) => {
      await tx
        .insert(s.workspaceMembers)
        .values({ workspaceId: r.workspace.id, userId: auth.userId, role: r.inv.workspaceRole, jobTitle: r.inv.jobTitle, capacityHoursWeek: r.inv.capacityHoursWeek ?? undefined })
        .onConflictDoUpdate({
          target: [s.workspaceMembers.workspaceId, s.workspaceMembers.userId],
          set: { role: r.inv.workspaceRole, status: 'active' },
        });
      if (r.inv.projectId && r.inv.projectRole) {
        await tx
          .insert(s.projectMembers)
          .values({ workspaceId: r.workspace.id, projectId: r.inv.projectId, userId: auth.userId, role: r.inv.projectRole, position: r.inv.jobTitle, capacityHoursWeek: r.inv.capacityHoursWeek })
          .onConflictDoNothing();
      }
      await tx.update(s.invitations).set({ status: 'accepted', acceptedUserId: auth.userId }).where(eq(s.invitations.id, r.inv.id));
      await tx.insert(s.auditLogs).values({
        workspaceId: r.workspace.id,
        actorId: auth.userId,
        actorKind: 'user',
        category: 'perm',
        action: 'member.joined',
        targetType: 'invitation',
        targetId: r.inv.id,
        summary: r.inv.email,
      });
      // J4: "เมื่อตอบรับ ระบบจะแจ้งผู้เชิญ และ PM ของโปรเจกต์ใน Inbox"
      await tx.insert(s.notifications).values({
        workspaceId: r.workspace.id,
        recipientId: r.inv.invitedBy,
        eventType: 'member.joined',
        actorId: auth.userId,
        projectId: r.inv.projectId,
        payload: { email: r.inv.email },
        reason: 'คุณเป็นผู้เชิญ',
      });
    });
    return { workspace: { slug: r.workspace.slug, name: r.workspace.name }, role: r.inv.workspaceRole };
  }

  async decline(auth: AuthInfo, token: string) {
    const r = await this.usable(auth, token);
    await this.system.update(s.invitations).set({ status: 'declined' }).where(eq(s.invitations.id, r.inv.id));
    return { status: 'declined' };
  }

  /** คำเชิญต้องยังรออยู่ และผู้ตอบต้องล็อกอินด้วยอีเมลที่ถูกเชิญ */
  private async usable(auth: AuthInfo, token: string) {
    const r = await this.byToken(token);
    if (r.status === 'expired' || r.status === 'revoked') {
      throw new AppError(410, 'invitation_expired', 'ลิงก์คำเชิญนี้หมดอายุแล้ว หรือถูกยกเลิก · ขอคำเชิญใหม่จากผู้เชิญ', { invitedBy: r.inviter.displayName });
    }
    if (r.status !== 'pending') throw new AppError(409, 'invitation_not_pending', 'คำเชิญนี้ถูกใช้ไปแล้ว');
    const [me] = await this.system.select({ email: s.users.email }).from(s.users).where(eq(s.users.id, auth.userId));
    if (me.email.toLowerCase() !== r.inv.email.toLowerCase()) {
      throw new AppError(403, 'invitation_email_mismatch', 'คำเชิญนี้ส่งถึงอีเมลอื่น · เข้าสู่ระบบด้วยบัญชีที่ถูกเชิญ', { email: r.inv.email });
    }
    return r;
  }
}
