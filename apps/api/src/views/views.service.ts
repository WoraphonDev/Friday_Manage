import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError } from '../common/errors.js';
import { loadPeople, type Person } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { addDays } from '../projects/calendar.js';
import { ProjectsService } from '../projects/projects.service.js';

const s = schema;
const uuid = z.uuid();
const isoDate = z.iso.date();

export const BoardQuery = z.object({
  /** bug = คอลัมน์ของ Workflow Bug (Open, In progress, Fixed, Verified, Closed) */
  type: z.enum(['bug']).optional(),
  level: z.enum(['all', 'task', 'subtask']).default('all'),
  assignee: z.union([z.literal('me'), uuid]).optional(),
  overdue: z.stringbool().default(false),
  moduleId: uuid.optional(),
  sprintId: uuid.optional(),
  /** การ์ดที่เสร็จเกิน 7 วันซ่อนไว้ ("Show older") */
  showOlderDone: z.stringbool().default(false),
});

export const TimelineQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'], message: 'to ต้องไม่ก่อน from' });

type Issue = typeof s.issues.$inferSelect;
type Status = typeof s.workflowStatuses.$inferSelect;
const HIDE_DONE_AFTER_DAYS = 7;

/** โหลดข้อมูลของโปรเจกต์ที่ทั้ง Kanban และ Timeline ใช้ ในไม่กี่ query */
async function loadProjectData(tx: Tx, projectId: string) {
  const [types, statuses, issues, modules, phases] = await Promise.all([
    tx.select().from(s.issueTypes).where(eq(s.issueTypes.projectId, projectId)),
    tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.projectId, projectId)).orderBy(asc(s.workflowStatuses.sort)),
    tx
      .select()
      .from(s.issues)
      .where(and(eq(s.issues.projectId, projectId), isNull(s.issues.deletedAt)))
      .orderBy(sql`${s.issues.rank} collate "C"`, asc(s.issues.number)),
    tx.select().from(s.modules).where(eq(s.modules.projectId, projectId)).orderBy(asc(s.modules.sort), asc(s.modules.name)),
    tx.select().from(s.phases).where(eq(s.phases.projectId, projectId)).orderBy(asc(s.phases.sort), asc(s.phases.name)),
  ]);
  const assignees = await tx
    .select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
    .from(s.issueAssignees)
    .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
    .where(eq(s.issues.projectId, projectId))
    .orderBy(asc(s.issueAssignees.sort));
  const byIssue = new Map<string, string[]>();
  for (const a of assignees) byIssue.set(a.issueId, [...(byIssue.get(a.issueId) ?? []), a.userId]);
  return {
    types: new Map(types.map((t) => [t.id, t])),
    statuses: new Map(statuses.map((st) => [st.id, st])),
    statusList: statuses,
    issues,
    modules,
    phases,
    assignees: byIssue,
    numberOf: new Map(issues.map((i) => [i.id, i.number])),
  };
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

