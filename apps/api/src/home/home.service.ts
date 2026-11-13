import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../common/errors.js';
import { today } from '../common/dates.js';
import { loadPeople, type Person } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { DueRequestsService, ListDueRequestsQuery } from '../due-requests/due-requests.service.js';
import { projectHealth, type HealthItem } from '../overview/health.js';
import { weekOf, workspaceWorkload } from '../overview/workload.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import { loadScope, type Issue, type Scope } from './scope.js';
import { reviewerList } from '../issues/rules.js';
import { canMoveIssue } from '../projects/permissions.js';

const uuid = z.uuid();

export const MyIssuesQuery = z.object({
  tab: z.enum(['assigned', 'reviewer', 'watching', 'created']).default('assigned'),
  group: z.enum(['due', 'project', 'status']).default('due'),
  projectKey: z.string().trim().min(1).max(20).optional(),
  assignee: uuid.optional(),
});

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const dateOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(d);
const startOfDay = (date: string) => new Date(`${date}T00:00:00+07:00`);
const isReviewName = (name: string) => name.trim().toLowerCase() === 'review';
const STATUS_ORDER: Record<string, number> = { todo: 0, in_progress: 1, blocked: 2, review: 3, done: 4, cancelled: 5 };

/** ครบกำหนดเมื่อไหร่ เทียบวันนี้ (วันทำการไม่เกี่ยว ใช้วันปฏิทินตาม Canvas "เลย 7 วัน") */
export function dueState(planEnd: string | null, now: string) {
  if (!planEnd) return { state: 'none' as const, days: null };
  const d = daysBetween(now, planEnd);
  return { state: d < 0 ? ('overdue' as const) : d === 0 ? ('today' as const) : ('later' as const), days: Math.abs(d) };
}

/** E · Home และ F · My Tasks */
@Injectable()
export class HomeService {
  constructor(
    private readonly db: TenantDb,
    private readonly dueRequests: DueRequestsService,
  ) {}

  // ---------------------------------------------------------------------------
  // E · Home
  // ---------------------------------------------------------------------------
  async home(auth: AuthInfo, tenant: TenantInfo) {
    const now = today();
    const week = weekOf(now);
    const guest = tenant.role === 'guest';
    const core = await this.db.run(auth, tenant, async (tx) => {
      const sc = await loadScope(tx, auth, tenant);
      const open = sc.issues.filter((i) => !sc.isDone(i));
      // สถิติ "ทีม" นับเฉพาะโปรเจกต์ที่ฉันเป็นสมาชิก · "ของฉัน" นับทุกโปรเจกต์ที่เข้าถึงได้
      const team = open.filter((i) => sc.mine.has(i.projectId) && sc.due(i).date);
      // "ของฉัน" นับทุกบทบาทในงาน (Dev, BA, SA, QA / Reviewer) ให้ตรงกับแท็บ "มอบหมายให้ฉัน"
      const myOpen = open.filter((i) => sc.rolesOf(i, auth.userId).length > 0);
      const weekLast = lastWorkday(week.end);
      const count = (list: Issue[], pred: (i: Issue) => boolean) => list.filter(pred).length;
      // วันครบกำหนดตามขั้นของงาน: งานที่ส่ง QA แล้วในโปรเจกต์แยก Dev / QA ใช้ QA Due
      const dueDate = (i: Issue) => sc.due(i).date;
      const late = (i: Issue) => dueDate(i)! < now;
      const dueToday = (i: Issue) => dueDate(i) === now;
      const thisWeek = (i: Issue) => dueDate(i)! >= now && dueDate(i)! <= week.end;

      // งานเลยกำหนดขั้น QA นับให้ QA / Reviewer ไม่ใช่ Dev
      const byAssignee = new Map<string, number>();
      for (const i of team.filter(late)) for (const u of sc.lateOwners(i).length ? sc.lateOwners(i) : ['_none']) byAssignee.set(u, (byAssignee.get(u) ?? 0) + 1);

      const reviews = open.filter((i) => reviewerList(i).includes(auth.userId) && (sc.statuses.get(i.statusId)!.category === 'review' || isReviewName(sc.statuses.get(i.statusId)!.name)));
      const mentions = await this.mentions(tx, auth, tenant);
      const people = await loadPeople(tx, guest ? [] : [...byAssignee.keys()].filter((u) => u !== '_none'));

      const summary = {
        dueToday: { team: count(team, dueToday), mine: count(myOpen, (i) => !!dueDate(i) && dueToday(i)), keys: team.filter(dueToday).slice(0, 5).map(sc.keyOf) },
        overdue: {
          team: count(team, late),
          mine: count(myOpen, (i) => !!dueDate(i) && late(i)),
          // Guest ไม่เห็นชื่อคนในองค์กร
          byAssignee: guest ? [] : [...byAssignee].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u, n]) => ({ person: people.get(u) ?? null, count: n })),
        },
        dueThisWeek: { team: count(team, thisWeek), mine: count(myOpen, (i) => !!dueDate(i) && thisWeek(i)), until: weekLast },
        inProgress: { mine: count(myOpen, (i) => sc.statuses.get(i.statusId)!.category === 'in_progress') },
        waitingReview: reviews.length,
        unreadMentions: mentions,
      };

