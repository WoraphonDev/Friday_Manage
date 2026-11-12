// การคำนวณ Workload ใช้ร่วมกันระหว่างหน้า 1 (Overview), 7 (Members), O1 (A09), E (A10) และ N1
// วิธีคิด (01-entities › ค่าที่คำนวณ, docs/decisions.md):
//   * Man-Day ของงานกระจายเท่ากันตามวันทำการระหว่าง Plan Start–End แล้วแบ่งเท่ากันต่อ Dev
//   * นับเฉพาะงานระดับล่างสุด (Task ที่ไม่มี Sub-task หรือ Sub-task) เพราะ Estimate ของ Task ที่มี Sub-task = ผลรวม Sub-task
//   * capacity = ชั่วโมงต่อสัปดาห์ ÷ 8 (1 MD) ÷ จำนวนวันทำงานต่อสัปดาห์ ต่อวันทำการ · หักวันหยุดและวันลา
//   * มี 2 ชุด (ผู้ใช้ตัดสิน 9 พ.ย. 2026): plan = ตามแผนเสมอ · actual = ตามที่ทำจริง ใช้ดู performance
//     actual: งานที่เสร็จกระจายตาม Actual Start–End (ไม่มีใช้ Plan Start และวันที่เสร็จ) · งานที่ยังไม่เสร็จ
//     ส่วนที่คืบหน้าแล้วอยู่ก่อนวันนี้ ส่วนที่เหลือกระจายจากวันนี้ถึง Plan End (เลยกำหนดแล้วตกที่วันนี้)
import { schema as s, type Tx } from '@friday/db';
import { and, eq, inArray, isNull, lte, gte, ne, sql } from 'drizzle-orm';
import { today } from '../common/dates.js';
import { loadPeople, type Person } from '../common/people.js';
import { config } from '../config.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import { closedStatus } from '../common/status-category.js';

export const HOURS_PER_MD = 8;
const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(d);
/** ช่วงยาวสุดที่ขอได้ในครั้งเดียว · กันคำขอที่วนวันเป็นหมื่นรอบ */
export const MAX_RANGE_DAYS = 366;

export type WorkloadUnit = 'md' | 'hour' | 'count';
export type WorkloadBasis = 'plan' | 'actual';
export type WorkloadGroup = 'day' | 'week' | 'month';

export interface Bucket {
  start: string;
  end: string;
}

/** งานที่นับ Workload ได้ (ระดับล่างสุด) */
export interface WorkItem {
  id: string;
  projectId: string;
  key: string;
  title: string;
  moduleId: string | null;
  estimateMd: number | null;
  planStart: string | null;
  planEnd: string | null;
  assigneeIds: string[];
  /** ใช้กับ basis = actual · ไม่ส่ง = ถือว่ายังไม่เสร็จและยังไม่เริ่ม */
  done?: boolean;
  progressPct?: number | null;
  actualStart?: string | null;
  /** Actual End หรือวันที่เสร็จ (เวลาไทย) */
  actualEnd?: string | null;
}

export interface CapacityPerson {
  userId: string;
  /** ชั่วโมงต่อสัปดาห์ที่ใช้เป็น capacity (โปรเจกต์: project_members → workspace_members) */
  capacityHoursWeek: number;
}

export interface LeaveSpan {
  userId: string;
  startDate: string;
  endDate: string;
  halfDay: 'am' | 'pm' | null;
}

export interface WorkloadInput {
  from: string;
  to: string;
  group: WorkloadGroup;
  items: WorkItem[];
  people: CapacityPerson[];
  leaves: LeaveSpan[];
  /** ปฏิทินที่ใช้กระจาย Man-Day ของงาน (ตามโปรเจกต์ของงาน) */
  calendarOf: (projectId: string) => WorkCalendar;
  /** ปฏิทินที่ใช้คิด capacity ของคน */
  capacityCalendar: WorkCalendar;
  /** ค่าเริ่มต้น plan */
  basis?: WorkloadBasis;
  /** วันนี้ (เวลาไทย) ใช้แบ่งส่วนที่ทำแล้ว / ที่เหลือของ basis = actual */
  today?: string;
}

export interface CellItem {
  id: string;
  projectId: string;
  key: string;
  title: string;
  md: number;
}

export interface WorkloadCell {
  md: number;
  capacityMd: number;
  /** จำนวนวันลา (ครึ่งวัน = 0.5) ที่ตกในวันทำการของช่วงนี้ */
  leaveDays: number;
  items: CellItem[];
}

