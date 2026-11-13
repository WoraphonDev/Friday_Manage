// O32 · ศูนย์ช่วยเหลือ (03 · X1–X9) และการส่งบั๊กจาก Ticket ให้ทีมพัฒนา (04 · T7–T11) · ทีม Friday เขียน ลูกค้าอ่านเฉพาะที่เผยแพร่
import { type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { staffUsers, supportTickets } from './ops.ts';

const oneOf = (col: AnyPgColumn, values: readonly string[]) => sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

export const HELP_ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
/** public = ทุกคนรวมหน้าสาธารณะ /help · signed_in = เฉพาะผู้ที่เข้าสู่ระบบ (RLS ตรวจจาก app.user_id) */
export const HELP_VISIBILITIES = ['public', 'signed_in'] as const;

/** หมวดของศูนย์ช่วยเหลือ (X9) · ลบได้เมื่อไม่มีบทความ (FK ของ help_articles ไม่ cascade) */
export const helpCategories = pgTable('help_categories', {
  id: pk(), slug: text().notNull().unique(), name: text().notNull(), nameEn: text(),
  position: integer().notNull().default(0), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('help_categories_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`)]);

/**
 * บทความ (19b) · เนื้อหาเป็น Markdown + กล่องเตือน · คอลัมน์หลักคือฉบับที่เผยแพร่อยู่
 * แก้บทความที่เผยแพร่แล้ว: บันทึกอัตโนมัติลง `draft` ก่อน กดเผยแพร่จึงคัดลอกเข้าคอลัมน์หลักและเก็บเวอร์ชันใน help_article_versions
 * ลูกค้าอ่านได้เฉพาะคอลัมน์ที่ grant ไว้ (ไม่รวม draft และข้อมูลภายใน) จึงต้องเลือกคอลัมน์เองเสมอ ห้าม select ทั้งแถวจาก API ลูกค้า
 * ค้นหาใช้ pg_trgm บน `search_text` แบบเดียวกับค้นหางาน (A22) เพราะ tsvector ของ PostgreSQL ตัดคำภาษาไทยไม่ได้
 */
export const helpArticles = pgTable('help_articles', {
  id: pk(), slug: text().notNull().unique(),
  categoryId: uuid().notNull().references(() => helpCategories.id),
  title: text().notNull(), summary: text(), body: text().notNull().default(''),
  titleEn: text(), summaryEn: text(), bodyEn: text(),
  status: text().notNull().default('draft'), visibility: text().notNull().default('public'),
  /** หน้าในแอปที่เกี่ยวข้อง เช่น gantt · kanban · import · admin.trash (แนะนำในแผง X4) */
  appRoutes: text().array().notNull().default(sql`'{}'`),
  /** คำค้นเพิ่ม คั่นด้วยจุลภาคตามที่พิมพ์ในตัวแก้ เช่น "trash, restore, เอากลับ" */
  keywords: text(),
  /** วันทบทวนอีกครั้ง · เลยวันนี้ = "ต้องทบทวน" */
  reviewAt: date(),
  /** ผู้ดูแลบทความ */
  ownerId: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  /** สร้างจาก Ticket (X8) */
  sourceTicketId: uuid().references(() => supportTickets.id, { onDelete: 'set null' }),
  /** ติ๊ก "ตรวจแล้วไม่มีข้อมูลลูกค้า" · ต้องมีก่อนเผยแพร่ */
  piiCheckedAt: tstz(), piiCheckedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  /** ร่างที่ยังไม่เผยแพร่ของบทความที่เผยแพร่แล้ว { title, summary, body, title_en, summary_en, body_en, … } · null = ไม่มีร่างค้าง */
  draft: jsonb(), draftSavedAt: tstz(),
  /** เลขเวอร์ชันที่เผยแพร่ล่าสุด · 0 = ยังไม่เคยเผยแพร่ */
  version: integer().notNull().default(0),
  publishedAt: tstz(),
  searchText: text().generatedAlwaysAs((): SQL => sql`lower(${helpArticles.title} || ' ' || coalesce(${helpArticles.summary}, '') || ' ' || coalesce(${helpArticles.keywords}, '') || ' ' || coalesce(${helpArticles.titleEn}, '') || ' ' || coalesce(${helpArticles.summaryEn}, '') || ' ' || ${helpArticles.body} || ' ' || coalesce(${helpArticles.bodyEn}, ''))`),
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  updatedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('help_articles_category_idx').on(t.categoryId, t.status),
  index('help_articles_search_trgm_idx').using('gin', t.searchText.op('gin_trgm_ops')),
  index('help_articles_routes_idx').using('gin', t.appRoutes),
  check('help_articles_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,79}$'`),
  check('help_articles_status_valid', oneOf(t.status, HELP_ARTICLE_STATUSES)),
  check('help_articles_visibility_valid', oneOf(t.visibility, HELP_VISIBILITIES)),
  check('help_articles_published', sql`${t.status} <> 'published' OR (${t.publishedAt} IS NOT NULL AND ${t.piiCheckedAt} IS NOT NULL AND ${t.version} > 0)`)]);

/** ทุกการเผยแพร่เก็บเวอร์ชัน · ย้อนกลับ = เผยแพร่เวอร์ชันเดิมเป็นเวอร์ชันใหม่ */
export const helpArticleVersions = pgTable('help_article_versions', {
  id: pk(), articleId: uuid().notNull().references(() => helpArticles.id, { onDelete: 'cascade' }),
  version: integer().notNull(), categoryId: uuid(), title: text().notNull(), summary: text(), body: text().notNull(),
  titleEn: text(), summaryEn: text(), bodyEn: text(), visibility: text().notNull(),
  appRoutes: text().array().notNull().default(sql`'{}'`), keywords: text(),
  publishedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(),
}, (t) => [uniqueIndex('help_article_versions_article_version_key').on(t.articleId, t.version)]);

/** โหวต "ช่วยได้ไหม" (X3) · ไม่เก็บผู้ใช้หรือ Workspace · ลูกค้าเพิ่มได้อย่างเดียวและเฉพาะบทความที่ตัวเองเห็น */
export const helpFeedback = pgTable('help_feedback', {
  id: pk(), articleId: uuid().notNull().references(() => helpArticles.id, { onDelete: 'cascade' }),
  helpful: boolean().notNull(), comment: text(), createdAt: createdAt(),
}, (t) => [index('help_feedback_article_idx').on(t.articleId, t.createdAt),
  check('help_feedback_comment_length', sql`${t.comment} IS NULL OR char_length(${t.comment}) <= 2000`)]);

/** ยอดอ่านต่อบทความต่อวัน (เวลาไทย) · "อ่าน 30 วัน" ใน 19 และบทความยอดนิยมใน X1 · เพิ่มผ่าน app.record_help_view() */
export const helpArticleViews = pgTable('help_article_views', {
  articleId: uuid().notNull().references(() => helpArticles.id, { onDelete: 'cascade' }),
  day: date().notNull(), views: integer().notNull().default(0),
}, (t) => [primaryKey({ columns: [t.articleId, t.day] })]);

/** ยอดค้นหาต่อวัน (ทั้งในแอปและหน้าสาธารณะ) · "ค้นหา 30 วัน" และสัดส่วนที่ไม่พบใน 19 · เพิ่มผ่าน app.record_help_search() */
export const helpSearchStats = pgTable('help_search_stats', {
  day: date().primaryKey(), searches: integer().notNull().default(0), misses: integer().notNull().default(0),
});

/**
 * คำค้นที่ไม่พบ (ไม่เก็บว่าใครค้น) · app.record_help_search() ตัดข้อความที่ดูเหมือนอีเมล / เบอร์โทรออกก่อนบันทึก
 * เก็บ 25 เดือนเท่า product_events แล้วงานเบื้องหลังลบ
 */
export const helpSearchMisses = pgTable('help_search_misses', {
  day: date().notNull(), query: text().notNull(), searches: integer().notNull().default(0),
  /** เปิด Ticket ต่อหลังค้นคำนี้ (A44 เพิ่มตอนลูกค้าส่งฟอร์ม X5 ที่มาจากผลค้นหาไม่พบ) */
  tickets: integer().notNull().default(0),
  /** บทความที่เขียนตอบคำค้นนี้แล้ว ("เขียนบทความ" ใน 19) */
  articleId: uuid().references(() => helpArticles.id, { onDelete: 'set null' }),
}, (t) => [primaryKey({ columns: [t.day, t.query] }), index('help_search_misses_query_idx').on(t.query)]);

export const HELP_ARTICLE_TICKET_SOURCES = ['customer', 'staff', 'created_from'] as const;

/** Ticket ที่อ้างถึงบทความ · customer = ลูกค้ากด "ติดต่อ Support พร้อมแนบบทความนี้" · staff = พนักงานแนบลิงก์ในคำตอบ · created_from = สร้างบทความจาก Ticket (X8) */
export const helpArticleTickets = pgTable('help_article_tickets', {
  articleId: uuid().notNull().references(() => helpArticles.id, { onDelete: 'cascade' }),
  ticketId: uuid().notNull().references(() => supportTickets.id, { onDelete: 'cascade' }),
  source: text().notNull(), createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.articleId, t.ticketId] }), index('help_article_tickets_ticket_idx').on(t.ticketId),
  check('help_article_tickets_source_valid', oneOf(t.source, HELP_ARTICLE_TICKET_SOURCES))]);

export const DEV_SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;
export const DEV_RESOLUTIONS = ['fixed', 'wont_fix', 'duplicate'] as const;

/**
 * งานในโปรเจกต์ FM ของทีมพัฒนา (Friday Work Management ของเราเอง · O36) ที่ผูกกับ Ticket · ข้อมูลล่าสุดจาก Webhook issue.updated / ดึงสำรองทุก 15 นาที
 * `issue_id` ไม่ใส่ FK เพราะ ops-api คุยกับงานนั้นผ่าน API token เหมือนระบบภายนอก (คนละ Workspace และอาจคนละฐานในอนาคต)
 * released_at = ย้ายเข้าสถานะ Released (หมวด Done) · พร้อมแจ้งลูกค้า (T9) เมื่อ released_at มีค่าและยังมี Ticket ที่ notified_at ว่าง
 */
export const devIssueLinks = pgTable('dev_issue_links', {
  id: pk(), issueKey: text().notNull().unique('dev_issue_links_issue_key_unique'), issueId: uuid(), title: text().notNull(),
  severity: text().notNull(), statusName: text(), statusCategory: text(),
  /** ปิดแบบไม่แก้ / ซ้ำ (T10) · duplicate_of_key = งานที่ซ้ำด้วย */
  resolution: text(), duplicateOfKey: text(),
  assigneeName: text(), sprintName: text(), dueDate: date(),
  doneAt: tstz(), releasedAt: tstz(), releaseVersion: text(), syncedAt: tstz(),
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('dev_issue_links_status_idx').on(t.statusCategory, t.severity),
  check('dev_issue_links_severity_valid', oneOf(t.severity, DEV_SEVERITIES)),
  check('dev_issue_links_category_valid', sql`${t.statusCategory} IS NULL OR ${oneOf(t.statusCategory, ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'])}`),
  check('dev_issue_links_resolution_valid', sql`${t.resolution} IS NULL OR ${oneOf(t.resolution, DEV_RESOLUTIONS)}`),
  check('dev_issue_links_duplicate', sql`${t.duplicateOfKey} IS NULL OR ${t.resolution} = 'duplicate'`)]);

export const DEV_TICKET_OUTCOMES = ['fixed', 'workaround', 'returned'] as const;

/**
 * Ticket ↔ งานของทีมพัฒนา · 1 Ticket ผูกได้ 1 งาน (เปลี่ยนงาน = แก้ link_id) · หลาย Ticket ผูกงานเดียวกันได้
 * notified_at = แจ้งลูกค้าแล้ว (T9 / T10) · outcome: fixed (แจ้งว่าแก้แล้ว) · workaround (ยังไม่แก้ + ทางเลี่ยง) · returned (คืน Support)
 */
export const devIssueTickets = pgTable('dev_issue_tickets', {
  ticketId: uuid().primaryKey().references(() => supportTickets.id, { onDelete: 'cascade' }),
  linkId: uuid().notNull().references(() => devIssueLinks.id, { onDelete: 'cascade' }),
  linkedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), linkedAt: tstz().notNull().defaultNow(),
  notifiedAt: tstz(), notifiedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), outcome: text(),
}, (t) => [index('dev_issue_tickets_link_idx').on(t.linkId),
  check('dev_issue_tickets_outcome_valid', sql`${t.outcome} IS NULL OR ${oneOf(t.outcome, DEV_TICKET_OUTCOMES)}`),
  check('dev_issue_tickets_notified', sql`${t.outcome} IS NULL OR ${t.outcome} = 'returned' OR ${t.notifiedAt} IS NOT NULL`)]);

/**
 * การเชื่อมต่อกับ Friday Work Management ของทีมพัฒนา (T11) · มีแถวเดียว (id = 1)
 * token / webhook secret เข้ารหัสก่อนเก็บ (`*_enc`) · `api_base_url` เป็น URL ภายในเครือข่าย Docker / VPS เช่น http://api:3001
 * `mapping` = { severityPriority: { S1: 'urgent', … }, releasedStatus: 'Released', label: 'from-support', issueType: 'Bug' }
 */
export const devBridgeSettings = pgTable('dev_bridge_settings', {
  id: smallint().primaryKey().default(1),
  apiBaseUrl: text(), workspaceSlug: text(), projectKey: text(),
  tokenEnc: text(), tokenHint: text(), tokenExpiresAt: tstz(), webhookSecretEnc: text(),
  mapping: jsonb().notNull().default(sql`'{"severityPriority":{"S1":"urgent","S2":"high","S3":"medium","S4":"low"},"releasedStatus":"Released","label":"from-support","issueType":"Bug"}'::jsonb`),
  lastWebhookAt: tstz(), lastTestAt: tstz(), lastTestOk: boolean(),
  updatedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), updatedAt: updatedAt(),
}, (t) => [check('dev_bridge_settings_singleton', sql`${t.id} = 1`)]);
