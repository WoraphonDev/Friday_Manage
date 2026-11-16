// M (ต่อ). เงินฝั่งหลังบ้าน: ใบลดหนี้ เครดิต และประวัติการตามหนี้ (Friday Ops เฟส 1 · O00)
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { invoices } from './billing.ts';
import { approvalRequests, staffUsers } from './ops.ts';
import { workspaceId } from './project.ts';
import { tenantFk, tenantKey } from './saas-common.ts';

/** ใบลดหนี้ · ทุกการคืนเงิน ให้เครดิตจากใบที่ชำระแล้ว หรือยกเลิกใบที่ออกใบกำกับแล้ว ต้องออกเอกสารนี้ ไม่ลบใบเดิม */
export const creditNotes = pgTable('credit_notes', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), number: text().notNull().unique(),
  kind: text().notNull(), amountSatang: bigint({ mode: 'number' }).notNull(), vatSatang: bigint({ mode: 'number' }).notNull().default(0),
  reason: text().notNull(), status: text().notNull().default('draft'),
  /** คืนเงินไปที่ไหน · null เมื่อไม่ได้คืนเงิน */
  refundMethod: text(), providerRef: text(),
  createdByStaff: uuid().references(() => staffUsers.id), approvalRequestId: uuid().references(() => approvalRequests.id),
  issuedAt: tstz(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('credit_notes', t), tenantFk('credit_notes_invoice_fk', t.workspaceId, t.invoiceId, invoices),
  index('credit_notes_invoice_idx').on(t.invoiceId),
  check('credit_notes_kind_valid', sql`${t.kind} IN ('refund', 'credit', 'void')`),
  check('credit_notes_status_valid', sql`${t.status} IN ('draft', 'issued', 'sent')`),
  check('credit_notes_refund_method_valid', sql`${t.refundMethod} IS NULL OR ${t.refundMethod} IN ('original', 'bank_transfer')`),
  check('credit_notes_amounts', sql`${t.amountSatang} > 0 AND ${t.vatSatang} >= 0`)]);

/**
 * ใบเพิ่มหนี้ (ม.86/9) · เก็บเงินขาดในใบกำกับภาษีที่ออกไปแล้ว · ออกจากหลังบ้านเท่านั้น
 * `invoiceId` = ใบแจ้งหนี้ของใบกำกับภาษีเดิม · `chargeInvoiceId` = ใบแจ้งหนี้ใบใหม่ที่ให้ลูกค้าจ่ายส่วนเพิ่ม
 */
export const debitNotes = pgTable('debit_notes', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), number: text().notNull().unique(),
  amountSatang: bigint({ mode: 'number' }).notNull(), vatSatang: bigint({ mode: 'number' }).notNull().default(0),
  reason: text().notNull(), status: text().notNull().default('issued'), chargeInvoiceId: uuid(),
  createdByStaff: uuid().references(() => staffUsers.id), approvalRequestId: uuid().references(() => approvalRequests.id),
  issuedAt: tstz(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('debit_notes', t), tenantFk('debit_notes_invoice_fk', t.workspaceId, t.invoiceId, invoices),
  index('debit_notes_invoice_idx').on(t.invoiceId),
  check('debit_notes_status_valid', sql`${t.status} IN ('issued', 'sent')`),
  check('debit_notes_amounts', sql`${t.amountSatang} > 0 AND ${t.vatSatang} >= 0`)]);

/** สมุดเครดิตของ Workspace · ยอดคงเหลือ = ผลรวม amount (บวก = ได้เครดิต · ลบ = ใช้หักใบแจ้งหนี้) */
export const workspaceCredits = pgTable('workspace_credits', {
  id: pk(), workspaceId: workspaceId(), amountSatang: bigint({ mode: 'number' }).notNull(), source: text().notNull(),
  creditNoteId: uuid(), invoiceId: uuid(), note: text(),
  createdByStaff: uuid().references(() => staffUsers.id), createdAt: createdAt(),
}, (t) => [index('workspace_credits_workspace_idx').on(t.workspaceId, t.createdAt),
  tenantFk('workspace_credits_credit_note_fk', t.workspaceId, t.creditNoteId, creditNotes),
  tenantFk('workspace_credits_invoice_fk', t.workspaceId, t.invoiceId, invoices),
  // applied = ใช้ชำระใบแจ้งหนี้ · refunded = คืนเครดิตเป็นเงิน · reversal = คืนเครดิตจากใบที่ยกเลิกหลังหักเครดิต (รอบ 4 · R)
  check('workspace_credits_source_valid', sql`${t.source} IN ('credit_note', 'overpayment', 'goodwill', 'applied', 'refunded', 'reversal')`),
  check('workspace_credits_nonzero', sql`${t.amountSatang} <> 0`),
  check('workspace_credits_applied_negative', sql`(${t.source} IN ('applied', 'refunded')) = (${t.amountSatang} < 0)`)]);