export interface WorkloadResult {
  buckets: Bucket[];
  rows: Map<string, WorkloadCell[]>;
}

const isoWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** สัปดาห์ (จันทร์–อาทิตย์) ที่มีวันนี้อยู่ */
export function weekOf(date: string): Bucket {
  const start = addDays(date, 1 - isoWeekday(date));
  return { start, end: addDays(start, 6) };
}

const monthEnd = (date: string) => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** แบ่งช่วง from–to เป็นวัน / สัปดาห์ (จันทร์–อาทิตย์) / เดือน · ช่วงแรกและช่วงสุดท้ายตัดตาม from–to */
export function buckets(from: string, to: string, group: WorkloadGroup): Bucket[] {
  const out: Bucket[] = [];
  let start = from;
  while (start <= to) {
    const natural = group === 'day' ? start : group === 'week' ? weekOf(start).end : monthEnd(start);
    const end = natural < to ? natural : to;
    out.push({ start, end });
    start = addDays(end, 1);
  }
  return out;
}

/** วันทำการของงานและ Man-Day ต่อคนต่อวัน · null = คำนวณไม่ได้ (ไม่มีวันในแผน, Man-Day หรือ Dev) */
export function dailyShare(cal: WorkCalendar, item: Pick<WorkItem, 'estimateMd' | 'planStart' | 'planEnd' | 'assigneeIds'>) {
  if (!item.estimateMd || !item.planStart || !item.planEnd || !item.assigneeIds.length) return null;
  const days: string[] = [];
  for (let d = item.planStart; d <= item.planEnd; d = addDays(d, 1)) if (cal.isWorkingDay(d)) days.push(d);
  // ช่วงที่เป็นวันหยุดทั้งหมด: นับไว้ที่วันทำการถัดไป เพื่อไม่ให้ Man-Day หายไปจาก Workload
  if (!days.length) days.push(cal.onOrAfter(item.planStart));
  return { days, perPersonPerDay: item.estimateMd / days.length / item.assigneeIds.length };
}

/** ช่วงวันและ Man-Day ที่ใช้กระจายของงานหนึ่งตาม basis */
export function workSpans(item: WorkItem, basis: WorkloadBasis, today: string): { start: string; end: string; md: number }[] {
  const md = item.estimateMd ?? 0;
  if (!md) return [];
  if (basis === 'plan') return item.planStart && item.planEnd ? [{ start: item.planStart, end: item.planEnd, md }] : [];
  if (item.done) {
    const end = item.actualEnd ?? item.planEnd;
    if (!end) return [];
    const start = item.actualStart ?? item.planStart ?? end;
    return [{ start: start <= end ? start : end, end, md }];
  }
  const out: { start: string; end: string; md: number }[] = [];
  const doneMd = (md * Math.min(100, Math.max(0, item.progressPct ?? 0))) / 100;
  const started = item.actualStart ?? item.planStart;
  const yesterday = addDays(today, -1);
  // ส่วนที่คืบหน้าแล้วเกิดก่อนวันนี้ · ยังไม่ถึงวันเริ่มให้รวมไปกับส่วนที่เหลือ
  const pastShare = doneMd > 0 && started && started <= yesterday ? doneMd : 0;
  if (pastShare) out.push({ start: started!, end: yesterday, md: pastShare });
  const left = md - pastShare;
  if (left > 0) {
    const start = item.planStart && item.planStart > today ? item.planStart : today;
    const end = item.planEnd && item.planEnd > start ? item.planEnd : start;
    out.push({ start, end, md: left });
  }
  return out;
}

