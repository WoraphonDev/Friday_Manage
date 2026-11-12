import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { COUPON_DURATIONS, COUPON_KINDS, cyclesOf, type Db, PLAN_DEFAULT_MONTHLY_SATANG, PRICE_NOTICE_DAYS, schema, type Tx, YEARLY_MONTHS } from '@friday/db';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AnnouncementsService } from '../announcements/announcements.service.js';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { type Approval, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { baht, todayBkk } from '../billing/ledger.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
const DAY = 86_400_000;

export const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
type PlanCode = (typeof PLAN_CODES)[number];
const PLAN_NAMES: Record<PlanCode, string> = { free: 'Free', team_s: 'Team S', team_m: 'Team M', team_l: 'Team L', enterprise: 'Enterprise' };
/** ขายออนไลน์ได้ (แก้ราคาได้) · Free = ฿0 เสมอ · Enterprise = ตามใบเสนอราคา */
const PRICED: readonly PlanCode[] = ['team_s', 'team_m', 'team_l'];
const COUPON_PLANS = ['team_s', 'team_m', 'team_l', 'enterprise'] as const;
/** ค่าตั้งต้นของคีย์ในตารางแพ็กเกจ (ใช้เมื่อยังไม่มีเวอร์ชันสิทธิ์ · O21) */
const DEFAULT_PROJECTS: Record<PlanCode, number | null> = { free: 3, team_s: null, team_m: null, team_l: null, enterprise: null };

const money = z.number().int().min(0).max(100_000_000_00);
export const PlanBody = z
  .object({
    displayName: z.string().trim().min(1, 'กรอกชื่อที่แสดง').max(40),
    monthlySatang: money.nullable(),
    /** null = ราคาเดือน × 10 */
    yearlySatang: money.nullable(),
    listed: z.boolean(),
    openForSignup: z.boolean(),
    existingPolicy: z.enum(['grandfather', 'next_cycle']).default('grandfather'),
    reason: z.string().trim().min(3, 'ใส่เหตุผลอย่างน้อย 3 ตัวอักษร').max(500),
  })
  .strict();

const code = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/, 'โค้ด 3–32 ตัว ใช้ A–Z 0–9 - _ (ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)'));
const couponFields = {
  code,
  description: z.string().trim().max(200).nullish(),
  kind: z.enum(COUPON_KINDS),
  value: z.number().int().positive('มูลค่าต้องมากกว่า 0'),
  duration: z.enum(COUPON_DURATIONS),
  durationCycles: z.number().int().min(1).max(36).nullish(),
  planCodes: z.array(z.enum(COUPON_PLANS)).min(1, 'เลือกแพ็กเกจอย่างน้อย 1 แพ็กเกจ'),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullish(),
  expiresOn: z.iso.date().nullish(),
  newCustomersOnly: z.boolean(),
  stackable: z.boolean(),
};
type CouponInput = { [K in keyof typeof couponFields]: z.infer<(typeof couponFields)[K]> };
/** กติกาข้ามช่อง (ตรงกับ check ของตาราง coupons) */
function checkCoupon(v: Partial<CouponInput>, ctx: z.RefinementCtx) {
  if (v.kind === 'percent' && v.value !== undefined && v.value > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'เปอร์เซ็นต์ต้องไม่เกิน 100' });
  if (v.kind === 'amount' && v.value !== undefined && v.value < 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'ส่วนลดต้องอย่างน้อย ฿1' });
  if (v.kind === 'free_months' && v.value !== undefined && v.value > 24) ctx.addIssue({ code: 'custom', path: ['value'], message: 'ใช้ฟรีได้ไม่เกิน 24 เดือน' });
  if (v.duration === 'repeating' && !v.durationCycles) ctx.addIssue({ code: 'custom', path: ['durationCycles'], message: 'ระบุจำนวนรอบบิล' });
  if (v.kind === 'free_months' && v.duration && v.duration !== 'once') ctx.addIssue({ code: 'custom', path: ['duration'], message: 'ใช้ฟรี N เดือนใช้ได้ครั้งเดียว' });
  if (v.kind === 'free_months' && v.stackable) ctx.addIssue({ code: 'custom', path: ['stackable'], message: 'ใช้ฟรี N เดือนใช้คู่กับคูปองอื่นไม่ได้' });
  if (v.expiresOn && v.expiresOn < todayBkk()) ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: 'วันหมดอายุต้องไม่อยู่ในอดีต' });
}
export const CouponBody = z
  .object({ ...couponFields, newCustomersOnly: z.boolean().default(false), stackable: z.boolean().default(false), activate: z.boolean().default(false) })
  .strict()
  .superRefine(checkCoupon);
export const CouponPatch = z.object(couponFields).partial().strict().superRefine(checkCoupon);
export const DisableBody = z.object({ reason: z.string().trim().min(3, 'ใส่เหตุผลอย่างน้อย 3 ตัวอักษร').max(300) }).strict();

export type Gated<T> = T | { pendingApproval: NonNullable<Awaited<ReturnType<ApprovalsService['gate']>>> };
const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);

type CouponRow = typeof s.coupons.$inferSelect;
type VersionRow = typeof s.planPriceVersions.$inferSelect;
interface PricePayload {
  plan: PlanCode;
  input: z.infer<typeof PlanBody>;
}

