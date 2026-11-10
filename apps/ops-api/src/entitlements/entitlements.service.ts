import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  changes,
  type Db,
  ENTITLEMENT_KEYS,
  ENTITLEMENT_PLANS,
  type EntitlementPlan,
  type EntitlementValue,
  keyOf,
  type Matrix,
  normalizeMatrix,
  OVERRIDE_KEYS,
  type OverrideKey,
  reductions,
  resolveEntitlements,
  schema,
  versionAt,
} from '@friday/db';
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { type Approval, audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
const DAY = 86_400_000;
const GB = 1024 ** 3;
/** ใกล้ชนเพดาน = ใช้เกิน 85% (Canvas › ใกล้ชนเพดาน) */
const NEAR = 0.85;
/** เกินแพ็กเกจเกิน 20% ต้องให้ Owner อนุมัติ (06 › 3) */
const OVERRIDE_HEADROOM = 1.2;
const WARN_DAYS = 7;

const PLAN_NAMES: Record<EntitlementPlan, string> = { free: 'Free', team_s: 'Team S', team_m: 'Team M', team_l: 'Team L', enterprise: 'Enterprise' };
/** ชื่อไทยของคีย์ (ใช้ในเหตุผล Audit log ที่ลูกค้าเห็น และอีเมล) */
const KEY_NAMES: Record<string, string> = {
  seats: 'ที่นั่ง', projects: 'โปรเจกต์', storage_gb_per_member: 'พื้นที่ไฟล์ต่อคน', storage_gb: 'พื้นที่ไฟล์', automation_runs: 'Automation ต่อเดือน', api_rpm: 'API ต่อนาที',
  history_days: 'เก็บประวัติ Activity', gantt: 'Gantt และ Baseline', import_update: 'Import Excel โหมดอัปเดต', channels: 'LINE OA และ Webhook', automation: 'Automation',
  api: 'API token', guests: 'Guest', sso: 'SSO / SAML', sla: 'SLA และผู้ดูแลประจำบัญชี',
};

const limitValue = z.number().int().min(0).max(1_000_000_000).nullable();
const PlanValues = z.record(z.string(), z.union([z.boolean(), limitValue]));
export const MatrixBody = z
  .object(Object.fromEntries(ENTITLEMENT_PLANS.map((p) => [p, PlanValues])) as Record<EntitlementPlan, typeof PlanValues>)
  .strict()
  .superRefine((m, ctx) => {
    for (const plan of ENTITLEMENT_PLANS) {
      for (const k of ENTITLEMENT_KEYS) {
        const v = m[plan][k.key];
        const path = [plan, k.key];
        if (v === undefined) ctx.addIssue({ code: 'custom', path, message: 'ต้องมีค่าทุกช่อง' });
        else if (k.kind === 'feature' && typeof v !== 'boolean') ctx.addIssue({ code: 'custom', path, message: 'ฟีเจอร์ต้องเป็น true / false' });
        else if (k.kind === 'limit' && typeof v === 'boolean') ctx.addIssue({ code: 'custom', path, message: 'ขีดจำกัดต้องเป็นตัวเลขหรือ null (ไม่จำกัด)' });
        // ที่นั่งและพื้นที่เป็น 0 ไม่ได้ (constraint ของ plans และลูกค้าจะใช้งานไม่ได้เลย)
        else if ((k.key === 'seats' || k.key === 'storage_gb_per_member') && v === 0) ctx.addIssue({ code: 'custom', path, message: 'ต้องมากกว่า 0 หรือไม่จำกัด' });
      }
      for (const key of Object.keys(m[plan])) if (!keyOf(key)) ctx.addIssue({ code: 'custom', path: [plan, key], message: 'ไม่รู้จักคีย์นี้' });
    }
  });
export const PreviewBody = z.object({ matrix: MatrixBody }).strict();
export const VersionBody = z
  .object({
    matrix: MatrixBody,
    /** ไม่ส่ง = มีผลทันทีเมื่ออนุมัติ */
    effectiveAt: z.iso.datetime({ offset: true }).nullish(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export const RestoreBody = z.object({ effectiveAt: z.iso.datetime({ offset: true }).nullish(), reason: z.string().trim().min(3).max(500) }).strict();
export const OverrideBody = z
  .object({
    workspaceId: z.uuid(),
    key: z.enum(OVERRIDE_KEYS),
    value: z.union([z.boolean(), limitValue]),
    expiresAt: z.iso.datetime({ offset: true }).nullish(),
    /** สัญญา Enterprise · มีค่าแล้วไม่ต้องมีวันหมดอายุ */
    contractRef: z.string().trim().min(3).max(60).nullish(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.key === 'sso' ? typeof v.value !== 'boolean' : typeof v.value === 'boolean') ctx.addIssue({ code: 'custom', path: ['value'], message: v.key === 'sso' ? 'ต้องเป็น true / false' : 'ต้องเป็นตัวเลขหรือ null (ไม่จำกัด)' });
    if (!v.expiresAt && !v.contractRef) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'ต้องมีวันหมดอายุ ยกเว้นตามสัญญา Enterprise (ระบุเลขที่สัญญา)' });
    if (v.expiresAt && new Date(v.expiresAt).getTime() <= Date.now()) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'วันหมดอายุต้องอยู่ในอนาคต' });
    if ((v.key === 'seats' || v.key === 'storage_gb') && v.value === 0) ctx.addIssue({ code: 'custom', path: ['value'], message: 'ต้องมากกว่า 0' });
  });
