import { schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo } from '../common/request.js';
import type { ProjectAccess } from '../projects/permissions.js';
import type { ProjectRow } from '../projects/projects.service.js';

type Issue = typeof s.issues.$inferSelect;
const uuid = z.uuid();
const filterId = z.union([uuid, z.literal('none')]);
const filterList = z.string().trim().min(1).max(1000);
const booleanQuery = z.enum(['true', 'false', '1', '0']).transform((x) => x === 'true' || x === '1');
export const TableListQuery = z.object({
  status: filterList.optional(),
  type: z.enum(['Story', 'Task', 'Bug', 'Spike', 'story', 'task', 'bug', 'spike']).optional(),
  assignee: z.union([uuid, z.literal('me'), z.literal('none')]).optional(),
  ba: z.union([uuid, z.literal('me'), z.literal('none')]).optional(),
  module: filterId.optional(), moduleId: filterId.optional(),
  phase: filterId.optional(), phaseId: filterId.optional(),
  sprint: z.union([uuid, z.literal('current'), z.literal('none')]).optional(),
  sprintId: filterId.optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  overdue: booleanQuery.optional(),
  q: z.string().trim().max(300).optional(),
  level: z.enum(['task', 'subtask']).optional(),
  sort: z.string().max(100).optional(),
  view: z.literal('table').optional(),
  fields: z.string().max(1500).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(2000).optional(),
});

const sorts = {
  number: s.issues.number, title: s.issues.title, priority: s.issues.priority, status: s.workflowStatuses.sort,
  estimateMd: s.issues.estimateMd, progressPct: s.issues.progressPct,
  planStart: s.issues.planStart, planEnd: s.issues.planEnd, actualStart: s.issues.actualStart, actualEnd: s.issues.actualEnd,
  createdAt: s.issues.createdAt, updatedAt: s.issues.updatedAt, rank: s.issues.rank, size: s.issues.size,
} as const;
type SortKey = keyof typeof sorts;

