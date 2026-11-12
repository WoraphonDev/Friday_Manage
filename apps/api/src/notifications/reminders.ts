import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, isNotNull, isNull, lte, type SQL, sql } from 'drizzle-orm';
import { today } from '../common/dates.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import { dueOf, loadDueRules, PLAIN_DUE } from '../projects/due-stage.js';
import { Audience, type IssueCtx, type ProjectCtx } from './audience.js';
import { Notifier } from './notifier.js';
import { DAILY_EVENT, REASONS } from './rules.js';
import { openStatus } from '../common/status-category.js';

const s = schema;
export type DueReminder = '1d_and_today' | '3d' | 'today_only';
type Digest = 'workdays' | 'daily' | 'off';
/** Workspace ไม่มีโปรเจกต์ให้ WorkCalendar อ่านวันหยุดเฉพาะโปรเจกต์ · ใช้ id ว่างแทน */
const NO_PROJECT = '00000000-0000-0000-0000-000000000000';
/** รายการสูงสุดต่อหัวข้อ · ที่เหลือบอกเป็นจำนวน (…Count) */
export const MAX_SUMMARY_ITEMS = 20;
/** มองหางานใกล้ครบกำหนดล่วงหน้าไม่เกินนี้ (3 วันทำการ + วันหยุดยาว) */
const LOOKAHEAD_DAYS = 21;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * งานนี้อยู่ในหัวข้อ "ใกล้ครบกำหนด" ของสรุปวันนี้ไหม (Profile › แจ้งเตือนก่อนครบกำหนด) · นับวันทำการตามปฏิทินโปรเจกต์
 * `1d_and_today` = ครบกำหนดภายในวันทำการถัดไป · `3d` = ภายใน 3 วันทำการ · `today_only` = ไม่มีหัวข้อนี้ (เห็นเฉพาะวันครบกำหนด)
 */
export function dueSoonInSummary(setting: DueReminder, planEnd: string, date: string, cal: WorkCalendar) {
  if (planEnd <= date || setting === 'today_only') return false;
  return cal.workingDaysIn(addDays(date, 1), planEnd) <= (setting === '3d' ? 3 : 1);
}

interface OpenIssue {
  issue: IssueCtx;
  project: ProjectCtx & { holidayCalendarId: string | null };
  /** วันที่ใช้ตัดสินเลยกำหนด: Plan End · โปรเจกต์แยก Dev / QA และงานรอ QA = QA Due (projects/due-stage.ts) */
  planEnd: string | null;
  /** ขั้น QA: แจ้ง QA / Reviewer แทน Assignee */
  qaStage: boolean;
  statusName: string;
}

export interface SummaryItem {
  issueKey: string;
  title: string;
  planEnd: string | null;
  projectKey: string;
  daysLate?: number;
  daysLeft?: number;
  assignees?: (string | null)[];
}

/** สรุปของคนหนึ่งคนใน Workspace หนึ่ง */
interface Box {
  workspaceId: string;
  userId: string;
  dueSoon: SummaryItem[];
  dueToday: SummaryItem[];
  overdue: SummaryItem[];
  review: SummaryItem[];
  /** งานเลยกำหนดของทีมในโปรเจกต์ที่ดูแล (PM) · ไม่รวมงานที่อยู่ในหัวข้อ "เลยกำหนด" ของตัวเองแล้ว */
  team: Map<string, { projectKey: string; projectName: string; issues: SummaryItem[] }>;
}

const byDue = (a: SummaryItem, b: SummaryItem) => (a.planEnd ?? '9999').localeCompare(b.planEnd ?? '9999') || a.issueKey.localeCompare(b.issueKey);
const isReview = (name: string) => name.trim().toLowerCase() === 'review';

