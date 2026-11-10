import { Inject, Injectable } from '@nestjs/common';
import { type Db, type EntitlementValue, resolveEntitlements, schema, type Tx } from '@friday/db';
import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import { smallestPlanForSeats, GB, PLAN_CATALOG, PLAN_ORDER, TRIAL_DAYS, TRIAL_PLAN, effectivePlan, type PlanCode, type PlanSpec } from '../billing/catalog.js';
import { AppError } from '../common/errors.js';
import { SYSTEM_DB } from '../db/db.module.js';

const { plans, subscriptions, workspaces, projects, workspaceMembers, fileVersions, automationRuns } = schema;

/** ฟีเจอร์ที่ API บังคับตามแพ็กเกจ (O21) · ชื่อไทยใช้ในข้อความ 402 */
export type FeatureKey = 'import_update' | 'channels' | 'automation' | 'api' | 'guests';
const FEATURE_NAMES: Record<FeatureKey, string> = {
  import_update: 'Import Excel โหมดอัปเดต',
  channels: 'LINE OA และ Webhook',
  automation: 'Automation',
  api: 'API token',
  guests: 'Guest',
};
/** คำขอผ่าน API token อ่านสิทธิ์จากที่เก็บไว้ไม่เกิน 10 วินาที (ทุกคำขออ่านฐานข้อมูลไม่ไหว) · แก้แล้วมีผลภายในไม่กี่วินาที */
const CACHE_MS = 10_000;
const MINUTE = 60_000;

/** ทรัพยากรที่แพ็กเกจจำกัด (หน้า Q2) */
export type LimitKind = 'projects' | 'seats' | 'storage_bytes';

export interface PlanSnapshot {
  plan: { code: PlanCode; name: string };
  subscription: {
    planCode: PlanCode;
    status: 'trialing' | 'active' | 'past_due' | 'canceled';
    cycle: 'monthly' | 'yearly';
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    prices: { monthly: number | null; yearly: number | null };
  };
  /** null = ไม่จำกัด */
  limits: Record<LimitKind, number | null>;
  usage: Record<LimitKind, number>;
  /** สิทธิ์ทุกคีย์หลังรวมเวอร์ชัน ช่วงผ่อนผัน และ override (O21) */
  entitlements: { version: number; values: Record<string, EntitlementValue>; grace: string[] };
}

const MESSAGES: Record<LimitKind, (plan: string, limit: number) => string> = {
  projects: (plan, limit) => `${plan} สร้างได้ ${limit} โปรเจกต์ · Archive โปรเจกต์ที่จบแล้ว หรืออัปเกรดแพ็กเกจ`,
  seats: (plan, limit) => `${plan} รองรับสมาชิก ${limit} คน (ไม่นับ Guest) · ปิดบัญชีคนที่ไม่ได้ใช้งาน หรืออัปเกรดแพ็กเกจ`,
  storage_bytes: (plan) => `พื้นที่ไฟล์ของ ${plan} เต็ม · ลบไฟล์ที่ไม่ใช้ หรืออัปเกรดแพ็กเกจ`,
};
const EXITS: Record<LimitKind, string[]> = {
  projects: ['archive_project', 'upgrade'],
  seats: ['deactivate_members', 'upgrade'],
  storage_bytes: ['manage_files', 'upgrade'],
};

/**
 * ตรวจขีดจำกัดของแพ็กเกจก่อนสร้างทรัพยากร · เกินตอบ 402 `plan_limit_reached` ตาม 03-api › Error (หน้า Q2)
 * จุดที่เรียก: สร้างโปรเจกต์, เพิ่มสมาชิกที่ไม่ใช่ Guest, นำเข้า Excel เป็นโปรเจกต์ใหม่ · ไฟล์ (A11) เรียกตอนอัปโหลด
 */
@Injectable()
export class PlanLimits {
  constructor(@Inject(SYSTEM_DB) private readonly system: Db) {}

  async assert(tx: Tx, workspaceId: string, kind: LimitKind, increment = 1): Promise<void> {
    const snap = await this.snapshot(tx, workspaceId);
    const limit = snap.limits[kind];
    const current = snap.usage[kind];
    if (limit === null || current + increment <= limit) return;
    const planName = snap.plan.name;
    const shown = kind === 'storage_bytes' ? Math.round(limit / GB) : limit;
    throw new AppError(402, 'plan_limit_reached', MESSAGES[kind](planName, shown), {
      kind,
      limit,
      current,
      increment,
      plan: snap.plan.code,
      suggestedPlan: this.suggest(snap.plan.code, kind, current + increment),
      exits: EXITS[kind],
    });
  }