export const RevokeBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const ReferBody = z.object({ key: z.enum(['seats', 'projects', 'storage']), note: z.string().trim().max(500).optional() }).strict();

export type Gated<T> = T | { pendingApproval: NonNullable<Awaited<ReturnType<ApprovalsService['gate']>>> };
const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);

/** แสดงค่าในข้อความ (Audit log / อีเมล) */
function show(key: string, v: EntitlementValue) {
  if (typeof v === 'boolean') return v ? 'ได้' : 'ไม่ได้';
  if (v === null) return 'ไม่จำกัด';
  if (key === 'storage_gb' || key === 'storage_gb_per_member') return `${v} GB${key === 'storage_gb_per_member' ? ' ต่อคน' : ''}`;
  return v.toLocaleString('th-TH');
}

interface Usage {
  id: string;
  slug: string;
  name: string;
  plan: EntitlementPlan;
  subStatus: string | null;
  cycleStart: Date | null;
  seats: number;
  projects: number;
  storage: number;
  automationRuns: number;
  rules: number;
  tokens: number;
  channels: number;
  guests: number;
  updateImports: number;
  seats30: number;
  projects30: number;
  storage30: number;
}

/**
 * สิทธิ์และขีดจำกัดตามแพ็กเกจ (O21 · Canvas › Entitlements, P2, P3)
 * บันทึกเวอร์ชันใหม่ต้องมีคนอนุมัติเสมอ · ปรับเฉพาะรายเกิน 20% / ไม่มีวันหมดอายุ / เปิดฟีเจอร์นอกแพ็กเกจ ต้องให้ Owner อนุมัติ
 */
