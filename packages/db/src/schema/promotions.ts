// O20 · แพ็กเกจและโปรโมชัน: ราคาแบบมีเวอร์ชัน (grandfathering) และคูปองส่วนลด · เงินเป็นสตางค์
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { invoices, plans } from './billing.ts';
import { users } from './identity.ts';
import { approvalRequests, staffUsers } from './ops.ts';
import { workspaceId } from './project.ts';
import { tenantFk, tenantKey } from './saas-common.ts';

/**
 * เวอร์ชันราคาและการแสดงผลของแพ็กเกจ (P1) · แก้ / ลบไม่ได้ · ราคา null = ใช้ค่าตั้งต้นในโค้ด (billing/catalog.ts)
 * ลูกค้าเดิมผูกกับเวอร์ชันที่จ่ายล่าสุด (`subscriptions.price_version_id`) จนกว่าจะเลือกย้ายแพ็กเกจ
 * `existing_policy = next_cycle`: ลูกค้าเดิมย้ายมาราคานี้ในรอบที่ออกใบแจ้งหนี้ตั้งแต่ `existing_from` (แจ้งล่วงหน้า 30 วัน)
 */
export const planPriceVersions = pgTable('plan_price_versions', {
  id: pk(), planCode: text().notNull().references(() => plans.code), version: integer().notNull(),
  displayName: text(), monthlySatang: bigint({ mode: 'number' }), yearlySatang: bigint({ mode: 'number' }),
  listed: boolean().notNull().default(true), openForSignup: boolean().notNull().default(true),
  existingPolicy: text().notNull().default('grandfather'), existingFrom: tstz(),
  effectiveAt: tstz().notNull(), reason: text().notNull(),
  createdBy: uuid().references(() => staffUsers.id), approvedBy: uuid().references(() => staffUsers.id),
  approvalRequestId: uuid().references(() => approvalRequests.id),
  createdAt: createdAt(),
}, (t) => [unique('plan_price_versions_plan_version_key').on(t.planCode, t.version),
  check('plan_price_versions_version_positive', sql`${t.version} > 0`),
  check('plan_price_versions_prices_nonnegative', sql`(${t.monthlySatang} IS NULL OR ${t.monthlySatang} >= 0) AND (${t.yearlySatang} IS NULL OR ${t.yearlySatang} >= 0)`),
  check('plan_price_versions_policy_valid', sql`${t.existingPolicy} IN ('grandfather', 'next_cycle') AND (${t.existingPolicy} = 'grandfather' OR ${t.existingFrom} IS NOT NULL)`)]);

/**
 * คูปอง / โค้ดส่วนลด (P4) · โค้ดเก็บเป็นตัวพิมพ์ใหญ่ · ร่าง → เปิด → ปิด (ปิดแล้วคนที่ใช้อยู่ยังได้ส่วนลดครบรอบ)
 * `kind`: percent (value = %) · amount (value = สตางค์ต่อรอบบิล) · free_months (value = จำนวนเดือน · ครั้งเดียวเสมอ)
 * `duration`: once · repeating (`duration_cycles` รอบบิลแรก) · forever
 */
export const coupons = pgTable('coupons', {
  id: pk(), code: text().notNull().unique(), description: text(),
  kind: text().notNull(), value: integer().notNull(),
  duration: text().notNull(), durationCycles: integer(),
  /** แพ็กเกจที่ใช้ได้ (plans.code) */
  planCodes: text().array().notNull(),
  /** null = ไม่จำกัดจำนวนสิทธิ์ */
  maxRedemptions: integer(),
  /** ใช้โค้ดได้ถึงสิ้นวันนี้ (เวลาไทย) · null = ไม่หมดอายุ */
  expiresOn: date(),
  newCustomersOnly: boolean().notNull().default(false), stackable: boolean().notNull().default(false),
  status: text().notNull().default('draft'),
  createdBy: uuid().notNull().references(() => staffUsers.id),
  activatedAt: tstz(), activatedBy: uuid().references(() => staffUsers.id),
  disabledAt: tstz(), disabledBy: uuid().references(() => staffUsers.id), disableReason: text(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('coupons_code_format', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'`),
  check('coupons_kind_valid', sql`${t.kind} IN ('percent', 'amount', 'free_months')`),
  check('coupons_value_valid', sql`${t.value} > 0 AND (${t.kind} <> 'percent' OR ${t.value} <= 100) AND (${t.kind} <> 'free_months' OR ${t.value} <= 24)`),
  check('coupons_duration_valid', sql`${t.duration} IN ('once', 'repeating', 'forever') AND (${t.duration} = 'repeating') = (${t.durationCycles} IS NOT NULL) AND (${t.durationCycles} IS NULL OR ${t.durationCycles} BETWEEN 1 AND 36)`),
  check('coupons_free_months_once', sql`${t.kind} <> 'free_months' OR (${t.duration} = 'once' AND NOT ${t.stackable})`),
  check('coupons_plans_present', sql`cardinality(${t.planCodes}) > 0`),
  check('coupons_max_positive', sql`${t.maxRedemptions} IS NULL OR ${t.maxRedemptions} > 0`),
  check('coupons_status_valid', sql`${t.status} IN ('draft', 'active', 'disabled')`)]);

/**
 * Workspace ที่ใช้คูปอง (1 คูปองต่อ 1 Workspace) · pending = ใส่โค้ดแล้วแต่ยังไม่ชำระ · active = ได้ส่วนลดอยู่ · ended = ครบรอบแล้ว
 * `cycles_total` จับค่าตอนใช้ (null = ตลอดไป) ทีมแก้คูปองทีหลังไม่กระทบคนที่ใช้แล้ว
 */
export const couponRedemptions = pgTable('coupon_redemptions', {
  id: pk(), workspaceId: workspaceId(), couponId: uuid().notNull().references(() => coupons.id),
  status: text().notNull().default('pending'), cyclesTotal: integer(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(), activatedAt: tstz(), endedAt: tstz(), updatedAt: updatedAt(),
}, (t) => [tenantKey('coupon_redemptions', t), unique('coupon_redemptions_workspace_coupon_key').on(t.workspaceId, t.couponId),
  index('coupon_redemptions_coupon_idx').on(t.couponId, t.status),
  check('coupon_redemptions_status_valid', sql`${t.status} IN ('pending', 'active', 'ended')`)]);

/** ส่วนลดของคูปองในใบแจ้งหนี้แต่ละใบ · paid = นับเป็น 1 รอบที่ใช้ไป (ใบที่ไม่ได้ชำระไม่นับ) */
export const couponUses = pgTable('coupon_uses', {
  id: pk(), workspaceId: workspaceId(), redemptionId: uuid().notNull(), couponId: uuid().notNull().references(() => coupons.id),
  invoiceId: uuid().notNull(), amount: bigint({ mode: 'number' }).notNull(),
  status: text().notNull().default('pending'), createdAt: createdAt(), paidAt: tstz(),
}, (t) => [tenantFk('coupon_uses_redemption_fk', t.workspaceId, t.redemptionId, couponRedemptions).onDelete('cascade'),
  tenantFk('coupon_uses_invoice_fk', t.workspaceId, t.invoiceId, invoices).onDelete('cascade'),
  uniqueIndex('coupon_uses_invoice_redemption_key').on(t.invoiceId, t.redemptionId),
  index('coupon_uses_coupon_idx').on(t.couponId, t.status),
  check('coupon_uses_amount_nonnegative', sql`${t.amount} >= 0`),
  check('coupon_uses_status_valid', sql`${t.status} IN ('pending', 'paid')`)]);
