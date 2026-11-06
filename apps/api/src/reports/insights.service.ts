import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, eq, inArray } from 'drizzle-orm';
import { today } from '../common/dates.js';
import { AppError } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { projectWorkload, utilization, weekOf } from '../overview/workload.js';
import { addDays } from '../projects/calendar.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService, type ProjectRow } from '../projects/projects.service.js';
import { daysBetween, isOpen, type Item, loadPlan, type PlanData, round1 } from './plan-data.js';

export const WEEKS_BACK = 8;
/** หน้าต่างวัดอัตราเสร็จจริงเพื่อคาดวันจบ */
const VELOCITY_DAYS = 28;
const SEVERITY = { high: 0, medium: 1, low: 2 } as const;
type Severity = keyof typeof SEVERITY;

export interface RiskItem {
  kind: 'overdue' | 'due_soon_low_progress' | 'capacity_over' | 'blocked' | 'pending_due_requests';
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  issueKeys: string[];
  people?: Array<{ id: string; displayName: string; count?: number; md?: number; capacityMd?: number; utilizationPct?: number | null }>;
}

const listKeys = (items: Item[], n = 10) => items.slice(0, n).map((i) => i.key);

/** O1 · Lead Dashboard: ความเสี่ยงของแผนและความคืบหน้าราย Module */
@Injectable()
export class InsightsService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
  ) {}

  /** ผู้เรียกต้องเข้าโปรเจกต์ได้ ไม่ใช่ Guest และมีสิทธิ์ที่ระบุ */
  async guard(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, permission: string) {
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    if (access.guestViewer) throw new AppError(403, 'guest_view_limited', 'Guest เห็นเฉพาะ Overview, Timeline และงานที่แชร์ให้', { allowed: ['overview', 'timeline'] });
    requirePerm(access, permission);
    return project;
  }

  // ---------------------------------------------------------------------------
  // GET p/insights/risks
  // ---------------------------------------------------------------------------
  async risks(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.guard(tx, auth, tenant, key, 'project.workload.view');
      const plan = await loadPlan(tx, project);
      const items = await this.computeRisks(tx, project, plan, today());
      return { project: { key: project.key, name: project.name }, asOf: today(), counts: { high: items.filter((i) => i.severity === 'high').length, medium: items.filter((i) => i.severity === 'medium').length, low: items.filter((i) => i.severity === 'low').length }, items };
    });
  }

  /** ใช้ร่วมกับรายงานรายสัปดาห์ (ส่วน "ความเสี่ยงและสิ่งที่ต้องตัดสินใจ") */
  async computeRisks(tx: Tx, project: ProjectRow, plan: PlanData, now: string): Promise<RiskItem[]> {
    const out: RiskItem[] = [];
    const open = plan.items.filter((i) => isOpen(i) && !i.isBug);
    const names = await loadPeople(tx, open.flatMap((i) => i.assigneeIds));
    const nameOf = (id: string) => names.get(id)?.displayName ?? '—';

    // 1) เลยกำหนด
    const late = open.filter((i) => i.planEnd && i.planEnd < now).sort((a, b) => a.planEnd!.localeCompare(b.planEnd!));
    if (late.length) {
      const per = new Map<string, number>();
      for (const i of late) for (const u of i.assigneeIds.length ? i.assigneeIds : ['_none']) per.set(u, (per.get(u) ?? 0) + 1);
      const oldest = daysBetween(late[0]!.planEnd!, now);
      const top = [...per].sort((a, b) => b[1] - a[1]);
      out.push({
        kind: 'overdue',
        severity: oldest >= 7 || late.length >= 5 ? 'high' : 'medium',
        title: `งานเลยกำหนด ${late.length} งาน`,
        detail: `เก่าสุดเลย ${oldest} วัน · ${top.slice(0, 4).map(([u, n]) => `${u === '_none' ? 'ยังไม่มีผู้รับผิดชอบ' : nameOf(u)} ${n}`).join(' · ')}`,
        count: late.length,
        issueKeys: listKeys(late),
        people: top.filter(([u]) => u !== '_none').slice(0, 5).map(([u, n]) => ({ id: u, displayName: nameOf(u), count: n })),
      });
    }

    // 2) ใกล้ครบกำหนดแต่ความคืบหน้าต่ำ (7 วันข้างหน้า, ต่ำกว่า 50%)
    const soon = open.filter((i) => i.planEnd && i.planEnd >= now && i.planEnd <= addDays(now, 7) && i.progressPct < 50).sort((a, b) => a.planEnd!.localeCompare(b.planEnd!));
    if (soon.length) {
      const urgent = soon.filter((i) => daysBetween(now, i.planEnd!) <= 2 && i.progressPct < 25);
      out.push({
        kind: 'due_soon_low_progress',
        severity: urgent.length ? 'high' : 'medium',
        title: `ใกล้ครบกำหนดใน 7 วันแต่ยังคืบหน้าไม่ถึง 50% ${soon.length} งาน`,
        detail: urgent.length ? `${urgent.length} งานครบกำหนดภายใน 2 วันและคืบหน้าต่ำกว่า 25%` : `ครบกำหนดเร็วสุด ${soon[0]!.planEnd}`,
        count: soon.length,
        issueKeys: listKeys(soon),
      });
    }

    // 3) คน capacity เกินในสัปดาห์นี้
    const week = weekOf(now);
    const wl = await projectWorkload(tx, project, { from: week.start, to: week.end, group: 'week', unit: 'md' });
    const over = [...wl.result.rows]
      .map(([userId, cells]) => ({ userId, md: round1(cells.reduce((n, c) => n + c.md, 0)), capacityMd: round1(cells.reduce((n, c) => n + c.capacityMd, 0)) }))
      .filter((r) => r.md > r.capacityMd && r.capacityMd >= 0 && r.md > 0)
      .sort((a, b) => b.md - a.md);
    if (over.length) {
      const people = over.map((r) => ({ id: r.userId, displayName: wl.profiles.get(r.userId)?.displayName ?? '—', md: r.md, capacityMd: r.capacityMd, utilizationPct: utilization(r.md, r.capacityMd) }));
      const worst = Math.max(...over.map((r) => (r.capacityMd > 0 ? r.md / r.capacityMd : 99)));
      out.push({
        kind: 'capacity_over',
        severity: worst >= 2 ? 'high' : 'medium',
        title: `คนที่งานเกิน capacity สัปดาห์นี้ ${over.length} คน`,
        detail: people.slice(0, 4).map((p) => `${p.displayName} ${p.md}/${p.capacityMd} MD`).join(' · '),
        count: over.length,
        issueKeys: [],
        people: people.slice(0, 8),
      });
    }

    // 4) งานที่ติด Dependency: งานที่ควรเริ่มแล้วแต่ Predecessor ยังไม่เสร็จ
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    const blocked = new Map<string, { succ: Item; preds: Item[] }>();
    for (const d of plan.deps) {
      const pred = byId.get(d.pred);
      const succ = byId.get(d.succ);
      if (!pred || !succ || !isOpen(pred) || !isOpen(succ)) continue;
      if ((pred.planEnd && pred.planEnd < now) || (succ.planStart && succ.planStart <= now)) {
        const e = blocked.get(succ.id) ?? { succ, preds: [] };
        e.preds.push(pred);
        blocked.set(succ.id, e);
      }
    }
    if (blocked.size) {
      const list = [...blocked.values()];
      const worst = Math.max(...list.flatMap((b) => b.preds.map((p) => (p.planEnd && p.planEnd < now ? daysBetween(p.planEnd, now) : 0))));
      out.push({
        kind: 'blocked',
        severity: worst >= 7 ? 'high' : 'medium',
        title: `งานที่ติด Dependency ${list.length} งาน`,
        detail: list.slice(0, 3).map((b) => `${b.succ.key} รอ ${b.preds.map((p) => p.key).join(', ')}`).join(' · '),
        count: list.length,
        issueKeys: list.map((b) => b.succ.key).slice(0, 10),
      });
    }

    // 5) คำขอเลื่อน Due ที่ยังรอ
    const pending = await tx
      .select({ createdAt: s.dueChangeRequests.createdAt, issueId: s.dueChangeRequests.issueId })
      .from(s.dueChangeRequests)
      .innerJoin(s.issues, eq(s.issues.id, s.dueChangeRequests.issueId))
      .where(and(eq(s.issues.projectId, project.id), eq(s.dueChangeRequests.status, 'pending')));
    if (pending.length) {
      const oldest = Math.max(...pending.map((p) => Math.floor((Date.now() - p.createdAt.getTime()) / 86_400_000)));
      out.push({
        kind: 'pending_due_requests',
        severity: oldest >= 3 ? 'high' : 'medium',
        title: `คำขอเลื่อน Due ที่รออนุมัติ ${pending.length} รายการ`,
        detail: oldest > 0 ? `รอนานสุด ${oldest} วัน` : 'ส่งเข้ามาวันนี้',
        count: pending.length,
        issueKeys: pending.map((p) => byId.get(p.issueId)?.key).filter((k): k is string => !!k).slice(0, 10),
      });
    }
    return out.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.count - a.count);
  }

  // ---------------------------------------------------------------------------
  // GET p/insights/modules
  // ---------------------------------------------------------------------------
  async modules(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.guard(tx, auth, tenant, key, 'project.workload.view');
      const plan = await loadPlan(tx, project);
      return this.moduleStats(tx, project, plan, today());
    });
  }

  async moduleStats(tx: Tx, project: ProjectRow, plan: PlanData, now: string) {
    const cal = plan.cal;
    const since = addDays(now, -(VELOCITY_DAYS - 1));
    const sinceDate = new Date(`${since}T00:00:00+07:00`);
    const velocityDays = Math.max(1, cal.workingDaysIn(since, now));
    const groups: Array<{ id: string | null; name: string }> = [...plan.modules, ...(plan.work.some((w) => !w.moduleId) ? [{ id: null as string | null, name: 'ไม่ระบุ Module' }] : [])];

    const stat = (name: string, id: string | null, work: Item[], milestones: PlanData['milestones']) => {
      const total = work.reduce((n, w) => n + w.estimateMd, 0);
      const done = work.filter((w) => w.category === 'done');
      const doneMd = done.reduce((n, w) => n + w.estimateMd, 0);
      const remainingMd = round1(total - doneMd);
      const recentMd = done.filter((w) => w.completedAt && w.completedAt >= sinceDate).reduce((n, w) => n + w.estimateMd, 0);
      const mdPerDay = recentMd / velocityDays;
      const starts = work.map((w) => w.planStart).filter((x): x is string => !!x);
      const ends = work.map((w) => w.planEnd).filter((x): x is string => !!x);
      const plannedEnd = ends.length ? ends.reduce((m, e) => (e > m ? e : m)) : null;
      // เป้าหมาย = Milestone ถัดไปของ Module (ไม่มีใช้ตัวล่าสุด) · ไม่มี Milestone ใช้วันจบตามแผน
      const upcoming = milestones.filter((m) => m.date >= now)[0] ?? milestones.at(-1) ?? null;
      const targetDate = upcoming?.date ?? plannedEnd;
      const finished = work.length > 0 && done.length === work.length;
      let forecastEnd: string | null = null;
      let reason: string | null = null;
      if (finished) forecastEnd = done.map((w) => w.completedAt).filter((d): d is Date => !!d).map((d) => d.toISOString().slice(0, 10)).sort().at(-1) ?? now;
      else if (remainingMd <= 0) reason = 'no_estimate';
      else if (mdPerDay <= 0) reason = 'no_velocity';
      else forecastEnd = cal.nthWorkingDay(cal.onOrAfter(now), Math.max(1, Math.ceil(remainingMd / mdPerDay)));
      const slipDays = forecastEnd && targetDate ? daysBetween(targetDate, forecastEnd) : null;
      const status = finished ? 'done' : forecastEnd === null || slipDays === null ? 'no_forecast' : slipDays <= 0 ? 'on_track' : slipDays <= 7 ? 'at_risk' : 'off_track';
      return {
        id,
        name,
        taskCount: work.length,
        doneCount: done.length,
        totalMd: round1(total),
        doneMd: round1(doneMd),
        remainingMd,
        progressPct: total > 0 ? Math.round((doneMd / total) * 100) : work.length ? Math.round((done.length / work.length) * 100) : 0,
        overdue: work.filter((w) => isOpen(w) && w.planEnd && w.planEnd < now).length,
        planStart: starts.length ? starts.reduce((m, e) => (e < m ? e : m)) : null,
        plannedEnd,
        milestone: upcoming ? { name: upcoming.name, date: upcoming.date } : null,
        targetDate,
        velocityMdPerWeek: round1(mdPerDay * cal.daysPerWeek),
        forecastEnd,
        forecastReason: reason,
        slipDays,
        status,
      };
    };

    const modules = groups.map((g) => stat(g.name, g.id, plan.work.filter((w) => w.moduleId === g.id), plan.milestones.filter((m) => m.moduleId === g.id)));
    const all = stat(project.name, null, plan.work, plan.milestones);
    // เทียบแผนกับ capacity ของทีม (KPI "ต้องใช้จริงตาม capacity ≈ N สัปดาห์")
    const devIds = [...new Set(plan.work.filter(isOpen).flatMap((w) => w.assigneeIds))];
    const caps = devIds.length
      ? await tx
          .select({ userId: s.workspaceMembers.userId, ws: s.workspaceMembers.capacityHoursWeek, pj: s.projectMembers.capacityHoursWeek })
          .from(s.workspaceMembers)
          .leftJoin(s.projectMembers, and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, s.workspaceMembers.userId)))
          .where(and(eq(s.workspaceMembers.workspaceId, project.workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.userId, devIds)))
      : [];
    const capacityMdPerWeek = round1(caps.reduce((n, c) => n + (c.pj ?? c.ws) / 8, 0));
    const goLive = project.goliveDate;
    const weeksToGoLive = goLive ? round1(Math.max(0, cal.workingDaysIn(cal.onOrAfter(now), goLive)) / cal.daysPerWeek) : null;
    const requiredWeeks = capacityMdPerWeek > 0 ? round1(all.remainingMd / capacityMdPerWeek) : null;
    return {
      asOf: now,
      project: { key: project.key, name: project.name, goliveDate: goLive },
      summary: {
        taskCount: all.taskCount,
        totalMd: all.totalMd,
        doneMd: all.doneMd,
        remainingMd: all.remainingMd,
        progressPct: all.progressPct,
        capacityMdPerWeek,
        requiredWeeks,
        weeksToGoLive,
        // บวก = ต้องใช้เวลามากกว่าที่เหลือถึง Go-live
        gapWeeks: requiredWeeks !== null && weeksToGoLive !== null ? round1(requiredWeeks - weeksToGoLive) : null,
        forecastEnd: all.forecastEnd,
        forecastReason: all.forecastReason,
        status: goLive && all.forecastEnd ? (daysBetween(goLive, all.forecastEnd) <= 0 ? 'on_track' : daysBetween(goLive, all.forecastEnd) <= 7 ? 'at_risk' : 'off_track') : all.status,
      },
      velocity: { windowDays: VELOCITY_DAYS, note: 'อัตราเสร็จจริงใน 28 วันล่าสุด (Man-Day ต่อสัปดาห์ทำการ) ใช้คาดวันจบ' },
      modules,
    };
  }

  /** Man-Day ที่ตั้งใจเสร็จ (Plan) เทียบที่เสร็จจริง (Actual) รายสัปดาห์ย้อนหลัง */
  weeklySeries(plan: PlanData, now: string, weeks = WEEKS_BACK, moduleId?: string | null) {
    const out: Array<{ weekStart: string; weekEnd: string; plannedMd: number; doneMd: number }> = [];
    const cur = weekOf(now);
    for (let k = weeks - 1; k >= 0; k--) {
      const start = addDays(cur.start, -7 * k);
      const end = addDays(start, 6);
      const scope = plan.work.filter((w) => moduleId === undefined || w.moduleId === moduleId);
      const planned = scope.filter((w) => w.planEnd && w.planEnd >= start && w.planEnd <= end).reduce((n, w) => n + w.estimateMd, 0);
      const done = scope.filter((w) => w.category === 'done' && w.completedAt && w.completedAt >= new Date(`${start}T00:00:00+07:00`) && w.completedAt < new Date(`${addDays(end, 1)}T00:00:00+07:00`)).reduce((n, w) => n + w.estimateMd, 0);
      out.push({ weekStart: start, weekEnd: end, plannedMd: round1(planned), doneMd: round1(done) });
    }
    return out;
  }
}

