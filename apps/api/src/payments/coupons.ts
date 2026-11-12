import { applyCoupons, type CouponKind, cyclesOf, type Db, paidCycles, schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, gt, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { today } from '../common/dates.js';

// O20 · ราคาของลูกค้า (เวอร์ชันราคา + grandfathering) และคูปองตอน checkout
// ส่วนลดหักจากราคาแพ็กเกจก่อน VAT ใน billing core ของ Friday: ผู้ให้บริการรับชำระ (ตัวจำลอง / Gateway จริงใน A35b) ตัดแค่ยอดสุทธิในใบแจ้งหนี้

const s = schema;

/** โค้ดที่ลูกค้าพิมพ์: ตัดช่องว่าง ไม่สนตัวพิมพ์เล็ก/ใหญ่ */
export const CouponCode = z
  .string()
  .trim()
  .max(32)
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/, 'รูปแบบโค้ดส่วนลดไม่ถูกต้อง'));

type Coupon = typeof s.coupons.$inferSelect;
type Version = typeof s.planPriceVersions.$inferSelect;

export interface PriceChoice {
  /** ราคาที่ใช้คิด (null = ใช้ค่าตั้งต้นในโค้ด) */
  override: { monthly: number | null; yearly: number | null };
  versionId: string | null;
  /** ลูกค้าเดิมได้ราคาเวอร์ชันเก่าที่ถูกกว่าราคาปัจจุบัน */
  grandfathered: boolean;
}

/**
 * ราคาของแพ็กเกจสำหรับ Workspace นี้ · แคตตาล็อกและเวอร์ชันราคาเป็นข้อมูลระดับระบบ (ops_only) จึงอ่านด้วย SYSTEM_DB
 * - ลูกค้าใหม่ / เปลี่ยนแพ็กเกจ: เวอร์ชันล่าสุดที่มีผลแล้ว
 * - ลูกค้าเดิมที่จ่ายแพ็กเกจเดิมอยู่: เวอร์ชันที่จ่ายล่าสุด (grandfathering) จนกว่าจะย้ายแพ็กเกจเอง · เวอร์ชันใหม่แบบ next_cycle ที่ถึงวันแล้วย้ายให้
 *   ใช้ราคาที่ถูกกว่าเสมอ: ลดราคาแล้วลูกค้าเดิมได้ราคาใหม่ด้วย
 * `price` = ฟังก์ชันคิดราคาของรอบจากค่า override (priceFor ใน catalog)
 */
export async function choosePrice(sys: Db, workspaceId: string, plan: string, price: (o: PriceChoice['override']) => number | null, now = new Date()): Promise<PriceChoice> {
  const [row] = await sys.select().from(s.plans).where(eq(s.plans.code, plan));
  const [sub] = await sys
    .select({ status: s.subscriptions.status, planCode: s.plans.code, priceVersionId: s.subscriptions.priceVersionId })
    .from(s.subscriptions)
    .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
    .where(eq(s.subscriptions.workspaceId, workspaceId));
  const existing = !!sub && sub.planCode === plan && (sub.status === 'active' || sub.status === 'past_due');
  if (row && !row.openForSignup && !existing) throw new AppError(422, 'plan_not_open', 'แพ็กเกจนี้ปิดรับสมัครใหม่ชั่วคราว · เลือกแพ็กเกจอื่นหรือติดต่อทีม Friday', { plan });
  const versions = await sys
    .select()
    .from(s.planPriceVersions)
    .where(and(eq(s.planPriceVersions.planCode, plan), lte(s.planPriceVersions.effectiveAt, now)))
    .orderBy(desc(s.planPriceVersions.version));
  const current = versions[0];
  // ยังไม่มีเวอร์ชัน (ฐานที่ test ล้าง): ราคาในตาราง plans แบบเดิม
  if (!current) return { override: { monthly: row?.priceMonthlySatang ?? null, yearly: row?.priceYearlySatang ?? null }, versionId: null, grandfathered: false };
  const of = (v: Version) => ({ monthly: v.monthlySatang, yearly: v.yearlySatang });
  let chosen: Version = current;
  const locked = existing && sub.priceVersionId ? versions.find((v) => v.id === sub.priceVersionId) : undefined;
  if (locked && locked.id !== current.id) {
    // เวอร์ชันที่ประกาศว่าลูกค้าเดิมย้ายตามรอบถัดไป และพ้นช่วงแจ้งล่วงหน้าแล้ว
    const moved = versions.find((v) => v.version > locked.version && v.existingPolicy === 'next_cycle' && v.existingFrom && v.existingFrom <= now);
    const keep = moved ?? locked;
    const a = price(of(keep));
    const b = price(of(current));
    if (a !== null && (b === null || a < b)) chosen = keep;
  }
  return { override: of(chosen), versionId: chosen.id, grandfathered: chosen.id !== current.id };
}

