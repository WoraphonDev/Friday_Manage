// J. แจ้งเตือน (Inbox) · ช่องทางส่งออกนอกแอป (LINE, Email, Webhook) อยู่ใน migration ถัดไป
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
    createdAt: createdAt(),
  },
  (t) => [index('notifications_recipient_idx').on(t.recipientId, t.createdAt)],
);
