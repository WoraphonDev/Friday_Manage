// ขอบเขตข้อมูลของ Home / My Tasks: ทุกโปรเจกต์ที่ผู้เรียกเข้าถึงได้ (RLS) พร้อมกฎของ Guest
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { projectAccess, type ProjectAccess } from '../projects/permissions.js';

export type Issue = typeof s.issues.$inferSelect;
export type Project = typeof s.projects.$inferSelect;
export type Status = typeof s.workflowStatuses.$inferSelect;

export interface Scope {
  projects: Project[];
  access: Map<string, ProjectAccess>;
  /** โปรเจกต์ที่ฉันเป็นเจ้าของหรือเป็นสมาชิกจริง (ไม่นับแค่ที่ visibility ให้เห็น) */
  mine: Set<string>;
  issues: Issue[];
  statuses: Map<string, Status>;
  typeNames: Map<string, string>;
  assignees: Map<string, string[]>;
  keyOf: (i: Issue) => string;
  isDone: (i: Issue) => boolean;
  isBug: (i: Issue) => boolean;
  /** Guest ที่เป็น Viewer ของโปรเจกต์ใดโปรเจกต์หนึ่ง */
  anyGuest: boolean;
}

/** งานที่ยังไม่เสร็จหรือเพิ่งเสร็จ (ภายใน doneSince) ของทุกโปรเจกต์ที่เข้าถึงได้ · Guest Viewer เห็นเฉพาะงานที่แชร์และไม่ใช่ Bug */
export async function loadScope(tx: Tx, auth: AuthInfo, tenant: TenantInfo, opts: { doneSince?: Date } = {}): Promise<Scope> {
  const projects = await tx
    .select()
    .from(s.projects)
    .where(and(isNull(s.projects.deletedAt), isNull(s.projects.archivedAt), sql`${s.projects.status} <> 'archived'`))
    .orderBy(asc(s.projects.name));
  const access = new Map<string, ProjectAccess>();
  for (const p of projects) access.set(p.id, await projectAccess(tx, auth, tenant, p));
  const accessible = projects.filter((p) => access.get(p.id)!.role);

  const memberships = accessible.length
    ? await tx.select({ projectId: s.projectMembers.projectId }).from(s.projectMembers).where(and(eq(s.projectMembers.userId, auth.userId), inArray(s.projectMembers.projectId, accessible.map((p) => p.id))))
    : [];
  const mine = new Set([...memberships.map((m) => m.projectId), ...accessible.filter((p) => p.ownerUserId === auth.userId).map((p) => p.id)]);

  const ids = accessible.map((p) => p.id);
  const statusRows = ids.length ? await tx.select().from(s.workflowStatuses).where(inArray(s.workflowStatuses.projectId, ids)) : [];
  const statuses = new Map(statusRows.map((x) => [x.id, x]));
  const types = ids.length ? await tx.select({ id: s.issueTypes.id, name: s.issueTypes.name }).from(s.issueTypes).where(inArray(s.issueTypes.projectId, ids)) : [];
  const typeNames = new Map(types.map((x) => [x.id, x.name]));
  const doneIds = new Set(statusRows.filter((x) => x.category === 'done').map((x) => x.id));

  const rows = ids.length ? await tx.select().from(s.issues).where(and(inArray(s.issues.projectId, ids), isNull(s.issues.deletedAt))).orderBy(asc(s.issues.projectId), asc(s.issues.number)) : [];
  const since = opts.doneSince?.getTime() ?? Infinity;
  const issues = rows.filter((i) => {
    if (access.get(i.projectId)!.guestViewer && (!i.sharedWithGuests || typeNames.get(i.issueTypeId) === 'Bug')) return false;
    // งานที่เสร็จนานแล้วไม่เกี่ยวกับ Home / My Tasks
    return !doneIds.has(i.statusId) || (i.completedAt !== null && i.completedAt.getTime() >= since);
  });

  const assigneeRows = issues.length ? await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, issues.map((i) => i.id))).orderBy(asc(s.issueAssignees.sort)) : [];
  const assignees = new Map<string, string[]>();
  for (const a of assigneeRows) assignees.set(a.issueId, [...(assignees.get(a.issueId) ?? []), a.userId]);

  const projectKey = new Map(projects.map((p) => [p.id, p.key]));
  return {
    projects: accessible,
    access,
    mine,
    issues,
    statuses,
    typeNames,
    assignees,
    keyOf: (i) => `${projectKey.get(i.projectId)}-${i.number}`,
    isDone: (i) => doneIds.has(i.statusId),
    isBug: (i) => typeNames.get(i.issueTypeId) === 'Bug',
    anyGuest: accessible.some((p) => access.get(p.id)!.guestViewer),
  };
}