export interface DiscountLine {
  code: string;
  kind: CouponKind;
  value: number;
  amount: number;
  /** รอบที่เหลือหลังใบนี้ · null = ตลอดไป */
  cyclesLeft: number | null;
  /** ได้ต่อจากรอบก่อน (ไม่ต้องใส่โค้ดอีก) */
  carried: boolean;
}
export interface DiscountResult {
  discount: number;
  discounts: DiscountLine[];
  /** โค้ดที่ส่งมาและใช้ได้ */
  coupon: string | null;
  /** คูปองใช้ฟรี N เดือน: ใบนี้ไม่เสียเงินและครอบคลุม N เดือน */
  freeMonths: number | null;
  /** ใช้ตอนบันทึกใบแจ้งหนี้ */
  apply: { couponId: string; redemptionId: string | null; cyclesTotal: number | null; amount: number }[];
}

const NONE: DiscountResult = { discount: 0, discounts: [], coupon: null, freeMonths: null, apply: [] };
const bad = (code: string, message: string, details?: Record<string, unknown>) => new AppError(422, code, message, details);
const PLAN_NAMES: Record<string, string> = { team_s: 'Team S', team_m: 'Team M', team_l: 'Team L', enterprise: 'Enterprise' };

/**
 * ส่วนลดของใบนี้: คูปองที่ได้ต่อจากรอบก่อน (active) + โค้ดที่ลูกค้าใส่ใหม่
 * `tx` = ธุรกรรมของลูกค้า (RLS: Owner / Admin อ่านการใช้คูปองและใบแจ้งหนี้ของ Workspace ตัวเอง) · `sys` อ่านคูปองและนับสิทธิ์ทุก Workspace
 */
