import { AsyncLocalStorage } from 'node:async_hooks';
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
  | 'support.replied'
  // ย้ายงานข้ามโปรเจกต์ (2026-11-20) · projectId = ปลายทาง · data.oldKey / issueKey
  | 'issue.moved';

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
  /** รอบ 4 · S7: requestId ของคำขอ HTTP ที่ทำให้เกิดเหตุการณ์ · ว่าง = Job / Worker · เติมให้เองใน publish */
  requestId?: string;
}

/**
 * บริบทของคำขอ HTTP ปัจจุบัน (รอบ 4 · S7) · middleware ใน NotificationsModule เปิดไว้ทุกคำขอ
 * เก็บ req ทั้งก้อนแล้วอ่าน id ตอนใช้ เพราะ middleware ที่ตั้ง req.id (app.module) อาจทำงานทีหลัง
 */
export const requestContext = new AsyncLocalStorage<{ req: { id?: string } }>();
export const currentRequestId = (): string | undefined => requestContext.getStore()?.req.id;

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
      e.requestId ??= currentRequestId();
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
