import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden } from '../common/errors.js';
import { loadPeople, type Person } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { IssuesService, outsideParent } from '../issues/issues.service.js';
import { Notifier } from '../notifications/notifier.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import { type ProjectAccess, projectAccess, requirePerm, usersWithPerm } from '../projects/permissions.js';
import type { ProjectRow } from '../projects/projects.service.js';

const s = schema;
const isoDate = z.iso.date();

/** เหตุผลในหน้า K3 */
export const REASONS = {
  scope_added: 'ขอบเขตงานเพิ่ม',
  waiting_input: 'รอข้อมูล / สิ่งที่ต้องได้จาก BA หรือผู้ใช้',
  blocked_by_dependency: 'ติด Dependency จากงานอื่น',
  estimate_wrong: 'ประเมินเวลาผิด',
  other: 'อื่น ๆ',
} as const;
type ReasonCode = keyof typeof REASONS;

export const PreviewQuery = z.object({ due: isoDate });

export const CreateDueRequestBody = z
  .object({
    requestedDue: isoDate,
    reasonCode: z.enum(Object.keys(REASONS) as [ReasonCode, ...ReasonCode[]]),
    detail: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.reasonCode !== 'other' || !!v.detail, { path: ['detail'], message: 'เลือก "อื่น ๆ" ต้องใส่รายละเอียด' });

export const DecideBody = z.object({ note: z.string().trim().max(2000).optional() });

export const ListDueRequestsQuery = z.object({
  /** to_approve = คำขอที่ฉันอนุมัติได้ (Home "รออนุมัติ") · mine = คำขอที่ฉันส่ง */
  scope: z.enum(['to_approve', 'mine']).default('to_approve'),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending'),
});

type Issue = typeof s.issues.$inferSelect;
type DueRequest = typeof s.dueChangeRequests.$inferSelect;
type Warning = { code: string; message: string };

@Injectable()
export class DueRequestsService {
  constructor(
    private readonly db: TenantDb,
    private readonly issues: IssuesService,
    private readonly notifier: Notifier,
  ) {}

  // ---------------------------------------------------------------------------
  // K3 · ผลกระทบที่ระบบคำนวณ (แสดงในฟอร์มก่อนส่ง)
  // ---------------------------------------------------------------------------
  async preview(auth: AuthInfo, tenant: TenantInfo, issueKey: string, due: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.issues.loadIssue(tx, auth, tenant, issueKey);
      if (!access.perms.has('issue.edit') && !access.perms.has('due_request.approve')) throw forbidden('issue.edit');
      const currentDue = requireDue(issue);
      if (due <= currentDue) throw notPostponement(currentDue);
      return this.impact(tx, auth, project, issue, currentDue, due);
    });
  }

  // ---------------------------------------------------------------------------
  // K3 · ส่งคำขอ
  // ---------------------------------------------------------------------------
  async create(auth: AuthInfo, tenant: TenantInfo, issueKey: string, input: z.infer<typeof CreateDueRequestBody>) {
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.issues.loadIssue(tx, auth, tenant, issueKey);
      requirePerm(access, 'issue.edit');
      if (access.perms.has('issue.change_due_directly')) {
        throw new AppError(422, 'due_change_allowed_directly', 'คุณเปลี่ยน Due ได้เลยโดยไม่ต้องขออนุมัติ');
      }
      const currentDue = requireDue(issue);
      if (input.requestedDue <= currentDue) throw notPostponement(currentDue);

      const [pending] = await tx
        .select({ id: s.dueChangeRequests.id })
        .from(s.dueChangeRequests)
        .where(and(eq(s.dueChangeRequests.issueId, issue.id), eq(s.dueChangeRequests.status, 'pending')));
      if (pending) throw new AppError(409, 'due_request_pending', 'งานนี้มีคำขอเลื่อน Due ที่รออนุมัติอยู่แล้ว', { id: pending.id });

      const impact = await this.impact(tx, auth, project, issue, currentDue, input.requestedDue);
      if (!impact.approvers.length) throw new AppError(422, 'no_approver', 'โปรเจกต์นี้ยังไม่มีผู้อนุมัติคำขอเลื่อน Due');

      const [req] = await tx
        .insert(s.dueChangeRequests)
        .values({
          workspaceId: tenant.workspaceId,
          issueId: issue.id,
          requesterId: auth.userId,
          currentDue,
          requestedDue: input.requestedDue,
          reasonCode: input.reasonCode,
          detail: input.detail,
          impact,
        })
        .returning();
      await tx.insert(s.activities).values({
        workspaceId: tenant.workspaceId,
        projectId: project.id,
        issueId: issue.id,
        actorId: auth.userId,
        verb: 'due_requested',
        field: 'planEnd',
        oldValue: currentDue,
        newValue: input.requestedDue,
      });
      const people = await loadPeople(tx, [auth.userId]);
      return { project, issue, req, impact, requester: people.get(auth.userId)!, warnings: impact.warnings, key: issueKeyOf(project, issue) };
    });

    const { project, issue, req, impact, requester, key } = result;
    await this.notifier.notify({
      workspaceId: tenant.workspaceId,
      recipientIds: impact.approvers.map((p) => p.id),
      eventType: 'due_request.created',
      actorId: auth.userId,
      projectId: project.id,
      issueId: issue.id,
      payload: {
        requestId: req.id,
        projectKey: project.key,
        projectName: project.name,
        issueKey: key,
        issueTitle: issue.title,
        actorName: requester.displayName,
        currentDue: req.currentDue,
        requestedDue: req.requestedDue,
        reasonCode: req.reasonCode,
        detail: req.detail,
      },
      reason: (id) => (id === project.ownerUserId ? 'คุณเป็นผู้อนุมัติ (Project Owner)' : 'คุณเป็นผู้อนุมัติคำขอเลื่อน Due ของโปรเจกต์นี้'),
    });
    return { ...this.dto(req, key, new Map([[requester.id, requester]])), warnings: result.warnings };
  }

  // ---------------------------------------------------------------------------
  // อ่าน
  // ---------------------------------------------------------------------------
  /** ประวัติคำขอของงาน (หน้า C › Activity, K3) */
  async listForIssue(auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.issues.loadIssue(tx, auth, tenant, issueKey);
      if (access.guestViewer) throw forbidden('project.view');
      const rows = await tx
        .select()
        .from(s.dueChangeRequests)
        .where(eq(s.dueChangeRequests.issueId, issue.id))
        .orderBy(desc(s.dueChangeRequests.createdAt));
      const people = await loadPeople(tx, rows.flatMap((r) => [r.requesterId, r.decidedBy]));
      return { items: rows.map((r) => this.dto(r, issueKeyOf(project, issue), people)) };
    });
  }

  /** Home "รออนุมัติ" และคำขอของฉัน · ข้ามทุกโปรเจกต์ใน Workspace */
  async list(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof ListDueRequestsQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const where = [isNull(s.issues.deletedAt)];
      if (q.status !== 'all') where.push(eq(s.dueChangeRequests.status, q.status));
      if (q.scope === 'mine') where.push(eq(s.dueChangeRequests.requesterId, auth.userId));
      else where.push(ne(s.dueChangeRequests.requesterId, auth.userId));
      const rows = await tx
        .select({ req: s.dueChangeRequests, issue: s.issues, project: s.projects })
        .from(s.dueChangeRequests)
        .innerJoin(s.issues, eq(s.issues.id, s.dueChangeRequests.issueId))
        .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
        .where(and(...where))
        .orderBy(desc(s.dueChangeRequests.createdAt))
        .limit(200);

      const access = new Map<string, ProjectAccess>();
      for (const r of rows) if (!access.has(r.project.id)) access.set(r.project.id, await projectAccess(tx, auth, tenant, r.project));
      const visible = q.scope === 'mine' ? rows : rows.filter((r) => access.get(r.project.id)!.perms.has('due_request.approve'));
      const people = await loadPeople(tx, visible.flatMap((r) => [r.req.requesterId, r.req.decidedBy]));
      return {
        items: visible.map((r) => ({
          ...this.dto(r.req, issueKeyOf(r.project, r.issue), people),
          issue: { key: issueKeyOf(r.project, r.issue), title: r.issue.title, planEnd: r.issue.planEnd },
          project: { key: r.project.key, name: r.project.name },
          canDecide: r.req.status === 'pending' && r.req.requesterId !== auth.userId && access.get(r.project.id)!.perms.has('due_request.approve'),
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // G · อนุมัติ / ปฏิเสธ / ยกเลิก
  // ---------------------------------------------------------------------------
  async decide(auth: AuthInfo, tenant: TenantInfo, id: string, action: 'approve' | 'reject' | 'cancel', note?: string) {
    const parsedId = z.uuid().safeParse(id);
    if (!parsedId.success) throw notFoundRequest();

    const result = await this.db.run(auth, tenant, async (tx) => {
      const [req] = await tx.select().from(s.dueChangeRequests).where(eq(s.dueChangeRequests.id, id)).for('update');
      if (!req) throw notFoundRequest();
      const [issue] = await tx.select().from(s.issues).where(eq(s.issues.id, req.issueId)).for('update');
      const [project] = await tx.select().from(s.projects).where(eq(s.projects.id, issue.projectId));
      const access = await projectAccess(tx, auth, tenant, project);
      if (!access.role || access.guestViewer) throw notFoundRequest();

      if (action === 'cancel') {
        if (req.requesterId !== auth.userId) throw new AppError(403, 'forbidden', 'ยกเลิกได้เฉพาะคำขอของตัวเอง');
      } else {
        requirePerm(access, 'due_request.approve');
        // 04-permissions ข้อ 3.3: อนุมัติคำขอของตัวเองไม่ได้ แม้เป็น Admin
        if (req.requesterId === auth.userId) throw new AppError(403, 'cannot_decide_own_request', 'อนุมัติหรือปฏิเสธคำขอของตัวเองไม่ได้');
      }
      if (req.status !== 'pending') throw new AppError(409, 'already_decided', 'คำขอนี้ถูกตัดสินไปแล้ว', { status: req.status });

      const base = { workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, field: 'planEnd' };
      const warnings: Warning[] = [];
      let updatedIssue: Issue = issue;
      if (action === 'approve') {
        if (issue.deletedAt) throw new AppError(410, 'gone', 'งานนี้ถูกลบแล้ว');
        // Due ถูกแก้ไปแล้วหลังส่งคำขอ: ให้ผู้อนุมัติดูใหม่ (ปฏิเสธ หรือให้ผู้ขอยกเลิกแล้วส่งใหม่)
        if (issue.planEnd !== req.currentDue) {
          throw new AppError(409, 'due_changed_since_request', 'Due ของงานถูกเปลี่ยนหลังจากส่งคำขอแล้ว', {
            currentDue: issue.planEnd,
            dueWhenRequested: req.currentDue,
          });
        }
        [updatedIssue] = await tx.update(s.issues).set({ planEnd: req.requestedDue }).where(eq(s.issues.id, issue.id)).returning();
        await tx.insert(s.activities).values({ ...base, verb: 'due_request_approved', oldValue: req.currentDue, newValue: req.requestedDue });

        // แก้ผ่านคำขอใช้เหตุผลในคำขอ (03-api › กติกาการเปลี่ยน Due)
        const [baseline] = await tx
          .select({ id: s.planBaselines.id })
          .from(s.planBaselines)
          .where(eq(s.planBaselines.projectId, project.id))
          .orderBy(desc(s.planBaselines.version))
          .limit(1);
        if (baseline) {
          const impact = req.impact as { addedWorkingDays?: number } | null;
          await tx.insert(s.planChanges).values({
            workspaceId: tenant.workspaceId,
            projectId: project.id,
            issueId: issue.id,
            baselineId: baseline.id,
            field: 'planEnd',
            oldValue: req.currentDue,
            newValue: req.requestedDue,
            reason: [REASONS[req.reasonCode], req.detail].filter(Boolean).join(': '),
            impact: impact?.addedWorkingDays ? `เพิ่ม ${impact.addedWorkingDays} วันทำการ` : null,
            source: 'due_request',
            changedBy: auth.userId,
          });
        }
        if (issue.parentId) {
          const [parent] = await tx.select().from(s.issues).where(eq(s.issues.id, issue.parentId));
          warnings.push(...outsideParent(parent, issue.planStart, req.requestedDue));
        }
      } else {
        await tx.insert(s.activities).values({
          ...base,
          verb: action === 'reject' ? 'due_request_rejected' : 'due_request_cancelled',
          oldValue: req.currentDue,
          newValue: req.requestedDue,
        });
      }

      const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
      const [decided] = await tx
        .update(s.dueChangeRequests)
        .set({
          status,
          // ยกเลิกโดยผู้ขอ: ไม่ใช่การตัดสิน (constraint ห้าม decided_by = ผู้ขอ)
          decidedBy: action === 'cancel' ? null : auth.userId,
          decidedAt: new Date(),
          decidedVia: action === 'cancel' ? null : 'in_app',
          decisionNote: note,
        })
        .where(eq(s.dueChangeRequests.id, req.id))
        .returning();
      const people = await loadPeople(tx, [decided.requesterId, decided.decidedBy, auth.userId]);
      return { project, issue: updatedIssue, decided, people, warnings, key: issueKeyOf(project, issue) };
    });

    const { project, issue, decided, people, warnings, key } = result;
    if (action !== 'cancel') {
      await this.notifier.notify({
        workspaceId: tenant.workspaceId,
        recipientIds: [decided.requesterId],
        eventType: 'due_request.decided',
        actorId: auth.userId,
        projectId: project.id,
        issueId: issue.id,
        payload: {
          requestId: decided.id,
          decision: decided.status,
          note: decided.decisionNote,
          projectKey: project.key,
          projectName: project.name,
          issueKey: key,
          issueTitle: issue.title,
          actorName: people.get(auth.userId)?.displayName,
          currentDue: decided.currentDue,
          requestedDue: decided.requestedDue,
        },
        reason: 'คุณเป็นผู้ขอเลื่อน Due',
      });
    }
    return {
      ...this.dto(decided, key, people),
      issue: { key, planEnd: issue.planEnd, version: issue.version },
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // ผลกระทบ
  // ---------------------------------------------------------------------------
  private async impact(tx: Tx, auth: AuthInfo, project: ProjectRow, issue: Issue, currentDue: string, requestedDue: string) {
    const cal = await WorkCalendar.load(tx, project);
    const windowStart = addDays(currentDue, 1);
    const warnings: Warning[] = [];
    if (!cal.isWorkingDay(requestedDue)) warnings.push({ code: 'due_on_holiday', message: `${requestedDue} ไม่ใช่วันทำการ` });

    // งานในตระกูลเดียวกัน (งานแม่ / Sub-task) ไม่นับเป็นงานชน
    const children = await tx.select({ id: s.issues.id }).from(s.issues).where(eq(s.issues.parentId, issue.id));
    const family = [issue.id, ...children.map((c) => c.id), ...(issue.parentId ? [issue.parentId] : [])];

    // Workload ของ Dev ช่วงที่เลื่อนออกไป (ในโปรเจกต์นี้ · นับเฉพาะงานที่ไม่มีลูก เพื่อไม่ให้ Task กับ Sub-task ซ้ำกัน)
    const assignees = await tx
      .select({ userId: s.issueAssignees.userId })
      .from(s.issueAssignees)
      .where(eq(s.issueAssignees.issueId, issue.id))
      .orderBy(asc(s.issueAssignees.sort));
    const assigneeIds = assignees.map((a) => a.userId);
    const others = assigneeIds.length
      ? await tx
          .select({
            userId: s.issueAssignees.userId,
            number: s.issues.number,
            title: s.issues.title,
            planStart: s.issues.planStart,
            planEnd: s.issues.planEnd,
            estimateMd: s.issues.estimateMd,
            devs: sql<number>`(select count(*)::int from ${s.issueAssignees} x where x.issue_id = ${s.issues.id})`,
          })
          .from(s.issueAssignees)
          .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
          .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
          .where(
            and(
              inArray(s.issueAssignees.userId, assigneeIds),
              eq(s.issues.projectId, project.id),
              isNull(s.issues.deletedAt),
              ne(s.workflowStatuses.category, 'done'),
              notInArray(s.issues.id, family),
              lte(s.issues.planStart, requestedDue),
              gte(s.issues.planEnd, windowStart),
              sql`not exists (select 1 from ${s.issues} c where c.parent_id = ${s.issues.id} and c.deleted_at is null)`,
            ),
          )
          .orderBy(asc(s.issues.planStart), asc(s.issues.number))
      : [];
    const capacity = assigneeIds.length
      ? await tx
          .select({ userId: s.workspaceMembers.userId, ws: s.workspaceMembers.capacityHoursWeek, project: s.projectMembers.capacityHoursWeek })
          .from(s.workspaceMembers)
          .leftJoin(s.projectMembers, and(eq(s.projectMembers.userId, s.workspaceMembers.userId), eq(s.projectMembers.projectId, project.id)))
          .where(and(eq(s.workspaceMembers.workspaceId, project.workspaceId), inArray(s.workspaceMembers.userId, assigneeIds)))
      : [];
    const addedWorkingDays = cal.workingDaysIn(windowStart, requestedDue);

    const approverIds = (await usersWithPerm(tx, project, 'due_request.approve')).filter((id) => id !== auth.userId);
    const people = await loadPeople(tx, [...assigneeIds, ...approverIds]);

    const workload = assigneeIds.map((userId) => {
      const mine = others.filter((o) => o.userId === userId);
      let otherWorkMd = 0;
      for (const o of mine) {
        const days = Math.max(1, cal.workingDaysIn(o.planStart!, o.planEnd!));
        const overlap = cal.workingDaysIn(o.planStart! > windowStart ? o.planStart! : windowStart, o.planEnd! < requestedDue ? o.planEnd! : requestedDue);
        otherWorkMd += ((o.estimateMd ?? 0) / Math.max(1, o.devs)) * (overlap / days);
      }
      const cap = capacity.find((c) => c.userId === userId);
      const hoursWeek = cap?.project ?? cap?.ws ?? 40;
      const capacityMd = round((hoursWeek / 8 / cal.daysPerWeek) * addedWorkingDays);
      otherWorkMd = round(otherWorkMd);
      return {
        person: people.get(userId) ?? null,
        otherWorkMd,
        capacityMd,
        overloaded: otherWorkMd >= capacityMd,
        overlapping: mine.map((o) => ({ key: `${project.key}-${o.number}`, title: o.title, planStart: o.planStart, planEnd: o.planEnd })),
      };
    });

    // งานที่รองานนี้อยู่ (Dependency) ที่เริ่มก่อน Due ใหม่
    const dependents = await tx
      .select({ number: s.issues.number, title: s.issues.title, planStart: s.issues.planStart, type: s.issueDependencies.type })
      .from(s.issueDependencies)
      .innerJoin(s.issues, eq(s.issues.id, s.issueDependencies.successorId))
      .where(and(eq(s.issueDependencies.predecessorId, issue.id), isNull(s.issues.deletedAt)));

    // Milestone ระดับโปรเจกต์, ของ Module เดียวกัน หรือที่ผูกกับงานนี้ ที่ยังไม่ผ่าน
    const milestones = await tx
      .select({ id: s.milestones.id, name: s.milestones.name, date: s.milestones.date })
      .from(s.milestones)
      .where(
        and(
          eq(s.milestones.projectId, project.id),
          gte(s.milestones.date, currentDue),
          or(
            isNull(s.milestones.moduleId),
            issue.moduleId ? eq(s.milestones.moduleId, issue.moduleId) : sql`false`,
            sql`exists (select 1 from ${s.milestoneIssues} mi where mi.milestone_id = ${s.milestones.id} and mi.issue_id = ${issue.id})`,
          ),
        ),
      )
      .orderBy(asc(s.milestones.date));

    let parent = null;
    if (issue.parentId) {
      const [p] = await tx.select().from(s.issues).where(eq(s.issues.id, issue.parentId));
      parent = { key: `${project.key}-${p.number}`, planEnd: p.planEnd, exceeded: !!p.planEnd && requestedDue > p.planEnd };
      if (parent.exceeded) warnings.push({ code: 'outside_parent_range', message: `Due ใหม่เกิน Due ของงานแม่ ${parent.key} (${p.planEnd})` });
    }

    return {
      currentDue,
      requestedDue,
      addedWorkingDays,
      workload,
      dependents: dependents.map((d) => ({
        key: `${project.key}-${d.number}`,
        title: d.title,
        planStart: d.planStart,
        type: d.type,
        affected: !!d.planStart && d.planStart <= requestedDue,
      })),
      milestones: milestones.map((m) => ({ ...m, onTime: requestedDue <= m.date })),
      goLive: { date: project.goliveDate, onTime: requestedDue <= project.goliveDate },
      parent,
      approvers: approverIds.map((id) => people.get(id)).filter((p): p is Person => !!p),
      warnings,
    };
  }

  private dto(r: DueRequest, issueKey: string, people: Map<string, Person>) {
    return {
      id: r.id,
      issueKey,
      status: r.status,
      currentDue: r.currentDue,
      requestedDue: r.requestedDue,
      reasonCode: r.reasonCode,
      reasonLabel: REASONS[r.reasonCode],
      detail: r.detail,
      impact: r.impact,
      requester: people.get(r.requesterId) ?? null,
      decidedBy: r.decidedBy ? (people.get(r.decidedBy) ?? null) : null,
      decidedAt: r.decidedAt,
      decidedVia: r.decidedVia,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt,
    };
  }
}

const issueKeyOf = (project: { key: string }, issue: { number: number }) => `${project.key}-${issue.number}`;
const round = (n: number) => Math.round(n * 100) / 100;
const notFoundRequest = () => new AppError(404, 'not_found', 'ไม่พบคำขอเลื่อน Due');
const notPostponement = (currentDue: string) =>
  new AppError(422, 'not_a_postponement', 'Due ใหม่ต้องหลัง Due ปัจจุบัน · ดึง Due เข้ามาเร็วขึ้นแก้ในงานได้เลยไม่ต้องขอ', { currentDue });

function requireDue(issue: Issue) {
  if (!issue.planEnd) throw new AppError(422, 'no_current_due', 'งานนี้ยังไม่มี Due · กำหนด Due ในงานได้เลยไม่ต้องขอ');
  return issue.planEnd;
}