export async function listIssues<T extends { id: string; key: string; number: number; type: string; status: { category: string }; [key: string]: unknown }>(
  tx: Tx, auth: AuthInfo, project: ProjectRow, access: ProjectAccess, q: z.infer<typeof TableListQuery>, dto: (rows: Issue[]) => Promise<T[]>,
) {
  if (access.guestViewer && q.view === 'table') throw new AppError(403, 'forbidden', 'Guest Viewer เปิดได้เฉพาะ Overview และ Timeline');
  const where: SQL[] = [eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)];
  const moduleId = q.module ?? q.moduleId;
  const phaseId = q.phase ?? q.phaseId;
  const sprint = q.sprint ?? q.sprintId;
  if (moduleId) where.push(moduleId === 'none' ? isNull(s.issues.moduleId) : eq(s.issues.moduleId, moduleId));
  if (phaseId) where.push(phaseId === 'none' ? isNull(s.issues.phaseId) : eq(s.issues.phaseId, phaseId));
  if (sprint === 'current') where.push(sql`${s.issues.sprintId} in (select id from ${s.sprints} where ${s.sprints.projectId} = ${project.id} and ${s.sprints.status} = 'active')`);
  else if (sprint) where.push(sprint === 'none' ? isNull(s.issues.sprintId) : eq(s.issues.sprintId, sprint));
  if (q.level === 'task') where.push(isNull(s.issues.parentId));
  if (q.level === 'subtask') where.push(sql`${s.issues.parentId} is not null`);
  if (q.status) {
    const values = q.status.split(',');
    const conditions = values.map((value) => {
      if (['todo', 'in_progress', 'done'].includes(value)) return eq(s.workflowStatuses.category, value as 'todo' | 'in_progress' | 'done');
      if (uuid.safeParse(value).success) return eq(s.issues.statusId, value);
      throw new AppError(400, 'invalid_filter', 'ตัวกรองสถานะไม่ถูกต้อง');
    });
    where.push(or(...conditions)!);
  }
  if (q.type) where.push(eq(s.issueTypes.name, q.type[0].toUpperCase() + q.type.slice(1).toLowerCase()));
  if (q.priority) where.push(eq(s.issues.priority, q.priority));
  if (q.assignee) {
    const who = q.assignee === 'me' ? auth.userId : q.assignee;
    where.push(q.assignee === 'none' ? sql`not exists (select 1 from ${s.issueAssignees} a where a.issue_id = ${s.issues.id})`
      : sql`exists (select 1 from ${s.issueAssignees} a where a.issue_id = ${s.issues.id} and a.user_id = ${who})`);
  }
  if (q.ba) where.push(q.ba === 'none' ? isNull(s.issues.baId) : eq(s.issues.baId, q.ba === 'me' ? auth.userId : q.ba));
  const overdue = and(sql`${s.issues.planEnd} < ${today()}`, ne(s.workflowStatuses.category, 'done'))!;
  if (q.overdue !== undefined) where.push(q.overdue ? overdue : sql`not coalesce((${overdue}), false)`);
  if (q.q) {
    // ข้อความค้นหาเป็น literal ไม่เปลี่ยน % / _ เป็น wildcard ของ SQL
    const text = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    // Canvas Table: "ค้นหางาน, รหัส DP-…, FR หรือ SCR"
    const byRequirement = sql`exists (select 1 from ${s.issueRequirements} ir join ${s.requirements} r on r.id = ir.requirement_id where ir.issue_id = ${s.issues.id} and r.code ilike ${text})`;
    const byScreen = sql`exists (select 1 from ${s.issueScreens} isc join ${s.screens} sc on sc.id = isc.screen_id where isc.issue_id = ${s.issues.id} and sc.code ilike ${text})`;
    where.push(or(ilike(s.issues.title, text), ilike(sql`${project.key} || '-' || ${s.issues.number}`, text), byRequirement, byScreen)!);
  }
  if (access.guestViewer) where.push(eq(s.issues.sharedWithGuests, true), ne(s.issueTypes.name, 'Bug'));
  const sortInput = q.sort ?? 'number';
  const parsed = /^(-?)([A-Za-z]+)(?::(asc|desc))?$/.exec(sortInput);
  if (!parsed || !Object.hasOwn(sorts, parsed[2])) throw new AppError(400, 'invalid_sort', 'รูปแบบการเรียงลำดับไม่ถูกต้อง');
  const sortKey = parsed[2] as SortKey;
  const descending = parsed[1] === '-' || parsed[3] === 'desc';
  const column = sorts[sortKey];
  // รายการรวมคำนวณจากผลกรองทั้งหมด ไม่ใช่เฉพาะหน้าที่โหลด
  const totals = q.view === 'table' ? await tx.select({ issue: s.issues, category: s.workflowStatuses.category }).from(s.issues)
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId)).innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId)).where(and(...where)) : null;
  const progressRows = totals ? await tx.select({ issue: s.issues, category: s.workflowStatuses.category }).from(s.issues)
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId)).where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt))) : null;
  if (q.cursor !== undefined) {
    if (/^\d+$/.test(q.cursor) && sortInput === 'number' && Number.isSafeInteger(Number(q.cursor))) where.push(gt(s.issues.number, Number(q.cursor)));
    else {
      const cursor = decodeCursor(q.cursor, sortInput);
      const equal = cursor.value === null ? isNull(column) : sql`${column} = ${cursor.value}`;
      const after = cursor.value === null ? sql`false` : sql`(${column} ${descending ? sql`<` : sql`>`} ${cursor.value} or ${column} is null)`;
      where.push(or(after, and(equal, gt(s.issues.number, cursor.number)))!);
    }
  }
  const rows = await tx.select({ issue: s.issues, sortValue: column }).from(s.issues)
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId)).innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
    .where(and(...where)).orderBy(sql`${descending ? desc(column) : asc(column)} nulls last`, asc(s.issues.number)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  let items: Record<string, unknown>[] = await dto(page.map((r) => r.issue));
  if (q.view === 'table' && page.length) {
    const ids = page.map((r) => r.issue.id);
    const assignmentRows = await tx.select().from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, ids)).orderBy(asc(s.issueAssignees.sort));
    const people = await loadPeople(tx, [...assignmentRows.map((a) => a.userId), ...page.flatMap((r) => [r.issue.baId, r.issue.saId])]);
    const progress = progressCalculator(progressRows!, project.progressMethod === 'weighted');
    items = items.map((item, index) => ({ ...item, progressPct: progress(page[index].issue),
      assignees: assignmentRows.filter((a) => a.issueId === item.id).map((a) => people.get(a.userId)).filter(Boolean),
      ba: people.get(page[index].issue.baId ?? '') ?? null,
      sa: people.get(page[index].issue.saId ?? '') ?? null,
    }));
  }
  if (q.fields) {
    const requested = new Set(q.fields.split(',').filter(Boolean));
    const allowed = new Set(['id', 'key', 'number', 'projectKey', 'type', 'parentKey', 'title', 'description', 'status', 'priority', 'moduleId', 'phaseId', 'sprintId', 'size', 'estimateMd', 'progressPct', 'planStart', 'planEnd', 'actualStart', 'actualEnd', 'reopenCount', 'severity', 'environment', 'details', 'sharedWithGuests', 'version', 'createdAt', 'updatedAt', 'assigneeIds', 'baId', 'saId', 'reviewerId', 'testerId', 'reporterId', 'assignees', 'ba', 'sa', 'labels', 'requirements', 'screens']);
    if ([...requested].some((key) => !allowed.has(key))) throw new AppError(400, 'invalid_fields', 'ชื่อฟิลด์ที่ขอไม่ถูกต้อง');
    requested.add('key');
    items = items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => requested.has(key))));
  }
  const last = page.at(-1);
  const nextCursor = rows.length > q.limit && last ? (sortInput === 'number' ? last.issue.number : Buffer.from(JSON.stringify({ sort: sortInput, number: last.issue.number, value: last.sortValue })).toString('base64url')) : null;
  if (!totals) return { items, nextCursor };
  const modules = await tx.select({ id: s.modules.id, name: s.modules.name, color: s.modules.color }).from(s.modules).where(eq(s.modules.projectId, project.id)).orderBy(asc(s.modules.sort));
  const phases = await tx.select({ id: s.phases.id, moduleId: s.phases.moduleId, name: s.phases.name }).from(s.phases).where(eq(s.phases.projectId, project.id)).orderBy(asc(s.phases.sort));
  const progress = progressCalculator(progressRows!, project.progressMethod === 'weighted');
  const aggregate = (members: typeof totals) => {
    const roots = members.filter((r) => !r.issue.parentId);
    return { taskCount: roots.length, subtaskCount: members.length - roots.length, doneCount: roots.filter((r) => r.category === 'done').length,
      estimateMd: roots.reduce((sum, r) => sum + (r.issue.estimateMd ?? 0), 0), progressPct: rollup(roots.map((r) => ({ md: r.issue.estimateMd, pct: progress(r.issue) })), project.progressMethod === 'weighted') };
  };
  const grouped = [...modules, { id: null, name: null, color: null }].map((module) => ({ ...module,
    ...aggregate(totals.filter((r) => r.issue.moduleId === module.id)),
    phases: [...phases.filter((p) => p.moduleId === module.id), { id: null, name: null, moduleId: module.id }].map((phase) => ({ ...phase, ...aggregate(totals.filter((r) => r.issue.moduleId === module.id && r.issue.phaseId === phase.id)) })),
  }));
  return { items, nextCursor, summary: aggregate(totals), modules: grouped };
}

