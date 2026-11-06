import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { today } from '../common/dates.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import { Audience, type IssueCtx, type ProjectCtx } from './audience.js';
import { Notifier } from './notifier.js';
import { REASONS } from './rules.js';

const s = schema;
type DueReminder = '1d_and_today' | '3d' | 'today_only';
type Digest = 'workdays' | 'daily' | 'off';
/** Workspace ไม่มีโปรเจกต์ให้ WorkCalendar อ่านวันหยุดเฉพาะโปรเจกต์ · ใช้ id ว่างแทน */
const NO_PROJECT = '00000000-0000-0000-0000-000000000000';
const MAX_SUMMARY_ITEMS = 20;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function workingDayBefore(cal: WorkCalendar, date: string, n: number) {
  let d = date;
  for (let found = 0, guard = 0; found < n && guard < 400; guard++) {
    d = addDays(d, -1);
    if (cal.isWorkingDay(d)) found++;
  }
  return d;
}

/** ควรเตือน "ใกล้ครบกำหนด" วันนี้ไหม (I · Profile › แจ้งเตือนก่อนครบกำหนด) · นับวันทำการตามปฏิทินโปรเจกต์ */
export function dueSoonToday(setting: DueReminder, planEnd: string, date: string, cal: WorkCalendar) {
  if (planEnd === date) return setting !== '3d';
  if (setting === '1d_and_today') return workingDayBefore(cal, planEnd, 1) === date;
  if (setting === '3d') return workingDayBefore(cal, planEnd, 3) === date;
  return false;
}

interface OpenIssue {
  issue: IssueCtx;
  project: ProjectCtx & { holidayCalendarId: string | null };
  planEnd: string;
  statusName: string;
}

/**
 * งานตามเวลาของแจ้งเตือน (A16 เรียกตาม SCHEDULES ใน rules.ts) · ทุกงานรันซ้ำได้: ใช้ dedupeKey ของ Notifier
 * ใช้ friday_system เพราะรันนอกคำขอของผู้ใช้และครอบคลุมทุก Workspace · ตรวจสิทธิ์ผู้รับด้วย Audience.visible
 */