/** MD ของงานที่ควรเสร็จตามแผนภายในวันที่ asOf (นับวันทำการแบบเดียวกับ Workload) */
export function plannedMdBy(cal: WorkCalendar, item: Pick<WorkItem, 'estimateMd' | 'planStart' | 'planEnd'>, asOf: string) {
  if (!item.estimateMd || !item.planStart || !item.planEnd) return 0;
  if (asOf >= item.planEnd) return item.estimateMd;
  if (asOf < item.planStart) return 0;
  const total = cal.workingDaysIn(item.planStart, item.planEnd);
  if (!total) return item.estimateMd;
  return (item.estimateMd * cal.workingDaysIn(item.planStart, asOf)) / total;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** คำนวณ Workload ต่อคนต่อช่วง · ไม่แตะฐานข้อมูล (A09, A10 เรียกตรงได้) */
export function computeWorkload(input: WorkloadInput): WorkloadResult {
  const bks = buckets(input.from, input.to, input.group);
  const indexOf = new Map<string, number>();
  bks.forEach((b, i) => {
    for (let d = b.start; d <= b.end; d = addDays(d, 1)) indexOf.set(d, i);
  });

  const raw = new Map<string, { md: number; capacityMd: number; leaveDays: number; items: Map<string, CellItem> }[]>();
  const rowOf = (userId: string) => {
    let row = raw.get(userId);
    if (!row) {
      row = bks.map(() => ({ md: 0, capacityMd: 0, leaveDays: 0, items: new Map() }));
      raw.set(userId, row);
    }
    return row;
  };

  // capacity: วันทำการ × ชั่วโมงต่อวัน · วันลาหักเต็มวันหรือครึ่งวัน
  const leaveOf = new Map<string, Map<string, number>>();
  for (const l of input.leaves) {
    const m = leaveOf.get(l.userId) ?? new Map<string, number>();
    const from = l.startDate > input.from ? l.startDate : input.from;
    const to = l.endDate < input.to ? l.endDate : input.to;
    for (let d = from; d <= to; d = addDays(d, 1)) m.set(d, Math.min(1, (m.get(d) ?? 0) + (l.halfDay ? 0.5 : 1)));
    leaveOf.set(l.userId, m);
  }
  const cal = input.capacityCalendar;
  for (const p of input.people) {
    const row = rowOf(p.userId);
    const perDay = p.capacityHoursWeek / HOURS_PER_MD / cal.daysPerWeek;
    const leaves = leaveOf.get(p.userId);
    for (const [d, i] of indexOf) {
      if (!cal.isWorkingDay(d)) continue;
      const off = leaves?.get(d) ?? 0;
      row[i].capacityMd += perDay * (1 - off);
      row[i].leaveDays += off;
    }
  }

  const wanted = new Set(input.people.map((p) => p.userId));
  const basis = input.basis ?? 'plan';
  const now = input.today ?? input.from;
  for (const item of input.items) {
    const cal = input.calendarOf(item.projectId);
    for (const span of workSpans(item, basis, now)) {
      const share = dailyShare(cal, { estimateMd: span.md, planStart: span.start, planEnd: span.end, assigneeIds: item.assigneeIds });
      if (!share) continue;
      for (const d of share.days) {
        const i = indexOf.get(d);
        if (i === undefined) continue;
        for (const userId of item.assigneeIds) {
          if (!wanted.has(userId)) continue;
          const cell = rowOf(userId)[i];
          cell.md += share.perPersonPerDay;
          const ci = cell.items.get(item.id) ?? { id: item.id, projectId: item.projectId, key: item.key, title: item.title, md: 0 };
          ci.md += share.perPersonPerDay;
          cell.items.set(item.id, ci);
        }
      }
    }
  }

  const rows = new Map<string, WorkloadCell[]>();
  for (const [userId, row] of raw) {
    rows.set(
      userId,
      row.map((c) => ({
        md: round2(c.md),
        capacityMd: round2(c.capacityMd),
        leaveDays: c.leaveDays,
        items: [...c.items.values()].map((x) => ({ ...x, md: round2(x.md) })).sort((a, b) => b.md - a.md || a.key.localeCompare(b.key)),
      })),
    );
  }
  return { buckets: bks, rows };
}

/** แปลงค่า MD เป็นหน่วยที่หน้าจอขอ · จำนวนงานไม่มี capacity */
export function inUnit(cell: WorkloadCell, unit: WorkloadUnit) {
  if (unit === 'count') return { value: cell.items.length, capacity: null };
  const k = unit === 'hour' ? HOURS_PER_MD : 1;
  return { value: round2(cell.md * k), capacity: round2(cell.capacityMd * k) };
}

export const utilization = (md: number, capacityMd: number) => (capacityMd > 0 ? Math.round((md / capacityMd) * 100) : md > 0 ? null : 0);

// ---------------------------------------------------------------------------
// โหลดข้อมูลจากฐานข้อมูล (ทุก query ผ่าน tx ที่ตั้ง RLS แล้ว)
// ---------------------------------------------------------------------------

type IssueRow = Pick<
  typeof s.issues.$inferSelect,
  'id' | 'projectId' | 'number' | 'title' | 'parentId' | 'estimateMd' | 'planStart' | 'planEnd' | 'moduleId' | 'progressPct' | 'actualStart' | 'actualEnd' | 'completedAt'
>;

/** งานระดับล่างสุดพร้อม Dev · ตัดงานที่มี Sub-task ที่ยังไม่ถูกลบ */
export async function loadWorkItems(tx: Tx, projects: { id: string; key: string }[]): Promise<WorkItem[]> {
  if (!projects.length) return [];
  const keyOf = new Map(projects.map((p) => [p.id, p.key]));
  const rows: (IssueRow & { bug: boolean; done: boolean })[] = await tx
    .select({
      id: s.issues.id,
      projectId: s.issues.projectId,
      number: s.issues.number,
      title: s.issues.title,
      parentId: s.issues.parentId,
      estimateMd: s.issues.estimateMd,
      planStart: s.issues.planStart,
      planEnd: s.issues.planEnd,
      moduleId: s.issues.moduleId,
      progressPct: s.issues.progressPct,
      actualStart: s.issues.actualStart,
      actualEnd: s.issues.actualEnd,
      completedAt: s.issues.completedAt,
      bug: sql<boolean>`${s.issueTypes.name} = 'Bug'`,
      done: sql<boolean>`${s.workflowStatuses.category} = 'done'`,
    })
    .from(s.issues)
    .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
    // งานที่ยกเลิกไม่เป็นภาระงาน
    .where(and(inArray(s.issues.projectId, [...keyOf.keys()]), isNull(s.issues.deletedAt), ne(s.workflowStatuses.category, 'cancelled')));
  // Bug ใต้ Task ไม่ได้แบ่ง Man-Day ของ Task จึงไม่ทำให้ Task หยุดเป็นงานระดับล่างสุด
  const parents = new Set(rows.filter((r) => r.parentId && !r.bug).map((r) => r.parentId!));
  const leaves = rows.filter((r) => !parents.has(r.id));
  const assignees = await loadAssignees(tx, leaves.map((r) => r.id));
  return leaves.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    key: `${keyOf.get(r.projectId)}-${r.number}`,
    title: r.title,
    moduleId: r.moduleId,
    estimateMd: r.estimateMd,
    planStart: r.planStart,
    planEnd: r.planEnd,
    assigneeIds: assignees.get(r.id) ?? [],
    done: r.done,
    progressPct: r.progressPct,
    actualStart: r.actualStart,
    actualEnd: r.actualEnd ?? (r.completedAt ? localDate(r.completedAt) : null),
  }));
}

