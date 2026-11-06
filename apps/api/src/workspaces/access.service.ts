import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { webUrl } from '../auth/auth.config.js';
import { hashToken, newToken } from '../auth/sessions.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { PlanLimits } from '../core/plan-limits.js';
import { EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Notifier } from '../notifications/notifier.js';

const s = schema;
/** ลิงก์เชิญใช้ prefix นี้ เพื่อให้หน้าเว็บ /join/[token] แยกออกจาก token ของคำเชิญรายอีเมล */
export const LINK_PREFIX = 'lnk_';

export const CreateLinkBody = z.object({
  /** ลิงก์ให้สิทธิ์ Admin ไม่ได้ (เชิญ Admin ต้องระบุอีเมลรายคน) */
  role: z.enum(['member', 'guest']).default('member'),
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
});
export const DecideBody = z.object({ role: z.enum(['admin', 'member', 'viewer']).optional() });
export const AccessRequestsQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending') });

const isAdmin = (t: TenantInfo) => t.role === 'owner' || t.role === 'admin';
const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

/** ลิงก์เชิญ, เข้าร่วมด้วยลิงก์ และคำขอเข้าร่วม Workspace / โปรเจกต์ */
@Injectable()
export class AccessService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly limits: PlanLimits,
    private readonly events: EventBus,
    private readonly notifier: Notifier,
  ) {}

  // ---------------------------------------------------------------------------
  // w/invite-links
  // ---------------------------------------------------------------------------
  async createLink(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof CreateLinkBody>) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    const token = `${LINK_PREFIX}${newToken()}`;
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.insert(s.inviteLinks).values({ workspaceId: tenant.workspaceId, tokenHash: hashToken(token), role: body.role, expiresAt, createdBy: auth.userId }).returning();
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action: 'invite_link.created', targetType: 'invite_link', targetId: row.id, summary: `${body.role} · ${body.expiresInDays} วัน` });
      // token แสดงครั้งเดียว · ในฐานข้อมูลเก็บเฉพาะ hash
      return { id: row.id, role: row.role, expiresAt, url: `${process.env.APP_URL ?? webUrl()}/join/${token}` };
    });
  }

  async listLinks(auth: AuthInfo, tenant: TenantInfo) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    const rows = await this.db.run(auth, tenant, (tx) =>
      tx.select().from(s.inviteLinks).where(and(isNull(s.inviteLinks.revokedAt), gt(s.inviteLinks.expiresAt, new Date()))).orderBy(desc(s.inviteLinks.createdAt)),
    );
    const people = await this.db.run(auth, tenant, (tx) => loadPeople(tx, rows.map((r) => r.createdBy)));
    return { items: rows.map((r) => ({ id: r.id, role: r.role, expiresAt: r.expiresAt, createdAt: r.createdAt, createdBy: people.get(r.createdBy) ?? null })) };
  }

  async revokeLink(auth: AuthInfo, tenant: TenantInfo, id: string) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    if (!z.uuid().safeParse(id).success) throw notFound('ลิงก์เชิญ');
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.update(s.inviteLinks).set({ revokedAt: new Date() }).where(and(eq(s.inviteLinks.id, id), isNull(s.inviteLinks.revokedAt))).returning();
      if (!row) throw notFound('ลิงก์เชิญ');
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action: 'invite_link.revoked', targetType: 'invite_link', targetId: id, summary: row.role });
      return { revoked: true };
    });
  }

  // ---------------------------------------------------------------------------
  // join/{linkToken}  (ผู้เรียกยังไม่ได้เป็นสมาชิก จึงใช้ SYSTEM_DB)
  // ---------------------------------------------------------------------------
  private async byLink(token: string) {
    if (!token.startsWith(LINK_PREFIX)) throw notFound('ลิงก์เชิญ');
    const [row] = await this.system
      .select({ link: s.inviteLinks, slug: s.workspaces.slug, name: s.workspaces.name })
      .from(s.inviteLinks)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.inviteLinks.workspaceId))
      .where(and(eq(s.inviteLinks.tokenHash, hashToken(token)), isNull(s.workspaces.deletedAt)));
    if (!row) throw notFound('ลิงก์เชิญ');
    return row;
  }

  async joinPreview(token: string) {
    const r = await this.byLink(token);
    const status = r.link.revokedAt ? 'revoked' : r.link.expiresAt.getTime() <= Date.now() ? 'expired' : 'valid';
    return { workspace: { slug: r.slug, name: r.name }, role: r.link.role, status, expiresAt: r.link.expiresAt };
  }

  async join(auth: AuthInfo, token: string) {
    const r = await this.byLink(token);
    if (r.link.revokedAt || r.link.expiresAt.getTime() <= Date.now()) {
      throw new AppError(410, 'invite_link_expired', 'ลิงก์เชิญนี้หมดอายุแล้วหรือถูกยกเลิก · ขอลิงก์ใหม่จาก Admin');
    }
    const joined = await this.system.transaction(async (tx) => {
      const [existing] = await tx.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, r.link.workspaceId), eq(s.workspaceMembers.userId, auth.userId)));
      if (existing?.status === 'active') return false;
      if (existing) throw new AppError(403, 'member_deactivated', 'บัญชีของคุณถูกปิดการใช้งานใน Workspace นี้ · ติดต่อ Admin');
      if (r.link.role !== 'guest') await this.limits.assert(tx, r.link.workspaceId, 'seats');
      await tx.insert(s.workspaceMembers).values({ workspaceId: r.link.workspaceId, userId: auth.userId, role: r.link.role });
      await tx.insert(s.auditLogs).values({ workspaceId: r.link.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action: 'member.joined', targetType: 'invite_link', targetId: r.link.id, summary: `เข้าร่วมด้วยลิงก์ · ${r.link.role}` });
      return true;
    });
    if (joined) await this.events.publish({ type: 'member.joined', workspaceId: r.link.workspaceId, actorId: auth.userId, data: { userId: auth.userId, role: r.link.role, via: 'invite_link' }, at: new Date() });
    return { workspace: { slug: r.slug, name: r.name }, role: r.link.role, alreadyMember: !joined };
  }

  // ---------------------------------------------------------------------------
  // access-requests
  // ---------------------------------------------------------------------------
  private async managers(workspaceId: string, projectId?: string | null) {
    const wsAdmins = await this.system
      .select({ id: s.workspaceMembers.userId })
      .from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.role, ['owner', 'admin'])));
    if (!projectId) return wsAdmins.map((a) => a.id);
    const [p] = await this.system.select({ owner: s.projects.ownerUserId }).from(s.projects).where(eq(s.projects.id, projectId));
    const padmins = await this.system.select({ id: s.projectMembers.userId }).from(s.projectMembers).where(and(eq(s.projectMembers.projectId, projectId), eq(s.projectMembers.role, 'admin')));
    return [...new Set([...(p ? [p.owner] : []), ...padmins.map((a) => a.id), ...wsAdmins.map((a) => a.id)])];
  }

  /** ขอเข้า Workspace: ต้องเปิดให้เข้าร่วมด้วยโดเมน และอีเมลของผู้ขออยู่ในโดเมนที่ยืนยันแล้วของ Workspace */
  async requestWorkspace(auth: AuthInfo, slug: string) {
    const [ws] = await this.system.select().from(s.workspaces).where(and(sql`lower(${s.workspaces.slug}) = ${slug.toLowerCase()}`, isNull(s.workspaces.deletedAt)));
    if (!ws) throw notFound('Workspace');
    const [me] = await this.system.select({ email: s.users.email, name: s.users.displayName }).from(s.users).where(eq(s.users.id, auth.userId));
    const domains = await this.system.select({ domain: s.verifiedDomains.domain, at: s.verifiedDomains.verifiedAt }).from(s.verifiedDomains).where(eq(s.verifiedDomains.workspaceId, ws.id));
    const allowed = ws.allowDomainJoin && domains.some((d) => d.at && d.domain.toLowerCase() === domainOf(me.email));
    if (!allowed) throw new AppError(403, 'domain_join_not_allowed', 'Workspace นี้ไม่เปิดให้ขอเข้าร่วมด้วยอีเมลของคุณ · ขอลิงก์เชิญจาก Admin');
    const [member] = await this.system.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, ws.id), eq(s.workspaceMembers.userId, auth.userId)));
    if (member?.status === 'active') throw new AppError(409, 'already_member', 'คุณเป็นสมาชิกของ Workspace นี้อยู่แล้ว');
    if (member) throw new AppError(403, 'member_deactivated', 'บัญชีของคุณถูกปิดการใช้งานใน Workspace นี้ · ติดต่อ Admin');
    const created = await this.createRequest(ws.id, auth.userId, null);
    if (created.isNew) {
      await this.notifier.notify({ workspaceId: ws.id, recipientIds: await this.managers(ws.id), eventType: 'access_request.created', actorId: auth.userId, payload: { requesterName: me.name, workspaceName: ws.name, requestId: created.row.id }, reason: 'คุณเป็น Admin ของ Workspace · มีคนขอเข้าร่วม' });
    }
    return { id: created.row.id, status: created.row.status, workspace: { slug: ws.slug, name: ws.name }, alreadyPending: !created.isNew };
  }

  /** ขอเข้าโปรเจกต์ (หน้า 403): ผู้ขอต้องเป็นสมาชิก Workspace อยู่แล้ว · หาโปรเจกต์ด้วย SYSTEM_DB เพราะโปรเจกต์ Private ที่ยังไม่ได้เป็นสมาชิก RLS ซ่อนไว้ */
  async requestProject(auth: AuthInfo, tenant: TenantInfo, key: string) {
    const [p] = await this.system
      .select()
      .from(s.projects)
      .where(and(eq(s.projects.workspaceId, tenant.workspaceId), eq(s.projects.key, key.toUpperCase()), isNull(s.projects.deletedAt)));
    if (!p) throw new AppError(404, 'project_not_found', 'ไม่พบโปรเจกต์');
    if (tenant.role === 'guest') throw forbidden('project.request_access');
    const [m] = await this.system.select().from(s.projectMembers).where(and(eq(s.projectMembers.projectId, p.id), eq(s.projectMembers.userId, auth.userId)));
    if (m || p.ownerUserId === auth.userId) throw new AppError(409, 'already_member', 'คุณเป็นสมาชิกโปรเจกต์นี้อยู่แล้ว');
    const [me] = await this.system.select({ name: s.users.displayName }).from(s.users).where(eq(s.users.id, auth.userId));
    const created = await this.createRequest(tenant.workspaceId, auth.userId, p.id);
    if (created.isNew) {
      await this.notifier.notify({
        workspaceId: tenant.workspaceId, recipientIds: await this.managers(tenant.workspaceId, p.id), eventType: 'access_request.created', actorId: auth.userId, projectId: p.id,
        payload: { requesterName: me.name, projectKey: p.key, projectName: p.name, requestId: created.row.id }, reason: 'คุณเป็น Admin ของโปรเจกต์นี้ · มีคนขอเข้าร่วม',
      });
    }
    return { id: created.row.id, status: created.row.status, project: { key: p.key, name: p.name }, alreadyPending: !created.isNew };
  }

  private async createRequest(workspaceId: string, userId: string, projectId: string | null) {
    const [pending] = await this.system
      .select()
      .from(s.accessRequests)
      .where(and(eq(s.accessRequests.workspaceId, workspaceId), eq(s.accessRequests.userId, userId), eq(s.accessRequests.status, 'pending'), projectId ? eq(s.accessRequests.projectId, projectId) : isNull(s.accessRequests.projectId)));
    if (pending) return { row: pending, isNew: false };
    const [row] = await this.system.insert(s.accessRequests).values({ workspaceId, userId, projectId }).returning();
    return { row, isNew: true };
  }

  /** Admin ของ Workspace เห็นทั้งหมด · Admin/Owner ของโปรเจกต์เห็นเฉพาะคำขอเข้าโปรเจกต์ของตัวเอง */
  async list(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof AccessRequestsQuery>) {
    const rows = await this.system
      .select({ r: s.accessRequests, projectKey: s.projects.key, projectName: s.projects.name, projectOwner: s.projects.ownerUserId })
      .from(s.accessRequests)
      .leftJoin(s.projects, eq(s.projects.id, s.accessRequests.projectId))
      .where(and(eq(s.accessRequests.workspaceId, tenant.workspaceId), q.status === 'all' ? undefined : eq(s.accessRequests.status, q.status)))
      .orderBy(desc(s.accessRequests.createdAt))
      .limit(200);
    const myAdminProjects = new Set(
      (await this.system.select({ id: s.projectMembers.projectId }).from(s.projectMembers).where(and(eq(s.projectMembers.userId, auth.userId), eq(s.projectMembers.role, 'admin')))).map((x) => x.id),
    );
    const visible = rows.filter((x) => isAdmin(tenant) || (x.r.projectId && (x.projectOwner === auth.userId || myAdminProjects.has(x.r.projectId))));
    if (!isAdmin(tenant) && !myAdminProjects.size) {
      const [owns] = await this.system.select({ id: s.projects.id }).from(s.projects).where(and(eq(s.projects.workspaceId, tenant.workspaceId), eq(s.projects.ownerUserId, auth.userId), isNull(s.projects.deletedAt))).limit(1);
      if (!owns) throw forbidden('ws.members.manage');
    }
    const users = await this.system
      .select({ id: s.users.id, displayName: s.users.displayName, email: s.users.email })
      .from(s.users)
      .where(inArray(s.users.id, [...new Set(visible.map((x) => x.r.userId))].length ? [...new Set(visible.map((x) => x.r.userId))] : ['00000000-0000-0000-0000-000000000000']));
    const by = new Map(users.map((u) => [u.id, u]));
    return {
      items: visible.map((x) => ({
        id: x.r.id,
        kind: x.r.projectId ? ('project' as const) : ('workspace' as const),
        status: x.r.status,
        requester: by.get(x.r.userId) ?? null,
        project: x.r.projectId ? { key: x.projectKey, name: x.projectName } : null,
        createdAt: x.r.createdAt,
        decidedAt: x.r.decidedAt,
      })),
    };
  }

  async decide(auth: AuthInfo, tenant: TenantInfo, id: string, decision: 'approve' | 'reject', body: z.infer<typeof DecideBody>) {
    if (!z.uuid().safeParse(id).success) throw notFound('คำขอ');
    const [row] = await this.system
      .select({ r: s.accessRequests, project: s.projects })
      .from(s.accessRequests)
      .leftJoin(s.projects, eq(s.projects.id, s.accessRequests.projectId))
      .where(and(eq(s.accessRequests.id, id), eq(s.accessRequests.workspaceId, tenant.workspaceId)));
    if (!row) throw notFound('คำขอ');
    // สิทธิ์: Admin ของ Workspace หรือ (คำขอเข้าโปรเจกต์) Project Owner / Admin ของโปรเจกต์นั้น
    let allowed = isAdmin(tenant);
    if (!allowed && row.project) {
      const [pm] = await this.system.select({ role: s.projectMembers.role }).from(s.projectMembers).where(and(eq(s.projectMembers.projectId, row.project.id), eq(s.projectMembers.userId, auth.userId)));
      allowed = row.project.ownerUserId === auth.userId || pm?.role === 'admin';
    }
    if (!allowed) throw forbidden(row.project ? 'project.invite' : 'ws.members.manage');
    if (row.r.status !== 'pending') throw new AppError(409, 'already_decided', 'คำขอนี้ถูกตัดสินไปแล้ว', { status: row.r.status });

    if (decision === 'approve') {
      await this.system.transaction(async (tx) => {
        if (row.project) {
          const [wm] = await tx.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, tenant.workspaceId), eq(s.workspaceMembers.userId, row.r.userId), eq(s.workspaceMembers.status, 'active')));
          if (!wm) throw new AppError(409, 'requester_not_member', 'ผู้ขอไม่ได้เป็นสมาชิก Workspace แล้ว');
          // Guest เป็น Viewer ได้อย่างเดียว
          const role = wm.role === 'guest' ? 'viewer' : (body.role ?? 'member');
          await tx.insert(s.projectMembers).values({ workspaceId: tenant.workspaceId, projectId: row.project.id, userId: row.r.userId, role }).onConflictDoNothing();
        } else {
          await this.limits.assert(tx, tenant.workspaceId, 'seats');
          await tx.insert(s.workspaceMembers).values({ workspaceId: tenant.workspaceId, userId: row.r.userId, role: 'member' }).onConflictDoNothing();
        }
        await tx.update(s.accessRequests).set({ status: 'approved', decidedBy: auth.userId, decidedAt: new Date() }).where(eq(s.accessRequests.id, id));
      });
    } else {
      await this.system.update(s.accessRequests).set({ status: 'rejected', decidedBy: auth.userId, decidedAt: new Date() }).where(eq(s.accessRequests.id, id));
    }
    await this.system.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action: `perm.access_request_${decision === 'approve' ? 'approved' : 'rejected'}`, targetType: 'access_request', targetId: id, summary: row.project ? row.project.key : 'workspace' });
    await this.notifier.notify({
      workspaceId: tenant.workspaceId, recipientIds: [row.r.userId], eventType: 'access_request.decided', actorId: auth.userId, projectId: row.project?.id,
      payload: { decision, projectKey: row.project?.key, projectName: row.project?.name }, reason: 'คุณเป็นผู้ขอสิทธิ์',
    });
    if (decision === 'approve') {
      await this.events.publish({ type: 'member.joined', workspaceId: tenant.workspaceId, projectId: row.project?.id, actorId: auth.userId, data: { userId: row.r.userId, role: row.project ? (body.role ?? 'member') : 'member', via: 'access_request' }, at: new Date() });
    }
    return { id, status: decision === 'approve' ? ('approved' as const) : ('rejected' as const) };
  }
}