@Injectable()
export class ViewsService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
  ) {}

  // ---------------------------------------------------------------------------
  // 3 · Kanban
  // ---------------------------------------------------------------------------
  async board(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof BoardQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      // Guest ที่เป็น Viewer เห็นแค่ Overview, Timeline และงานที่แชร์ (04-permissions ข้อ 4)
      if (access.guestViewer) throw new AppError(403, 'guest_view_limited', 'Guest เห็นเฉพาะ Overview, Timeline และงานที่แชร์ให้', { allowed: ['overview', 'timeline'] });

      const d = await loadProjectData(tx, project.id);
      const bugType = [...d.types.values()].find((t) => t.name === 'Bug');
      const stdType = [...d.types.values()].find((t) => t.name === 'Task') ?? [...d.types.values()].find((t) => t.id !== bugType?.id)!;
      const workflowId = q.type === 'bug' ? bugType?.workflowId : stdType.workflowId;
      if (!workflowId) throw new AppError(404, 'not_found', 'โปรเจกต์นี้ไม่มี Workflow ของ Bug');
      const columns = d.statusList.filter((st) => st.workflowId === workflowId);
      const columnIds = new Set(columns.map((c) => c.id));

      // บอร์ดมาตรฐาน: การ์ด Bug วางตาม board_column_id · สถานะที่ไม่ได้ผูกคอลัมน์ไปคอลัมน์แรกที่หมวดเดียวกัน
      const columnOf = (st: Status) => {
        if (q.type === 'bug') return st.id;
        const c = st.boardColumnId ?? st.id;
        return columnIds.has(c) ? c : (columns.find((x) => x.category === st.category) ?? columns[0]).id;
      };

      const now = today();
      const hideBefore = Date.now() - HIDE_DONE_AFTER_DAYS * 86_400_000;
      const me = q.assignee === 'me' ? auth.userId : q.assignee;
      const subtaskStats = new Map<string, { total: number; done: number }>();
      for (const i of d.issues) {
        if (!i.parentId) continue;
        const st = subtaskStats.get(i.parentId) ?? { total: 0, done: 0 };
        st.total++;
        if (d.statuses.get(i.statusId)!.category === 'done') st.done++;
        subtaskStats.set(i.parentId, st);
      }
      const comments = await tx
        .select({ issueId: s.comments.issueId, n: sql<number>`count(*)::int` })
        .from(s.comments)
        .innerJoin(s.issues, eq(s.issues.id, s.comments.issueId))
        .where(and(eq(s.issues.projectId, project.id), isNull(s.comments.deletedAt)))
        .groupBy(s.comments.issueId);
      const commentCount = new Map(comments.map((c) => [c.issueId, c.n]));

      const card = (i: Issue, st: Status) => {
        const type = d.types.get(i.issueTypeId)!;
        const mod = d.modules.find((m) => m.id === i.moduleId);
        const phase = d.phases.find((p) => p.id === i.phaseId);
        return {
          key: `${project.key}-${i.number}`,
          type: { name: type.name, color: type.color },
          title: i.title,
          status: { id: st.id, name: st.name, category: st.category },
          module: mod ? { id: mod.id, name: mod.name, color: mod.color } : null,
          phase: phase ? { id: phase.id, name: phase.name } : null,
          parentKey: i.parentId ? `${project.key}-${d.numberOf.get(i.parentId)}` : null,
          sprintId: i.sprintId,
          priority: i.priority,
          planStart: i.planStart,
          planEnd: i.planEnd,
          due: dueState(i.planEnd, st, now),
          assigneeIds: d.assignees.get(i.id) ?? [],
          subtasks: subtaskStats.get(i.id) ?? null,
          comments: commentCount.get(i.id) ?? 0,
          rank: i.rank,
          version: i.version,
        };
      };
      let hiddenDone = 0;
      const wip = new Map<string, number>();
      const cards: (ReturnType<typeof card> & { columnId: string })[] = [];

      for (const i of d.issues) {
        const st = d.statuses.get(i.statusId)!;
        if (q.type === 'bug' && i.issueTypeId !== bugType!.id) continue;
        if (st.category === 'done' && i.completedAt && i.completedAt.getTime() < hideBefore && !q.showOlderDone) {
          hiddenDone++;
          continue;
        }
        const columnId = columnOf(st);
        wip.set(columnId, (wip.get(columnId) ?? 0) + 1);

        if (q.level === 'task' && i.parentId) continue;
        if (q.level === 'subtask' && !i.parentId) continue;
        if (me && !(d.assignees.get(i.id) ?? []).includes(me)) continue;
        if (q.moduleId && i.moduleId !== q.moduleId) continue;
        if (q.sprintId && i.sprintId !== q.sprintId) continue;
        const c = card(i, st);
        if (q.overdue && c.due?.state !== 'overdue') continue;
        cards.push({ ...c, columnId });
      }

      const people = await loadPeople(tx, cards.flatMap((c) => c.assigneeIds));
      return {
        project: { key: project.key, name: project.name },
        board: q.type === 'bug' ? 'bug' : 'standard',
        today: now,
        columns: columns.map((col) => {
          const items = cards.filter((c) => c.columnId === col.id);
          const current = wip.get(col.id) ?? 0;
          return {
            id: col.id,
            name: col.name,
            category: col.category,
            count: items.length,
            wip: { limit: col.wipLimit, current, exceeded: !!col.wipLimit && current > col.wipLimit },
            cards: items.map(({ columnId: _, assigneeIds, ...c }) => ({ ...c, assignees: assigneeIds.map((id) => people.get(id)).filter((p): p is Person => !!p) })),
          };
        }),
        hiddenDone,
        // คำอธิบายใต้บอร์ด: สถานะ Bug → คอลัมน์
        bugStatusColumns:
          q.type === 'bug' || !bugType
            ? []
            : d.statusList.filter((st) => st.workflowId === bugType.workflowId).map((st) => ({ status: st.name, column: columns.find((c) => c.id === columnOf(st))!.name })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 4 · Timeline (Module › กลุ่มงาน › Task › Sub-task + Sprint + Milestone + งานไม่มีวันที่)
  // ---------------------------------------------------------------------------
  async timeline(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof TimelineQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      const d = await loadProjectData(tx, project.id);
      const [sprints, milestones] = await Promise.all([
        tx.select().from(s.sprints).where(eq(s.sprints.projectId, project.id)).orderBy(asc(s.sprints.number)),
        tx.select().from(s.milestones).where(eq(s.milestones.projectId, project.id)).orderBy(asc(s.milestones.date)),
      ]);

      // Guest ที่เป็น Viewer: ไม่เห็น Bug และชื่อคน · เปิดได้เฉพาะงานที่แชร์
      const guest = access.guestViewer;
      const bugTypeIds = new Set([...d.types.values()].filter((t) => t.name === 'Bug').map((t) => t.id));
      const issues = guest ? d.issues.filter((i) => !bugTypeIds.has(i.issueTypeId)) : d.issues;
      const now = today();
      const weighted = project.progressMethod === 'weighted';
      const isDone = (i: Issue) => d.statuses.get(i.statusId)!.category === 'done';
      const scheduled = (i: Issue) => !!i.planStart && !!i.planEnd;

      const subsOf = new Map<string, Issue[]>();
      for (const i of issues) if (i.parentId) subsOf.set(i.parentId, [...(subsOf.get(i.parentId) ?? []), i]);
      const byDate = (a: Issue, b: Issue) => (a.planStart! < b.planStart! ? -1 : a.planStart! > b.planStart! ? 1 : a.number - b.number);

      const people = guest ? new Map<string, Person>() : await loadPeople(tx, [...d.assignees.values()].flat());
      const progressOf = (i: Issue): number => {
        if (isDone(i)) return 100;
        const subs = subsOf.get(i.id);
        if (subs?.length) return rollup(subs.map((x) => ({ md: x.estimateMd, pct: progressOf(x) })), weighted);
        return i.progressPct ?? 0;
      };
      const lateOf = (i: Issue) => (!isDone(i) && i.planEnd && i.planEnd < now ? daysBetween(i.planEnd, now) : 0);
      const row = (i: Issue): TimelineRow => {
        const st = d.statuses.get(i.statusId)!;
        const subs = (subsOf.get(i.id) ?? []).filter(scheduled).sort(byDate);
        return {
          key: `${project.key}-${i.number}`,
          type: d.types.get(i.issueTypeId)!.name,
          title: i.title,
          status: { name: st.name, category: st.category },
          start: i.planStart!,
          end: i.planEnd!,
          actualStart: i.actualStart,
          actualEnd: i.actualEnd,
          estimateMd: i.estimateMd,
          progressPct: progressOf(i),
          lateDays: Math.max(lateOf(i), ...subs.map(lateOf)),
          ...(guest
            ? { canOpen: i.sharedWithGuests }
            : { assignees: (d.assignees.get(i.id) ?? []).map((id) => people.get(id)).filter((p): p is Person => !!p) }),
          subtasks: subs.map(row),
        };
      };
      const inRange = (r: TimelineRow): boolean => ((!q.from || r.end >= q.from) && (!q.to || r.start <= q.to)) || r.subtasks.some(inRange);
      const summarize = (tasks: Issue[]) => {
        if (!tasks.length) return { start: null, end: null, progressPct: 0, lateDays: 0, taskCount: 0 };
        return {
          start: tasks.reduce((m, t) => (t.planStart! < m ? t.planStart! : m), tasks[0].planStart!),
          end: tasks.reduce((m, t) => (t.planEnd! > m ? t.planEnd! : m), tasks[0].planEnd!),
          progressPct: rollup(tasks.map((t) => ({ md: t.estimateMd, pct: progressOf(t) })), weighted),
          lateDays: Math.max(0, ...tasks.flatMap((t) => [lateOf(t), ...(subsOf.get(t.id) ?? []).map(lateOf)])),
          taskCount: tasks.length,
        };
      };

      const tasks = issues.filter((i) => !i.parentId && scheduled(i));
      const moduleList: { id: string | null; name: string; color: string | null }[] = [
        ...d.modules.map((m) => ({ id: m.id, name: m.name, color: m.color })),
        ...(tasks.some((t) => !t.moduleId) ? [{ id: null, name: 'ไม่ระบุ Module', color: null }] : []),
      ];
      const modules = moduleList.map((m) => {
        const mine = tasks.filter((t) => t.moduleId === m.id);
        const phaseList: { id: string | null; name: string }[] = [
          ...d.phases.filter((p) => p.moduleId === m.id).map((p) => ({ id: p.id, name: p.name })),
          ...(mine.some((t) => !t.phaseId) ? [{ id: null, name: 'ไม่ระบุกลุ่มงาน' }] : []),
        ];
        const groups = phaseList
          .map((p) => {
            const list = mine.filter((t) => t.phaseId === p.id).sort(byDate);
            return { phase: p.id ? p : null, name: p.name, ...summarize(list), tasks: list.map(row).filter(inRange) };
          })
          .filter((g) => g.tasks.length);
        return { ...m, ...summarize(mine), groups };
      });

      const unscheduled = issues
        .filter((i) => !scheduled(i))
        .map((i) => ({
          key: `${project.key}-${i.number}`,
          type: d.types.get(i.issueTypeId)!.name,
          title: i.title,
          moduleId: i.moduleId,
          parentKey: i.parentId ? `${project.key}-${d.numberOf.get(i.parentId)}` : null,
          planStart: i.planStart,
          planEnd: i.planEnd,
        }));
      const all = summarize(tasks);

      return {
        project: { key: project.key, name: project.name, startDate: project.startDate, goliveDate: project.goliveDate, progressMethod: project.progressMethod },
        today: now,
        range: { from: q.from ?? all.start ?? project.startDate, to: q.to ?? maxDate(all.end, project.goliveDate) },
        lastEnd: all.end,
        sprints: sprints.map((sp) => ({ id: sp.id, number: sp.number, name: sp.name, startDate: sp.startDate, endDate: sp.endDate, status: sp.status })),
        milestones: milestones
          .filter((ms) => (!q.from || ms.date >= q.from) && (!q.to || ms.date <= q.to))
          .map((ms) => ({ id: ms.id, name: ms.name, date: ms.date, moduleId: ms.moduleId })),
        modules,
        unscheduled,
      };
    });
  }
}

