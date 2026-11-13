import { schema, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { today } from '../common/dates.js';
import { addTimelineSheet, type TimelineInput, type TimelineRow } from './timeline-sheet.js';
import { dueOf, loadDueRule } from '../projects/due-stage.js';
import type { ProfileField, ResolvedProfile } from '../projects/field-profile.js';
import { type CustomFieldDef, displayValue, readCustomValues } from '../issues/custom-values.js';
import { reviewerList } from '../issues/rules.js';
import { acceptanceText } from './plan.js';

const s = schema;

/**
 * คอลัมน์ของชีต Tasks (รูปแบบใหม่) · หัวคอลัมน์ต้องตรง alias ใน plan.ts (autoMap) เพื่อให้นำเข้ากลับได้
 * Key ว่าง = งานใหม่ · Parent Key = Sub-task ของ Task นั้น · ไม่มีคอลัมน์ No. (จับคู่ด้วย Key)
 * Checklist 1 แถวต่อ 1 ข้อ: ข้อแรกอยู่ในแถวของงาน ข้อถัดไปเป็นแถวต่อท้ายที่มีเฉพาะ Key / Parent Key / Module / Group / Title
 */
export const EXPORT_HEADERS = [
  'Key',
  'Parent Key',
  'Module',
  'Group',
  'Title',
  'Checklist',
  'Status',
  'Priority',
  'Business Analyst',
  'System Analyst',
  'Developer',
  'QA / Reviewer',
  'Size',
  'Man-Day',
  'Plan Start',
  'Plan End',
  'QA Due',
  'Actual Start',
  'Actual End',
  'Requirement',
  'Screen',
  'Label',
  'Description',
  'Remark',
] as const;
type Header = (typeof EXPORT_HEADERS)[number];
const WIDTH = [10, 11, 22, 18, 44, 48, 13, 10, 18, 18, 24, 24, 7, 9, 12, 12, 12, 12, 12, 18, 16, 16, 40, 32];
const WIDTH_OF = Object.fromEntries(EXPORT_HEADERS.map((h, i) => [h, WIDTH[i]])) as Record<Header, number>;
/** คอลัมน์ที่ขึ้นกับชุดฟิลด์ของโปรเจกต์ · ฟิลด์ที่ซ่อนทั้ง Task และ Sub-task ไม่ส่งออก (นำเข้ากลับแล้วไม่แตะค่าเดิม) */
const HEADER_FIELD: Partial<Record<Header, ProfileField>> = {
  Priority: 'priority', 'Business Analyst': 'ba', 'System Analyst': 'sa', 'QA / Reviewer': 'reviewer', Size: 'size',
  'Actual Start': 'actual', 'Actual End': 'actual', Requirement: 'requirements', Screen: 'screens', Label: 'labels', Remark: 'remark',
};

const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' } as const;
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const DEFAULT_STATUSES = ['To do', 'In progress', 'Review', 'Done'];
const VALUES = 'ค่าที่ใช้ได้';
const MAX_ROWS = 5000;
/** คอลัมน์ที่แถวต่อท้ายของ Checklist ใส่ซ้ำ (plan.ts ใช้ระบุว่าเป็นงานเดิม) */
const CHECKLIST_IDENTITY = new Set<Header>(['Key', 'Parent Key', 'Module', 'Group', 'Title']);

const asDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

interface SheetData {
  /** หัวคอลัมน์ตามลำดับ (มาตรฐานที่แสดง + Custom field) */
  headers?: string[];
  rows: (string | number | Date | null)[][];
  /** แถวที่เป็น Sub-task (index ใน rows) แสดงย่อหน้าชื่องาน */
  subRows: Set<number>;
  /** แถวต่อท้ายของ Checklist (index ใน rows) แสดงชื่องานสีจาง */
  checklistRows?: Set<number>;
  statuses: string[];
  modules: string[];
  people: string[];
  holidays: { date: string; name: string }[];
  /** ชีต Timeline (เฉพาะ Export แผนของโปรเจกต์) */
  timeline?: TimelineInput;
}

/** แผนงานของโปรเจกต์เป็น .xlsx: Task + Sub-task (ไม่รวม Bug) เรียง Task แล้วตามด้วย Sub-task ของมัน */
export async function buildPlanXlsx(
  tx: Tx,
  project: { id: string; key: string; name: string; startDate: string; goliveDate: string; workspaceId: string; holidayCalendarId: string | null; progressSplit?: boolean; qaBufferDays?: number },
  options: { scale?: 'day' | 'week'; today?: string; profile?: ResolvedProfile; customFields?: CustomFieldDef[] } = {},
): Promise<Buffer> {
  const shown = (h: Header) => {
    // QA Due มีเฉพาะโปรเจกต์แยก Dev / QA · โปรเจกต์อื่นได้ไฟล์แบบเดิม
    if (h === 'QA Due') return !!project.progressSplit;
    const f = HEADER_FIELD[h];
    const rule = f ? options.profile?.fields[f] : undefined;
    return !rule || rule.task !== 'hidden' || rule.subtask !== 'hidden';
  };
  const standard = EXPORT_HEADERS.filter(shown);
  // Custom field ที่ซ่อนทั้งสองระดับไม่ส่งออก · ชื่อชนกับคอลัมน์มาตรฐานต่อท้าย (Custom)
  const customs = (options.customFields ?? []).filter((f) => f.taskMode !== 'hidden' || f.subtaskMode !== 'hidden');
  const taken = new Set(EXPORT_HEADERS.map((h) => h.toLowerCase()));
  const customHeaders = customs.map((f) => (taken.has(f.name.toLowerCase()) ? `${f.name} (Custom)` : f.name));
  const [taskType] = await tx.select({ id: s.issueTypes.id, workflowId: s.issueTypes.workflowId }).from(s.issueTypes).where(and(eq(s.issueTypes.projectId, project.id), eq(s.issueTypes.name, 'Task')));
  const issues = await tx
    .select()
    .from(s.issues)
    .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt), eq(s.issues.issueTypeId, taskType.id)))
    .orderBy(asc(s.issues.number));
  const ids = issues.map((i) => i.id);
  const some = <T>(q: () => Promise<T[]>) => (ids.length ? q() : Promise.resolve([] as T[]));
  const [mods, phs, sts, users, asg, reqs, scrs, lbls, checks] = await Promise.all([
    tx.select({ id: s.modules.id, name: s.modules.name }).from(s.modules).where(eq(s.modules.projectId, project.id)).orderBy(asc(s.modules.sort)),
    tx.select({ id: s.phases.id, name: s.phases.name }).from(s.phases).where(eq(s.phases.projectId, project.id)),
    tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name, category: s.workflowStatuses.category }).from(s.workflowStatuses).where(eq(s.workflowStatuses.workflowId, taskType.workflowId)).orderBy(asc(s.workflowStatuses.sort)),
    tx.select({ id: s.users.id, name: s.users.displayName }).from(s.users),
    some(() => tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, ids)).orderBy(asc(s.issueAssignees.sort))),
    some(() => tx.select({ issueId: s.issueRequirements.issueId, code: s.requirements.code }).from(s.issueRequirements).innerJoin(s.requirements, eq(s.requirements.id, s.issueRequirements.requirementId)).where(inArray(s.issueRequirements.issueId, ids))),
    some(() => tx.select({ issueId: s.issueScreens.issueId, code: s.screens.code }).from(s.issueScreens).innerJoin(s.screens, eq(s.screens.id, s.issueScreens.screenId)).where(inArray(s.issueScreens.issueId, ids))),
    some(() => tx.select({ issueId: s.issueLabels.issueId, name: s.labels.name }).from(s.issueLabels).innerJoin(s.labels, eq(s.labels.id, s.issueLabels.labelId)).where(inArray(s.issueLabels.issueId, ids))),
    // Checklist ก่อน Acceptance แล้วตามลำดับในงาน · นำเข้ากลับได้ลำดับเดิม
    some(() => tx.select({ issueId: s.checklistItems.issueId, kind: s.checklistItems.kind, text: s.checklistItems.text }).from(s.checklistItems).where(inArray(s.checklistItems.issueId, ids)).orderBy(asc(s.checklistItems.kind), asc(s.checklistItems.sort), asc(s.checklistItems.id))),
  ]);
  const moduleName = new Map(mods.map((x) => [x.id, x.name]));
  const groupName = new Map(phs.map((x) => [x.id, x.name]));
  const userName = new Map(users.map((x) => [x.id, x.name]));
  const statusName = new Map(sts.map((x) => [x.id, x.name]));
  const group = <T extends { issueId: string }>(list: T[], pick: (r: T) => string) => {
    const out = new Map<string, string[]>();
    for (const r of list) out.set(r.issueId, [...(out.get(r.issueId) ?? []), pick(r)]);
    return out;
  };
  const [devsOf, reqsOf, scrsOf, lblsOf, checksOf] = [group(asg, (r) => userName.get(r.userId) ?? ''), group(reqs, (r) => r.code), group(scrs, (r) => r.code), group(lbls, (r) => r.name), group(checks, (r) => (r.kind === 'acceptance' ? acceptanceText(r.text) : r.text))];
  const byId = new Map(issues.map((i) => [i.id, i]));
  const join = (list: string[] | undefined) => (list?.length ? list.join(', ') : null);
  const person = (id: string | null) => (id ? (userName.get(id) ?? null) : null);

  // Task เรียงตามลำดับในแผนเดิม (ถ้ามี) แล้วตามเลขงาน · Sub-task ต่อท้าย Task แม่
  const tops = issues.filter((i) => !i.parentId).sort((a, b) => (a.excelRowNo ?? Infinity) - (b.excelRowNo ?? Infinity) || a.number - b.number);
  const kids = group(issues.filter((i) => i.parentId && byId.has(i.parentId)).map((i) => ({ issueId: i.parentId!, id: i.id })), (r) => r.id);
  const ordered = tops.flatMap((t) => [t, ...(kids.get(t.id) ?? []).map((id) => byId.get(id)!)]);

  const customOf = await readCustomValues(tx, ids);
  const userText = (v: unknown) => (typeof v === 'string' ? (userName.get(v) ?? v) : v);
  const cell = (f: CustomFieldDef, v: unknown): string | number | Date | null => {
    const shownValue = f.fieldType === 'user' ? userText(v) : displayValue(f, v);
    if (shownValue === null || shownValue === undefined) return null;
    if (f.fieldType === 'date') return asDate(String(shownValue));
    if (Array.isArray(shownValue)) return shownValue.join(', ');
    return typeof shownValue === 'number' ? shownValue : String(shownValue);
  };
  const rows: SheetData['rows'] = [];
  const subRows = new Set<number>();
  const checklistRows = new Set<number>();
  for (const i of ordered) {
    const parent = i.parentId ? byId.get(i.parentId) : undefined;
    const details = (i.details ?? {}) as { requirementText?: string };
    const [firstCheck, ...moreChecks] = checksOf.get(i.id) ?? [];
    if (parent) subRows.add(rows.length);
    const full: (string | number | Date | null)[] = [
      `${project.key}-${i.number}`,
      parent ? `${project.key}-${parent.number}` : null,
      i.moduleId ? (moduleName.get(i.moduleId) ?? null) : null,
      i.phaseId ? (groupName.get(i.phaseId) ?? null) : null,
      i.title,
      firstCheck ?? null,
      statusName.get(i.statusId) ?? null,
      PRIORITY_LABEL[i.priority],
      person(i.baId),
      person(i.saId),
      join(devsOf.get(i.id)),
      join(reviewerList(i).map((u) => person(u)).filter((x): x is string => !!x)),
      i.size,
      i.estimateMd === null ? null : Number(i.estimateMd),
      asDate(i.planStart),
      asDate(i.planEnd),
      asDate(i.qaEnd),
      asDate(i.actualStart),
      asDate(i.actualEnd),
      join([...(reqsOf.get(i.id) ?? []), ...(details.requirementText ? [details.requirementText] : [])]),
      join(scrsOf.get(i.id)),
      join(lblsOf.get(i.id)),
      i.description,
      i.remark,
    ];
    const values = customOf.get(i.id) ?? {};
    rows.push([...EXPORT_HEADERS.flatMap((h, n) => (shown(h) ? [full[n]] : [])), ...customs.map((f) => cell(f, values[f.id] ?? null))]);
    for (const text of moreChecks) {
      if (parent) subRows.add(rows.length);
      checklistRows.add(rows.length);
      rows.push([...EXPORT_HEADERS.flatMap((h, n) => (shown(h) ? [h === 'Checklist' ? text : CHECKLIST_IDENTITY.has(h) ? full[n] : null] : [])), ...customs.map(() => null)]);
    }
  }

  const [ws0] = await tx.select({ cal: s.workspaceSettings.holidayCalendarId }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, project.workspaceId));
  const calendarId = project.holidayCalendarId ?? ws0?.cal ?? null;
  const holidays = [
    ...(calendarId ? await tx.select({ date: s.holidays.date, name: s.holidays.name }).from(s.holidays).where(eq(s.holidays.calendarId, calendarId)) : []),
    ...(await tx.select({ date: s.projectHolidays.date, name: s.projectHolidays.name }).from(s.projectHolidays).where(eq(s.projectHolidays.projectId, project.id))),
  ];
  // Timeline: เรียงตาม Module แล้ว Task (ลำดับเดียวกับชีต Tasks) และ Sub-task ใต้แม่
  const category = new Map(sts.map((x) => [x.id, x.category]));
  // โปรเจกต์แยก Dev / QA: งานที่รอ QA ระบายสีเลยกำหนดตาม QA Due
  const dueRule = await loadDueRule(tx, { ...project, progressSplit: project.progressSplit ?? false, qaBufferDays: project.qaBufferDays ?? 0 });
  const taskRow = (i: (typeof issues)[number]): TimelineRow => {
    const cat = category.get(i.statusId) ?? 'todo';
    return { kind: 'task', key: `${project.key}-${i.number}`, title: i.title, sub: !!i.parentId, status: statusName.get(i.statusId) ?? '', category: cat, progress: i.progressPct ?? (cat === 'done' ? 100 : 0), start: i.planStart, end: i.planEnd, due: dueOf(dueRule, i, cat).date };
  };
  const timelineRows: TimelineRow[] = [];
  for (const m of [...mods.map((x) => ({ id: x.id as string | null, name: x.name })), { id: null, name: 'ไม่ระบุ Module' }]) {
    const inModule = ordered.filter((i) => (i.moduleId ?? null) === m.id);
    if (!inModule.length) continue;
    const startsM = inModule.map((i) => i.planStart).filter((d): d is string => !!d).sort();
    const endsM = inModule.map((i) => i.planEnd).filter((d): d is string => !!d).sort();
    timelineRows.push({ kind: 'module', name: m.name, start: startsM[0] ?? null, end: endsM.at(-1) ?? null }, ...inModule.map(taskRow));
  }
  return render({
    headers: [...standard, ...customHeaders], rows, subRows, checklistRows, statuses: sts.map((x) => x.name), modules: mods.map((m) => m.name), people: await memberNames(tx), holidays,
    timeline: { projectName: project.name, today: options.today ?? today(), from: project.startDate, to: project.goliveDate, scale: options.scale ?? 'day', holidays: new Set(holidays.map((h) => h.date)), rows: timelineRows },
  });
}

