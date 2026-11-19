import { schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo } from '../common/request.js';
import { lateSql, loadDueRule } from '../projects/due-stage.js';
import type { ProjectAccess } from '../projects/permissions.js';
import type { ProjectRow } from '../projects/projects.service.js';
import { countsForProgress, openStatus, STATUS_CATEGORIES, type StatusCategory } from '../common/status-category.js';
import { attachmentCounts, attachmentsOf } from '../files/attachment-counts.js';
import { baList, reviewerList } from './rules.js';

type Issue = typeof s.issues.$inferSelect;
const uuid = z.uuid();
const filterId = z.union([uuid, z.literal('none')]);
const filterList = z.string().trim().min(1).max(1000);
/** รายการ id คั่นด้วย , · none = ไม่มีค่า · current = Sprint ที่กำลังทำ (เฉพาะ Sprint) */
const idList = (withCurrent: boolean) => z.string().trim().min(1).max(2000).transform((v, ctx) => {
  const values = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
  const ok = values.length > 0 && values.length <= 50 && values.every((x) => x === 'none' || (withCurrent && x === 'current') || uuid.safeParse(x).success);
  if (!ok) ctx.addIssue({ code: 'custom', message: 'ตัวกรองไม่ถูกต้อง' });
  return values;
});
const booleanQuery = z.enum(['true', 'false', '1', '0']).transform((x) => x === 'true' || x === '1');
export const TableListQuery = z.object({
  status: filterList.optional(),
  type: z.enum(['Story', 'Task', 'Bug', 'Spike', 'story', 'task', 'bug', 'spike']).optional(),
  assignee: z.union([uuid, z.literal('me'), z.literal('none')]).optional(),
  ba: z.union([uuid, z.literal('me'), z.literal('none')]).optional(),
  // Module / Sprint เลือกได้หลายค่า คั่นด้วย , (ตัวกรองหลายตัวเลือกในแท็บ Table · ผู้ใช้ขอ 2026-11-19)
  module: idList(false).optional(), moduleId: filterId.optional(),
  phase: filterId.optional(), phaseId: filterId.optional(),
  sprint: idList(true).optional(),
  sprintId: filterId.optional(),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
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
  const where = await issueFilters(tx, auth, project, q);
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
    const people = await loadPeople(tx, [...assignmentRows.map((a) => a.userId), ...page.flatMap((r) => [...baList(r.issue), r.issue.saId, ...reviewerList(r.issue)])]);
    const files = await attachmentCounts(tx, ids);
    const progress = progressCalculator(progressRows!, project.progressMethod === 'weighted');
    items = items.map((item, index) => ({ ...item, progressPct: progress(page[index].issue),
      assignees: assignmentRows.filter((a) => a.issueId === item.id).map((a) => people.get(a.userId)).filter(Boolean),
      ba: people.get(page[index].issue.baId ?? '') ?? null,
      // BA หลายคน (คนแรก = ba)
      bas: baList(page[index].issue).map((id) => people.get(id)).filter(Boolean),
      attachments: attachmentsOf(files, page[index].issue.id),
      sa: people.get(page[index].issue.saId ?? '') ?? null,
      reviewer: people.get(page[index].issue.reviewerId ?? '') ?? null,
      // QA หลายคน (คนแรก = reviewer)
      reviewers: reviewerList(page[index].issue).map((id) => people.get(id)).filter(Boolean),
    }));
  }
  if (q.fields) {
    const requested = new Set(q.fields.split(',').filter(Boolean));
    const allowed = new Set(['id', 'key', 'number', 'projectKey', 'type', 'parentKey', 'title', 'description', 'remark', 'status', 'priority', 'moduleId', 'phaseId', 'sprintId', 'size', 'estimateMd', 'progressPct', 'planStart', 'planEnd', 'qaEnd', 'qaDue', 'dueDate', 'dueStage', 'actualStart', 'actualEnd', 'reopenCount', 'severity', 'environment', 'details', 'sharedWithGuests', 'version', 'createdAt', 'updatedAt', 'assigneeIds', 'baId', 'baIds', 'saId', 'reviewerId', 'reviewerIds', 'testerId', 'reporterId', 'canMove', 'assignees', 'ba', 'bas', 'attachments', 'sa', 'reviewer', 'reviewers', 'labels', 'requirements', 'screens', 'customFields']);
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
    // งานที่ยกเลิกไม่นับในจำนวนและความคืบหน้า
    const counted = members.filter((r) => countsForProgress(r.category));
    const roots = counted.filter((r) => !r.issue.parentId);
    return { taskCount: roots.length, subtaskCount: counted.length - roots.length, doneCount: roots.filter((r) => r.category === 'done').length,
      estimateMd: roots.reduce((sum, r) => sum + (r.issue.estimateMd ?? 0), 0), progressPct: rollup(roots.map((r) => ({ md: r.issue.estimateMd, pct: progress(r.issue) })), project.progressMethod === 'weighted') };
  };
  const grouped = [...modules, { id: null, name: null, color: null }].map((module) => ({ ...module,
    ...aggregate(totals.filter((r) => r.issue.moduleId === module.id)),
    phases: [...phases.filter((p) => p.moduleId === module.id), { id: null, name: null, moduleId: module.id }].map((phase) => ({ ...phase, ...aggregate(totals.filter((r) => r.issue.moduleId === module.id && r.issue.phaseId === phase.id)) })),
  }));
  return { items, nextCursor, summary: aggregate(totals), modules: grouped };
}

