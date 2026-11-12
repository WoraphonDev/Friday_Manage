import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { today } from '../common/dates.js';
import { AppError, forbidden } from '../common/errors.js';
import { loadPeople, type Person } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import { dueOf, loadDueRule, qaDueOf } from '../projects/due-stage.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService, type ProjectRow } from '../projects/projects.service.js';
import { HEALTH_THRESHOLDS, projectHealth } from './health.js';
import {
  daysBetween,
  HOURS_PER_MD,
  inUnit,
  MAX_RANGE_DAYS,
  plannedMdBy,
  projectWorkload,
  utilization,
  weekOf,
  type WorkloadCell,
  type WorkloadUnit,
  workspaceWorkload,
} from './workload.js';

const isoDate = z.iso.date();
const uuid = z.uuid();

export const OverviewQuery = z.object({
  /** ทั้งโปรเจกต์ / งานของฉัน (ตัวเลือกบนหัวหน้า 1) */
  scope: z.enum(['all', 'mine']).default('all'),
  moduleId: uuid.optional(),
});

const range = { from: isoDate.optional(), to: isoDate.optional() };
const rangeRule = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
const rangeSize = (v: { from?: string; to?: string }) => !v.from || !v.to || daysBetween(v.from, v.to) < MAX_RANGE_DAYS;
const unitGroup = {
  /** Man-Day · ชั่วโมง (1 MD = 8 ชม.) · จำนวนงาน */
  unit: z.enum(['md', 'hour', 'count']).default('md'),
  group: z.enum(['day', 'week', 'month']).default('week'),
  /** plan = ตามแผน · actual = ตามที่ทำจริง (งานที่เสร็จใช้วันที่ทำจริง) */
  basis: z.enum(['plan', 'actual']).default('plan'),
};

export const ProjectWorkloadQuery = z
  .object({ ...range, ...unitGroup, moduleId: uuid.optional(), position: z.string().trim().min(1).max(100).optional() })
  .refine(rangeRule, { path: ['to'], message: 'to ต้องไม่ก่อน from' })
  .refine(rangeSize, { path: ['to'], message: `ขอได้ไม่เกิน ${MAX_RANGE_DAYS} วันต่อครั้ง` });

export const WorkspaceWorkloadQuery = z
  .object({ ...range, ...unitGroup, team: uuid.optional() })
  .refine(rangeRule, { path: ['to'], message: 'to ต้องไม่ก่อน from' })
  .refine(rangeSize, { path: ['to'], message: `ขอได้ไม่เกิน ${MAX_RANGE_DAYS} วันต่อครั้ง` });

/** ค่าเริ่มต้นตามหน้า 7: 8 สัปดาห์นับจากสัปดาห์นี้ */
const DEFAULT_WEEKS = 8;
function resolveRange(q: { from?: string; to?: string }) {
  const span = DEFAULT_WEEKS * 7 - 1;
  if (q.from && q.to) return { from: q.from, to: q.to };
  if (q.from) return { from: q.from, to: addDays(q.from, span) };
  if (q.to) return { from: addDays(q.to, -span), to: q.to };
  const from = weekOf(today()).start;
  return { from, to: addDays(from, span) };
}

/** ชื่อคนที่ Guest เห็น (04-permissions ข้อ 4) */
const hiddenPerson = { displayName: 'ทีมพัฒนา', initials: '', avatarUrl: null };
const personFields = new Set(['assigneeIds', 'baId', 'reviewerId', 'testerId', 'createdBy', 'deletedBy', 'ownerUserId']);
const LIST_LIMIT = 10;
const ACTIVITY_LIMIT = 10;
/** กันโปรเจกต์ที่วันที่ในแผนยาวผิดปกติ (เช่น พิมพ์ปีผิด) ไม่ให้คำตอบใหญ่เกิน · 5 ปี */
const BURNUP_MAX_WEEKS = 260;

type Issue = typeof s.issues.$inferSelect;
type Status = typeof s.workflowStatuses.$inferSelect;

const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(d);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