/** ราคาที่ใช้จริง (เดือน / ปี) จากค่าที่เก็บ · null ในที่เก็บ = ค่าตั้งต้นในโค้ด */
function effective(code: PlanCode, monthly: number | null, yearly: number | null) {
  if (code === 'free') return { monthly: 0, yearly: 0, yearlyCustom: false };
  if (code === 'enterprise') return { monthly: null, yearly: null, yearlyCustom: false };
  const m = monthly ?? PLAN_DEFAULT_MONTHLY_SATANG[code] ?? null;
  return { monthly: m, yearly: yearly ?? (m === null ? null : m * YEARLY_MONTHS), yearlyCustom: yearly !== null };
}

/**
 * แพ็กเกจและโปรโมชัน (O20 · Canvas › Promotions, P1, P4)
 * - แก้ราคา / ชื่อ / การแสดงผลของแพ็กเกจเป็นเวอร์ชันใหม่ทุกครั้ง · เปลี่ยนราคาต้องมีคนอนุมัติเสมอ · ลูกค้าเดิมคงราคาเดิม (grandfathering)
 *   หรือย้ายตามรอบที่ออกใบแจ้งหนี้หลังแจ้งล่วงหน้า 30 วัน (ส่งประกาศ O24 ให้อัตโนมัติ)
 * - คูปอง: ร่าง → เปิด (แตะ key · เกินวงเงินส่วนลดของพนักงานต้องอนุมัติ) → ปิด (คนที่ใช้แล้วยังได้ส่วนลดครบรอบ)
 * - รายงาน "ลูกค้าที่จ่ายต่อหลังหมดส่วนลด" ต่อคูปอง
 * ทุกการแก้ลง staff_audit_logs · API ลูกค้าคิดส่วนลดตอน checkout (apps/api/src/payments/coupons.ts)
 */
