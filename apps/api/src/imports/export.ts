import { schema, type Tx } from '@friday/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { WorkCalendar } from '../projects/calendar.js';

const s = schema;

/** 18 คอลัมน์แบบไฟล์แผนต้นฉบับ · หัวคอลัมน์ต้องตรง alias ใน plan.ts (autoMap) เพื่อให้นำเข้ากลับได้ */
export const EXPORT_HEADERS = ['ID', 'No.', 'Module', 'Sprint', 'Module Task', 'Screen ID', 'FR / NFR', 'BA', 'Status', 'Dev', 'Size', 'Man-Day', 'Plan Start', 'Plan End', 'Actual Start', 'Actual End', 'Remark', 'Working Days'] as const;

const asDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

/** แผนงานของโปรเจกต์เป็น .xlsx (ชีต Table + Holidays) · งานระดับ Task เท่านั้น ไม่รวม Sub-task / Bug */
export async function buildPlanXlsx(tx: Tx, project: { id: string; workspaceId: string; holidayCalendarId: string | null }): Promise<Buffer> {
  const [taskType] = await tx.select({ id: s.issueTypes.id }).from(s.issueTypes).where(and(eq(s.issueTypes.projectId, project.id), eq(s.issueTypes.name, 'Task')));
  const issues = await tx
    .select()
    .from(s.issues)
    .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt), isNull(s.issues.parentId), eq(s.issues.issueTypeId, taskType.id)))
    .orderBy(asc(s.issues.number));
  const [mods, phs, sts, users, asg, reqs, scrs] = await Promise.all([
    tx.select({ id: s.modules.id, name: s.modules.name }).from(s.modules).where(eq(s.modules.projectId, project.id)),
    tx.select({ id: s.phases.id, name: s.phases.name }).from(s.phases).where(eq(s.phases.projectId, project.id)),
    tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name }).from(s.workflowStatuses),
    tx.select({ id: s.users.id, name: s.users.displayName }).from(s.users),
    tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId, sort: s.issueAssignees.sort }).from(s.issueAssignees).innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId)).where(eq(s.issues.projectId, project.id)).orderBy(asc(s.issueAssignees.sort)),
    tx.select({ issueId: s.issueRequirements.issueId, code: s.requirements.code }).from(s.issueRequirements).innerJoin(s.requirements, eq(s.requirements.id, s.issueRequirements.requirementId)).where(eq(s.requirements.projectId, project.id)),
    tx.select({ issueId: s.issueScreens.issueId, code: s.screens.code }).from(s.issueScreens).innerJoin(s.screens, eq(s.screens.id, s.issueScreens.screenId)).where(eq(s.screens.projectId, project.id)),
  ]);
  const name = (m: { id: string; name: string }[]) => new Map(m.map((x) => [x.id, x.name]));
  const [moduleName, phaseName, statusName, userName] = [name(mods), name(phs), name(sts), name(users)];
  const group = <T extends { issueId: string }>(rows: T[], pick: (r: T) => string) => {
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.issueId, [...(out.get(r.issueId) ?? []), pick(r)]);
    return out;
  };
  const [devsOf, reqsOf, scrsOf] = [group(asg, (r) => userName.get(r.userId) ?? ''), group(reqs, (r) => r.code), group(scrs, (r) => r.code)];

  // งานที่ยังไม่มี No. (สร้างในระบบ) ได้เลขต่อจาก No. สูงสุด · นำเข้ากลับจะจับคู่ด้วย ID แล้วบันทึก No. ให้
  let nextNo = Math.max(0, ...issues.map((i) => i.excelRowNo ?? 0)) + 1;
  const cal = await WorkCalendar.load(tx, project);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Table');
  ws.addRow([...EXPORT_HEADERS]).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const i of issues) {
    const details = (i.details ?? {}) as { requirementText?: string };
    const fr = [...(reqsOf.get(i.id) ?? []), ...(details.requirementText ? [details.requirementText] : [])];
    const days = i.planStart && i.planEnd ? cal.workingDaysIn(i.planStart, i.planEnd) : null;
    ws.addRow([
      i.number,
      i.excelRowNo ?? nextNo++,
      i.moduleId ? (moduleName.get(i.moduleId) ?? '') : '',
      i.phaseId ? (phaseName.get(i.phaseId) ?? null) : null,
      i.title,
      (scrsOf.get(i.id) ?? []).join(', ') || null,
      fr.join(', ') || null,
      i.baId ? (userName.get(i.baId) ?? null) : null,
      statusName.get(i.statusId) ?? null,
      (devsOf.get(i.id) ?? []).join(', ') || null,
      i.size,
      i.estimateMd === null ? null : Number(i.estimateMd),
      asDate(i.planStart),
      asDate(i.planEnd),
      asDate(i.actualStart),
      asDate(i.actualEnd),
      i.description,
      days,
    ]);
  }
  for (const col of [13, 14, 15, 16]) ws.getColumn(col).numFmt = 'yyyy-mm-dd';
  ws.columns.forEach((c, n) => (c.width = [8, 6, 22, 24, 48, 18, 18, 14, 14, 24, 7, 10, 12, 12, 12, 12, 30, 13][n]));

  const hs = wb.addWorksheet('Holidays');
  hs.addRow(['Date', 'Name']).font = { bold: true };
  const [ws0] = await tx.select({ cal: s.workspaceSettings.holidayCalendarId }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, project.workspaceId));
  const calendarId = project.holidayCalendarId ?? ws0?.cal ?? null;
  const rows = [
    ...(calendarId ? await tx.select({ date: s.holidays.date, name: s.holidays.name }).from(s.holidays).where(eq(s.holidays.calendarId, calendarId)) : []),
    ...(await tx.select({ date: s.projectHolidays.date, name: s.projectHolidays.name }).from(s.projectHolidays).where(eq(s.projectHolidays.projectId, project.id))),
  ];
  const seen = new Set<string>();
  for (const h of rows.sort((a, b) => a.date.localeCompare(b.date))) {
    if (seen.has(h.date)) continue;
    seen.add(h.date);
    hs.addRow([asDate(h.date), h.name]);
  }
  hs.getColumn(1).numFmt = 'yyyy-mm-dd';
  hs.columns.forEach((c, n) => (c.width = [12, 36][n]));

  return Buffer.from(await wb.xlsx.writeBuffer());
}