@Injectable()
export class EntitlementsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Entitlements');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    this.approvals.register('entitlements.version', (p, ctx) => this.applyVersion(ctx.requester, p as unknown as VersionPayload, ctx));
    this.approvals.register('entitlements.override', (p, ctx) => this.applyOverride(ctx.requester, p.input as z.infer<typeof OverrideBody>, ctx));
    // เตือนรายการที่ใกล้หมดอายุ และเทียบ plans กับเวอร์ชันที่ถึงวันมีผล ทุกชั่วโมง · test เรียกเอง · ปิดด้วย OPS_JOBS=off
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), 3_600_000);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    await this.syncPlans(now);
    return this.warnExpiring(now);
  }

  // ---------------------------------------------------------------------------
  // หน้า Entitlements
  // ---------------------------------------------------------------------------

  async overview(now = new Date()) {
    await this.syncPlans(now);
    const current = await versionAt(this.db, now);
    const versions = await this.versionRows();
    const cur = versions.find((v) => v.version === current.version);
    const scheduled = versions.filter((v) => v.effectiveAt > now).map((v) => ({ version: v.version, effectiveAt: v.effectiveAt, reason: v.reason }));
    const pending = await this.db
      .select({ id: s.approvalRequests.id, reason: s.approvalRequests.reason, createdAt: s.approvalRequests.createdAt, requestedBy: s.staffUsers.name, payload: s.approvalRequests.payload })
      .from(s.approvalRequests)
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.approvalRequests.requestedBy))
      .where(and(eq(s.approvalRequests.kind, 'entitlements.version'), eq(s.approvalRequests.status, 'pending'), gt(s.approvalRequests.expiresAt, now)))
      .orderBy(desc(s.approvalRequests.createdAt));
    const usage = await this.usage(now);
    const customers = Object.fromEntries(ENTITLEMENT_PLANS.map((p) => [p, usage.filter((u) => u.plan === p).length]));
    return {
      keys: ENTITLEMENT_KEYS,
      overrideKeys: OVERRIDE_KEYS,
      plans: ENTITLEMENT_PLANS.map((code) => ({ code, name: PLAN_NAMES[code], customers: customers[code] })),
      current: { version: current.version, effectiveAt: current.version ? current.effectiveAt : null, matrix: current.matrix, reason: cur?.reason ?? null, createdBy: cur?.createdBy ?? null, approvedBy: cur?.approvedBy ?? null },
      scheduled,
      pending: pending.map((p) => ({ id: p.id, reason: p.reason, createdAt: p.createdAt, requestedBy: p.requestedBy, effectiveAt: (p.payload as { effectiveAt?: string | null }).effectiveAt ?? null })),
      overrides: await this.overrides(now),
      nearLimit: await this.nearLimit(usage, now),
    };
  }

  /** P2 · เทียบกับเวอร์ชันปัจจุบัน และนับลูกค้าที่ถูกลดสิทธิ์ก่อนบันทึก */
  async preview(input: z.infer<typeof PreviewBody>, now = new Date()) {
    const current = await versionAt(this.db, now);
    const next = normalizeMatrix(input.matrix);
    const diff = changes(current.matrix, next);
    const usage = await this.usage(now);
    const overridden = await this.db
      .select({ ws: s.entitlementOverrides.workspaceId, key: s.entitlementOverrides.key })
      .from(s.entitlementOverrides)
      .where(and(isNull(s.entitlementOverrides.revokedAt), sql`(${s.entitlementOverrides.expiresAt} IS NULL OR ${s.entitlementOverrides.expiresAt} > ${now})`));
    const has = new Set(overridden.map((o) => `${o.ws}:${o.key}`));
    const affected = reductions(current.matrix, next).map((r) => {
      const hit = usage.filter((u) => u.plan === r.plan && !has.has(`${u.id}:${r.key === 'storage_gb_per_member' ? 'storage_gb' : r.key}`) && this.hurts(u, r.key, r.to));
      return { ...r, workspaces: hit.length, examples: hit.slice(0, 5).map((u) => ({ id: u.id, name: u.name })) };
    });
    return { fromVersion: current.version, nextVersion: (await this.maxVersion()) + 1, changes: diff, affected, affectedTotal: new Set(affected.flatMap((a) => usage.filter((u) => u.plan === a.plan && this.hurts(u, a.key, a.to)).map((u) => u.id))).size };
  }

  /** ลูกค้ารายนี้ใช้เกินค่าใหม่ หรือใช้ฟีเจอร์ที่ถูกปิดอยู่ไหม */
  private hurts(u: Usage, key: string, to: EntitlementValue) {
    if (to === null || to === true) return false;
    switch (key) {
      case 'seats':
        return u.seats > (to as number);
      case 'projects':
        return u.projects > (to as number);
      case 'storage_gb_per_member':
        return u.storage > (to as number) * GB * Math.max(u.seats, 1);
      case 'automation_runs':
        return u.automationRuns > (to as number);
      case 'api_rpm':
      case 'api':
        return u.tokens > 0;
      case 'automation':
        return u.rules > 0;
      case 'channels':
        return u.channels > 0;
      case 'guests':
        return u.guests > 0;
      case 'import_update':
        return u.updateImports > 0;
      default:
        // ยังไม่บังคับในแอป (ประวัติ, Gantt, SSO, SLA) · นับทุกรายในแพ็กเกจว่าอาจกระทบ
        return true;
    }
  }

  // ---------------------------------------------------------------------------
  // เวอร์ชัน (P2 / P3)
  // ---------------------------------------------------------------------------

  async createVersion(staff: Staff, input: z.infer<typeof VersionBody>, restoredFrom?: number): Promise<Gated<{ version: number }>> {
    const current = await versionAt(this.db, new Date());
    const matrix = normalizeMatrix(input.matrix);
    const diff = changes(current.matrix, matrix);
    if (!diff.length) throw new AppError(422, 'no_changes', 'ไม่มีอะไรต่างจากเวอร์ชันที่ใช้อยู่');
    if (input.effectiveAt && new Date(input.effectiveAt).getTime() < Date.now() - 60_000) throw new AppError(422, 'effective_in_past', 'วันที่มีผลต้องไม่อยู่ในอดีต');
    const payload: VersionPayload = { matrix, effectiveAt: input.effectiveAt ?? null, reason: input.reason, restoredFrom: restoredFrom ?? null };
    const summary = diff.map((c) => `${PLAN_NAMES[c.plan]} ${KEY_NAMES[c.key]} ${show(c.key, c.from)} → ${show(c.key, c.to)}`).join(' · ');
    const pending = await this.approvals.gate(staff, {
      kind: 'entitlements.version',
      payload: payload as unknown as Record<string, unknown>,
      reason: input.reason,
      exceeds: true,
      rule: `บันทึกสิทธิ์เป็นเวอร์ชันใหม่ต้องมีคนอนุมัติ · ${summary}`,
    });
    return { pendingApproval: pending! };
  }

  async restore(staff: Staff, version: number, input: z.infer<typeof RestoreBody>) {
    const [row] = await this.db.select().from(s.entitlementVersions).where(eq(s.entitlementVersions.version, version));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบเวอร์ชันนี้');
    return this.createVersion(staff, { matrix: normalizeMatrix(row.matrix), effectiveAt: input.effectiveAt, reason: input.reason }, version);
  }

  private async applyVersion(staff: Staff, p: VersionPayload, ctx: ApprovalContext) {
    const matrix = normalizeMatrix(p.matrix);
    const effectiveAt = p.effectiveAt ? new Date(p.effectiveAt) : new Date();
    const row = await this.db.transaction(async (tx) => {
      // ล็อกตารางสั้น ๆ กันเลขเวอร์ชันชนกันเมื่ออนุมัติพร้อมกัน
      await tx.execute(sql`LOCK TABLE ${s.entitlementVersions} IN SHARE ROW EXCLUSIVE MODE`);
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${s.entitlementVersions.version}), 0)::int` }).from(s.entitlementVersions);
      const [v] = await tx
        .insert(s.entitlementVersions)
        .values({ version: n + 1, matrix, effectiveAt, reason: p.reason, restoredFrom: p.restoredFrom, createdBy: staff.id, approvedBy: ctx.approver.id, approvalRequestId: ctx.requestId })
        .returning();
      await staffAudit(tx, staff, 'entitlements.version_created', `เวอร์ชัน ${v.version}${p.restoredFrom ? ` (กู้จากเวอร์ชัน ${p.restoredFrom})` : ''} · มีผล ${effectiveAt.toISOString()} · ${p.reason}`, { type: 'entitlement_version', id: v.id }, undefined, approvalOf(ctx));
      return v;
    });
    await this.syncPlans();
    return { version: row.version, effectiveAt: row.effectiveAt };
  }

  /** P3 · ทุกเวอร์ชัน พร้อมความต่างจากเวอร์ชันก่อนหน้า */
  async history(now = new Date()) {
    const rows = await this.versionRows();
    const current = await versionAt(this.db, now);
    const asc_ = [...rows].sort((a, b) => a.version - b.version);
    const out = asc_.map((r, i) => {
      const prev = i > 0 ? normalizeMatrix(asc_[i - 1].matrix) : null;
      return {
        version: r.version,
        effectiveAt: r.effectiveAt,
        reason: r.reason,
        restoredFrom: r.restoredFrom,
        createdBy: r.createdBy,
        approvedBy: r.approvedBy,
        createdAt: r.createdAt,
        status: r.version === current.version ? 'current' : r.effectiveAt > now ? 'scheduled' : 'past',
        changes: prev ? changes(prev, normalizeMatrix(r.matrix)) : [],
        matrix: normalizeMatrix(r.matrix),
      };
    });
    return { items: out.reverse() };
  }

  private async versionRows() {
    const creator = sql<string | null>`(select name from staff_users where id = ${s.entitlementVersions.createdBy})`;
    const approver = sql<string | null>`(select name from staff_users where id = ${s.entitlementVersions.approvedBy})`;
    return this.db
      .select({ id: s.entitlementVersions.id, version: s.entitlementVersions.version, matrix: s.entitlementVersions.matrix, effectiveAt: s.entitlementVersions.effectiveAt, reason: s.entitlementVersions.reason, restoredFrom: s.entitlementVersions.restoredFrom, createdAt: s.entitlementVersions.createdAt, createdBy: creator, approvedBy: approver })
      .from(s.entitlementVersions)
      .orderBy(desc(s.entitlementVersions.version));
  }

  private async maxVersion() {
    const [{ n }] = await this.db.select({ n: sql<number>`coalesce(max(${s.entitlementVersions.version}), 0)::int` }).from(s.entitlementVersions);
    return n;
  }

  /**
   * คอลัมน์ seat_limit / storage_gb_per_member ของ plans ให้ตรงกับเวอร์ชันที่มีผล
   * ส่วนอื่น (หน้าราคา, เปลี่ยนแพ็กเกจ, ลูกค้าเสี่ยง) ยังอ่านจาก plans · API ลูกค้าอ่านเวอร์ชันตรง
   */
  async syncPlans(now = new Date()) {
    const current = await versionAt(this.db, now);
    if (!current.version) return;
    for (const code of ENTITLEMENT_PLANS) {
      const v = current.matrix[code];
      await this.db
        .update(s.plans)
        .set({ seatLimit: v.seats as number | null, storageGbPerMember: v.storage_gb_per_member as number | null })
        .where(and(eq(s.plans.code, code), sql`(${s.plans.seatLimit} IS DISTINCT FROM ${v.seats as number | null} OR ${s.plans.storageGbPerMember} IS DISTINCT FROM ${v.storage_gb_per_member as number | null})`));
    }
  }

  // ---------------------------------------------------------------------------
  // ปรับเฉพาะราย
  // ---------------------------------------------------------------------------

  async overrides(now = new Date()) {
    const creator = sql<string>`(select name from staff_users where id = ${s.entitlementOverrides.createdBy})`;
    const approver = sql<string | null>`(select name from staff_users where id = ${s.entitlementOverrides.approvedBy})`;
    const rows = await this.db
      .select({ o: s.entitlementOverrides, name: s.workspaces.name, slug: s.workspaces.slug, createdBy: creator, approvedBy: approver })
      .from(s.entitlementOverrides)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.entitlementOverrides.workspaceId))
      .where(isNull(s.entitlementOverrides.revokedAt))
      .orderBy(asc(s.entitlementOverrides.expiresAt));
    const usage = new Map((await this.usage(now, rows.map((r) => r.o.workspaceId))).map((u) => [u.id, u]));
    const current = await versionAt(this.db, now);
    return rows.map((r) => {
      const u = usage.get(r.o.workspaceId);
      const expired = !!r.o.expiresAt && r.o.expiresAt <= now;
      const soon = !!r.o.expiresAt && !expired && r.o.expiresAt.getTime() - now.getTime() <= WARN_DAYS * DAY;
      return {
        id: r.o.id,
        workspace: { id: r.o.workspaceId, name: r.name, slug: r.slug, plan: u?.plan ?? null },
        key: r.o.key,
        base: u ? this.base(current.matrix, u, r.o.key as OverrideKey) : null,
        value: r.o.value as EntitlementValue,
        expiresAt: r.o.expiresAt,
        contractRef: r.o.contractRef,
        reason: r.o.reason,
        createdBy: r.createdBy,
        approvedBy: r.approvedBy,
        status: expired ? 'expired' : soon ? 'expiring' : r.o.contractRef && !r.o.expiresAt ? 'contract' : 'active',
      };
    });
  }

  /** ค่าที่แพ็กเกจให้ (ก่อน override) · storage_gb = GB ต่อคน × สมาชิก */
  private base(matrix: Matrix, u: Usage, key: OverrideKey): EntitlementValue {
    const plan = matrix[u.plan];
    if (key === 'storage_gb') return plan.storage_gb_per_member === null ? null : (plan.storage_gb_per_member as number) * Math.max(u.seats, 1);
    return plan[key];
  }

  async createOverride(staff: Staff, input: z.infer<typeof OverrideBody>): Promise<Gated<{ id: string }>> {
    const [u] = await this.usage(new Date(), [input.workspaceId]);
    if (!u) throw new AppError(404, 'not_found', 'ไม่พบ Workspace หรือยังไม่มีแพ็กเกจ');
    const base = this.base((await versionAt(this.db, new Date())).matrix, u, input.key);
    const v = input.value;
    const over =
      typeof v === 'boolean' ? v === true && base !== true : v === null ? base !== null : typeof base === 'number' && v > base * OVERRIDE_HEADROOM;
    const exceeds = over || !input.expiresAt;
    const pending = await this.approvals.gate(staff, {
      kind: 'entitlements.override',
      workspaceId: input.workspaceId,
      target: { type: 'workspace', id: input.workspaceId },
      payload: { workspaceId: input.workspaceId, input },
      reason: input.reason,
      exceeds,
      rule: !input.expiresAt
        ? `ปรับสิทธิ์เฉพาะรายโดยไม่มีวันหมดอายุ (สัญญา ${input.contractRef}) ต้องให้ Owner อนุมัติ`
        : `ปรับ${KEY_NAMES[input.key]}เป็น ${show(input.key, v)} เกินแพ็กเกจ (${show(input.key, base)}) เกิน 20% หรือเปิดฟีเจอร์นอกแพ็กเกจ ต้องให้ Owner อนุมัติ`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyOverride(staff, input);
  }

  private async applyOverride(staff: Staff, input: z.infer<typeof OverrideBody>, ctx?: ApprovalContext) {
    const row = await this.db.transaction(async (tx) => {
      // รายการเดิมของคีย์เดียวกัน (รวมที่หมดอายุแล้ว) ถูกแทนที่
      await tx
        .update(s.entitlementOverrides)
        .set({ revokedAt: new Date(), revokedBy: staff.id, revokeReason: 'แทนด้วยรายการใหม่' })
        .where(and(eq(s.entitlementOverrides.workspaceId, input.workspaceId), eq(s.entitlementOverrides.key, input.key), isNull(s.entitlementOverrides.revokedAt)));
      const [o] = await tx
        .insert(s.entitlementOverrides)
        .values({
          workspaceId: input.workspaceId,
          key: input.key,
          value: input.value,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          contractRef: input.contractRef ?? null,
          reason: input.reason,
          createdBy: staff.id,
          approvedBy: ctx?.approver.id ?? null,
        })
        .returning();
      const until = input.expiresAt ? `ถึง ${input.expiresAt.slice(0, 10)}` : `ตามสัญญา ${input.contractRef}`;
      await audit(tx, staff, input.workspaceId, 'plan', 'ops.entitlement_override', `ปรับ${KEY_NAMES[input.key]}เป็น ${show(input.key, input.value)} ${until} · ${input.reason}`, { type: 'entitlement_override', id: o.id }, approvalOf(ctx));
      return o;
    });
    return { id: row.id };
  }

  async revokeOverride(staff: Staff, id: string, input: z.infer<typeof RevokeBody>) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบการปรับเฉพาะราย');
    return this.db.transaction(async (tx) => {
      const [o] = await tx
        .update(s.entitlementOverrides)
        .set({ revokedAt: new Date(), revokedBy: staff.id, revokeReason: input.reason })
        .where(and(eq(s.entitlementOverrides.id, id), isNull(s.entitlementOverrides.revokedAt)))
        .returning();
      if (!o) throw new AppError(404, 'not_found', 'ไม่พบการปรับเฉพาะราย หรือยกเลิกไปแล้ว');
      await audit(tx, staff, o.workspaceId, 'plan', 'ops.entitlement_override_revoked', `ยกเลิกการปรับ${KEY_NAMES[o.key]} · ${input.reason}`, { type: 'entitlement_override', id });
      return { id, revoked: true };
    });
  }

  /** แจ้งเจ้าของรายการล่วงหน้า 7 วันก่อนหมดอายุ (ครั้งเดียวต่อรายการ) */
  async warnExpiring(now = new Date()) {
    const rows = await this.db
      .select({ o: s.entitlementOverrides, email: s.staffUsers.email, staffName: s.staffUsers.name, ws: s.workspaces.name })
      .from(s.entitlementOverrides)
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.entitlementOverrides.createdBy))
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.entitlementOverrides.workspaceId))
      .where(and(isNull(s.entitlementOverrides.revokedAt), isNull(s.entitlementOverrides.warnedAt), isNotNull(s.entitlementOverrides.expiresAt), gt(s.entitlementOverrides.expiresAt, now), lte(s.entitlementOverrides.expiresAt, new Date(now.getTime() + WARN_DAYS * DAY))));
    let sent = 0;
    for (const r of rows) {
      // จองก่อนส่ง กันสองเครื่องส่งซ้ำ
      const [claimed] = await this.db.update(s.entitlementOverrides).set({ warnedAt: now }).where(and(eq(s.entitlementOverrides.id, r.o.id), isNull(s.entitlementOverrides.warnedAt))).returning({ id: s.entitlementOverrides.id });
      if (!claimed) continue;
      try {
        await this.mail.send({
          to: r.email,
          subject: `[Friday Ops] การปรับสิทธิ์ของ ${r.ws} จะหมดอายุ ${r.o.expiresAt!.toISOString().slice(0, 10)}`,
          text: `${r.staffName}\n\nการปรับ${KEY_NAMES[r.o.key]}เป็น ${show(r.o.key, r.o.value as EntitlementValue)} ของ ${r.ws} จะหมดอายุภายใน ${WARN_DAYS} วัน\nเหตุผลเดิม: ${r.o.reason}\n\nต่ออายุหรือปล่อยให้หมดได้ที่หน้าสิทธิ์และขีดจำกัด`,
        });
        sent++;
      } catch {
        /* บันทึกใน mail log แล้ว */
      }
    }
    return { warned: rows.length, sent };
  }

  // ---------------------------------------------------------------------------
  // ใกล้ชนเพดาน
  // ---------------------------------------------------------------------------

  private async nearLimit(usage: Usage[], now: Date) {
    const referred = await this.db
      .select({ ws: s.staffAuditLogs.workspaceId, at: sql<Date>`max(${s.staffAuditLogs.createdAt})` })
      .from(s.staffAuditLogs)
      .where(and(eq(s.staffAuditLogs.action, 'entitlements.referred_to_sales'), gt(s.staffAuditLogs.createdAt, new Date(now.getTime() - 30 * DAY))))
      .groupBy(s.staffAuditLogs.workspaceId);
    const sentAt = new Map(referred.map((r) => [r.ws, r.at]));
    const out: { workspace: { id: string; name: string; slug: string }; plan: EntitlementPlan; key: 'seats' | 'projects' | 'storage'; used: number; limit: number; ratio: number; etaDays: number | null; referredAt: Date | null }[] = [];
    for (const u of usage) {
      // เฉพาะลูกค้าที่ยังใช้งานอยู่ (ไม่นับที่ยกเลิกแล้ว)
      if (u.subStatus === 'canceled') continue;
      const ent = await resolveEntitlements(this.db, u.id, u.plan, u.subStatus === 'trialing' ? null : u.cycleStart, now);
      const seats = ent.values.seats as number | null;
      const projects = ent.values.projects as number | null;
      const perMember = ent.values.storage_gb_per_member as number | null;
      const storage = ent.storageGbTotal !== undefined ? (ent.storageGbTotal === null ? null : ent.storageGbTotal * GB) : perMember === null ? null : perMember * GB * Math.max(u.seats, 1);
      const push = (key: 'seats' | 'projects' | 'storage', used: number, limit: number | null, growth30: number) => {
        if (!limit || used / limit < NEAR) return;
        const left = limit - used;
        out.push({ workspace: { id: u.id, name: u.name, slug: u.slug }, plan: u.plan, key, used, limit, ratio: Math.round((used / limit) * 1000) / 1000, etaDays: left <= 0 ? 0 : growth30 > 0 ? Math.ceil(left / (growth30 / 30)) : null, referredAt: sentAt.get(u.id) ?? null });
      };
      push('seats', u.seats, seats, u.seats30);
      push('projects', u.projects, projects, u.projects30);
      push('storage', u.storage, storage, u.storage30);
    }
    return out.sort((a, b) => b.ratio - a.ratio);
  }

  async referToSales(staff: Staff, workspaceId: string, input: z.infer<typeof ReferBody>) {
    const [u] = await this.usage(new Date(), [workspaceId]);
    if (!u) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const what = input.key === 'storage' ? 'พื้นที่ไฟล์' : KEY_NAMES[input.key];
    await staffAudit(this.db, staff, 'entitlements.referred_to_sales', `${u.name} (${PLAN_NAMES[u.plan]}) ใกล้ชนเพดาน${what}${input.note ? ` · ${input.note}` : ''}`, { type: 'workspace', id: workspaceId }, workspaceId);
    // ยังไม่มีทีมขายในระบบ · ส่งถึงอีเมลทีมขาย (OPS_SALES_EMAIL) หรือ Owner ทุกคน
    const to = (process.env.OPS_SALES_EMAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const recipients = to.length ? to : (await this.approvals.activeOwners()).map((o) => o.email);
    for (const email of recipients) {
      try {
        await this.mail.send({ to: email, subject: `[Friday Ops] เสนอแพ็กเกจใหญ่ขึ้น: ${u.name}`, text: `${staff.name} ส่งต่อ ${u.name} (${u.slug}) แพ็กเกจ ${PLAN_NAMES[u.plan]}\nใกล้ชนเพดาน${what}\nที่นั่ง ${u.seats} · โปรเจกต์ ${u.projects}${input.note ? `\nหมายเหตุ: ${input.note}` : ''}` });
      } catch {
        /* บันทึกใน mail log แล้ว */
      }
    }
    return { workspaceId, referredAt: new Date(), notified: recipients.length };
  }

  // ---------------------------------------------------------------------------

  /** การใช้งานของทุก Workspace ที่มีแพ็กเกจ (หรือเฉพาะที่ระบุ) · แพ็กเกจ = ที่ใช้สิทธิ์จริง (ทดลองหมด / ยกเลิกครบรอบ → Free) */
  private async usage(now: Date, ids?: string[]): Promise<Usage[]> {
    if (ids && !ids.length) return [];
    if (ids && ids.some((id) => !z.uuid().safeParse(id).success)) return [];
    const since = new Date(now.getTime() - 30 * DAY);
    const rows = await this.db.execute(sql`
      select w.id, w.slug, w.name, s.status as "subStatus", s.current_period_start as "cycleStart",
        case when s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at <= ${now}) then 'free'
             when s.status = 'canceled' and (s.current_period_end is null or s.current_period_end <= ${now}) then 'free'
             else p.code end as plan,
        (select count(*) from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest')::int as seats,
        (select count(*) from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest' and m.joined_at > ${since})::int as "seats30",
        (select count(*) from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role = 'guest')::int as guests,
        (select count(*) from projects pr where pr.workspace_id = w.id and pr.deleted_at is null and pr.archived_at is null)::int as projects,
        (select count(*) from projects pr where pr.workspace_id = w.id and pr.deleted_at is null and pr.archived_at is null and pr.created_at > ${since})::int as "projects30",
        (select coalesce(sum(f.size_bytes), 0) from file_versions f where f.workspace_id = w.id)::bigint as storage,
        (select coalesce(sum(f.size_bytes), 0) from file_versions f where f.workspace_id = w.id and f.created_at > ${since})::bigint as "storage30",
        (select count(*) from automation_runs r where r.workspace_id = w.id and r.result <> 'skipped'
           and r.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')::int as "automationRuns",
        (select count(*) from automation_rules r where r.workspace_id = w.id and r.enabled)::int as rules,
        (select count(*) from api_tokens t where t.workspace_id = w.id and t.revoked_at is null)::int as tokens,
        ((select count(*) from webhook_endpoints h where h.workspace_id = w.id) + (select count(*) from line_oa_configs l where l.workspace_id = w.id))::int as channels,
        (select count(*) from import_jobs j where j.workspace_id = w.id and j.mode = 'update' and j.created_at > ${new Date(now.getTime() - 90 * DAY)})::int as "updateImports"
      from workspaces w
      join subscriptions s on s.workspace_id = w.id
      join plans p on p.id = s.plan_id
      where w.deleted_at is null ${ids ? sql`and w.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}`);
    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      plan: (ENTITLEMENT_PLANS as readonly string[]).includes(r.plan as string) ? (r.plan as EntitlementPlan) : 'free',
      subStatus: (r.subStatus as string | null) ?? null,
      cycleStart: r.cycleStart ? new Date(r.cycleStart as string) : null,
      seats: Number(r.seats),
      projects: Number(r.projects),
      storage: Number(r.storage),
      automationRuns: Number(r.automationRuns),
      rules: Number(r.rules),
      tokens: Number(r.tokens),
      channels: Number(r.channels),
      guests: Number(r.guests),
      updateImports: Number(r.updateImports),
      seats30: Number(r.seats30),
      projects30: Number(r.projects30),
      storage30: Number(r.storage30),
    }));
  }
}

interface VersionPayload {
  matrix: Matrix;
  effectiveAt: string | null;
  reason: string;
  restoredFrom: number | null;
}

