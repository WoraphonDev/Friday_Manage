import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, isNull, lt, lte, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { REASONS } from '../due-requests/due-requests.service.js';
import { addDays } from '../projects/calendar.js';
import { type ProjectAccess, projectAccess } from '../projects/permissions.js';

const s = schema;
const n = s.notifications;

/** ตัวกรองในหน้า G (Inbox) · "ความเคลื่อนไหวของงาน" = เหตุการณ์ที่ไม่อยู่ในหมวดอื่น */
const CATEGORY_EVENTS = {
  assign: ['issue.assigned', 'issue.review_requested', 'member.invited', 'member.joined', 'project.admin_joined'],
  mention: ['issue.mentioned'],
  due: ['issue.due_soon', 'issue.overdue'],
} as const;
const GROUPED = Object.values(CATEGORY_EVENTS).flat();
type Category = keyof typeof CATEGORY_EVENTS | 'activity';
const FILTERS = ['all', 'unread', 'assign', 'mention', 'activity', 'due'] as const;

export const ListNotificationsQuery = z.object({
  /** slug ของ Workspace · ไม่ส่ง = กระดิ่งรวมทุก Workspace (ไม่มีข้อมูลงานล่าสุด ใช้ข้อความ ณ เวลาที่แจ้ง) */
  workspace: z.string().optional(),
  filter: z.enum(FILTERS).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** id ของรายการสุดท้ายในหน้าก่อน (id เป็น UUID v7 เรียงตามเวลา) */
  cursor: z.uuid().optional(),
});

export const SnoozeBody = z.union([
  z.object({ until: z.iso.datetime({ offset: true }) }),
  z.object({ preset: z.enum(['tomorrow']) }),
]);
export const ReadAllBody = z.object({ workspace: z.string().optional() });

function categoryOf(eventType: string): Category {
  for (const [cat, events] of Object.entries(CATEGORY_EVENTS)) if ((events as readonly string[]).includes(eventType)) return cat as Category;
  return 'activity';
}

function filterCond(filter: (typeof FILTERS)[number]): SQL | undefined {
  if (filter === 'all') return undefined;
  if (filter === 'unread') return isNull(n.readAt);
  if (filter === 'activity') return notInArray(n.eventType, GROUPED);
  return inArray(n.eventType, [...CATEGORY_EVENTS[filter]]);
}

/** ยังไม่ทำเสร็จ และไม่อยู่ในช่วงเลื่อนเตือน */
const active = () => [isNull(n.doneAt), or(isNull(n.snoozedUntil), lte(n.snoozedUntil, sql`now()`))!];

@Injectable()
export class NotificationsService {
  constructor(private readonly db: TenantDb) {}