/**
 * สรุปงานประจำวัน 08:30 (A16 เรียกตาม SCHEDULES ใน rules.ts) · แทนการเตือนทีละงาน 08:00, digest และสรุป PM 09:30 เดิม
 * ผู้ใช้ตัดสิน 12 พ.ย. 2026: รวมเป็นแจ้งเตือนเดียวต่อคนต่อวัน เพื่อประหยัดโควตาอีเมล · Inbox ได้รายการเดียวเหมือนกัน
 * ใช้ friday_system เพราะรันนอกคำขอของผู้ใช้และครอบคลุมทุก Workspace · ตรวจสิทธิ์ผู้รับด้วย Audience.visible
 * รันซ้ำได้: dedupeKey `digest:{date}` ต่อคนต่อ Workspace
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

  async daily(date = today()) {
    const due = await this.openIssues(and(isNotNull(s.issues.planEnd), lte(s.issues.planEnd, addDays(date, LOOKAHEAD_DAYS)))!);
    // งานที่รอ Review ไม่ขึ้นกับ Due จึงอ่านแยก
    const review = await this.openIssues(and(isNotNull(s.issues.reviewerId), sql`lower(trim(${s.workflowStatuses.name})) = 'review'`)!);
    const all = [...new Map([...due, ...review].map((o) => [o.issue.id, o])).values()];
    const devAssignees = await this.audience.assignees(all.map((o) => o.issue.id));
    // งานที่ส่ง QA แล้ว (โปรเจกต์แยก Dev / QA) เป็นความรับผิดชอบของ QA / Reviewer ไม่ใช่ Dev
    const assignees = new Map(all.map((o) => [o.issue.id, o.qaStage && o.issue.reviewerId ? [o.issue.reviewerId] : (devAssignees.get(o.issue.id) ?? [])]));
    const calendars = await this.calendars(all.map((o) => o.project));
    const queried = new Set([...assignees.values()].flat().concat(all.flatMap((o) => (o.issue.reviewerId ? [o.issue.reviewerId] : []))));
    const settings = await this.settings([...queried]);
    const boxes = new Map<string, Box>();
    const box = (workspaceId: string, userId: string) => {
      const k = `${workspaceId}:${userId}`;
      if (!boxes.has(k)) boxes.set(k, { workspaceId, userId, dueSoon: [], dueToday: [], overdue: [], review: [], team: new Map() });
      return boxes.get(k)!;
    };
    const item = (o: OpenIssue, extra: Partial<SummaryItem> = {}): SummaryItem => ({ issueKey: o.issue.key, title: o.issue.title, planEnd: o.planEnd, projectKey: o.project.key, ...extra });

    // งานของฉัน: ใกล้ครบกำหนด / วันนี้ / เลยกำหนด
    for (const o of due) {
      const people = assignees.get(o.issue.id) ?? [];
      if (!people.length || !o.planEnd) continue;
      const visible = await this.audience.visible(people, o.project, o.issue);
      for (const u of visible) {
        const b = box(o.project.workspaceId, u);
        if (o.planEnd < date) b.overdue.push(item(o, { daysLate: daysBetween(o.planEnd, date) }));
        else if (o.planEnd === date) b.dueToday.push(item(o));
        else if (dueSoonInSummary(settings.get(`${o.project.workspaceId}:${u}`)?.dueReminder ?? '1d_and_today', o.planEnd, date, calendars.get(o.project.id)!))
          b.dueSoon.push(item(o, { daysLeft: daysBetween(date, o.planEnd) }));
      }
    }
    // รอฉัน Review
    for (const o of review) {
      if (!o.issue.reviewerId || !isReview(o.statusName)) continue;
      if ((await this.audience.visible([o.issue.reviewerId], o.project, o.issue)).size) box(o.project.workspaceId, o.issue.reviewerId).review.push(item(o));
    }
    // PM: งานเลยกำหนดของทีมในแต่ละโปรเจกต์
    const lateByProject = new Map<string, OpenIssue[]>();
    for (const o of due) if (o.planEnd && o.planEnd < date) lateByProject.set(o.project.id, [...(lateByProject.get(o.project.id) ?? []), o]);
    const names = await this.audience.names([...new Set([...lateByProject.values()].flat().flatMap((o) => assignees.get(o.issue.id) ?? []))]);
    for (const list of lateByProject.values()) {
      const project = list[0].project;
      const pms = await this.audience.visible([...(await this.audience.pmRecipients(project)).keys()], project);
      for (const u of pms) {
        const b = box(project.workspaceId, u);
        const mine = new Set(b.overdue.map((i) => i.issueKey));
        const issues = list
          .filter((o) => !mine.has(o.issue.key))
          .map((o) => item(o, { daysLate: daysBetween(o.planEnd!, date), assignees: (assignees.get(o.issue.id) ?? []).map((id) => names.get(id) ?? null) }));
        if (issues.length) b.team.set(project.id, { projectKey: project.key, projectName: project.name, issues });
      }
    }

    // PM ที่ไม่มีงานของตัวเองยังไม่ได้อ่านค่า (ใช้ความถี่ของสรุป)
    const missing = [...new Set([...boxes.values()].map((b) => b.userId))].filter((u) => !queried.has(u));
    for (const [k, v] of await this.settings(missing)) settings.set(k, v);
    const workspaceCalendars = new Map<string, WorkCalendar>();
    let sent = 0;
    for (const b of boxes.values()) {
      const mode: Digest = settings.get(`${b.workspaceId}:${b.userId}`)?.digest ?? 'workdays';
      // 'off' เป็นค่าเดิมก่อนรวมสรุป: งานเลยกำหนดเคยแจ้งเสมอ จึงถือเป็นวันทำการ
      if (mode !== 'daily') {
        if (!workspaceCalendars.has(b.workspaceId))
          workspaceCalendars.set(b.workspaceId, await this.db.transaction((tx) => WorkCalendar.load(tx, { id: NO_PROJECT, workspaceId: b.workspaceId, holidayCalendarId: null }, addDays(date, -1))));
        if (!workspaceCalendars.get(b.workspaceId)!.isWorkingDay(date)) continue;
      }
      [b.dueSoon, b.dueToday, b.overdue, b.review].forEach((l) => l.sort(byDue));
      const team = [...b.team.values()].sort((x, y) => x.projectKey.localeCompare(y.projectKey));
      team.forEach((p) => p.issues.sort(byDue));
      const teamCount = team.reduce((n, p) => n + p.issues.length, 0);
      const count = b.dueSoon.length + b.dueToday.length + b.overdue.length + b.review.length + teamCount;
      if (!count) continue;
      const cap = (l: SummaryItem[]) => l.slice(0, MAX_SUMMARY_ITEMS);
      await this.notifier.notify({
        workspaceId: b.workspaceId,
        recipientIds: [b.userId],
        eventType: DAILY_EVENT,
        actorId: null,
        payload: {
          date,
          title: summaryTitle({ dueToday: b.dueToday.length, overdue: b.overdue.length, dueSoon: b.dueSoon.length, review: b.review.length, team: teamCount }),
          count,
          dueSoon: cap(b.dueSoon),
          dueSoonCount: b.dueSoon.length,
          dueToday: cap(b.dueToday),
          dueTodayCount: b.dueToday.length,
          overdue: cap(b.overdue),
          overdueCount: b.overdue.length,
          review: cap(b.review),
          reviewCount: b.review.length,
          team: team.map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, count: p.issues.length, issues: cap(p.issues) })),
          teamCount,
        },
        reason: REASONS.daily,
        dedupeKey: `digest:${date}`,
      });
      sent++;
    }
    return { date, sent };
  }

  /** งานที่ยังไม่เสร็จตามเงื่อนไข · ไม่รวมโปรเจกต์ที่เก็บถาวรหรือถูกลบ */
  private async openIssues(where: SQL): Promise<OpenIssue[]> {
    const rows = await this.db
      .select({
        id: s.issues.id,
        number: s.issues.number,
        title: s.issues.title,
        planEnd: s.issues.planEnd,
        qaEnd: s.issues.qaEnd,
        category: s.workflowStatuses.category,
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
      .where(and(isNull(s.issues.deletedAt), isNull(s.projects.deletedAt), isNull(s.projects.archivedAt), isNull(s.workspaces.deletedAt), openStatus(), where));
    const rules = rows.length ? await this.db.transaction((tx) => loadDueRules(tx, rows.map((r) => r.projectId))) : new Map();
    return rows.map((r) => {
      const due = dueOf(rules.get(r.projectId) ?? PLAIN_DUE, r, r.category);
      return {
      planEnd: due.date,
      qaStage: due.stage === 'qa',
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
    };
    });
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

/** หัวเรื่องภาษาไทยที่เก็บใน payload (Inbox / กระดิ่งใช้เมื่อไม่มีคำแปล) · Email / LINE สร้างใหม่ตามภาษาผู้รับใน channels/message.ts */
export function summaryTitle(c: { dueToday: number; overdue: number; dueSoon: number; review: number; team: number }) {
  return [
    c.dueToday && `ครบกำหนดวันนี้ ${c.dueToday}`,
    c.overdue && `เลยกำหนด ${c.overdue}`,
    c.dueSoon && `ใกล้ครบกำหนด ${c.dueSoon}`,
    c.review && `รอ Review ${c.review}`,
    c.team && `ทีมเลยกำหนด ${c.team}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
