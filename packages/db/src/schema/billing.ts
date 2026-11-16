// M. เงินเก็บเป็นสตางค์ bigint · ยังไม่ตั้งราคาจริงใน seed
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { users } from './identity.ts';
import { staffUsers } from './ops.ts';
import { workspaceId } from './project.ts';
import { tenantFk, tenantKey } from './saas-common.ts';
import { billingCycle, branchType, invoiceStatus, paymentMethod, paymentStatus, subscriptionStatus } from './saas-enums.ts';
import { workspaces } from './workspace.ts';

export const plans = pgTable('plans', {
  id: pk(), code: text().notNull().unique(), seatLimit: integer(), storageGbPerMember: integer(),
  features: jsonb().notNull().default(sql`'{}'::jsonb`),
  priceMonthlySatang: bigint({ mode: 'number' }), priceYearlySatang: bigint({ mode: 'number' }),
  /** ชื่อที่แสดง / หน้าราคา / เปิดให้สมัครใหม่ ตามเวอร์ชันราคาล่าสุด (O20 · P1) · null = ชื่อตั้งต้นในโค้ด */
  displayName: text(), listed: boolean().notNull().default(true), openForSignup: boolean().notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('plans_limits_positive', sql`(${t.seatLimit} IS NULL OR ${t.seatLimit} > 0) AND (${t.storageGbPerMember} IS NULL OR ${t.storageGbPerMember} > 0)`),
  check('plans_prices_nonnegative', sql`(${t.priceMonthlySatang} IS NULL OR ${t.priceMonthlySatang} >= 0) AND (${t.priceYearlySatang} IS NULL OR ${t.priceYearlySatang} >= 0)`)]);

export const subscriptions = pgTable('subscriptions', {
  id: pk(), workspaceId: workspaceId().unique(), planId: uuid().notNull().references(() => plans.id),
  cycle: billingCycle().notNull().default('monthly'), status: subscriptionStatus().notNull().default('trialing'),
  trialEndsAt: tstz(), currentPeriodStart: tstz(), currentPeriodEnd: tstz(), paymentMethod: paymentMethod(),
  stripeCustomerId: text(), stripeSubscriptionId: text(),
  discount: jsonb().notNull().default(sql`'{}'::jsonb`),
  /** ใบแจ้งหนี้ที่เปิดสิทธิ์ปัจจุบัน (ชำระแล้วหรือเปิดชั่วคราวระหว่างรอตรวจสลิป) · ใช้ตัดสินว่าใบไหนแทนใบไหน (N01/N02) */
  sourceInvoiceId: uuid(),
  /** ลดแพ็กเกจที่ตั้งไว้ให้มีผลเมื่อจบรอบบิลปัจจุบัน (C4 · ลดแพ็กเกจมีผลรอบถัดไปเสมอ) · null = ไม่มี */
  pendingPlanId: uuid().references(() => plans.id), pendingCycle: billingCycle(),
  /** เวอร์ชันราคาที่ลูกค้าจ่ายล่าสุด (plan_price_versions · O20 grandfathering) · null = ก่อนมีเวอร์ชัน */
  priceVersionId: uuid(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('subscriptions', t), check('subscriptions_dates', sql`${t.currentPeriodEnd} >= ${t.currentPeriodStart}`)]);

export const billingProfiles = pgTable('billing_profiles', {
  id: pk(), workspaceId: workspaceId().unique(), companyName: text().notNull(), taxId: text().notNull(),
  branchType: branchType().notNull().default('head'), branchNo: text(), address: text().notNull(), taxEmail: text().notNull(),
  whtEnabled: boolean().notNull().default(false), createdAt: createdAt(), updatedAt: updatedAt(),
});

export const invoices = pgTable('invoices', {
  id: pk(), workspaceId: workspaceId(), subscriptionId: uuid().notNull(), number: text().notNull().unique(),
  periodStart: date().notNull(), periodEnd: date().notNull(),
  subtotal: bigint({ mode: 'number' }).notNull(), vat: bigint({ mode: 'number' }).notNull(), total: bigint({ mode: 'number' }).notNull(),
  whtAmount: bigint({ mode: 'number' }).notNull().default(0), amountDue: bigint({ mode: 'number' }).notNull(),
  /** ส่วนลดคูปองที่หักจากราคาแพ็กเกจแล้ว (O20) · subtotal = ราคาหลังหักส่วนลด ก่อน VAT */
  discount: bigint({ mode: 'number' }).notNull().default(0),
  /** เครดิตของ Workspace ที่ใช้ชำระใบนี้ (รอบ 4 · R) · ไม่ใช่ส่วนลด: subtotal / VAT ไม่เปลี่ยน · amount_due หักส่วนนี้แล้ว */
  creditApplied: bigint({ mode: 'number' }).notNull().default(0),
  poNumber: text(), status: invoiceStatus().notNull().default('open'), dueDate: date().notNull(), paidAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('invoices', t), tenantFk('invoices_subscription_fk', t.workspaceId, t.subscriptionId, subscriptions),
  index('invoices_workspace_status_idx').on(t.workspaceId, t.status), check('invoices_dates', sql`${t.periodEnd} >= ${t.periodStart}`),
  check('invoices_amounts_nonnegative', sql`${t.subtotal} >= 0 AND ${t.vat} >= 0 AND ${t.total} >= 0 AND ${t.whtAmount} >= 0 AND ${t.amountDue} >= 0`),
  check('invoices_discount_nonnegative', sql`${t.discount} >= 0`), check('invoices_credit_applied_nonnegative', sql`${t.creditApplied} >= 0`)]);

export const payments = pgTable('payments', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), method: paymentMethod().notNull(),
  amount: bigint({ mode: 'number' }).notNull(), providerRef: text(), slipFileKey: text(),
  status: paymentStatus().notNull().default('pending_review'), reviewedBy: uuid().references(() => staffUsers.id), reviewedAt: tstz(),
  /** ใครยืนยันเงินเข้า (Friday Ops เฟส 1) · null = ยังไม่ยืนยัน */
  verifiedBy: text(),
  /** เหตุที่ระบบยืนยันเองไม่ได้ · มีค่า = อยู่ในคิวกรณีผิดปกติ */
  exceptionReason: text(),
  /** ใบแจ้งหนี้ที่พนักงานผูกให้เมื่อเงินเข้าไม่ตรงใบเดิม */
  matchedInvoiceId: uuid(),
  /** เวลาที่เงินเข้าจริง (บัตร / PromptPay = เวลาที่ผู้ให้บริการยืนยัน · โอน = เวลาโอนที่ลูกค้าแจ้งตอนแนบสลิป) · วันที่ของใบกำกับภาษี = วันนี้ */
  paidAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantFk('payments_invoice_fk', t.workspaceId, t.invoiceId, invoices),
  tenantFk('payments_matched_invoice_fk', t.workspaceId, t.matchedInvoiceId, invoices),
  index('payments_exception_idx').on(t.exceptionReason).where(sql`${t.exceptionReason} IS NOT NULL`),
  check('payments_verified_by_valid', sql`${t.verifiedBy} IS NULL OR ${t.verifiedBy} IN ('webhook', 'bank', 'slip_api', 'staff')`),
  check('payments_exception_reason_valid', sql`${t.exceptionReason} IS NULL OR ${t.exceptionReason} IN ('amount_mismatch', 'wht_not_declared', 'duplicate_slip', 'payer_name_mismatch', 'unmatched', 'double_payment', 'wht_certificate', 'unreadable_slip')`),
  uniqueIndex('payments_provider_ref_key').on(t.method, t.providerRef), index('payments_invoice_idx').on(t.invoiceId),
  check('payments_amount_positive', sql`${t.amount} > 0`)]);

