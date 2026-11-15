import { schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { today } from '../common/dates.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { openStatus } from '../common/status-category.js';
import type { DomainEvent } from '../core/events.js';
import type { ProjectRow } from './projects.service.js';

const s = schema;

/**
 * ย้ายชื่อผู้รับผิดชอบในงานที่ยังไม่เสร็จของโปรเจกต์ · ใช้กติกาเดียวกับการแก้ Assignee ใน PATCH งาน (version, Activity, การแก้ไขแผน, Event)
 * ใช้ทั้งตอนนำออกจากโปรเจกต์ (P3) และตอนปิดการใช้งานใน Workspace · to = null คือไม่ระบุผู้รับผิดชอบ
 */
export async function reassignOpenIssues(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: Pick<ProjectRow, 'id' | 'key'>, userId: string, to: string | null, reason: string, events: DomainEvent[]) {
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

export interface OpenWork {
  /** งานที่ยังไม่เสร็จ (รวม Sub-task) */
  open: number;
  subtasks: number;
  overdue: number;
  /** Man-Day ของงานที่ค้าง แบ่งเท่ากันตามจำนวน Dev (ธรรมเนียมใน docs/decisions.md) */
  md: number;
}

/** งานค้างของแต่ละคนในโปรเจกต์ (Assignee, ยังไม่อยู่หมวด done, ไม่อยู่ในถังขยะ) */
export async function openWork(tx: Tx, projectId: string, userIds?: string[]) {
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
