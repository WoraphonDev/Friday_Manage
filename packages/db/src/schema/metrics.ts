// ข้อมูลธุรกิจที่ต้องเก็บตั้งแต่วันเปิดตัว (docs/spec/05-business-metrics.md › 1) · props ห้ามมีเนื้อหาของลูกค้า
import { sql } from 'drizzle-orm';
import { bigint, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz } from './_common.ts';
import { users } from './identity.ts';
import { staffUsers } from './ops.ts';
import { workspaceId } from './project.ts';
import { workspaces } from './workspace.ts';

/** ช่องทางที่ผู้ใช้มาครั้งแรก (1:1) · เก็บแค่ host ของ referrer ไม่เก็บ URL เต็ม */
export const signupAttributions = pgTable('signup_attributions', {
  userId: uuid().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  utmSource: text(), utmMedium: text(), utmCampaign: text(), utmTerm: text(), referrerHost: text(), landingPath: text(),
  via: text().notNull().default('direct'), invitedByUserId: uuid(), invitedWorkspaceId: uuid(),
  firstSeenAt: tstz(), createdAt: createdAt(),
}, (t) => [check('signup_attributions_via_valid', sql`${t.via} IN ('direct', 'invited', 'ops_created')`)]);

/** ที่มาของ Workspace (คัดลอกจากผู้สร้างตอนสร้าง) */
export const workspaceAcquisitions = pgTable('workspace_acquisitions', {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  source: text(), medium: text(), campaign: text(), referrerHost: text(), via: text().notNull().default('signup'),
  /** Workspace ที่ผู้สร้างเคยถูกชวนเข้า · ใช้วัดการโตแบบไม่ต้องจ่ายค่าโฆษณา */
  referringWorkspaceId: uuid(), createdAt: createdAt(),
}, (t) => [index('workspace_acquisitions_source_idx').on(t.source),
  check('workspace_acquisitions_via_valid', sql`${t.via} IN ('signup', 'invited_user', 'sales', 'ops_created')`)]);

/** เหตุการณ์ในแอปที่หาจากตารางอื่นไม่ได้ · append-only · เก็บ 25 เดือน · แบ่ง partition รายเดือนเมื่อข้อมูลโต */
export const productEvents = pgTable('product_events', {
  id: pk(), workspaceId: workspaceId(),
  /** ไม่ใส่ FK · ลบบัญชีแล้วตั้งเป็น null ตาม 05 › 3 */
  userId: uuid(), name: text().notNull(), props: jsonb().notNull().default(sql`'{}'::jsonb`),
  occurredAt: tstz().notNull().defaultNow(),
}, (t) => [index('product_events_workspace_idx').on(t.workspaceId, t.occurredAt), index('product_events_name_idx').on(t.name, t.occurredAt)]);

/** ทุกครั้งที่ MRR ของ Workspace เปลี่ยน · append-only · MRR ก่อน VAT หลังส่วนลด รายปีหาร 12 */
export const subscriptionChanges = pgTable('subscription_changes', {
  id: pk(), workspaceId: workspaceId(), kind: text().notNull(),
  planFrom: text(), planTo: text(), seatsFrom: integer(), seatsTo: integer(),
  mrrBeforeSatang: bigint({ mode: 'number' }).notNull(), mrrAfterSatang: bigint({ mode: 'number' }).notNull(),
  actorKind: text().notNull(), actorId: uuid(), effectiveAt: tstz().notNull(), createdAt: createdAt(),
}, (t) => [index('subscription_changes_workspace_idx').on(t.workspaceId, t.effectiveAt), index('subscription_changes_kind_idx').on(t.kind, t.effectiveAt),
  check('subscription_changes_kind_valid', sql`${t.kind} IN ('new', 'upgrade', 'downgrade', 'seats_up', 'seats_down', 'cycle_change', 'cancel', 'reactivate', 'churn_payment')`),
  check('subscription_changes_actor_valid', sql`${t.actorKind} IN ('user', 'system', 'staff')`),
  check('subscription_changes_mrr_nonnegative', sql`${t.mrrBeforeSatang} >= 0 AND ${t.mrrAfterSatang} >= 0`)]);

/** คำตอบตอนกดยกเลิกแพ็กเกจ */
export const cancellationResponses = pgTable('cancellation_responses', {
  id: pk(), workspaceId: workspaceId(), userId: uuid(), reason: text().notNull(),
  missingFeature: text(), switchedTo: text(), detail: text(),
  offerShown: text().notNull().default('none'), outcome: text().notNull(), createdAt: createdAt(),
}, (t) => [index('cancellation_responses_created_idx').on(t.createdAt),
  check('cancellation_responses_reason_valid', sql`${t.reason} IN ('too_expensive', 'missing_feature', 'switched_tool', 'project_ended', 'hard_to_use', 'company_closed', 'other')`),
  check('cancellation_responses_offer_valid', sql`${t.offerShown} IN ('none', 'discount', 'pause')`),
  check('cancellation_responses_outcome_valid', sql`${t.outcome} IN ('canceled', 'kept')`)]);

/** ยอดใช้ต่อ Workspace ต่อวัน (job 01:00) · ใช้คิดต้นทุน */
export const dailyUsages = pgTable('daily_usages', {
  workspaceId: workspaceId(), date: date().notNull(),
  lineMessages: integer().notNull().default(0), emails: integer().notNull().default(0), webhookCalls: integer().notNull().default(0),
  storageBytes: bigint({ mode: 'number' }).notNull().default(0), apiCalls: integer().notNull().default(0),
  automationRuns: integer().notNull().default(0), activeUsers: integer().notNull().default(0),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.date] })]);

/** ต้นทุนต่อหน่วย (ทีม Friday ตั้งเอง) · ค่าเป็นสตางค์และมีทศนิยมได้ เช่น 0.42 บาท = 42 */
export const costRates = pgTable('cost_rates', {
  id: pk(), resource: text().notNull(), unitCostSatang: numeric({ precision: 12, scale: 4, mode: 'number' }),
  pct: numeric({ precision: 6, scale: 3, mode: 'number' }), effectiveFrom: date().notNull(),
  createdBy: uuid().references(() => staffUsers.id), createdAt: createdAt(),
}, (t) => [uniqueIndex('cost_rates_resource_from_key').on(t.resource, t.effectiveFrom),
  check('cost_rates_resource_valid', sql`${t.resource} IN ('line_message', 'email', 'storage_gb_month', 'payment_fee_card', 'payment_fee_promptpay', 'etax_doc', 'slip_check')`),
  check('cost_rates_one_value', sql`(${t.unitCostSatang} IS NULL) <> (${t.pct} IS NULL)`)]);

/** ค่าใช้จ่ายส่วนกลางรายเดือน (month = วันที่ 1 ของเดือน) */
export const infraCosts = pgTable('infra_costs', {
  month: date().notNull(), category: text().notNull(), amountSatang: bigint({ mode: 'number' }).notNull(), createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.month, t.category] }),
  check('infra_costs_category_valid', sql`${t.category} IN ('aws', 'tools', 'other')`),
  check('infra_costs_first_day', sql`extract(day from ${t.month}) = 1`)]);

/** ค่าการตลาดรายเดือนตามช่องทาง (ทีม Friday กรอก) · source ตรงกับ utm_source */
export const marketingCosts = pgTable('marketing_costs', {
  month: date().notNull(), source: text().notNull(), amountSatang: bigint({ mode: 'number' }).notNull(), note: text(), createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.month, t.source] }), check('marketing_costs_first_day', sql`extract(day from ${t.month}) = 1`)]);
