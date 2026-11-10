// J. ช่องทางแจ้งเตือน · ค่า secret เป็น ciphertext และมี suffix สำหรับแสดงในหน้าตั้งค่า
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, smallint, text, time, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { users } from './identity.ts';
import { workspaces } from './workspace.ts';
import { notifications } from './notify.ts';
import { inProject, workspaceId } from './project.ts';
import { tenantFk, tenantKey } from './saas-common.ts';
import { deliveryStatus, digestFrequency, dueReminder, notificationChannel, quietMode, webhookFormat } from './saas-enums.ts';

// ผู้รับเห็นของตัวเอง, Admin เห็นทั้ง Workspace · เขียนได้เฉพาะงานเบื้องหลัง (RLS 0009)
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: pk(), workspaceId: workspaceId(), notificationId: uuid().notNull(),
  channel: notificationChannel().notNull(), targetRef: text().notNull(),
  status: deliveryStatus().notNull().default('queued'), attempts: integer().notNull().default(0),
  lastError: text(), sentAt: tstz(),
  /** ชื่อปลายทางที่แสดง (อีเมล, ชื่อกลุ่ม LINE, ชื่อ Webhook) · ค้นในหลังบ้าน (O23) */
  targetLabel: text(),
  /** สิ่งที่ส่งครั้งล่าสุด { view: { subject?, text }, request?: { method, url (ซ่อน token), headers, body } } · เก็บ 90 วัน */
  content: jsonb(),
  /** คำตอบจากปลายทางครั้งล่าสุด { status, body (ย่อ ≤ 500 ตัวอักษร) } */
  response: jsonb(),
  /** ลำดับเหตุการณ์ [{ at, kind, attempt?, status?, message?, final? }] */
  log: jsonb().notNull().default(sql`'[]'::jsonb`),
  /** ทีม Friday ขอส่งซ้ำ · งาน scan ของ API หยิบไปส่งภายใน 1 นาที */
  resendRequestedAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantFk('notification_deliveries_notification_fk', t.workspaceId, t.notificationId, notifications).onDelete('cascade'),
  index('notification_deliveries_status_idx').on(t.workspaceId, t.status, t.createdAt),
  uniqueIndex('notification_deliveries_target_key').on(t.notificationId, t.channel, t.targetRef),
  check('notification_deliveries_attempts_nonnegative', sql`${t.attempts} >= 0`),
  // Inbox ไม่ใช่การส่งออกนอกแอป · เทียบเป็นข้อความเพราะค่า enum ใหม่ใช้ในธุรกรรมเดียวกับที่เพิ่มไม่ได้
  check('notification_deliveries_external_channel', sql`${t.channel}::text <> 'in_app'`),
  index('notification_deliveries_created_idx').on(t.createdAt)]);

export const EMAIL_SUPPRESSION_REASONS = ['hard_bounce', 'complaint', 'soft_bounce_repeated', 'manual'] as const;

/**
 * อีเมลที่ระบบไม่ส่งให้ (O23) · ระดับระบบ ไม่ผูก Workspace (อีเมลเดียวอยู่ได้หลาย Workspace) · workspace_id = ที่มาของ bounce ล่าสุด ใช้แสดงผล
 * ลบไม่ได้ · เอาออก = ตั้ง removed_at พร้อมเหตุผล (Y7)
 */
export const emailSuppressions = pgTable('email_suppressions', {
  id: pk(), email: text().notNull(), reason: text().notNull(), detail: text(),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: 'set null' }),
  /** ses = จาก webhook ของผู้ให้บริการ · ops = ทีม Friday เพิ่มเอง */
  source: text().notNull().default('ses'),
  createdAt: createdAt(), removedAt: tstz(), removedBy: uuid(), removeReason: text(),
}, (t) => [uniqueIndex('email_suppressions_active_key').on(sql`lower(${t.email})`).where(sql`${t.removedAt} IS NULL`),
  check('email_suppressions_reason_valid', sql`${t.reason} IN ('hard_bounce', 'complaint', 'soft_bounce_repeated', 'manual')`)]);

/** เหตุการณ์ bounce / complaint จากผู้ให้บริการอีเมล · ใช้นับ bounce ชั่วคราวซ้ำ · เก็บ 90 วัน */
export const emailFeedbackEvents = pgTable('email_feedback_events', {
  id: pk(), email: text().notNull(), kind: text().notNull(), detail: text(), raw: jsonb(), createdAt: createdAt(),
}, (t) => [index('email_feedback_events_email_idx').on(sql`lower(${t.email})`, t.createdAt),
  check('email_feedback_events_kind_valid', sql`${t.kind} IN ('bounce_permanent', 'bounce_transient', 'complaint')`)]);

