// J. แจ้งเตือน (Inbox) · ช่องทางส่งออกนอกแอป (LINE, Email, Webhook) อยู่ใน migration ถัดไป
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz } from './_common.ts';
import { users } from './identity.ts';
import { workspaceId } from './project.ts';

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    workspaceId: workspaceId(),
    recipientId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text().notNull(),
    actorId: uuid().references(() => users.id),
    projectId: uuid(),
    issueId: uuid(),
    payload: jsonb().notNull(),
    /** "ทำไมฉันได้รับแจ้ง" */
    reason: text(),
    readAt: tstz(),
    doneAt: tstz(),
    snoozedUntil: tstz(),
    /**
     * false = ผู้รับปิด In-app ของเหตุการณ์นี้ แต่ยังต้องส่ง Email / LINE ตาม pref
     * แถวนี้ใช้เป็นต้นทางของการส่งออกนอกแอปเท่านั้น · RLS ซ่อนจาก Inbox ของผู้รับ (0011)
     */
    inApp: boolean().notNull().default(true),
    /** requestId ของคำขอ HTTP ที่ทำให้เกิดการแจ้งเตือน (รอบ 4 · S7) · ใช้ค้นในประวัติการส่ง */
    requestId: text(),
    createdAt: createdAt(),
  },
  (t) => [unique('notifications_workspace_id_key').on(t.workspaceId, t.id), index('notifications_recipient_idx').on(t.recipientId, t.createdAt),
    index('notifications_request_idx').on(t.requestId).where(sql`${t.requestId} IS NOT NULL`)],
);