/** ประวัติการตามหนี้ (เตือนอัตโนมัติ, โทร, ระงับ) · ใช้แสดงในแท็บค้างชำระ */
export const dunningEvents = pgTable('dunning_events', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), step: text().notNull(), channel: text().notNull(),
  result: text(), byStaff: uuid().references(() => staffUsers.id), createdAt: createdAt(),
}, (t) => [tenantFk('dunning_events_invoice_fk', t.workspaceId, t.invoiceId, invoices), index('dunning_events_invoice_idx').on(t.invoiceId, t.createdAt),
  check('dunning_events_step_valid', sql`${t.step} IN ('invoice_sent', 'reminder', 'final_notice', 'call', 'extended', 'suspended', 'delete_notice')`),
  check('dunning_events_channel_valid', sql`${t.channel} IN ('email', 'line', 'phone', 'banner', 'system')`)]);

/**
 * คิวงานกับผู้ให้บริการ e-Tax (รอบ 4 · E) · 1 แถว = 1 การกระทำต่อเอกสาร 1 ฉบับ
 * doc_kind: tax_document | credit_note | debit_note · action: issue = ส่งออกเอกสาร · cancel = แจ้งยกเลิก
 * status: pending → submitted → done | failed · manual = ทีมบันทึกเองว่าทำที่ผู้ให้บริการแล้ว
 * สถานะของใบกำกับภาษียังอยู่ที่ tax_documents.status · ตารางนี้เก็บจำนวนครั้ง สาเหตุ และเวลาลองครั้งถัดไป
 */
export const etaxJobs = pgTable('etax_jobs', {
  id: pk(), workspaceId: workspaceId(), docKind: text().notNull(), docId: uuid().notNull(), action: text().notNull(),
  status: text().notNull().default('pending'), providerRef: text(), attempts: smallint().notNull().default(0),
  lastError: text(), lastAttemptAt: tstz(), nextAttemptAt: tstz(), note: text(),
  byStaff: uuid().references(() => staffUsers.id), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [unique('etax_jobs_doc_action_key').on(t.docKind, t.docId, t.action),
  index('etax_jobs_open_idx').on(t.status, t.nextAttemptAt).where(sql`${t.status} IN ('pending', 'submitted', 'failed')`),
  check('etax_jobs_doc_kind_valid', sql`${t.docKind} IN ('tax_document', 'credit_note', 'debit_note')`),
  check('etax_jobs_action_valid', sql`${t.action} IN ('issue', 'cancel')`),
  check('etax_jobs_status_valid', sql`${t.status} IN ('pending', 'submitted', 'done', 'failed', 'manual')`)]);

/** การขอ 50 ทวิ จากลูกค้าแต่ละครั้ง (รอบ 4 · E7) · auto_7 / auto_30 = งานอัตโนมัติหลังชำระ · manual = ทีมกดขอ */
export const whtRequests = pgTable('wht_requests', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), kind: text().notNull(),
  recipients: text().array().notNull().default(sql`'{}'`), message: text(),
  sentBy: uuid().references(() => staffUsers.id), createdAt: createdAt(),
}, (t) => [tenantFk('wht_requests_invoice_fk', t.workspaceId, t.invoiceId, invoices), index('wht_requests_invoice_idx').on(t.invoiceId, t.createdAt),
  check('wht_requests_kind_valid', sql`${t.kind} IN ('auto_7', 'auto_30', 'manual')`)]);
