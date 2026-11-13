// O32 · มีอะไรใหม่ / Spotlight / NPS (01 · U1–U7) และ Onboarding checklist (02 · V1–V7)
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { workspaceRole } from './enums.ts';
import { devIssueLinks } from './help.ts';
import { users } from './identity.ts';
import { staffUsers, supportTickets } from './ops.ts';
import { workspaceId } from './project.ts';
import { workspaces } from './workspace.ts';

const oneOf = (col: AnyPgColumn, values: readonly string[]) => sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

export const CHANGELOG_KINDS = ['new', 'improved', 'fixed'] as const;
/** all = ทุก Workspace (ยกเว้น Guest / ถูกระงับ · API กรอง) · plans = ตาม audience_plans · flag = Workspace ที่เปิด flag · admins = เฉพาะ Owner / Admin */
export const CHANGELOG_AUDIENCES = ['all', 'plans', 'flag', 'admins'] as const;
export const CHANGELOG_STATUSES = ['draft', 'scheduled', 'published', 'hidden'] as const;

/**
 * รายการ Changelog (U4) · ลูกค้าอ่านผ่าน RLS เฉพาะ published / scheduled ที่ published_at ผ่านแล้ว
 * (scheduled ที่ถึงเวลาแล้วนับเป็นเผยแพร่ ไม่ต้องมีงานเบื้องหลังเปลี่ยนสถานะ) · กลุ่มผู้เห็นกรองที่ API
 * Spotlight (U2) มีได้ทีละ 1 รายการในบรรดาที่ตั้งเวลา / เผยแพร่ (unique index) · ฉบับอังกฤษไม่บังคับ ว่าง = แสดงฉบับไทย
 */
export const changelogEntries = pgTable('changelog_entries', {
  id: pk(), kind: text().notNull(),
  title: text().notNull(), summary: text().notNull(), body: text().notNull().default(''),
  titleEn: text(), summaryEn: text(), bodyEn: text(),
  /** รูปหรือวิดีโอในที่เก็บไฟล์สาธารณะ (แยกจากไฟล์ลูกค้า) */
  mediaUrl: text(), mediaKind: text(), mediaAlt: text(),
  /** ปุ่ม "ลองใช้" · cta_path = หน้าใน Workspace ปัจจุบัน เช่น /profile/notifications */
  ctaLabel: text(), ctaLabelEn: text(), ctaPath: text(),
  audience: text().notNull().default('all'),
  /** plans.code เมื่อ audience = plans */
  audiencePlans: text().array().notNull().default(sql`'{}'`),
  /** feature_flags.key เมื่อ audience = flag · ไม่ใส่ FK เพื่อให้ลบ flag แล้วรายการเก่ายังอยู่ (API ถือว่าไม่มีใครเห็น) */
  audienceFlag: text(),
  spotlight: boolean().notNull().default(false),
  /** แสดงในหน้าสาธารณะ fridaymanage.com/changelog */
  showPublic: boolean().notNull().default(true),
  status: text().notNull().default('draft'),
  /** วันที่ที่แสดงในแผง · null = วันของ published_at */
  displayDate: date(),
  /** เวลาเผยแพร่ (scheduled = เวลาที่ตั้งไว้) */
  publishedAt: tstz(),
  hiddenAt: tstz(), hiddenBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), hideReason: text(),
  /** ร่างรายการ "แก้ไข" จากงานของทีมพัฒนา (T9 · O36) */
  devIssueLinkId: uuid().references(() => devIssueLinks.id, { onDelete: 'set null' }),
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  updatedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('changelog_entries_published_idx').on(t.status, t.publishedAt),
  uniqueIndex('changelog_entries_spotlight_key').on(t.spotlight).where(sql`${t.spotlight} AND ${t.status} IN ('scheduled', 'published')`),
  check('changelog_entries_kind_valid', oneOf(t.kind, CHANGELOG_KINDS)),
  check('changelog_entries_audience_valid', oneOf(t.audience, CHANGELOG_AUDIENCES)),
  check('changelog_entries_status_valid', oneOf(t.status, CHANGELOG_STATUSES)),
  check('changelog_entries_media_kind_valid', sql`${t.mediaKind} IS NULL OR ${oneOf(t.mediaKind, ['image', 'video'])}`),
  check('changelog_entries_audience_values', sql`(${t.audience} = 'plans') = (cardinality(${t.audiencePlans}) > 0) AND (${t.audience} = 'flag') = (${t.audienceFlag} IS NOT NULL)`),
  check('changelog_entries_summary_length', sql`char_length(${t.summary}) <= 140 AND (${t.summaryEn} IS NULL OR char_length(${t.summaryEn}) <= 140)`),
  check('changelog_entries_published_at', sql`${t.status} NOT IN ('scheduled', 'published') OR ${t.publishedAt} IS NOT NULL`),
  check('changelog_entries_hidden', sql`(${t.status} = 'hidden') = (${t.hiddenAt} IS NOT NULL) AND (${t.status} <> 'hidden' OR ${t.hideReason} IS NOT NULL)`)]);

