import { createHash } from 'node:crypto';
import { AnalyticsService, classifyChange } from '../analytics/analytics.service.js';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { bkkDate, type BuyerSnapshot, canGrant, cancelETax, commitCouponUses, type Db, issueReceipt, nextDocNumber, queueETax, resumeIfPaid, schema, type Tx } from '@friday/db';
import { bankFromEnv } from '@friday/docs';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { BillingService } from '../billing/billing.service.js';
import { Mailer } from '../core/mail.js';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { config } from '../config.js';
import { Jobs } from '../queue/jobs.js';
import { CouponCode, recordDiscount } from './coupons.js';
import { ETAX_PROVIDER, type ETaxCancelInput, type ETaxInput, type ETaxProvider, etaxErrorText, PAYMENT_GATEWAY, type PaymentGateway, verifyETaxSignature } from './providers.js';

const s = schema;
const DAY = 86_400_000;
/** คิว e-Tax: ลอง 3 ครั้ง ห่าง 10 นาที · ส่งแล้วรอผลเกิน 1 ชม. ถามผู้ให้บริการเอง (หน้าจอ E1) */
export const ETAX_MAX_ATTEMPTS = 3;
const ETAX_RETRY_MS = 10 * 60_000;
const ETAX_CHECK_AFTER_MS = 60 * 60_000;

export const CheckoutBody = z
  .object({
    plan: z.enum(['team_s', 'team_m', 'team_l']),
    cycle: z.enum(['monthly', 'yearly']).default('monthly'),
    method: z.enum(['card', 'promptpay', 'transfer']),
    /** หัก ณ ที่จ่าย 3% · PromptPay / โอนเท่านั้น */
    wht: z.boolean().default(false),
    poNumber: z.string().trim().max(50).optional(),
    /** โค้ดส่วนลด (O20) */
    coupon: CouponCode.optional(),
  })
  .strict();
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, 'Idempotency-Key ต้องยาว 8–128 ตัวอักษร (ตัวอักษร ตัวเลข _ . : -)');

