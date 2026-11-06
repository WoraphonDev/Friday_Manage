import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { loadPeople } from '../common/people.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import type { ProjectRow } from '../projects/projects.service.js';
import { computeWorkload } from '../overview/workload.js';

export type SprintRow = typeof s.sprints.$inferSelect;
export type SprintIssue = typeof s.issues.$inferSelect & { category: string; type: string; statusName: string; assigneeIds: string[] };
const round = (value: number) => Math.round(value * 100) / 100;

export async function loadIssues(tx: Tx, projectId: string): Promise<SprintIssue[]> {
  const rows = await tx.select({ issue: s.issues, category: s.workflowStatuses.category, statusName: s.workflowStatuses.name, type: s.issueTypes.name })
    .from(s.issues)
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
    .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
    .where(and(eq(s.issues.projectId, projectId), isNull(s.issues.deletedAt)))
    .orderBy(asc(s.issues.rank), asc(s.issues.number));
  const assignees = rows.length ? await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
    .from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, rows.map((row) => row.issue.id))).orderBy(asc(s.issueAssignees.userId)) : [];
  const byIssue = new Map<string, string[]>();
  for (const row of assignees) byIssue.set(row.issueId, [...(byIssue.get(row.issueId) ?? []), row.userId]);
  return rows.map(({ issue, ...extra }) => ({ ...issue, ...extra, assigneeIds: byIssue.get(issue.id) ?? [] }));
}

/** นับ MD เฉพาะระดับล่างสุด เพื่อไม่รวมทั้ง estimate ของแม่และลูกซ้ำ */
export function leafIssues(rows: SprintIssue[]) {
  const parents = new Set(rows.map((row) => row.parentId).filter(Boolean));
  return rows.filter((row) => !parents.has(row.id));
}

export function totals(rows: SprintIssue[]) {
  const leaves = leafIssues(rows);
  return {
    totalMd: round(leaves.reduce((sum, row) => sum + (row.estimateMd ?? 0), 0)),
    remainingMd: round(leaves.reduce((sum, row) => sum + (row.category !== 'done' ? row.estimateMd ?? 0 : 0), 0)),
    doneMd: round(leaves.reduce((sum, row) => sum + (row.category === 'done' ? row.estimateMd ?? 0 : 0), 0)),
    issueCount: leaves.length,
    doneCount: leaves.filter((row) => row.category === 'done').length,
    unestimatedCount: leaves.filter((row) => row.estimateMd === null).length,
  };
}

export async function saveSnapshot(tx: Tx, sprint: SprintRow, rows: SprintIssue[], date: string) {
  const { remainingMd, doneMd, issueCount, doneCount } = totals(rows);
  const values = { workspaceId: sprint.workspaceId, sprintId: sprint.id, date, remainingMd, doneMd, issueCount, doneCount };
  await tx.insert(s.sprintDailySnapshots).values(values).onConflictDoUpdate({ target: [s.sprintDailySnapshots.sprintId, s.sprintDailySnapshots.date], set: { remainingMd, doneMd, issueCount, doneCount } });
  return values;
}