@Injectable()
export class OverviewService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
  ) {}

  // ---------------------------------------------------------------------------
  // 1 · Overview
  // ---------------------------------------------------------------------------
  async overview(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof OverviewQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      const guest = access.guestViewer;
      const now = today();
      const cal = await WorkCalendar.load(tx, project);

      // ทีละ query: ธุรกรรมเดียวใช้ connection เดียว (pg ไม่รับ query ซ้อนกัน)
      const types = await tx.select().from(s.issueTypes).where(eq(s.issueTypes.projectId, project.id));
      const statuses = await tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.projectId, project.id)).orderBy(asc(s.workflowStatuses.sort));
      const allIssues = await tx
        .select()
        .from(s.issues)
        .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)))
        .orderBy(asc(s.issues.number));
      const modules = await tx.select().from(s.modules).where(eq(s.modules.projectId, project.id)).orderBy(asc(s.modules.sort), asc(s.modules.name));
      const phases = await tx.select().from(s.phases).where(eq(s.phases.projectId, project.id));
      const milestones = await tx.select().from(s.milestones).where(eq(s.milestones.projectId, project.id)).orderBy(asc(s.milestones.date));
      const statusOf = new Map(statuses.map((st) => [st.id, st]));
      const bugTypeIds = new Set(types.filter((t) => t.name === 'Bug').map((t) => t.id));
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      const isBug = (i: Issue) => bugTypeIds.has(i.issueTypeId);
      const isDone = (i: Issue) => statusOf.get(i.statusId)!.category === 'done';
      const assignees = await this.assigneesOf(tx, allIssues.map((i) => i.id));

      // ตัวกรองบนหัวหน้า · Guest ที่เป็น Viewer ไม่เห็น Bug (ไม่นับใน Overview)
      // งานที่ยกเลิกไม่อยู่ในแผน: ไม่นับในความคืบหน้า KPI งานเลยกำหนด และ Health
      const cancelled = (i: Issue) => statusOf.get(i.statusId)!.category === 'cancelled';
      let issues = (guest ? allIssues.filter((i) => !isBug(i)) : allIssues).filter((i) => !cancelled(i));
      if (q.moduleId) issues = issues.filter((i) => i.moduleId === q.moduleId);
      if (q.scope === 'mine') issues = issues.filter((i) => (assignees.get(i.id) ?? []).includes(auth.userId));
      const inSet = new Set(issues.map((i) => i.id));

      // งานในแผน = ไม่ใช่ Bug · งานระดับล่างสุดดูจากลูกในทั้งโปรเจกต์ เพื่อไม่นับ Man-Day ซ้ำกับ Sub-task
      // Bug ที่อยู่ใต้ Task ไม่ทำให้ Task นั้นหยุดเป็นงานระดับล่างสุด (Bug ไม่ได้แบ่ง Man-Day ของ Task)
      const plan = issues.filter((i) => !isBug(i));
      const planIds = new Set(plan.map((i) => i.id));
      const childrenOf = new Map<string, Issue[]>();
      for (const i of allIssues) if (i.parentId && !isBug(i) && !cancelled(i)) childrenOf.set(i.parentId, [...(childrenOf.get(i.parentId) ?? []), i]);
      const isLeaf = (i: Issue) => !childrenOf.has(i.id);
      const leaves = plan.filter(isLeaf);
      const weighted = project.progressMethod === 'weighted';

      const mdOf = (i: Issue): number => {
        const kids = childrenOf.get(i.id);
        return kids ? kids.reduce((n, k) => n + mdOf(k), 0) : (i.estimateMd ?? 0);
      };
      // เกณฑ์ "เสร็จ" ของความคืบหน้า: ปกติ = Done (ที่เหลือใช้ % ที่กรอก)
      // แยก Dev / QA (project.progress_split): Dev = ส่งให้ QA แล้ว (หมวด review / done) · QA = Done เท่านั้น (ยังไม่ผ่าน = 0)
      type Basis = { full: (i: Issue) => boolean; partial: (i: Issue) => number };
      const NORMAL: Basis = { full: isDone, partial: (i) => i.progressPct ?? 0 };
      const sentToQa = (i: Issue) => ['review', 'done'].includes(statusOf.get(i.statusId)!.category);
      const DEV: Basis = { full: sentToQa, partial: (i) => i.progressPct ?? 0 };
      const QA: Basis = { full: isDone, partial: () => 0 };
      const progressOf = (i: Issue, byMd = weighted, b: Basis = NORMAL): number => {
        if (b.full(i)) return 100;
        const kids = childrenOf.get(i.id);
        if (kids?.length) return rollup(kids.map((k) => ({ w: byMd ? mdOf(k) : 1, pct: progressOf(k, byMd, b) })));
        return b.partial(i);
      };
      /** ความคืบหน้ารวมของชุดงาน: ใช้เฉพาะงานบนสุดในชุด (ลูกคิดผ่านแม่แล้ว) */
      const progressOfSet = (set: Issue[], byMd = weighted, b: Basis = NORMAL) => {
        const ids = new Set(set.map((i) => i.id));
        const roots = set.filter((i) => !i.parentId || !ids.has(i.parentId));
        return rollup(roots.map((i) => ({ w: byMd ? mdOf(i) : 1, pct: progressOf(i, byMd, b) })));
      };
      /** Dev / QA ของชุดงาน · null = โปรเจกต์ไม่ได้เปิดแยกความคืบหน้า */
      const splitOf = (set: Issue[], byMd = weighted) => project.progressSplit
        ? {
          dev: { pct: progressOfSet(set, byMd, DEV), done: set.filter(sentToQa).length, total: set.length },
          qa: { pct: progressOfSet(set, byMd, QA), done: set.filter(isDone).length, total: set.length },
        }
        : null;

      const completedOn = (i: Issue) => (i.completedAt ? localDate(i.completedAt) : null);
      // แยก Dev / QA: งานที่รอ QA ตัดสินด้วย QA Due (projects/due-stage.ts) · โปรเจกต์อื่น = Plan End เหมือนเดิม
      const dueRule = await loadDueRule(tx, project, cal);
      const dueOfIssue = (i: Issue) => dueOf(dueRule, i, statusOf.get(i.statusId)!.category);
      const dueDate = (i: Issue) => dueOfIssue(i).date;
      const overdue = (i: Issue) => { const d = dueDate(i); return !isDone(i) && !!d && d < now; };
      const week = weekOf(now);
      const weekAgo = addDays(now, -7);

      // --- ความคืบหน้า ---
      const mdTotal = leaves.reduce((n, i) => n + (i.estimateMd ?? 0), 0);
      const mdDone = leaves.filter(isDone).reduce((n, i) => n + (i.estimateMd ?? 0), 0);
      const totalDays = cal.workingDaysIn(project.startDate, project.goliveDate);
      const elapsedDays = cal.workingDaysIn(project.startDate, now < project.goliveDate ? now : project.goliveDate);
      const lastPlanEnd = plan.reduce<string | null>((m, i) => (i.planEnd && (!m || i.planEnd > m) ? i.planEnd : m), null);
      const nextMilestone = milestones.find((m) => m.date >= now);
      const progress = {
        method: project.progressMethod,
        pct: progressOfSet(plan),
        split: splitOf(plan),
        tasks: { done: plan.filter(isDone).length, total: plan.length },
        md: { done: round2(mdDone), total: round2(mdTotal), pct: pct(mdDone, mdTotal) },
        time: { elapsedWorkingDays: elapsedDays, totalWorkingDays: totalDays, pct: pct(elapsedDays, totalDays) },
        remainingWorkingDays: cal.workingDaysIn(addDays(now, 1), project.goliveDate),
        lastPlanEnd,
        nextMilestone: nextMilestone ? { id: nextMilestone.id, name: nextMilestone.name, date: nextMilestone.date, daysLeft: daysBetween(now, nextMilestone.date) } : null,
      };

      // --- Health ---
      const base = projectHealth(
        cal,
        leaves.map((i) => ({ estimateMd: i.estimateMd, planStart: i.planStart, planEnd: i.planEnd, done: isDone(i), progressPct: i.progressPct })),
        now,
      );
      const overdueIssues = issues.filter(overdue);
      const behind = leaves.filter((i) => !isDone(i) && i.estimateMd && i.planStart && i.planEnd && (i.progressPct ?? 0) < (plannedMdBy(cal, i, now) / i.estimateMd) * 100);
      const people = guest ? new Map<string, Person>() : await loadPeople(tx, [...assignees.values()].flat());
      const topOverdue = guest ? null : topAssignee(overdueIssues, assignees, people);
      const remainingMd = leaves.reduce((n, i) => n + (i.estimateMd ?? 0) * (isDone(i) ? 0 : 1 - (i.progressPct ?? 0) / 100), 0);
      const teamMdPerWeek = await this.teamMdPerWeek(tx, project, [...new Set(leaves.flatMap((i) => assignees.get(i.id) ?? []))]);
      const health = {
        ...base,
        thresholds: HEALTH_THRESHOLDS,
        behindPlan: behind.length,
        overdue: { count: overdueIssues.length, ...(guest ? {} : { topAssignee: topOverdue }) },
        capacity: {
          remainingMd: round1(remainingMd),
          teamMdPerWeek: round1(teamMdPerWeek),
          weeksNeeded: teamMdPerWeek ? round1(remainingMd / teamMdPerWeek) : null,
          weeksLeft: round1(progress.remainingWorkingDays / cal.daysPerWeek),
        },
      };

      // --- KPI + รายการตาม KPI ---
      const doneIn = (from: string, to: string) => issues.filter((i) => isDone(i) && completedOn(i) !== null && completedOn(i)! >= from && completedOn(i)! <= to);
      const dueToday = issues.filter((i) => !isDone(i) && dueDate(i) === now);
      const laterThisWeek = issues.filter((i) => { const d = dueDate(i); return !isDone(i) && !!d && d > now && d <= week.end; });
      const doneLast7 = doneIn(addDays(now, -6), now);
      const donePrev7 = doneIn(addDays(now, -13), addDays(now, -7));
      // Overdue เมื่อสัปดาห์ก่อน: ครบกำหนดก่อนวันนั้นและยังไม่เสร็จ ณ วันนั้น
      // แยก Dev / QA ใช้ขั้นของงานวันนี้แทนขั้นเมื่อสัปดาห์ก่อน (ไม่ได้เก็บประวัติขั้นไว้)
      const overdueWeekAgo = issues.filter((i) => { const d = dueDate(i); return d && d < weekAgo && (!isDone(i) || (completedOn(i) ?? '') > weekAgo); }).length;
      const kpis = {
        total: issues.length,
        done: issues.filter(isDone).length,
        overdue: overdueIssues.length,
        overdueDelta: overdueIssues.length - overdueWeekAgo,
        dueToday: dueToday.length,
        laterThisWeek: laterThisWeek.length,
        laterThisWeekRange: { from: addDays(now, 1), to: week.end },
        doneLast7Days: doneLast7.length,
        doneDelta: doneLast7.length - donePrev7.length,
        md: { done: round2(mdDone), total: round2(mdTotal) },
      };

      const moduleOf = new Map(modules.map((m) => [m.id, m]));
      const phaseOf = new Map(phases.map((p) => [p.id, p]));
      const keyOf = new Map(allIssues.map((i) => [i.id, `${project.key}-${i.number}`]));
      const item = (i: Issue) => {
        const st = statusOf.get(i.statusId)!;
        const mod = i.moduleId ? moduleOf.get(i.moduleId) : undefined;
        const phase = i.phaseId ? phaseOf.get(i.phaseId) : undefined;
        return {
          key: keyOf.get(i.id)!,
          type: typeName.get(i.issueTypeId)!,
          title: i.title,
          status: { name: st.name, category: st.category },
          module: mod ? { id: mod.id, name: mod.name, color: mod.color } : null,
          phase: phase ? { id: phase.id, name: phase.name } : null,
          parentKey: i.parentId ? (keyOf.get(i.parentId) ?? null) : null,
          planEnd: i.planEnd,
          ...(dueRule.split ? { qaDue: qaDueOf(dueRule, i), dueStage: dueOfIssue(i).stage } : {}),
          lateDays: overdue(i) ? daysBetween(dueDate(i)!, now) : 0,
          completedOn: completedOn(i),
          ...(guest ? { canOpen: i.sharedWithGuests } : { assignees: (assignees.get(i.id) ?? []).map((id) => people.get(id)).filter((p): p is Person => !!p) }),
        };
      };
      const byDue = (a: Issue, b: Issue) => (dueDate(a)! < dueDate(b)! ? -1 : dueDate(a)! > dueDate(b)! ? 1 : a.number - b.number);
      const lists = {
        overdue: [...overdueIssues].sort(byDue).slice(0, LIST_LIMIT).map(item),
        dueToday: [...dueToday].sort(byDue).slice(0, LIST_LIMIT).map(item),
        laterThisWeek: [...laterThisWeek].sort(byDue).slice(0, LIST_LIMIT).map(item),
        doneLast7Days: [...doneLast7]
          .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())
          .slice(0, LIST_LIMIT)
          .map(item),
      };

      // --- งานที่เสร็จรายวัน 7 วันล่าสุด + Burn-up รายสัปดาห์ ---
      const doneDaily = Array.from({ length: 7 }, (_, k) => {
        const date = addDays(now, k - 6);
        return { date, count: doneLast7.filter((i) => completedOn(i) === date).length, workingDay: cal.isWorkingDay(date) };
      });
      const burnup = this.burnup(cal, project, leaves, isDone, completedOn, now, weighted);

      // --- Module, สถานะ, Milestone ---
      const moduleRows = [
        ...modules.map((m) => ({ id: m.id as string | null, name: m.name, color: m.color })),
        ...(plan.some((i) => !i.moduleId) ? [{ id: null, name: 'ไม่ระบุ Module', color: null }] : []),
      ].map((m) => {
        const mine = plan.filter((i) => i.moduleId === m.id);
        const start = mine.reduce<string | null>((x, i) => (i.planStart && (!x || i.planStart < x) ? i.planStart : x), null);
        const done = mine.filter(isDone).length;
        return {
          ...m,
          pct: progressOfSet(mine),
          split: splitOf(mine),
          done,
          total: mine.length,
          overdue: mine.filter(overdue).length,
          startDate: start,
          notStarted: !done && !!start && start > now,
          scheduled: !!start,
        };
      });

      const statusBreakdown = this.statusBreakdown(types, statuses, issues);
      const links = milestones.length
        ? await tx.select().from(s.milestoneIssues).where(inArray(s.milestoneIssues.milestoneId, milestones.map((m) => m.id)))
        : [];
      const milestoneRows = milestones.map((m) => {
        const linked = links.filter((l) => l.milestoneId === m.id && planIds.has(l.issueId)).map((l) => plan.find((i) => i.id === l.issueId)!);
        const moduleIssues = m.moduleId ? plan.filter((i) => i.moduleId === m.moduleId) : [];
        // ไม่ได้ผูกงานไว้: ใช้ความคืบหน้าของ Module (เช่น "Credit Line ครบตามแผน" = Module Credit Line)
        const basis = linked.length ? 'linked' : m.moduleId ? 'module' : 'project';
        const set = linked.length ? linked : m.moduleId ? moduleIssues : plan;
        // % ของ Milestone ถ่วงด้วย Man-Day เสมอ ไม่ขึ้นกับ progress_method (ผู้ใช้ตัดสิน 9 พ.ย. 2026)
        return { id: m.id, name: m.name, date: m.date, moduleId: m.moduleId, daysLeft: daysBetween(now, m.date), linkedIssues: linked.length, donePct: progressOfSet(set, true), split: splitOf(set, true), basis };
      });

      // --- Workload สัปดาห์นี้ (Guest ไม่เห็น) ---
      let workloadThisWeek: unknown = null;
      if (!guest) {
        const w = await projectWorkload(tx, project, { from: week.start, to: week.end, group: 'week', unit: 'md', moduleId: q.moduleId });
        workloadThisWeek = {
          from: week.start,
          to: week.end,
          people: [...w.result.rows.entries()]
            .map(([userId, [cell]]) => ({
              person: w.profiles.get(userId) ?? null,
              md: cell.md,
              capacityMd: cell.capacityMd,
              utilizationPct: utilization(cell.md, cell.capacityMd),
              over: cell.md > cell.capacityMd,
            }))
            .filter((p) => p.person && (q.scope === 'all' || p.person.id === auth.userId))
            .sort((a, b) => b.md - a.md || a.person!.displayName.localeCompare(b.person!.displayName)),
        };
      }

      // --- Activity ล่าสุด ---
      const filtered = q.scope === 'mine' || !!q.moduleId || guest;
      const acts = await tx
        .select()
        .from(s.activities)
        .where(
          and(
            eq(s.activities.projectId, project.id),
            // ตัวกรองหรือ Guest: เฉพาะงานในชุดที่เห็น (Guest ไม่เห็น Activity ของ Bug)
            filtered ? (inSet.size ? inArray(s.activities.issueId, [...inSet]) : sql`false`) : undefined,
          ),
        )
        .orderBy(desc(s.activities.createdAt), desc(s.activities.id))
        .limit(ACTIVITY_LIMIT);
      const actors = await loadPeople(tx, acts.map((a) => a.actorId));
      const issueById = new Map(allIssues.map((i) => [i.id, i]));
      const activity = acts.map((a) => {
        const i = a.issueId ? issueById.get(a.issueId) : undefined;
        const hide = guest && !!a.field && personFields.has(a.field);
        return {
          id: a.id,
          issue: i ? { key: keyOf.get(i.id)!, title: i.title } : null,
          actor: !a.actorId ? null : guest && a.actorId !== auth.userId ? hiddenPerson : (actors.get(a.actorId) ?? null),
          actorKind: a.actorKind,
          verb: a.verb,
          field: a.field,
          old: hide ? null : a.oldValue,
          new: hide ? null : a.newValue,
          createdAt: a.createdAt,
        };
      });

      // --- ข้อมูลโปรเจกต์ (การ์ดด้านขวา) ---
      const scope = await tx.select().from(s.projectScopeItems).where(eq(s.projectScopeItems.projectId, project.id)).orderBy(asc(s.projectScopeItems.sort));
      const [{ members }] = await tx.select({ members: sql<number>`count(*)::int` }).from(s.projectMembers).where(eq(s.projectMembers.projectId, project.id));
      const owner = guest ? new Map<string, Person>() : await loadPeople(tx, [project.ownerUserId]);
      const counts = guest ? null : await this.counts(tx, allIssues.filter((i) => inSet.has(i.id)), isBug, isDone);

      return {
        project: {
          key: project.key,
          name: project.name,
          clientName: project.clientName,
          description: project.description,
          status: project.status,
          startDate: project.startDate,
          goliveDate: project.goliveDate,
          progressMethod: project.progressMethod,
          owner: guest ? hiddenPerson : (owner.get(project.ownerUserId) ?? null),
          memberCount: members,
          moduleCount: modules.length,
          scope: groupScope(scope),
        },
        today: now,
        filter: { scope: q.scope, moduleId: q.moduleId ?? null },
        progress,
        health,
        kpis,
        lists,
        doneDaily,
        burnup,
        modules: moduleRows,
        statusBreakdown,
        milestones: milestoneRows,
        workloadThisWeek,
        activity,
        counts,
        lastActivityAt: acts[0]?.createdAt ?? null,
      };
    });
  }

  /** Burn-up: Man-Day (weighted) หรือจำนวนงาน (count) สะสมตามแผน vs เสร็จจริง ณ วันอาทิตย์ของแต่ละสัปดาห์ */
  private burnup(cal: WorkCalendar, project: ProjectRow, leaves: Issue[], isDone: (i: Issue) => boolean, completedOn: (i: Issue) => string | null, now: string, weighted: boolean) {
    const end = leaves.reduce((m, i) => (i.planEnd && i.planEnd > m ? i.planEnd : m), project.goliveDate);
    const points: { weekStart: string; weekEnd: string; planned: number; done: number | null }[] = [];
    const unitOf = (i: Issue) => (weighted ? (i.estimateMd ?? 0) : 1);
    const plannedBy = (i: Issue, d: string) => (weighted ? plannedMdBy(cal, i, d) : i.planEnd && i.planEnd <= d ? 1 : 0);
    for (let w = weekOf(project.startDate); w.start <= end && points.length < BURNUP_MAX_WEEKS; w = weekOf(addDays(w.end, 1))) {
      const asOf = w.end < now ? w.end : now;
      points.push({
        weekStart: w.start,
        weekEnd: w.end,
        planned: round2(leaves.reduce((n, i) => n + plannedBy(i, w.end), 0)),
        done: w.start > now ? null : round2(leaves.filter((i) => isDone(i) && (completedOn(i) ?? '9999') <= asOf).reduce((n, i) => n + unitOf(i), 0)),
      });
    }
    return { unit: weighted ? 'md' : 'count', total: round2(leaves.reduce((n, i) => n + unitOf(i), 0)), points };
  }

  /** นับตามคอลัมน์ของบอร์ดมาตรฐาน · Bug นับในคอลัมน์ที่สถานะผูกไว้ (แบบเดียวกับ Kanban) */
  private statusBreakdown(types: (typeof s.issueTypes.$inferSelect)[], statuses: Status[], issues: Issue[]) {
    const bugType = types.find((t) => t.name === 'Bug');
    const std = types.find((t) => t.name === 'Task') ?? types.find((t) => t.id !== bugType?.id);
    const columns = statuses.filter((st) => st.workflowId === std?.workflowId);
    const ids = new Set(columns.map((c) => c.id));
    const statusOf = new Map(statuses.map((st) => [st.id, st]));
    const columnOf = (st: Status) => {
      const c = st.boardColumnId ?? st.id;
      return ids.has(c) ? c : (columns.find((x) => x.category === st.category) ?? columns[0])?.id;
    };
    const count = new Map<string, number>();
    for (const i of issues) {
      const c = columnOf(statusOf.get(i.statusId)!);
      if (c) count.set(c, (count.get(c) ?? 0) + 1);
    }
    return {
      total: issues.length,
      columns: columns.map((c) => ({ id: c.id, name: c.name, category: c.category, count: count.get(c.id) ?? 0, pct: issues.length ? round1(((count.get(c.id) ?? 0) / issues.length) * 100) : 0 })),
    };
  }

  /** Bug ที่ยังเปิด และคำขอเลื่อน Due ที่รออนุมัติ (หน้า M6) */
  private async counts(tx: Tx, issues: Issue[], isBug: (i: Issue) => boolean, isDone: (i: Issue) => boolean) {
    const ids = issues.map((i) => i.id);
    const [pending] = ids.length
      ? await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.dueChangeRequests)
          .where(and(inArray(s.dueChangeRequests.issueId, ids), eq(s.dueChangeRequests.status, 'pending')))
      : [{ n: 0 }];
    return { openBugs: issues.filter((i) => isBug(i) && !isDone(i)).length, pendingDueRequests: pending.n };
  }

  /** capacity ของ Dev ในโปรเจกต์ (MD ต่อสัปดาห์) · project_members ก่อน แล้วค่อย workspace_members */
  private async teamMdPerWeek(tx: Tx, project: ProjectRow, userIds: string[]) {
    if (!userIds.length) return 0;
    const rows = await tx
      .select({ ws: s.workspaceMembers.capacityHoursWeek, project: s.projectMembers.capacityHoursWeek })
      .from(s.workspaceMembers)
      .leftJoin(s.projectMembers, and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, s.workspaceMembers.userId)))
      .where(and(eq(s.workspaceMembers.workspaceId, project.workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.userId, userIds)));
    return rows.reduce((n, r) => n + (r.project ?? r.ws) / HOURS_PER_MD, 0);
  }

  private async assigneesOf(tx: Tx, issueIds: string[]) {
    const map = new Map<string, string[]>();
    if (!issueIds.length) return map;
    const rows = await tx
      .select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
      .from(s.issueAssignees)
      .where(inArray(s.issueAssignees.issueId, issueIds))
      .orderBy(asc(s.issueAssignees.sort));
    for (const r of rows) map.set(r.issueId, [...(map.get(r.issueId) ?? []), r.userId]);
    return map;
  }

  // ---------------------------------------------------------------------------
  // 7 · Workload ของโปรเจกต์ (+ O1 ใช้ group=week)
  // ---------------------------------------------------------------------------
  async projectWorkload(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof ProjectWorkloadQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      // Guest ที่เป็น Viewer ไม่มี project.workload.view (04-permissions ข้อ 4)
      requirePerm(access, 'project.workload.view');
      const { from, to } = resolveRange(q);
      const w = await projectWorkload(tx, project, { from, to, group: q.group, unit: q.unit, basis: q.basis, compare: true, moduleId: q.moduleId, position: q.position });
      const unit = q.unit;
      const hoursPerWeekOf = new Map(w.people.map((p) => [p.userId, { hours: p.projectCapacity ?? p.wsCapacity, position: p.position ?? p.jobTitle, role: p.role }]));

      const people = [...w.result.rows.entries()]
        .map(([userId, cells]) => {
          const info = hoursPerWeekOf.get(userId)!;
          return {
            person: w.profiles.get(userId)!,
            position: info.position,
            projectRole: info.role,
            capacityHoursWeek: info.hours,
            ...personSeries(cells, unit),
            compare: compareOf(cells, w.other?.rows.get(userId), q.basis, unit),
          };
        })
        .filter((p) => p.person)
        .sort((a, b) => a.person.displayName.localeCompare(b.person.displayName));

      // รวมทั้งทีม: เส้นประ = capacity ทีม (หักวันลาแล้ว) · หน่วยจำนวนงานนับงานไม่ซ้ำ
      const team = w.result.buckets.map((_, i) => {
        const cell = mergeCells(people.map((p) => p.raw[i]));
        return { ...inUnit(cell, unit), utilizationPct: utilization(cell.md, cell.capacityMd) };
      });

      // สรุปสัปดาห์นี้ (กล่องบนหน้า 7) คำนวณแยกจากช่วงที่ขอ
      const week = weekOf(today());
      const current = await projectWorkload(tx, project, { from: week.start, to: week.end, group: 'week', unit: 'md', moduleId: q.moduleId, position: q.position });
      const thisWeek = summarize(current.result.rows, current.profiles);

      const [withoutBa] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.issues)
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
        .where(
          and(
            eq(s.issues.projectId, project.id),
            isNull(s.issues.deletedAt),
            isNull(s.issues.parentId),
            isNull(s.issues.baId),
            sql`${s.workflowStatuses.category} not in ('done', 'cancelled')`,
            sql`${s.issueTypes.name} <> 'Bug'`,
            q.moduleId ? eq(s.issues.moduleId, q.moduleId) : undefined,
          ),
        );

      return {
        range: { from, to },
        unit,
        group: q.group,
        basis: q.basis,
        hoursPerMd: HOURS_PER_MD,
        buckets: w.result.buckets,
        people: people.map(({ raw: _, ...p }) => p),
        team,
        thisWeek: { from: week.start, to: week.end, ...thisWeek },
        withoutBa: withoutBa.n,
        unscheduled: w.unscheduled,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // N1 · Workload รวมทุกโปรเจกต์
  // ---------------------------------------------------------------------------
  async workspaceWorkload(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof WorkspaceWorkloadQuery>) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.workload.view');
    return this.db.run(auth, tenant, async (tx) => {
      if (q.team) {
        const [team] = await tx.select({ id: s.teams.id }).from(s.teams).where(eq(s.teams.id, q.team));
        if (!team) throw new AppError(404, 'team_not_found', 'ไม่พบทีม');
      }
      const { from, to } = resolveRange(q);
      const w = await workspaceWorkload(tx, tenant.workspaceId, { from, to, group: q.group, unit: q.unit, basis: q.basis, teamId: q.team });
      const projectOf = new Map(w.projects.map((p) => [p.id, p]));
      const memberOf = new Map(w.members.map((m) => [m.userId, m]));
      const people = [...w.result.rows.entries()]
        .filter(([userId]) => w.profiles.has(userId))
        .map(([userId, cells]) => {
          const m = memberOf.get(userId)!;
          const series = personSeries(cells, q.unit);
          const allocated = w.allocations.get(userId) ?? 0;
          return {
            person: w.profiles.get(userId)!,
            jobTitle: m.jobTitle,
            capacityHoursWeek: m.capacityHoursWeek,
            // ชั่วโมงที่แบ่งให้โปรเจกต์รวมกันเกินเวลาทั้งหมดของคน → แจ้ง Admin
            allocatedHoursWeek: allocated,
            overAllocated: allocated > m.capacityHoursWeek,
            overPeriods: series.raw.filter((c) => c.md > c.capacityMd).length,
            cells: series.cells.map((c, i) => ({
              ...c,
              byProject: byProject(series.raw[i], q.unit).map((x) => {
                const p = projectOf.get(x.projectId)!;
                return { key: p.key, name: p.name, color: p.color, value: x.value };
              }),
            })),
            total: series.total,
            compare: compareOf(cells, w.other.rows.get(userId), q.basis, q.unit),
          };
        })
        .sort((a, b) => a.person.displayName.localeCompare(b.person.displayName));
      return { range: { from, to }, unit: q.unit, group: q.group, basis: q.basis, hoursPerMd: HOURS_PER_MD, teamId: q.team ?? null, buckets: w.result.buckets, people };
    });
  }
}