function decodeCursor(value: string, sort: string): { value: string | number | null; number: number } {
  try {
    const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (data.sort !== sort || !Number.isSafeInteger(data.number) || data.number < 1 || !['string', 'number'].includes(typeof data.value) && data.value !== null) throw new Error();
    return data;
  } catch { throw new AppError(400, 'invalid_cursor', 'Cursor ไม่ถูกต้องหรือใช้กับลำดับอื่น'); }
}

function progressCalculator(rows: { issue: Issue; category: string }[], weighted: boolean) {
  const children = new Map<string, Issue[]>();
  const categories = new Map(rows.map((r) => [r.issue.id, r.category]));
  for (const { issue } of rows) if (issue.parentId) children.set(issue.parentId, [...children.get(issue.parentId) ?? [], issue]);
  const progress = (issue: Issue): number => {
    if (categories.get(issue.id) === 'done') return 100;
    const subs = children.get(issue.id);
    return subs?.length ? rollup(subs.map((sub) => ({ md: sub.estimateMd, pct: progress(sub) })), weighted) : issue.progressPct ?? 0;
  };
  return progress;
}

function rollup(rows: { md: number | null; pct: number }[], weighted: boolean) {
  if (!rows.length) return 0;
  const weight = rows.reduce((sum, row) => sum + (weighted ? row.md ?? 0 : 1), 0);
  return Math.round(weight ? rows.reduce((sum, row) => sum + row.pct * (weighted ? row.md ?? 0 : 1), 0) / weight : rows.reduce((sum, row) => sum + row.pct, 0) / rows.length);
}