type Method = 'card' | 'promptpay' | 'transfer';
export interface CheckoutMeta {
  plan: string;
  cycle: 'monthly' | 'yearly';
  method: Method;
  wht: boolean;
  /** แฮชของ (Workspace + Idempotency-Key) / ของ payload ที่ขอ */
  key: string;
  payload: string;
  /** เวอร์ชันราคาที่ใช้คิดใบนี้ (O20) · เปิดแพ็กเกจแล้วลูกค้าผูกกับราคานี้ (grandfathering) · ไม่มี = ใบก่อนมีเวอร์ชัน */
  priceVersionId?: string | null;
  /** โค้ดส่วนลดที่ใส่ตอน checkout */
  coupon?: string | null;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
/** บัญชีรับโอน (env) · ที่เดียวกับที่พิมพ์ในใบแจ้งหนี้ PDF */
export const bankInfo = bankFromEnv;
export const PayBody = z.object({ renew: z.boolean().default(false) }).strict();

type Invoice = typeof s.invoices.$inferSelect;
type Payment = typeof s.payments.$inferSelect;

export const invoiceDto = (i: Invoice) => ({ id: i.id, number: i.number, periodStart: i.periodStart, periodEnd: i.periodEnd, subtotal: i.subtotal, discount: i.discount, vat: i.vat, total: i.total, whtAmount: i.whtAmount, amountDue: i.amountDue, poNumber: i.poNumber, status: i.status, dueDate: i.dueDate, paidAt: i.paidAt, createdAt: i.createdAt });

/** ชำระเงิน (R2): checkout, ยืนยันผลจาก Stripe, ออกเอกสารภาษี */
@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly log = new Logger('Payments');

  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly billing: BillingService,
    private readonly limits: PlanLimits,
    @Inject(PAYMENT_GATEWAY) readonly gateway: PaymentGateway,
    @Inject(ETAX_PROVIDER) readonly etax: ETaxProvider,
    private readonly jobs: Jobs,
    private readonly mailer: Mailer,
    private readonly analytics: AnalyticsService,
  ) {}

  async onModuleInit() {
    this.jobs.define('payments.etax', (d: { taxDocumentId: string }) => this.submitETax(d.taxDocumentId));
    // ใบกำกับภาษีที่หลังบ้าน (ops-api) สร้างตอนยืนยันสลิปโอน อยู่ในสถานะ pending โดยไม่มีใครส่งงานให้ → กวาดส่งทุก 10 นาที
    this.jobs.define('payments.etax-sweep', () => this.sweepETax());
    await this.jobs.every('payments.etax-sweep', '*/10 * * * *');
    // กระทบยอดกับผู้ให้บริการทุกเช้า 06:00 จับ Webhook ที่หลุด (A35a)
    this.jobs.define('payments.reconcile', () => this.reconcile(new Date(Date.now() - 3 * DAY)));
    await this.jobs.every('payments.reconcile', '0 6 * * *');
  }

  /**
   * กระทบยอด: รายการที่ผู้ให้บริการรับเงินแล้วแต่ระบบยังไม่ยืนยัน → ยืนยันเหมือนได้ Webhook
   * ยอดไม่ตรง → เข้าคิวกรณีผิดปกติ · ใบแจ้งหนี้ชำระด้วยรายการอื่นไปแล้ว → จ่ายซ้ำ · ไม่รู้จักเลขอ้างอิง → คืนในผลให้ทีม Friday ตรวจ
   */
  async reconcile(since: Date) {
    const result = { checked: 0, settled: 0, exceptions: 0, unmatched: [] as { providerRef: string; invoiceId: string | null; amount: number }[] };
    for (const p of await this.gateway.listSettled(since)) {
      result.checked++;
      const [payment] = await this.sys.select().from(s.payments).where(and(inArray(s.payments.method, ['card', 'promptpay']), eq(s.payments.providerRef, p.providerRef)));
      if (!payment) {
        result.unmatched.push({ providerRef: p.providerRef, invoiceId: p.invoiceId, amount: p.amount });
        continue;
      }
      if (payment.status === 'confirmed' || payment.exceptionReason) continue;
      if (p.amount !== payment.amount) {
        await this.flag(payment, 'amount_mismatch', `ผู้ให้บริการรับ ${p.amount / 100} บาท · ใบแจ้งหนี้ ${payment.amount / 100} บาท`);
        result.exceptions++;
        continue;
      }
      const outcome = await this.succeed(payment);
      if (outcome === 'settled') result.settled++;
      else result.exceptions++;
    }
    if (result.settled || result.exceptions || result.unmatched.length) this.log.warn(`กระทบยอด: ยืนยันเพิ่ม ${result.settled} · ผิดปกติ ${result.exceptions} · ไม่รู้จัก ${result.unmatched.length}`);
    return result;
  }

  /** รับเงินสำเร็จ: ใบแจ้งหนี้ชำระด้วยรายการอื่นไปแล้ว = จ่ายซ้ำ (ไม่เปิดสิทธิ์ซ้ำ รอทีมตัดสินว่าเก็บเป็นเครดิตหรือคืน) */
  private async succeed(payment: Payment): Promise<'settled' | 'double_payment'> {
    const [invoice] = await this.sys.select({ status: s.invoices.status }).from(s.invoices).where(eq(s.invoices.id, payment.invoiceId));
    if (invoice?.status === 'paid') {
      await this.flag(payment, 'double_payment', 'ใบแจ้งหนี้นี้ชำระด้วยรายการอื่นแล้ว');
      return 'double_payment';
    }
    await this.settle(payment);
    return 'settled';
  }

  /** ส่งเข้าคิวกรณีผิดปกติของ Friday Ops (O03) */
  async flag(payment: Payment, reason: 'amount_mismatch' | 'double_payment' | 'duplicate_slip' | 'wht_not_declared' | 'unmatched', note: string) {
    await this.sys.transaction(async (tx) => {
      await tx.update(s.payments).set({ status: 'pending_review', exceptionReason: reason, updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
      await tx.insert(s.auditLogs).values({ workspaceId: payment.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.payment_exception', targetType: 'invoice', targetId: payment.invoiceId, summary: `${reason} · ${note}` });
    });
  }

  /**
   * งานกวาด e-Tax ทุก 10 นาที (คิวเดียว `etax_jobs`: ส่ง TX / CN / DN และแจ้งยกเลิก)
   * ① เอกสารเก่าที่ยังไม่มีงานในคิว (สร้างก่อนมีคิว / ops-api รุ่นก่อน) เข้าคิว · รอ 1 นาทีให้ผู้สร้างส่งเอง
   * ② งานที่ถึงเวลา: ส่ง / ลองใหม่ (3 ครั้ง ห่าง 10 นาที) · ③ งานที่รอผลและทีมกด "ตรวจสถานะ" หรือครบ 1 ชม. → ถามผู้ให้บริการ
   */
  async sweepETax() {
    await this.sys.execute(sql`
      insert into etax_jobs (workspace_id, doc_kind, doc_id, action, status, next_attempt_at)
      select d.workspace_id, 'tax_document', d.id, 'issue', 'pending', now() from tax_documents d
      where d.status = 'pending' and d.doc_type <> 'receipt' and d.created_at < now() - interval '1 minute'
      on conflict do nothing`);
    const due = await this.sys
      .select({ id: s.etaxJobs.id, status: s.etaxJobs.status })
      .from(s.etaxJobs)
      .where(sql`(${s.etaxJobs.status} = 'pending' and ${s.etaxJobs.attempts} < ${ETAX_MAX_ATTEMPTS} and coalesce(${s.etaxJobs.nextAttemptAt}, now()) <= now())
        or (${s.etaxJobs.status} = 'submitted' and ${s.etaxJobs.nextAttemptAt} <= now())`)
      .orderBy(s.etaxJobs.createdAt)
      .limit(50);
    const result = { submitted: 0, checked: 0, errors: 0 };
    for (const j of due) {
      const r = j.status === 'submitted' ? await this.checkETaxJob(j.id) : await this.runETaxJob(j.id);
      if (r === 'submitted') result.submitted++;
      else if (r === 'checked') result.checked++;
      else if (r === 'error') result.errors++;
    }
    return result;
  }

  private requireBilling(tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.billing');
  }

  // ---------------------------------------------------------------------------
  // POST w/billing/checkout
  // ---------------------------------------------------------------------------

  async checkout(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CheckoutBody>, rawKey: string | undefined) {
    this.requireBilling(tenant);
    const parsedKey = IdempotencyKey.safeParse(rawKey ?? '');
    if (!parsedKey.success) throw new AppError(400, 'idempotency_key_required', 'ต้องส่งหัว Idempotency-Key (8–128 ตัวอักษร) เพื่อกันตัดเงินซ้ำ');
    if (input.wht && input.method === 'card') throw new AppError(422, 'wht_not_allowed_for_card', 'หัก ณ ที่จ่ายเลือกได้เฉพาะ PromptPay หรือโอนเงิน');
    const key = sha(`${tenant.workspaceId}:${parsedKey.data}`);
    const payload = sha(JSON.stringify([input.plan, input.cycle, input.method, input.wht, input.poNumber ?? null, ...(input.coupon ? [input.coupon] : [])]));

    const out = await this.db.run(auth, tenant, async (tx) => {
      // คำขอซ้ำที่มาพร้อมกันต้องต่อคิว ไม่ให้สร้างสองใบ
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'checkout:' + tenant.workspaceId}, 0))`);
      const [seen] = await tx
        .select({ targetId: s.auditLogs.targetId, summary: s.auditLogs.summary })
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.action, 'billing.checkout'), sql`(${s.auditLogs.summary})::jsonb ->> 'key' = ${key}`));
      if (seen) {
        const meta = JSON.parse(seen.summary!) as CheckoutMeta;
        if (meta.payload !== payload) throw new AppError(422, 'idempotency_key_reuse', 'Idempotency-Key นี้ถูกใช้กับคำขอที่ต่างกัน');
        return { invoiceId: seen.targetId!, replayed: true };
      }

      const [profile] = await tx.select().from(s.billingProfiles);
      if (!profile) throw new AppError(422, 'billing_profile_required', 'กรอกข้อมูลออกใบกำกับภาษีก่อน (PUT billing/profile)');
      // คูปองที่จำกัดจำนวนสิทธิ์: หลาย Workspace ใช้โค้ดเดียวกันพร้อมกันต้องต่อคิว ไม่ให้เกินสิทธิ์ (O20)
      if (input.coupon) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'coupon:' + input.coupon}, 0))`);
      const { internal, ...quote } = await this.billing.price(auth, tenant, { plan: input.plan, cycle: input.cycle, wht: input.wht, coupon: input.coupon }, tx);
      const [subRow] = await tx.select({ id: s.subscriptions.id }).from(s.subscriptions);

      // เลขใบแจ้งหนี้ออกต่อเนื่องทั้งระบบ (ใบกำกับภาษีต้องเรียงเลข) จึงล็อกระดับระบบ แล้วนับด้วย SYSTEM_DB ซึ่งเห็นทุก Workspace
      const start = today();
      const number = await nextDocNumber(tx, 'invoice', start, this.sys);
      // คูปองใช้ฟรี N เดือน: ใบนี้ครอบคลุม N เดือน แล้วรอบถัดไปจ่ายราคาปกติตามรอบที่เลือก
      const months = quote.freeMonths ?? (input.cycle === 'yearly' ? 12 : 1);
      // ไม่มียอดชำระ (ฟรี / ส่วนลด 100%): ไม่ส่งไปผู้ให้บริการรับชำระ ปิดใบทันทีหลัง commit
      const free = quote.amountDue === 0;

      const [invoice] = await tx
        .insert(s.invoices)
        .values({
          workspaceId: tenant.workspaceId,
          subscriptionId: subRow.id,
          number,
          periodStart: start,
          periodEnd: addDays(addMonths(start, months), -1),
          subtotal: quote.subtotal,
          discount: quote.discount,
          vat: quote.vat,
          total: quote.total,
          whtAmount: quote.whtAmount,
          amountDue: quote.amountDue,
          poNumber: input.poNumber ?? null,
          dueDate: input.method === 'transfer' && !free ? addDays(start, 7) : start,
        })
        .returning();
      await recordDiscount(tx, { workspaceId: tenant.workspaceId, userId: auth.userId, invoiceId: invoice.id, apply: internal.apply });

      if (!free) {
        const gwReq = { amount: invoice.amountDue, invoiceId: invoice.id, invoiceNumber: invoice.number, email: profile.taxEmail, idempotencyKey: key };
        const gw = input.method === 'card' ? await this.gateway.createCard(gwReq) : input.method === 'promptpay' ? await this.gateway.createPromptPay(gwReq) : null;
        await tx.insert(s.payments).values({ workspaceId: tenant.workspaceId, invoiceId: invoice.id, method: input.method, amount: invoice.amountDue, providerRef: gw?.providerRef ?? null });
      }

      const meta: CheckoutMeta = { plan: input.plan, cycle: input.cycle, method: input.method, wht: input.wht, key, payload, priceVersionId: internal.priceVersionId, coupon: quote.coupon };
      const log = { workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user' as const, category: 'plan' as const, targetType: 'invoice', targetId: invoice.id };
      const off = quote.discount ? ` · ส่วนลด ${quote.discounts.map((d) => d.code).join(', ')} ${quote.discount / 100} บาท` : '';
      await tx.insert(s.auditLogs).values([
        { ...log, action: 'billing.checkout', summary: JSON.stringify(meta) },
        { ...log, action: 'billing.invoice_created', summary: `${invoice.number} · ${quote.planName} ${input.cycle === 'yearly' ? 'รายปี' : 'รายเดือน'} · ${input.method} · ${invoice.amountDue / 100} บาท${off}` },
      ]);
      return { invoiceId: invoice.id, replayed: false };
    });
    // ใบที่ไม่มียอดชำระปิดเองทันที · ส่งซ้ำแล้วใบยังเปิดอยู่ (ปิดครั้งก่อนไม่สำเร็จ) ก็ปิดให้
    await this.settleFree(out.invoiceId);
    return this.db.run(auth, tenant, async (tx) => ({ ...(await this.respond(tx, out.invoiceId, key)), replayed: out.replayed }));
  }

  /**
   * POST w/billing/invoices/:id/pay · หน้าชำระใบแจ้งหนี้ (W22b) ขอ client secret ของบัตร หรือ QR PromptPay ของใบเดิม
   * ใช้ key เดิมของ checkout → ผู้ให้บริการคืนรายการชำระเดิม (บัตรที่ไม่ผ่านยืนยันซ้ำได้) · `renew` = QR หมดอายุ สร้างรายการใหม่ในใบเดิม
   */
  async pay(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof PayBody>) {
    this.requireBilling(tenant);
    const { invoice, payment } = await this.db.run(auth, tenant, async (tx) => {
      if (!z.uuid().safeParse(id).success) throw notFound('ใบแจ้งหนี้');
      const [invoice] = await tx.select().from(s.invoices).where(eq(s.invoices.id, id));
      if (!invoice) throw notFound('ใบแจ้งหนี้');
      const [payment] = await tx.select().from(s.payments).where(eq(s.payments.invoiceId, id)).orderBy(desc(s.payments.createdAt)).limit(1);
      return { invoice, payment };
    });
    if (invoice.status !== 'open') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ไม่ได้รอชำระแล้ว', { status: invoice.status });
    if (!payment || payment.method === 'transfer') throw new AppError(409, 'pay_not_applicable', 'ใบนี้ชำระด้วยการโอน · แนบสลิปที่หน้าเดียวกัน');
    if (input.renew && payment.method !== 'promptpay') throw new AppError(409, 'renew_not_applicable', 'สร้างรายการใหม่ได้เฉพาะ QR PromptPay');
    const meta = await this.meta(invoice.id);
    // key ของรายการชำระปัจจุบัน: สร้าง QR ใหม่ครั้งล่าสุด หรือ key ของ checkout
    const [renewed] = await this.sys.select({ summary: s.auditLogs.summary }).from(s.auditLogs).where(and(eq(s.auditLogs.action, 'billing.qr_renewed'), eq(s.auditLogs.targetId, invoice.id))).orderBy(desc(s.auditLogs.createdAt)).limit(1);
    let key = renewed?.summary ? (JSON.parse(renewed.summary) as { key: string }).key : meta.key;
    if (input.renew) {
      // ผูกกับเลขอ้างอิงเดิม: กดซ้ำระหว่างรอได้ QR ชุดเดียวกัน ไม่สร้างรายการซ้อน
      key = sha(`${key}:renew:${payment.providerRef}`);
      const [profile] = await this.sys.select({ email: s.billingProfiles.taxEmail }).from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, invoice.workspaceId));
      const gw = await this.gateway.createPromptPay({ amount: invoice.amountDue, invoiceId: invoice.id, invoiceNumber: invoice.number, email: profile?.email ?? null, idempotencyKey: key });
      if (gw.providerRef !== payment.providerRef) {
        await this.sys.transaction(async (tx) => {
          await tx.update(s.payments).set({ providerRef: gw.providerRef, status: 'pending_review', updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
          await tx.insert(s.auditLogs).values({ workspaceId: invoice.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'billing.qr_renewed', targetType: 'invoice', targetId: invoice.id, summary: JSON.stringify({ key, providerRef: gw.providerRef, previous: payment.providerRef }) });
        });
      }
    }
    return this.db.run(auth, tenant, (tx) => this.respond(tx, invoice.id, key));
  }

  /**
   * ใบแจ้งหนี้ยอด 0 (คูปองใช้ฟรี N เดือน / ส่วนลด 100%): ชำระแล้วโดยไม่ผ่านผู้ให้บริการ → เปิดแพ็กเกจ + นับรอบคูปอง
   * ไม่ออกใบกำกับภาษี / ใบเสร็จ เพราะไม่มีการรับเงิน · เขียนด้วย SYSTEM_DB (invoices / subscriptions แก้ผ่านแอปไม่ได้) · เรียกซ้ำได้
   */
  private async settleFree(invoiceId: string) {
    await this.sys.transaction(async (tx) => {
      const [invoice] = await tx.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).for('update');
      if (!invoice || invoice.status !== 'open' || invoice.amountDue !== 0) return;
      const [hasPayment] = await tx.select({ id: s.payments.id }).from(s.payments).where(eq(s.payments.invoiceId, invoiceId)).limit(1);
      if (hasPayment) return;
      const meta = await this.meta(invoice.id);
      await tx.update(s.invoices).set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() }).where(eq(s.invoices.id, invoice.id));
      const [prev] = await tx.select({ status: s.subscriptions.status, cycle: s.subscriptions.cycle, plan: s.plans.code }).from(s.subscriptions).leftJoin(s.plans, eq(s.plans.id, s.subscriptions.planId)).where(eq(s.subscriptions.id, invoice.subscriptionId));
      const granted = await this.activate(tx, invoice, meta);
      await commitCouponUses(tx, invoice.id);
      const kind = granted ? classifyChange({ plan: prev?.plan ?? null, status: prev?.status ?? null, cycle: prev?.cycle ?? null }, { plan: meta.plan, cycle: meta.cycle }) : null;
      if (kind) await this.analytics.subscriptionChanged(tx, { workspaceId: invoice.workspaceId, kind, planFrom: prev?.plan ?? null, planTo: meta.plan, mrrAfterSatang: 0, actorKind: 'system', actorId: null });
      await tx.insert(s.auditLogs).values({ workspaceId: invoice.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.payment_confirmed', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · ไม่มียอดชำระ (คูปอง ${meta.coupon ?? '-'}) · ${granted ? `เปิดแพ็กเกจ ${meta.plan}` : 'ไม่เปลี่ยนแพ็กเกจ (มีใบที่ใหม่กว่าเปิดสิทธิ์อยู่)'}` });
    });
  }

  /** ผลของ checkout (ใช้ทั้งครั้งแรกและตอนส่งซ้ำ) · บัตร / PromptPay ถามผู้ให้บริการอีกครั้งด้วย key เดิม ได้ intent เดิม */
  private async respond(tx: Tx, invoiceId: string, key: string) {
    const [invoice] = await tx.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    const [payment] = await tx.select().from(s.payments).where(eq(s.payments.invoiceId, invoiceId));
    // ไม่มียอดชำระ (คูปอง): ไม่มีรายการชำระและไม่ต้องไปผู้ให้บริการ
    if (!payment) return { invoice: invoiceDto(invoice), payment: null, free: true as const };
    const [profile] = await tx.select({ email: s.billingProfiles.taxEmail }).from(s.billingProfiles);
    const base = { invoice: invoiceDto(invoice), payment: { id: payment.id, method: payment.method, status: payment.status, amount: payment.amount } };
    const req = { amount: invoice.amountDue, invoiceId: invoice.id, invoiceNumber: invoice.number, email: profile?.email ?? null, idempotencyKey: key };
    if (payment.method === 'card') return { ...base, card: { clientSecret: (await this.gateway.createCard(req)).clientSecret } };
    if (payment.method === 'promptpay') {
      const qr = (await this.gateway.createPromptPay(req)).qr!;
      return { ...base, promptpay: { qrPayload: qr.payload, expiresAt: qr.expiresAt } };
    }
    return { ...base, transfer: { ...bankInfo(), reference: invoice.number, dueDate: invoice.dueDate, amount: invoice.amountDue } };
  }

  // ---------------------------------------------------------------------------
  // เปิดใช้แพ็กเกจ / ยืนยันชำระ (ใช้ร่วมกับสลิป)
  // ---------------------------------------------------------------------------

  async meta(invoiceId: string): Promise<CheckoutMeta> {
    const [row] = await this.sys.select({ summary: s.auditLogs.summary }).from(s.auditLogs).where(and(eq(s.auditLogs.action, 'billing.checkout'), eq(s.auditLogs.targetId, invoiceId)));
    if (!row?.summary) throw new AppError(409, 'invoice_meta_missing', 'ไม่พบรายละเอียดแพ็กเกจของใบแจ้งหนี้นี้');
    return JSON.parse(row.summary) as CheckoutMeta;
  }

  /**
   * เปลี่ยนแพ็กเกจของ Workspace ตามใบแจ้งหนี้ · เขียน `subscriptions` ผ่าน SYSTEM_DB เพราะตารางนี้ฝั่งแอปแก้ไม่ได้ (ลูกค้าห้ามตั้งแพ็กเกจเอง)
   * เรียกซ้ำได้: ตั้งค่าเดิมซ้ำไม่มีผลข้างเคียง
   * คืน false เมื่อใบนี้ถูกแทนที่ด้วยใบที่ใหม่กว่าซึ่งยังมีผล (N02): สลิป / webhook / การยืนยันของใบเก่าที่มาทีหลังต้องไม่ลดแพ็กเกจที่ชำระแล้ว
   */
  async activate(tx: Tx, invoice: Invoice, meta: CheckoutMeta): Promise<boolean> {
    if (!(await canGrant(tx, invoice))) return false;
    const [plan] = await tx.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.code, meta.plan));
    if (!plan) throw new AppError(409, 'plan_not_found', `ไม่พบแพ็กเกจ ${meta.plan}`);
    await tx
      .update(s.subscriptions)
      .set({ planId: plan.id, cycle: meta.cycle, status: 'active', trialEndsAt: null, currentPeriodStart: new Date(`${invoice.periodStart}T00:00:00+07:00`), currentPeriodEnd: new Date(`${addDays(invoice.periodEnd, 1)}T00:00:00+07:00`), paymentMethod: meta.method, sourceInvoiceId: invoice.id, ...(meta.priceVersionId !== undefined ? { priceVersionId: meta.priceVersionId } : {}), updatedAt: new Date() })
      .where(eq(s.subscriptions.id, invoice.subscriptionId));
    return true;
  }

  /** ชำระสำเร็จ (Stripe หรือเจ้าหน้าที่ยืนยัน) → ปิดใบแจ้งหนี้, เปิดแพ็กเกจ, ขอออกใบกำกับภาษี */
  private async settle(payment: Payment) {
    const paidAt = new Date();
    const created = await this.sys.transaction(async (tx) => {
      const [invoice] = await tx.select().from(s.invoices).where(eq(s.invoices.id, payment.invoiceId));
      const meta = await this.meta(invoice.id);
      await tx.update(s.payments).set({ status: 'confirmed', verifiedBy: 'webhook', paidAt, updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
      await tx.update(s.invoices).set({ status: 'paid', paidAt, updatedAt: new Date() }).where(eq(s.invoices.id, invoice.id));
      const [prev] = await tx.select({ status: s.subscriptions.status, cycle: s.subscriptions.cycle, plan: s.plans.code }).from(s.subscriptions).leftJoin(s.plans, eq(s.plans.id, s.subscriptions.planId)).where(eq(s.subscriptions.id, invoice.subscriptionId));
      const granted = await this.activate(tx, invoice, meta);
      // ส่วนลดคูปองในใบนี้นับเป็นรอบที่ใช้ไป (O20)
      await commitCouponUses(tx, invoice.id);
      // A34: MRR movement · MRR = ยอดก่อน VAT หลังส่วนลด (รายปีหาร 12)
      const kind = granted ? classifyChange({ plan: prev?.plan ?? null, status: prev?.status ?? null, cycle: prev?.cycle ?? null }, { plan: meta.plan, cycle: meta.cycle }) : null;
      if (kind) await this.analytics.subscriptionChanged(tx, { workspaceId: invoice.workspaceId, kind, planFrom: prev?.plan ?? null, planTo: meta.plan, mrrAfterSatang: meta.cycle === 'yearly' ? invoice.subtotal / 12 : invoice.subtotal, actorKind: 'system', actorId: null });
      // ใบกำกับภาษี (จด VAT) หรือใบเสร็จ (ยังไม่จด) · เลขเดินแยกไม่ผูกกับเลขใบแจ้งหนี้ · วันที่ = วันที่ได้รับเงิน
      const { doc: issued, created: isNew } = await issueReceipt(tx, invoice, { vatRegistered: config.vatRegistered, paidAt });
      const doc = isNew ? issued : undefined;
      // ระงับเพราะค้างชำระ + เปิดเองเมื่อชำระ (C6) → เปิดถ้าไม่เหลือใบเลยกำหนด
      await resumeIfPaid(tx, invoice.workspaceId);
      await tx.insert(s.auditLogs).values({ workspaceId: invoice.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.payment_confirmed', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · ${payment.method} · ${payment.amount / 100} บาท · ${granted ? `เปิดแพ็กเกจ ${meta.plan}` : 'ไม่เปลี่ยนแพ็กเกจ (มีใบที่ใหม่กว่าเปิดสิทธิ์อยู่)'}` });
      return doc;
    });
    if (created?.docType === 'tax_invoice_receipt') await this.jobs.enqueue('payments.etax', { taxDocumentId: created.id });
  }

  // ---------------------------------------------------------------------------
  // hooks/stripe
  // ---------------------------------------------------------------------------

  async handleStripe(raw: Buffer, signature: string | undefined) {
    let ev;
    try {
      ev = this.gateway.verifyWebhook(raw, signature);
    } catch (e) {
      throw new AppError(400, 'invalid_signature', `ลายเซ็น Webhook ไม่ถูกต้อง (${(e as Error).message})`);
    }
    if (ev.type === 'ignored') return { received: true, ignored: true };
    // รู้แค่เลขอ้างอิงของผู้ให้บริการ ยังไม่รู้ Workspace จึงค้นด้วย SYSTEM_DB
    const [payment] = await this.sys.select().from(s.payments).where(and(inArray(s.payments.method, ['card', 'promptpay']), eq(s.payments.providerRef, ev.providerRef)));
    if (!payment) return { received: true, unknown: true };

    if (ev.type === 'payment.succeeded') {
      if (payment.status === 'confirmed') return { received: true, duplicate: true };
      if (payment.exceptionReason) return { received: true, exception: payment.exceptionReason };
      const outcome = await this.succeed(payment);
      return outcome === 'settled' ? { received: true } : { received: true, exception: outcome };
    }
    // ล้มเหลว / ยกเลิก (เช่น QR หมดอายุ): ไม่ย้อนการชำระที่ยืนยันแล้ว
    if (payment.status === 'confirmed') return { received: true, ignored: true };
    await this.sys.transaction(async (tx) => {
      await tx.update(s.payments).set({ status: 'rejected', updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
      if (ev.type === 'payment.canceled') await tx.update(s.invoices).set({ status: 'void', updatedAt: new Date() }).where(and(eq(s.invoices.id, payment.invoiceId), eq(s.invoices.status, 'open')));
      await tx.insert(s.auditLogs).values({ workspaceId: payment.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: ev.type === 'payment.failed' ? 'billing.payment_failed' : 'billing.payment_canceled', targetType: 'invoice', targetId: payment.invoiceId, summary: `${payment.method} ${payment.providerRef}` });
    });
    return { received: true };
  }

  // ---------------------------------------------------------------------------
  // e-Tax
  // ---------------------------------------------------------------------------

  /** งานเบื้องหลังหลังรับเงิน: ส่งใบกำกับภาษีใบนี้ทันที (งานในคิวสร้างพร้อมเอกสารแล้ว · เอกสารเก่าสร้างให้ที่นี่) */
  async submitETax(taxDocumentId: string) {
    const [doc] = await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, taxDocumentId));
    if (!doc || doc.status !== 'pending' || doc.docType === 'receipt') return;
    await queueETax(this.sys, { workspaceId: doc.workspaceId, docKind: 'tax_document', docId: doc.id, action: 'issue' });
    const [job] = await this.sys.select({ id: s.etaxJobs.id }).from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, 'tax_document'), eq(s.etaxJobs.docId, doc.id), eq(s.etaxJobs.action, 'issue')));
    if (job) await this.runETaxJob(job.id);
  }

  /**
   * ส่งงานหนึ่งงานถึงผู้ให้บริการ · จองงานก่อนด้วยการเลื่อน next_attempt_at ไป 10 นาที (งานกวาดกับงานหลังรับเงินชนกันไม่ส่งซ้ำ ·
   * โปรเซสล้มกลางทางก็ลองใหม่เองรอบถัดไป) · ล้มครบ 3 ครั้ง → failed ขึ้นตาราง "เอกสาร e-Tax ที่ต้องดู"
   */
  async runETaxJob(id: string): Promise<'submitted' | 'error' | 'skipped'> {
    const [job] = await this.sys
      .update(s.etaxJobs)
      .set({ attempts: sql`${s.etaxJobs.attempts} + 1`, lastAttemptAt: new Date(), nextAttemptAt: new Date(Date.now() + ETAX_RETRY_MS), updatedAt: new Date() })
      .where(and(eq(s.etaxJobs.id, id), eq(s.etaxJobs.status, 'pending'), sql`${s.etaxJobs.attempts} < ${ETAX_MAX_ATTEMPTS}`, sql`coalesce(${s.etaxJobs.nextAttemptAt}, now()) <= now()`))
      .returning();
    if (!job) return 'skipped';
    try {
      let providerRef: string;
      let number: string;
      if (job.action === 'issue') {
        const input = await this.etaxInput(job);
        if (!input) {
          await this.sys.update(s.etaxJobs).set({ status: 'manual', nextAttemptAt: null, note: 'ไม่ต้องส่ง: เอกสารถูกยกเลิกหรือไม่พบ', updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
          return 'skipped';
        }
        number = input.number;
        ({ providerRef } = await this.etax.issue(input));
      } else {
        const input = await this.etaxCancelInput(job);
        if (!input) {
          await this.sys.update(s.etaxJobs).set({ status: 'manual', nextAttemptAt: null, note: 'ไม่ต้องแจ้งยกเลิก: ฉบับนี้ไม่ได้ออกที่ผู้ให้บริการ', updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
          return 'skipped';
        }
        number = input.number;
        ({ providerRef } = await this.etax.cancel(input));
      }
      await this.sys.transaction(async (tx) => {
        // รอผลทาง webhook · ครบ 1 ชม. ยังไม่มาถามผู้ให้บริการเองหนึ่งครั้ง
        await tx.update(s.etaxJobs).set({ status: 'submitted', providerRef, lastError: null, nextAttemptAt: new Date(Date.now() + ETAX_CHECK_AFTER_MS), updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
        // สถานะของใบกำกับภาษีอยู่ที่ tax_documents · ฉบับที่ยกเลิกระหว่างส่งไม่เปลี่ยนกลับ
        if (job.docKind === 'tax_document' && job.action === 'issue') await tx.update(s.taxDocuments).set({ providerRef, status: 'submitted', updatedAt: new Date() }).where(and(eq(s.taxDocuments.id, job.docId), inArray(s.taxDocuments.status, ['pending', 'failed'])));
        await tx.insert(s.auditLogs).values({ workspaceId: job.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: job.action === 'issue' ? 'billing.etax_submitted' : 'billing.etax_cancel_submitted', targetType: job.docKind, targetId: job.docId, summary: `${number} · ${providerRef}` });
      });
      return 'submitted';
    } catch (e) {
      const final = job.attempts >= ETAX_MAX_ATTEMPTS;
      const error = etaxErrorText(e);
      await this.sys.transaction(async (tx) => {
        await tx.update(s.etaxJobs).set({ status: final ? 'failed' : 'pending', lastError: error, nextAttemptAt: final ? null : new Date(Date.now() + ETAX_RETRY_MS), updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
        if (final && job.docKind === 'tax_document' && job.action === 'issue') await tx.update(s.taxDocuments).set({ status: 'failed', updatedAt: new Date() }).where(and(eq(s.taxDocuments.id, job.docId), eq(s.taxDocuments.status, 'pending')));
        if (final) await tx.insert(s.auditLogs).values({ workspaceId: job.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: job.action === 'issue' ? 'billing.etax_failed' : 'billing.etax_cancel_failed', targetType: job.docKind, targetId: job.docId, summary: `ลอง ${job.attempts} ครั้งไม่สำเร็จ · ${error}` });
      });
      this.log.error(`ส่ง e-Tax (${job.action} ${job.docKind} ${job.docId}) ครั้งที่ ${job.attempts} ไม่สำเร็จ: ${error}`);
      return 'error';
    }
  }

  /** ถามผลของงานที่ส่งแล้ว (ครบ 1 ชม. หรือทีมกด "ตรวจสถานะ") · ยังไม่มีผล = รอต่อ (ขึ้นตาราง "รอผลเกิน 1 ชม.") */
  private async checkETaxJob(id: string): Promise<'checked' | 'error' | 'skipped'> {
    const [job] = await this.sys.update(s.etaxJobs).set({ nextAttemptAt: null, updatedAt: new Date() }).where(and(eq(s.etaxJobs.id, id), eq(s.etaxJobs.status, 'submitted'), sql`${s.etaxJobs.nextAttemptAt} <= now()`)).returning();
    if (!job?.providerRef) return 'skipped';
    try {
      const r = await this.etax.status(job.providerRef);
      if (r.status !== 'pending') await this.applyETaxResult(job, r.status, r.code, r.message);
      return 'checked';
    } catch (e) {
      await this.sys.update(s.etaxJobs).set({ lastError: `ตรวจสถานะไม่ได้ · ${etaxErrorText(e)}`, updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
      return 'error';
    }
  }

  /** ข้อมูลที่ส่งผู้ให้บริการ · ผู้ซื้อ = ข้อมูลที่ล็อกไว้ในเอกสาร (ไม่ใช่โปรไฟล์ปัจจุบัน) · null = ไม่ต้องส่ง */
  private async etaxInput(job: typeof s.etaxJobs.$inferSelect): Promise<ETaxInput | null> {
    const ref = async (d: typeof s.taxDocuments.$inferSelect | undefined) => {
      if (!d) return null;
      const [j] = await this.sys.select({ providerRef: s.etaxJobs.providerRef }).from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, 'tax_document'), eq(s.etaxJobs.docId, d.id), eq(s.etaxJobs.action, 'issue')));
      return { number: d.number, issuedOn: d.issuedOn ?? bkkDate(d.createdAt), providerRef: d.providerRef ?? j?.providerRef ?? null };
    };
    if (job.docKind === 'tax_document') {
      const [doc] = await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, job.docId));
      if (!doc || doc.status === 'cancelled' || doc.docType === 'receipt') return null;
      const [invoice] = await this.sys.select().from(s.invoices).where(eq(s.invoices.id, doc.invoiceId));
      const [old] = doc.replacesId ? await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, doc.replacesId)) : [];
      return {
        documentId: doc.id, taxDocumentId: doc.id, kind: 'tax_invoice', number: doc.number, issuedOn: doc.issuedOn ?? bkkDate(doc.createdAt), invoiceNumber: invoice.number,
        amounts: { subtotal: invoice.subtotal, vat: invoice.vat, total: invoice.total },
        buyer: await this.lockedBuyer(doc.workspaceId, doc.buyer),
        replaces: await ref(old), reason: old?.cancelReason ?? null,
      };
    }
    const note = job.docKind === 'credit_note' ? (await this.sys.select().from(s.creditNotes).where(eq(s.creditNotes.id, job.docId)))[0] : (await this.sys.select().from(s.debitNotes).where(eq(s.debitNotes.id, job.docId)))[0];
    if (!note) return null;
    const [invoice] = await this.sys.select().from(s.invoices).where(eq(s.invoices.id, note.invoiceId));
    // ใบลด / เพิ่มหนี้อ้างใบกำกับภาษีที่ยังมีผลของใบแจ้งหนี้เดิม (ม.86/9 · 86/10)
    const docs = await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.invoiceId, note.invoiceId)).orderBy(desc(s.taxDocuments.createdAt));
    const tax = docs.find((d) => d.status !== 'cancelled') ?? docs[0];
    if (!tax || tax.docType === 'receipt') return null;
    return {
      documentId: note.id, kind: job.docKind === 'credit_note' ? 'credit_note' : 'debit_note', number: note.number, issuedOn: bkkDate(note.issuedAt ?? note.createdAt), invoiceNumber: invoice.number,
      amounts: { subtotal: note.amountSatang, vat: note.vatSatang, total: note.amountSatang + note.vatSatang },
      buyer: await this.lockedBuyer(note.workspaceId, tax.buyer), references: await ref(tax), reason: note.reason,
    };
  }

  private async etaxCancelInput(job: typeof s.etaxJobs.$inferSelect): Promise<ETaxCancelInput | null> {
    const [issue] = await this.sys.select().from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, job.docKind), eq(s.etaxJobs.docId, job.docId), eq(s.etaxJobs.action, 'issue')));
    if (job.docKind !== 'tax_document') return null;
    const [doc] = await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, job.docId));
    const providerRef = doc?.providerRef ?? issue?.providerRef;
    if (!doc || !providerRef) return null;
    return { documentId: doc.id, kind: 'tax_invoice', number: doc.number, providerRef, reason: doc.cancelReason ?? 'ยกเลิกและออกฉบับใหม่แทน' };
  }

  /** ผู้ซื้อที่ล็อกในเอกสาร · เอกสารเก่าที่ยังไม่มี snapshot ใช้โปรไฟล์ปัจจุบัน */
  private async lockedBuyer(workspaceId: string, snapshot: unknown): Promise<ETaxInput['buyer']> {
    const [profile] = await this.sys.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, workspaceId));
    const b = (snapshot && typeof snapshot === 'object' ? snapshot : profile ? { companyName: profile.companyName, taxId: profile.taxId, branchType: profile.branchType, branchNo: profile.branchNo, address: profile.address, email: profile.taxEmail } : null) as BuyerSnapshot | null;
    if (!b) throw new Error('ไม่พบข้อมูลผู้ซื้อ');
    return { companyName: b.companyName, taxId: b.taxId, branchType: b.branchType, branchNo: b.branchNo, address: b.address, email: b.email ?? profile?.taxEmail ?? '' };
  }

  /**
   * hooks/etax · ผลของงานในคิว (ออกเอกสาร TX / CN / DN หรือแจ้งยกเลิก) · ค้นจากเลขอ้างอิงของผู้ให้บริการ
   * `{ providerRef, status: issued | cancelled | failed, code?, message? }`
   */
  async handleETax(raw: Buffer, signature: string | undefined) {
    if (!verifyETaxSignature(raw, signature)) throw new AppError(400, 'invalid_signature', 'ลายเซ็น Webhook ไม่ถูกต้อง');
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      throw new AppError(400, 'invalid_payload', 'รูปแบบข้อมูลไม่ถูกต้อง');
    }
    const body = z.object({ providerRef: z.string().min(1), status: z.enum(['issued', 'failed', 'cancelled']), code: z.string().max(50).optional(), message: z.string().max(500).optional() }).safeParse(json);
    if (!body.success) throw new AppError(400, 'invalid_payload', 'รูปแบบข้อมูลไม่ถูกต้อง');
    const { providerRef, status, code, message } = body.data;
    // งานแจ้งยกเลิกที่ทีมบันทึกเองได้เลขอ้างอิงของการยกเลิก → ค้นงานก่อน แล้วค่อยค้นใบกำกับภาษี (เอกสารก่อนมีคิว)
    let [job] = await this.sys.select().from(s.etaxJobs).where(eq(s.etaxJobs.providerRef, providerRef)).orderBy(desc(s.etaxJobs.updatedAt)).limit(1);
    if (!job) {
      const [doc] = await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.providerRef, providerRef));
      if (!doc) return { received: true, unknown: true };
      await queueETax(this.sys, { workspaceId: doc.workspaceId, docKind: 'tax_document', docId: doc.id, action: 'issue' });
      await this.sys.update(s.etaxJobs).set({ status: 'submitted', providerRef, nextAttemptAt: null }).where(and(eq(s.etaxJobs.docKind, 'tax_document'), eq(s.etaxJobs.docId, doc.id), eq(s.etaxJobs.action, 'issue'), eq(s.etaxJobs.status, 'pending')));
      [job] = await this.sys.select().from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, 'tax_document'), eq(s.etaxJobs.docId, doc.id), eq(s.etaxJobs.action, 'issue')));
    }
    return { received: true, ...(await this.applyETaxResult(job, status, code, message)) };
  }

  /**
   * บันทึกผลจากผู้ให้บริการลงคิวและเอกสาร
   * ใบกำกับภาษีที่ยกเลิกแล้ว: ผลที่มาช้าเก็บในประวัติ แต่ไม่เปลี่ยนสถานะกลับ (และต้องแจ้งยกเลิกฉบับที่ผู้ให้บริการเพิ่งออก)
   */
  private async applyETaxResult(job: typeof s.etaxJobs.$inferSelect, status: 'issued' | 'failed' | 'cancelled', code?: string, message?: string) {
    const ok = job.action === 'issue' ? status === 'issued' : status === 'cancelled';
    const nextStatus = ok ? 'done' : status === 'failed' ? 'failed' : null;
    const error = status === 'failed' ? [code, message].filter(Boolean).join(' · ') || 'ผู้ให้บริการปฏิเสธ' : null;
    if (!nextStatus) {
      // ผลไม่ตรงกับงาน (เช่น "cancelled" ของงานออกเอกสาร) · เก็บไว้ให้ทีมดู ไม่เปลี่ยนอะไร
      await this.sys.insert(s.auditLogs).values({ workspaceId: job.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.etax_unexpected', targetType: job.docKind, targetId: job.docId, summary: `${job.action} · ผู้ให้บริการแจ้ง ${status}` });
      return { ignored: true };
    }
    if (job.status === nextStatus && (nextStatus === 'done' || job.lastError === error)) return { duplicate: true };
    const [doc] = job.docKind === 'tax_document' ? await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, job.docId)) : [];
    const late = job.action === 'issue' && doc?.status === 'cancelled';
    await this.sys.transaction(async (tx) => {
      await tx.update(s.etaxJobs).set({ status: nextStatus, lastError: error, nextAttemptAt: null, updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
      const label = doc?.number ?? job.docId;
      if (late) {
        await tx.insert(s.auditLogs).values({ workspaceId: job.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: 'billing.etax_late_result', targetType: job.docKind, targetId: job.docId, summary: `${label} · ผู้ให้บริการแจ้ง ${status} หลังยกเลิกในระบบแล้ว (ไม่เปลี่ยนสถานะ)${error ? ` · ${error}` : ''}` });
        // ผู้ให้บริการเพิ่งออกฉบับที่ยกเลิกไปแล้ว → ต้องแจ้งยกเลิก
        if (ok) await cancelETax(tx, { id: doc.id, workspaceId: doc.workspaceId, providerRef: doc.providerRef ?? job.providerRef, status: 'issued' });
        return;
      }
      if (doc && job.action === 'issue') await tx.update(s.taxDocuments).set({ status: ok ? 'issued' : 'failed', ...(ok ? { sentAt: new Date() } : {}), updatedAt: new Date() }).where(eq(s.taxDocuments.id, doc.id));
      const action = job.action === 'issue' ? (ok ? 'billing.etax_issued' : 'billing.etax_failed') : ok ? 'billing.etax_cancelled' : 'billing.etax_cancel_failed';
      await tx.insert(s.auditLogs).values({ workspaceId: job.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action, targetType: job.docKind, targetId: job.docId, summary: `${label}${error ? ` · ${error}` : ''}` });
    });
    if (late) return { late: true };
    if (doc && job.action === 'issue' && ok) {
      const [profile] = await this.sys.select({ email: s.billingProfiles.taxEmail }).from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, doc.workspaceId));
      const to = (doc.buyer as BuyerSnapshot | null)?.email ?? profile?.email;
      if (to) await this.mailer.send({ to, subject: `ใบกำกับภาษีอิเล็กทรอนิกส์ ${doc.number}`, text: `ออกใบกำกับภาษีอิเล็กทรอนิกส์เลขที่ ${doc.number} เรียบร้อยแล้ว · ดาวน์โหลดได้ที่หน้า การเรียกเก็บเงิน` }).catch((e) => this.log.error(`ส่งอีเมล e-Tax ไม่สำเร็จ: ${(e as Error).message}`));
    }
    return {};
  }
}
