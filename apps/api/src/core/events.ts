import { Injectable, Logger } from '@nestjs/common';

/**
 * เหตุการณ์ในระบบ (03-api › Event ที่ระบบส่งต่อ)
 * ผู้ฟัง: แจ้งเตือน, Automation, Webhook, Realtime · ส่งหลังธุรกรรม commit แล้วเท่านั้น
 */
export type EventType =
  | 'issue.created'
  | 'issue.assigned'
  | 'issue.status_changed'
  | 'issue.review_requested'
  | 'issue.updated'
  | 'issue.deleted'
  | 'issue.commented'
  | 'issue.mentioned'
  | 'issue.due_soon'
  | 'issue.overdue'
  | 'due_request.created'
  | 'due_request.decided'
  | 'bug.created'
  | 'bug.reopened'
  | 'test_run.failed'
  | 'sprint.started'
  | 'sprint.completed'
  | 'plan.changed'
  | 'project.health_changed'
  | 'member.invited'
  | 'member.joined'
  | 'import.completed'
  | 'report.weekly'
  | 'leave.created'
  | 'ci.failed'
  // A43 · Onboarding checklist (ไม่มี projectId จึงไม่เข้า Inbox / Realtime)
  | 'onboarding.step_done'
  | 'onboarding.completed'
  // A41 · ถังขยะ
  | 'project.restored_from_trash'
  | 'trash.purged'
  // A44 · ศูนย์ช่วยเหลือ / Ticket ในแอป (ไม่มี projectId)
  | 'support.ticket_created'
  | 'support.replied';

export interface DomainEvent {
  type: EventType;
  workspaceId: string;
  projectId?: string;
  issueId?: string;
  /** null = ระบบ (Job ตามเวลา, Automation) */
  actorId: string | null;
  /** ข้อมูลของเหตุการณ์ เช่น { issueKey, title, field, from, to, userIds } */
  data: Record<string, unknown>;
  at: Date;
}

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

/**
 * ตัวกระจายเหตุการณ์ในโปรเซสเดียว · ผู้ฟังลงทะเบียนใน onModuleInit ของ module ตัวเอง
 * ผู้ฟังที่ล้มถูก log ไว้ ไม่ทำให้คำขอหลักล้ม · ภายหลังผู้ฟังที่ช้าส่งงานเข้าคิว (BullMQ) เอง
 */
@Injectable()
export class EventBus {
  private readonly log = new Logger('EventBus');
  private readonly handlers = new Map<EventType | '*', EventHandler[]>();

  on(type: EventType | '*', handler: EventHandler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  async publish(events: DomainEvent | DomainEvent[]) {
    for (const e of Array.isArray(events) ? events : [events]) {
      for (const h of [...(this.handlers.get(e.type) ?? []), ...(this.handlers.get('*') ?? [])]) {
        try {
          await h(e);
        } catch (err) {
          this.log.error(`${e.type} handler failed: ${(err as Error).stack ?? err}`);
        }
      }
    }
  }
}
