// ราคาแบบมีเวอร์ชันและคูปอง (O20) · ใช้ร่วมกันระหว่าง apps/api (คิดยอด checkout, รับเงินผ่าน Gateway) และ apps/ops-api (แก้ราคา, ยืนยันสลิป)
// เงินเป็นสตางค์ · ส่วนลดหักจากราคาแพ็กเกจก่อน VAT ใน billing core ของ Friday เอง ผู้ให้บริการรับชำระจึงตัดแค่ยอดสุทธิ
import { and, count, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { invoices } from './schema/billing.ts';
import { couponRedemptions, coupons, couponUses } from './schema/promotions.ts';

/** ราคารายเดือนตั้งต้นต่อ Workspace (ราคาในตาราง plans / เวอร์ชันราคาชนะเมื่อมี) · null = ฟรี / ติดต่อฝ่ายขาย */
export const PLAN_DEFAULT_MONTHLY_SATANG: Record<string, number | null> = { free: 0, team_s: 150_000, team_m: 300_000, team_l: 550_000, enterprise: null };
/** รายปีจ่าย 10 เดือน ใช้ 12 เดือน (หน้า Checkout) */
export const YEARLY_MONTHS = 10;
/** แจ้งลูกค้าเดิมล่วงหน้าก่อนเปลี่ยนราคาตามรอบถัดไป (P1) */
export const PRICE_NOTICE_DAYS = 30;

export type CouponKind = 'percent' | 'amount' | 'free_months';
export type CouponDuration = 'once' | 'repeating' | 'forever';
export const COUPON_KINDS = ['percent', 'amount', 'free_months'] as const;
export const COUPON_DURATIONS = ['once', 'repeating', 'forever'] as const;

export interface CouponTerms {
  kind: CouponKind;
  value: number;
  duration: CouponDuration;
  durationCycles: number | null;
}

/** จำนวนรอบบิลที่ได้ส่วนลด · null = ตลอดไป · ใช้ฟรี N เดือนเป็นใบเดียว (ครั้งเดียว) */
export const cyclesOf = (c: { kind: string; duration: string; durationCycles: number | null }): number | null =>
  c.kind === 'free_months' || c.duration === 'once' ? 1 : c.duration === 'repeating' ? (c.durationCycles ?? 1) : null;

/** ส่วนลดของคูปองหนึ่งใบต่อราคาหนึ่งรอบ (ไม่เกินราคา) · ใช้ฟรี N เดือน = ใบแรกไม่เสียเงิน */
export function couponAmount(c: { kind: string; value: number }, price: number) {
  if (price <= 0) return 0;
  if (c.kind === 'percent') return Math.min(price, Math.round((price * c.value) / 100));
  if (c.kind === 'amount') return Math.min(price, c.value);
  return price;
}

/** หักหลายคูปองตามลำดับ · รวมแล้วไม่เกินราคา (คูปองหลังได้ส่วนลดเท่าที่เหลือ) */
export function applyCoupons<T extends { kind: string; value: number }>(price: number, list: T[]) {
  let left = price;
  const lines = list.map((c) => {
    const amount = Math.min(left, couponAmount(c, price));
    left -= amount;
    return { coupon: c, amount };
  });
  return { discount: price - left, lines };
}

/**
 * รับเงินใบแจ้งหนี้แล้ว: ส่วนลดในใบนี้นับเป็นรอบที่ใช้ไป · คูปองที่ใช้ครบรอบ = ended
 * ต้องเรียกด้วยการเชื่อมต่อที่ข้าม RLS (SYSTEM_DB / ops) ในธุรกรรมเดียวกับที่ตั้งใบแจ้งหนี้เป็น paid · เรียกซ้ำได้ (นับเฉพาะ use ที่ยัง pending)
 */
export async function commitCouponUses(tx: Tx, invoiceId: string, now = new Date()) {
  const paid = await tx
    .update(couponUses)
    .set({ status: 'paid', paidAt: now })
    .where(and(eq(couponUses.invoiceId, invoiceId), eq(couponUses.status, 'pending')))
    .returning({ redemptionId: couponUses.redemptionId });
  const ids = [...new Set(paid.map((p) => p.redemptionId))];
  if (!ids.length) return 0;
  const counts = await tx
    .select({ id: couponUses.redemptionId, n: count() })
    .from(couponUses)
    .where(and(inArray(couponUses.redemptionId, ids), eq(couponUses.status, 'paid')))
    .groupBy(couponUses.redemptionId);
  const used = new Map(counts.map((c) => [c.id, c.n]));
  for (const r of await tx.select().from(couponRedemptions).where(inArray(couponRedemptions.id, ids))) {
    const done = r.cyclesTotal !== null && (used.get(r.id) ?? 0) >= r.cyclesTotal;
    await tx
      .update(couponRedemptions)
      .set({ status: done ? 'ended' : 'active', activatedAt: r.activatedAt ?? now, endedAt: done ? (r.endedAt ?? now) : null })
      .where(eq(couponRedemptions.id, r.id));
  }
  return ids.length;
}

/** รอบที่ใช้ไปแล้ว (ชำระแล้ว) ของการใช้คูปองแต่ละรายการ */
export async function paidCycles(tx: Db | Tx, redemptionIds: string[]) {
  if (!redemptionIds.length) return new Map<string, number>();
  const rows = await tx
    .select({ id: couponUses.redemptionId, n: sql<number>`count(*)::int` })
    .from(couponUses)
    .where(and(inArray(couponUses.redemptionId, redemptionIds), eq(couponUses.status, 'paid')))
    .groupBy(couponUses.redemptionId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

export interface GrantBlock {
  code: string;
  message: string;
}
type CouponRow = typeof coupons.$inferSelect;

/**
 * ทีม Friday ให้คูปองที่มีอยู่กับ Workspace (รอบ 4 · H7) · ตรวจกติกาเดียวกับตอนลูกค้าใส่โค้ด (apps/api › payments/coupons.ts › resolveDiscount):
 * สถานะ / วันหมดอายุ / แพ็กเกจ / ลูกค้าใหม่เท่านั้น / ใช้ร่วมกับคูปองอื่น / สิทธิ์คงเหลือ
 * `global` = คูปองใช้ไม่ได้ทั้งชุด · `perWorkspace` = รายที่ต้องข้าม · `remaining` = สิทธิ์คงเหลือ (null = ไม่จำกัด) ผู้เรียกตัดรายที่เกินเอง
 * ต้องเป็นการเชื่อมต่อที่ข้าม RLS (นับสิทธิ์ทุก Workspace)
 */
export async function couponGrantBlockers(db: Db | Tx, c: CouponRow, rows: { workspaceId: string; plan: string | null }[], todayIso: string) {
  let global: GrantBlock | null = null;
  if (c.status !== 'active') global = { code: 'coupon_inactive', message: `คูปอง ${c.code} ยังไม่เปิดใช้หรือถูกปิดแล้ว` };
  else if (c.expiresOn && c.expiresOn < todayIso) global = { code: 'coupon_expired', message: `คูปอง ${c.code} หมดอายุแล้ว` };
  const perWorkspace = new Map<string, GrantBlock>();
  const ids = rows.map((r) => r.workspaceId);
  if (!ids.length || global) return { global, perWorkspace, remaining: null as number | null };
  const existing = await db.select({ workspaceId: couponRedemptions.workspaceId, couponId: couponRedemptions.couponId, status: couponRedemptions.status }).from(couponRedemptions).where(inArray(couponRedemptions.workspaceId, ids));
  const otherIds = [...new Set(existing.filter((e) => e.couponId !== c.id && e.status === 'active').map((e) => e.couponId))];
  const others = otherIds.length ? await db.select({ id: coupons.id, code: coupons.code, stackable: coupons.stackable }).from(coupons).where(inArray(coupons.id, otherIds)) : [];
  const paid = c.newCustomersOnly
    ? new Set((await db.selectDistinct({ id: invoices.workspaceId }).from(invoices).where(and(inArray(invoices.workspaceId, ids), eq(invoices.status, 'paid'), gt(invoices.subtotal, 0)))).map((r) => r.id))
    : new Set<string>();
  for (const r of rows) {
    const own = existing.find((e) => e.workspaceId === r.workspaceId && e.couponId === c.id);
    const active = existing.filter((e) => e.workspaceId === r.workspaceId && e.couponId !== c.id && e.status === 'active').map((e) => others.find((o) => o.id === e.couponId)).filter(Boolean) as { code: string; stackable: boolean }[];
    if (!r.plan) perWorkspace.set(r.workspaceId, { code: 'no_subscription', message: 'ยังไม่มีแพ็กเกจ' });
    else if (own) perWorkspace.set(r.workspaceId, { code: 'coupon_already_used', message: own.status === 'ended' ? `ใช้คูปอง ${c.code} ครบแล้ว` : `ใช้คูปอง ${c.code} อยู่แล้ว` });
    else if (!c.planCodes.includes(r.plan)) perWorkspace.set(r.workspaceId, { code: 'coupon_plan_mismatch', message: `คูปองใช้กับแพ็กเกจ ${r.plan} ไม่ได้` });
    else if (paid.has(r.workspaceId)) perWorkspace.set(r.workspaceId, { code: 'coupon_new_customers_only', message: 'คูปองนี้ใช้ได้เฉพาะลูกค้าใหม่ที่ยังไม่เคยชำระเงิน' });
    else if (active.length && (!c.stackable || active.some((o) => !o.stackable))) perWorkspace.set(r.workspaceId, { code: 'coupon_not_stackable', message: `ใช้ร่วมกับส่วนลดที่ใช้อยู่ (${active.map((o) => o.code).join(', ')}) ไม่ได้` });
  }
  let remaining: number | null = null;
  if (c.maxRedemptions !== null) {
    // นับแบบเดียวกับ resolveDiscount: ใช้แล้ว + ใส่โค้ดแล้วมีใบแจ้งหนี้ที่ยังรอชำระ
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(couponRedemptions)
      .where(
        and(
          eq(couponRedemptions.couponId, c.id),
          or(
            inArray(couponRedemptions.status, ['active', 'ended']),
            sql`exists (select 1 from ${couponUses} u join ${invoices} i on i.id = u.invoice_id where u.redemption_id = ${couponRedemptions.id} and i.status in ('open', 'pending_review'))`,
          ),
        ),
      );
    remaining = Math.max(0, c.maxRedemptions - n);
  }
  return { global, perWorkspace, remaining };
}

/** ทีม Friday ให้คูปอง: ได้ส่วนลดตั้งแต่ใบแจ้งหนี้ถัดไป (active = resolveDiscount หยิบไปใช้ต่อเอง) · ต้องเรียกในธุรกรรมที่ข้าม RLS */
export async function grantCoupon(tx: Tx, c: CouponRow, workspaceId: string, now = new Date()) {
  const [row] = await tx
    .insert(couponRedemptions)
    .values({ workspaceId, couponId: c.id, status: 'active', cyclesTotal: cyclesOf(c), activatedAt: now, createdBy: null })
    .returning({ id: couponRedemptions.id });
  return row.id;
}