/** ยอดเห็น / คลิกต่อรายการ ไม่เก็บว่าใครอ่าน · เพิ่มผ่าน app.count_changelog_views() / app.count_changelog_click() เท่านั้น */
export const changelogStats = pgTable('changelog_stats', {
  entryId: uuid().primaryKey().references(() => changelogEntries.id, { onDelete: 'cascade' }),
  views: integer().notNull().default(0), clicks: integer().notNull().default(0), updatedAt: updatedAt(),
});

/**
 * สถานะ UI ของผู้ใช้ที่ไม่ผูก Workspace (1:1) · ผู้ใช้อ่าน / แก้ของตัวเองผ่าน RLS
 * whats_new_seen_at = เปิดแผงมีอะไรใหม่ล่าสุด (รายการที่ published_at ใหม่กว่า = ยังไม่เห็น · จุดเหลือง)
 * nps_prompted_at = แสดงแบบสำรวจล่าสุด (≤ 1 ครั้งต่อวัน) · nps_responded_at = ตอบหรือปิดล่าสุด (ถามซ้ำตาม repeat_days ต่อคน)
 */
export const userUiStates = pgTable('user_ui_states', {
  userId: uuid().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  whatsNewSeenAt: tstz(),
  spotlightSeenIds: uuid().array().notNull().default(sql`'{}'`), spotlightSeenAt: tstz(),
  npsPromptedAt: tstz(), npsRespondedAt: tstz(),
  updatedAt: updatedAt(),
});

/**
 * ตั้งค่าแบบสำรวจ NPS (U5) · มีแถวเดียว (id = 1) · ค่าเริ่มต้นตามคำตัดสิน: ถาม Owner / Admin หลังใช้ 30 วัน ซ้ำทุก 90 วัน สุ่ม 50%
 * exclude_*_days = null คือไม่ใช้เงื่อนไขนั้น · follow_ups = คำถามต่อตามกลุ่มคะแนน { detractor, passive, promoter }
 * topics = รหัสหัวข้อให้เลือก (ข้อความแสดงอยู่ในไฟล์ภาษาของเว็บ)
 */
export const npsSettings = pgTable('nps_settings', {
  id: smallint().primaryKey().default(1), enabled: boolean().notNull().default(true),
  audience: text().notNull().default('admins'),
  firstAfterDays: smallint().notNull().default(30), repeatDays: smallint().notNull().default(90), samplePct: smallint().notNull().default(50),
  excludeTrialDays: smallint().default(14), excludeTicketDays: smallint().default(7),
  excludeSpotlightDay: boolean().notNull().default(true), excludeShortMobile: boolean().notNull().default(true),
  question: text().notNull().default('คุณจะแนะนำ Friday Work Management ให้เพื่อนหรือเพื่อนร่วมงานไหม'), questionEn: text(),
  followUps: jsonb().notNull().default(sql`'{"detractor":"อะไรที่เราควรปรับให้ดีขึ้นที่สุด","passive":"อะไรที่จะทำให้ให้ 10 คะแนน","promoter":"ชอบอะไรที่สุด"}'::jsonb`),
  followUpsEn: jsonb(),
  topics: text().array().notNull().default(sql`'{speed,usability,missing_feature,price,mobile}'`),
  updatedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), updatedAt: updatedAt(),
}, (t) => [check('nps_settings_singleton', sql`${t.id} = 1`),
  check('nps_settings_audience_valid', oneOf(t.audience, ['admins', 'members'])),
  check('nps_settings_days', sql`${t.firstAfterDays} >= 0 AND ${t.repeatDays} >= 1 AND (${t.excludeTrialDays} IS NULL OR ${t.excludeTrialDays} >= 0) AND (${t.excludeTicketDays} IS NULL OR ${t.excludeTicketDays} >= 0)`),
  check('nps_settings_sample', sql`${t.samplePct} BETWEEN 0 AND 100`)]);

export const NPS_FOLLOW_UP_STATUSES = ['open', 'done'] as const;