export async function capacity(tx: Tx, project: ProjectRow, sprint: SprintRow, rows: SprintIssue[], cal: WorkCalendar) {
  const members = await tx.select({ userId: s.projectMembers.userId, projectHours: s.projectMembers.capacityHoursWeek, workspaceHours: s.workspaceMembers.capacityHoursWeek })
    .from(s.projectMembers).innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, project.workspaceId), eq(s.workspaceMembers.userId, s.projectMembers.userId)))
    .where(and(eq(s.projectMembers.projectId, project.id), eq(s.workspaceMembers.status, 'active'))).orderBy(asc(s.projectMembers.userId));
  const ids = members.map((member) => member.userId);
  const leave = ids.length ? await tx.select({ userId: s.leaves.userId, startDate: s.leaves.startDate, endDate: s.leaves.endDate, halfDay: s.leaves.halfDay }).from(s.leaves)
    .where(and(inArray(s.leaves.userId, ids), eq(s.leaves.status, 'approved'), lte(s.leaves.startDate, sprint.endDate), gte(s.leaves.endDate, sprint.startDate))) : [];
  const result = computeWorkload({ from: sprint.startDate, to: sprint.endDate, group: 'month', items: [], people: members.map((member) => ({ userId: member.userId, capacityHoursWeek: member.projectHours ?? member.workspaceHours })), leaves: leave, calendarOf: () => cal, capacityCalendar: cal });
  const profiles = await loadPeople(tx, ids);
  const committed = new Map<string, number>();
  let unassignedMd = 0;
  for (const issue of leafIssues(rows)) {
    const md = issue.estimateMd ?? 0;
    if (!issue.assigneeIds.length) unassignedMd += md;
    for (const id of issue.assigneeIds) committed.set(id, (committed.get(id) ?? 0) + md / issue.assigneeIds.length);
  }
  const people = members.map((member) => {
    const cells = result.rows.get(member.userId) ?? [];
    const capacityMd = round(cells.reduce((sum, cell) => sum + cell.capacityMd, 0));
    const committedMd = round(committed.get(member.userId) ?? 0);
    return { person: profiles.get(member.userId), capacityHoursWeek: member.projectHours ?? member.workspaceHours, capacityMd, committedMd, leaveDays: round(cells.reduce((sum, cell) => sum + cell.leaveDays, 0)), overloaded: committedMd > capacityMd };
  });
  const totalMd = round(people.reduce((sum, person) => sum + person.capacityMd, 0));
  const committedMd = totals(rows).totalMd;
  return { capacityMd: totalMd, committedMd, unassignedMd: round(unassignedMd), unavailableAssigneeMd: round([...committed].filter(([id]) => !ids.includes(id)).reduce((sum, [, md]) => sum + md, 0)), overloaded: committedMd > totalMd, workingDays: cal.workingDaysIn(sprint.startDate, sprint.endDate), people };
}

export async function burndown(tx: Tx, sprint: SprintRow, rows: SprintIssue[], cal: WorkCalendar, date: string) {
  const actual = await tx.select({ date: s.sprintDailySnapshots.date, remainingMd: s.sprintDailySnapshots.remainingMd, doneMd: s.sprintDailySnapshots.doneMd, issueCount: s.sprintDailySnapshots.issueCount, doneCount: s.sprintDailySnapshots.doneCount }).from(s.sprintDailySnapshots)
    .where(eq(s.sprintDailySnapshots.sprintId, sprint.id)).orderBy(asc(s.sprintDailySnapshots.date));
  const baseline = actual[0] ? round(actual[0].remainingMd + actual[0].doneMd) : totals(rows).totalMd;
  const workDays = cal.workingDaysIn(sprint.startDate, sprint.endDate);
  // จุดแรกคือต้นวันแรก แล้วลดเฉพาะวันทำการจนจบวันสุดท้าย
  const ideal = [{ date: addDays(sprint.startDate, -1), remainingMd: baseline }];
  let elapsed = 0;
  for (let day = sprint.startDate; day <= sprint.endDate; day = addDays(day, 1)) {
    if (cal.isWorkingDay(day)) elapsed++;
    ideal.push({ date: day, remainingMd: workDays ? round(baseline * (1 - elapsed / workDays)) : baseline });
    if (day === sprint.endDate) break;
  }
  return { sprintId: sprint.id, asOf: date, baselineMd: baseline, ideal, actual };
}

export function issueDto(issue: SprintIssue, projectKey: string) {
  return { id: issue.id, key: `${projectKey}-${issue.number}`, title: issue.title, type: issue.type, parentId: issue.parentId, rank: issue.rank, sprintId: issue.sprintId, moduleId: issue.moduleId, size: issue.size, estimateMd: issue.estimateMd, priority: issue.priority, planStart: issue.planStart, planEnd: issue.planEnd, progressPct: issue.progressPct, status: { id: issue.statusId, name: issue.statusName, category: issue.category }, assigneeIds: issue.assigneeIds, version: issue.version };
}