/** Template เปล่าสำหรับเริ่มแผนใหม่ (สร้างโปรเจกต์จากไฟล์) · มีรายชื่อสมาชิกและวันหยุดของ Workspace ให้เลือก */
export async function buildTemplateXlsx(tx: Tx, workspaceId: string): Promise<Buffer> {
  const [ws0] = await tx.select({ cal: s.workspaceSettings.holidayCalendarId }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, workspaceId));
  const holidays = ws0?.cal ? await tx.select({ date: s.holidays.date, name: s.holidays.name }).from(s.holidays).where(eq(s.holidays.calendarId, ws0.cal)) : [];
  return render({ rows: [], subRows: new Set(), statuses: DEFAULT_STATUSES, modules: [], people: await memberNames(tx), holidays });
}

/** สมาชิกที่จับคู่ได้ตอนนำเข้า (ไม่รวม Guest) */
async function memberNames(tx: Tx) {
  const rows = await tx
    .select({ name: s.users.displayName })
    .from(s.workspaceMembers)
    .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
    .where(and(eq(s.workspaceMembers.status, 'active'), ne(s.workspaceMembers.role, 'guest')));
  return [...new Set(rows.map((r) => r.name))].sort((a, b) => a.localeCompare(b));
}

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const KEY_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
const SUB_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };

async function render(d: SheetData): Promise<Buffer> {
  // Template เปล่าใช้ได้กับทุกโปรเจกต์ จึงไม่มีคอลัมน์ QA Due (เพิ่มเองได้ ระบบจับคู่จากชื่อหัวคอลัมน์)
  const headers = d.headers ?? EXPORT_HEADERS.filter((h) => h !== 'QA Due');
  // คอลัมน์ที่ไม่ได้ส่งออกได้เลข 0 · ใช้กับการจัดรูปแบบที่ข้ามคอลัมน์ที่ไม่มี
  const COL = Object.fromEntries(EXPORT_HEADERS.map((h) => [h, headers.indexOf(h) + 1])) as Record<Header, number>;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tasks', { views: [{ state: 'frozen', xSplit: COL.Title, ySplit: 1 }] });
  const head = ws.addRow(headers);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => (c.fill = HEAD_FILL));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  d.rows.forEach((r, i) => {
    const row = ws.addRow(r);
    row.getCell(COL.Key).fill = KEY_FILL;
    if (d.subRows.has(i)) {
      row.getCell(COL.Title).alignment = { indent: 2 };
      row.getCell(COL['Parent Key']).fill = SUB_FILL;
    }
    if (d.checklistRows?.has(i)) row.getCell(COL.Title).font = { color: { argb: 'FF9CA3AF' } };
  });
  if (COL.Checklist) ws.getColumn(COL.Checklist).alignment = { wrapText: true, vertical: 'top' };
  for (const c of [COL['Plan Start'], COL['Plan End'], COL['QA Due'], COL['Actual Start'], COL['Actual End']]) if (c) ws.getColumn(c).numFmt = 'yyyy-mm-dd';
  ws.columns.forEach((c, n) => (c.width = WIDTH_OF[headers[n] as Header] ?? 18));
  if (d.timeline) addTimelineSheet(wb, d.timeline);

  // ชีตค่าที่ใช้ได้ + รายการเลือกในเซลล์ (พิมพ์ค่าอื่นได้ ระบบตรวจตอนนำเข้า)
  const lists: [string, string[]][] = [
    ['Status', d.statuses],
    ['Priority', Object.values(PRIORITY_LABEL)],
    ['Size', SIZES],
    ['Module', d.modules],
    ['สมาชิก', d.people],
  ];
  const vs = wb.addWorksheet(VALUES);
  vs.addRow(lists.map(([h]) => h)).font = { bold: true };
  const longest = Math.max(...lists.map(([, v]) => v.length));
  for (let i = 0; i < longest; i++) vs.addRow(lists.map(([, v]) => v[i] ?? null));
  vs.columns.forEach((c) => (c.width = 22));
  const validations = (ws as unknown as { dataValidations: { add: (range: string, v: ExcelJS.DataValidation) => void } }).dataValidations;
  const letter = (n: number) => ws.getColumn(n).letter;
  const pick = (col: number, list: number) => {
    const n = lists[list][1].length;
    if (!n || !col) return;
    const src = vs.getColumn(list + 1).letter;
    validations.add(`${letter(col)}2:${letter(col)}${MAX_ROWS}`, {
      type: 'list',
      allowBlank: true,
      showErrorMessage: false,
      formulae: [`'${VALUES}'!$${src}$2:$${src}$${n + 1}`],
    });
  };
  pick(COL.Status, 0);
  pick(COL.Priority, 1);
  pick(COL.Size, 2);
  pick(COL.Module, 3);
  for (const c of [COL['Business Analyst'], COL['System Analyst'], COL['QA / Reviewer']]) pick(c, 4);

  const guide = wb.addWorksheet('คำแนะนำ');
  guide.addRow(['คอลัมน์', 'ความหมาย', 'จำเป็น']).font = { bold: true };
  for (const r of GUIDE) guide.addRow(r);
  guide.addRow([]);
  for (const line of NOTES) guide.addRow([line]);
  guide.columns.forEach((c, n) => (c.width = [18, 80, 10][n]));
  guide.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const hs = wb.addWorksheet('Holidays');
  hs.addRow(['Date', 'Name']).font = { bold: true };
  const seen = new Set<string>();
  for (const h of [...d.holidays].sort((a, b) => a.date.localeCompare(b.date))) {
    if (seen.has(h.date)) continue;
    seen.add(h.date);
    hs.addRow([asDate(h.date), h.name]);
  }
  hs.getColumn(1).numFmt = 'yyyy-mm-dd';
  hs.columns.forEach((c, n) => (c.width = [12, 36][n]));

  // เปิดไฟล์มาเจอชีต Tasks ก่อน
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const GUIDE: [string, string, string][] = [
  ['Key', 'รหัสงานในระบบ เช่น DP-12 · แถวที่มี Key = แก้งานเดิม · เว้นว่าง = สร้างงานใหม่ (ระบบออกเลขให้) · อย่าแก้ Key ของงานเดิม', '—'],
  ['Parent Key', 'Key ของ Task แม่ ถ้าแถวนี้เป็น Sub-task · Task แม่ต้องอยู่ในไฟล์หรือในโปรเจกต์ และต้องไม่เป็น Sub-task เอง', '—'],
  ['Module', 'ชื่อ Module · ยังไม่มีในโปรเจกต์ = สร้างให้ · Sub-task ใช้ Module ของ Task แม่เสมอ', 'Task'],
  ['Group', 'กลุ่มของ Task ใต้ Module (ไม่บังคับ) · ยังไม่มี = สร้างให้ · ว่าง = ไม่มีกลุ่ม · Sub-task อยู่กลุ่มเดียวกับ Task แม่เสมอ', '—'],
  ['Title', 'ชื่องาน', 'ใช่'],
  ['Checklist', '1 แถวต่อ 1 ข้อ: ข้อแรกใส่ในแถวของงาน ข้อถัดไปเพิ่มแถวใต้งานโดยใส่ Title (และ Key ถ้ามี) เดียวกัน ช่องอื่นเว้นว่าง · ขึ้นต้นด้วย [Acceptance] = Acceptance criteria · อัปเดตแผน: ข้อใหม่เพิ่มให้ ข้อที่ลบออกจากไฟล์ลบเฉพาะที่ยังไม่ติ๊ก', '—'],
  ['Status', 'สถานะตาม Workflow ของโปรเจกต์ (ดูชีตค่าที่ใช้ได้) · ว่าง = To do', '—'],
  ['Priority', 'Urgent / High / Medium / Low · ว่าง = Medium (งานใหม่) หรือคงค่าเดิม', '—'],
  ['Business Analyst', 'ชื่อที่แสดงของสมาชิก 1 คน', '—'],
  ['System Analyst', 'ชื่อที่แสดงของสมาชิก 1 คน', '—'],
  ['Developer', 'ชื่อสมาชิก หลายคนคั่นด้วย ,', '—'],
  ['QA / Reviewer', 'ชื่อสมาชิก หลายคนคั่นด้วย ,', '—'],
  ['Size', 'XS / S / M / L / XL · ว่างแต่มี Man-Day = คำนวณให้ (งานใหม่)', '—'],
  ['Man-Day', 'จำนวนวันทำงานรวมทั้งทีม (ตัวเลขมากกว่า 0)', '—'],
  ['Plan Start / Plan End', 'วันที่ YYYY-MM-DD · ไม่มีทั้งคู่ = Backlog · Plan End ว่าง = คำนวณจาก Man-Day ตามวันทำงาน', '—'],
  ['QA Due', 'โปรเจกต์ที่แยก Dev / QA: วันที่ QA ต้องทดสอบเสร็จ YYYY-MM-DD · ว่าง = Plan End + วันเผื่อ QA', '—'],
  ['Actual Start / Actual End', 'วันที่เริ่ม / เสร็จจริง YYYY-MM-DD', '—'],
  ['Requirement', 'รหัส FR-xxx / NFR-xxx หลายค่าคั่นด้วย ,', '—'],
  ['Screen', 'รหัส SCR-xxx หลายค่าคั่นด้วย ,', '—'],
  ['Label', 'ชื่อ Label หลายค่าคั่นด้วย , · ยังไม่มี = สร้างให้', '—'],
  ['Description', 'รายละเอียดงาน', '—'],
  ['Remark', 'หมายเหตุของงาน · ไม่ใช่รายละเอียด (แยกกันคนละช่อง)', '—'],
];

const NOTES = [
  'นำเข้า: หน้า Import / Export › เลือก "สร้างโปรเจกต์ใหม่" หรือ "อัปเดตแผนของโปรเจกต์เดิม" แล้วอัปโหลดไฟล์นี้',
  'อัปเดตแผน: งานที่อยู่ในระบบแต่ลบแถวออกจากไฟล์ ระบบจะถามก่อนว่าเก็บไว้หรือลบ · คอลัมน์ที่ลบออกจากไฟล์ = ไม่แตะค่าเดิมในระบบ',
  'ชีต Holidays: วันหยุดที่ใช้คำนวณ Plan End · วันที่ไม่มีในปฏิทินของ Workspace จะเพิ่มเป็นวันหยุดของโปรเจกต์ (ตอนสร้างโปรเจกต์)',
  'ไฟล์รูปแบบเดิม (มีคอลัมน์ No.) ยังนำเข้าได้ ระบบจับคู่ด้วย No. เหมือนเดิม',
];