export async function resolveDiscount(sys: Db, tx: Tx, input: { workspaceId: string; plan: string; listPrice: number; code: string | null }): Promise<DiscountResult> {
  // coupons เป็นตาราง ops_only: อ่านการใช้ของ Workspace ผ่าน RLS แล้วอ่านรายละเอียดคูปองด้วย SYSTEM_DB
  const redemptions = await tx.select().from(s.couponRedemptions).where(eq(s.couponRedemptions.workspaceId, input.workspaceId)).orderBy(asc(s.couponRedemptions.createdAt));
  const ids = [...new Set(redemptions.map((r) => r.couponId))];
  const known = ids.length ? await sys.select().from(s.coupons).where(inArray(s.coupons.id, ids)) : [];
  const byId = new Map(known.map((c) => [c.id, c]));
  const active = redemptions.filter((r) => r.status === 'active' && byId.get(r.couponId)?.planCodes.includes(input.plan));
  const used = await paidCycles(tx, active.map((r) => r.id));

  type Pick = { coupon: Coupon; redemptionId: string | null; cyclesTotal: number | null; carried: boolean; usedCycles: number };
  const picks: Pick[] = active.map((r) => ({ coupon: byId.get(r.couponId)!, redemptionId: r.id, cyclesTotal: r.cyclesTotal, carried: true, usedCycles: used.get(r.id) ?? 0 }));
  let accepted: string | null = null;

  if (input.code) {
    const [c] = await sys.select().from(s.coupons).where(eq(s.coupons.code, input.code));
    if (!c) throw bad('coupon_not_found', 'ไม่พบโค้ดส่วนลดนี้ · ตรวจตัวสะกดอีกครั้ง');
    const own = redemptions.find((r) => r.couponId === c.id);
    if (own?.status === 'ended') throw bad('coupon_already_used', `Workspace นี้ใช้โค้ด ${c.code} ครบแล้ว`);
    if (!c.planCodes.includes(input.plan))
      throw bad('coupon_plan_mismatch', `โค้ด ${c.code} ใช้กับแพ็กเกจนี้ไม่ได้ · ใช้ได้กับ ${c.planCodes.map((p) => PLAN_NAMES[p] ?? p).join(', ')}`, { plans: c.planCodes });
    if (own?.status === 'active') {
      // ใช้อยู่แล้ว: ได้ส่วนลดต่อเอง ไม่ต้องใส่ซ้ำ
      accepted = c.code;
    } else {
      if (c.status !== 'active') throw bad('coupon_inactive', `โค้ด ${c.code} ยังไม่เปิดใช้หรือถูกปิดแล้ว`);
      if (c.expiresOn && c.expiresOn < today()) throw bad('coupon_expired', `โค้ด ${c.code} หมดอายุแล้ว`, { expiresOn: c.expiresOn });
      if (c.newCustomersOnly) {
        const [paid] = await tx
          .select({ id: s.invoices.id })
          .from(s.invoices)
          .where(and(eq(s.invoices.workspaceId, input.workspaceId), eq(s.invoices.status, 'paid'), gt(s.invoices.subtotal, 0)))
          .limit(1);
        if (paid) throw bad('coupon_new_customers_only', `โค้ด ${c.code} ใช้ได้เฉพาะลูกค้าใหม่ที่ยังไม่เคยชำระเงิน`);
      }
      if (c.maxRedemptions !== null) {
        // นับทุก Workspace (SYSTEM_DB): ใช้แล้ว + ใส่โค้ดแล้วมีใบแจ้งหนี้ที่ยังรอชำระ
        const [{ n }] = await sys
          .select({ n: sql<number>`count(*)::int` })
          .from(s.couponRedemptions)
          .where(
            and(
              eq(s.couponRedemptions.couponId, c.id),
              ne(s.couponRedemptions.workspaceId, input.workspaceId),
              or(
                inArray(s.couponRedemptions.status, ['active', 'ended']),
                sql`exists (select 1 from ${s.couponUses} u join ${s.invoices} i on i.id = u.invoice_id
                  where u.redemption_id = ${s.couponRedemptions.id} and i.status in ('open', 'pending_review'))`,
              ),
            ),
          );
        if (n >= c.maxRedemptions) throw bad('coupon_exhausted', `สิทธิ์ของโค้ด ${c.code} ถูกใช้ครบแล้ว`);
      }
      const others = picks.map((p) => p.coupon);
      if (others.length && (!c.stackable || others.some((o) => !o.stackable)))
        throw bad('coupon_not_stackable', `ใช้โค้ด ${c.code} ร่วมกับส่วนลดที่ใช้อยู่ (${others.map((o) => o.code).join(', ')}) ไม่ได้`, { active: others.map((o) => o.code) });
      picks.push({ coupon: c, redemptionId: own?.id ?? null, cyclesTotal: cyclesOf(c), carried: false, usedCycles: 0 });
      accepted = c.code;
    }
  }
  if (!picks.length) return { ...NONE, coupon: accepted };

  const { discount, lines } = applyCoupons(input.listPrice, picks.map((p) => p.coupon));
  const free = picks.find((p) => p.coupon.kind === 'free_months');
  return {
    discount,
    coupon: accepted,
    freeMonths: free ? free.coupon.value : null,
    discounts: picks.map((p, i) => ({
      code: p.coupon.code,
      kind: p.coupon.kind as CouponKind,
      value: p.coupon.value,
      amount: lines[i].amount,
      cyclesLeft: p.cyclesTotal === null ? null : Math.max(0, p.cyclesTotal - p.usedCycles - 1),
      carried: p.carried,
    })),
    apply: picks.map((p, i) => ({ couponId: p.coupon.id, redemptionId: p.redemptionId, cyclesTotal: p.cyclesTotal, amount: lines[i].amount })),
  };
}

/** บันทึกการใช้คูปองของใบแจ้งหนี้ (ในธุรกรรมของลูกค้า · RLS) · รอบนับเมื่อชำระ (commitCouponUses) */
export async function recordDiscount(tx: Tx, input: { workspaceId: string; userId: string; invoiceId: string; apply: DiscountResult['apply'] }) {
  for (const a of input.apply) {
    let redemptionId = a.redemptionId;
    if (!redemptionId) {
      const [r] = await tx
        .insert(s.couponRedemptions)
        .values({ workspaceId: input.workspaceId, couponId: a.couponId, cyclesTotal: a.cyclesTotal, createdBy: input.userId })
        .returning({ id: s.couponRedemptions.id });
      redemptionId = r.id;
    }
    await tx.insert(s.couponUses).values({ workspaceId: input.workspaceId, redemptionId, couponId: a.couponId, invoiceId: input.invoiceId, amount: a.amount });
  }
}
