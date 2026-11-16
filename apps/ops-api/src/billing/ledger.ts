import { canGrant, commitCouponUses, type Db, issueReceipt, nextDocNumber, resumeIfPaid, schema, type Tx } from '@friday/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
 * เลขเอกสารต่อเนื่องทั้งระบบ (ใบกำกับภาษี / ใบลดหนี้ / ใบเพิ่มหนี้ต้องเรียงเลข) · กติกาเดียวกับ API ลูกค้า (@friday/db › nextDocNumber)
 * `FRI-2611-0001` (ใบแจ้งหนี้) · `CN-2611-0001` (ใบลดหนี้) · `DN-2611-0001` (ใบเพิ่มหนี้)
 */
export const nextNumber = (tx: Tx, kind: 'invoice' | 'credit_note' | 'debit_note', date = todayBkk()) => nextDocNumber(tx, kind, date);

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
 * วันที่ของเอกสาร = วันที่ได้รับเงิน: `paidAt` ที่ส่งมา หรือเวลาโอนที่ลูกค้าแจ้งในสลิป ไม่ใช่วันที่ทีมงานตรวจ (VAT จะได้ไม่ตกผิดเดือน)
 * คืน true ถ้าเปิดแพ็กเกจ
 */
export async function settleInvoice(tx: Tx, inv: Invoice, paidAt?: Date) {
  const [declared] = await tx.select({ paidAt: s.payments.paidAt }).from(s.payments).where(eq(s.payments.invoiceId, inv.id)).orderBy(desc(s.payments.createdAt)).limit(1);
  const receivedAt = paidAt ?? declared?.paidAt ?? new Date();
  await tx.update(s.invoices).set({ status: 'paid', paidAt: receivedAt, updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
  const meta = await metaOf(tx, inv.id);
  const granted = meta ? await activate(tx, inv, meta) : false;
  // ส่วนลดคูปองในใบนี้นับเป็นรอบที่ใช้ไป (O20 · ทางเดียวกับที่ API ลูกค้ารับเงินผ่าน Gateway)
  await commitCouponUses(tx, inv.id);
  await issueReceipt(tx, inv, { vatRegistered: vatRegistered(), paidAt: receivedAt });
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