type FilterQuery = Omit<z.infer<typeof TableListQuery>, 'limit'> & { limit?: number };

/** เงื่อนไขกรองงานชุดเดียวกับแท็บ Table · ใช้ซ้ำตอน Export ตามตัวกรอง (ต้องได้งานชุดเดียวกับที่เห็นในตาราง) */
export async function issueFilters(tx: Tx, auth: AuthInfo, project: ProjectRow, q: FilterQuery): Promise<SQL[]> {
  const where: SQL[] = [eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)];
  const modules = q.module ?? (q.moduleId ? [q.moduleId] : undefined);
  const phaseId = q.phase ?? q.phaseId;
  const sprints = q.sprint ?? (q.sprintId ? [q.sprintId] : undefined);
  if (modules) where.push(anyOf(s.issues.moduleId, modules, () => sql`false`));
  if (phaseId) where.push(phaseId === 'none' ? isNull(s.issues.phaseId) : eq(s.issues.phaseId, phaseId));
  if (sprints) where.push(anyOf(s.issues.sprintId, sprints, () => sql`${s.issues.sprintId} in (select id from ${s.sprints} where ${s.sprints.projectId} = ${project.id} and ${s.sprints.status} = 'active')`));
  if (q.size) where.push(eq(s.issues.size, q.size));
  if (q.level === 'task') where.push(isNull(s.issues.parentId));
  if (q.level === 'subtask') where.push(sql`${s.issues.parentId} is not null`);
  if (q.status) {
    const values = q.status.split(',');
    const conditions = values.map((value) => {
      if ((STATUS_CATEGORIES as readonly string[]).includes(value)) return eq(s.workflowStatuses.category, value as StatusCategory);
      // open = งานค้างทุกหมวด (ซ่อนงานที่เสร็จ / ยกเลิก)
      if (value === 'open') return openStatus();
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
  // BA หลายคน: กรองเจองานที่คนนั้นเป็น BA คนใดคนหนึ่ง
  if (q.ba) where.push(q.ba === 'none' ? sql`cardinality(${s.issues.baIds}) = 0 and ${s.issues.baId} is null`
    : sql`(${q.ba === 'me' ? auth.userId : q.ba})::uuid = any(${s.issues.baIds})`);
  // โปรเจกต์แยก Dev / QA: งานที่รอ QA เลยกำหนดตาม QA Due (projects/due-stage.ts)
  const dueRule = await loadDueRule(tx, project);
  const overdue = and(lateSql(dueRule, today()), openStatus())!;
  if (q.overdue !== undefined) where.push(q.overdue ? overdue : sql`not coalesce((${overdue}), false)`);
  if (q.q) {
    // ข้อความค้นหาเป็น literal ไม่เปลี่ยน % / _ เป็น wildcard ของ SQL
    const text = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    // ค้นจากชื่อ, รหัส DP-…, FR / SCR, รายละเอียด, หมายเหตุ และค่าใน details (Bug steps / expected / actual ฯลฯ · ผู้ใช้ขอ 2026-11-18)
    // details ค้นเฉพาะค่า ไม่ค้นชื่อคีย์ของ JSON เพื่อไม่ให้คำอย่าง "steps" เจอทุกงาน
    const byDetails = sql`exists (select 1 from jsonb_each_text(${s.issues.details}) d where d.value ilike ${text})`;
    const byRequirement = sql`exists (select 1 from ${s.issueRequirements} ir join ${s.requirements} r on r.id = ir.requirement_id where ir.issue_id = ${s.issues.id} and r.code ilike ${text})`;
    const byScreen = sql`exists (select 1 from ${s.issueScreens} isc join ${s.screens} sc on sc.id = isc.screen_id where isc.issue_id = ${s.issues.id} and sc.code ilike ${text})`;
    where.push(or(ilike(s.issues.title, text), ilike(sql`${project.key} || '-' || ${s.issues.number}`, text),
      ilike(s.issues.description, text), ilike(s.issues.remark, text), byDetails, byRequirement, byScreen)!);
  }
  return where;
}

/** คอลัมน์ตรงกับค่าใดค่าหนึ่ง: none = ว่าง · current = เงื่อนไขพิเศษ */
function anyOf(column: typeof s.issues.moduleId | typeof s.issues.sprintId, values: string[], current: () => SQL): SQL {
  const ids = values.filter((v) => v !== 'none' && v !== 'current');
  return or(
    ...(ids.length ? [inArray(column, ids)] : []),
    ...(values.includes('none') ? [isNull(column)] : []),
    ...(values.includes('current') ? [current()] : []),
  )!;
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
  const progress = (issue: Issue): number => issueProgress(categories.get(issue.id), issue.progressPct,
    (children.get(issue.id) ?? []).map((sub) => ({ category: categories.get(sub.id), md: sub.estimateMd, pct: progress(sub) })), weighted, issue.checklistPct);
  return progress;
}

/** Progress ของงานหนึ่งตัว: เสร็จแล้ว = 100 · มี Sub-task (ไม่นับที่ยกเลิก) = เฉลี่ยจาก Sub-task · ไม่มี = ค่าที่เก็บไว้ (กรอกเองหรือจาก Checklist)
 *  Task ที่มีทั้ง Sub-task และ Checklist ของตัวเอง: Checklist นับเป็นอีกหนึ่งส่วนเท่ากับ Sub-task หนึ่งตัว (ผู้ใช้ขอ 2026-11-16)
 *  แบบถ่วง Man-Day ให้ส่วนนี้หนักเท่าค่าเฉลี่ยของ Sub-task · ใช้ทุกที่ที่รวม Progress เพื่อให้ตัวเลขตรงกัน */
export function issueProgress(category: string | undefined, ownPct: number | null, subs: { category: string | undefined; md: number | null; pct: number }[], weighted: boolean, checklistPct: number | null = null) {
  if (category === 'done') return 100;
  const counted = subs.filter((sub) => countsForProgress(sub.category));
  if (!counted.length) return ownPct ?? 0;
  return rollup(withChecklistPart(counted, checklistPct), weighted);
}

/** เพิ่ม Checklist ของ Task แม่เป็นอีกหนึ่งส่วน · น้ำหนัก = Man-Day เฉลี่ยของ Sub-task */
export function withChecklistPart<T extends { md: number | null; pct: number }>(subs: T[], checklistPct: number | null): (T | { md: number; pct: number })[] {
  if (checklistPct === null || !subs.length) return subs;
  const md = subs.reduce((sum, sub) => sum + (sub.md ?? 0), 0) / subs.length;
  return [...subs, { md, pct: checklistPct }];
}

export function rollup(rows: { md: number | null; pct: number }[], weighted: boolean) {
  if (!rows.length) return 0;
  const weight = rows.reduce((sum, row) => sum + (weighted ? row.md ?? 0 : 1), 0);
  return Math.round(weight ? rows.reduce((sum, row) => sum + row.pct * (weighted ? row.md ?? 0 : 1), 0) / weight : rows.reduce((sum, row) => sum + row.pct, 0) / rows.length);
}