  /** แพ็กเกจและการใช้งานปัจจุบัน · ใช้ทั้งตรวจ 402 และ `GET w/usage` */
  async snapshot(tx: Tx, workspaceId: string): Promise<PlanSnapshot> {
    const sub = await this.ensureSubscription(workspaceId);
    const code = effectivePlan(sub);
    const spec: PlanSpec = { ...PLAN_CATALOG[code] };
    const ent = await this.resolve(workspaceId, sub, code);
    if (ent.version > 0) {
      // มีเวอร์ชันสิทธิ์ (O21) → ใช้ค่าจากเวอร์ชันและ override แทนค่าในโค้ดและคอลัมน์ของ plans
      spec.seats = ent.values.seats as number | null;
      spec.projects = ent.values.projects as number | null;
      spec.storageGbPerMember = ent.values.storage_gb_per_member as number | null;
    } else {
      // ฐานข้อมูลที่ไม่มีเวอร์ชัน (ล้างตอนทดสอบ): ค่าใน plans ที่ทีม Friday ตั้งไว้ชนะค่าตั้งต้นในโค้ด
      if (code === sub.planCode) {
        if (sub.seatLimit != null) spec.seats = sub.seatLimit;
        if (sub.storageGbPerMember != null) spec.storageGbPerMember = sub.storageGbPerMember;
      }
      // override ยังมีผลเสมอ
      if (ent.overrides.some((o) => o.key === 'seats')) spec.seats = ent.values.seats as number | null;
    }
    const [seatRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active'), ne(workspaceMembers.role, 'guest')));
    const [projectRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt), isNull(projects.archivedAt)));
    // ไฟล์ในถังขยะยังนับจนกว่าจะลบถาวร (หน้า Q2: "ลบไฟล์ในถังขยะคืนพื้นที่")
    const [storageRow] = await tx
      .select({ n: sql<number>`coalesce(sum(${fileVersions.sizeBytes}), 0)::bigint` })
      .from(fileVersions)
      .where(eq(fileVersions.workspaceId, workspaceId));
    const seats = seatRow?.n ?? 0;
    // พื้นที่รวมของทีม = GB ต่อคน × จำนวนสมาชิก (อย่างน้อย 1 คน) · override storage_gb กำหนดพื้นที่รวมตรง ๆ
    const storage =
      ent.storageGbTotal !== undefined ? (ent.storageGbTotal === null ? null : ent.storageGbTotal * GB) : spec.storageGbPerMember === null ? null : spec.storageGbPerMember * GB * Math.max(seats, 1);
    return {
      plan: { code, name: spec.name },
      subscription: { ...sub, prices: { monthly: sub.priceMonthly, yearly: sub.priceYearly } },
      limits: { seats: spec.seats, projects: spec.projects, storage_bytes: storage },
      usage: { seats, projects: projectRow?.n ?? 0, storage_bytes: Number(storageRow?.n ?? 0) },
      entitlements: { version: ent.version, values: ent.values, grace: ent.grace },
    };
  }

  /** ฟีเจอร์นี้อยู่ในแพ็กเกจ (รวม override) ไหม · ไม่มี → 402 `plan_feature_unavailable` */
  async assertFeature(workspaceId: string, feature: FeatureKey, cached = false): Promise<void> {
    const { code, values } = await this.current(workspaceId, cached);
    if (values[feature] !== false) return;
    const name = PLAN_CATALOG[code].name;
    throw new AppError(402, 'plan_feature_unavailable', `${name} ยังไม่มี ${FEATURE_NAMES[feature]} · อัปเกรดแพ็กเกจเพื่อใช้ฟีเจอร์นี้`, {
      kind: 'feature',
      feature,
      plan: code,
      suggestedPlan: this.nextTier(code),
      exits: ['upgrade'],
    });
  }

  /**
   * Automation ต่อเดือน (เดือนตามเวลาไทย) · คืน false เมื่อรันครบโควตาแล้ว (ตัว engine บันทึกเป็นข้ามแทนการโยน error เพราะไม่มีผู้ใช้รอคำตอบ)
   * ใช้ SYSTEM_DB เพราะ engine เรียกนอกคำขอของผู้ใช้
   */
  async automationAllowed(workspaceId: string): Promise<{ ok: boolean; limit: number | null; used: number }> {
    const { values } = await this.current(workspaceId);
    if (values.automation === false) return { ok: false, limit: 0, used: 0 };
    const limit = values.automation_runs as number | null;
    if (limit === null) return { ok: true, limit, used: 0 };
    const [row] = await this.system
      .select({ n: sql<number>`count(*)::int` })
      .from(automationRuns)
      .where(and(eq(automationRuns.workspaceId, workspaceId), gte(automationRuns.createdAt, sql`date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'`), ne(automationRuns.result, 'skipped')));
    const used = row?.n ?? 0;
    return { ok: used < limit, limit, used };
  }

  private readonly windows = new Map<string, number[]>();

  /**
   * จำกัดคำขอผ่าน API token ต่อ Workspace ต่อนาที (Rate limit ต่อลูกค้า รวมเข้าเป็น "API ต่อนาที" ของ O21)
   * นับในหน่วยความจำของ process (API ตอนนี้รัน 1 ตัว) · หลายเครื่องต้องย้ายไป Valkey
   */
  async rateLimit(workspaceId: string, now = Date.now()): Promise<{ limit: number | null; remaining: number | null }> {
    await this.assertFeature(workspaceId, 'api', true);
    const { values } = await this.current(workspaceId, true);
    const limit = values.api_rpm as number | null;
    if (limit === null) return { limit, remaining: null };
    const hits = (this.windows.get(workspaceId) ?? []).filter((t) => t > now - MINUTE);
    if (hits.length >= limit) {
      this.windows.set(workspaceId, hits);
      const retryAfter = Math.max(1, Math.ceil((hits[0] + MINUTE - now) / 1000));
      throw new AppError(429, 'rate_limited', `เรียก API เกิน ${limit} ครั้งต่อนาทีของแพ็กเกจ · ลองใหม่ใน ${retryAfter} วินาที`, { limit, retryAfter });
    }
    hits.push(now);
    this.windows.set(workspaceId, hits);
    return { limit, remaining: limit - hits.length };
  }

  private readonly cache = new Map<string, { at: number; code: PlanCode; values: Record<string, EntitlementValue> }>();

  /** `cached` ใช้กับทางที่ถูกเรียกทุกคำขอ (API token) เท่านั้น · ทางเขียนอ่านสดเสมอ ไม่ให้อัปเกรดแล้วยังติด 402 */
  private async current(workspaceId: string, cached = false) {
    const hit = this.cache.get(workspaceId);
    if (cached && hit && Date.now() - hit.at < CACHE_MS) return hit;
    const sub = await this.ensureSubscription(workspaceId);
    const code = effectivePlan(sub);
    const ent = await this.resolve(workspaceId, sub, code);
    const entry = { at: Date.now(), code, values: ent.values };
    this.cache.set(workspaceId, entry);
    return entry;
  }

  /** รอบบิลที่จ่ายแล้วเท่านั้นมีช่วงผ่อนผันตอนลดสิทธิ์ (ทดลอง / Free ใช้เวอร์ชันใหม่ทันที) */
  private resolve(workspaceId: string, sub: Awaited<ReturnType<PlanLimits['ensureSubscription']>>, code: PlanCode) {
    const paid = code === sub.planCode && sub.status !== 'trialing';
    return resolveEntitlements(this.system, workspaceId, code, paid ? sub.currentPeriodStart : null);
  }

  /**
   * Workspace ใหม่ทดลอง Team 14 วันนับจากวันที่สร้าง · สร้าง subscription ตอนเรียกครั้งแรก
   * ใช้ SYSTEM_DB เพราะ `plans` เขียนได้เฉพาะ friday_system และการสร้าง Workspace อยู่นอก lane ของงานนี้ (A14)
   */
  async ensureSubscription(workspaceId: string) {
    const read = async () => {
      const [row] = await this.system
        .select({
          planCode: plans.code,
          status: subscriptions.status,
          cycle: subscriptions.cycle,
          trialEndsAt: subscriptions.trialEndsAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          currentPeriodStart: subscriptions.currentPeriodStart,
          seatLimit: plans.seatLimit,
          storageGbPerMember: plans.storageGbPerMember,
          priceMonthly: plans.priceMonthlySatang,
          priceYearly: plans.priceYearlySatang,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(eq(subscriptions.workspaceId, workspaceId));
      return row ? { ...row, planCode: row.planCode as PlanCode } : undefined;
    };
    const existing = await read();
    if (existing) return existing;

    const [ws] = await this.system.select({ createdAt: workspaces.createdAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!ws) throw new AppError(404, 'workspace_not_found', 'ไม่พบ Workspace');
    // ฐานข้อมูลใหม่มีแถวแพ็กเกจจาก migration · เติมเฉพาะที่ขาด (เช่นฐานที่ถูกล้างตอนทดสอบ)
    await this.system
      .insert(plans)
      .values(PLAN_ORDER.map((c) => ({ code: c, seatLimit: PLAN_CATALOG[c].seats, features: { tier: c === 'free' ? 'free' : c === 'enterprise' ? 'enterprise' : 'team' } })))
      .onConflictDoNothing();
    const [trialPlan] = await this.system.select({ id: plans.id }).from(plans).where(eq(plans.code, TRIAL_PLAN));
    const trialEndsAt = new Date(ws.createdAt.getTime() + TRIAL_DAYS * 86_400_000);
    await this.system
      .insert(subscriptions)
      .values({ workspaceId, planId: trialPlan.id, cycle: 'monthly', status: 'trialing', trialEndsAt, currentPeriodStart: ws.createdAt, currentPeriodEnd: trialEndsAt })
      .onConflictDoNothing();
    return (await read())!;
  }

  private suggest(current: PlanCode, kind: LimitKind, needed: number): PlanCode | null {
    if (kind === 'seats') {
      const c = smallestPlanForSeats(needed);
      return c === current ? this.nextTier(current) : c;
    }
    return this.nextTier(current);
  }

  private nextTier(code: PlanCode): PlanCode | null {
    const i = PLAN_ORDER.indexOf(code);
    return PLAN_ORDER[i + 1] ?? null;
  }
}