      const recent = await this.recent(tx, auth, sc);
      const projects = await this.projectCards(tx, auth, sc, now);
      const upcoming = await this.upcoming(tx, tenant, sc, now);
      const workload = guest ? null : await this.workload(tx, auth, tenant, week);
      return { sc, reviews, summary, recent, projects, upcoming, workload };
    });

    // รออนุมัติ: Guest ไม่มีสิทธิ์อนุมัติ
    const approvals = guest ? { items: [] as Array<{ canDecide: boolean }> } : await this.dueRequests.list(auth, tenant, ListDueRequestsQuery.parse({ scope: 'to_approve', status: 'pending' }));
    const { sc, reviews, summary } = core;
    const reviewPeople = await this.db.run(auth, tenant, (tx) => loadPeople(tx, guest ? [] : reviews.map((i) => i.createdBy)));
    return {
      today: now,
      week,
      summary: { ...summary, pendingApprovals: approvals.items.length },
      waiting: {
        approvals: approvals.items,
        reviews: reviews.map((i) => ({ ...this.issueRef(sc, i), from: i.createdBy ? (reviewPeople.get(i.createdBy) ?? null) : null })),
      },
      projects: core.projects,
      recent: core.recent,
      upcoming: core.upcoming,
      workload: core.workload,
    };
  }

  private issueRef(sc: Scope, i: Issue) {
    const st = sc.statuses.get(i.statusId)!;
    const p = sc.projects.find((x) => x.id === i.projectId)!;
    return { key: sc.keyOf(i), title: i.title, project: { key: p.key, name: p.name }, status: { name: st.name, category: st.category }, planEnd: i.planEnd };
  }

  private async mentions(tx: Tx, auth: AuthInfo, tenant: TenantInfo) {
    const rows = await tx
      .select({ payload: s.notifications.payload })
      .from(s.notifications)
      .where(and(eq(s.notifications.workspaceId, tenant.workspaceId), eq(s.notifications.recipientId, auth.userId), eq(s.notifications.eventType, 'issue.mentioned'), isNull(s.notifications.readAt), isNull(s.notifications.doneAt)))
      .orderBy(desc(s.notifications.createdAt));
    return { count: rows.length, latestFrom: (rows[0]?.payload as { actorName?: string } | undefined)?.actorName ?? null };
  }

  /** เปิดล่าสุด: งานที่ฉันแตะล่าสุดจาก activities (ไม่ซ้ำงาน) */
  private async recent(tx: Tx, auth: AuthInfo, sc: Scope) {
    const rows = await tx
      .select({ issueId: s.activities.issueId, verb: s.activities.verb, field: s.activities.field, at: s.activities.createdAt })
      .from(s.activities)
      .where(and(eq(s.activities.actorId, auth.userId), eq(s.activities.actorKind, 'user')))
      .orderBy(desc(s.activities.createdAt))
      .limit(80);
    const seen = new Set<string>();
    const out: Array<{ key: string; title: string; project: { key: string; name: string }; verb: string; at: Date }> = [];
    const visible = new Map(sc.issues.map((i) => [i.id, i]));
    for (const r of rows) {
      if (!r.issueId || seen.has(r.issueId)) continue;
      const i = visible.get(r.issueId);
      if (!i) continue; // งานที่เสร็จนานแล้ว / ลบแล้ว / ไม่มีสิทธิ์เห็น
      seen.add(r.issueId);
      const ref = this.issueRef(sc, i);
      out.push({ key: ref.key, title: ref.title, project: ref.project, verb: r.verb, at: r.at });
      if (out.length >= 8) break;
    }
    return out;
  }

  /** โปรเจกต์ของฉัน: ความคืบหน้า, Overdue, งานของฉัน, Go-live และ Health */
  private async projectCards(tx: Tx, auth: AuthInfo, sc: Scope, now: string) {
    const mine = sc.projects.filter((p) => sc.mine.has(p.id));
    if (!mine.length) return [];
    // ความคืบหน้าและ Health ต้องนับงานที่เสร็จแล้วทั้งหมด ซึ่ง scope ตัดทิ้ง จึงอ่านทั้งโปรเจกต์
    const all = await tx.select().from(s.issues).where(and(inArray(s.issues.projectId, mine.map((p) => p.id)), isNull(s.issues.deletedAt)));
    const guest = (id: string) => sc.access.get(id)!.guestViewer;
    return Promise.all(
      mine.map(async (p) => {
        // งานที่ยกเลิกไม่นับในความคืบหน้าและ Health
        const list = all.filter((i) => i.projectId === p.id && sc.statuses.get(i.statusId)?.category !== 'cancelled' && (!guest(p.id) || (i.sharedWithGuests && sc.typeNames.get(i.issueTypeId) !== 'Bug')));
        const done = (i: Issue) => sc.statuses.get(i.statusId)?.category === 'done';
        const tasks = list.filter((i) => !i.parentId);
        const weighted = p.progressMethod === 'weighted';
        const total = tasks.reduce((n, i) => n + (weighted ? (i.estimateMd ?? 0) : 1), 0);
        const finished = tasks.filter(done).reduce((n, i) => n + (weighted ? (i.estimateMd ?? 0) : 1), 0);
        const parents = new Set(list.filter((i) => i.parentId && sc.typeNames.get(i.issueTypeId) !== 'Bug').map((i) => i.parentId!));
        const items: HealthItem[] = list.filter((i) => !parents.has(i.id)).map((i) => ({ estimateMd: i.estimateMd, planStart: i.planStart, planEnd: i.planEnd, done: done(i), progressPct: i.progressPct }));
        const health = projectHealth(await WorkCalendar.load(tx, p), items, now);
        const open = list.filter((i) => !done(i));
        return {
          key: p.key,
          name: p.name,
          color: p.color,
          goliveDate: p.goliveDate,
          daysToGolive: p.goliveDate ? daysBetween(now, p.goliveDate) : null,
          progressPct: total ? Math.round((finished / total) * 100) : 0,
          overdue: open.filter((i) => { const d = sc.due(i).date; return d && d < now; }).length,
          myTasks: open.filter((i) => sc.rolesOf(i, auth.userId).length > 0).length,
          health: { level: health.level, gapPct: health.gapPct },
        };
      }),
    ).then((cards) => cards.sort((a, b) => (a.goliveDate ?? '9999').localeCompare(b.goliveDate ?? '9999') || a.name.localeCompare(b.name)));
  }

  /** 30 วันข้างหน้า: Sprint, Milestone, วันหยุด และกลุ่มงานที่ครบ */
  private async upcoming(tx: Tx, tenant: TenantInfo, sc: Scope, now: string) {
    const to = addDays(now, 30);
    const mine = sc.projects.filter((p) => sc.mine.has(p.id));
    const ids = mine.map((p) => p.id);
    const nameOf = new Map(sc.projects.map((p) => [p.id, p.name]));
    const events: Array<{ date: string; type: string; title: string; project: string | null }> = [];
    if (ids.length) {
      const sprints = await tx.select().from(s.sprints).where(and(inArray(s.sprints.projectId, ids), lte(s.sprints.startDate, to), gte(s.sprints.endDate, now)));
      for (const sp of sprints) {
        if (sp.startDate >= now) events.push({ date: sp.startDate, type: 'sprint_start', title: sp.name, project: nameOf.get(sp.projectId) ?? null });
        if (sp.endDate <= to) events.push({ date: sp.endDate, type: 'sprint_end', title: sp.name, project: nameOf.get(sp.projectId) ?? null });
      }
      const ms = await tx.select().from(s.milestones).where(and(inArray(s.milestones.projectId, ids), gte(s.milestones.date, now), lte(s.milestones.date, to)));
      for (const m of ms) events.push({ date: m.date, type: 'milestone', title: m.name, project: nameOf.get(m.projectId) ?? null });
      // กลุ่มงานที่ครบ = วันสิ้นสุดของงานสุดท้ายในกลุ่ม
      const phases = await tx.select().from(s.phases).where(inArray(s.phases.projectId, ids));
      for (const ph of phases) {
        const dates = sc.issues.filter((i) => i.phaseId === ph.id && i.planEnd).map((i) => i.planEnd!);
        const end = dates.reduce<string | null>((m, d) => (!m || d > m ? d : m), null);
        if (end && end >= now && end <= to) events.push({ date: end, type: 'phase_end', title: ph.name, project: nameOf.get(ph.projectId) ?? null });
      }
    }
    const holidays = await tx
      .select({ date: s.holidays.date, name: s.holidays.name })
      .from(s.holidays)
      .innerJoin(s.workspaceSettings, eq(s.workspaceSettings.holidayCalendarId, s.holidays.calendarId))
      .where(and(eq(s.workspaceSettings.workspaceId, tenant.workspaceId), gte(s.holidays.date, now), lte(s.holidays.date, to)));
    for (const h of holidays) events.push({ date: h.date, type: 'holiday', title: h.name, project: null });
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  }

  /** Workload สัปดาห์นี้ของทีม (ทุกโปรเจกต์ที่เข้าถึงได้) และของฉัน */
  private async workload(tx: Tx, auth: AuthInfo, tenant: TenantInfo, week: { start: string; end: string }) {
    const w = await workspaceWorkload(tx, tenant.workspaceId, { from: week.start, to: week.end, group: 'week', unit: 'md' });
    const round = (n: number) => Math.round(n * 10) / 10;
    const rows = [...w.result.rows].map(([userId, cells]) => ({
      person: w.profiles.get(userId) as Person | undefined,
      md: round(cells.reduce((n, c) => n + c.md, 0)),
      capacityMd: round(cells.reduce((n, c) => n + c.capacityMd, 0)),
      userId,
    }));
    const teamMd = round(rows.reduce((n, r) => n + r.md, 0));
    const capacity = round(rows.reduce((n, r) => n + r.capacityMd, 0));
    const me = rows.find((r) => r.userId === auth.userId);
    return {
      week,
      team: { md: teamMd, capacityMd: capacity, utilizationPct: capacity ? Math.round((teamMd / capacity) * 100) : null },
      mine: me ? { md: me.md, capacityMd: me.capacityMd, utilizationPct: me.capacityMd ? Math.round((me.md / me.capacityMd) * 100) : null } : null,
      people: rows.sort((a, b) => b.md - a.md).slice(0, 10).map(({ userId: _u, ...r }) => ({ ...r, utilizationPct: r.capacityMd ? Math.round((r.md / r.capacityMd) * 100) : null })),
    };
  }

  // ---------------------------------------------------------------------------
  // F · My Tasks
  // ---------------------------------------------------------------------------
  async myIssues(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof MyIssuesQuery>) {
    const now = today();
    return this.db.run(auth, tenant, async (tx) => {
      const sc = await loadScope(tx, auth, tenant, { doneSince: startOfDay(now) });
      const watched = new Set(
        (await tx.select({ issueId: s.issueWatchers.issueId }).from(s.issueWatchers).where(and(eq(s.issueWatchers.userId, auth.userId), eq(s.issueWatchers.workspaceId, tenant.workspaceId)))).map((w) => w.issueId),
      );
      const me = (i: Issue, tab: z.infer<typeof MyIssuesQuery>['tab']) =>
        // มอบหมายให้ฉัน = ทุกบทบาท ไม่ใช่แค่ผู้รับผิดชอบ (BA ที่ถูกตั้งเป็น QA ต้องเห็นงานด้วย)
        tab === 'assigned' ? sc.rolesOf(i, auth.userId).length > 0 : tab === 'reviewer' ? reviewerList(i).includes(auth.userId) : tab === 'watching' ? watched.has(i.id) : i.createdBy === auth.userId;
      const open = (i: Issue) => !sc.isDone(i);
      // จำนวนบนแต่ละแท็บนับเฉพาะงานที่ยังไม่เสร็จ
      const counts = Object.fromEntries((['assigned', 'reviewer', 'watching', 'created'] as const).map((t) => [t, sc.issues.filter((i) => open(i) && me(i, t)).length]));

      const wanted = q.projectKey?.toUpperCase();
      const project = wanted ? sc.projects.find((p) => p.key === wanted) : undefined;
      if (wanted && !project) throw new AppError(404, 'project_not_found', 'ไม่พบโปรเจกต์');
      const rows = sc.issues.filter((i) => me(i, q.tab) && (!project || i.projectId === project.id) && (!q.assignee || (sc.assignees.get(i.id) ?? []).includes(q.assignee)));
      const guest = tenant.role === 'guest';
      const people = guest ? new Map<string, Person>() : await loadPeople(tx, rows.flatMap((i) => sc.assignees.get(i.id) ?? []));
      const parentKey = new Map(sc.issues.map((i) => [i.id, sc.keyOf(i)]));
      const subCounts = new Map<string, { total: number; done: number }>();
      for (const i of sc.issues) if (i.parentId) {
        const c = subCounts.get(i.parentId) ?? { total: 0, done: 0 };
        c.total++;
        if (sc.isDone(i)) c.done++;
        subCounts.set(i.parentId, c);
      }
      const item = (i: Issue) => {
        const st = sc.statuses.get(i.statusId)!;
        const p = sc.projects.find((x) => x.id === i.projectId)!;
        return {
          key: sc.keyOf(i),
          title: i.title,
          type: sc.typeNames.get(i.issueTypeId) ?? null,
          project: { key: p.key, name: p.name, color: p.color },
          status: { id: st.id, name: st.name, category: st.category },
          priority: i.priority,
          planStart: i.planStart,
          planEnd: i.planEnd,
          // ฟิลด์ของการแยก Dev / QA ส่งเฉพาะโปรเจกต์ที่แยก · โปรเจกต์อื่นได้รูปแบบเดิม
          ...(sc.due(i).stage ? { qaDue: sc.qaDue(i) } : {}),
          due: sc.isDone(i) ? { state: 'done' as const, days: null } : { ...dueState(sc.due(i).date, now), ...(sc.due(i).stage ? { stage: sc.due(i).stage } : {}) },
          estimateMd: i.estimateMd,
          parentKey: i.parentId ? (parentKey.get(i.parentId) ?? null) : null,
          subtasks: subCounts.get(i.id) ?? null,
          assignees: (sc.assignees.get(i.id) ?? []).map((u) => people.get(u)).filter((x): x is Person => !!x),
          myRoles: sc.rolesOf(i, auth.userId),
          // แท็บ "มอบหมายให้ฉัน" รวม BA / SA ที่เปลี่ยนสถานะไม่ได้ · หน้าเว็บซ่อนช่องติ๊กเสร็จตามค่านี้
          canMove: canMoveIssue(sc.access.get(i.projectId)!, { ...i, assigneeIds: sc.assignees.get(i.id) ?? [] }),
          version: i.version,
        };
      };
      const byDue = (a: Issue, b: Issue) => (sc.due(a).date ?? '9999').localeCompare(sc.due(b).date ?? '9999') || a.number - b.number;

      let groups: Array<{ key: string; label: string; range?: { from: string; to: string }; items: Issue[] }>;
      if (q.group === 'due') {
        const wk = weekOf(now);
        const next = weekOf(addDays(wk.end, 1));
        const doneToday = (i: Issue) => sc.isDone(i) && !!i.completedAt && dateOf(i.completedAt) === now;
        const bucket = (i: Issue) => {
          if (sc.isDone(i)) return doneToday(i) ? 'done_today' : null;
          const d = sc.due(i).date;
          if (!d) return 'none';
          if (d < now) return 'late';
          if (d === now) return 'today';
          if (d <= wk.end) return 'this_week';
          if (d <= next.end) return 'next_week';
          return 'later';
        };
        const defs = [
          ['late', 'เลยกำหนด', undefined],
          ['today', 'วันนี้', { from: now, to: now }],
          ['this_week', 'สัปดาห์นี้', { from: addDays(now, 1), to: wk.end }],
          ['next_week', 'สัปดาห์หน้า', { from: next.start, to: next.end }],
          ['later', 'ภายหลัง', { from: addDays(next.end, 1), to: '' }],
          ['none', 'ไม่มีวันที่', undefined],
          ['done_today', 'เสร็จวันนี้', { from: now, to: now }],
        ] as const;
        groups = defs.map(([key, label, range]) => ({ key, label, ...(range ? { range: range.to ? range : { from: range.from, to: range.from } } : {}), items: rows.filter((i) => bucket(i) === key).sort(byDue) }));
        // ช่วงของ "ภายหลัง" ไม่มีวันสิ้นสุด
        const later = groups.find((g) => g.key === 'later')!;
        later.range = { from: addDays(next.end, 1), to: '' };
      } else if (q.group === 'project') {
        groups = sc.projects
          .map((p) => ({ key: p.key, label: p.name, items: rows.filter((i) => i.projectId === p.id).sort(byDue) }))
          .filter((g) => g.items.length);
      } else {
        const order = new Map<string, { sort: number; cat: number; name: string }>();
        for (const i of rows) {
          const st = sc.statuses.get(i.statusId)!;
          order.set(st.name, { sort: st.sort, cat: STATUS_ORDER[st.category as keyof typeof STATUS_ORDER] ?? 9, name: st.name });
        }
        groups = [...order.values()]
          .sort((a, b) => a.cat - b.cat || a.sort - b.sort || a.name.localeCompare(b.name))
          .map((o) => ({ key: o.name, label: o.name, items: rows.filter((i) => sc.statuses.get(i.statusId)!.name === o.name).sort(byDue) }));
      }
      return {
        today: now,
        tab: q.tab,
        group: q.group,
        counts,
        total: rows.filter(open).length,
        groups: groups.map((g) => ({ key: g.key, label: g.label, ...(g.range ? { range: g.range } : {}), count: g.items.length, items: g.items.map(item) })),
      };
    });
  }
}

/** ศุกร์ของสัปดาห์ (วันทำการสุดท้ายแบบจันทร์–ศุกร์) ใช้แสดง "ถึง ศ. 4 ธ.ค." */
function lastWorkday(weekEnd: string) {
  return addDays(weekEnd, -2);
}