export const taxDocuments = pgTable('tax_documents', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), docType: text().notNull(),
  number: text().notNull().unique(), providerRef: text(), status: text().notNull().default('pending'), sentAt: tstz(),
  /** วันที่ของใบกำกับภาษี = วันที่ได้รับเงิน (ม.86/4(7)) · null = เอกสารก่อนมีคอลัมน์นี้ ใช้ invoices.paid_at */
  issuedOn: date(),
  /** ฉบับใหม่ที่ออกแทนฉบับที่ยกเลิก (ข้อมูลผู้ซื้อผิด) · ชี้ไปฉบับเดิม */
  replacesId: uuid(),
  /** ยกเลิกแล้ว (status = 'cancelled') · เก็บเหตุผลไว้แสดงในรายงานภาษีขายและฉบับใหม่ */
  cancelledAt: tstz(), cancelReason: text(),
  /** ข้อมูลผู้ซื้อ ณ วันที่ออก (ชื่อ เลขผู้เสียภาษี สาขา ที่อยู่) · ลูกค้าแก้ข้อมูลภาษีภายหลัง เอกสารเดิมต้องไม่เปลี่ยนตาม · null = เอกสารเก่า ใช้ข้อมูลปัจจุบัน */
  buyer: jsonb(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantFk('tax_documents_invoice_fk', t.workspaceId, t.invoiceId, invoices), index('tax_documents_invoice_idx').on(t.invoiceId)]);

/** ใบเสนอราคา (ไม่ใช่เอกสารภาษี) · เก็บไว้ให้ใบแจ้งหนี้อ้างอิงและตรวจย้อนได้ว่าเสนอราคาอะไรไป */
export const quotations = pgTable('quotations', {
  id: pk(), workspaceId: workspaceId(), number: text().notNull().unique(), plan: text().notNull(), cycle: billingCycle().notNull(),
  wht: boolean().notNull().default(false), coupon: text(),
  subtotal: bigint({ mode: 'number' }).notNull(), discount: bigint({ mode: 'number' }).notNull().default(0), vat: bigint({ mode: 'number' }).notNull(),
  total: bigint({ mode: 'number' }).notNull(), whtAmount: bigint({ mode: 'number' }).notNull().default(0), amountDue: bigint({ mode: 'number' }).notNull(),
  validUntil: date().notNull(), createdBy: uuid().references(() => users.id), createdAt: createdAt(),
}, (t) => [tenantKey('quotations', t), index('quotations_workspace_idx').on(t.workspaceId)]);

