import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { apiPublicUrl, webUrl } from '../auth/auth.config.js';
import { today } from '../common/dates.js';
import { AppError, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { weekOf } from '../overview/workload.js';
import { addDays } from '../projects/calendar.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService } from '../projects/projects.service.js';
import { buildIcs, type IcsEvent } from './ical.js';
import { dueOf, loadDueRule, qaDueOf } from '../projects/due-stage.js';

const s = schema;

export const MonthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month ต้องเป็น YYYY-MM').optional() });
export const CreateFeedBody = z.object({
  /** slug ของ Workspace (เส้นทาง me/... ไม่มี Workspace ใน URL) */
  workspace: z.string().trim().min(1).max(63),
  /** ไม่ส่ง = งานของฉันทุกโปรเจกต์ใน Workspace นี้ */
  projectKey: z.string().trim().min(1).max(20).optional(),
});
export const FeedQuery = z.object({ workspace: z.string().trim().min(1).max(63) });

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const lastOfMonth = (month: string) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

/** หน้า 6 · Calendar และลิงก์ iCal ส่วนตัว (Subscribe) */
@Injectable()
export class CalendarService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  // ---------------------------------------------------------------------------
  // GET p/calendar?month=YYYY-MM
  // ---------------------------------------------------------------------------
  async month(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof MonthQuery>) {
    const now = today();
    const month = q.month ?? now.slice(0, 7);
    const first = `${month}-01`;
    const last = lastOfMonth(month);
    // ช่องของเดือนรวมวันของสัปดาห์ที่คาบเกี่ยว (จันทร์–อาทิตย์)
    const range = { from: weekOf(first).start, to: weekOf(last).end };

    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.view');
      // Guest Viewer เห็นเฉพาะ Overview และ Timeline (03-api 3.5, 04-permissions ข้อ 4) · จึงไม่มีวันลา / ชื่อคนให้รั่ว · Guest Member เห็นเหมือน Member
      if (access.guestViewer) {
        throw new AppError(403, 'guest_view_limited', 'Guest เห็นเฉพาะ Overview, Timeline และงานที่แชร์ให้', { allowed: ['overview', 'timeline'] });
      }

      const rows = await tx
        .select({ i: s.issues, status: s.workflowStatuses, type: s.issueTypes.name })
        .from(s.issues)
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
        .where(
          and(
            eq(s.issues.projectId, project.id),
            isNull(s.issues.deletedAt),
            // ช่วงวันของงาน = Plan Start–End (ไม่มี Start ใช้ Due วันเดียว)
            or(and(lte(s.issues.planStart, range.to), gte(s.issues.planEnd, range.from)), and(isNull(s.issues.planStart), gte(s.issues.planEnd, range.from), lte(s.issues.planEnd, range.to)), and(isNull(s.issues.planEnd), gte(s.issues.planStart, range.from), lte(s.issues.planStart, range.to))),
          ),
        )
        .orderBy(asc(s.issues.planEnd), asc(s.issues.number))
        .limit(2000);
      const assignees = rows.length
        ? await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, rows.map((r) => r.i.id))).orderBy(asc(s.issueAssignees.sort))
        : [];
      const byIssue = new Map<string, string[]>();
      for (const a of assignees) byIssue.set(a.issueId, [...(byIssue.get(a.issueId) ?? []), a.userId]);
      const numberOf = new Map(rows.map((r) => [r.i.id, r.i.number]));

      const sprints = await tx
        .select()
        .from(s.sprints)
        .where(and(eq(s.sprints.projectId, project.id), lte(s.sprints.startDate, range.to), gte(s.sprints.endDate, range.from)))
        .orderBy(asc(s.sprints.number));
      const milestones = await tx.select().from(s.milestones).where(and(eq(s.milestones.projectId, project.id), gte(s.milestones.date, range.from), lte(s.milestones.date, range.to))).orderBy(asc(s.milestones.date));

      // วันหยุด: ปฏิทินของโปรเจกต์ (ถ้าไม่ตั้ง ใช้ของ Workspace) + วันหยุดเฉพาะโปรเจกต์
      const [ws] = await tx.select({ calendarId: s.workspaceSettings.holidayCalendarId }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
      const calendarId = project.holidayCalendarId ?? ws?.calendarId;
      const shared = calendarId ? await tx.select({ date: s.holidays.date, name: s.holidays.name }).from(s.holidays).where(and(eq(s.holidays.calendarId, calendarId), gte(s.holidays.date, range.from), lte(s.holidays.date, range.to))) : [];
      const own = await tx.select({ date: s.projectHolidays.date, name: s.projectHolidays.name }).from(s.projectHolidays).where(and(eq(s.projectHolidays.projectId, project.id), gte(s.projectHolidays.date, range.from), lte(s.projectHolidays.date, range.to)));
      const holidays = [...shared.map((h) => ({ ...h, scope: 'workspace' as const })), ...own.map((h) => ({ ...h, scope: 'project' as const }))].sort((a, b) => a.date.localeCompare(b.date));

      // วันลาของสมาชิกโปรเจกต์ (รวม Owner) ที่ทับช่วง · รออนุมัติและอนุมัติแล้ว
      const memberRows = await tx.select({ userId: s.projectMembers.userId }).from(s.projectMembers).where(eq(s.projectMembers.projectId, project.id));
      const memberIds = [...new Set([project.ownerUserId, ...memberRows.map((m) => m.userId)])];
      const leaveRows = await tx
        .select()
        .from(s.leaves)
        .where(and(inArray(s.leaves.userId, memberIds), lte(s.leaves.startDate, range.to), gte(s.leaves.endDate, range.from)))
        .orderBy(asc(s.leaves.startDate));
      const people = await loadPeople(tx, [...assignees.map((a) => a.userId), ...leaveRows.map((l) => l.userId)]);
      // โปรเจกต์แยก Dev / QA: งานที่รอ QA เลยกำหนดตาม QA Due (projects/due-stage.ts)
      const dueRule = await loadDueRule(tx, project);
      const dueState = (i: typeof s.issues.$inferSelect, category: string) => {
        if (category === 'done' || category === 'cancelled') return 'done' as const;
        const d = dueOf(dueRule, i, category).date;
        return d && d < now ? ('overdue' as const) : d === now ? ('today' as const) : ('upcoming' as const);
      };

      return {
        project: { key: project.key, name: project.name },
        today: now,
        month,
        range,
        issues: rows.map(({ i, status, type }) => ({
          key: `${project.key}-${i.number}`,
          type,
          title: i.title,
          status: { name: status.name, category: status.category },
          priority: i.priority,
          planStart: i.planStart,
          planEnd: i.planEnd,
          // ปิดงานแล้ว (เสร็จ / ยกเลิก) ไม่มีสถานะเลยกำหนด
          due: dueState(i, status.category),
          ...(dueRule.split ? { qaDue: qaDueOf(dueRule, i) } : {}),
          parentKey: i.parentId && numberOf.has(i.parentId) ? `${project.key}-${numberOf.get(i.parentId)}` : null,
          assignees: (byIssue.get(i.id) ?? []).map((u) => people.get(u)).filter((p) => !!p),
          version: i.version,
        })),
        sprints: sprints.map((sp) => ({ id: sp.id, number: sp.number, name: sp.name, startDate: sp.startDate, endDate: sp.endDate, status: sp.status })),
        milestones: milestones.map((m) => ({ id: m.id, name: m.name, date: m.date })),
        holidays,
        leaves: leaveRows.map((l) => ({ person: people.get(l.userId) ?? null, leaveType: l.leaveType, startDate: l.startDate, endDate: l.endDate, halfDay: l.halfDay, status: l.status })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // me/calendar-feeds
  // ---------------------------------------------------------------------------
  /** Workspace ที่ฉันเป็นสมาชิกที่ active (ไม่ใช่สมาชิก = 404 เหมือนที่อื่น) */
  private async workspaceOf(auth: AuthInfo, slug: string) {
    const tenant = await this.db.tenant(auth, slug);
    return tenant;
  }

  async createFeed(auth: AuthInfo, body: z.infer<typeof CreateFeedBody>) {
    const tenant = await this.workspaceOf(auth, body.workspace);
    // token แสดงครั้งเดียว · ในฐานข้อมูลเก็บแค่ hash เหมือนรหัสผ่าน
    const token = randomBytes(32).toString('base64url');
    const feed = await this.db.run(auth, tenant, async (tx) => {
      let projectId: string | null = null;
      if (body.projectKey) {
        const { project, access } = await this.projects.load(tx, auth, tenant, body.projectKey);
        requirePerm(access, 'project.view');
        projectId = project.id;
      }
      const [row] = await tx.insert(s.calendarFeedTokens).values({ workspaceId: tenant.workspaceId, userId: auth.userId, projectId, tokenHash: hash(token) }).returning();
      return { row, projectKey: body.projectKey?.toUpperCase() ?? null };
    });
    return { id: feed.row.id, workspace: tenant.slug, projectKey: feed.projectKey, createdAt: feed.row.createdAt, url: `${apiPublicUrl()}/api/v1/ical/${token}.ics` };
  }

  async listFeeds(auth: AuthInfo, q: z.infer<typeof FeedQuery>) {
    const tenant = await this.workspaceOf(auth, q.workspace);
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx
        .select({ f: s.calendarFeedTokens, projectKey: s.projects.key })
        .from(s.calendarFeedTokens)
        .leftJoin(s.projects, eq(s.projects.id, s.calendarFeedTokens.projectId))
        .where(and(eq(s.calendarFeedTokens.userId, auth.userId), eq(s.calendarFeedTokens.workspaceId, tenant.workspaceId), isNull(s.calendarFeedTokens.revokedAt)))
        .orderBy(desc(s.calendarFeedTokens.createdAt));
      // URL ที่มี token ดูซ้ำไม่ได้ (เก็บเฉพาะ hash) · ถ้าทำหายให้สร้างใหม่แล้วลบอันเก่า
      return { items: rows.map(({ f, projectKey }) => ({ id: f.id, projectKey, createdAt: f.createdAt })) };
    });
  }

  async deleteFeed(auth: AuthInfo, id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw notFound('ลิงก์ปฏิทิน');
    // ลิงก์ของคนอื่นหาไม่เจอด้วย RLS ไม่พอ (workspace) จึงกรอง user เองด้วย
    const [row] = await this.system
      .update(s.calendarFeedTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.calendarFeedTokens.id, id), eq(s.calendarFeedTokens.userId, auth.userId), isNull(s.calendarFeedTokens.revokedAt)))
      .returning({ id: s.calendarFeedTokens.id });
    if (!row) throw notFound('ลิงก์ปฏิทิน');
    return { revoked: true };
  }

  // ---------------------------------------------------------------------------
  // GET ical/{token}.ics (สาธารณะ)
  // ---------------------------------------------------------------------------
  /**
   * หา token ด้วย SYSTEM_DB เพราะคนเรียกไม่ได้ล็อกอินและยังไม่รู้ Workspace
   * จากนั้นอ่านงานผ่าน RLS ในฐานะเจ้าของลิงก์ จึงเห็นเท่าที่เขาเห็นได้ ณ ตอนนี้ (ออกจากโปรเจกต์แล้ว งานหาย)
   */
  async ics(file: string): Promise<string> {
    const token = file.replace(/\.ics$/i, '');
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw notFound('ลิงก์ปฏิทิน');
    const [feed] = await this.system
      .select({ f: s.calendarFeedTokens, slug: s.workspaces.slug, wsName: s.workspaces.name, role: s.workspaceMembers.role })
      .from(s.calendarFeedTokens)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.calendarFeedTokens.workspaceId))
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.calendarFeedTokens.workspaceId), eq(s.workspaceMembers.userId, s.calendarFeedTokens.userId), eq(s.workspaceMembers.status, 'active')))
      .where(and(eq(s.calendarFeedTokens.tokenHash, hash(token)), isNull(s.calendarFeedTokens.revokedAt), isNull(s.workspaces.deletedAt)));
    if (!feed) throw notFound('ลิงก์ปฏิทิน');

    const auth: AuthInfo = { userId: feed.f.userId, sessionId: 'ical' };
    const tenant: TenantInfo = { workspaceId: feed.f.workspaceId, slug: feed.slug, role: feed.role };
    const events = await this.db.run(auth, tenant, async (tx) => {
      const mine = await tx.select({ issueId: s.issueAssignees.issueId }).from(s.issueAssignees).where(eq(s.issueAssignees.userId, auth.userId));
      if (!mine.length) return [] as IcsEvent[];
      const rows = await tx
        .select({ i: s.issues, key: s.projects.key, projectName: s.projects.name, done: s.workflowStatuses.category, type: s.issueTypes.name })
        .from(s.issues)
        .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
        .where(
          and(
            inArray(s.issues.id, mine.map((m) => m.issueId)),
            isNull(s.issues.deletedAt),
            isNull(s.projects.deletedAt),
            isNull(s.projects.archivedAt),
            feed.f.projectId ? eq(s.issues.projectId, feed.f.projectId) : undefined,
            or(and(gte(s.issues.planEnd, '2000-01-01')), gte(s.issues.planStart, '2000-01-01')),
          ),
        )
        .orderBy(asc(s.issues.planEnd), asc(s.issues.number));
      const guest = feed.role === 'guest';
      const out: IcsEvent[] = [];
      for (const r of rows) {
        // งานที่เสร็จแล้วไม่ต้องเตือน · Guest เห็นเฉพาะงานที่แชร์และไม่ใช่ Bug
        if (r.done === 'done' || r.done === 'cancelled') continue;
        if (guest && (!r.i.sharedWithGuests || r.type === 'Bug')) continue;
        const k = `${r.key}-${r.i.number}`;
        const end = r.i.planEnd ?? r.i.planStart!;
        const start = r.i.planStart && r.i.planStart <= end ? r.i.planStart : end;
        out.push({
          uid: `${r.i.id}@friday-manage`,
          start,
          end,
          summary: `[${k}] ${r.i.title}`,
          description: `${r.projectName} · ครบกำหนด ${end}\n${webUrl()}/work/${feed.slug}/p/${r.key}/table?issue=${k}`,
          url: `${webUrl()}/work/${feed.slug}/p/${r.key}/table?issue=${k}`,
          category: r.projectName,
        });
      }
      return out;
    });
    const scope = feed.f.projectId ? events[0]?.category : null;
    return buildIcs(`Friday Manage · ${feed.wsName}${scope ? ` · ${scope}` : ''}`, events);
  }
}