/**
 * ยอดรวมในช่วงที่ขอทั้งตามแผนและตามจริง ไว้ดู performance ของแต่ละคน
 * doneOnPlanPct = ส่วนที่ทำจริงเทียบกับที่ควรทำตามแผนในช่วงเดียวกัน (100 = ตรงแผน)
 */
function compareOf(cells: WorkloadCell[], other: WorkloadCell[] | undefined, basis: 'plan' | 'actual', unit: WorkloadUnit) {
  const sum = (list: WorkloadCell[] | undefined) => (list ? inUnit(mergeCells(list), unit).value : 0);
  const mine = sum(cells);
  const alt = sum(other);
  const plan = basis === 'plan' ? mine : alt;
  const actual = basis === 'actual' ? mine : alt;
  return { plan, actual, actualVsPlanPct: plan > 0 ? Math.round((actual / plan) * 100) : null };
}

/** รวมหลายช่องเป็นช่องเดียว · งานเดียวกันนับครั้งเดียว */
function mergeCells(cells: WorkloadCell[]): WorkloadCell {
  return {
    md: round2(cells.reduce((n, c) => n + c.md, 0)),
    capacityMd: round2(cells.reduce((n, c) => n + c.capacityMd, 0)),
    leaveDays: cells.reduce((n, c) => n + c.leaveDays, 0),
    items: [...new Map(cells.flatMap((c) => c.items).map((x) => [x.id, x])).values()],
  };
}

