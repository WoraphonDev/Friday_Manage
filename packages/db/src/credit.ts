// เครดิตของ Workspace และส่วนต่างเมื่อเปลี่ยนแพ็กเกจ (รอบ 4 · O41) · ใช้ร่วมกันระหว่าง API ลูกค้าและหลังบ้าน (ops-api) ให้กติกาเดียวกัน
// เครดิต = เงินของลูกค้าที่จ่ายไว้แล้ว ใช้ "ชำระ" ใบถัดไป · ไม่ใช่ส่วนลด จึงไม่ลดมูลค่าและ VAT ของใบนั้น (ใบกำกับภาษีออกเต็มยอด)
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { activeOverrides, type EntitlementPlan, versionAt } from './plan-entitlements.ts';
import type { Db, Tx } from './client.ts';
import * as s from './schema/index.ts';

const DAY = 86_400_000;

/** ยอดเครดิตคงเหลือ (สตางค์) · ไม่ติดลบ */
export async function creditBalance(db: Db | Tx, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ b: sql<string>`coalesce(sum(${s.workspaceCredits.amountSatang}), 0)` })
    .from(s.workspaceCredits)
    .where(eq(s.workspaceCredits.workspaceId, workspaceId));
  return Math.max(0, Number(row?.b ?? 0));
}

/**
 * หักเครดิตคงเหลือจากใบแจ้งหนี้ที่เพิ่งสร้าง (ยังเปิดอยู่) ในธุรกรรมเดียวกับที่สร้างใบ
 * เขียนแถว `applied` (ติดลบ ผูกใบนี้) · เพิ่ม `credit_applied` · ลด `amount_due` · คืนยอดที่หัก
 * ล็อกต่อ Workspace กันสองใบหักเครดิตก้อนเดียวกันพร้อมกัน · `db` ต้องเขียน workspace_credits ได้
 * (ลูกค้าเขียนได้เฉพาะแถว applied ของตัวเอง ตาม policy ใน 0046)
 */
export async function applyCreditToInvoice(tx: Tx, invoiceId: string): Promise<number> {
  const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
  if (!inv || inv.status !== 'open' || inv.amountDue <= 0) return 0;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'credit:' + inv.workspaceId}, 0))`);
  const balance = await creditBalance(tx, inv.workspaceId);
  const use = Math.min(balance, inv.amountDue);
  if (use <= 0) return 0;
  await tx.insert(s.workspaceCredits).values({ workspaceId: inv.workspaceId, amountSatang: -use, source: 'applied', invoiceId: inv.id, note: `ใช้ชำระ ${inv.number}` });
  await tx
    .update(s.invoices)
    .set({ creditApplied: inv.creditApplied + use, amountDue: inv.amountDue - use, updatedAt: new Date() })
    .where(eq(s.invoices.id, inv.id));
  return use;
}

/**
 * แบบสองขั้นสำหรับ checkout ของลูกค้า (friday_app แก้ใบแจ้งหนี้หลังสร้างไม่ได้):
 * `reserveCredit` ล็อกและคำนวณยอดที่จะหักก่อน insert ใบ → insert ใบด้วย credit_applied / amount_due ที่หักแล้ว → `recordCreditUse`
 */
export async function reserveCredit(tx: Tx, workspaceId: string, amountDue: number): Promise<number> {
  if (amountDue <= 0) return 0;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'credit:' + workspaceId}, 0))`);
  return Math.min(await creditBalance(tx, workspaceId), amountDue);
}
export async function recordCreditUse(tx: Tx, invoice: { id: string; workspaceId: string; number: string }, use: number) {
  if (use <= 0) return;
  await tx.insert(s.workspaceCredits).values({ workspaceId: invoice.workspaceId, amountSatang: -use, source: 'applied', invoiceId: invoice.id, note: `ใช้ชำระ ${invoice.number}` });
}