interface TimelineRow {
  key: string;
  type: string;
  title: string;
  status: { name: string; category: string };
  start: string;
  end: string;
  actualStart: string | null;
  actualEnd: string | null;
  estimateMd: number | null;
  progressPct: number;
  lateDays: number;
  assignees?: Person[];
  canOpen?: boolean;
  subtasks: TimelineRow[];
}

/** ความคืบหน้ารวม: ถ่วงด้วย Man-Day (progress_method = weighted) หรือนับจำนวนงาน */
function rollup(items: { md: number | null; pct: number }[], weighted: boolean) {
  if (!items.length) return 0;
  const w = items.map((x) => (weighted ? (x.md ?? 0) : 1));
  const total = w.reduce((a, b) => a + b, 0);
  if (!total) return Math.round(items.reduce((a, x) => a + x.pct, 0) / items.length);
  return Math.round(items.reduce((a, x, i) => a + x.pct * w[i], 0) / total);
}

/** สถานะ Due บนการ์ด: เลยกำหนด / วันนี้ / ภายใน 3 วัน */
function dueState(planEnd: string | null, st: Status, now: string) {
  if (!planEnd || st.category === 'done') return null;
  const days = daysBetween(now, planEnd);
  if (days < 0) return { state: 'overdue' as const, days: -days };
  if (days === 0) return { state: 'today' as const, days: 0 };
  if (planEnd <= addDays(now, 3)) return { state: 'soon' as const, days };
  return null;
}

const maxDate = (a: string | null, b: string) => (a && a > b ? a : b);
