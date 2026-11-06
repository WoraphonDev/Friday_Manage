import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { smallestPlanForSeats, GB, PLAN_CATALOG, PLAN_ORDER, TRIAL_DAYS, TRIAL_PLAN, effectivePlan, type PlanCode, type PlanSpec } from '../billing/catalog.js';
import { AppError } from '../common/errors.js';
import { SYSTEM_DB } from '../db/db.module.js';

const { plans, subscriptions, workspaces, projects, workspaceMembers, fileVersions } = schema;

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
    // ค่าใน plans ที่ทีม Friday ตั้งไว้ชนะค่าตั้งต้นในโค้ด (เฉพาะแพ็กเกจที่ใช้สิทธิ์อยู่ ถ้ายังเป็นแพ็กเกจเดิมของ subscription)
    if (code === sub.planCode) {
      if (sub.seatLimit != null) spec.seats = sub.seatLimit;
      if (sub.storageGbPerMember != null) spec.storageGbPerMember = sub.storageGbPerMember;
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
    return {
      plan: { code, name: spec.name },
      subscription: { ...sub, prices: { monthly: sub.priceMonthly, yearly: sub.priceYearly } },
      limits: {
        seats: spec.seats,
        projects: spec.projects,
        // พื้นที่รวมของทีม = GB ต่อคน × จำนวนสมาชิก (อย่างน้อย 1 คน)
        storage_bytes: spec.storageGbPerMember === null ? null : spec.storageGbPerMember * GB * Math.max(seats, 1),
      },
      usage: { seats, projects: projectRow?.n ?? 0, storage_bytes: Number(storageRow?.n ?? 0) },
    };
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
