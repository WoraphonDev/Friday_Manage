import { Inject, Injectable } from '@nestjs/common';
import { config } from '../config.js';
import { type Db, schema, type Tx } from '@friday/db';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { PlanLimits } from '../core/plan-limits.js';
import { GB, PLAN_CATALOG, computeQuote, priceFor, type Cycle, type PlanCode } from './catalog.js';

const s = schema;

export const QuoteQuery = z.object({
  plan: z.enum(['team_s', 'team_m', 'team_l']),
  cycle: z.enum(['monthly', 'yearly']).default('monthly'),
  wht: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

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
    return {
      plan: snap.plan,
      subscription: {
        status: sub.status,
        cycle: sub.cycle,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodEnd: sub.currentPeriodEnd,
        planCode: sub.planCode,
      },
      limits: snap.limits,
      invoices,
      profile,
    };
  }

  /** R2 · สรุปยอด: VAT 7% คิดจากยอดก่อนภาษี · หัก ณ ที่จ่าย 3% คิดจากยอดก่อน VAT · ราคารายปี = 10 เดือน */
  async quote(tenant: TenantInfo, q: z.infer<typeof QuoteQuery>) {
    this.requireBilling(tenant);
    const spec = PLAN_CATALOG[q.plan as PlanCode];
    const sub = await this.limits.ensureSubscription(tenant.workspaceId);
    // ราคาที่ทีม Friday ตั้งใน plans ชนะค่าตั้งต้น
    const override = await this.priceOverride(q.plan);
    const subtotal = priceFor(spec, q.cycle as Cycle, override);
    if (subtotal === null) throw new AppError(422, 'plan_not_purchasable', 'แพ็กเกจนี้ยังไม่เปิดขายออนไลน์ · ติดต่อฝ่ายขาย', { plan: q.plan });
    // ยังไม่จด VAT: ไม่คิด VAT และเอกสารเป็นใบเสร็จ (หน้าชำระเงินซ่อนบรรทัด VAT ตาม documentType)
    return { ...computeQuote(spec, q.cycle as Cycle, q.wht, subtotal, config.vatRegistered), currentPlan: sub.planCode, vatRegistered: config.vatRegistered, documentType: config.vatRegistered ? 'tax_invoice_receipt' : 'receipt' };
  }

  /** แคตตาล็อกแพ็กเกจเป็นข้อมูลระดับระบบ ไม่มี Workspace → อ่านด้วย SYSTEM_DB */
  private async priceOverride(code: string) {
    const [row] = await this.system
      .select({ monthly: s.plans.priceMonthlySatang, yearly: s.plans.priceYearlySatang })
      .from(s.plans)
      .where(eq(s.plans.code, code));
    return row;
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
