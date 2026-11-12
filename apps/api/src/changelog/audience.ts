import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray } from 'drizzle-orm';
import { effectivePlan, type PlanCode } from '../billing/catalog.js';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';

const { featureFlags, featureFlagOverrides } = schema;

/** คอลัมน์ของรายการที่ใช้ตัดสินกลุ่มผู้เห็น (changelog_entries.audience*) */
export interface AudienceOf {
  audience: string;
  audiencePlans: string[];
  audienceFlag: string | null;
}

/**
 * Workspace ปัจจุบันจาก `?workspace=slug` สำหรับ route ระดับผู้ใช้ของ module นี้
 * Guest และ Workspace ที่ถูกระงับไม่ได้รับมีอะไรใหม่ / Spotlight / NPS (A42) จึงคืน null แทนการตอบ error
 * ให้แอปซ่อนปุ่มเงียบ ๆ ได้ · ไม่ใช่สมาชิกยังตอบ 404 ตามปกติ
 */
export async function eligibleTenant(db: TenantDb, auth: AuthInfo, slug: string): Promise<TenantInfo | null> {
  let tenant: TenantInfo;
  try {
    tenant = await db.tenant(auth, slug);
  } catch (e) {
    if (e instanceof AppError && e.code === 'workspace_suspended') return null;
    throw e;
  }
  if (tenant.role === 'guest' || tenant.suspension) return null;
  return tenant;
}

/**
 * ตัดสินว่า Workspace / บทบาทนี้เห็นรายการไหน (all · plans · flag · admins)
 * แพ็กเกจและ flag อ่านเฉพาะเมื่อมีรายการที่ต้องใช้ เพื่อไม่ให้ทุกคำขอต้องอ่านเพิ่ม
 */
@Injectable()
export class Audience {
  constructor(
    private readonly plans: PlanLimits,
    // feature_flags / overrides เป็นตารางของทีม Friday (ops_only) ลูกค้าอ่านตรงไม่ได้ · อ่านเฉพาะสถานะ flag ของ Workspace นี้ด้วย SYSTEM_DB
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  /** แพ็กเกจที่ใช้สิทธิ์จริงตอนนี้ (ทดลองหมด = free) · ใช้ทั้งกรองผู้เห็นและบันทึกกับคำตอบ NPS */
  async planOf(workspaceId: string): Promise<PlanCode> {
    return effectivePlan(await this.subscription(workspaceId));
  }

  /** subscription ของ Workspace (สร้างช่วงทดลองให้ถ้ายังไม่มี ตาม PlanLimits) */
  subscription(workspaceId: string) {
    return this.plans.ensureSubscription(workspaceId);
  }

  async filter<T extends AudienceOf>(tenant: TenantInfo, items: T[]): Promise<T[]> {
    const needPlan = items.some((i) => i.audience === 'plans');
    const flagKeys = [...new Set(items.filter((i) => i.audience === 'flag' && i.audienceFlag).map((i) => i.audienceFlag!))];
    const plan = needPlan ? await this.planOf(tenant.workspaceId) : null;
    const flags = flagKeys.length ? await this.flagsOn(tenant.workspaceId, flagKeys) : new Set<string>();
    const admin = tenant.role === 'owner' || tenant.role === 'admin';
    return items.filter((i) => {
      switch (i.audience) {
        case 'all':
          return true;
        case 'plans':
          return !!plan && i.audiencePlans.includes(plan);
        case 'flag':
          // flag ที่ถูกลบไปแล้ว = ไม่มีใครเห็น (รายการเก่ายังอยู่ใน Ops)
          return !!i.audienceFlag && flags.has(i.audienceFlag);
        case 'admins':
          return admin;
        default:
          return false;
      }
    });
  }

  /** flag ที่เปิดให้ Workspace นี้: override ของ Workspace ชนะค่าตั้งต้นของ flag */
  private async flagsOn(workspaceId: string, keys: string[]) {
    const rows = await this.system
      .select({ key: featureFlags.key, defaultOn: featureFlags.defaultOn, enabled: featureFlagOverrides.enabled })
      .from(featureFlags)
      .leftJoin(featureFlagOverrides, and(eq(featureFlagOverrides.flagId, featureFlags.id), eq(featureFlagOverrides.workspaceId, workspaceId)))
      .where(inArray(featureFlags.key, keys));
    return new Set(rows.filter((r) => r.enabled ?? r.defaultOn).map((r) => r.key));
  }
}