export async function loadAssignees(tx: Tx, issueIds: string[]) {
  const map = new Map<string, string[]>();
  if (!issueIds.length) return map;
  const rows = await tx
    .select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
    .from(s.issueAssignees)
    .where(inArray(s.issueAssignees.issueId, issueIds))
    .orderBy(s.issueAssignees.sort);
  for (const r of rows) map.set(r.issueId, [...(map.get(r.issueId) ?? []), r.userId]);
  return map;
}

/** วันลาที่ทับช่วง from–to · นับทั้งที่รออนุมัติและอนุมัติแล้ว (ดูบันทึกผล A08) */
export async function loadLeaves(tx: Tx, userIds: string[], from: string, to: string): Promise<LeaveSpan[]> {
  if (!userIds.length) return [];
  return tx
    .select({ userId: s.leaves.userId, startDate: s.leaves.startDate, endDate: s.leaves.endDate, halfDay: s.leaves.halfDay })
    .from(s.leaves)
    .where(and(inArray(s.leaves.userId, userIds), lte(s.leaves.startDate, to), gte(s.leaves.endDate, from)));
}

/** ปฏิทินของ Workspace (ไม่รวมวันหยุดเฉพาะโปรเจกต์) ใช้กับ Workload รวมทุกโปรเจกต์ */
export async function loadWorkspaceCalendar(tx: Tx, workspaceId: string) {
  const [ws] = await tx
    .select({ workDays: s.workspaceSettings.workDays, calendarId: s.workspaceSettings.holidayCalendarId })
    .from(s.workspaceSettings)
    .where(eq(s.workspaceSettings.workspaceId, workspaceId));
  const off = new Set<string>();
  if (ws?.calendarId) {
    const rows = await tx.select({ date: s.holidays.date }).from(s.holidays).where(eq(s.holidays.calendarId, ws.calendarId));
    rows.forEach((r) => off.add(r.date));
  }
  return new WorkCalendar(new Set(ws?.workDays ?? [1, 2, 3, 4, 5]), off);
}

