import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { bkkDate, type Db, schema as s } from '@friday/db';
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { webUrl } from '../../auth/auth.config.js';
import { Mailer } from '../../core/mail.js';
import { SYSTEM_DB } from '../../db/db.module.js';
import { Jobs } from '../../queue/jobs.js';
import { PaymentsService } from '../payments.service.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../providers.js';
import { CARD_ATTEMPT_DAYS, cardAttemptDue, daysBetween, nextAttemptOn, QR_TTL_MS } from './card-retry.js';
import { markQrExpired } from './qr-expiry.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const baht = (satang: number) => `${(satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
const PAID_PLANS = ['team_s', 'team_m', 'team_l'];

type Result = { invoices: number; attempts: number; pending: number; failed: number; actionRequired: number; exhausted: number; errors: number };

/**
 * งานเบื้องหลังของผู้ให้บริการรับชำระ (A35b)
 * - `payments.card-renewal` ทุกวัน 07:00: ใบต่ออายุของลูกค้าบัตร (ออกใบด้วย checkout เดิม) แล้วตัดบัตรที่เก็บไว้ · ล้มแล้วลองใหม่วันที่ 1, 3, 5
 * - `payments.qr-expire` ทุก 5 นาที: QR PromptPay ที่ครบ 15 นาทีปิดที่ผู้ให้บริการ (สแกนจ่ายไม่ได้แล้ว) ลูกค้ากดสร้าง QR ใหม่ในใบเดิม
 * ผลการตัดเงินยืนยันด้วย Webhook เสมอ (ไม่ปิดใบจากผลของคำขอ) · Webhook หลุดจะถูกจับโดยงานกระทบยอด 06:00
 */
@Injectable()
export class GatewayJobs implements OnModuleInit {
  private readonly log = new Logger('PaymentGateway');

  constructor(
    @Inject(SYSTEM_DB) private readonly sys: Db,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly jobs: Jobs,
    private readonly mailer: Mailer,
  ) {}

  async onModuleInit() {
    this.jobs.define('payments.card-renewal', () => this.renewCards());
    await this.jobs.every('payments.card-renewal', '0 7 * * *');
    this.jobs.define('payments.qr-expire', () => this.expireQrs());
    await this.jobs.every('payments.qr-expire', '*/5 * * * *');
  }

  // ---------------------------------------------------------------------------
  // QR หมดอายุ
  // ---------------------------------------------------------------------------

  async expireQrs(now = new Date()) {
    const rows = await this.sys
      .select({ id: s.payments.id, workspaceId: s.payments.workspaceId, invoiceId: s.payments.invoiceId, providerRef: s.payments.providerRef })
      .from(s.payments)
      .innerJoin(s.invoices, eq(s.invoices.id, s.payments.invoiceId))
      .where(and(eq(s.payments.method, 'promptpay'), eq(s.payments.status, 'pending_review'), isNull(s.payments.exceptionReason), isNotNull(s.payments.providerRef), eq(s.invoices.status, 'open'), lt(s.payments.updatedAt, new Date(now.getTime() - QR_TTL_MS))))
      .limit(100);
    let expired = 0;
    for (const p of rows) {
      try {
        // ผู้ให้บริการตอบว่าชำระแล้ว = รอ Webhook / กระทบยอด ไม่ปิดฝั่งเรา
        if ((await this.gateway.closeExpiredQr(p.providerRef!, now)) === 'expired' && (await markQrExpired(this.sys, p))) expired++;
      } catch (e) {
        this.log.error(`ปิด QR ${p.providerRef} ไม่สำเร็จ: ${(e as Error).message}`);
      }
    }
    return { checked: rows.length, expired };
  }

  // ---------------------------------------------------------------------------
  // ตัดบัตรตามรอบ
  // ---------------------------------------------------------------------------

