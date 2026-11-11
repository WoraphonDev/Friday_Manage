import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Db } from '@friday/db';
import { type DomainEvent, EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Jobs } from '../queue/jobs.js';
import { Audience, type IssueCtx, type ProjectCtx } from './audience.js';
import { Notifier } from './notifier.js';
import { Reminders } from './reminders.js';
import { IN_APP_LOCKED, isReviewStatus, JOBS, NO_INBOX, REASONS, SCHEDULES, SENT_AT_SOURCE, WATCHED_FIELDS } from './rules.js';

/** Event ที่ผ่านคิว (JSON) · at เป็น string */
type QueuedEvent = Omit<DomainEvent, 'at'> & { at: string | Date };

/** ผู้รับ 1 ชุดของ 1 eventType · ผู้รับคนเดียวมีหลายบทบาทได้ ใช้เหตุผลแรกที่ใส่ */
const PM_REASON = { owner: REASONS.pm, admin: REASONS.pmAdmin, deputy: REASONS.pmDeputy } as const;

class Send {
  readonly reasons = new Map<string, string>();
  constructor(
    readonly eventType: string,
    readonly payload: Record<string, unknown> = {},
  ) {}
  add(ids: (string | null | undefined)[], reason: string) {
    for (const id of ids) if (id && !this.reasons.has(id)) this.reasons.set(id, reason);
    return this;
  }
  drop(ids: Iterable<string>) {
    for (const id of ids) this.reasons.delete(id);
    return this;
  }
}

const ids = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);

/**
 * A23 · กระจายแจ้งเตือนเข้า Inbox จาก EventBus และงานตามเวลา
 * ผู้ฟังแค่ส่งเข้าคิว (A16) เพื่อไม่ให้คำขอหลักช้า · โหมด inline รันทันที
 */
@Injectable()
export class NotificationFanout implements OnModuleInit {
  private readonly log = new Logger('NotificationFanout');
  private readonly audience: Audience;

  constructor(
    private readonly events: EventBus,
    private readonly jobs: Jobs,
    private readonly notifier: Notifier,
    private readonly reminders: Reminders,
    @Inject(SYSTEM_DB) db: Db,
  ) {
    this.audience = new Audience(db);
  }

  async onModuleInit() {
    this.jobs.define<QueuedEvent>(JOBS.fanout, (event) => this.fanout(event));
    this.events.on('*', async (event) => {
      if (SENT_AT_SOURCE.has(event.type) || NO_INBOX.has(event.type)) return;
      await this.jobs.enqueue(JOBS.fanout, event);
    });
    this.jobs.define<{ date?: string }>(JOBS.dueReminders, (data) => this.reminders.dueReminders(data?.date));
    this.jobs.define<{ date?: string }>(JOBS.overdueSummary, (data) => this.reminders.overdueSummary(data?.date));
    this.jobs.define<{ date?: string }>(JOBS.digest, (data) => this.reminders.digest(data?.date));
    await this.jobs.every(JOBS.dueReminders, SCHEDULES.dueReminders);
    await this.jobs.every(JOBS.overdueSummary, SCHEDULES.overdueSummary);
    await this.jobs.every(JOBS.digest, SCHEDULES.digest);
  }

  /** สร้างรายการ Inbox ของ 1 Event (เรียกจากคิว) */
  async fanout(event: QueuedEvent) {
    if (!event.projectId) return;
    const project = await this.audience.project(event.projectId);
    if (!project) return;
    const issue = event.issueId ? await this.audience.issue(event.issueId, project.key) : null;
    const sends = await this.recipients(event, project, issue);
    if (!sends.length) return;
    const names = event.actorId ? await this.audience.names([event.actorId]) : new Map<string, string>();
    const d = event.data ?? {};
    const base = {
      projectKey: project.key,
      projectName: project.name,
      ...(issue || d.issueKey ? { issueKey: issue?.key ?? d.issueKey, issueTitle: issue?.title ?? d.title } : {}),
      ...(event.actorId ? { actorName: names.get(event.actorId) ?? null } : {}),
    };
    for (const send of sends) {
      // import.completed: ผู้นำเข้าคือผู้ทำ action แต่ต้องได้รับแจ้งเมื่อคิวทำเสร็จ จึงไม่ตัดผู้ทำเอง
      const selfNotify = event.type === 'import.completed';
      const candidates = [...send.reasons.keys()].filter((id) => selfNotify || id !== event.actorId);
      const visible = await this.audience.visible(candidates, project, issue);
      const muted = IN_APP_LOCKED.has(send.eventType) ? new Set<string>() : await this.audience.inAppDisabled(project.workspaceId, [...visible], send.eventType);
      // คนที่ปิด In-app ยังอยู่ในรายชื่อ (ไม่เข้า Inbox) เพื่อให้ Email / LINE / กฎ Webhook ที่เปิดไว้ยังทำงาน
      const recipients = [...visible];
      if (!recipients.length) continue;
      await this.notifier.notify({
        workspaceId: project.workspaceId,
        recipientIds: recipients,
        eventType: send.eventType,
        actorId: selfNotify ? null : event.actorId,
        projectId: project.id,
        issueId: issue?.id,
        payload: { ...base, ...send.payload },
        reason: (id) => send.reasons.get(id)!,
        inAppOff: muted,
      });
    }
  }