// ---------------------------------------------------------------------------
// Workload ของโปรเจกต์ (หน้า 7, O1, Overview)
// ---------------------------------------------------------------------------

export interface ProjectWorkloadOptions {
  from: string;
  to: string;
  group: WorkloadGroup;
  unit: WorkloadUnit;
  basis?: WorkloadBasis;
  /** คำนวณอีก basis หนึ่งไว้เทียบด้วย */
  compare?: boolean;
  moduleId?: string;
  /** ตำแหน่งใน project_members (เช่น Backend) ไม่สนตัวพิมพ์เล็กใหญ่ */
  position?: string;
}

type ProjectLike = { id: string; key: string; workspaceId: string; holidayCalendarId: string | null };

/**
 * คนใน Workload ของโปรเจกต์ = Dev ที่มีงานในโปรเจกต์นี้ (ไม่นับงานที่ลบ) และยังเป็นสมาชิก Workspace ที่ active
 * BA / PM ที่ไม่มีงานเป็น Dev ไม่อยู่ในกราฟ เพื่อให้ capacity ทีมตรงกับหน้าจอ ("Dev 6 คน × 5 วันทำการ")
 */
export async function projectWorkload(tx: Tx, project: ProjectLike, opts: ProjectWorkloadOptions) {
  const cal = await WorkCalendar.load(tx, project);
  const all = await loadWorkItems(tx, [project]);
  const items = opts.moduleId ? all.filter((i) => i.moduleId === opts.moduleId) : all;

  const devIds = await tx
    .selectDistinct({ userId: s.issueAssignees.userId })
    .from(s.issueAssignees)
    .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
    .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)));
  const members = devIds.length
    ? await tx
        .select({
          userId: s.workspaceMembers.userId,
          wsCapacity: s.workspaceMembers.capacityHoursWeek,
          projectCapacity: s.projectMembers.capacityHoursWeek,
          position: s.projectMembers.position,
          positions: s.projectMembers.positions,
          role: s.projectMembers.role,
          jobTitle: s.workspaceMembers.jobTitle,
        })
        .from(s.workspaceMembers)
        .leftJoin(s.projectMembers, and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, s.workspaceMembers.userId)))
        .where(
          and(
            eq(s.workspaceMembers.workspaceId, project.workspaceId),
            eq(s.workspaceMembers.status, 'active'),
            inArray(
              s.workspaceMembers.userId,
              devIds.map((d) => d.userId),
            ),
          ),
        )
    : [];
  const position = opts.position?.toLowerCase();
  // คนหนึ่งมีได้หลายตำแหน่ง: ตรงตำแหน่งใดตำแหน่งหนึ่งก็นับ · ไม่มีตำแหน่งในโปรเจกต์ใช้ชื่อตำแหน่งใน Workspace
  const people = members.filter((m) => !position || (m.positions?.length ? m.positions.map((x) => x.toLowerCase()) : [(m.position ?? m.jobTitle ?? '').toLowerCase()]).includes(position));
  const leaves = await loadLeaves(tx, people.map((p) => p.userId), opts.from, opts.to);
  const run = (basis: WorkloadBasis) =>
    computeWorkload({
      from: opts.from,
      to: opts.to,
      group: opts.group,
      items,
      people: people.map((p) => ({ userId: p.userId, capacityHoursWeek: p.projectCapacity ?? p.wsCapacity })),
      leaves,
      calendarOf: () => cal,
      capacityCalendar: cal,
      basis,
      today: today(),
    });
  const basis = opts.basis ?? 'plan';
  const result = run(basis);
  // อีกชุดไว้เทียบแผนกับที่ทำจริง (performance) · ขอเฉพาะเมื่อหน้าจอต้องการ
  const other = opts.compare ? run(basis === 'plan' ? 'actual' : 'plan') : null;

  // งานที่คำนวณไม่ได้: ยังไม่ Done, มี Dev แต่ไม่มีวันในแผนหรือ Man-Day
  const unscheduled = await countUnscheduled(tx, project.id, items);
  const profiles = await loadPeople(tx, people.map((p) => p.userId));
  return { cal, result, other, people, profiles, unscheduled };
}