/**
 * 50 ทวิ ของใบแจ้งหนี้ · status: pending_review | confirmed | rejected | pending_ewht | uncollected
 * source: upload = ลูกค้าอัปโหลดไฟล์ · ewht = ลูกค้าแจ้งว่าหักผ่าน e-Withholding Tax (ไม่มีไฟล์) · ops = ทีมบันทึก (เช่น ปิดว่าไม่ได้รับ)
 */
export const whtCertificates = pgTable('wht_certificates', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), fileKey: text(),
  uploadedBy: uuid().references(() => users.id), status: text().notNull().default('pending_review'),
  reviewedBy: uuid().references(() => staffUsers.id),
  source: text().notNull().default('upload'),
  /** สาเหตุที่ไม่ผ่าน (ลูกค้าเห็น) หรือเหตุผลที่ปิดว่าไม่ได้รับ */
  rejectReason: text(),
  /** เลขอ้างอิง e-WHT ที่ลูกค้าแจ้ง / ที่ได้จากไฟล์สรรพากร */
  ewhtRef: text(), decidedAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantFk('wht_certificates_invoice_fk', t.workspaceId, t.invoiceId, invoices), index('wht_certificates_invoice_idx').on(t.invoiceId),
  check('wht_certificates_source_valid', sql`${t.source} IN ('upload', 'ewht', 'ops')`),
  check('wht_certificates_file_when_upload', sql`${t.source} <> 'upload' OR ${t.fileKey} IS NOT NULL`)]);

export const legalDocuments = pgTable('legal_documents', {
  id: pk(), docType: text().notNull(), version: text().notNull(), effectiveAt: tstz().notNull(),
  summary: text().notNull(), body: text().notNull(), locale: text().notNull().default('th'),
  /** true = เปลี่ยนสาระสำคัญ ผู้ใช้ต้องกดยอมรับใหม่ · false = แจ้งให้ทราบ (แบนเนอร์) อย่างเดียว (O05) */
  requiresAcceptance: boolean().notNull().default(true),
  /** แจ้งลูกค้าทางอีเมล (รอบ 4 · H14) · null = ไม่ส่ง · all = ผู้ใช้ทุกคนที่ใช้งานอยู่ · admins = Owner และ Admin */
  notifyAudience: text(), notifyAt: tstz(), remindAt: tstz(), notifiedAt: tstz(), remindedAt: tstz(),
  /** แสดงแบนเนอร์ในแอปตั้งแต่เผยแพร่ถึงวันที่มีผล */
  notifyBanner: boolean().notNull().default(true),
  /** พนักงานที่สร้างเวอร์ชัน · null = seed / ก่อนมีหลังบ้าน */
  createdByStaff: uuid(), createdAt: createdAt(),
}, (t) => [uniqueIndex('legal_documents_version_key').on(t.docType, t.version, t.locale),
  check('legal_documents_notify_audience_valid', sql`${t.notifyAudience} IS NULL OR ${t.notifyAudience} IN ('all', 'admins')`)]);

/** อีเมลแจ้งเอกสารกฎหมายฉบับใหม่ทีละผู้ใช้ (รอบ 4 · H15) · กันส่งซ้ำและนับส่งแล้ว / ตีกลับ */
export const legalNotices = pgTable('legal_notices', {
  id: pk(), documentId: uuid().notNull().references(() => legalDocuments.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }), email: text().notNull(),
  kind: text().notNull(), status: text().notNull(), error: text(), sentAt: createdAt(),
}, (t) => [unique('legal_notices_once_key').on(t.documentId, t.userId, t.kind),
  check('legal_notices_kind_valid', sql`${t.kind} IN ('notice', 'reminder')`),
  check('legal_notices_status_valid', sql`${t.status} IN ('sent', 'failed', 'suppressed')`)]);

export const legalAcceptances = pgTable('legal_acceptances', {
  id: pk(), userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  // ยอมรับเงื่อนไขตอนสมัครได้ก่อนมี Workspace
  workspaceId: uuid().references(() => workspaces.id, { onDelete: 'cascade' }),
  documentId: uuid().notNull().references(() => legalDocuments.id), acceptedAt: tstz().notNull().defaultNow(), ip: text(),
  createdAt: createdAt(),
}, (t) => [unique('legal_acceptances_user_document_key').on(t.userId, t.documentId, t.workspaceId).nullsNotDistinct()]);
