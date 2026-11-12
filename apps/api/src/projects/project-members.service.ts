import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError, forbidden } from '../common/errors.js';
import { initials } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { requirePerm } from './permissions.js';
import { checkNewMembers, type ProjectRow, ProjectsService } from './projects.service.js';
import { openStatus } from '../common/status-category.js';

const s = schema;
const projectRole = z.enum(['admin', 'member', 'viewer']);
const position = z.string().trim().max(60);
const capacity = z.number().int().min(0).max(168);

export const AddMemberBody = z.object({
  userId: z.uuid(),
  role: projectRole.default('member'),
  position: position.optional(),
  capacityHoursWeek: capacity.optional(),
});

export const UpdateMemberBody = z
  .object({ role: projectRole, position: position.nullable(), capacityHoursWeek: capacity.nullable(), pmDeputy: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

/** P3 · ลบคนที่มีงานค้าง: reassignTo = คนรับงานต่อ · null = ไม่ระบุผู้รับผิดชอบ · ไม่ส่ง = ถามก่อน (409) */
export const RemoveMemberBody = z.object({ reassignTo: z.uuid().nullable().optional() }).default({});

/** 1 MD = 8 ชั่วโมง (Members › Capacity "40 ชม. · 5 MD/สัปดาห์") */
const HOURS_PER_MD = 8;
const ROLE_ORDER = { admin: 0, member: 1, viewer: 2 } as const;

/** หน้า 7 › Members และ L2 › สมาชิก · งาน: A04 */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly events: EventBus,
  ) {}

  async list(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      // Guest ที่เป็น Viewer ไม่เห็นชื่อคน (04-permissions ข้อ 4)
      if (access.guestViewer) throw forbidden('project.members.view');
      requirePerm(access, 'project.view');
      const rows = await this.rows(tx, project);
      const work = await openWork(tx, project.id);
      const hideEmail = tenant.role === 'guest';
      return {
        items: rows.map((r) => this.dto(project, r, work.get(r.userId), hideEmail)),
        canInvite: access.perms.has('project.invite'),
        canManage: access.perms.has('project.settings'),
      };
    });
  }

  /** เพิ่มสมาชิก Workspace เข้าโปรเจกต์ (คนนอก Workspace ใช้คำเชิญทางอีเมลของ w/invitations) */
  async add(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof AddMemberBody>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.invite');
      // ตั้งเป็น Admin = ให้สิทธิ์ตั้งค่าโปรเจกต์ จึงต้องมีสิทธิ์นั้นเองก่อน (กัน Member ที่ได้ project.invite ยกระดับคนอื่น)
      if (input.role === 'admin') requirePerm(access, 'project.settings');
      await checkNewMembers(tx, [input]);
      const [row] = await tx
        .insert(s.projectMembers)
        .values({ workspaceId: tenant.workspaceId, projectId: project.id, userId: input.userId, role: input.role, position: input.position, capacityHoursWeek: input.capacityHoursWeek })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new AppError(409, 'already_project_member', 'คนนี้เป็นสมาชิกโปรเจกต์อยู่แล้ว');
      const member = await this.one(tx, project, input.userId, tenant);
      await this.audit(tx, auth, tenant, project, 'project.member_added', `${project.key} · ${member.displayName} · ${input.role}`);
      events.push({ type: 'member.joined', workspaceId: tenant.workspaceId, projectId: project.id, actorId: auth.userId, data: { projectKey: project.key, userId: input.userId, role: input.role }, at: new Date() });
      return member;
    });
    await this.events.publish(events);
    return result;
  }

  /** เปลี่ยน Role, ตำแหน่ง, capacity · Project Owner เป็น Admin เสมอ */
  async update(auth: AuthInfo, tenant: TenantInfo, key: string, userId: string, input: z.infer<typeof UpdateMemberBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.settings');
      const current = await this.find(tx, project, userId);
      if (input.role && input.role !== 'admin' && userId === project.ownerUserId) {
        throw new AppError(409, 'owner_role_fixed', 'Project Owner เป็น Admin เสมอ · โอนความเป็นเจ้าของก่อนเปลี่ยน Role');
      }
      if (input.role === 'admin') await checkNewMembers(tx, [{ userId, role: 'admin' }]);
      // Guest ทำแทน PM ไม่ได้ เพราะต้องเห็นงานและคนทั้งโปรเจกต์ (04-permissions ข้อ 4)
      if (input.pmDeputy && current.workspaceRole === 'guest') throw new AppError(409, 'guest_cannot_be_pm_deputy', 'Guest ทำแทน PM ไม่ได้');
      await tx
        .update(s.projectMembers)
        .set({ role: input.role, position: input.position, capacityHoursWeek: input.capacityHoursWeek, pmDeputy: input.pmDeputy })
        .where(and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, userId)));
      const member = await this.one(tx, project, userId, tenant);
      if (input.role && input.role !== current.role) {
        await this.audit(tx, auth, tenant, project, 'project.member_role_changed', `${project.key} · ${member.displayName} · ${current.role} → ${input.role}`);
      }
      if (input.pmDeputy !== undefined && input.pmDeputy !== current.pmDeputy) {
        await this.audit(tx, auth, tenant, project, 'project.member_pm_deputy', `${project.key} · ${member.displayName} · ${input.pmDeputy ? 'ตั้งให้ทำแทน PM' : 'เลิกทำแทน PM'}`);
      }
      return member;
    });
  }

  /**
   * นำออกจากโปรเจกต์ (P3) · งานที่ยังไม่เสร็จโอนให้ reassignTo หรือปล่อยว่าง · งานที่เสร็จแล้วยังแสดงชื่อเดิม
   * ออกจากโปรเจกต์เองได้โดยไม่ต้องมีสิทธิ์ตั้งค่า
   */
  async remove(auth: AuthInfo, tenant: TenantInfo, key: string, userId: string, input: z.infer<typeof RemoveMemberBody>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      if (userId !== auth.userId || access.archived) requirePerm(access, 'project.settings');
      if (userId === project.ownerUserId) throw new AppError(409, 'owner_cannot_be_removed', 'นำ Project Owner ออกไม่ได้ · โอนความเป็นเจ้าของก่อน');
      await this.find(tx, project, userId);
      const [person] = await tx.select({ name: s.users.displayName }).from(s.users).where(eq(s.users.id, userId));
      const name = person?.name ?? 'สมาชิก';

      const work = (await openWork(tx, project.id, [userId])).get(userId);
      if (work && work.open > 0 && input.reassignTo === undefined) {
        throw new AppError(409, 'member_has_open_issues', `${name} ยังมีงานค้างในโปรเจกต์นี้ ${work.open} งาน · เลือกคนรับงานต่อหรือไม่ระบุผู้รับผิดชอบ`, {
          openIssues: work.open,
          openSubtasks: work.subtasks,
          openMd: work.md,
        });
      }
      const reassignTo = input.reassignTo ?? null;
      if (reassignTo) {
        if (reassignTo === userId) throw new AppError(400, 'reassign_target_invalid', 'เลือกคนอื่นรับงานต่อ', { fields: ['reassignTo'] });
        await this.find(tx, project, reassignTo).catch(() => {
          throw new AppError(400, 'reassign_target_invalid', 'คนรับงานต่อต้องเป็นสมาชิกของโปรเจกต์นี้', { fields: ['reassignTo'] });
        });
      }

      const reassigned = work?.open ? await this.reassign(tx, auth, tenant, project, userId, reassignTo, name, events) : 0;
      await tx.delete(s.projectMembers).where(and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, userId)));
      await this.audit(tx, auth, tenant, project, 'project.member_removed', `${project.key} · ${name}${reassigned ? ` · โอน ${reassigned} งาน` : ''}`);
      return { userId, removed: true, reassigned, reassignTo };
    });
    await this.events.publish(events);
    return result;
  }

  /** ย้ายชื่อผู้รับผิดชอบในงานที่ยังไม่เสร็จ · ใช้กติกาเดียวกับการแก้ Assignee ใน PATCH งาน (version, Activity, การแก้ไขแผน, Event) */
  private async reassign(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: ProjectRow, userId: string, to: string | null, name: string, events: DomainEvent[]) {
    const issues = await tx
      .select({ id: s.issues.id, number: s.issues.number, title: s.issues.title })
      .from(s.issueAssignees)
      .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .where(and(eq(s.issueAssignees.userId, userId), eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt), openStatus()))
      .for('update', { of: s.issues });
    if (!issues.length) return 0;
    const ids = issues.map((i) => i.id);
    const current = await tx
      .select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
      .from(s.issueAssignees)
      .where(inArray(s.issueAssignees.issueId, ids))
      .orderBy(asc(s.issueAssignees.sort));
    const [baseline] = await tx
      .select({ id: s.planBaselines.id })
      .from(s.planBaselines)
      .where(eq(s.planBaselines.projectId, project.id))
      .orderBy(desc(s.planBaselines.version))
      .limit(1);
    const reason = `นำ ${name} ออกจากโปรเจกต์`;

    for (const issue of issues) {
      const before = current.filter((c) => c.issueId === issue.id).map((c) => c.userId);
      const after = before.filter((u) => u !== userId);
      if (to && !after.includes(to)) after.push(to);
      await tx.delete(s.issueAssignees).where(eq(s.issueAssignees.issueId, issue.id));
      if (after.length) await tx.insert(s.issueAssignees).values(after.map((u, i) => ({ workspaceId: tenant.workspaceId, issueId: issue.id, userId: u, sort: i })));
      // รายชื่อ Dev อยู่อีกตาราง trigger ไม่เพิ่ม version ให้ · เพิ่มเองให้ If-Match จับการแก้ชนกันได้
      await tx.update(s.issues).set({ version: sql`${s.issues.version} + 1` }).where(eq(s.issues.id, issue.id));
      const base = { workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id };
      await tx.insert(s.activities).values({ ...base, actorId: auth.userId, verb: 'updated', field: 'assigneeIds', oldValue: before, newValue: after });
      if (baseline) {
        await tx.insert(s.planChanges).values({ ...base, baselineId: baseline.id, field: 'assigneeIds', oldValue: before, newValue: after, reason, changedBy: auth.userId });
      }
      const data = { issueKey: `${project.key}-${issue.number}`, title: issue.title };
      const ev = (type: DomainEvent['type'], extra: Record<string, unknown>): DomainEvent => ({
        type,
        workspaceId: tenant.workspaceId,
        projectId: project.id,
        issueId: issue.id,
        actorId: auth.userId,
        data: { ...data, ...extra },
        at: new Date(),
      });
      events.push(ev('issue.updated', { fields: ['assigneeIds'] }));
      events.push(ev('issue.assigned', { userIds: to && !before.includes(to) ? [to] : [], removedUserIds: [userId] }));
      if (baseline) events.push(ev('plan.changed', { fields: ['assigneeIds'], reason }));
    }
    return issues.length;
  }

  private async rows(tx: Tx, project: ProjectRow, userId?: string) {
    const where = [eq(s.projectMembers.projectId, project.id)];
    if (userId) where.push(eq(s.projectMembers.userId, userId));
    const rows = await tx
      .select({
        userId: s.projectMembers.userId,
        role: s.projectMembers.role,
        position: s.projectMembers.position,
        capacityHoursWeek: s.projectMembers.capacityHoursWeek,
        pmDeputy: s.projectMembers.pmDeputy,
        joinedAt: s.projectMembers.joinedAt,
        displayName: s.users.displayName,
        email: s.users.email,
        avatarUrl: s.users.avatarUrl,
        workspaceRole: s.workspaceMembers.role,
        workspaceStatus: s.workspaceMembers.status,
      })
      .from(s.projectMembers)
      .innerJoin(s.users, eq(s.users.id, s.projectMembers.userId))
      .leftJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.projectMembers.workspaceId), eq(s.workspaceMembers.userId, s.projectMembers.userId)))
      .where(and(...where));
    // Owner ก่อน แล้วตาม Role และชื่อ
    return rows.sort(
      (a, b) =>
        Number(b.userId === project.ownerUserId) - Number(a.userId === project.ownerUserId) ||
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        a.displayName.localeCompare(b.displayName),
    );
  }

  private async find(tx: Tx, project: ProjectRow, userId: string) {
    const [row] = await this.rows(tx, project, userId);
    if (!row) throw new AppError(404, 'project_member_not_found', 'ไม่พบสมาชิกคนนี้ในโปรเจกต์');
    return row;
  }

  private async one(tx: Tx, project: ProjectRow, userId: string, tenant: TenantInfo) {
    const row = await this.find(tx, project, userId);
    const work = await openWork(tx, project.id, [userId]);
    return this.dto(project, row, work.get(userId), tenant.role === 'guest');
  }

  private dto(project: ProjectRow, r: Awaited<ReturnType<ProjectMembersService['rows']>>[number], work: OpenWork | undefined, hideEmail: boolean) {
    return {
      userId: r.userId,
      displayName: r.displayName,
      initials: initials(r.displayName),
      avatarUrl: r.avatarUrl,
      // Guest ไม่เห็นรายชื่อ / อีเมลของคนในองค์กร (04-permissions ข้อ 4)
      email: hideEmail ? null : r.email,
      role: project.ownerUserId === r.userId ? ('admin' as const) : r.role,
      isOwner: project.ownerUserId === r.userId,
      isGuest: r.workspaceRole === 'guest',
      active: r.workspaceStatus === 'active',
      position: r.position,
      capacityHoursWeek: r.capacityHoursWeek,
      capacityMdWeek: r.capacityHoursWeek === null ? null : Math.round((r.capacityHoursWeek / HOURS_PER_MD) * 100) / 100,
      pmDeputy: r.pmDeputy,
      openIssues: work?.open ?? 0,
      overdueIssues: work?.overdue ?? 0,
      openMd: work?.md ?? 0,
      joinedAt: r.joinedAt,
    };
  }

  private async audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: ProjectRow, action: string, summary: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'perm', action, targetType: 'project', targetId: project.id, summary });
  }
}