  /**
   * Workspace ที่จ่ายด้วยบัตร รอบบิลจบแล้ว และมีบัตรเก็บไว้ (`stripe_customer_id`)
   * ข้าม: ยกเลิกแพ็กเกจแล้ว (status ไม่ใช่ active) · มีการลดแพ็กเกจที่ตั้งไว้ (รอให้งานของ ops-api เปลี่ยนแพ็กเกจก่อน แล้วรอบถัดไปตัดตามแพ็กเกจใหม่)
   */
  async renewCards(now = new Date()) {
    const due = await this.sys
      .select({ sub: s.subscriptions, plan: s.plans.code, slug: s.workspaces.slug })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.subscriptions.workspaceId))
      .where(and(eq(s.subscriptions.status, 'active'), eq(s.subscriptions.paymentMethod, 'card'), isNotNull(s.subscriptions.stripeCustomerId), lte(s.subscriptions.currentPeriodEnd, now), isNull(s.subscriptions.pendingPlanId), isNull(s.workspaces.deletedAt), inArray(s.plans.code, PAID_PLANS)));
    const result: Result = { invoices: 0, attempts: 0, pending: 0, failed: 0, actionRequired: 0, exhausted: 0, errors: 0 };
    for (const row of due) {
      try {
        await this.renewOne(row, now, result);
      } catch (e) {
        result.errors++;
        this.log.error(`ต่ออายุบัตรของ Workspace ${row.sub.workspaceId} ไม่สำเร็จ: ${(e as Error).message}`);
      }
    }
    if (result.attempts || result.errors) this.log.log(`ตัดบัตรตามรอบ: ออกใบ ${result.invoices} · ตัด ${result.attempts} · รอยืนยัน ${result.pending} · ไม่ผ่าน ${result.failed} · ต้องยืนยันตัวตน ${result.actionRequired} · ครบทุกครั้ง ${result.exhausted}`);
    return result;
  }

  private async renewOne(row: { sub: typeof s.subscriptions.$inferSelect; plan: string; slug: string }, now: Date, result: Result) {
    const { sub } = row;
    // 1 รอบ = 1 ใบ: key ผูกกับวันจบรอบ ส่งซ้ำ (งานรันซ้ำ / วันลองใหม่) ได้ใบเดิม
    const rawKey = `renew:${sub.id}:${bkkDate(sub.currentPeriodEnd!)}`;
    const invoiceId = await this.renewalInvoice(row, rawKey, result);
    if (!invoiceId) return;
    const [invoice] = await this.sys.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    // ชำระแล้ว (Webhook มาแล้ว / เครดิตพอทั้งใบ) หรือทีมยกเลิกใบ
    if (!invoice || invoice.status !== 'open') return;
    const [payment] = await this.sys.select().from(s.payments).where(and(eq(s.payments.invoiceId, invoice.id), eq(s.payments.method, 'card'))).orderBy(desc(s.payments.createdAt)).limit(1);
    if (!payment?.providerRef || payment.status === 'confirmed' || payment.exceptionReason) return;

    const day = daysBetween(invoice.periodStart, bkkDate(now));
    const attempt = await this.sys.transaction(async (tx) => {
      // งานซ้อนกัน (หลาย worker / กดรันเอง) ต้องไม่ตัดครั้งเดียวกันซ้ำ
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'card-charge:' + invoice.id}, 0))`);
      const logs = await tx.select({ action: s.auditLogs.action }).from(s.auditLogs).where(and(eq(s.auditLogs.targetId, invoice.id), inArray(s.auditLogs.action, ['billing.card_charge_attempt', 'billing.card_action_required', 'billing.card_renewal_failed'])));
      // ธนาคารขอ 3-D Secure หรือครบทุกครั้งแล้ว: หยุดตัดเอง รอลูกค้าจ่ายจากลิงก์ / ทีมการเงินตาม
      if (logs.some((l) => l.action !== 'billing.card_charge_attempt')) return null;
      const next = cardAttemptDue(logs.length, day);
      if (!next?.due) return null;
      await tx.insert(s.auditLogs).values({ workspaceId: invoice.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.card_charge_attempt', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · ตัดบัตรครั้งที่ ${next.attempt}/${CARD_ATTEMPT_DAYS.length} (วันที่ ${day} ของรอบ) · ${baht(invoice.amountDue)}` });
      return next;
    });
    if (!attempt) return;
    result.attempts++;

    const r = await this.gateway.chargeSaved({ providerRef: payment.providerRef, customerRef: sub.stripeCustomerId!, idempotencyKey: sha(`${rawKey}:charge:${attempt.attempt}`) });
    const link = `${webUrl()}/work/${row.slug}/billing/invoices/${invoice.id}`;
    const audit = (action: string, summary: string) => this.sys.insert(s.auditLogs).values({ workspaceId: invoice.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action, targetType: 'invoice', targetId: invoice.id, summary });

    if (r.status === 'succeeded' || r.status === 'processing') {
      result.pending++;
      return;
    }
    if (r.status === 'requires_action') {
      result.actionRequired++;
      await audit('billing.card_action_required', `${invoice.number} · ธนาคารขอยืนยันตัวตน (3-D Secure) · ส่งลิงก์ชำระให้ลูกค้า`);
      await this.notify(invoice.workspaceId, `ยืนยันการชำระ ${invoice.number} · Friday Work Management`, `ธนาคารผู้ออกบัตรขอให้ยืนยันตัวตน (3-D Secure) ก่อนตัดค่าบริการรอบใหม่ ${baht(invoice.amountDue)}\nยืนยันหรือเปลี่ยนบัตรได้ที่ ${link}`);
      return;
    }
    result.failed++;
    const nextOn = attempt.final ? null : nextAttemptOn(invoice.periodStart, attempt.attempt);
    await audit('billing.card_charge_failed', `${invoice.number} · ครั้งที่ ${attempt.attempt} ไม่ผ่าน (${r.code ?? 'declined'})${nextOn ? ` · ลองใหม่ ${nextOn}` : ''}`);
    if (nextOn) {
      await this.notify(invoice.workspaceId, `ตัดบัตรไม่ผ่าน ${invoice.number} · Friday Work Management`, `ตัดค่าบริการรอบใหม่ ${baht(invoice.amountDue)} ไม่ผ่าน ระบบจะลองอีกครั้งวันที่ ${nextOn}\nเปลี่ยนบัตรหรือชำระด้วย PromptPay ได้ที่ ${link}`);
      return;
    }
    result.exhausted++;
    // ครบ 4 ครั้ง (วันที่ 0, 1, 3, 5): ทีมการเงินเห็นใน Audit และส่งลิงก์ชำระซ้ำได้จาก Friday Ops
    await audit('billing.card_renewal_failed', `${invoice.number} · ตัดบัตรไม่ผ่านครบ ${CARD_ATTEMPT_DAYS.length} ครั้ง · ส่งลิงก์ชำระให้ลูกค้าแล้ว`);
    await this.notify(invoice.workspaceId, `ชำระค่าบริการ ${invoice.number} · Friday Work Management`, `ตัดบัตรค่าบริการรอบใหม่ ${baht(invoice.amountDue)} ไม่ผ่านครบ ${CARD_ATTEMPT_DAYS.length} ครั้ง\nกรุณาชำระด้วยบัตรใบใหม่หรือ PromptPay ที่ ${link}`);
  }

  /**
   * ใบต่ออายุของรอบนี้ · ครั้งแรกออกด้วย `PaymentsService.checkout` (ราคา คูปองที่ได้ต่อ เครดิต VAT และ Idempotency เหมือนลูกค้ากดเอง)
   * ในนามของ Owner เพราะ checkout ทำงานภายใต้ RLS ของ Workspace · บันทึก `billing.card_renewal_invoice` ว่าระบบเป็นผู้ออก
   */
  private async renewalInvoice(row: { sub: typeof s.subscriptions.$inferSelect; plan: string; slug: string }, rawKey: string, result: Result) {
    const { sub } = row;
    const [seen] = await this.sys.select({ id: s.auditLogs.targetId }).from(s.auditLogs).where(and(eq(s.auditLogs.workspaceId, sub.workspaceId), eq(s.auditLogs.action, 'billing.card_renewal_invoice'), eq(s.auditLogs.summary, JSON.stringify({ renewal: rawKey }))));
    if (seen?.id) return seen.id;
    const [owner] = await this.sys.select({ userId: s.workspaceMembers.userId }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, sub.workspaceId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active'))).limit(1);
    if (!owner) {
      this.log.warn(`ต่ออายุบัตรไม่ได้: Workspace ${sub.workspaceId} ไม่มี Owner`);
      return null;
    }
    const out = await this.payments.checkout({ userId: owner.userId, sessionId: 'system:card-renewal' }, { workspaceId: sub.workspaceId, slug: row.slug, role: 'owner' }, { plan: row.plan as 'team_s' | 'team_m' | 'team_l', cycle: sub.cycle, method: 'card', wht: false }, rawKey);
    await this.sys.insert(s.auditLogs).values({ workspaceId: sub.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.card_renewal_invoice', targetType: 'invoice', targetId: out.invoice.id, summary: JSON.stringify({ renewal: rawKey }) });
    result.invoices++;
    return out.invoice.id;
  }

  /** อีเมลผู้รับเอกสารภาษีของ Workspace · ส่งไม่สำเร็จไม่ทำให้งานล้ม */
  private async notify(workspaceId: string, subject: string, text: string) {
    const [profile] = await this.sys.select({ email: s.billingProfiles.taxEmail }).from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, workspaceId));
    if (!profile?.email) return;
    await this.mailer.send({ to: profile.email, subject, text }).catch((e) => this.log.error(`ส่งอีเมลแจ้งการตัดบัตรไม่สำเร็จ: ${(e as Error).message}`));
  }
}