export const userNotificationPrefs = pgTable('user_notification_prefs', {
  id: pk(), workspaceId: workspaceId(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventType: text().notNull(), channel: notificationChannel().notNull(), enabled: boolean().notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('user_notification_prefs_key').on(t.workspaceId, t.userId, t.eventType, t.channel)]);

export const userNotificationSettings = pgTable('user_notification_settings', {
  id: pk(), workspaceId: workspaceId(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  dueReminder: dueReminder().notNull().default('1d_and_today'), digest: digestFrequency().notNull().default('workdays'),
  quietStart: time(), quietEnd: time(), quietOnHolidays: boolean().notNull().default(true),
  autoWatch: boolean().notNull().default(true), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('user_notification_settings_user_key').on(t.workspaceId, t.userId),
  check('user_notification_settings_quiet_pair', sql`(${t.quietStart} IS NULL) = (${t.quietEnd} IS NULL)`)]);

export const lineOaConfigs = pgTable('line_oa_configs', {
  id: pk(), workspaceId: workspaceId().unique(), channelId: text().notNull(),
  channelSecretEncrypted: text().notNull(), channelSecretLast4: text().notNull(),
  accessTokenEncrypted: text().notNull(), accessTokenLast4: text().notNull(),
  fallbackToEmail: boolean().notNull().default(true), batchDigestMinutes: smallint().notNull().default(5),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('line_oa_configs_batch_positive', sql`${t.batchDigestMinutes} > 0`)]);

export const lineGroups = pgTable('line_groups', {
  id: pk(), workspaceId: workspaceId(), lineGroupId: text().notNull(), name: text().notNull(),
  joinedAt: tstz().notNull().defaultNow(), createdAt: createdAt(),
}, (t) => [tenantKey('line_groups', t), uniqueIndex('line_groups_external_key').on(t.workspaceId, t.lineGroupId)]);

export const emailSenderConfigs = pgTable('email_sender_configs', {
  id: pk(), workspaceId: workspaceId().unique(),
  fromName: text().notNull(), fromEmail: text().notNull(), replyTo: text(),
  spfOk: boolean().notNull().default(false), dkimOk: boolean().notNull().default(false), dmarcOk: boolean().notNull().default(false),
  verifiedAt: tstz(), smtpHost: text(), smtpPort: integer(), smtpUser: text(),
  smtpPasswordEncrypted: text(), smtpPasswordLast4: text(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('email_sender_configs_port_range', sql`${t.smtpPort} BETWEEN 1 AND 65535`)]);

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: pk(), workspaceId: workspaceId(), name: text().notNull(), format: webhookFormat().notNull().default('json'),
  urlEncrypted: text().notNull(), urlLast4: text().notNull(),
  signingSecretEncrypted: text(), signingSecretLast4: text(),
  status: text().notNull().default('active'), consecutiveFailures: integer().notNull().default(0), pausedUntil: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('webhook_endpoints', t), check('webhook_endpoints_failures_nonnegative', sql`${t.consecutiveFailures} >= 0`)]);

export const projectNotificationRules = pgTable('project_notification_rules', {
  id: pk(), workspaceId: workspaceId(), projectId: uuid().notNull(), eventType: text().notNull(),
  enabled: boolean().notNull().default(true), lineGroupId: uuid(), webhookId: uuid(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [inProject('project_notification_rules', t),
  tenantFk('project_notification_rules_group_fk', t.workspaceId, t.lineGroupId, lineGroups).onDelete('cascade'),
  tenantFk('project_notification_rules_webhook_fk', t.workspaceId, t.webhookId, webhookEndpoints).onDelete('cascade'),
  check('project_notification_rules_one_target', sql`num_nonnulls(${t.lineGroupId}, ${t.webhookId}) = 1`),
  uniqueIndex('project_notification_rules_group_key').on(t.projectId, t.eventType, t.lineGroupId),
  uniqueIndex('project_notification_rules_webhook_key').on(t.projectId, t.eventType, t.webhookId)]);

export const projectNotificationSettings = pgTable('project_notification_settings', {
  id: pk(), workspaceId: workspaceId(), projectId: uuid().notNull().unique(),
  quietMode: quietMode().notNull().default('after_hours'), criticalBugBypass: boolean().notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [inProject('project_notification_settings', t)]);

export const reportSchedules = pgTable('report_schedules', {
  id: pk(), workspaceId: workspaceId(), projectId: uuid().notNull(), reportType: text().notNull(),
  weekday: smallint().notNull(), time: time().notNull().default('09:00'),
  channels: notificationChannel().array().notNull().default(sql`'{}'`),
  recipients: jsonb().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [inProject('report_schedules', t), uniqueIndex('report_schedules_type_key').on(t.projectId, t.reportType), check('report_schedules_weekday', sql`${t.weekday} BETWEEN 1 AND 7`)]);