interface OpenWork {
  /** งานที่ยังไม่เสร็จ (รวม Sub-task) */
  open: number;
  subtasks: number;
  overdue: number;
  /** Man-Day ของงานที่ค้าง แบ่งเท่ากันตามจำนวน Dev (ธรรมเนียมใน docs/decisions.md) */
  md: number;
}

/** งานค้างของแต่ละคนในโปรเจกต์ (Assignee, ยังไม่อยู่หมวด done, ไม่อยู่ในถังขยะ) */
async function openWork(tx: Tx, projectId: string, userIds?: string[]) {
  const where = [eq(s.issues.projectId, projectId), isNull(s.issues.deletedAt), openStatus()];
  if (userIds) where.push(inArray(s.issueAssignees.userId, userIds));
  // โปรเจกต์แยก Dev / QA: งานที่ส่ง QA แล้วไม่นับเป็น Overdue ของ Dev (ผู้ใช้ขอ 2026-11-13)
  const [p] = await tx.select({ progressSplit: s.projects.progressSplit }).from(s.projects).where(eq(s.projects.id, projectId));
  const late = p?.progressSplit
    ? sql`${s.workflowStatuses.category} <> 'review' and ${s.issues.planEnd} < ${today()}`
    : sql`${s.issues.planEnd} < ${today()}`;
  const rows = await tx
    .select({
      userId: s.issueAssignees.userId,
      open: sql<number>`count(*)::int`,
      subtasks: sql<number>`(count(*) filter (where ${s.issues.parentId} is not null))::int`,
      overdue: sql<number>`(count(*) filter (where ${late}))::int`,
      md: sql<string>`coalesce(sum(${s.issues.estimateMd} / (select count(*) from ${s.issueAssignees} x where x.issue_id = ${s.issues.id})), 0)`,
    })
    .from(s.issueAssignees)
    .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
    .where(and(...where))
    .groupBy(s.issueAssignees.userId);
  return new Map<string, OpenWork>(rows.map((r) => [r.userId, { open: r.open, subtasks: r.subtasks, overdue: r.overdue, md: Math.round(Number(r.md) * 100) / 100 }]));
}