@Injectable()
export class PromotionsService implements OnModuleInit {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly announcements: AnnouncementsService,
  ) {}

  onModuleInit() {
    this.approvals.register('promotions.plan_price', (p, ctx) => this.applyPlan(ctx.requester, p as unknown as PricePayload, ctx));
    this.approvals.register('promotions.coupon_activate', (p, ctx) => this.applyActivate(ctx.requester, p.couponId as string, ctx));
  }

  // ---------------------------------------------------------------------------
  // หน้าแพ็กเกจและโปรโมชัน
  // ---------------------------------------------------------------------------

  async overview(now = new Date()) {
    const plans = await this.planRows(now);
    const pending = await this.db
      .select({ id: s.approvalRequests.id, reason: s.approvalRequests.reason, createdAt: s.approvalRequests.createdAt, requestedBy: s.staffUsers.name, payload: s.approvalRequests.payload })
      .from(s.approvalRequests)
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.approvalRequests.requestedBy))
      .where(and(eq(s.approvalRequests.kind, 'promotions.plan_price'), eq(s.approvalRequests.status, 'pending'), gt(s.approvalRequests.expiresAt, now)))
      .orderBy(desc(s.approvalRequests.createdAt));
    const coupons = await this.couponRows();
    const month = todayBkk().slice(0, 7);
    const [given] = await this.db
      .select({ n: sql<number>`coalesce(sum(${s.couponUses.amount}), 0)::bigint` })
      .from(s.couponUses)
      .where(and(eq(s.couponUses.status, 'paid'), sql`to_char(${s.couponUses.paidAt} at time zone 'Asia/Bangkok', 'YYYY-MM') = ${month}`));
    return {
      plans,
      pendingPrices: pending.map((p) => {
        const x = p.payload as unknown as PricePayload;
        return { id: p.id, plan: x.plan, requestedBy: p.requestedBy, createdAt: p.createdAt, reason: p.reason, monthlySatang: x.input?.monthlySatang ?? null, yearlySatang: x.input?.yearlySatang ?? null };
      }),
      coupons,
      summary: { activeCoupons: coupons.filter((c) => c.state === 'active').length, discountThisMonthSatang: Number(given.n) },
    };
  }

  private async currentVersions(now: Date) {
    const rows = await this.db.select().from(s.planPriceVersions).where(sql`${s.planPriceVersions.effectiveAt} <= ${now}`).orderBy(desc(s.planPriceVersions.version));
    const current = new Map<string, VersionRow>();
    for (const r of rows) if (!current.has(r.planCode)) current.set(r.planCode, r);
    return current;
  }

  private async planRows(now: Date) {
    const rows = await this.db.select().from(s.plans);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const current = await this.currentVersions(now);
    const subs = await this.db
      .select({ plan: s.plans.code, status: s.subscriptions.status, versionId: s.subscriptions.priceVersionId })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.subscriptions.workspaceId))
      .where(and(isNull(s.workspaces.deletedAt), sql`${s.subscriptions.status} <> 'canceled'`));
    const ent = await this.db.select({ matrix: s.entitlementVersions.matrix }).from(s.entitlementVersions).where(sql`${s.entitlementVersions.effectiveAt} <= ${now}`).orderBy(desc(s.entitlementVersions.version)).limit(1);
    const matrix = ent[0]?.matrix as Record<string, Record<string, number | boolean | null>> | undefined;
    return PLAN_CODES.map((code) => {
      const row = byCode.get(code);
      const v = current.get(code);
      const price = effective(code, row?.priceMonthlySatang ?? null, row?.priceYearlySatang ?? null);
      const mine = subs.filter((x) => x.plan === code);
      return {
        code,
        name: row?.displayName ?? PLAN_NAMES[code],
        defaultName: PLAN_NAMES[code],
        monthlySatang: price.monthly,
        yearlySatang: price.yearly,
        yearlyCustom: price.yearlyCustom,
        yearlyMonths: YEARLY_MONTHS,
        listed: row?.listed ?? true,
        openForSignup: row?.openForSignup ?? true,
        seatLimit: row?.seatLimit ?? null,
        storageGbPerMember: row?.storageGbPerMember ?? null,
        projects: matrix ? ((matrix[code]?.projects as number | null) ?? null) : DEFAULT_PROJECTS[code],
        customers: mine.length,
        // จ่ายราคาเวอร์ชันเก่าอยู่ (ลูกค้าที่จ่ายเงินและผูกกับเวอร์ชันอื่นที่ไม่ใช่ปัจจุบัน)
        grandfathered: v ? mine.filter((x) => (x.status === 'active' || x.status === 'past_due') && x.versionId && x.versionId !== v.id).length : 0,
        version: v?.version ?? null,
        priceEditable: PRICED.includes(code),
      };
    });
  }

  /** ประวัติราคา (แท็บ "ประวัติราคา") · ใหม่สุดก่อน พร้อมความต่างจากเวอร์ชันก่อนหน้าของแพ็กเกจเดียวกัน */
  async priceHistory(now = new Date()) {
    const creator = sql<string | null>`(select name from staff_users where id = ${s.planPriceVersions.createdBy})`;
    const approver = sql<string | null>`(select name from staff_users where id = ${s.planPriceVersions.approvedBy})`;
    const rows = await this.db.select({ v: s.planPriceVersions, createdBy: creator, approvedBy: approver }).from(s.planPriceVersions).orderBy(s.planPriceVersions.planCode, s.planPriceVersions.version);
    const current = await this.currentVersions(now);
    const prev = new Map<string, VersionRow>();
    const out = rows.map(({ v, createdBy, approvedBy }) => {
      const code = v.planCode as PlanCode;
      const before = prev.get(code);
      prev.set(code, v);
      const pe = (x: VersionRow) => effective(code, x.monthlySatang, x.yearlySatang);
      const changes: { field: 'name' | 'monthly' | 'yearly' | 'listed' | 'openForSignup'; from: string | number | boolean | null; to: string | number | boolean | null }[] = [];
      if (before) {
        const a = pe(before);
        const b = pe(v);
        if ((before.displayName ?? PLAN_NAMES[code]) !== (v.displayName ?? PLAN_NAMES[code])) changes.push({ field: 'name', from: before.displayName ?? PLAN_NAMES[code], to: v.displayName ?? PLAN_NAMES[code] });
        if (a.monthly !== b.monthly) changes.push({ field: 'monthly', from: a.monthly, to: b.monthly });
        if (a.yearly !== b.yearly) changes.push({ field: 'yearly', from: a.yearly, to: b.yearly });
        if (before.listed !== v.listed) changes.push({ field: 'listed', from: before.listed, to: v.listed });
        if (before.openForSignup !== v.openForSignup) changes.push({ field: 'openForSignup', from: before.openForSignup, to: v.openForSignup });
      }
      return {
        id: v.id,
        plan: code,
        planName: v.displayName ?? PLAN_NAMES[code],
        version: v.version,
        displayName: v.displayName,
        monthlySatang: v.monthlySatang,
        yearlySatang: v.yearlySatang,
        listed: v.listed,
        openForSignup: v.openForSignup,
        existingPolicy: v.existingPolicy as 'grandfather' | 'next_cycle',
        existingFrom: v.existingFrom,
        effectiveAt: v.effectiveAt,
        reason: v.reason,
        createdBy,
        approvedBy,
        status: current.get(code)?.id === v.id ? ('current' as const) : ('past' as const),
        changes,
      };
    });
    return { items: out.sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime() || b.version - a.version) };
  }

  // ---------------------------------------------------------------------------
  // P1 · แก้ไขแพ็กเกจ
  // ---------------------------------------------------------------------------

  async updatePlan(staff: Staff, plan: string, input: z.infer<typeof PlanBody>): Promise<Gated<{ version: number }>> {
    const p = z.enum(PLAN_CODES).safeParse(plan);
    if (!p.success) throw new AppError(404, 'not_found', 'ไม่พบแพ็กเกจนี้');
    const code = p.data;
    const [row] = await this.db.select().from(s.plans).where(eq(s.plans.code, code));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบแพ็กเกจนี้');
    const before = effective(code, row.priceMonthlySatang, row.priceYearlySatang);
    const after = effective(code, input.monthlySatang, input.yearlySatang);
    // Free / Enterprise: ค่าที่ส่งมาต้องเท่าค่าเดิม (หน้าเว็บส่งค่าปัจจุบันกลับมา)
    const fixedChanged = !PRICED.includes(code) && ((input.monthlySatang ?? null) !== before.monthly || (input.yearlySatang !== null && input.yearlySatang !== before.yearly));
    const priceChanged = PRICED.includes(code) && (before.monthly !== after.monthly || before.yearly !== after.yearly || before.yearlyCustom !== after.yearlyCustom);
    if (fixedChanged) throw new AppError(422, 'price_not_editable', `ราคา ${PLAN_NAMES[code]} แก้ไม่ได้ (${code === 'free' ? 'ฟรีเสมอ' : 'ตามใบเสนอราคา'})`);
    if (PRICED.includes(code) && input.monthlySatang === null) throw new AppError(422, 'price_required', 'กรอกราคาต่อเดือน', { fields: [{ path: 'monthlySatang', message: 'กรอกราคาต่อเดือน' }] });
    const nameChanged = (row.displayName ?? PLAN_NAMES[code]) !== input.displayName;
    if (!priceChanged && !nameChanged && row.listed === input.listed && row.openForSignup === input.openForSignup) throw new AppError(422, 'no_changes', 'ไม่มีอะไรต่างจากที่ใช้อยู่');
    const payload: PricePayload = { plan: code, input: { ...input, existingPolicy: priceChanged ? input.existingPolicy : 'grandfather' } };
    if (!priceChanged) return this.applyPlan(staff, payload);
    const summary = `${PLAN_NAMES[code]} ราคา/เดือน ${this.show(before.monthly)} → ${this.show(after.monthly)} · ราคา/ปี ${this.show(before.yearly)} → ${this.show(after.yearly)} · ${input.existingPolicy === 'grandfather' ? 'ลูกค้าเดิมใช้ราคาเดิม' : `ลูกค้าเดิมเปลี่ยนตามรอบถัดไป (แจ้งล่วงหน้า ${PRICE_NOTICE_DAYS} วัน)`}`;
    const pending = await this.approvals.gate(staff, {
      kind: 'promotions.plan_price',
      target: { type: 'plan', id: row.id },
      payload: payload as unknown as Record<string, unknown>,
      reason: input.reason,
      exceeds: true,
      rule: `เปลี่ยนราคาแพ็กเกจต้องมีคนอนุมัติ · ${summary}`,
    });
    return { pendingApproval: pending! };
  }

  private show(v: number | null) {
    return v === null ? 'ตามใบเสนอราคา' : baht(v);
  }

  /** บันทึกเป็นเวอร์ชันใหม่ + ตั้งค่าใน plans (ราคาสำหรับลูกค้าใหม่ / หน้าราคา) · next_cycle ส่งประกาศถึงลูกค้าเดิมที่ถูกกระทบ */
  private async applyPlan(staff: Staff, p: PricePayload, ctx?: ApprovalContext) {
    const { plan: code, input } = p;
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      // ล็อกตารางสั้น ๆ กันเลขเวอร์ชันชนกันเมื่ออนุมัติพร้อมกัน
      await tx.execute(sql`LOCK TABLE ${s.planPriceVersions} IN SHARE ROW EXCLUSIVE MODE`);
      const [row] = await tx.select().from(s.plans).where(eq(s.plans.code, code)).for('update');
      if (!row) throw new AppError(404, 'not_found', 'ไม่พบแพ็กเกจนี้');
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${s.planPriceVersions.version}), 0)::int` }).from(s.planPriceVersions).where(eq(s.planPriceVersions.planCode, code));
      const before = effective(code, row.priceMonthlySatang, row.priceYearlySatang);
      // ยังไม่มีเวอร์ชัน (ฐานใหม่ที่ไม่ได้ผ่าน migration): เก็บค่าเดิมเป็นเวอร์ชัน 1 ก่อน ลูกค้าเดิมจึงผูกกับราคานั้นได้
      let next = n + 1;
      if (n === 0) {
        const [first] = await tx
          .insert(s.planPriceVersions)
          .values({ planCode: code, version: 1, displayName: row.displayName, monthlySatang: row.priceMonthlySatang, yearlySatang: row.priceYearlySatang, listed: row.listed, openForSignup: row.openForSignup, effectiveAt: new Date(now.getTime() - 1000), reason: 'ราคาก่อนแก้ครั้งแรก' })
          .returning();
        await tx.update(s.subscriptions).set({ priceVersionId: first.id }).where(and(eq(s.subscriptions.planId, row.id), isNull(s.subscriptions.priceVersionId)));
        next = 2;
      }
      const wanted = effective(code, input.monthlySatang, input.yearlySatang);
      const priceChanged = PRICED.includes(code) && (before.monthly !== wanted.monthly || before.yearly !== wanted.yearly || before.yearlyCustom !== wanted.yearlyCustom);
      // ไม่เปลี่ยนราคา: เก็บค่าเดิมไว้ (null = ยังใช้ราคาตั้งต้นในโค้ด)
      const monthly = priceChanged ? input.monthlySatang : row.priceMonthlySatang;
      const yearly = priceChanged ? input.yearlySatang : row.priceYearlySatang;
      const after = effective(code, monthly, yearly);
      const policy = priceChanged ? input.existingPolicy : 'grandfather';
      const existingFrom = policy === 'next_cycle' ? new Date(now.getTime() + PRICE_NOTICE_DAYS * DAY) : null;
      const [v] = await tx
        .insert(s.planPriceVersions)
        .values({ planCode: code, version: next, displayName: input.displayName === PLAN_NAMES[code] ? null : input.displayName, monthlySatang: monthly, yearlySatang: yearly, listed: input.listed, openForSignup: input.openForSignup, existingPolicy: policy, existingFrom, effectiveAt: now, reason: input.reason, createdBy: staff.id, approvedBy: ctx?.approver.id ?? null, approvalRequestId: ctx?.requestId ?? null })
        .returning();
      await tx
        .update(s.plans)
        .set({ displayName: v.displayName, priceMonthlySatang: monthly, priceYearlySatang: yearly, listed: input.listed, openForSignup: input.openForSignup, updatedAt: now })
        .where(eq(s.plans.id, row.id));
      const parts = [
        priceChanged ? `ราคา/เดือน ${this.show(before.monthly)} → ${this.show(after.monthly)} · ราคา/ปี ${this.show(before.yearly)} → ${this.show(after.yearly)}` : null,
        (row.displayName ?? PLAN_NAMES[code]) !== input.displayName ? `ชื่อ "${row.displayName ?? PLAN_NAMES[code]}" → "${input.displayName}"` : null,
        row.listed !== input.listed ? (input.listed ? 'แสดงในหน้าราคา' : 'ซ่อนจากหน้าราคา') : null,
        row.openForSignup !== input.openForSignup ? (input.openForSignup ? 'เปิดรับสมัครใหม่' : 'ปิดรับสมัครใหม่') : null,
        priceChanged ? (policy === 'grandfather' ? 'ลูกค้าเดิมใช้ราคาเดิม' : `ลูกค้าเดิมเปลี่ยนตั้งแต่ ${existingFrom!.toISOString().slice(0, 10)}`) : null,
      ].filter(Boolean);
      await staffAudit(tx, staff, 'promotions.plan_updated', `${PLAN_NAMES[code]} เวอร์ชัน ${v.version} · ${parts.join(' · ')} · ${input.reason}`, { type: 'plan_price_version', id: v.id }, undefined, approvalOf(ctx));
      // ลูกค้าเดิมที่จ่ายแพ็กเกจนี้อยู่ (จะถูกเปลี่ยนราคาตามรอบถัดไป)
      const affected = policy === 'next_cycle'
        ? await tx
            .select({ id: s.subscriptions.workspaceId })
            .from(s.subscriptions)
            .innerJoin(s.workspaces, eq(s.workspaces.id, s.subscriptions.workspaceId))
            .where(and(eq(s.subscriptions.planId, row.id), inArray(s.subscriptions.status, ['active', 'past_due']), isNull(s.workspaces.deletedAt)))
        : [];
      return { v, after, existingFrom, affected: affected.map((a) => a.id) };
    });
    // แจ้งล่วงหน้า 30 วันทางอีเมล + แบนเนอร์ (O24) · ส่งไม่สำเร็จไม่ย้อนการแก้ราคา แต่ลงไว้ให้ทีมส่งเอง
    let announced = 0;
    if (result.affected.length && result.existingFrom) {
      const date = result.existingFrom.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'long' });
      const message = `เรียนผู้ดูแล {ชื่อ Workspace}\n\nแพ็กเกจ ${input.displayName} จะปรับราคาเป็น ${this.show(result.after.monthly)} ต่อเดือน (${this.show(result.after.yearly)} ต่อปี · ก่อน VAT) สำหรับรอบบิลที่ชำระตั้งแต่ ${date}\nรอบที่ชำระก่อนวันนั้นยังใช้ราคาเดิม · สอบถามได้ที่ทีม Support`;
      try {
        await this.announcements.create(staff, { workspaceIds: result.affected, title: `แจ้งปรับราคาแพ็กเกจ ${input.displayName}`, message, channels: ['email', 'banner'] });
        announced = result.affected.length;
      } catch (e) {
        await staffAudit(this.db, staff, 'promotions.price_notice_failed', `ส่งประกาศปรับราคา ${PLAN_NAMES[code]} ไม่สำเร็จ: ${(e as Error).message}`, { type: 'plan_price_version', id: result.v.id });
      }
    }
    return { version: result.v.version, announced };
  }

  // ---------------------------------------------------------------------------
  // คูปอง
  // ---------------------------------------------------------------------------

  private async couponRows(ids?: string[]) {
    const creator = sql<string | null>`(select name from staff_users where id = ${s.coupons.createdBy})`;
    const rows = await this.db.select({ c: s.coupons, createdBy: creator }).from(s.coupons).where(ids ? inArray(s.coupons.id, ids) : undefined).orderBy(desc(s.coupons.createdAt));
    if (!rows.length) return [];
    const couponIds = rows.map((r) => r.c.id);
    const stats = await this.db
      .select({
        id: s.couponRedemptions.couponId,
        used: sql<number>`count(*) filter (where ${s.couponRedemptions.status} in ('active', 'ended'))::int`,
        pending: sql<number>`count(*) filter (where ${s.couponRedemptions.status} = 'pending' and exists (select 1 from coupon_uses u join invoices i on i.id = u.invoice_id where u.redemption_id = coupon_redemptions.id and i.status in ('open', 'pending_review')))::int`,
      })
      .from(s.couponRedemptions)
      .where(inArray(s.couponRedemptions.couponId, couponIds))
      .groupBy(s.couponRedemptions.couponId);
    const given = await this.db
      .select({ id: s.couponUses.couponId, n: sql<number>`coalesce(sum(${s.couponUses.amount}), 0)::bigint` })
      .from(s.couponUses)
      .where(and(inArray(s.couponUses.couponId, couponIds), eq(s.couponUses.status, 'paid')))
      .groupBy(s.couponUses.couponId);
    const retention = await this.retention(couponIds);
    const pending = await this.db
      .select({ id: sql<string>`${s.approvalRequests.payload} ->> 'couponId'` })
      .from(s.approvalRequests)
      .where(and(eq(s.approvalRequests.kind, 'promotions.coupon_activate'), eq(s.approvalRequests.status, 'pending'), gt(s.approvalRequests.expiresAt, new Date())));
    const waiting = new Set(pending.map((p) => p.id));
    const st = new Map(stats.map((x) => [x.id, x]));
    const gv = new Map(given.map((x) => [x.id, Number(x.n)]));
    const today = todayBkk();
    return rows.map(({ c, createdBy }) => {
      const used = st.get(c.id)?.used ?? 0;
      const state =
        c.status !== 'active' ? c.status : c.expiresOn && c.expiresOn < today ? 'expired' : c.maxRedemptions !== null && used >= c.maxRedemptions ? 'exhausted' : 'active';
      return {
        id: c.id,
        code: c.code,
        description: c.description,
        kind: c.kind,
        value: c.value,
        duration: c.duration,
        durationCycles: c.durationCycles,
        planCodes: c.planCodes,
        maxRedemptions: c.maxRedemptions,
        expiresOn: c.expiresOn,
        newCustomersOnly: c.newCustomersOnly,
        stackable: c.stackable,
        status: c.status,
        state,
        used,
        pending: st.get(c.id)?.pending ?? 0,
        discountGivenSatang: gv.get(c.id) ?? 0,
        retention: retention.get(c.id) ?? { ended: 0, eligible: 0, kept: 0, rate: null },
        createdAt: c.createdAt,
        createdBy,
        activatedAt: c.activatedAt,
        disabledAt: c.disabledAt,
        disableReason: c.disableReason,
        pendingApproval: waiting.has(c.id),
      };
    });
  }

  /**
   * ลูกค้าที่จ่ายต่อหลังหมดส่วนลด (ต่อคูปอง)
   * - หมดส่วนลด = ใช้ครบรอบแล้ว (ended) · ตลอดไปไม่มีวันหมด
   * - นับเป็นตัวหาร (eligible) เมื่อรอบสุดท้ายที่ได้ส่วนลดสิ้นสุดแล้ว หรือจ่ายต่อแล้ว
   * - จ่ายต่อ (kept) = มีใบแจ้งหนี้ที่ชำระแล้วและมียอด ออกหลังใบสุดท้ายที่ได้ส่วนลดของคูปองนี้
   */
  private async retention(couponIds: string[]) {
    const rows = await this.db.execute<{ coupon_id: string; ended: number; eligible: number; kept: number }>(sql`
      with last as (
        select r.coupon_id, r.workspace_id, r.id,
          max(i.period_end) as last_end, max(i.created_at) as last_at
        from coupon_redemptions r
        join coupon_uses u on u.redemption_id = r.id and u.status = 'paid'
        join invoices i on i.id = u.invoice_id
        where r.status = 'ended' and r.coupon_id in (${sql.join(couponIds.map((id) => sql`${id}::uuid`), sql`, `)})
        group by r.coupon_id, r.workspace_id, r.id
      ), k as (
        select l.*, exists (
          select 1 from invoices i2
          where i2.workspace_id = l.workspace_id and i2.status = 'paid' and i2.subtotal > 0 and i2.created_at > l.last_at
            and not exists (select 1 from coupon_uses u2 where u2.invoice_id = i2.id and u2.redemption_id = l.id)
        ) as kept
        from last l
      )
      select coupon_id, count(*)::int as ended,
        count(*) filter (where kept or last_end < (now() at time zone 'Asia/Bangkok')::date)::int as eligible,
        count(*) filter (where kept)::int as kept
      from k group by coupon_id`);
    return new Map(
      rows.rows.map((r) => [r.coupon_id, { ended: Number(r.ended), eligible: Number(r.eligible), kept: Number(r.kept), rate: Number(r.eligible) ? Number(r.kept) / Number(r.eligible) : null }]),
    );
  }

  private async coupon(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบคูปองนี้');
    const [c] = await this.db.select().from(s.coupons).where(eq(s.coupons.id, id));
    if (!c) throw new AppError(404, 'not_found', 'ไม่พบคูปองนี้');
    return c;
  }
  private async dto(id: string) {
    return (await this.couponRows([id]))[0];
  }

  /** ข้อความสั้นของคูปอง (Audit log) */
  private describe(c: Pick<CouponRow, 'code' | 'kind' | 'value' | 'duration' | 'durationCycles' | 'planCodes'>) {
    const off = c.kind === 'percent' ? `ลด ${c.value}%` : c.kind === 'amount' ? `ลด ${baht(c.value)}` : `ใช้ฟรี ${c.value} เดือน`;
    const dur = c.kind === 'free_months' ? '' : c.duration === 'once' ? ' ครั้งเดียว' : c.duration === 'forever' ? ' ตลอดไป' : ` ${c.durationCycles} รอบบิลแรก`;
    return `${c.code} · ${off}${dur} · ${c.planCodes.map((p) => PLAN_NAMES[p as PlanCode] ?? p).join(', ')}`;
  }

  async createCoupon(staff: Staff, input: z.infer<typeof CouponBody>) {
    const { activate, ...v } = input;
    const [taken] = await this.db.select({ id: s.coupons.id }).from(s.coupons).where(eq(s.coupons.code, v.code));
    if (taken) throw new AppError(409, 'coupon_code_taken', `โค้ด ${v.code} มีอยู่แล้ว`, { fields: [{ path: 'code', message: 'โค้ดนี้มีอยู่แล้ว' }] });
    const row = await this.db.transaction(async (tx) => {
      const [c] = await tx.insert(s.coupons).values({ ...(this.values(v) as typeof s.coupons.$inferInsert), createdBy: staff.id }).returning();
      await staffAudit(tx, staff, 'promotions.coupon_created', `สร้างคูปองร่าง ${this.describe(c)}`, { type: 'coupon', id: c.id });
      return c;
    });
    if (!activate) return { coupon: await this.dto(row.id) };
    const r = await this.activate(staff, row.id);
    return 'pendingApproval' in r ? { coupon: await this.dto(row.id), pendingApproval: r.pendingApproval } : r;
  }

  private values(v: Partial<CouponInput>) {
    const kind = v.kind;
    return {
      ...(v.code !== undefined ? { code: v.code } : {}),
      ...(v.description !== undefined ? { description: v.description || null } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(v.value !== undefined ? { value: v.value } : {}),
      ...(v.duration !== undefined ? { duration: kind === 'free_months' ? 'once' : v.duration, durationCycles: v.duration === 'repeating' && kind !== 'free_months' ? (v.durationCycles ?? 1) : null } : {}),
      ...(v.planCodes !== undefined ? { planCodes: [...new Set(v.planCodes)] } : {}),
      ...(v.maxRedemptions !== undefined ? { maxRedemptions: v.maxRedemptions ?? null } : {}),
      ...(v.expiresOn !== undefined ? { expiresOn: v.expiresOn ?? null } : {}),
      ...(v.newCustomersOnly !== undefined ? { newCustomersOnly: v.newCustomersOnly } : {}),
      ...(v.stackable !== undefined ? { stackable: kind === 'free_months' ? false : v.stackable } : {}),
    };
  }

  /** ร่างแก้ได้ทุกช่อง · เปิดแล้ว / ปิดแล้วแก้ได้เฉพาะคำอธิบาย วันหมดอายุ และจำนวนสิทธิ์ (P4 "แก้วันหมดอายุ") */
  async updateCoupon(staff: Staff, id: string, input: z.infer<typeof CouponPatch>) {
    const c = await this.coupon(id);
    const keys = Object.keys(input) as (keyof typeof input)[];
    if (!keys.length) throw new AppError(422, 'no_changes', 'ไม่มีอะไรเปลี่ยน');
    const open: (keyof typeof input)[] = ['description', 'expiresOn', 'maxRedemptions'];
    if (c.status !== 'draft' && keys.some((k) => !open.includes(k) && JSON.stringify(input[k]) !== JSON.stringify((c as Record<string, unknown>)[k])))
      throw new AppError(422, 'coupon_locked', 'คูปองที่เปิดใช้แล้วแก้ได้เฉพาะคำอธิบาย วันหมดอายุ และจำนวนสิทธิ์ · ต้องการเงื่อนไขอื่นให้คัดลอกเป็นคูปองใหม่');
    if (input.code && input.code !== c.code) {
      const [taken] = await this.db.select({ id: s.coupons.id }).from(s.coupons).where(eq(s.coupons.code, input.code));
      if (taken) throw new AppError(409, 'coupon_code_taken', `โค้ด ${input.code} มีอยู่แล้ว`, { fields: [{ path: 'code', message: 'โค้ดนี้มีอยู่แล้ว' }] });
    }
    // เติมค่าที่ไม่ได้ส่งจากของเดิม แล้วตรวจกติกาข้ามช่องอีกครั้ง (ตรงกับ check ของตาราง)
    const merged = { kind: c.kind, value: c.value, duration: c.duration, durationCycles: c.durationCycles, stackable: c.stackable, ...input } as Partial<CouponInput>;
    z.unknown().superRefine((_, ctx) => checkCoupon({ ...merged, expiresOn: input.expiresOn }, ctx)).parse(null);
    const patch = c.status === 'draft' ? this.values(merged) : this.values(Object.fromEntries(keys.filter((k) => open.includes(k)).map((k) => [k, input[k]])) as Partial<CouponInput>);
    await this.db.transaction(async (tx) => {
      const [after] = await tx.update(s.coupons).set(patch).where(eq(s.coupons.id, c.id)).returning();
      const what = keys.map((k) => `${k}: ${JSON.stringify((c as Record<string, unknown>)[k] ?? null)} → ${JSON.stringify((after as Record<string, unknown>)[k] ?? null)}`).join(' · ');
      await staffAudit(tx, staff, 'promotions.coupon_updated', `แก้คูปอง ${after.code} · ${what}`, { type: 'coupon', id: c.id });
    });
    return { coupon: await this.dto(c.id) };
  }

  /**
   * เปิดใช้คูปอง (แตะ key ที่ controller) · ส่วนลดเกินวงเงินของพนักงาน (06 › 3 · ≤ 30% และ ≤ 12 รอบ) หรือตลอดไป → ต้องให้ Owner อนุมัติ
   * จำนวนเงินเทียบเป็นเปอร์เซ็นต์ของราคารายเดือนที่ถูกที่สุดในแพ็กเกจที่ใช้ได้
   */
  async activate(staff: Staff, id: string): Promise<Gated<{ coupon: Awaited<ReturnType<PromotionsService['dto']>> }>> {
    const c = await this.coupon(id);
    if (c.status === 'active') throw new AppError(409, 'coupon_already_active', 'คูปองนี้เปิดใช้อยู่แล้ว');
    if (c.expiresOn && c.expiresOn < todayBkk()) throw new AppError(422, 'coupon_expired', 'คูปองหมดอายุแล้ว · แก้วันหมดอายุก่อนเปิดใช้');
    const { discountPct, discountCycles } = staff.limits;
    const cycles = cyclesOf(c);
    let pct = c.kind === 'percent' ? c.value : 0;
    if (c.kind === 'amount') {
      const rows = await this.db.select().from(s.plans).where(inArray(s.plans.code, c.planCodes));
      const prices = rows.map((r) => effective(r.code as PlanCode, r.priceMonthlySatang, r.priceYearlySatang).monthly).filter((x): x is number => !!x);
      pct = prices.length ? (c.value / Math.min(...prices)) * 100 : 100;
    }
    if (c.kind === 'free_months') pct = 100;
    const months = c.kind === 'free_months' ? c.value : cycles;
    // ใช้ฟรี N เดือน = ส่วนลด 100% นาน N เดือน
    const exceeds = pct > discountPct || months === null || months > discountCycles;
    const pending = await this.approvals.gate(staff, {
      kind: 'promotions.coupon_activate',
      target: { type: 'coupon', id: c.id },
      payload: { couponId: c.id },
      reason: `เปิดใช้คูปอง ${this.describe(c)}`,
      exceeds,
      rule: `คูปองเกินวงเงินส่วนลด (≤ ${discountPct}% และ ≤ ${discountCycles} รอบ) หรือไม่มีวันสิ้นสุดส่วนลด ต้องให้ Owner อนุมัติ · ${this.describe(c)}`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyActivate(staff, c.id);
  }

  private async applyActivate(staff: Staff, id: string, ctx?: ApprovalContext) {
    await this.db.transaction(async (tx) => {
      const [c] = await tx
        .update(s.coupons)
        .set({ status: 'active', activatedAt: new Date(), activatedBy: staff.id, disabledAt: null, disabledBy: null, disableReason: null })
        .where(and(eq(s.coupons.id, id), sql`${s.coupons.status} <> 'active'`))
        .returning();
      if (!c) throw new AppError(409, 'coupon_already_active', 'คูปองนี้เปิดใช้อยู่แล้ว');
      await staffAudit(tx, staff, 'promotions.coupon_activated', `เปิดใช้คูปอง ${this.describe(c)}`, { type: 'coupon', id }, undefined, approvalOf(ctx));
    });
    return { coupon: await this.dto(id) };
  }

  /** ปิดก่อนกำหนด: ใส่โค้ดใหม่ไม่ได้ · Workspace ที่ใช้อยู่ยังได้ส่วนลดครบรอบ */
  async disable(staff: Staff, id: string, input: z.infer<typeof DisableBody>) {
    await this.db.transaction(async (tx: Tx) => {
      const [c] = await tx
        .update(s.coupons)
        .set({ status: 'disabled', disabledAt: new Date(), disabledBy: staff.id, disableReason: input.reason })
        .where(and(eq(s.coupons.id, id), eq(s.coupons.status, 'active')))
        .returning();
      if (!c) {
        await this.coupon(id);
        throw new AppError(409, 'coupon_not_active', 'ปิดได้เฉพาะคูปองที่เปิดใช้อยู่');
      }
      await staffAudit(tx, staff, 'promotions.coupon_disabled', `ปิดคูปอง ${c.code} ก่อนกำหนด · ${input.reason}`, { type: 'coupon', id });
    });
    return { coupon: await this.dto(id) };
  }

  /** ลูกค้าที่ใช้คูปอง (P4 "ดูลูกค้าที่ใช้") */
  async redemptions(id: string) {
    const c = await this.coupon(id);
    const rows = await this.db
      .select({ r: s.couponRedemptions, ws: { id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug } })
      .from(s.couponRedemptions)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.couponRedemptions.workspaceId))
      .where(eq(s.couponRedemptions.couponId, c.id))
      .orderBy(desc(s.couponRedemptions.createdAt));
    const ids = rows.map((r) => r.r.id);
    const uses = ids.length
      ? await this.db
          .select({ id: s.couponUses.redemptionId, n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${s.couponUses.amount}), 0)::bigint`, lastAt: sql<Date>`max(${s.couponUses.createdAt})` })
          .from(s.couponUses)
          .where(and(inArray(s.couponUses.redemptionId, ids), eq(s.couponUses.status, 'paid')))
          .groupBy(s.couponUses.redemptionId)
      : [];
    const byId = new Map(uses.map((u) => [u.id, u]));
    const kept = new Set<string>();
    for (const r of rows.filter((x) => x.r.status === 'ended')) {
      const last = byId.get(r.r.id)?.lastAt;
      if (!last) continue;
      const [hit] = await this.db.execute<{ ok: boolean }>(sql`
        select exists (select 1 from invoices i where i.workspace_id = ${r.ws.id} and i.status = 'paid' and i.subtotal > 0 and i.created_at > ${new Date(last)}
          and not exists (select 1 from coupon_uses u where u.invoice_id = i.id and u.redemption_id = ${r.r.id})) as ok`).then((x) => x.rows);
      if (hit?.ok) kept.add(r.r.id);
    }
    return {
      items: rows.map(({ r, ws }) => ({
        workspace: ws,
        status: r.status,
        cyclesTotal: r.cyclesTotal,
        cyclesUsed: byId.get(r.id)?.n ?? 0,
        discountSatang: Number(byId.get(r.id)?.amount ?? 0),
        createdAt: r.createdAt,
        endedAt: r.endedAt,
        keptPaying: r.status === 'ended' ? kept.has(r.id) : null,
      })),
    };
  }
}