/** ชุดค่าของคนหนึ่งตามหน่วย · เก็บ raw (MD) ไว้คำนวณรวมทีม */
function personSeries(cells: WorkloadCell[], unit: WorkloadUnit) {
  const all = mergeCells(cells);
  return {
    raw: cells,
    cells: cells.map((c) => ({
      ...inUnit(c, unit),
      utilizationPct: utilization(c.md, c.capacityMd),
      over: c.md > c.capacityMd,
      leaveDays: c.leaveDays,
      issues: c.items.map((x) => ({ key: x.key, title: x.title, value: unit === 'hour' ? round2(x.md * HOURS_PER_MD) : unit === 'count' ? 1 : x.md })),
    })),
    total: { ...inUnit(all, unit), utilizationPct: utilization(all.md, all.capacityMd), leaveDays: all.leaveDays },
  };
}

function byProject(cell: WorkloadCell, unit: WorkloadUnit) {
  const map = new Map<string, number>();
  for (const x of cell.items) map.set(x.projectId, (map.get(x.projectId) ?? 0) + (unit === 'count' ? 1 : x.md));
  return [...map.entries()].map(([projectId, v]) => ({ projectId, value: unit === 'hour' ? round2(v * HOURS_PER_MD) : round2(v) }));
}

/** กล่องสรุปบนหน้า 7: capacity ทีม, มอบหมายแล้ว, Utilization, คนที่เกิน capacity */
function summarize(rows: Map<string, WorkloadCell[]>, profiles: Map<string, Person>) {
  let md = 0;
  let cap = 0;
  const overloaded: { person: Person; utilizationPct: number | null }[] = [];
  for (const [userId, [cell]] of rows) {
    const p = profiles.get(userId);
    if (!p) continue;
    md += cell.md;
    cap += cell.capacityMd;
    if (cell.md > cell.capacityMd) overloaded.push({ person: p, utilizationPct: utilization(cell.md, cell.capacityMd) });
  }
  overloaded.sort((a, b) => (b.utilizationPct ?? Infinity) - (a.utilizationPct ?? Infinity));
  return { people: [...rows.keys()].filter((id) => profiles.has(id)).length, capacityMd: round2(cap), assignedMd: round2(md), utilizationPct: utilization(md, cap), overloaded };
}

