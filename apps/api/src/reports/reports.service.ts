import { Injectable } from '@nestjs/common';
import { schema as s } from '@friday/db';
import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { projectHealth } from '../overview/health.js';
import { weekOf } from '../overview/workload.js';
import { addDays } from '../projects/calendar.js';
import { InsightsService, WEEKS_BACK } from './insights.service.js';
import { isOpen, type Item, loadPlan, round1 } from './plan-data.js';

const isoDate = z.iso.date();
export const WeeklyQuery = z.object({ week: isoDate.optional() });
export const ForecastQuery = z.object({ weeks: z.coerce.number().int().min(1).max(26).default(WEEKS_BACK) });
export const TraceQuery = z.object({
  kind: z.enum(['FR', 'NFR']).optional(),
  result: z.enum(['uncovered', 'untested', 'partial', 'passed', 'failed', 'blocked']).optional(),
});

const startOf = (date: string) => new Date(`${date}T00:00:00+07:00`);
const inWeek = (d: Date | null, start: string, end: string) => !!d && d >= startOf(start) && d < startOf(addDays(end, 1));

/** O2 · Reports: รายงานประจำสัปดาห์, พยากรณ์ Module, Traceability */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: TenantDb,
    private readonly insights: InsightsService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET p/reports/weekly?week=
  // ---------------------------------------------------------------------------
  async weekly(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof WeeklyQuery>) {
    const now = today();
    const week = weekOf(q.week ?? now);
    const next = weekOf(addDays(week.end, 1));
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.insights.guard(tx, auth, tenant, key, 'project.view');
      const plan = await loadPlan(tx, project);
      const asOf = week.end < now ? week.end : now;
      const work = plan.work;
      const names = await loadPeople(tx, plan.items.flatMap((i) => i.assigneeIds));
      const nameOf = (id: string) => names.get(id)?.displayName ?? '—';

      const doneInWeek = work.filter((i) => i.category === 'done' && inWeek(i.completedAt, week.start, week.end));
      const inProgress = work.filter((i) => i.category === 'in_progress');
      const inReview = work.filter((i) => isOpen(i) && i.statusName.trim().toLowerCase() === 'review');
      const late = work.filter((i) => isOpen(i) && i.planEnd && i.planEnd < asOf);
      const perPerson = new Map<string, number>();
      for (const i of late) for (const u of i.assigneeIds) perPerson.set(u, (perPerson.get(u) ?? 0) + 1);
      const bugs = plan.items.filter((i) => i.isBug && i.createdAt >= startOf(week.start) && i.createdAt < startOf(addDays(week.end, 1)));
      const fixedBugs = plan.items.filter((i) => i.isBug && i.category === 'done' && inWeek(i.completedAt, week.start, week.end));
      const starting = work.filter((i) => i.planStart && i.planStart >= next.start && i.planStart <= next.end);
      const startingMd = starting.reduce((n, i) => n + i.estimateMd, 0);
      const moduleName = new Map(plan.modules.map((m) => [m.id, m.name]));
      const byModule = new Map<string, number>();
      for (const i of starting) byModule.set(moduleName.get(i.moduleId ?? '') ?? 'ไม่ระบุ Module', (byModule.get(moduleName.get(i.moduleId ?? '') ?? 'ไม่ระบุ Module') ?? 0) + 1);

      const holidays = await tx
        .select({ date: s.holidays.date, name: s.holidays.name })
        .from(s.holidays)
        .innerJoin(s.workspaceSettings, eq(s.workspaceSettings.holidayCalendarId, s.holidays.calendarId))
        .where(and(eq(s.workspaceSettings.workspaceId, tenant.workspaceId), gte(s.holidays.date, next.start), lt(s.holidays.date, addDays(next.end, 1))));
      const own = await tx.select({ date: s.projectHolidays.date, name: s.projectHolidays.name }).from(s.projectHolidays).where(and(eq(s.projectHolidays.projectId, project.id), gte(s.projectHolidays.date, next.start), lt(s.projectHolidays.date, addDays(next.end, 1))));
      const sprints = await tx.select().from(s.sprints).where(eq(s.sprints.projectId, project.id)).orderBy(asc(s.sprints.number));
      const sprintEvents = sprints.flatMap((sp) => [
        ...(sp.startDate >= next.start && sp.startDate <= next.end ? [{ date: sp.startDate, type: 'sprint_start', name: sp.name }] : []),
        ...(sp.endDate >= next.start && sp.endDate <= next.end ? [{ date: sp.endDate, type: 'sprint_end', name: sp.name }] : []),
      ]);

      const health = projectHealth(plan.cal, work.map((i) => ({ estimateMd: i.estimateMd || null, planStart: i.planStart, planEnd: i.planEnd, done: i.category === 'done', progressPct: i.progressPct })), asOf);
      const allMd = work.reduce((n, i) => n + i.estimateMd, 0);
      const usedMd = work.filter((i) => i.category === 'done').reduce((n, i) => n + i.estimateMd, 0);
      const risks = (await this.insights.computeRisks(tx, project, plan, asOf)).slice(0, 5);
      const unassigned = work.filter((i) => isOpen(i) && !i.assigneeIds.length && i.planStart && i.planStart <= next.end);

      const report = {
        project: { key: project.key, name: project.name },
        week: { start: week.start, end: week.end, label: `${week.start} – ${addDays(week.start, 4)}`, draft: week.end >= now, asOf },
        status: health.level,
        totals: { doneCount: work.filter((i) => i.category === 'done').length, taskCount: work.length, usedMd: round1(usedMd), totalMd: round1(allMd), overdue: late.length },
        thisWeek: {
          done: { count: doneInWeek.length, md: round1(doneInWeek.reduce((n, i) => n + i.estimateMd, 0)), keys: doneInWeek.slice(0, 20).map((i) => i.key) },
          inProgress: inProgress.length,
          inReview: inReview.length,
          overdue: { count: late.length, byAssignee: [...perPerson].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, displayName: nameOf(id), count })) },
          newBugs: bugs.map((b) => ({ key: b.key, title: b.title, status: b.statusName })),
          fixedBugs: fixedBugs.map((b) => ({ key: b.key, title: b.title })),
        },
        nextWeek: {
          start: next.start,
          end: next.end,
          starting: { count: starting.length, md: round1(startingMd), byModule: [...byModule].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) },
          holidays: [...holidays, ...own].sort((a, b) => a.date.localeCompare(b.date)),
          sprintEvents,
        },
        risks,
        needsHelp: { unassigned: { count: unassigned.length, keys: unassigned.slice(0, 10).map((i) => i.key) } },
      };
      return { ...report, text: this.text(report) };
    });
  }

  /** ข้อความล้วนสำหรับ "คัดลอกข้อความ" / ส่ง LINE · อีเมล (แก้ก่อนส่งได้ที่หน้าเว็บ) */
  private text(r: { project: { name: string }; week: { label: string }; status: string; totals: { doneCount: number; taskCount: number; usedMd: number; totalMd: number; overdue: number }; thisWeek: { done: { count: number; md: number }; inProgress: number; inReview: number; overdue: { count: number; byAssignee: Array<{ displayName: string; count: number }> }; newBugs: Array<{ key: string; title: string }> }; nextWeek: { starting: { count: number; md: number } }; risks: Array<{ title: string; detail: string }>; needsHelp: { unassigned: { count: number } } }) {
    const status = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' }[r.status] ?? r.status;
    const lines = [
      `รายงานประจำสัปดาห์ · ${r.project.name} · ${r.week.label}`,
      `สถานะรวม ${status} · เสร็จ ${r.totals.doneCount}/${r.totals.taskCount} งาน · Man-Day ใช้ไป ${r.totals.usedMd}/${r.totals.totalMd} · งานล่าช้า ${r.totals.overdue}`,
      '',
      '1. สัปดาห์นี้',
      `เสร็จแล้ว ${r.thisWeek.done.count} งาน (${r.thisWeek.done.md} MD) · กำลังทำ ${r.thisWeek.inProgress} งาน · รอ Review ${r.thisWeek.inReview} งาน`,
      ...(r.thisWeek.overdue.count ? [`งานเลยกำหนด ${r.thisWeek.overdue.count} งาน: ${r.thisWeek.overdue.byAssignee.map((p) => `${p.displayName} ${p.count}`).join(' · ')}`] : []),
      ...(r.thisWeek.newBugs.length ? [`Bug ใหม่ ${r.thisWeek.newBugs.length} (${r.thisWeek.newBugs.map((b) => `${b.key} ${b.title}`).join(', ')})`] : []),
      '',
      '2. สัปดาห์หน้า',
      `เริ่มตามแผน ${r.nextWeek.starting.count} งาน (${r.nextWeek.starting.md} MD)`,
      '',
      '3. ความเสี่ยงและสิ่งที่ต้องตัดสินใจ',
      ...(r.risks.length ? r.risks.map((k) => `- ${k.title} · ${k.detail}`) : ['- ไม่พบความเสี่ยงสำคัญ']),
      ...(r.needsHelp.unassigned.count ? ['', `4. ขอความช่วยเหลือ: มี ${r.needsHelp.unassigned.count} งานที่ใกล้เริ่มแต่ยังไม่มีผู้รับผิดชอบ`] : []),
    ];
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // GET p/reports/module-forecast
  // ---------------------------------------------------------------------------
  async moduleForecast(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof ForecastQuery>) {
    const now = today();
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.insights.guard(tx, auth, tenant, key, 'project.view');
      const plan = await loadPlan(tx, project);
      const base = await this.insights.moduleStats(tx, project, plan, now);
      return {
        ...base,
        weekly: this.insights.weeklySeries(plan, now, q.weeks),
        modules: base.modules.map((m) => ({ ...m, weekly: this.insights.weeklySeries(plan, now, q.weeks, m.id) })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // GET p/reports/traceability
  // ---------------------------------------------------------------------------
  async traceability(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof TraceQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const project = await this.insights.guard(tx, auth, tenant, key, 'project.view');
      const plan = await loadPlan(tx, project);
      const byId = new Map(plan.items.map((i) => [i.id, i]));
      const runs = plan.items.length
        ? await tx.select().from(s.testRuns).where(inArray(s.testRuns.issueId, plan.items.map((i) => i.id))).orderBy(desc(s.testRuns.runNo))
        : [];
      // ผลทดสอบล่าสุดของแต่ละงาน (runNo สูงสุด)
      const latest = new Map<string, (typeof runs)[number]>();
      for (const r of runs) if (!latest.has(r.issueId)) latest.set(r.issueId, r);

      const issueDto = (i: Item) => {
        const r = latest.get(i.id);
        return { key: i.key, title: i.title, type: i.type, status: { name: i.statusName, category: i.category }, latestTest: r ? { result: r.result, runNo: r.runNo, environment: r.environment, passed: r.passedCount, total: r.totalCount, at: r.createdAt } : null };
      };
      const verdict = (list: Item[]) => {
        if (!list.length) return 'uncovered' as const;
        const results = list.map((i) => latest.get(i.id)?.result);
        if (results.every((x) => !x)) return 'untested' as const;
        if (results.includes('failed')) return 'failed' as const;
        if (results.includes('blocked')) return 'blocked' as const;
        return results.every((x) => x === 'passed') ? ('passed' as const) : ('partial' as const);
      };

      const reqs = await tx.select().from(s.requirements).where(eq(s.requirements.projectId, project.id)).orderBy(asc(s.requirements.code));
      const reqLinks = await tx.select().from(s.issueRequirements).where(inArray(s.issueRequirements.requirementId, reqs.length ? reqs.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000']));
      const scr = await tx.select().from(s.screens).where(eq(s.screens.projectId, project.id)).orderBy(asc(s.screens.code));
      const scrLinks = await tx.select().from(s.issueScreens).where(inArray(s.issueScreens.screenId, scr.length ? scr.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000']));

      const build = <T extends { id: string }>(rows: T[], links: Array<{ issueId: string; id: string }>) =>
        rows.map((r) => {
          const issues = links.filter((l) => l.id === r.id).map((l) => byId.get(l.issueId)).filter((i): i is Item => !!i);
          return { row: r, issues, result: verdict(issues) };
        });
      const requirements = build(reqs, reqLinks.map((l) => ({ issueId: l.issueId, id: l.requirementId })))
        .filter((x) => (!q.kind || x.row.kind === q.kind) && (!q.result || x.result === q.result))
        .map((x) => ({ code: x.row.code, kind: x.row.kind, title: x.row.title, result: x.result, issues: x.issues.map(issueDto) }));
      const screens = build(scr, scrLinks.map((l) => ({ issueId: l.issueId, id: l.screenId })))
        .filter((x) => !q.result || x.result === q.result)
        .map((x) => ({ code: x.row.code, name: x.row.name, result: x.result, issues: x.issues.map(issueDto) }));

      const all = build(reqs, reqLinks.map((l) => ({ issueId: l.issueId, id: l.requirementId })));
      const count = (r: string) => all.filter((x) => x.result === r).length;
      const linked = new Set(reqLinks.map((l) => l.issueId));
      const unlinked = plan.work.filter((i) => !linked.has(i.id));
      return {
        project: { key: project.key, name: project.name },
        summary: {
          requirements: { total: all.length, uncovered: count('uncovered'), untested: count('untested'), partial: count('partial'), passed: count('passed'), failed: count('failed'), blocked: count('blocked') },
          screens: { total: scr.length },
          // งานที่ไม่มี FR อ้างอิง (O2: "งานไม่มี FR อ้างอิง")
          issuesWithoutRequirement: { count: unlinked.length, keys: unlinked.slice(0, 20).map((i) => i.key) },
        },
        requirements,
        screens,
      };
    });
  }
}