  // ---------------------------------------------------------------------------
  // G · Inbox
  // ---------------------------------------------------------------------------
  async list(auth: AuthInfo, q: z.infer<typeof ListNotificationsQuery>) {
    const tenant = q.workspace ? await this.db.tenant(auth, q.workspace) : null;
    return this.db.run(auth, tenant, async (tx) => {
      const scope = [...active(), ...(tenant ? [eq(n.workspaceId, tenant.workspaceId)] : [])];
      const where = [...scope];
      const f = filterCond(q.filter);
      if (f) where.push(f);
      if (q.cursor) where.push(lt(n.id, q.cursor));
      const rows = await tx
        .select()
        .from(n)
        .where(and(...where))
        .orderBy(desc(n.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);

      // จำนวนในแต่ละตัวกรอง (ชิปด้านบนของ Inbox)
      const byType = await tx
        .select({ eventType: n.eventType, total: sql<number>`count(*)::int`, unread: sql<number>`(count(*) filter (where ${n.readAt} is null))::int` })
        .from(n)
        .where(and(...scope))
        .groupBy(n.eventType);
      const counts = { all: 0, unread: 0, assign: 0, mention: 0, activity: 0, due: 0 };
      for (const r of byType) {
        counts.all += r.total;
        counts.unread += r.unread;
        counts[categoryOf(r.eventType)] += r.total;
      }

      const items = tenant ? await this.enrich(tx, auth, tenant, page) : page.map((r) => this.dto(r));
      return { items, counts, nextCursor: rows.length > q.limit ? page[page.length - 1].id : null };
    });
  }

  /** K4 · จำนวนยังไม่อ่านแยก Workspace (กระดิ่ง, เมนูสลับ Workspace) */
  async summary(auth: AuthInfo) {
    return this.db.run(auth, null, async (tx) => {
      const rows = await tx
        .select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name, unread: sql<number>`count(*)::int` })
        .from(n)
        .innerJoin(s.workspaces, eq(s.workspaces.id, n.workspaceId))
        .where(and(...active(), isNull(n.readAt)))
        .groupBy(s.workspaces.id, s.workspaces.slug, s.workspaces.name)
        .orderBy(asc(s.workspaces.name));
      return { total: rows.reduce((a, r) => a + r.unread, 0), workspaces: rows };
    });
  }

  // ---------------------------------------------------------------------------
  // การกระทำกับรายการ (เฉพาะของตัวเอง · RLS own_notifications)
  // ---------------------------------------------------------------------------
  async mark(auth: AuthInfo, id: string, action: 'read' | 'unread' | 'done' | 'undone') {
    const set =
      action === 'read' ? { readAt: sql`coalesce(${n.readAt}, now())` }
      : action === 'unread' ? { readAt: null }
      : action === 'done' ? { doneAt: new Date(), readAt: sql`coalesce(${n.readAt}, now())` }
      : { doneAt: null };
    return this.update(auth, id, set);
  }

  /** "เตือนฉันพรุ่งนี้" = 09:00 ของวันพรุ่งนี้ตามเวลาไทย */
  async snooze(auth: AuthInfo, id: string, body: z.infer<typeof SnoozeBody>) {
    const until = 'until' in body ? new Date(body.until) : new Date(`${addDays(today(), 1)}T09:00:00+07:00`);
    if (until.getTime() <= Date.now()) throw new AppError(400, 'invalid_snooze', 'เวลาที่เลื่อนต้องอยู่ในอนาคต');
    return this.update(auth, id, { snoozedUntil: until, readAt: sql`coalesce(${n.readAt}, now())` });
  }

  async readAll(auth: AuthInfo, body: z.infer<typeof ReadAllBody>) {
    const tenant = body.workspace ? await this.db.tenant(auth, body.workspace) : null;
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx
        .update(n)
        .set({ readAt: new Date() })
        .where(and(isNull(n.readAt), ...(tenant ? [eq(n.workspaceId, tenant.workspaceId)] : [])))
        .returning({ id: n.id });
      return { updated: rows.length };
    });
  }

  private async update(auth: AuthInfo, id: string, set: Record<string, unknown>) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบการแจ้งเตือน');
    const [row] = await this.db.run(auth, null, (tx) => tx.update(n).set(set).where(eq(n.id, id)).returning());
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบการแจ้งเตือน');
    return this.dto(row);
  }

  // ---------------------------------------------------------------------------
  // รูปแบบรายการ
  // ---------------------------------------------------------------------------
  private dto(r: typeof n.$inferSelect) {
    const p = r.payload as Record<string, unknown>;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      eventType: r.eventType,
      category: categoryOf(r.eventType),
      actor: r.actorId ? { id: r.actorId, displayName: (p.actorName as string | undefined) ?? null } : null,
      project: p.projectKey ? { key: p.projectKey as string, name: (p.projectName as string | undefined) ?? null } : null,
      payload: p,
      reason: r.reason,
      readAt: r.readAt,
      snoozedUntil: r.snoozedUntil,
      createdAt: r.createdAt,
    };
  }

  /** เติมข้อมูลล่าสุดของงานและคำขอเลื่อน Due (ผ่าน RLS ของ Workspace นั้น) ให้แผงรายละเอียดด้านขวา */
  private async enrich(tx: Tx, auth: AuthInfo, tenant: TenantInfo, rows: (typeof n.$inferSelect)[]) {
    const issueIds = [...new Set(rows.map((r) => r.issueId).filter((x): x is string => !!x))];
    const issues = issueIds.length
      ? await tx
          .select({ issue: s.issues, project: s.projects, type: s.issueTypes.name, statusName: s.workflowStatuses.name, statusCategory: s.workflowStatuses.category, moduleName: s.modules.name })
          .from(s.issues)
          .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
          .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
          .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
          .leftJoin(s.modules, eq(s.modules.id, s.issues.moduleId))
          .where(inArray(s.issues.id, issueIds))
      : [];
    const access = new Map<string, ProjectAccess>();
    for (const i of issues) if (!access.has(i.project.id)) access.set(i.project.id, await projectAccess(tx, auth, tenant, i.project));
    const visible = issues.filter((i) => {
      const a = access.get(i.project.id)!;
      return a.role && (!a.guestViewer || i.issue.sharedWithGuests);
    });

    const assignees = visible.length
      ? await tx
          .select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
          .from(s.issueAssignees)
          .where(inArray(s.issueAssignees.issueId, visible.map((i) => i.issue.id)))
          .orderBy(asc(s.issueAssignees.sort))
      : [];

    const requestIds = rows.map((r) => (r.payload as { requestId?: string }).requestId).filter((x): x is string => !!x);
    const requests = requestIds.length ? await tx.select().from(s.dueChangeRequests).where(inArray(s.dueChangeRequests.id, requestIds)) : [];
    const people = await loadPeople(tx, [...rows.map((r) => r.actorId), ...assignees.map((a) => a.userId), ...requests.map((r) => r.decidedBy)]);

    return rows.map((r) => {
      const base = this.dto(r);
      const i = visible.find((x) => x.issue.id === r.issueId);
      const a = i ? access.get(i.project.id)! : null;
      const req = requests.find((x) => x.id === (r.payload as { requestId?: string }).requestId);
      return {
        ...base,
        actor: r.actorId ? (people.get(r.actorId) ?? base.actor) : null,
        issue: i
          ? {
              key: `${i.project.key}-${i.issue.number}`,
              title: i.issue.title,
              type: i.type,
              status: { name: i.statusName, category: i.statusCategory },
              moduleName: i.moduleName,
              planEnd: i.issue.planEnd,
              deleted: !!i.issue.deletedAt,
              assignees: a!.guestViewer ? [] : assignees.filter((x) => x.issueId === i.issue.id).map((x) => people.get(x.userId)).filter(Boolean),
            }
          : null,
        dueRequest: req
          ? {
              id: req.id,
              status: req.status,
              currentDue: req.currentDue,
              requestedDue: req.requestedDue,
              reasonCode: req.reasonCode,
              reasonLabel: REASONS[req.reasonCode],
              detail: req.detail,
              decidedBy: req.decidedBy ? (people.get(req.decidedBy) ?? null) : null,
              decidedAt: req.decidedAt,
              decisionNote: req.decisionNote,
              canDecide: req.status === 'pending' && req.requesterId !== auth.userId && !!a?.perms.has('due_request.approve'),
            }
          : null,
      };
    });
  }
}