@Injectable()
export class Reminders {
  private readonly audience: Audience;

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly notifier: Notifier,
  ) {
    this.audience = new Audience(db);
  }

  /** 08:00 · ใกล้ครบกำหนดตาม due_reminder ของแต่ละคน และแจ้ง Assignee ครั้งแรกที่งานเลยกำหนด */
  async dueReminders(date = today()) {
    const open = await this.openIssues(addDays(date, 21));
    const assignees = await this.audience.assignees(open.map((o) => o.issue.id));
    const users = [...new Set([...assignees.values()].flat())];
    const settings = await this.settings(users);
    const calendars = await this.calendars(open.map((o) => o.project));
    let sent = 0;
    for (const o of open) {
      const people = assignees.get(o.issue.id) ?? [];
      if (!people.length) continue;
      if (o.planEnd < date) {
        sent += await this.send(o, people, 'issue.overdue', REASONS.overdue, `overdue:${o.issue.id}:${o.planEnd}`, { planEnd: o.planEnd, daysLate: daysBetween(o.planEnd, date) });
        continue;
      }
      const cal = calendars.get(o.project.id)!;
      const due = people.filter((u) => dueSoonToday(settings.get(`${o.project.workspaceId}:${u}`)?.dueReminder ?? '1d_and_today', o.planEnd, date, cal));
      sent += await this.send(o, due, 'issue.due_soon', REASONS.dueSoon, `due_soon:${o.issue.id}:${o.planEnd}:${date}`, { planEnd: o.planEnd, daysLeft: daysBetween(date, o.planEnd) });
    }
    return { date, sent };
  }

  /** 09:30 วันทำการ · สรุปงานเลยกำหนดของแต่ละโปรเจกต์ให้ PM (Project Owner) 1 รายการ */
  async overdueSummary(date = today()) {
    const open = (await this.openIssues(addDays(date, -1))).filter((o) => o.planEnd < date);
    const byProject = new Map<string, OpenIssue[]>();
    for (const o of open) byProject.set(o.project.id, [...(byProject.get(o.project.id) ?? []), o]);
    const calendars = await this.calendars([...byProject.values()].map((list) => list[0].project));
    const assignees = await this.audience.assignees(open.map((o) => o.issue.id));
    const names = await this.audience.names([...new Set([...assignees.values()].flat())]);
    let sent = 0;
    for (const list of byProject.values()) {
      const project = list[0].project;
      if (!calendars.get(project.id)!.isWorkingDay(date)) continue;
      const visible = await this.audience.visible([project.ownerUserId], project);
      if (!visible.size) continue;
      list.sort((a, b) => a.planEnd.localeCompare(b.planEnd) || a.issue.key.localeCompare(b.issue.key));
      await this.notifier.notify({
        workspaceId: project.workspaceId,
        recipientIds: [...visible],
        eventType: 'issue.overdue',
        actorId: null,
        projectId: project.id,
        payload: {
          projectKey: project.key,
          projectName: project.name,
          summary: true,
          date,
          count: list.length,
          issues: list.slice(0, MAX_SUMMARY_ITEMS).map((o) => ({
            issueKey: o.issue.key,
            title: o.issue.title,
            planEnd: o.planEnd,
            daysLate: daysBetween(o.planEnd, date),
            assignees: (assignees.get(o.issue.id) ?? []).map((id) => names.get(id) ?? null),
          })),
        },
        reason: REASONS.overdueSummary,
        dedupeKey: `overdue_summary:${project.id}:${date}`,
      });
      sent++;
    }
    return { date, sent };
  }

  /**
   * 08:30 · Daily digest (งานวันนี้ + เลยกำหนด + รอ Review) ตาม digest ใน Profile
   * Canvas I ปิด In-app ของ digest เป็นค่าเริ่มต้น จึงส่งเข้า Inbox เฉพาะคนที่เปิดเอง · Email / LINE เป็นของ A24 / A25
   */
  async digest(date = today()) {
    const optedIn = await this.audience.inAppEnabled('digest.daily');
    if (!optedIn.length) return { date, sent: 0 };
    const settings = await this.settings(optedIn.map((o) => o.userId));
    const open = await this.openIssues(date);
    const assignees = await this.audience.assignees(open.map((o) => o.issue.id));
    const workspaceCalendars = new Map<string, WorkCalendar>();
    let sent = 0;
    for (const { workspaceId, userId } of optedIn) {
      const mode: Digest = settings.get(`${workspaceId}:${userId}`)?.digest ?? 'workdays';
      if (mode === 'off') continue;
      if (mode === 'workdays') {
        if (!workspaceCalendars.has(workspaceId))
          workspaceCalendars.set(workspaceId, await this.db.transaction((tx) => WorkCalendar.load(tx, { id: NO_PROJECT, workspaceId, holidayCalendarId: null }, addDays(date, -1))));
        if (!workspaceCalendars.get(workspaceId)!.isWorkingDay(date)) continue;
      }
      const mine = open.filter((o) => o.project.workspaceId === workspaceId);
      const visible = new Set<string>();
      for (const o of mine) if ((await this.audience.visible([userId], o.project, o.issue)).size) visible.add(o.issue.id);
      const item = (o: OpenIssue) => ({ issueKey: o.issue.key, title: o.issue.title, planEnd: o.planEnd, projectKey: o.project.key });
      const assigned = mine.filter((o) => visible.has(o.issue.id) && (assignees.get(o.issue.id) ?? []).includes(userId));
      const dueToday = assigned.filter((o) => o.planEnd === date).map(item);
      const overdue = assigned.filter((o) => o.planEnd < date).map(item);
      const review = mine.filter((o) => visible.has(o.issue.id) && o.issue.reviewerId === userId && o.statusName.trim().toLowerCase() === 'review').map(item);
      if (!dueToday.length && !overdue.length && !review.length) continue;
      await this.notifier.notify({
        workspaceId,
        recipientIds: [userId],
        eventType: 'digest.daily',
        actorId: null,
        payload: { date, dueToday, overdue: overdue.slice(0, MAX_SUMMARY_ITEMS), overdueCount: overdue.length, review },
        reason: REASONS.digest,
        dedupeKey: `digest:${date}`,
      });
      sent++;
    }
    return { date, sent };
  }

  private async send(o: OpenIssue, userIds: string[], eventType: string, reason: string, dedupeKey: string, extra: Record<string, unknown>) {
    if (!userIds.length) return 0;
    const visible = await this.audience.visible(userIds, o.project, o.issue);
    const muted = eventType === 'issue.overdue' ? new Set<string>() : await this.audience.inAppDisabled(o.project.workspaceId, [...visible], eventType);
    const recipients = [...visible].filter((id) => !muted.has(id));
    if (!recipients.length) return 0;
    await this.notifier.notify({
      workspaceId: o.project.workspaceId,
      recipientIds: recipients,
      eventType,
      actorId: null,
      projectId: o.project.id,
      issueId: o.issue.id,
      payload: { projectKey: o.project.key, projectName: o.project.name, issueKey: o.issue.key, issueTitle: o.issue.title, ...extra },
      reason,
      dedupeKey,
    });
    return recipients.length;
  }

  /** งานที่ยังไม่เสร็จและมี Plan End ไม่เกิน until · ไม่รวมโปรเจกต์ที่เก็บถาวรหรือถูกลบ */
  private async openIssues(until: string): Promise<OpenIssue[]> {
    const rows = await this.db
      .select({
        id: s.issues.id,
        number: s.issues.number,
        title: s.issues.title,
        planEnd: s.issues.planEnd,
        parentId: s.issues.parentId,
        reviewerId: s.issues.reviewerId,
        baId: s.issues.baId,
        sharedWithGuests: s.issues.sharedWithGuests,
        type: s.issueTypes.name,
        statusName: s.workflowStatuses.name,
        projectId: s.projects.id,
        workspaceId: s.projects.workspaceId,
        key: s.projects.key,
        name: s.projects.name,
        ownerUserId: s.projects.ownerUserId,
        visibility: s.projects.visibility,
        holidayCalendarId: s.projects.holidayCalendarId,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.issues.workspaceId))
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
      .where(
        and(
          isNull(s.issues.deletedAt),
          isNull(s.projects.deletedAt),
          isNull(s.projects.archivedAt),
          isNull(s.workspaces.deletedAt),
          ne(s.workflowStatuses.category, 'done'),
          isNotNull(s.issues.planEnd),
          lte(s.issues.planEnd, until),
        ),
      );
    return rows.map((r) => ({
      planEnd: r.planEnd!,
      statusName: r.statusName,
      issue: {
        id: r.id,
        key: `${r.key}-${r.number}`,
        title: r.title,
        parentId: r.parentId,
        reviewerId: r.reviewerId,
        baId: r.baId,
        sharedWithGuests: r.sharedWithGuests,
        isBug: r.type === 'Bug',
        deleted: false,
      },
      project: {
        id: r.projectId,
        workspaceId: r.workspaceId,
        key: r.key,
        name: r.name,
        ownerUserId: r.ownerUserId,
        visibility: r.visibility,
        holidayCalendarId: r.holidayCalendarId,
        deleted: false,
      },
    }));
  }

  private async settings(userIds: string[]) {
    const out = new Map<string, { dueReminder: DueReminder; digest: Digest }>();
    if (!userIds.length) return out;
    const t = s.userNotificationSettings;
    const rows = await this.db
      .select({ workspaceId: t.workspaceId, userId: t.userId, dueReminder: t.dueReminder, digest: t.digest })
      .from(t)
      .where(inArray(t.userId, [...new Set(userIds)]));
    rows.forEach((r) => out.set(`${r.workspaceId}:${r.userId}`, { dueReminder: r.dueReminder, digest: r.digest }));
    return out;
  }

  private async calendars(projects: (ProjectCtx & { holidayCalendarId: string | null })[]) {
    const out = new Map<string, WorkCalendar>();
    const unique = [...new Map(projects.map((p) => [p.id, p])).values()];
    if (!unique.length) return out;
    await this.db.transaction(async (tx) => {
      for (const p of unique) out.set(p.id, await WorkCalendar.load(tx, { id: p.id, workspaceId: p.workspaceId, holidayCalendarId: p.holidayCalendarId }, addDays(today(), -400)));
    });
    return out;
  }
}
