import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { type Approval, audit, staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { billingContacts, mailAll } from '../billing/ledger.js';
import { mrrOf } from '../metrics/economics.js';

const s = schema;
const DAY = 86_400_000;
const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;

export const ExtendTrialBody = z.object({ days: z.number().int().min(1).max(60), reason: z.string().trim().min(3).max(300) }).strict();
export const DiscountBody = z
  .object({
    percent: z.number().int().min(1).max(100),
    /** จำนวนรอบบิลที่ลด · ไม่ระบุ = ตลอดไป */
    months: z.number().int().min(1).max(36).optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export const ChangePlanBody = z.object({ plan: z.enum(PLAN_CODES), cycle: z.enum(['monthly', 'yearly']).optional(), reason: z.string().trim().min(3).max(300) }).strict();
export const PreviewQuery = z.object({ plan: z.enum(PLAN_CODES), cycle: z.enum(['monthly', 'yearly']).optional() });
export const TransferOwnerBody = z
  .object({
    newOwnerUserId: z.uuid(),
    ticketNo: z.string().trim().min(3).max(40),
    reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(500),
    /** หลักฐานที่ต้องครบ (C7): หนังสือจากบริษัทลงนามโดยผู้มีอำนาจ (แนบใน Ticket) และชื่อนิติบุคคลตรงกับข้อมูลออกใบกำกับภาษี */
    evidence: z.object({ companyLetter: z.boolean(), legalNameMatches: z.boolean() }).strict(),
  })
  .strict();
export const AccessRequestBody = z
  .object({
    ticketNo: z.string().trim().min(3).max(40),
    /** เฟส 1 ขอได้เฉพาะอ่านอย่างเดียว (โหมดแก้ไขยังไม่เปิด) */
    mode: z.literal('read').default('read'),
    hours: z.number().int().min(1).max(168).default(1),
    reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(500),
  })
  .strict();
export const NoteBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
/** Owner เดิมคัดค้านได้ภายใน 7 วันหลังได้อีเมลแจ้ง (C7) */
export const OBJECTION_DAYS = 7;
export const SuspendBody = z
  .object({
    reason: z.string().trim().min(3).max(300),
    /** ระงับตามนโยบายค้างชำระ (การเงินทำได้ ไม่ต้องอนุมัติ) */
    policy: z.literal('overdue').optional(),
    /** read_only = ดูและส่งออกได้ แก้ไม่ได้ (ใช้กับค้างชำระ) · full = ปิดทั้งหมด ยกเว้น Owner เห็นหน้าติดต่อทีม (ใช้กับการใช้ผิด) */
    mode: z.enum(['read_only', 'full']).default('read_only'),
    /** ข้อความถึงลูกค้า · แสดงในแอปและส่งอีเมลถึง Owner และผู้รับใบแจ้งหนี้ */
    message: z.string().trim().min(3).max(500).optional(),
    /** เปิดใช้งานเองเมื่อชำระใบแจ้งหนี้ที่ค้างครบ (ค่าเริ่มต้น: เปิดเมื่อระงับตามนโยบายค้างชำระ) */
    autoResume: z.boolean().optional(),
  })
  .strict();
type Suspension = { mode: 'read_only' | 'full'; message: string | null; autoResume: boolean };
export const ResumeBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

interface TransferPayload {
  [k: string]: unknown;
  workspaceId: string;
  newOwnerUserId: string;
  previousOwnerIds: string[];
  ticketNo: string;
  noticeSentAt: string;
}

/** ผลของรายการที่ต้องอนุมัติ: ทำเลย หรือสร้างคำขอแล้ว (controller ตอบ 202) */
export type Gated<T> = T | { pendingApproval: NonNullable<Awaited<ReturnType<ApprovalsService['gate']>>> };
const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);

/** Workspace ของลูกค้า (ฝั่งหลังบ้าน) · ข้ามขอบเขต RLS เพราะเป็นทีมระบบ · ทุกการแก้เขียน audit_logs ของ Workspace นั้น */
@Injectable()
export class WorkspacesService implements OnModuleInit {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly mail: Mailer,
  ) {}

  /** อนุมัติแล้วทำรายการในนามผู้ขอ (06 › 4) */
  onModuleInit() {
    this.approvals.register('workspace.discount', (p, ctx) => this.applyDiscount(ctx.requester, p.workspaceId as string, p.input as z.infer<typeof DiscountBody>, ctx));
    this.approvals.register('workspace.extend_trial', (p, ctx) => this.applyExtendTrial(ctx.requester, p.workspaceId as string, p.input as z.infer<typeof ExtendTrialBody>, ctx));
    this.approvals.register('workspace.transfer_owner', (p, ctx) => this.applyTransfer(ctx.requester, p as TransferPayload, ctx));
    this.approvals.register('workspace.suspend', (p, ctx) => {
      const input = p.input as z.infer<typeof SuspendBody>;
      return this.setStatus(ctx.requester, p.workspaceId as string, 'suspended', input.reason, ctx, suspensionOf(input));
    });
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

  private async planRow(code: string) {
    const [plan] = await this.db.select().from(s.plans).where(eq(s.plans.code, code));
    if (!plan) throw new AppError(404, 'plan_not_found', `ไม่พบแพ็กเกจ ${code}`);
    return plan;
  }
  private async seatsInUse(id: string) {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, id), eq(s.workspaceMembers.status, 'active'), ne(s.workspaceMembers.role, 'guest')));
    return r.n;
  }
  private static price(plan: typeof s.plans.$inferSelect, cycle: string) {
    return cycle === 'yearly' ? plan.priceYearlySatang : plan.priceMonthlySatang;
  }

  /**
   * ตัวอย่างยอดก่อนเปลี่ยนแพ็กเกจ (C4) · อัปเกรดมีผลทันทีคิดส่วนต่างตามวันที่เหลือ · ลดแพ็กเกจมีผลรอบถัดไป
   * ใช้คนเกินที่นั่งของแพ็กเกจใหม่ไม่ได้ · Enterprise ไม่มีราคาตายตัว (ตามสัญญา)
   */
  async preview(id: string, q: z.infer<typeof PreviewQuery>) {
    const { sub } = await this.sub(id);
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    const [cur, next] = [await this.planRowById(sub.planId), await this.planRow(q.plan)];
    const cycle = q.cycle ?? sub.cycle;
    const seats = await this.seatsInUse(id);
    const oldPrice = WorkspacesService.price(cur, sub.cycle);
    const newPrice = WorkspacesService.price(next, cycle);
    const monthly = (p: number | null, c: string) => (p == null ? null : c === 'yearly' ? p / 12 : p);
    const upgrade = (monthly(newPrice, cycle) ?? Infinity) > (monthly(oldPrice, sub.cycle) ?? 0) || cycle !== sub.cycle;
    const blocked = next.seatLimit != null && seats > next.seatLimit ? { code: 'seats_exceed_plan', message: `ใช้อยู่ ${seats} คน เกินที่นั่งของ ${q.plan} (${next.seatLimit})` } : null;
    const lines: { label: string; satang: number }[] = [];
    let effective: 'now' | 'next_cycle' = upgrade ? 'now' : 'next_cycle';
    if (newPrice == null) effective = 'now';
    else if (sub.status === 'trialing') lines.push({ label: `${q.plan} ${cycle === 'yearly' ? 'รายปี' : 'รายเดือน'} (เริ่มเมื่อชำระ)`, satang: newPrice });
    else if (effective === 'now') {
      const start = sub.currentPeriodStart?.getTime() ?? Date.now();
      const end = sub.currentPeriodEnd?.getTime() ?? Date.now();
      const total = Math.max(1, Math.round((end - start) / DAY));
      const left = Math.max(0, Math.ceil((end - Date.now()) / DAY));
      if (cycle === sub.cycle) lines.push({ label: `${q.plan} ${left} วันที่เหลือของรอบนี้`, satang: Math.round(((newPrice - (oldPrice ?? 0)) * left) / total) });
      else {
        lines.push({ label: `${q.plan} ${cycle === 'yearly' ? 'รายปี' : 'รายเดือน'}`, satang: newPrice });
        if (oldPrice) lines.push({ label: `เครดิตคืน ${cur.code} ที่ยังไม่ใช้ (${left} วัน)`, satang: -Math.round((oldPrice * left) / total) });
      }
    }
    const subtotal = Math.max(0, lines.reduce((n, l) => n + l.satang, 0));
    const vat = process.env.VAT_REGISTERED !== 'false' ? Math.round(subtotal * 0.07) : 0;
    return {
      current: { plan: cur.code, cycle: sub.cycle, priceSatang: oldPrice, seatLimit: cur.seatLimit },
      next: { plan: next.code, cycle, priceSatang: newPrice, seatLimit: next.seatLimit },
      seatsInUse: seats,
      blocked,
      contract: newPrice == null,
      effective,
      lines,
      subtotalSatang: subtotal,
      vatSatang: vat,
      totalSatang: subtotal + vat,
    };
  }
  private async planRowById(planId: string) {
    const [plan] = await this.db.select().from(s.plans).where(eq(s.plans.id, planId));
    return plan;
  }

  /**
   * เปลี่ยนแพ็กเกจโดยทีม Friday (เช่น ย้ายไป Enterprise ตามสัญญา หรือลูกค้าขอผ่าน Ticket) · มีผลทันที
   * เฟส 1 ยังไม่ออกใบแจ้งหนี้ส่วนต่าง (ต้องใช้ขั้นตอนชำระเงินของ API ลูกค้า) · บันทึก subscription_changes ให้ MRR ตรง
   */
  async changePlan(staff: Staff, id: string, input: z.infer<typeof ChangePlanBody>) {
    const { sub } = await this.sub(id);
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    const plan = await this.planRow(input.plan);
    const prev = await this.planRowById(sub.planId);
    const cycle = input.cycle ?? sub.cycle;
    if (plan.id === prev.id && cycle === sub.cycle && sub.status === 'active') throw new AppError(409, 'no_change', 'ใช้แพ็กเกจนี้อยู่แล้ว');
    const seats = await this.seatsInUse(id);
    if (plan.seatLimit != null && seats > plan.seatLimit) throw new AppError(409, 'seats_exceed_plan', `ใช้อยู่ ${seats} คน เกินที่นั่งของแพ็กเกจ ${input.plan} (${plan.seatLimit})`, { seats, seatLimit: plan.seatLimit });
    const before = mrrOf(sub, prev);
    const after = mrrOf({ status: 'active', cycle, discount: sub.discount }, plan);
    await this.db.transaction(async (tx) => {
      // แพ็กเกจที่ทีมกำหนดเอง = เปิดใช้ทันที ไม่นับเป็นช่วงทดลอง
      await tx.update(s.subscriptions).set({ planId: plan.id, cycle, status: 'active', trialEndsAt: null, updatedAt: new Date() }).where(eq(s.subscriptions.id, sub.id));
      await tx.insert(s.subscriptionChanges).values({
        workspaceId: id, kind: sub.status === 'trialing' ? 'new' : after > before ? 'upgrade' : after < before ? 'downgrade' : 'cycle_change',
        planFrom: prev.code, planTo: plan.code, mrrBeforeSatang: sub.status === 'trialing' ? 0 : before, mrrAfterSatang: after, actorKind: 'staff', actorId: staff.id, effectiveAt: new Date(),
      });
      await audit(tx, staff, id, 'plan', 'ops.plan_changed', `เปลี่ยนแพ็กเกจ ${prev.code} → ${input.plan}${cycle !== sub.cycle ? ` (${cycle === 'yearly' ? 'รายปี' : 'รายเดือน'})` : ''} · ${input.reason}`, { type: 'subscription', id: sub.id });
    });
    return { plan: input.plan, cycle, previous: prev.code };
  }

  /**
   * โอนความเป็นเจ้าของ (C7): ใช้เมื่อ Owner เดิมลาออกหรือติดต่อไม่ได้ · ต้องมีหลักฐานครบ และให้คนที่สองอนุมัติทุกครั้ง
   * ส่งอีเมลแจ้ง Owner เดิมทันที · อนุมัติแล้วจะโอนได้เมื่อครบ 7 วันโดยไม่มีการคัดค้าน (คัดค้านทาง Ticket → ผู้อนุมัติกดไม่อนุมัติ)
   */
  async transferOwner(staff: Staff, id: string, input: z.infer<typeof TransferOwnerBody>) {
    const { ws } = await this.sub(id);
    if (ws.status === 'pending_delete') throw new AppError(409, 'workspace_deleted', 'Workspace นี้ถูกลบแล้ว');
    const missing = [!input.evidence.companyLetter && 'companyLetter', !input.evidence.legalNameMatches && 'legalNameMatches'].filter(Boolean);
    if (missing.length) throw new AppError(422, 'evidence_incomplete', 'หลักฐานยังไม่ครบ', { missing });
    const members = await this.db
      .select({ userId: s.workspaceMembers.userId, role: s.workspaceMembers.role, status: s.workspaceMembers.status, email: s.users.email, disabledAt: s.users.disabledAt })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(eq(s.workspaceMembers.workspaceId, id));
    const next = members.find((m) => m.userId === input.newOwnerUserId);
    if (!next || next.status !== 'active' || next.disabledAt) throw new AppError(422, 'new_owner_not_member', 'Owner ใหม่ต้องเป็นสมาชิกที่ใช้งานอยู่ของ Workspace นี้');
    if (next.role === 'guest') throw new AppError(422, 'new_owner_guest', 'Guest เป็น Owner ไม่ได้');
    if (next.role === 'owner') throw new AppError(409, 'already_owner', 'ผู้ใช้นี้เป็น Owner อยู่แล้ว');
    const previous = members.filter((m) => m.role === 'owner' && m.status === 'active');
    const [open] = await this.db.select({ id: s.approvalRequests.id }).from(s.approvalRequests).where(and(eq(s.approvalRequests.workspaceId, id), eq(s.approvalRequests.kind, 'workspace.transfer_owner'), eq(s.approvalRequests.status, 'pending')));
    if (open) throw new AppError(409, 'transfer_pending', 'มีคำขอโอนความเป็นเจ้าของที่รออยู่แล้ว', { approvalId: open.id });

    const noticeSentAt = new Date();
    const availableAt = new Date(noticeSentAt.getTime() + OBJECTION_DAYS * DAY);
    for (const o of previous) {
      await this.notify(o.email, `แจ้งขอโอนความเป็นเจ้าของ Workspace ${ws.name}`, [
        `ทีม Friday ได้รับคำขอโอนความเป็นเจ้าของ Workspace ${ws.name} ไปยัง ${next.email} (Ticket ${input.ticketNo})`,
        `ถ้าคุณไม่ได้ยินยอม ตอบกลับอีเมลนี้หรือ Ticket ${input.ticketNo} ภายใน ${OBJECTION_DAYS} วัน (ถึง ${availableAt.toISOString().slice(0, 10)}) ทีม Friday จะยกเลิกคำขอ`,
      ]);
    }
    const payload: TransferPayload = { workspaceId: id, newOwnerUserId: input.newOwnerUserId, previousOwnerIds: previous.map((p) => p.userId), ticketNo: input.ticketNo, noticeSentAt: noticeSentAt.toISOString() };
    const pending = await this.approvals.gate(staff, {
      kind: 'workspace.transfer_owner', workspaceId: id, target: { type: 'workspace', id }, payload, reason: `${input.reason} · Ticket ${input.ticketNo}`,
      exceeds: true, rule: `โอนความเป็นเจ้าของต้องอนุมัติทุกครั้ง · โอนได้หลังแจ้ง Owner เดิมครบ ${OBJECTION_DAYS} วัน`,
    });
    await audit(this.db, staff, id, 'perm', 'ops.owner_transfer_requested', `ขอโอนความเป็นเจ้าของให้ ${next.email} · แจ้ง Owner เดิม ${previous.length} คน · โอนได้ตั้งแต่ ${availableAt.toISOString().slice(0, 10)} · Ticket ${input.ticketNo} · ${input.reason}`, { type: 'workspace', id });
    return { pendingApproval: pending!, availableAt, notified: previous.length };
  }

  private async applyTransfer(staff: Staff, p: TransferPayload, ctx: ApprovalContext) {
    const availableAt = new Date(new Date(p.noticeSentAt).getTime() + OBJECTION_DAYS * DAY);
    if (Date.now() < availableAt.getTime()) throw new AppError(409, 'objection_window_open', `ยังอยู่ในช่วงให้ Owner เดิมคัดค้าน โอนได้ตั้งแต่ ${availableAt.toISOString().slice(0, 10)}`, { availableAt });
    const [next] = await this.db
      .select({ status: s.workspaceMembers.status, role: s.workspaceMembers.role, email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, p.workspaceId), eq(s.workspaceMembers.userId, p.newOwnerUserId)));
    if (!next || next.status !== 'active' || next.role === 'guest') throw new AppError(409, 'new_owner_not_member', 'Owner ใหม่ไม่ได้เป็นสมาชิกที่ใช้งานอยู่แล้ว');
    await this.db.transaction(async (tx) => {
      await tx.update(s.workspaceMembers).set({ role: 'owner' }).where(and(eq(s.workspaceMembers.workspaceId, p.workspaceId), eq(s.workspaceMembers.userId, p.newOwnerUserId)));
      // Owner เดิมยังอยู่ในทีมเป็น Admin · ลูกค้าเอาออกเองได้ภายหลัง
      if (p.previousOwnerIds.length) await tx.update(s.workspaceMembers).set({ role: 'admin' }).where(and(eq(s.workspaceMembers.workspaceId, p.workspaceId), inArray(s.workspaceMembers.userId, p.previousOwnerIds)));
      await audit(tx, staff, p.workspaceId, 'perm', 'ops.owner_transferred', `โอนความเป็นเจ้าของให้ ${next.email} · Owner เดิมเป็น Admin · Ticket ${p.ticketNo}`, { type: 'workspace', id: p.workspaceId }, approvalOf(ctx));
    });
    await this.notify(next.email, 'คุณเป็น Owner ของ Workspace แล้ว', [`ทีม Friday โอนความเป็นเจ้าของ Workspace ให้คุณแล้วตาม Ticket ${p.ticketNo}`]);
    return { workspaceId: p.workspaceId, newOwnerUserId: p.newOwnerUserId };
  }

  /** ขอสิทธิ์เข้าบัญชีจากลูกค้า (C2) เมื่อลูกค้ายังไม่เปิด · ส่งอีเมลถึง Owner ให้เปิดที่ Admin Console */
  async requestAccess(staff: Staff, id: string, input: z.infer<typeof AccessRequestBody>) {
    const { ws } = await this.sub(id);
    const [grant] = await this.db.select().from(s.supportAccessGrants).where(eq(s.supportAccessGrants.workspaceId, id));
    if (grant && (!grant.until || grant.until.getTime() > Date.now())) throw new AppError(409, 'support_access_already_granted', 'ลูกค้าเปิดสิทธิ์ให้อยู่แล้ว เข้าบัญชีได้เลย', { until: grant.until, maxMode: grant.maxMode });
    const owners = await this.db
      .select({ email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, id), eq(s.workspaceMembers.status, 'active'), eq(s.workspaceMembers.role, 'owner')));
    if (!owners.length) throw new AppError(409, 'no_owner', 'Workspace นี้ไม่มี Owner ที่ใช้งานอยู่ ใช้การโอนความเป็นเจ้าของก่อน');
    let sent = 0;
    for (const o of owners) {
      if (
        await this.notify(o.email, `ทีม Friday ขอเข้าดูบัญชี ${ws.name} (Ticket ${input.ticketNo})`, [
          `ทีม Friday (${staff.name}) ขอเข้าดูบัญชี ${ws.name} แบบอ่านอย่างเดียว ${input.hours} ชั่วโมง`,
          `เหตุผล: ${input.reason} (Ticket ${input.ticketNo})`,
          `อนุญาตได้ที่ ${config.appUrl}/work/${ws.slug}/admin › การเข้าช่วยเหลือจากทีม Friday · ถ้าไม่อนุญาต ไม่ต้องทำอะไร`,
        ])
      )
        sent++;
    }
    await audit(this.db, staff, id, 'secu', 'support.access_requested', `ขอสิทธิ์เข้าบัญชีแบบอ่านอย่างเดียว ${input.hours} ชม. · Ticket ${input.ticketNo} · ${input.reason}`, { type: 'workspace', id });
    return { sent, owners: owners.length };
  }

  /** บันทึกภายใน (ลูกค้าไม่เห็น) · เก็บใน staff_audit_logs ซึ่งแก้ / ลบไม่ได้ จึงเป็นประวัติตามจริง */
  async addNote(staff: Staff, id: string, input: z.infer<typeof NoteBody>) {
    await this.sub(id);
    await staffAudit(this.db, staff, 'ops.note', input.text, { type: 'workspace', id }, id);
    const [row] = await this.db.select({ id: s.staffAuditLogs.id, text: s.staffAuditLogs.reason, createdAt: s.staffAuditLogs.createdAt }).from(s.staffAuditLogs).where(and(eq(s.staffAuditLogs.workspaceId, id), eq(s.staffAuditLogs.action, 'ops.note'), eq(s.staffAuditLogs.staffId, staff.id))).orderBy(sql`${s.staffAuditLogs.createdAt} desc`).limit(1);
    return { ...row, staffId: staff.id, staffName: staff.name };
  }

  /** ส่งอีเมลไม่ได้ไม่ทำให้รายการล้ม (Mailer บันทึก log แล้ว) */
  private async notify(to: string, subject: string, lines: string[]) {
    try {
      await this.mail.send({ to, subject, text: lines.join('\n') });
      return true;
    } catch {
      return false;
    }
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
      return this.setStatus(staff, id, 'suspended', `${input.reason} (ค้างชำระตามนโยบาย)`, undefined, suspensionOf(input));
    }
    if (!has(staff, 'owner')) throw new AppError(403, 'forbidden', 'ระงับนอกนโยบายค้างชำระได้เฉพาะ Owner');
    if (ws.status === 'suspended') throw new AppError(409, 'no_change', 'Workspace ถูกระงับอยู่แล้ว');
    const pending = await this.approvals.gate(staff, {
      kind: 'workspace.suspend', workspaceId: id, target: { type: 'workspace', id }, payload: { workspaceId: id, input }, reason: input.reason,
      exceeds: sub?.status === 'active', rule: 'ระงับ Workspace ที่จ่ายเงินต้องอนุมัติทุกครั้ง',
    });
    if (pending) return { pendingApproval: pending };
    return this.setStatus(staff, id, 'suspended', input.reason, undefined, suspensionOf(input));
  }
  async resume(staff: Staff, id: string, input: z.infer<typeof ResumeBody>) {
    return this.setStatus(staff, id, 'active', input.reason);
  }
  private async setStatus(staff: Staff, id: string, target: 'suspended' | 'active', reason: string, ctx?: ApprovalContext, suspension?: Suspension) {
    const { ws, sub } = await this.sub(id);
    if (ws.status === 'pending_delete') throw new AppError(409, 'workspace_deleted', 'Workspace นี้ถูกลบแล้ว');
    if (target === 'suspended' ? ws.status === 'suspended' : ws.status !== 'suspended') throw new AppError(409, 'no_change', target === 'suspended' ? 'Workspace ถูกระงับอยู่แล้ว' : 'Workspace ไม่ได้ถูกระงับ');
    // ยกเลิกระงับ: กลับไปสถานะตามแพ็กเกจ (ยังทดลองใช้ = trial) ไม่ใช่ active เสมอ
    const status = target === 'suspended' ? 'suspended' : sub?.status === 'trialing' ? 'trial' : 'active';
    const sus = status === 'suspended' ? (suspension ?? { mode: 'read_only' as const, message: null, autoResume: false }) : null;
    await this.db.transaction(async (tx) => {
      await tx
        .update(s.workspaces)
        .set({ status, suspensionMode: sus?.mode ?? null, suspensionMessage: sus?.message ?? null, suspensionAutoResume: sus?.autoResume ?? false, updatedAt: new Date() })
        .where(eq(s.workspaces.id, id));
      const what = sus ? `ระงับ Workspace (${sus.mode === 'full' ? 'ปิดทั้งหมด' : 'อ่านอย่างเดียว'}${sus.autoResume ? ' · เปิดเองเมื่อชำระ' : ''})` : 'เปิดใช้งาน Workspace อีกครั้ง';
      await audit(tx, staff, id, 'secu', sus ? 'ops.workspace_suspended' : 'ops.workspace_resumed', `${what} · ${reason}`, { type: 'workspace', id }, approvalOf(ctx));
    });
    // แจ้ง Owner และผู้รับใบแจ้งหนี้ (ล้มไม่ทำให้การระงับล้ม)
    if (sus?.message) await mailAll(this.mail, await billingContacts(this.db, id), `Workspace ${ws.name} ถูกระงับ`, `${sus.message}\nข้อมูลทั้งหมดยังอยู่ครบ หากมีข้อสงสัยตอบกลับอีเมลนี้ได้`).catch(() => 0);
    return { id, status, suspension: sus };
  }
}

/** ค่าการระงับจากคำขอ · ระงับตามนโยบายค้างชำระเปิดเองเมื่อชำระเป็นค่าเริ่มต้น */
function suspensionOf(input: z.infer<typeof SuspendBody>): Suspension {
  return { mode: input.mode ?? 'read_only', message: input.message ?? null, autoResume: input.autoResume ?? input.policy === 'overdue' };
}
