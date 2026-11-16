// เลขเอกสารการเงินและการออกใบกำกับภาษี / ใบเสร็จ · ใช้ร่วมกันระหว่าง API ลูกค้าและหลังบ้าน (ops-api) ให้กติกาเดียวกัน
import { and, eq, isNull, like, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import * as s from './schema/index.ts';

/** ข้อมูลผู้ซื้อที่พิมพ์บนเอกสารภาษี (เก็บไว้กับเอกสารตอนออก) */
export interface BuyerSnapshot { companyName: string; taxId: string; branchType: string; branchNo: string | null; address: string; email: string | null }
export async function buyerSnapshot(db: Db | Tx, workspaceId: string): Promise<BuyerSnapshot | null> {
  const [p] = await db.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, workspaceId));
  return p ? { companyName: p.companyName, taxId: p.taxId, branchType: p.branchType, branchNo: p.branchNo, address: p.address, email: p.taxEmail } : null;
}

export type DocKind = 'invoice' | 'tax_invoice' | 'receipt' | 'credit_note' | 'debit_note' | 'quotation';

const PREFIX: Record<DocKind, string> = { invoice: 'FRI', tax_invoice: 'TX', receipt: 'RC', credit_note: 'CN', debit_note: 'DN', quotation: 'QT' };
// ชื่อล็อกของใบแจ้งหนี้ / ใบลดหนี้ตรงกับโค้ดเดิม ระหว่าง deploy ทีละ service จะได้ต่อคิวเดียวกัน
const LOCK: Record<DocKind, string> = { invoice: 'invoice-number', tax_invoice: 'tax-document-number', receipt: 'tax-document-number', credit_note: 'credit-note-number', debit_note: 'debit-note-number', quotation: 'quotation-number' };
const COLUMN = {
  invoice: s.invoices.number,
  tax_invoice: s.taxDocuments.number,
  receipt: s.taxDocuments.number,
  credit_note: s.creditNotes.number,
  debit_note: s.debitNotes.number,
  quotation: s.quotations.number,
} as const;
const TABLE = { invoice: s.invoices, tax_invoice: s.taxDocuments, receipt: s.taxDocuments, credit_note: s.creditNotes, debit_note: s.debitNotes, quotation: s.quotations } as const;

/** วันที่ตามเวลาไทย (YYYY-MM-DD) */
export const bkkDate = (at: Date = new Date()) => new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * เลขเอกสารถัดไป `TX-2611-0004` · เดินต่อเนื่องแยกตามชนิดและเดือน ไม่ผูกกับเลขใบแจ้งหนี้ (เลขใบกำกับภาษีห้ามข้าม ม.86/4(4))
 * นับจากเลขสูงสุดที่มี ไม่ใช่จำนวนแถว เพราะเอกสารเก่าเคยใช้เลขตามใบแจ้งหนี้ (มีช่องว่าง)
 * `reader` ต้องเห็นทุก Workspace (SYSTEM_DB) · ล็อกอยู่ใน `tx` จนจบ transaction
 */
export async function nextDocNumber(tx: Tx, kind: DocKind, date = bkkDate(), reader: Db | Tx = tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK[kind]}, 0))`);
  const prefix = `${PREFIX[kind]}-${date.slice(2, 4)}${date.slice(5, 7)}-`;
  const col = COLUMN[kind];
  const [row] = await reader
    // ตำแหน่งต้องเป็นตัวเลขในคำสั่ง (sql.raw) · ถ้าส่งเป็นพารามิเตอร์ PostgreSQL ตีเป็น substring แบบ regex แล้วได้ null
    .select({ n: sql<number>`coalesce(max(nullif(regexp_replace(substring(${col} from ${sql.raw(String(prefix.length + 1))}), '[^0-9]', '', 'g'), '')::int), 0)` })
    .from(TABLE[kind])
    .where(like(col, `${prefix}%`));
  return `${prefix}${String(Number(row?.n ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * ใบแจ้งหนี้ได้รับเงินแล้ว → ออกใบเสร็จรับเงิน/ใบกำกับภาษี (จด VAT · รอส่ง e-Tax) หรือใบเสร็จ (ยังไม่จด)
 * วันที่ของเอกสาร = วันที่ได้รับเงิน (โอน = เวลาที่ลูกค้าแจ้งในสลิป) · เรียกซ้ำได้: ใบที่มีเอกสารที่ยังไม่ยกเลิกอยู่แล้วคืนตัวเดิม
 */
export async function issueReceipt(tx: Tx, inv: { id: string; workspaceId: string }, opts: { vatRegistered: boolean; paidAt: Date }) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'receipt:' + inv.id}, 0))`);
  const [existing] = await tx.select().from(s.taxDocuments).where(and(eq(s.taxDocuments.invoiceId, inv.id), ne(s.taxDocuments.status, 'cancelled'), isNull(s.taxDocuments.cancelledAt)));
  if (existing) return { doc: existing, created: false };
  const issuedOn = bkkDate(opts.paidAt);
  const kind: DocKind = opts.vatRegistered ? 'tax_invoice' : 'receipt';
  const number = await nextDocNumber(tx, kind, issuedOn);
  const buyer = await buyerSnapshot(tx, inv.workspaceId);
  const [doc] = await tx
    .insert(s.taxDocuments)
    .values(opts.vatRegistered
      ? { workspaceId: inv.workspaceId, invoiceId: inv.id, docType: 'tax_invoice_receipt', number, issuedOn, buyer }
      // ยังไม่จด VAT: ไม่ต้องส่ง e-Tax จึงถือว่าออกแล้ว
      : { workspaceId: inv.workspaceId, invoiceId: inv.id, docType: 'receipt', number, issuedOn, buyer, status: 'issued', sentAt: new Date() })
    .returning();
  return { doc, created: true };
}

/**
 * ออกใบกำกับภาษีฉบับใหม่แทนฉบับที่ยกเลิก (ข้อมูลผู้ซื้อผิด) · ฉบับเดิมเป็น `cancelled` · ฉบับใหม่ได้เลขถัดไปแต่ลงวันที่ตามฉบับเดิม
 * ข้อมูลผู้ซื้อของฉบับใหม่ = ข้อมูลภาษีปัจจุบัน (ลูกค้าแก้ให้ถูกก่อนขอออกใหม่)
 * (จุดเกิดภาษีไม่เปลี่ยน · รอนักบัญชียืนยัน ดู design/proposals/billing/README.md)
 */
export async function replaceTaxDocument(tx: Tx, docId: string, reason: string) {
  const [old] = await tx.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, docId)).for('update');
  if (!old) return null;
  if (old.status === 'cancelled') return { old, replacement: null as null | typeof s.taxDocuments.$inferSelect, alreadyCancelled: true };
  const issuedOn = old.issuedOn ?? bkkDate(old.createdAt);
  const kind: DocKind = old.docType === 'receipt' ? 'receipt' : 'tax_invoice';
  // เลขใหม่เดินตามเดือนที่ออกจริง (เลขต้องเรียงตามลำดับที่ออก)
  const number = await nextDocNumber(tx, kind);
  await tx.update(s.taxDocuments).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() }).where(eq(s.taxDocuments.id, old.id));
  const [replacement] = await tx
    .insert(s.taxDocuments)
    .values({ workspaceId: old.workspaceId, invoiceId: old.invoiceId, docType: old.docType, number, issuedOn, replacesId: old.id, buyer: await buyerSnapshot(tx, old.workspaceId), ...(kind === 'receipt' ? { status: 'issued', sentAt: new Date() } : {}) })
    .returning();
  return { old, replacement, alreadyCancelled: false };
}
