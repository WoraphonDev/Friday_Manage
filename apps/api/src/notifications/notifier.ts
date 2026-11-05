import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { SYSTEM_DB } from '../db/db.module.js';

export interface NotifyInput {
  workspaceId: string;
  /** ผู้รับ · ผู้ที่ทำ action เองถูกตัดออกเสมอ (03-api › Event) */
  recipientIds: string[];
  eventType: string;
  actorId: string | null;
  projectId?: string;
  issueId?: string;
  /** ข้อความ ณ เวลาที่เกิดเหตุการณ์ (ชื่อผู้ทำ, Issue key, ชื่องาน) ให้ Inbox แสดงได้แม้งานถูกลบ / ย้ายสิทธิ์ */
  payload: Record<string, unknown>;
  /** "ทำไมฉันได้รับแจ้ง" · ส่งเป็นฟังก์ชันได้เมื่อเหตุผลต่างกันตามผู้รับ */
  reason: string | ((recipientId: string) => string);
}

/**
 * สร้างรายการใน Inbox · แอปไม่มีสิทธิ์ INSERT notifications (0001_rls) จึงเขียนผ่าน friday_system
 * เรียกหลังธุรกรรมหลัก commit แล้ว · ภายหลังย้ายเข้าคิว BullMQ พร้อมส่ง LINE / Email / Webhook
 */
@Injectable()
export class Notifier {
  private readonly log = new Logger('Notifier');

  constructor(@Inject(SYSTEM_DB) private readonly system: Db) {}

  async notify(n: NotifyInput) {
    const recipients = [...new Set(n.recipientIds)].filter((id) => id !== n.actorId);
    if (!recipients.length) return;
    try {
      await this.system.insert(schema.notifications).values(
        recipients.map((recipientId) => ({
          workspaceId: n.workspaceId,
          recipientId,
          eventType: n.eventType,
          actorId: n.actorId,
          projectId: n.projectId,
          issueId: n.issueId,
          payload: n.payload,
          reason: typeof n.reason === 'function' ? n.reason(recipientId) : n.reason,
        })),
      );
    } catch (err) {
      // ข้อมูลหลักบันทึกแล้ว แจ้งเตือนพลาดไม่ควรทำให้คำขอล้ม
      this.log.error(`notify ${n.eventType} failed: ${(err as Error).stack ?? err}`);
    }
  }
}
