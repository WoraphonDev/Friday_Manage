import { Inject, Injectable } from '@nestjs/common';
import { config } from '../config.js';
import { creditBalance, type Db, downgradeBlockers, prorateUpgrade, schema, type Tx } from '@friday/db';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { PlanLimits } from '../core/plan-limits.js';
import { GB, PLAN_CATALOG, computeQuote, priceFor, type Cycle, type PlanCode } from './catalog.js';
import { choosePrice, CouponCode, resolveDiscount } from '../payments/coupons.js';

const s = schema;

export const QuoteQuery = z.object({
  plan: z.enum(['team_s', 'team_m', 'team_l']),
  cycle: z.enum(['monthly', 'yearly']).default('monthly'),
  wht: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** โค้ดส่วนลด (O20) · ไม่ส่ง = ใช้เฉพาะส่วนลดที่ได้ต่อจากรอบก่อน */
  coupon: CouponCode.optional(),
});

/** R6 · ตั้งให้ลดแพ็กเกจ / เปลี่ยนรอบบิลมีผลรอบถัดไป */
export const ScheduleChangeBody = z.object({ plan: z.enum(['team_s', 'team_m', 'team_l']), cycle: z.enum(['monthly', 'yearly']) });

export const ProfileBody = z
  .object({
    companyName: z.string().trim().min(1).max(200),
    taxId: z.string().trim().regex(/^\d{13}$/, 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก'),
    branchType: z.enum(['head', 'branch']).default('head'),
    branchNo: z.string().trim().regex(/^\d{5}$/, 'รหัสสาขาต้องเป็นตัวเลข 5 หลัก').nullish(),
    address: z.string().trim().min(1).max(500),
    taxEmail: z.string().trim().toLowerCase().email().max(254),
    whtEnabled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.branchType === 'branch' && !v.branchNo) ctx.addIssue({ code: 'custom', path: ['branchNo'], message: 'สาขาต้องระบุรหัสสาขา' });
  });

const DAY = 86_400_000;

