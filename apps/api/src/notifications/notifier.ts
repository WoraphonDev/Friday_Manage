import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  /**
   * กันแจ้งซ้ำ: ผู้รับที่เคยได้ eventType เดียวกันพร้อม key นี้แล้วจะถูกข้าม (เก็บไว้ใน payload.dedupeKey)
   * ใช้กับงานตามเวลาที่อาจรันซ้ำหรือ retry (A16) เช่น `due_soon:{issueId}:{planEnd}:{date}`
   */
  dedupeKey?: string;
  /**
   * ผู้รับที่ปิด In-app ของเหตุการณ์นี้: ยังสร้างแถวไว้ให้ท่อส่ง Email / LINE (in_app = false, RLS ซ่อนจาก Inbox)
   * ไม่ตัดผู้รับทิ้ง เพราะการปิด Inbox ต้องไม่ทำให้ช่องทางอื่นที่เปิดไว้หยุดตาม (BUG-13)
   */
  inAppOff?: Iterable<string>;
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
    let recipients = [...new Set(n.recipientIds)].filter((id) => id !== n.actorId);
    if (!recipients.length) return;
    try {
      if (n.dedupeKey) {
        const t = schema.notifications;
        const sent = await this.system
          .select({ recipientId: t.recipientId })
          .from(t)
          .where(and(eq(t.workspaceId, n.workspaceId), eq(t.eventType, n.eventType), inArray(t.recipientId, recipients), sql`${t.payload}->>'dedupeKey' = ${n.dedupeKey}`));
        const done = new Set(sent.map((r) => r.recipientId));
        recipients = recipients.filter((id) => !done.has(id));
        if (!recipients.length) return;
      }
      const payload = n.dedupeKey ? { ...n.payload, dedupeKey: n.dedupeKey } : n.payload;
      const off = new Set(n.inAppOff ?? []);
      await this.system.insert(schema.notifications).values(
        recipients.map((recipientId) => ({
          workspaceId: n.workspaceId,
          recipientId,
          eventType: n.eventType,
          actorId: n.actorId,
          projectId: n.projectId,
          issueId: n.issueId,
          payload,
          reason: typeof n.reason === 'function' ? n.reason(recipientId) : n.reason,
          inApp: !off.has(recipientId),
        })),
      );
    } catch (err) {
      // ข้อมูลหลักบันทึกแล้ว แจ้งเตือนพลาดไม่ควรทำให้คำขอล้ม
      this.log.error(`notify ${n.eventType} failed: ${(err as Error).stack ?? err}`);
    }
  }
}