  /** ผู้รับเริ่มต้นตาม 03-api › Event ที่ระบบส่งต่อ · หน้าจอ I (Profile) เพิ่ม "ถูกถอดออกจากงาน" และ "ถูกเพิ่มเข้าโปรเจกต์" */
  private async recipients(event: QueuedEvent, project: ProjectCtx, issue: IssueCtx | null): Promise<Send[]> {
    const d = event.data ?? {};
    const assignees = async () => (issue ? ((await this.audience.assignees([issue.id])).get(issue.id) ?? []) : []);
    const watchers = async () => (issue ? this.audience.watchers(issue.id) : []);
    const pmPeople = await this.audience.pmRecipients(project);
    const pm = (send: Send) => {
      for (const [id, kind] of pmPeople) send.add([id], PM_REASON[kind]);
      return send;
    };

    switch (event.type) {
      case 'issue.assigned':
        return [
          new Send('issue.assigned').add(ids(d.userIds), REASONS.assignee),
          new Send('issue.assigned', { removed: true }).add(ids(d.removedUserIds), REASONS.unassigned),
        ];

      case 'issue.status_changed': {
        const changed = new Send('issue.status_changed', { from: d.from, to: d.to }).add(await watchers(), REASONS.watcher);
        // Sub-task เปลี่ยนสถานะ → ผู้รับผิดชอบงานแม่
        if (issue?.parentId) changed.add((await this.audience.assignees([issue.parentId])).get(issue.parentId) ?? [], REASONS.parentAssignee);
        const to = d.to as { name?: unknown; category?: unknown } | undefined;
        if (!issue?.reviewerId || !(to?.category === 'review' || isReviewStatus(to?.name))) return [changed];
        // ย้ายเข้า Review → Reviewer ได้ issue.review_requested แทนการแจ้งเปลี่ยนสถานะ
        const review = new Send('issue.review_requested', { from: d.from, to: d.to }).add([issue.reviewerId], REASONS.reviewer);
        return [review, changed.drop([issue.reviewerId])];
      }

      case 'issue.review_requested':
        return [new Send('issue.review_requested').add(ids(d.userIds).length ? ids(d.userIds) : [issue?.reviewerId], REASONS.reviewer)];

      case 'issue.updated': {
        const fields = ids(d.fields).filter((f) => WATCHED_FIELDS.has(f));
        if (!fields.length) return [];
        return [new Send('issue.updated', { fields }).add(await watchers(), REASONS.watcher)];
      }

      case 'issue.commented': {
        // คนที่ถูก @mention ในคอมเมนต์เดียวกันได้ issue.mentioned แล้ว ไม่ต้องได้ซ้ำ
        const mentioned = typeof d.commentId === 'string' ? await this.audience.mentionedIn(d.commentId) : [];
        return [new Send('issue.commented', { commentId: d.commentId, excerpt: d.excerpt }).add(await watchers(), REASONS.watcher).drop(mentioned)];
      }

      case 'issue.mentioned':
        return [new Send('issue.mentioned', { commentId: d.commentId }).add(ids(d.userIds), REASONS.mentioned)];

      case 'issue.due_soon':
        return [new Send('issue.due_soon', { planEnd: d.planEnd }).add(await assignees(), REASONS.dueSoon)];

      case 'issue.overdue':
        return [pm(new Send('issue.overdue', { planEnd: d.planEnd }).add(await assignees(), REASONS.overdue))];

      case 'bug.created':
        // สร้าง Bug พร้อมผู้รับผิดชอบจะมี issue.assigned ตามมาในคำขอเดียวกันเสมอ · Assignee จึงได้แค่รายการนั้น ไม่ซ้ำ 2 รายการ
        return [new Send('bug.created', { severity: d.severity }).add([issue?.baId], REASONS.ba)];

      case 'bug.reopened':
        return [
          new Send('bug.reopened', { reopenCount: d.reopenCount })
            .add(await assignees(), REASONS.bugAssignee)
            .add([issue?.baId], REASONS.ba),
        ];

      case 'test_run.failed':
        return [new Send('test_run.failed', d).add(await assignees(), REASONS.owner)];

      case 'sprint.started':
      case 'sprint.completed':
        return [new Send(event.type, d).add(await this.audience.projectMembers(project), REASONS.projectMember)];

      case 'plan.changed':
        return [pm(new Send('plan.changed', { fields: d.fields, reason: d.reason, source: d.source }))];

      case 'project.health_changed':
      case 'member.invited':
        return [pm(new Send(event.type, d))];

      case 'member.joined':
        return [pm(new Send('member.joined', { userId: d.userId, role: d.role }).add([d.userId as string], REASONS.addedToProject))];

      case 'import.completed':
        return [new Send('import.completed', d).add([(d.userId as string) ?? event.actorId], REASONS.importer)];

      default:
        return [];
    }
  }
}
