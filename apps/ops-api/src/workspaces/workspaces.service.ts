import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { type Approval, audit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
const DAY = 86_400_000;
const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;

export const ListQuery = z.object({
  plan: z.enum(PLAN_CODES).optional(),
  status: z.enum(['trial', 'active', 'suspended', 'pending_delete', 'trialing', 'canceled', 'past_due']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const ExtendTrialBody = z.object({ days: z.number().int().min(1).max(60), reason: z.string().trim().min(3).max(300) }).strict();
export const DiscountBody = z
  .object({
    percent: z.number().int().min(1).max(100),
    /** จำนวนรอบบิลที่ลด · ไม่ระบุ = ตลอดไป */
    months: z.number().int().min(1).max(36).optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export const ChangePlanBody = z.object({ plan: z.enum(PLAN_CODES), reason: z.string().trim().min(3).max(300) }).strict();
export const SuspendBody = z
  .object({
    reason: z.string().trim().min(3).max(300),
    /** ระงับตามนโยบายค้างชำระ (การเงินทำได้ ไม่ต้องอนุมัติ) */
    policy: z.literal('overdue').optional(),
  })
  .strict();
export const ResumeBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/** ผลของรายการที่ต้องอนุมัติ: ทำเลย หรือสร้างคำขอแล้ว (controller ตอบ 202) */
export type Gated<T> = T | { pendingApproval: NonNullable<Awaited<ReturnType<ApprovalsService['gate']>>> };
const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);

/** Workspace ของลูกค้า (ฝั่งหลังบ้าน) · ข้ามขอบเขต RLS เพราะเป็นทีมระบบ · ทุกการแก้เขียน audit_logs ของ Workspace นั้น */
@Injectable()
export class WorkspacesService implements OnModuleInit {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
  ) {}

  /** อนุมัติแล้วทำรายการในนามผู้ขอ (06 › 4) */
  onModuleInit() {
    this.approvals.register('workspace.discount', (p, ctx) => this.applyDiscount(ctx.requester, p.workspaceId as string, p.input as z.infer<typeof DiscountBody>, ctx));
    this.approvals.register('workspace.extend_trial', (p, ctx) => this.applyExtendTrial(ctx.requester, p.workspaceId as string, p.input as z.infer<typeof ExtendTrialBody>, ctx));
    this.approvals.register('workspace.suspend', (p, ctx) => this.setStatus(ctx.requester, p.workspaceId as string, 'suspended', (p.input as { reason: string }).reason, ctx));
  }

  async list(q: z.infer<typeof ListQuery>) {
    const where = and(
      sql`${s.workspaces.deletedAt} is null`,
      q.q ? or(ilike(s.workspaces.name, `%${q.q}%`), ilike(s.workspaces.slug, `%${q.q}%`)) : undefined,
      q.plan ? eq(s.plans.code, q.plan) : undefined,
      q.status ? (q.status === 'trialing' || q.status === 'canceled' || q.status === 'past_due' ? eq(s.subscriptions.status, q.status) : eq(s.workspaces.status, q.status)) : undefined,
    );
    const rows = await this.db
      .select({
        id: s.workspaces.id,
        slug: s.workspaces.slug,
        name: s.workspaces.name,
        status: s.workspaces.status,
        createdAt: s.workspaces.createdAt,
        plan: s.plans.code,
        subStatus: s.subscriptions.status,
        cycle: s.subscriptions.cycle,
        trialEndsAt: s.subscriptions.trialEndsAt,
        periodEnd: s.subscriptions.currentPeriodEnd,
        seats: sql<number>`(select count(*)::int from workspace_members m where m.workspace_id = ${s.workspaces.id} and m.status = 'active' and m.role <> 'guest')`,
        projects: sql<number>`(select count(*)::int from projects p where p.workspace_id = ${s.workspaces.id} and p.deleted_at is null and p.archived_at is null)`,
      })
      .from(s.workspaces)
      .leftJoin(s.subscriptions, eq(s.subscriptions.workspaceId, s.workspaces.id))
      .leftJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(where)
      .orderBy(desc(s.workspaces.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    return { items: rows, limit: q.limit, offset: q.offset };
  }

  async get(id: string) {
    const [ws] = await this.db
      .select({ ws: s.workspaces, sub: s.subscriptions, plan: s.plans.code })
      .from(s.workspaces)
      .leftJoin(s.subscriptions, eq(s.subscriptions.workspaceId, s.workspaces.id))
      .leftJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(this.byId(id));
    if (!ws) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const owners = await this.db
      .select({ id: s.users.id, email: s.users.email, displayName: s.users.displayName, role: s.workspaceMembers.role })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, ws.ws.id), eq(s.workspaceMembers.status, 'active'), sql`${s.workspaceMembers.role} in ('owner', 'admin')`));
    const usageRes = await this.db.execute(sql`
      select
        (select count(*)::int from workspace_members where workspace_id = ${ws.ws.id} and status = 'active' and role <> 'guest') as members,
        (select count(*)::int from workspace_members where workspace_id = ${ws.ws.id} and status = 'active' and role = 'guest') as guests,
        (select count(*)::int from projects where workspace_id = ${ws.ws.id} and deleted_at is null) as projects,
        (select count(*)::int from issues where workspace_id = ${ws.ws.id} and deleted_at is null) as issues,
        (select coalesce(sum(size_bytes), 0)::text from file_versions where workspace_id = ${ws.ws.id}) as storage`);
    const [usage] = ((usageRes as unknown as { rows?: unknown[] }).rows ?? (usageRes as unknown as unknown[])) as { members: number; guests: number; projects: number; issues: number; storage: string }[];
    const [grant] = await this.db.select().from(s.supportAccessGrants).where(eq(s.supportAccessGrants.workspaceId, ws.ws.id));
    const sessions = await this.db.select().from(s.supportSessions).where(eq(s.supportSessions.workspaceId, ws.ws.id)).orderBy(desc(s.supportSessions.startedAt)).limit(10);
    const invoices = await this.db.select({ id: s.invoices.id, number: s.invoices.number, status: s.invoices.status, total: s.invoices.total, amountDue: s.invoices.amountDue, createdAt: s.invoices.createdAt }).from(s.invoices).where(eq(s.invoices.workspaceId, ws.ws.id)).orderBy(desc(s.invoices.createdAt)).limit(10);
    return {
      id: ws.ws.id,
      slug: ws.ws.slug,
      name: ws.ws.name,
      status: ws.ws.status,
      createdAt: ws.ws.createdAt,
      subscription: ws.sub ? { plan: ws.plan, status: ws.sub.status, cycle: ws.sub.cycle, trialEndsAt: ws.sub.trialEndsAt, currentPeriodEnd: ws.sub.currentPeriodEnd, paymentMethod: ws.sub.paymentMethod, discount: ws.sub.discount } : null,
      usage: { ...usage, storageBytes: Number(usage.storage) },
      owners,
      supportAccess: grant ? { until: grant.until, maxMode: grant.maxMode, notifyAdmins: grant.notifyAdmins, active: !grant.until || grant.until.getTime() > Date.now() } : null,
      supportSessions: sessions,
      invoices,
    };
  }

  private byId(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    return eq(s.workspaces.id, id);
  }

  private async sub(id: string) {
    this.byId(id);
    const [row] = await this.db.select({ sub: s.subscriptions, ws: s.workspaces }).from(s.workspaces).leftJoin(s.subscriptions, eq(s.subscriptions.workspaceId, s.workspaces.id)).where(eq(s.workspaces.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    return row;
  }

  /** ต่อช่วงทดลอง: เฉพาะที่ยังอยู่ในสถานะทดลอง · เกินวงเงินรวม (วัน / ครั้ง) ต้องอนุมัติ */
  async extendTrial(staff: Staff, id: string, input: z.infer<typeof ExtendTrialBody>): Promise<Gated<{ trialEndsAt: Date }>> {
    const { sub } = await this.sub(id);
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    if (sub.status !== 'trialing') throw new AppError(409, 'not_trialing', 'ต่อช่วงทดลองได้เฉพาะ Workspace ที่อยู่ในช่วงทดลอง', { status: sub.status });
    const prior = await this.trialExtensions(id);
    const { trialDays, trialTimes } = staff.limits;
    const pending = await this.approvals.gate(staff, {
      kind: 'workspace.extend_trial', workspaceId: id, target: { type: 'subscription', id: sub.id }, payload: { workspaceId: id, input }, reason: input.reason,
      exceeds: prior.times + 1 > trialTimes || prior.days + input.days > trialDays,
      rule: `ขยายทดลองรวมเกิน ${trialDays} วัน หรือเกิน ${trialTimes} ครั้ง (เคยขยาย ${prior.times} ครั้ง ${prior.days} วัน)`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyExtendTrial(staff, id, input);
  }

  /** การขยายทดลองที่ผ่านมา · นับจาก Audit log ที่ service นี้เขียนเอง ("ต่อช่วงทดลอง N วัน") */
  private async trialExtensions(id: string) {
    const rows = await this.db.select({ summary: s.auditLogs.summary }).from(s.auditLogs).where(and(eq(s.auditLogs.workspaceId, id), eq(s.auditLogs.action, 'ops.trial_extended')));
    return { times: rows.length, days: rows.reduce((n, r) => n + Number(/ต่อช่วงทดลอง (\d+) วัน/.exec(r.summary ?? '')?.[1] ?? 0), 0) };
  }

  private async applyExtendTrial(staff: Staff, id: string, input: z.infer<typeof ExtendTrialBody>, ctx?: ApprovalContext) {
    const { sub } = await this.sub(id);
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    if (sub.status !== 'trialing') throw new AppError(409, 'not_trialing', 'ต่อช่วงทดลองได้เฉพาะ Workspace ที่อยู่ในช่วงทดลอง', { status: sub.status });
    const base = sub.trialEndsAt && sub.trialEndsAt.getTime() > Date.now() ? sub.trialEndsAt : new Date();
    const trialEndsAt = new Date(base.getTime() + input.days * DAY);
    await this.db.transaction(async (tx) => {
      await tx.update(s.subscriptions).set({ trialEndsAt, currentPeriodEnd: trialEndsAt, updatedAt: new Date() }).where(eq(s.subscriptions.id, sub.id));
      await audit(tx, staff, id, 'plan', 'ops.trial_extended', `ต่อช่วงทดลอง ${input.days} วัน → ${trialEndsAt.toISOString().slice(0, 10)} · ${input.reason}`, { type: 'subscription', id: sub.id }, approvalOf(ctx));
    });
    return { trialEndsAt };
  }

  /** ส่วนลดเกิน % หรือจำนวนรอบในวงเงิน (ไม่ระบุรอบ = ตลอดไป) ต้องอนุมัติ */
  async discount(staff: Staff, id: string, input: z.infer<typeof DiscountBody>): Promise<Gated<{ discount: Record<string, unknown> }>> {
    const { sub } = await this.sub(id);
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    const { discountPct, discountCycles } = staff.limits;
    const pending = await this.approvals.gate(staff, {
      kind: 'workspace.discount', workspaceId: id, target: { type: 'subscription', id: sub.id }, payload: { workspaceId: id, input }, reason: input.reason,
      exceeds: input.percent > discountPct || input.months == null || input.months > discountCycles,
      rule: `ส่วนลดเกิน ${discountPct}% หรือเกิน ${discountCycles} รอบ`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyDiscount(staff, id, input);
  }

  private async applyDiscount(staff: Staff, id: string, input: z.infer<typeof DiscountBody>, ctx?: ApprovalContext) {
    const { sub } = await this.sub(id);
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    const discount = { percent: input.percent, months: input.months ?? null, reason: input.reason, setBy: staff.id, setAt: new Date().toISOString() };
    await this.db.transaction(async (tx) => {
      await tx.update(s.subscriptions).set({ discount, updatedAt: new Date() }).where(eq(s.subscriptions.id, sub.id));
      await audit(tx, staff, id, 'plan', 'ops.discount_set', `ส่วนลด ${input.percent}%${input.months ? ` นาน ${input.months} รอบ` : ''} · ${input.reason}`, { type: 'subscription', id: sub.id }, approvalOf(ctx));
    });
    return { discount };
  }

  /** เปลี่ยนแพ็กเกจโดยทีม Friday (เช่น ย้ายไป Enterprise ตามสัญญา) · ไม่ออกใบแจ้งหนี้ */
  async changePlan(staff: Staff, id: string, input: z.infer<typeof ChangePlanBody>) {
    const { sub } = await this.sub(id);
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    const [plan] = await this.db.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.code, input.plan));
    if (!plan) throw new AppError(404, 'plan_not_found', `ไม่พบแพ็กเกจ ${input.plan}`);
    const [prev] = await this.db.select({ code: s.plans.code }).from(s.plans).where(eq(s.plans.id, sub.planId));
    await this.db.transaction(async (tx) => {
      // แพ็กเกจที่ทีมกำหนดเอง = เปิดใช้ทันที ไม่นับเป็นช่วงทดลอง
      await tx.update(s.subscriptions).set({ planId: plan.id, status: 'active', trialEndsAt: null, updatedAt: new Date() }).where(eq(s.subscriptions.id, sub.id));
      await audit(tx, staff, id, 'plan', 'ops.plan_changed', `เปลี่ยนแพ็กเกจ ${prev?.code ?? '-'} → ${input.plan} · ${input.reason}`, { type: 'subscription', id: sub.id });
    });
    return { plan: input.plan, previous: prev?.code ?? null };
  }

  /**
   * ระงับ: ตามนโยบายค้างชำระ (การเงิน · ต้องเป็น past_due) ไม่ต้องอนุมัติ
   * Workspace ที่จ่ายเงินอยู่ต้องให้ Owner อนุมัติทุกครั้ง · ช่วงทดลอง / ยกเลิกแล้ว Owner ระงับได้เลย
   */
  async suspend(staff: Staff, id: string, input: z.infer<typeof SuspendBody>): Promise<Gated<{ id: string; status: string }>> {
    const { sub, ws } = await this.sub(id);
    if (ws.status === 'pending_delete') throw new AppError(409, 'workspace_deleted', 'Workspace นี้ถูกลบแล้ว');
    if (input.policy === 'overdue') {
      if (sub?.status !== 'past_due') throw new AppError(422, 'not_overdue', 'ระงับตามนโยบายค้างชำระได้เฉพาะ Workspace ที่ค้างชำระ', { status: sub?.status ?? null });
      return this.setStatus(staff, id, 'suspended', `${input.reason} (ค้างชำระตามนโยบาย)`);
    }
    if (!has(staff, 'owner')) throw new AppError(403, 'forbidden', 'ระงับนอกนโยบายค้างชำระได้เฉพาะ Owner');
    if (ws.status === 'suspended') throw new AppError(409, 'no_change', 'Workspace ถูกระงับอยู่แล้ว');
    const pending = await this.approvals.gate(staff, {
      kind: 'workspace.suspend', workspaceId: id, target: { type: 'workspace', id }, payload: { workspaceId: id, input }, reason: input.reason,
      exceeds: sub?.status === 'active', rule: 'ระงับ Workspace ที่จ่ายเงินต้องอนุมัติทุกครั้ง',
    });
    if (pending) return { pendingApproval: pending };
    return this.setStatus(staff, id, 'suspended', input.reason);
  }
  async resume(staff: Staff, id: string, input: z.infer<typeof ResumeBody>) {
    return this.setStatus(staff, id, 'active', input.reason);
  }
  private async setStatus(staff: Staff, id: string, status: 'suspended' | 'active', reason: string, ctx?: ApprovalContext) {
    const { ws } = await this.sub(id);
    if (ws.status === 'pending_delete') throw new AppError(409, 'workspace_deleted', 'Workspace นี้ถูกลบแล้ว');
    if (ws.status === status) throw new AppError(409, 'no_change', status === 'suspended' ? 'Workspace ถูกระงับอยู่แล้ว' : 'Workspace ไม่ได้ถูกระงับ');
    await this.db.transaction(async (tx) => {
      await tx.update(s.workspaces).set({ status, updatedAt: new Date() }).where(eq(s.workspaces.id, id));
      await audit(tx, staff, id, 'secu', status === 'suspended' ? 'ops.workspace_suspended' : 'ops.workspace_resumed', `${status === 'suspended' ? 'ระงับ' : 'เปิดใช้งานอีกครั้ง'} Workspace · ${reason}`, { type: 'workspace', id }, approvalOf(ctx));
    });
    return { id, status };
  }
}