/** หน้า Q2 / R2 · ใช้งาน, แพ็กเกจ, ใบเสนอราคา และข้อมูลออกใบกำกับภาษี */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: TenantDb,
    private readonly limits: PlanLimits,
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  private requireBilling(tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.billing');
  }

  /** แบนเนอร์ Q2 · สมาชิกทุกคนดูได้ (Guest ไม่เห็นตัวเลขขององค์กร) */
  async usage(auth: AuthInfo, tenant: TenantInfo) {
    if (tenant.role === 'guest') throw forbidden('ws.usage.view');
    const snap = await this.db.run(auth, tenant, (tx) => this.limits.snapshot(tx, tenant.workspaceId));
    const row = (kind: 'seats' | 'projects' | 'storage_bytes') => {
      const limit = snap.limits[kind];
      const used = snap.usage[kind];
      return { used, limit, ratio: limit ? Math.min(used / limit, 1) : 0, over: limit !== null && used > limit };
    };
    const seats = row('seats');
    const projects = row('projects');
    const storage = row('storage_bytes');
    const { subscription } = snap;
    const now = Date.now();
    const trialEnds = subscription.status === 'trialing' ? subscription.trialEndsAt : null;
    return {
      plan: snap.plan,
      status: subscription.status,
      trial: trialEnds ? { endsAt: trialEnds, daysLeft: Math.max(0, Math.ceil((trialEnds.getTime() - now) / DAY)), expired: trialEnds.getTime() <= now } : null,
      seats,
      projects,
      storage: { ...storage, usedGb: Math.round((storage.used / GB) * 100) / 100, limitGb: storage.limit === null ? null : Math.round(storage.limit / GB) },
      // ผู้ที่จ่ายเงินไม่ได้ (Member) เห็นปุ่ม "ขอให้ Admin อัปเกรด" แทน
      canManageBilling: tenant.role === 'owner' || tenant.role === 'admin',
      // สิทธิ์ทุกคีย์ตามเวอร์ชันและ override (O21) ให้หน้าเว็บซ่อน / ล็อกฟีเจอร์ได้
      entitlements: snap.entitlements,
    };
  }

  /** `GET w/billing` · แพ็กเกจ, ใบแจ้งหนี้ และข้อมูลภาษี */
  async overview(auth: AuthInfo, tenant: TenantInfo) {
    this.requireBilling(tenant);
    const snap = await this.db.run(auth, tenant, (tx) => this.limits.snapshot(tx, tenant.workspaceId));
    const { invoices, profile } = await this.db.run(auth, tenant, async (tx) => ({
      invoices: await tx
        .select({
          id: s.invoices.id,
          number: s.invoices.number,
          periodStart: s.invoices.periodStart,
          periodEnd: s.invoices.periodEnd,
          total: s.invoices.total,
          whtAmount: s.invoices.whtAmount,
          amountDue: s.invoices.amountDue,
          status: s.invoices.status,
          dueDate: s.invoices.dueDate,
          paidAt: s.invoices.paidAt,
        })
        .from(s.invoices)
        .orderBy(desc(s.invoices.periodStart))
        .limit(24),
      profile: await this.readProfile(tx),
    }));
    const sub = await this.limits.ensureSubscription(tenant.workspaceId);
    // R1 / R4 / R7: เครดิตคงเหลือ และการลดแพ็กเกจ / เปลี่ยนรอบที่ตั้งไว้ (ตารางแพ็กเกจลูกค้าอ่านได้ แต่อ่านผ่าน SYSTEM_DB ให้ได้ชื่อแพ็กเกจในคำสั่งเดียว)
    const [pending] = await this.system
      .select({ plan: s.plans.code, cycle: s.subscriptions.pendingCycle })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.pendingPlanId))
      .where(eq(s.subscriptions.workspaceId, tenant.workspaceId));
    const creditSatang = await this.credit(auth, tenant);
    return {
      plan: snap.plan,
      subscription: {
        status: sub.status,
        cycle: sub.cycle,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodEnd: sub.currentPeriodEnd,
        planCode: sub.planCode,
      },
      creditSatang,
      pendingChange: pending ? { plan: pending.plan, cycle: pending.cycle ?? sub.cycle, effectiveAt: sub.currentPeriodEnd, blockers: await this.downgradeBlockers(tenant.workspaceId, pending.plan as PlanCode) } : null,
      // ยกเลิกแพ็กเกจ = กลับเป็น Free เมื่อจบรอบ · หน้าต่างยกเลิกบอกล่วงหน้าว่าทีมใช้เกินขีดจำกัดของ Free อยู่เท่าไร
      freeBlockers: sub.planCode === 'free' ? [] : await this.downgradeBlockers(tenant.workspaceId, 'free'),
      limits: snap.limits,
      invoices,
      profile,
    };
  }

  /** R2 · สรุปยอด: VAT 7% คิดจากยอดก่อนภาษีหลังหักส่วนลด · หัก ณ ที่จ่าย 3% คิดจากยอดก่อน VAT · ราคารายปี = 10 เดือน */
  async quote(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof QuoteQuery>) {
    const { internal, ...dto } = await this.price(auth, tenant, q);
    void internal;
    // เครดิตคงเหลือหักใบนี้อัตโนมัติ (R5) · ใบกำกับภาษียังออกเต็มยอด
    const balance = await this.credit(auth, tenant);
    const apply = Math.min(balance, dto.amountDue);
    return { ...dto, credit: { balanceSatang: balance, applySatang: apply }, payNowSatang: dto.amountDue - apply };
  }

  /**
   * ราคาของ checkout (ใช้ทั้ง quote และสร้างใบแจ้งหนี้) · `tx` = ธุรกรรมของ checkout เพื่อตรวจคูปองในธุรกรรมเดียวกับที่บันทึก
   * ราคา: เวอร์ชันราคา + grandfathering (O20) · ส่วนลด: คูปองที่ได้ต่อ + โค้ดที่ใส่ใหม่
   */
  async price(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof QuoteQuery>, tx?: Tx) {
    this.requireBilling(tenant);
    const spec = PLAN_CATALOG[q.plan as PlanCode];
    const sub = await this.limits.ensureSubscription(tenant.workspaceId);
    const choice = await choosePrice(this.system, tenant.workspaceId, q.plan, (o) => priceFor(spec, q.cycle as Cycle, o));
    const listPrice = priceFor(spec, q.cycle as Cycle, choice.override);
    if (listPrice === null) throw new AppError(422, 'plan_not_purchasable', 'แพ็กเกจนี้ยังไม่เปิดขายออนไลน์ · ติดต่อฝ่ายขาย', { plan: q.plan });
    const change = await this.changeKind(tenant.workspaceId, sub, q.plan as PlanCode, q.cycle as Cycle, listPrice);
    if (change.kind === 'upgrade') {
      // R5 อัปเกรดกลางรอบ: จ่ายเฉพาะส่วนต่างของวันที่เหลือ ไม่เริ่มรอบใหม่ · ไม่ใช้คูปองกับส่วนต่าง (คูปองใช้ตอนต่ออายุ)
      if (q.coupon) throw new AppError(422, 'coupon_not_for_upgrade', 'ใช้คูปองตอนอัปเกรดกลางรอบไม่ได้ · ใช้ได้ตอนต่ออายุรอบถัดไป');
      return {
        ...computeQuote(spec, q.cycle as Cycle, q.wht, change.proration.diffSatang, config.vatRegistered),
        currentPlan: sub.planCode,
        vatRegistered: config.vatRegistered,
        documentType: config.vatRegistered ? 'tax_invoice_receipt' : 'receipt',
        listPrice,
        discount: 0,
        discounts: [] as Awaited<ReturnType<typeof resolveDiscount>>['discounts'],
        coupon: null,
        freeMonths: null,
        grandfathered: choice.grandfathered,
        change,
        internal: { priceVersionId: choice.versionId, apply: [] as Awaited<ReturnType<typeof resolveDiscount>>['apply'] },
      };
    }
    const input = { workspaceId: tenant.workspaceId, plan: q.plan, listPrice, code: q.coupon ?? null };
    const d = tx ? await resolveDiscount(this.system, tx, input) : await this.db.run(auth, tenant, (t) => resolveDiscount(this.system, t, input));
    // ยังไม่จด VAT: ไม่คิด VAT และเอกสารเป็นใบเสร็จ (หน้าชำระเงินซ่อนบรรทัด VAT ตาม documentType)
    return {
      ...computeQuote(spec, q.cycle as Cycle, q.wht, listPrice - d.discount, config.vatRegistered),
      currentPlan: sub.planCode,
      vatRegistered: config.vatRegistered,
      documentType: config.vatRegistered ? 'tax_invoice_receipt' : 'receipt',
      listPrice,
      discount: d.discount,
      discounts: d.discounts,
      coupon: d.coupon,
      freeMonths: d.freeMonths,
      grandfathered: choice.grandfathered,
      change,
      internal: { priceVersionId: choice.versionId, apply: d.apply },
    };
  }

  /**
   * ซื้อแพ็กเกจนี้ตอนนี้คือการเปลี่ยนแบบไหน (O41 · R5–R6)
   * - upgrade: จ่ายแล้วและยังอยู่ในรอบบิล · รอบบิลเดิม · ราคาแพงขึ้น → จ่ายส่วนต่างตามวันที่เหลือ
   * - next_cycle: ลดแพ็กเกจ หรือเปลี่ยนรอบบิลระหว่างรอบที่จ่ายแล้ว → ตั้งให้มีผลรอบถัดไป (POST billing/scheduled-change)
   * - new: ทดลองใช้ / หมดรอบ / ซื้อแพ็กเกจเดิมซ้ำ → เริ่มรอบใหม่ (แบบเดิม)
   */
  private async changeKind(workspaceId: string, sub: Awaited<ReturnType<PlanLimits['ensureSubscription']>>, plan: PlanCode, cycle: Cycle, newPrice: number) {
    const now = new Date();
    const inPaidPeriod = sub.status === 'active' && !!sub.currentPeriodEnd && sub.currentPeriodEnd > now && sub.planCode !== 'free';
    if (!inPaidPeriod || (plan === sub.planCode && cycle === sub.cycle)) return { kind: 'new' as const };
    const effectiveAt = sub.currentPeriodEnd!;
    if (cycle !== sub.cycle) return { kind: 'next_cycle' as const, reason: 'cycle' as const, effectiveAt };
    const cur = await choosePrice(this.system, workspaceId, sub.planCode, (o) => priceFor(PLAN_CATALOG[sub.planCode], cycle, o));
    const oldPrice = priceFor(PLAN_CATALOG[sub.planCode], cycle, cur.override) ?? 0;
    const proration = prorateUpgrade({ newPriceSatang: newPrice, oldPriceSatang: oldPrice, start: sub.currentPeriodStart ?? now, end: effectiveAt, now });
    if (proration.diffSatang <= 0) return { kind: 'next_cycle' as const, reason: 'downgrade' as const, effectiveAt };
    return { kind: 'upgrade' as const, proration, effectiveAt, fromPlan: sub.planCode };
  }

  /**
   * `POST w/billing/scheduled-change` (R6) · ลดแพ็กเกจหรือเปลี่ยนรอบบิล มีผลเมื่อจบรอบที่จ่ายแล้ว · ไม่มีเงินคืนรอบนี้
   * อัปเกรดไม่ผ่านทางนี้ (จ่ายส่วนต่างที่ checkout มีผลทันที) · subscriptions ลูกค้าแก้เองไม่ได้ จึงเขียนผ่าน SYSTEM_DB
   * วันที่มีผลยังเกินขีดจำกัดของแพ็กเกจใหม่ → งานรายชั่วโมงของ ops-api คงแพ็กเกจเดิมอีก 1 รอบและแจ้ง Owner
   */
  async scheduleChange(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof ScheduleChangeBody>) {
    this.requireBilling(tenant);
    const sub = await this.limits.ensureSubscription(tenant.workspaceId);
    const spec = PLAN_CATALOG[body.plan as PlanCode];
    const choice = await choosePrice(this.system, tenant.workspaceId, body.plan, (o) => priceFor(spec, body.cycle as Cycle, o));
    const price = priceFor(spec, body.cycle as Cycle, choice.override);
    if (price === null) throw new AppError(422, 'plan_not_purchasable', 'แพ็กเกจนี้ยังไม่เปิดขายออนไลน์ · ติดต่อฝ่ายขาย', { plan: body.plan });
    const change = await this.changeKind(tenant.workspaceId, sub, body.plan as PlanCode, body.cycle as Cycle, price);
    if (change.kind !== 'next_cycle') throw new AppError(409, change.kind === 'upgrade' ? 'upgrade_now' : 'not_in_paid_period', change.kind === 'upgrade' ? 'อัปเกรดมีผลทันทีหลังชำระส่วนต่าง' : 'ยังไม่มีรอบที่จ่ายแล้ว · เลือกแพ็กเกจแล้วชำระได้เลย');
    const [plan] = await this.system.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.code, body.plan));
    await this.system.update(s.subscriptions).set({ pendingPlanId: plan.id, pendingCycle: body.cycle, updatedAt: new Date() }).where(eq(s.subscriptions.workspaceId, tenant.workspaceId));
    await this.audit(auth, tenant, 'billing.change_scheduled', `ตั้งเปลี่ยนเป็น ${body.plan} ${body.cycle === 'yearly' ? 'รายปี' : 'รายเดือน'} มีผล ${change.effectiveAt.toISOString().slice(0, 10)}`);
    return { pendingChange: { plan: body.plan, cycle: body.cycle, effectiveAt: change.effectiveAt, blockers: await this.downgradeBlockers(tenant.workspaceId, body.plan as PlanCode) } };
  }

  /** `DELETE w/billing/scheduled-change` (R7) · ยกเลิกการเปลี่ยนที่ตั้งไว้ */
  async cancelScheduledChange(auth: AuthInfo, tenant: TenantInfo) {
    this.requireBilling(tenant);
    const [row] = await this.system
      .update(s.subscriptions)
      .set({ pendingPlanId: null, pendingCycle: null, updatedAt: new Date() })
      .where(eq(s.subscriptions.workspaceId, tenant.workspaceId))
      .returning({ id: s.subscriptions.id });
    if (row) await this.audit(auth, tenant, 'billing.change_cancelled', 'ยกเลิกการเปลี่ยนแพ็กเกจที่ตั้งไว้');
    return { pendingChange: null };
  }

  private async audit(auth: AuthInfo, tenant: TenantInfo, action: string, summary: string) {
    await this.db.run(auth, tenant, (tx) =>
      tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action, targetType: 'subscription', targetId: null, summary }),
    );
  }

  /** ลดแพ็กเกจแล้วต้องลดอะไรก่อน (R6) · อ่าน entitlement_versions ของทีม Friday จึงใช้ SYSTEM_DB */
  async downgradeBlockers(workspaceId: string, plan: PlanCode) {
    return downgradeBlockers(this.system, workspaceId, plan);
  }

  /** เครดิตคงเหลือของ Workspace (ลูกค้าอ่านได้ตาม RLS) */
  async credit(auth: AuthInfo, tenant: TenantInfo) {
    return this.db.run(auth, tenant, (tx) => creditBalance(tx, tenant.workspaceId));
  }

  async getProfile(auth: AuthInfo, tenant: TenantInfo) {
    this.requireBilling(tenant);
    return { profile: await this.db.run(auth, tenant, (tx) => this.readProfile(tx)) };
  }

  async putProfile(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof ProfileBody>) {
    this.requireBilling(tenant);
    const values = {
      workspaceId: tenant.workspaceId,
      companyName: body.companyName,
      taxId: body.taxId,
      branchType: body.branchType,
      branchNo: body.branchType === 'branch' ? (body.branchNo ?? null) : null,
      address: body.address,
      taxEmail: body.taxEmail,
      whtEnabled: body.whtEnabled,
    };
    return this.db.run(auth, tenant, async (tx) => {
      const [saved] = await tx
        .insert(s.billingProfiles)
        .values(values)
        .onConflictDoUpdate({ target: s.billingProfiles.workspaceId, set: values })
        .returning();
      await tx.insert(s.auditLogs).values({
        workspaceId: tenant.workspaceId,
        actorId: auth.userId,
        actorKind: 'user',
        category: 'plan',
        action: 'billing.profile_updated',
        targetType: 'billing_profile',
        targetId: saved.id,
        summary: saved.companyName,
      });
      return { profile: this.dto(saved) };
    });
  }

  private async readProfile(tx: Tx) {
    const [row] = await tx.select().from(s.billingProfiles);
    return row ? this.dto(row) : null;
  }

  private dto(p: typeof s.billingProfiles.$inferSelect) {
    return {
      companyName: p.companyName,
      taxId: p.taxId,
      branchType: p.branchType,
      branchNo: p.branchNo,
      address: p.address,
      taxEmail: p.taxEmail,
      whtEnabled: p.whtEnabled,
    };
  }
}
