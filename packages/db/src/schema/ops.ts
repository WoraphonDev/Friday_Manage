// N. หลังบ้าน Friday · friday_app ไม่มีสิทธิ์ ตารางเหล่านี้ใช้โดย ops เท่านั้น
import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { users } from './identity.ts';
import { workspaceId } from './project.ts';
import { announcementAudience, supportMode } from './saas-enums.ts';

export const staffUsers = pgTable('staff_users', {
  id: pk(), email: text().notNull(), name: text().notNull(), role: text().notNull(),
  webauthnCredentials: jsonb().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('staff_users_email_key').on(sql`lower(${t.email})`)]);

export const supportAccessGrants = pgTable('support_access_grants', {
  id: pk(), workspaceId: workspaceId().unique(), grantedBy: uuid().notNull().references(() => users.id),
  until: tstz(), maxMode: supportMode().notNull().default('read'), notifyAdmins: boolean().notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const supportSessions = pgTable('support_sessions', {
  id: pk(), workspaceId: workspaceId(), staffId: uuid().notNull().references(() => staffUsers.id),
  ticketNo: text().notNull(), reason: text().notNull(), mode: supportMode().notNull().default('read'),
  secondApproverId: uuid().references(() => staffUsers.id), startedAt: tstz().notNull().defaultNow(), endedAt: tstz(),
  createdAt: createdAt(),
}, (t) => [index('support_sessions_workspace_idx').on(t.workspaceId, t.startedAt),
  check('support_sessions_write_approval', sql`${t.mode} <> 'write' OR (${t.secondApproverId} IS NOT NULL AND ${t.secondApproverId} <> ${t.staffId})`),
  check('support_sessions_dates', sql`${t.endedAt} >= ${t.startedAt}`)]);

export const featureFlags = pgTable('feature_flags', {
  id: pk(), key: text().notNull().unique(), description: text(), defaultOn: boolean().notNull().default(false),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const featureFlagOverrides = pgTable('feature_flag_overrides', {
  id: pk(), flagId: uuid().notNull().references(() => featureFlags.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(), enabled: boolean().notNull(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('feature_flag_overrides_key').on(t.flagId, t.workspaceId)]);

export const announcements = pgTable('announcements', {
  id: pk(), message: text().notNull(), audience: announcementAudience().notNull().default('all'),
  channels: text().array().notNull().default(sql`'{banner}'`), scheduledAt: tstz(), sentAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
});