/** ความคืบหน้ารวมแบบถ่วงน้ำหนัก · น้ำหนักรวมเป็น 0 ใช้ค่าเฉลี่ยธรรมดา */
function rollup(items: { w: number; pct: number }[]) {
  if (!items.length) return 0;
  const total = items.reduce((n, x) => n + x.w, 0);
  if (!total) return Math.round(items.reduce((n, x) => n + x.pct, 0) / items.length);
  return Math.round(items.reduce((n, x) => n + x.pct * x.w, 0) / total);
}

/** คนที่มีงาน Overdue มากที่สุด ("Overdue 7 งาน (Kaijeaw 4)") */
function topAssignee(issues: Issue[], assignees: Map<string, string[]>, people: Map<string, Person>) {
  const count = new Map<string, number>();
  for (const i of issues) for (const id of assignees.get(i.id) ?? []) count.set(id, (count.get(id) ?? 0) + 1);
  const [best] = [...count.entries()].sort((a, b) => b[1] - a[1] || (people.get(a[0])?.displayName ?? '').localeCompare(people.get(b[0])?.displayName ?? ''));
  const person = best ? people.get(best[0]) : undefined;
  return best && person ? { person, count: best[1] } : null;
}

function groupScope(rows: (typeof s.projectScopeItems.$inferSelect)[]) {
  const pick = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.text);
  return { inScope: pick('in_scope'), outScope: pick('out_scope'), deliverables: pick('deliverable'), acceptance: pick('acceptance'), assumptions: pick('assumption') };
}
