import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, eq, gte, isNull, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Notifier } from '../notifications/notifier.js';

const s = schema;
const isoDate = z.iso.date();

export const CreateLeaveBody = z
  .object({
    leaveType: z.string().trim().min(1).max(40),
    startDate: isoDate,
    endDate: isoDate,
    halfDay: z.enum(['am', 'pm']).nullish(),
    /** ลงวันลาให้คนอื่น (ต้องมี ws.members.manage) */
    userId: z.uuid().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, { path: ['endDate'], message: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม' })
  .refine((v) => !v.halfDay || v.startDate === v.endDate, { path: ['halfDay'], message: 'ลาครึ่งวันต้องเป็นวันเดียว' });
export const LeavesQuery = z.object({
  /** ไม่ส่ง = ของฉัน · `all` = ทั้ง Workspace (Admin) · หรือ userId */
  user: z.union([z.literal('all'), z.uuid()]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const isAdmin = (t: TenantInfo) => t.role === 'owner' || t.role === 'admin';

/** วันลา (ลด capacity ใน Workload) */
@Injectable()
export class LeavesService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly events: EventBus,
    private readonly notifier: Notifier,
  ) {}

  private dto(l: typeof s.leaves.$inferSelect, people: Map<string, unknown>) {
    return { id: l.id, user: people.get(l.userId) ?? null, leaveType: l.leaveType, startDate: l.startDate, endDate: l.endDate, halfDay: l.halfDay, status: l.status, source: l.source, createdAt: l.createdAt };
  }

  async list(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof LeavesQuery>) {
    const target = q.user === undefined ? auth.userId : q.user;
    if (target !== auth.userId && !isAdmin(tenant)) throw forbidden('ws.members.manage');
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx
        .select()
        .from(s.leaves)
        .where(and(eq(s.leaves.workspaceId, tenant.workspaceId), target === 'all' ? undefined : eq(s.leaves.userId, target), q.to ? lte(s.leaves.startDate, q.to) : undefined, q.from ? gte(s.leaves.endDate, q.from) : undefined))
        .orderBy(asc(s.leaves.startDate), asc(s.leaves.createdAt));
      const people = await loadPeople(tx, rows.map((r) => r.userId));
      return { items: rows.map((r) => this.dto(r, people)) };
    });
  }

  async create(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof CreateLeaveBody>) {
    const target = body.userId ?? auth.userId;
    const forOther = target !== auth.userId;
    if (forOther && !isAdmin(tenant)) throw forbidden('ws.members.manage');
    if (tenant.role === 'guest') throw forbidden('ws.leave');
    const created = await this.db.run(auth, tenant, async (tx) => {
      const [member] = await tx.select({ id: s.workspaceMembers.userId }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.userId, target), eq(s.workspaceMembers.status, 'active')));
      if (!member) throw notFound('สมาชิก');
      // ทับกับวันลาเดิมของคนเดียวกัน (ครึ่งวันคนละช่วงของวันเดียวกันไม่นับว่าทับ)
      const overlaps = await tx
        .select()
        .from(s.leaves)
        .where(and(eq(s.leaves.userId, target), lte(s.leaves.startDate, body.endDate), gte(s.leaves.endDate, body.startDate)));
      const clash = overlaps.find((o) => !(o.halfDay && body.halfDay && o.halfDay !== body.halfDay && o.startDate === o.endDate && o.startDate === body.startDate));
      if (clash) throw new AppError(409, 'leave_overlap', 'ช่วงนี้มีวันลาอยู่แล้ว', { existing: { id: clash.id, startDate: clash.startDate, endDate: clash.endDate } });
      // ลาเอง = รออนุมัติ · Admin ลงให้ = อนุมัติทันที
      const [row] = await tx
        .insert(s.leaves)
        .values({ workspaceId: tenant.workspaceId, userId: target, leaveType: body.leaveType, startDate: body.startDate, endDate: body.endDate, halfDay: body.halfDay ?? null, status: forOther ? 'approved' : 'pending' })
        .returning();
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'leave.created', targetType: 'leave', targetId: row.id, summary: `${body.leaveType} ${body.startDate}–${body.endDate}` });
      const people = await loadPeople(tx, [target]);
      return { row, leaver: people.get(target) };
    });
    await this.announce(tenant, auth, created.row, created.leaver?.displayName ?? '');
    const people = await this.db.run(auth, tenant, (tx) => loadPeople(tx, [created.row.userId]));
    return this.dto(created.row, people);
  }

  /** Event leave.created + แจ้งคนที่มอบหมายงานให้คนที่ลา (และ PM ของโปรเจกต์นั้น) ว่างานช่วงนี้อาจช้า */
  private async announce(tenant: TenantInfo, auth: AuthInfo, leave: typeof s.leaves.$inferSelect, leaverName: string) {
    const issues = await this.system
      .select({ id: s.issues.id, number: s.issues.number, projectKey: s.projects.key, projectId: s.issues.projectId, createdBy: s.issues.createdBy, owner: s.projects.ownerUserId })
      .from(s.issueAssignees)
      .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .where(
        and(
          eq(s.issues.workspaceId, tenant.workspaceId),
          eq(s.issueAssignees.userId, leave.userId),
          isNull(s.issues.deletedAt),
          isNull(s.projects.deletedAt),
          ne(s.workflowStatuses.category, 'done'),
          lte(s.issues.planStart, leave.endDate),
          gte(s.issues.planEnd, leave.startDate),
        ),
      );
    const byProject = new Map<string, typeof issues>();
    for (const i of issues) byProject.set(i.projectId, [...(byProject.get(i.projectId) ?? []), i]);
    for (const [projectId, list] of byProject) {
      const recipients = [...new Set(list.flatMap((i) => [i.createdBy, i.owner]).filter((x): x is string => !!x && x !== leave.userId))];
      await this.notifier.notify({
        workspaceId: tenant.workspaceId,
        recipientIds: recipients,
        eventType: 'leave.created',
        actorId: leave.userId,
        projectId,
        payload: { actorName: leaverName, projectKey: list[0]!.projectKey, startDate: leave.startDate, endDate: leave.endDate, leaveType: leave.leaveType, issueKeys: list.slice(0, 10).map((i) => `${i.projectKey}-${i.number}`), issueCount: list.length, title: `${leaverName} ลา ${leave.startDate}${leave.endDate !== leave.startDate ? `–${leave.endDate}` : ''}` },
        reason: 'คุณมอบหมายงาน หรือเป็น PM ของงานที่ผู้ลารับผิดชอบอยู่',
      });
    }
    await this.events.publish({ type: 'leave.created', workspaceId: tenant.workspaceId, actorId: auth.userId, data: { leaveId: leave.id, userId: leave.userId, startDate: leave.startDate, endDate: leave.endDate, leaveType: leave.leaveType, halfDay: leave.halfDay, affectedIssues: issues.length }, at: new Date() });
  }

  async approve(auth: AuthInfo, tenant: TenantInfo, id: string) {
    if (!isAdmin(tenant)) throw forbidden('ws.members.manage');
    if (!z.uuid().safeParse(id).success) throw notFound('วันลา');
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.update(s.leaves).set({ status: 'approved' }).where(eq(s.leaves.id, id)).returning();
      if (!row) throw notFound('วันลา');
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'leave.approved', targetType: 'leave', targetId: id, summary: `${row.startDate}–${row.endDate}` });
      return this.dto(row, await loadPeople(tx, [row.userId]));
    });
  }

  async remove(auth: AuthInfo, tenant: TenantInfo, id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('วันลา');
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.select().from(s.leaves).where(eq(s.leaves.id, id));
      if (!row) throw notFound('วันลา');
      if (row.userId !== auth.userId && !isAdmin(tenant)) throw forbidden('ws.members.manage');
      // วันลาที่ดึงมาจากระบบ HR แก้ที่ต้นทาง
      if (row.source === 'hr') throw new AppError(403, 'leave_from_hr', 'วันลานี้มาจากระบบ HR · แก้ไขที่ระบบ HR');
      await tx.delete(s.leaves).where(eq(s.leaves.id, id));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'leave.deleted', targetType: 'leave', targetId: id, summary: `${row.leaveType} ${row.startDate}–${row.endDate}` });
      return { deleted: true };
    });
  }
}

