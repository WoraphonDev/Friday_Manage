import { canGrant, commitCouponUses, type Db, resumeIfPaid, schema, type Tx } from '@friday/db';
import { and, count, eq, inArray, like, sql } from 'drizzle-orm';
import { AppError } from '../errors.js';
import type { Mailer } from '../mail.js';

/** ส่วนกลางของงานเงินในหลังบ้าน (O03) · ใช้ร่วมกันระหว่าง payments/ และ billing/ */
const s = schema;
export const DAY = 86_400_000;
export type Invoice = typeof s.invoices.$inferSelect;

/** แพ็กเกจ / รอบที่ผูกกับใบแจ้งหนี้ (API ลูกค้าเก็บใน audit_logs `billing.checkout`) · ใบที่ทีมออกเองอาจไม่มีแพ็กเกจ */
export interface CheckoutMeta {
  plan?: string;
  cycle?: 'monthly' | 'yearly';
  method?: 'card' | 'promptpay' | 'transfer';
  manual?: boolean;
  items?: { description: string; qty: number; unitSatang: number }[];
  note?: string;
  /** เวอร์ชันราคาที่ใบนี้ใช้ (O20 · ใบจาก checkout ของลูกค้า) · ไม่มี = ใบที่ทีมออกเอง / ก่อนมีเวอร์ชัน */
  priceVersionId?: string | null;
}

/** บริษัทจด VAT หรือยัง · ตั้งให้ตรงกับ API ลูกค้า (A35a) */
export const vatRegistered = () => process.env.VAT_REGISTERED !== 'false';
export const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * เลขเอกสารต่อเนื่องทั้งระบบ (ใบกำกับภาษี / ใบลดหนี้ต้องเรียงเลข) · ล็อกระดับระบบด้วยชื่อเดียวกับ API ลูกค้า
 * `FRI-2611-0001` (ใบแจ้งหนี้) · `CN-2611-0001` (ใบลดหนี้)
 */
export async function nextNumber(tx: Tx, kind: 'invoice' | 'credit_note', date = todayBkk()) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${kind === 'invoice' ? 'invoice-number' : 'credit-note-number'}, 0))`);
  const prefix = `${kind === 'invoice' ? 'FRI' : 'CN'}-${date.slice(2, 4)}${date.slice(5, 7)}-`;
  const table = kind === 'invoice' ? s.invoices : s.creditNotes;
  const [row] = await tx.select({ n: count() }).from(table).where(like(table.number, `${prefix}%`));
  return `${prefix}${String(row.n + 1).padStart(4, '0')}`;
}

export async function metaOf(db: Db | Tx, invoiceId: string): Promise<CheckoutMeta | null> {
  const [row] = await db.select({ summary: s.auditLogs.summary }).from(s.auditLogs).where(and(eq(s.auditLogs.action, 'billing.checkout'), eq(s.auditLogs.targetId, invoiceId)));
  if (!row?.summary) return null;
  try {
    return JSON.parse(row.summary) as CheckoutMeta;
  } catch {
    return null;
  }
}

/** เปิดแพ็กเกจตามใบแจ้งหนี้ · false = ใบนี้ถูกแทนที่ด้วยใบที่ใหม่กว่าซึ่งยังมีผล (กติกาเดียวกับ apps/api › PaymentsService.activate) */
export async function activate(tx: Tx, inv: Invoice, meta: CheckoutMeta): Promise<boolean> {
  if (!meta.plan) return false;
  if (!(await canGrant(tx, inv))) return false;
  const [plan] = await tx.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.code, meta.plan));
  if (!plan) throw new AppError(409, 'plan_not_found', `ไม่พบแพ็กเกจ ${meta.plan}`);
  await tx
    .update(s.subscriptions)
    .set({ planId: plan.id, cycle: meta.cycle ?? 'monthly', status: 'active', trialEndsAt: null, currentPeriodStart: new Date(`${inv.periodStart}T00:00:00+07:00`), currentPeriodEnd: new Date(`${addDays(inv.periodEnd, 1)}T00:00:00+07:00`), paymentMethod: meta.method ?? 'transfer', sourceInvoiceId: inv.id, ...(meta.priceVersionId !== undefined ? { priceVersionId: meta.priceVersionId } : {}), updatedAt: new Date() })
    .where(eq(s.subscriptions.id, inv.subscriptionId));
  return true;
}

/**
 * ใบแจ้งหนี้ได้รับเงินครบ: paid → เปิดแพ็กเกจ (ถ้ามี) → ออกใบกำกับภาษี (จด VAT · รอ e-Tax) หรือใบเสร็จ (ยังไม่จด)
 * คืน true ถ้าเปิดแพ็กเกจ
 */
export async function settleInvoice(tx: Tx, inv: Invoice) {
  await tx.update(s.invoices).set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
  const meta = await metaOf(tx, inv.id);
  const granted = meta ? await activate(tx, inv, meta) : false;
  // ส่วนลดคูปองในใบนี้นับเป็นรอบที่ใช้ไป (O20 · ทางเดียวกับที่ API ลูกค้ารับเงินผ่าน Gateway)
  await commitCouponUses(tx, inv.id);
  await tx
    .insert(s.taxDocuments)
    .values(vatRegistered()
      ? { workspaceId: inv.workspaceId, invoiceId: inv.id, docType: 'tax_invoice_receipt', number: `TX-${inv.number.slice(4)}` }
      : { workspaceId: inv.workspaceId, invoiceId: inv.id, docType: 'receipt', number: `RC-${inv.number.slice(4)}`, status: 'issued', sentAt: new Date() })
    .onConflictDoNothing();
  // ระงับเพราะค้างชำระ + เปิดเองเมื่อชำระ → เปิดถ้าไม่เหลือใบเลยกำหนด
  await resumeIfPaid(tx, inv.workspaceId);
  return granted;
}

/** ผู้รับอีเมลเรื่องเงินของลูกค้า: Owner / Admin + อีเมลรับใบกำกับภาษี */
export async function billingContacts(db: Db | Tx, workspaceId: string) {
  const admins = await db
    .select({ email: s.users.email })
    .from(s.workspaceMembers)
    .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
    .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.role, ['owner', 'admin'])));
  const [profile] = await db.select({ taxEmail: s.billingProfiles.taxEmail }).from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, workspaceId));
  return [...new Set([...admins.map((a) => a.email.toLowerCase()), ...(profile?.taxEmail ? [profile.taxEmail.toLowerCase()] : [])])];
}

/** ส่งอีเมลไม่ได้ไม่ทำให้รายการล้ม · คืนจำนวนที่ส่งได้ */
export async function mailAll(mail: Mailer, to: string[], subject: string, text: string) {
  let sent = 0;
  for (const t of to) {
    try {
      await mail.send({ to: t, subject, text });
      sent++;
    } catch {
      /* Mailer บันทึก log แล้ว */
    }
  }
  return sent;
}

export const baht = (satang: number) => `฿${(satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
