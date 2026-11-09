// M (ต่อ). เงินฝั่งหลังบ้าน: ใบลดหนี้ เครดิต และประวัติการตามหนี้ (Friday Ops เฟส 1 · O00)
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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

/** สมุดเครดิตของ Workspace · ยอดคงเหลือ = ผลรวม amount (บวก = ได้เครดิต · ลบ = ใช้หักใบแจ้งหนี้) */
export const workspaceCredits = pgTable('workspace_credits', {
  id: pk(), workspaceId: workspaceId(), amountSatang: bigint({ mode: 'number' }).notNull(), source: text().notNull(),
  creditNoteId: uuid(), invoiceId: uuid(), note: text(),
  createdByStaff: uuid().references(() => staffUsers.id), createdAt: createdAt(),
}, (t) => [index('workspace_credits_workspace_idx').on(t.workspaceId, t.createdAt),
  tenantFk('workspace_credits_credit_note_fk', t.workspaceId, t.creditNoteId, creditNotes),
  tenantFk('workspace_credits_invoice_fk', t.workspaceId, t.invoiceId, invoices),
  check('workspace_credits_source_valid', sql`${t.source} IN ('credit_note', 'overpayment', 'goodwill', 'applied')`),
  check('workspace_credits_nonzero', sql`${t.amountSatang} <> 0`),
  check('workspace_credits_applied_negative', sql`(${t.source} = 'applied') = (${t.amountSatang} < 0)`)]);

/** ประวัติการตามหนี้ (เตือนอัตโนมัติ, โทร, ระงับ) · ใช้แสดงในแท็บค้างชำระ */
export const dunningEvents = pgTable('dunning_events', {
  id: pk(), workspaceId: workspaceId(), invoiceId: uuid().notNull(), step: text().notNull(), channel: text().notNull(),
  result: text(), byStaff: uuid().references(() => staffUsers.id), createdAt: createdAt(),
}, (t) => [tenantFk('dunning_events_invoice_fk', t.workspaceId, t.invoiceId, invoices), index('dunning_events_invoice_idx').on(t.invoiceId, t.createdAt),
  check('dunning_events_step_valid', sql`${t.step} IN ('invoice_sent', 'reminder', 'final_notice', 'call', 'extended', 'suspended', 'delete_notice')`),
  check('dunning_events_channel_valid', sql`${t.channel} IN ('email', 'line', 'phone', 'banner', 'system')`)]);