async function countUnscheduled(tx: Tx, projectId: string, items: WorkItem[]) {
  const open = items.filter((i) => i.assigneeIds.length && (!i.planStart || !i.planEnd || !i.estimateMd));
  if (!open.length) return { count: 0, noDates: 0, noEstimate: 0 };
  const done = await tx
    .select({ id: s.issues.id })
    .from(s.issues)
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
    .where(and(eq(s.issues.projectId, projectId), closedStatus(), inArray(s.issues.id, open.map((i) => i.id))));
  const doneIds = new Set(done.map((d) => d.id));
  const left = open.filter((i) => !doneIds.has(i.id));
  return {
    count: left.length,
    noDates: left.filter((i) => !i.planStart || !i.planEnd).length,
    noEstimate: left.filter((i) => i.planStart && i.planEnd && !i.estimateMd).length,
  };
}

// ---------------------------------------------------------------------------
// Workload รวมทุกโปรเจกต์ (N1)
// ---------------------------------------------------------------------------

export interface WorkspaceWorkloadOptions {
  from: string;
  to: string;
  group: WorkloadGroup;
  unit: WorkloadUnit;
  basis?: WorkloadBasis;
  teamId?: string;
}

/**
 * รวมทุกโปรเจกต์ที่ผู้เรียกเข้าถึงได้ตาม RLS (ไม่รวมโปรเจกต์ที่ลบหรือ Archive)
 * capacity ใช้เวลาทั้งหมดของคน (workspace_members) และปฏิทินของ Workspace
 * คน = สมาชิกของทีมที่เลือก หรือ Dev ที่มีงานอย่างน้อย 1 งานเมื่อไม่ได้เลือกทีม
 */
export async function workspaceWorkload(tx: Tx, workspaceId: string, opts: WorkspaceWorkloadOptions) {
  const projects = await tx
    .select({ id: s.projects.id, key: s.projects.key, name: s.projects.name, color: s.projects.color, workspaceId: s.projects.workspaceId, holidayCalendarId: s.projects.holidayCalendarId })
    .from(s.projects)
    .where(and(isNull(s.projects.deletedAt), isNull(s.projects.archivedAt), sql`${s.projects.status} <> 'archived'`));
  const calendars = new Map<string, WorkCalendar>();
  for (const p of projects) calendars.set(p.id, await WorkCalendar.load(tx, p));
  const items = await loadWorkItems(tx, projects);

  let userIds: string[];
  if (opts.teamId) {
    const rows = await tx.select({ userId: s.teamMembers.userId }).from(s.teamMembers).where(eq(s.teamMembers.teamId, opts.teamId));
    userIds = rows.map((r) => r.userId);
  } else {
    userIds = [...new Set(items.flatMap((i) => i.assigneeIds))];
  }
  const members = userIds.length
    ? await tx
        .select({ userId: s.workspaceMembers.userId, capacityHoursWeek: s.workspaceMembers.capacityHoursWeek, jobTitle: s.workspaceMembers.jobTitle })
        .from(s.workspaceMembers)
        .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.userId, userIds)))
    : [];
  const ids = members.map((m) => m.userId);
  // ชั่วโมงที่แบ่งให้แต่ละโปรเจกต์รวมกัน (N1 v1.0.3: "แบ่งให้โปรเจกต์ X / Y ชม.")
  const allocations = ids.length
    ? await tx
        .select({ userId: s.projectMembers.userId, hours: sql<number>`coalesce(sum(${s.projectMembers.capacityHoursWeek}), 0)::int` })
        .from(s.projectMembers)
        .innerJoin(s.projects, eq(s.projects.id, s.projectMembers.projectId))
        .where(and(inArray(s.projectMembers.userId, ids), isNull(s.projects.deletedAt), isNull(s.projects.archivedAt)))
        .groupBy(s.projectMembers.userId)
    : [];
  const capacityCalendar = await loadWorkspaceCalendar(tx, workspaceId);
  const leaves = await loadLeaves(tx, ids, opts.from, opts.to);
  const run = (basis: WorkloadBasis) =>
    computeWorkload({
      from: opts.from,
      to: opts.to,
      group: opts.group,
      items,
      people: members,
      leaves,
      calendarOf: (id) => calendars.get(id)!,
      capacityCalendar,
      basis,
      today: today(),
    });
  const basis = opts.basis ?? 'plan';
  const result = run(basis);
  const other = run(basis === 'plan' ? 'actual' : 'plan');
  const profiles = await loadPeople(tx, ids);
  return { projects, members, allocations: new Map(allocations.map((a) => [a.userId, a.hours])), result, other, profiles };
}

export type { Person };
