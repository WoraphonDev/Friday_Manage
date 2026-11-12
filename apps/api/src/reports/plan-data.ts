// ข้อมูลแผนของโปรเจกต์ที่ Lead Dashboard และ Reports ใช้ร่วมกัน (อ่านครั้งเดียวต่อคำขอ)
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { WorkCalendar } from '../projects/calendar.js';
import { dueOf, loadDueRule } from '../projects/due-stage.js';
import type { StatusCategory } from '../common/status-category.js';
import { reviewerList } from '../issues/rules.js';

export type IssueRow = typeof s.issues.$inferSelect;

export interface Item {
  id: string;
  key: string;
  title: string;
  type: string;
  isBug: boolean;
  moduleId: string | null;
  estimateMd: number;
  planStart: string | null;
  planEnd: string | null;
  /** วันที่ใช้ตัดสินเลยกำหนด: Plan End · โปรเจกต์แยก Dev / QA และงานรอ QA = QA Due (projects/due-stage.ts) */
  dueDate: string | null;
  /** คนที่รับผิดชอบเมื่องานเลยกำหนด: ขั้น QA = QA / Reviewer · ที่เหลือ = Assignee */
  lateOwners: string[];
  category: StatusCategory;
  statusName: string;
  progressPct: number;
  assigneeIds: string[];
  reviewerId: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface PlanData {
  items: Item[];
  /** Task / Sub-task ระดับล่างสุดที่ไม่ใช่ Bug · ใช้นับความคืบหน้าและ Man-Day */
  work: Item[];
  modules: Array<{ id: string; name: string }>;
  milestones: Array<{ name: string; date: string; moduleId: string | null }>;
  deps: Array<{ pred: string; succ: string }>;
  cal: WorkCalendar;
}

type Project = { id: string; key: string; workspaceId: string; holidayCalendarId: string | null; progressSplit: boolean; qaBufferDays: number };

export async function loadPlan(tx: Tx, project: Project): Promise<PlanData> {
  const rows = await tx
    .select({ i: s.issues, category: s.workflowStatuses.category, statusName: s.workflowStatuses.name, type: s.issueTypes.name })
    .from(s.issues)
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
    .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
    .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)))
    .orderBy(asc(s.issues.number));
  const ids = rows.map((r) => r.i.id);
  const assignees = ids.length
    ? await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, ids)).orderBy(asc(s.issueAssignees.sort))
    : [];
  const by = new Map<string, string[]>();
  for (const a of assignees) by.set(a.issueId, [...(by.get(a.issueId) ?? []), a.userId]);
  const cal = await WorkCalendar.load(tx, project);
  const dueRule = await loadDueRule(tx, project, cal);
  const items: Item[] = rows.map(({ i, category, statusName, type }) => {
    const due = dueOf(dueRule, i, category);
    return {
    id: i.id,
    key: `${project.key}-${i.number}`,
    title: i.title,
    type,
    isBug: type === 'Bug',
    moduleId: i.moduleId,
    estimateMd: i.estimateMd ?? 0,
    planStart: i.planStart,
    planEnd: i.planEnd,
    dueDate: due.date,
    lateOwners: due.stage === 'qa' && reviewerList(i).length ? reviewerList(i) : (by.get(i.id) ?? []),
    category: category as Item['category'],
    statusName,
    progressPct: category === 'done' ? 100 : (i.progressPct ?? 0),
    assigneeIds: by.get(i.id) ?? [],
    reviewerId: i.reviewerId,
    completedAt: i.completedAt,
    createdAt: i.createdAt,
    };
  });
  // Task ที่มี Sub-task เป็นตัวสรุป (Estimate = ผลรวม Sub-task) · Bug ใต้ Task ไม่ทำให้ Task หยุดเป็นระดับล่างสุด
  const bugIds = new Set(items.filter((i) => i.isBug).map((i) => i.id));
  const parents = new Set(rows.filter((r) => r.i.parentId && !bugIds.has(r.i.id)).map((r) => r.i.parentId!));
  // งานที่ยกเลิกไม่อยู่ในแผน (ไม่นับใน Man-Day ความคืบหน้า และพยากรณ์)
  const work = items.filter((i) => !i.isBug && !parents.has(i.id) && i.category !== 'cancelled');
  const modules = await tx.select({ id: s.modules.id, name: s.modules.name }).from(s.modules).where(eq(s.modules.projectId, project.id)).orderBy(asc(s.modules.sort), asc(s.modules.name));
  const milestones = await tx.select({ name: s.milestones.name, date: s.milestones.date, moduleId: s.milestones.moduleId }).from(s.milestones).where(eq(s.milestones.projectId, project.id)).orderBy(asc(s.milestones.date));
  const deps = ids.length ? await tx.select({ pred: s.issueDependencies.predecessorId, succ: s.issueDependencies.successorId }).from(s.issueDependencies).where(inArray(s.issueDependencies.predecessorId, ids)) : [];
  return { items, work, modules, milestones, deps, cal };
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const isOpen = (i: Item) => i.category !== 'done' && i.category !== 'cancelled';
