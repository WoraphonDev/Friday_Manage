import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { couponGrantBlockers, cyclesOf, type Db, grantCoupon, schema } from '@friday/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type ApprovalContext, ApprovalsService } from '../approvals/approvals.service.js';
import { audit, staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { CustomersService, FEATURES } from './customers.service.js';
import { WorkspacesService } from './workspaces.service.js';

const s = schema;
/** สูงสุดต่อครั้ง (H4 · เลือกตามตัวกรอง) */
export const BULK_MAX = 1000;
const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;

/** ตัวกรองชุดเดียวกับ GET ops/workspaces (ไม่รวมการเรียง / แบ่งหน้า) */
export const BulkFilter = z
  .object({
    plan: z.enum(PLAN_CODES).optional(),
    status: z.enum(['trial', 'active', 'suspended', 'pending_delete', 'trialing', 'canceled', 'past_due']).optional(),
    q: z.string().trim().max(100).optional(),
    feature: z.enum(FEATURES).optional(),
  })
  .strict();
export const BulkBody = z
  .object({
    action: z.enum(['extend_trial', 'coupon', 'discount']),
    /** เลือกเป็นรายการ id (ข้ามหน้าได้) หรือ */
    ids: z.array(z.uuid()).min(1).max(BULK_MAX).optional(),
    /** ตามตัวกรอง: เซิร์ฟเวอร์หารายการ ณ เวลาที่ยืนยัน */
    filter: BulkFilter.optional(),
    days: z.number().int().min(1).max(60).optional(),
    couponId: z.uuid().optional(),
    percent: z.number().int().min(1).max(100).optional(),
    months: z.number().int().min(1).max(36).optional(),
    reason: z.string().trim().min(3).max(300),
    /** อีเมลแจ้ง Owner ของแต่ละ Workspace ที่ทำสำเร็จ */
    notifyOwners: z.boolean().default(false),
  })
  .strict()
  .refine((b) => !!b.ids !== !!b.filter, { message: 'ระบุ ids หรือ filter อย่างใดอย่างหนึ่ง', path: ['ids'] })
  .refine((b) => b.action !== 'extend_trial' || b.days !== undefined, { message: 'ระบุจำนวนวัน', path: ['days'] })
  .refine((b) => b.action !== 'coupon' || b.couponId !== undefined, { message: 'เลือกคูปอง', path: ['couponId'] })
  .refine((b) => b.action !== 'discount' || b.percent !== undefined, { message: 'ระบุส่วนลด %', path: ['percent'] });
type Body = z.infer<typeof BulkBody>;

type Verdict = 'ok' | 'approval' | 'skip';
interface Plan {
  workspaceId: string;
  name: string;
  slug: string;
  verdict: Verdict;
  /** เหตุผลที่ข้าม / ต้องอนุมัติ */
  reason: string | null;
  code: string | null;
}
type Coupon = typeof s.coupons.$inferSelect;

const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const thaiDate = (d: Date) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' }).format(d);

/** % ส่วนลดของคูปองเทียบราคาแพ็กเกจรายเดือน (ใช้เทียบวงเงินพนักงาน) · ใช้ฟรี N เดือน = 100% */
const couponPct = (c: Coupon, monthly: number | null) => (c.kind === 'percent' ? c.value : c.kind === 'free_months' ? 100 : monthly ? Math.ceil((c.value * 100) / monthly) : 100);

/**
 * ทำกับหลาย Workspace (รอบ 4 · H4–H7 · O02)
 * - preview: ตรวจก่อนทำ แต่ละรายเป็น ทำได้ทันที / ต้องอนุมัติ / ข้าม (พร้อมเหตุผล) · ไม่เขียนอะไร
 * - apply: ทำที่เซิร์ฟเวอร์ตามผลตรวจ ณ ตอนยืนยัน · รายที่เกินวงเงินสร้างคำขออนุมัติรายละ 1 คำขอ (gate เดิม) · คืนผลรายแถว
 * วงเงินใช้ของพนักงานจริง (staff.limits) · ทุกรายการเขียน Audit ของ Workspace นั้นผ่าน service เดิม + Audit ของทีม 1 แถวต่อชุด
 */
@Injectable()
export class BulkService implements OnModuleInit {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly customers: CustomersService,
    private readonly workspaces: WorkspacesService,
    private readonly approvals: ApprovalsService,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    this.approvals.register('workspace.coupon', (p, ctx) => this.applyCoupon(ctx.requester, p.workspaceId as string, p.couponId as string, p.reason as string, ctx));
  }

  private allowed(staff: Staff, action: Body['action']) {
    if (action === 'extend_trial' ? !has(staff, 'support') : !has(staff, 'finance')) {
      throw new AppError(403, 'forbidden', action === 'extend_trial' ? 'ขยายทดลองใช้ได้เฉพาะ Support' : 'ให้คูปองหรือส่วนลดได้เฉพาะการเงิน');
    }
  }

  /** Workspace ตามที่เลือก (id) หรือตามตัวกรอง · เกิน 1,000 รายไม่ทำ */
  private async targets(input: Body) {
    let ids: string[];
    if (input.filter) {
      ids = await this.customers.idsFor(input.filter, BULK_MAX + 1);
      if (ids.length > BULK_MAX) throw new AppError(422, 'bulk_too_many', `ตัวกรองนี้มีเกิน ${BULK_MAX.toLocaleString('en-US')} รายการ · กรองให้แคบลงก่อน`, { max: BULK_MAX });
    } else ids = [...new Set(input.ids!)];
    if (!ids.length) return [];
    const rows = await this.db
      .select({ id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug, status: s.workspaces.status, sub: s.subscriptions, plan: s.plans.code, monthly: s.plans.priceMonthlySatang })
      .from(s.workspaces)
      .leftJoin(s.subscriptions, eq(s.subscriptions.workspaceId, s.workspaces.id))
      .leftJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(and(inArray(s.workspaces.id, ids), isNull(s.workspaces.deletedAt)));
    // คงลำดับตามที่เลือก / ตามตัวกรอง
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  private async coupon(id: string) {
    const [c] = await this.db.select().from(s.coupons).where(eq(s.coupons.id, id));
    if (!c) throw new AppError(404, 'coupon_not_found', 'ไม่พบคูปอง');
    return c;
  }

  /** ตรวจก่อนทำ (ไม่เขียนอะไร) */
  async plan(staff: Staff, input: Body): Promise<{ rows: Plan[]; coupon: Coupon | null }> {
    this.allowed(staff, input.action);
    const ws = await this.targets(input);
    const base = (w: (typeof ws)[number], verdict: Verdict, reason: string | null = null, code: string | null = null): Plan => ({ workspaceId: w.id, name: w.name, slug: w.slug, verdict, reason, code });
    const L = staff.limits;
    if (input.action === 'extend_trial') {
      // การขยายที่ผ่านมา นับจาก Audit ที่ WorkspacesService เขียนเอง ("ต่อช่วงทดลอง N วัน") แบบเดียวกับรายเดี่ยว
      const prior = ws.length
        ? await this.db.select({ ws: s.auditLogs.workspaceId, summary: s.auditLogs.summary }).from(s.auditLogs).where(and(inArray(s.auditLogs.workspaceId, ws.map((w) => w.id)), eq(s.auditLogs.action, 'ops.trial_extended')))
        : [];
      return {
        coupon: null,
        rows: ws.map((w) => {
          if (w.status === 'suspended') return base(w, 'skip', 'ถูกระงับ', 'suspended');
          if (!w.sub || w.sub.status !== 'trialing') return base(w, 'skip', 'ไม่ได้อยู่ในช่วงทดลอง', 'not_trialing');
          if (w.sub.trialEndsAt && w.sub.trialEndsAt.getTime() < Date.now()) return base(w, 'skip', `ทดลองหมด ${thaiDate(w.sub.trialEndsAt)} แล้ว`, 'trial_ended');
          const mine = prior.filter((p) => p.ws === w.id);
          const days = mine.reduce((n, r) => n + Number(/ต่อช่วงทดลอง (\d+) วัน/.exec(r.summary ?? '')?.[1] ?? 0), 0) + input.days!;
          if (mine.length + 1 > L.trialTimes) return base(w, 'approval', `ขยายครั้งที่ ${mine.length + 1} (วงเงิน ${L.trialTimes} ครั้ง)`, 'over_times');
          if (days > L.trialDays) return base(w, 'approval', `รวม ${days} วัน (วงเงิน ${L.trialDays})`, 'over_days');
          return base(w, 'ok');
        }),
      };
    }
    if (input.action === 'discount') {
      const exceeds = input.percent! > L.discountPct || input.months == null || input.months > L.discountCycles;
      return { coupon: null, rows: ws.map((w) => (!w.sub ? base(w, 'skip', 'ยังไม่มีแพ็กเกจ', 'no_subscription') : exceeds ? base(w, 'approval', `ส่วนลดเกิน ${L.discountPct}% หรือเกิน ${L.discountCycles} รอบ`, 'over_limit') : base(w, 'ok'))) };
    }
    const c = await this.coupon(input.couponId!);
    const check = await couponGrantBlockers(this.db, c, ws.map((w) => ({ workspaceId: w.id, plan: w.sub ? w.plan : null })), todayBkk());
    if (check.global) throw new AppError(422, check.global.code, check.global.message);
    let left = check.remaining;
    const cycles = cyclesOf(c);
    return {
      coupon: c,
      rows: ws.map((w) => {
        const block = check.perWorkspace.get(w.id);
        if (block) return base(w, 'skip', block.message, block.code);
        if (left !== null) {
          if (left <= 0) return base(w, 'skip', 'สิทธิ์ของคูปองไม่พอ', 'coupon_exhausted');
          left--;
        }
        const pct = couponPct(c, w.monthly ?? null);
        if (pct > L.discountPct || cycles === null || cycles > L.discountCycles) return base(w, 'approval', `ส่วนลดเกิน ${L.discountPct}% หรือเกิน ${L.discountCycles} รอบ`, 'over_limit');
        return base(w, 'ok');
      }),
    };
  }

  async preview(staff: Staff, input: Body) {
    const { rows, coupon } = await this.plan(staff, input);
    const n = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
    return {
      action: input.action,
      total: rows.length,
      counts: { ok: n('ok'), approval: n('approval'), skip: n('skip') },
      rows,
      limits: staff.limits,
      coupon: coupon ? { id: coupon.id, code: coupon.code, kind: coupon.kind, value: coupon.value, cycles: cyclesOf(coupon) } : null,
    };
  }

  /** ทำจริงตามผลตรวจ ณ ตอนยืนยัน · รายที่ล้มไม่ทำให้รายอื่นล้ม */
  async apply(staff: Staff, input: Body) {
    const startedAt = new Date();
    const { rows } = await this.plan(staff, input);
    const batchId = randomUUID();
    const out: { workspaceId: string; name: string; slug: string; result: 'done' | 'pending' | 'skipped' | 'failed'; detail: string | null; approvalId: string | null }[] = [];
    const reason = `${input.reason} · ชุด #BULK-${batchId.slice(0, 8)}`;
    for (const r of rows) {
      const row = { workspaceId: r.workspaceId, name: r.name, slug: r.slug };
      if (r.verdict === 'skip') {
        out.push({ ...row, result: 'skipped', detail: r.reason, approvalId: null });
        continue;
      }
      try {
        if (r.verdict === 'approval') {
          const pending = await this.gate(staff, input, r, reason);
          out.push({ ...row, result: 'pending', detail: r.reason, approvalId: pending.id });
        } else {
          const detail = await this.run(staff, input, r.workspaceId, reason);
          out.push({ ...row, result: 'done', detail, approvalId: null });
          if (input.notifyOwners) await this.notifyOwners(r.workspaceId, r.name, input, detail);
        }
      } catch (e) {
        out.push({ ...row, result: 'failed', detail: e instanceof Error ? e.message : String(e), approvalId: null });
      }
    }
    const counts = { done: 0, pending: 0, skipped: 0, failed: 0 };
    for (const o of out) counts[o.result]++;
    const label = { extend_trial: `ขยายทดลองใช้ ${input.days} วัน`, coupon: 'ให้คูปอง', discount: `ส่วนลด ${input.percent}%${input.months ? ` ${input.months} รอบ` : ''}` }[input.action];
    await staffAudit(this.db, staff, `ops.bulk_${input.action}`, `${label} หลายราย ${out.length} Workspace · สำเร็จ ${counts.done} · รออนุมัติ ${counts.pending} · ข้าม ${counts.skipped} · ล้ม ${counts.failed} · ${input.filter ? 'ตามตัวกรอง' : 'ตามที่เลือก'} · ${input.reason}`, { type: 'bulk_batch', id: batchId });
    return { batchId, startedAt, finishedAt: new Date(), counts, rows: out };
  }

  /** 1 รายที่เกินวงเงิน = 1 คำขออนุมัติ (ใช้ตัวทำงานเดิมของรายเดี่ยว) */
  private async gate(staff: Staff, input: Body, r: Plan, reason: string) {
    const L = staff.limits;
    const g =
      input.action === 'extend_trial'
        ? { kind: 'workspace.extend_trial', payload: { workspaceId: r.workspaceId, input: { days: input.days!, reason } }, rule: `ขยายทดลองรวมเกิน ${L.trialDays} วัน หรือเกิน ${L.trialTimes} ครั้ง (${r.reason})` }
        : input.action === 'discount'
          ? { kind: 'workspace.discount', payload: { workspaceId: r.workspaceId, input: { percent: input.percent!, months: input.months, reason } }, rule: `ส่วนลดเกิน ${L.discountPct}% หรือเกิน ${L.discountCycles} รอบ` }
          : { kind: 'workspace.coupon', payload: { workspaceId: r.workspaceId, couponId: input.couponId!, reason }, rule: `คูปองให้ส่วนลดเกิน ${L.discountPct}% หรือเกิน ${L.discountCycles} รอบ` };
    const pending = await this.approvals.gate(staff, { ...g, workspaceId: r.workspaceId, target: { type: 'workspace', id: r.workspaceId }, reason, exceeds: true });
    return pending!;
  }

  private async run(staff: Staff, input: Body, workspaceId: string, reason: string) {
    if (input.action === 'extend_trial') {
      const r = await this.workspaces.applyExtendTrial(staff, workspaceId, { days: input.days!, reason });
      return `ทดลองถึง ${thaiDate(r.trialEndsAt)}`;
    }
    if (input.action === 'discount') {
      await this.workspaces.applyDiscount(staff, workspaceId, { percent: input.percent!, months: input.months, reason });
      return `ส่วนลด ${input.percent}%${input.months ? ` ${input.months} รอบ` : ''}`;
    }
    const r = await this.applyCoupon(staff, workspaceId, input.couponId!, reason);
    return `คูปอง ${r.code}`;
  }

  /** ให้คูปองจริง: บันทึก coupon_redemptions (active) ให้ใบแจ้งหนี้ถัดไปได้ส่วนลด · ตรวจกติกาคูปองซ้ำตอนทำ (สิทธิ์อาจหมดระหว่างรออนุมัติ) */
  async applyCoupon(staff: Staff, workspaceId: string, couponId: string, reason: string, ctx?: ApprovalContext) {
    const c = await this.coupon(couponId);
    const [w] = await this.db
      .select({ plan: s.plans.code, hasSub: s.subscriptions.id })
      .from(s.workspaces)
      .leftJoin(s.subscriptions, eq(s.subscriptions.workspaceId, s.workspaces.id))
      .leftJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(and(eq(s.workspaces.id, workspaceId), isNull(s.workspaces.deletedAt)));
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const check = await couponGrantBlockers(this.db, c, [{ workspaceId, plan: w.hasSub ? w.plan : null }], todayBkk());
    const block = check.global ?? check.perWorkspace.get(workspaceId) ?? (check.remaining === 0 ? { code: 'coupon_exhausted', message: 'สิทธิ์ของคูปองไม่พอ' } : null);
    if (block) throw new AppError(409, block.code, block.message);
    await this.db.transaction(async (tx) => {
      const redemptionId = await grantCoupon(tx, c, workspaceId);
      const cycles = cyclesOf(c);
      const what = c.kind === 'percent' ? `ลด ${c.value}%` : c.kind === 'amount' ? `ลด ฿${(c.value / 100).toLocaleString('en-US')}` : `ใช้ฟรี ${c.value} เดือน`;
      await audit(tx, staff, workspaceId, 'plan', 'ops.coupon_granted', `ให้คูปอง ${c.code} (${what}${cycles === null ? ' ตลอดไป' : ` ${cycles} รอบ`}) ใช้กับใบแจ้งหนี้ถัดไป · ${reason}`, { type: 'coupon_redemption', id: redemptionId }, ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);
    });
    return { code: c.code };
  }

  private async notifyOwners(workspaceId: string, name: string, input: Body, detail: string) {
    const owners = await this.db
      .select({ email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')));
    const subject = input.action === 'extend_trial' ? `ขยายช่วงทดลองใช้ ${name} แล้ว` : `${name} ได้รับส่วนลด`;
    for (const o of owners) {
      try {
        await this.mail.send({ to: o.email, subject, text: `ทีม Friday ${input.action === 'extend_trial' ? `ขยายช่วงทดลองใช้ของ ${name} (${detail})` : `ให้${detail} กับ ${name} ใช้กับใบแจ้งหนี้ถัดไป`}\nเหตุผล: ${input.reason}\n\nFriday Work Management` });
      } catch {
        /* บันทึกใน mail log แล้ว · ไม่ทำให้รายการล้ม */
      }
    }
  }
}

