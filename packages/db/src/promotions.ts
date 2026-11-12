// ราคาแบบมีเวอร์ชันและคูปอง (O20) · ใช้ร่วมกันระหว่าง apps/api (คิดยอด checkout, รับเงินผ่าน Gateway) และ apps/ops-api (แก้ราคา, ยืนยันสลิป)
// เงินเป็นสตางค์ · ส่วนลดหักจากราคาแพ็กเกจก่อน VAT ใน billing core ของ Friday เอง ผู้ให้บริการรับชำระจึงตัดแค่ยอดสุทธิ
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { couponRedemptions, couponUses } from './schema/promotions.ts';

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