/**
 * คำตอบ NPS (U3) · score null = ปิดโดยไม่ตอบ · role / plan จับค่าตอนตอบ · ลบบัญชีแล้ว user_id เป็น null (05 › 3)
 * ลูกค้าเพิ่มได้และอ่านได้เฉพาะแถวของตัวเอง (เฉพาะคอลัมน์ที่ grant) · tags / note / การติดตาม (U6) เป็นของทีม Friday
 * เก็บ 25 เดือนเท่า product_events แล้วงานเบื้องหลังลบ
 */
export const npsResponses = pgTable('nps_responses', {
  id: pk(), workspaceId: workspaceId(),
  userId: uuid().references(() => users.id, { onDelete: 'set null' }),
  role: workspaceRole().notNull(), plan: text(),
  score: smallint(), comment: text(), topics: text().array().notNull().default(sql`'{}'`),
  /** หัวข้อที่ทีม Friday ใส่ตอนติดตาม เช่น "ความเร็ว Gantt" */
  tags: text().array().notNull().default(sql`'{}'`),
  followUpStatus: text().notNull().default('open'),
  followedUpBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), followedUpAt: tstz(),
  /** Ticket ติดตามที่ทีมเปิด (U6) */
  ticketId: uuid(),
  /** บันทึกภายใน */
  note: text(),
  createdAt: createdAt(),
}, (t) => [index('nps_responses_workspace_idx').on(t.workspaceId, t.createdAt), index('nps_responses_created_idx').on(t.createdAt),
  foreignKey({ name: 'nps_responses_ticket_fk', columns: [t.workspaceId, t.ticketId], foreignColumns: [supportTickets.workspaceId, supportTickets.id] }),
  check('nps_responses_score_range', sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 10`),
  check('nps_responses_dismissed', sql`${t.score} IS NOT NULL OR (${t.comment} IS NULL AND cardinality(${t.topics}) = 0)`),
  check('nps_responses_comment_length', sql`${t.comment} IS NULL OR char_length(${t.comment}) <= 2000`),
  check('nps_responses_follow_up_valid', oneOf(t.followUpStatus, NPS_FOLLOW_UP_STATUSES))]);

/**
 * ขั้น Onboarding ที่เสร็จแล้ว (บันทึกครั้งแรกที่เสร็จ ไม่ย้อนกลับ) · user_id null = ขั้นของ Workspace · มีค่า = ขั้นส่วนตัวของสมาชิก (V3)
 * step = รหัสขั้นในโค้ดของ API (เช่น first_project, tasks_10, members_3) · version = เวอร์ชันชุดขั้นในโค้ดตอนที่เสร็จ
 * meta = ตัวเลขประกอบเท่านั้น เช่น { via: 'import', count: 46 } · ห้ามมีเนื้อหาของลูกค้า
 */
export const onboardingProgress = pgTable('onboarding_progress', {
  id: pk(), workspaceId: workspaceId(),
  userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
  version: smallint().notNull().default(1), step: text().notNull(),
  doneAt: tstz().notNull().defaultNow(), meta: jsonb().notNull().default(sql`'{}'::jsonb`),
}, (t) => [unique('onboarding_progress_step_key').on(t.workspaceId, t.userId, t.version, t.step).nullsNotDistinct(),
  index('onboarding_progress_done_idx').on(t.doneAt)]);

/** การ์ดเริ่มต้นใช้งานต่อคน (V1, V2, V4) · hidden_at = ซ่อนจาก Home · never = "ไม่ต้องแสดงอีก" · completion_seen_at = เห็นการ์ดเขียวแล้ว */
export const onboardingDismissals = pgTable('onboarding_dismissals', {
  workspaceId: workspaceId(), userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  hiddenAt: tstz(), never: boolean().notNull().default(false), completionSeenAt: tstz(), updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })]);

export const ONBOARDING_FOLLOWUP_STATUSES = ['open', 'emailed', 'no_reply', 'replied', 'done'] as const;

/**
 * ทีม Friday ติดตาม Workspace ที่ติด (V5) · 1 แถวต่อ Workspace · ส่งอีเมลได้ 1 ครั้งต่อ 7 วัน (ตรวจจาก last_emailed_at)
 * เนื้ออีเมลและผลการส่งอยู่ในประวัติการส่ง (O23) และ staff_audit_logs
 */
export const onboardingFollowups = pgTable('onboarding_followups', {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  assigneeId: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  status: text().notNull().default('open'), note: text(),
  lastEmailedAt: tstz(), emailsSent: integer().notNull().default(0),
  updatedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('onboarding_followups_assignee_idx').on(t.assigneeId),
  check('onboarding_followups_status_valid', oneOf(t.status, ONBOARDING_FOLLOWUP_STATUSES))]);