/**
 * ใบที่หักเครดิตไปแล้วถูกยกเลิกก่อนชำระส่วนที่เหลือ → คืนเครดิตเป็นแถว `reversal`
 * เรียกซ้ำได้: คืนเฉพาะส่วนที่ยังไม่เคยคืน · `db` ต้องเป็น role หลังบ้าน / งานเบื้องหลัง
 */
export async function reverseCreditOfInvoice(tx: Tx, invoiceId: string, note: string): Promise<number> {
  const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
  if (!inv || inv.creditApplied <= 0) return 0;
  const [done] = await tx
    .select({ n: sql<string>`coalesce(sum(${s.workspaceCredits.amountSatang}), 0)` })
    .from(s.workspaceCredits)
    .where(and(eq(s.workspaceCredits.invoiceId, inv.id), eq(s.workspaceCredits.source, 'reversal')));
  const left = inv.creditApplied - Number(done?.n ?? 0);
  if (left <= 0) return 0;
  await tx.insert(s.workspaceCredits).values({ workspaceId: inv.workspaceId, amountSatang: left, source: 'reversal', invoiceId: inv.id, note });
  return left;
}

/** วันในรอบบิล (ปัดตามวันปฏิทิน) · ใช้ทั้ง C4 ของทีมและการอัปเกรดเองของลูกค้า */
export function periodDays(start: Date, end: Date, now = new Date()) {
  const total = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY));
  const left = Math.min(total, Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY)));
  return { total, left };
}

/**
 * ส่วนต่างเมื่ออัปเกรดกลางรอบ (รอบบิลเดิม) · (ราคาใหม่ − ราคาเดิม) × วันที่เหลือ ÷ วันทั้งรอบ · ก่อน VAT
 * ราคาเดิม = ยอดที่จ่ายจริงของรอบนี้ (หลังส่วนลด) ถ้ามี ไม่ใช่ราคาตั้ง
 */
export function prorateUpgrade(input: { newPriceSatang: number; oldPriceSatang: number; start: Date; end: Date; now?: Date }) {
  const { total, left } = periodDays(input.start, input.end, input.now);
  const newPart = Math.round((input.newPriceSatang * left) / total);
  const oldPart = Math.round((input.oldPriceSatang * left) / total);
  return { total, left, newPartSatang: newPart, oldPartSatang: oldPart, diffSatang: newPart - oldPart };
}

/**
 * สิ่งที่ต้องลดก่อนลดแพ็กเกจมีผล (O41 · R6) · เทียบการใช้งานตอนนี้กับขีดจำกัดของแพ็กเกจปลายทาง (เวอร์ชันสิทธิ์ที่มีผล + override ที่นั่ง)
 * ว่าง = ลดได้ · `db` ต้องอ่านตารางของทีม Friday ได้ (entitlement_versions)
 */
export async function downgradeBlockers(db: Db | Tx, workspaceId: string, plan: string, now = new Date()) {
  const { matrix } = await versionAt(db, now);
  const values = matrix[plan as EntitlementPlan] ?? {};
  const seatOverride = (await activeOverrides(db, workspaceId, now)).find((o) => o.key === 'seats');
  const seatLimit = (seatOverride ? (seatOverride.value as number | null) : (values.seats as number | null)) ?? null;
  const projectLimit = (values.projects as number | null) ?? null;
  const [seats] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.workspaceMembers)
    .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), ne(s.workspaceMembers.role, 'guest')));
  const [projects] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.projects)
    .where(and(eq(s.projects.workspaceId, workspaceId), isNull(s.projects.deletedAt), isNull(s.projects.archivedAt)));
  const out: { key: 'seats' | 'projects'; used: number; limit: number }[] = [];
  if (seatLimit != null && (seats?.n ?? 0) > seatLimit) out.push({ key: 'seats', used: seats!.n, limit: seatLimit });
  if (projectLimit != null && (projects?.n ?? 0) > projectLimit) out.push({ key: 'projects', used: projects!.n, limit: projectLimit });
  return out;
}
