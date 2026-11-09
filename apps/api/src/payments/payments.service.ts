import { createHash } from 'node:crypto';
import { AnalyticsService, classifyChange } from '../analytics/analytics.service.js';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { canGrant, type Db, schema, type Tx } from '@friday/db';
import { and, count, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { BillingService } from '../billing/billing.service.js';
import { Mailer } from '../core/mail.js';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { config } from '../config.js';
import { Jobs } from '../queue/jobs.js';
import { ETAX_PROVIDER, type ETaxProvider, PAYMENT_GATEWAY, type PaymentGateway, verifyETaxSignature } from './providers.js';

const s = schema;
const DAY = 86_400_000;

export const CheckoutBody = z
  .object({
    plan: z.enum(['team_s', 'team_m', 'team_l']),
    cycle: z.enum(['monthly', 'yearly']).default('monthly'),
    method: z.enum(['card', 'promptpay', 'transfer']),
    /** หัก ณ ที่จ่าย 3% · PromptPay / โอนเท่านั้น */
    wht: z.boolean().default(false),
    poNumber: z.string().trim().max(50).optional(),
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
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
export const bankInfo = () => ({
  bank: process.env.BANK_NAME ?? 'ธนาคารตัวอย่าง',
  accountNo: process.env.BANK_ACCOUNT_NO ?? '000-0-00000-0',
  accountName: process.env.BANK_ACCOUNT_NAME ?? 'บริษัท ฟรายเดย์ จำกัด (ตัวอย่าง)',
});

type Invoice = typeof s.invoices.$inferSelect;
type Payment = typeof s.payments.$inferSelect;

export const invoiceDto = (i: Invoice) => ({ id: i.id, number: i.number, periodStart: i.periodStart, periodEnd: i.periodEnd, subtotal: i.subtotal, vat: i.vat, total: i.total, whtAmount: i.whtAmount, amountDue: i.amountDue, poNumber: i.poNumber, status: i.status, dueDate: i.dueDate, paidAt: i.paidAt, createdAt: i.createdAt });

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

  /** ส่ง e-Tax ของเอกสารที่ค้างสถานะ pending เกิน 1 นาที (ให้ผู้สร้างเอกสารมีเวลาส่งงานเอง) */
  async sweepETax() {
    const rows = await this.sys.select({ id: s.taxDocuments.id }).from(s.taxDocuments).where(and(eq(s.taxDocuments.status, 'pending'), ne(s.taxDocuments.docType, 'receipt'), sql`${s.taxDocuments.createdAt} < now() - interval '1 minute'`)).limit(50);
    let submitted = 0;
    for (const r of rows) {
      try {
        await this.submitETax(r.id);
        submitted++;
      } catch (e) {
        this.log.error(`ส่ง e-Tax ${r.id} ไม่สำเร็จ: ${(e as Error).message}`);
      }
    }
    return { submitted };
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
    const payload = sha(JSON.stringify([input.plan, input.cycle, input.method, input.wht, input.poNumber ?? null]));

    return this.db.run(auth, tenant, async (tx) => {
      // คำขอซ้ำที่มาพร้อมกันต้องต่อคิว ไม่ให้สร้างสองใบ
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'checkout:' + tenant.workspaceId}, 0))`);
      const [seen] = await tx
        .select({ targetId: s.auditLogs.targetId, summary: s.auditLogs.summary })
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.action, 'billing.checkout'), sql`(${s.auditLogs.summary})::jsonb ->> 'key' = ${key}`));
      if (seen) {
        const meta = JSON.parse(seen.summary!) as CheckoutMeta;
        if (meta.payload !== payload) throw new AppError(422, 'idempotency_key_reuse', 'Idempotency-Key นี้ถูกใช้กับคำขอที่ต่างกัน');
        return { ...(await this.respond(tx, seen.targetId!, key)), replayed: true };
      }

      const [profile] = await tx.select().from(s.billingProfiles);
      if (!profile) throw new AppError(422, 'billing_profile_required', 'กรอกข้อมูลออกใบกำกับภาษีก่อน (PUT billing/profile)');
      const quote = await this.billing.quote(tenant, { plan: input.plan, cycle: input.cycle, wht: input.wht });
      const sub = await this.limits.ensureSubscription(tenant.workspaceId);
      void sub;
      const [subRow] = await tx.select({ id: s.subscriptions.id }).from(s.subscriptions);

      // เลขใบแจ้งหนี้ออกต่อเนื่องทั้งระบบ (ใบกำกับภาษีต้องเรียงเลข) จึงล็อกระดับระบบ แล้วนับด้วย SYSTEM_DB ซึ่งเห็นทุก Workspace
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('invoice-number', 0))`);
      const start = today();
      const prefix = `FRI-${start.slice(2, 4)}${start.slice(5, 7)}-`;
      const [seq] = await this.sys.select({ n: count() }).from(s.invoices).where(like(s.invoices.number, `${prefix}%`));
      const number = `${prefix}${String(seq.n + 1).padStart(4, '0')}`;

      const [invoice] = await tx
        .insert(s.invoices)
        .values({
          workspaceId: tenant.workspaceId,
          subscriptionId: subRow.id,
          number,
          periodStart: start,
          periodEnd: addDays(addMonths(start, input.cycle === 'yearly' ? 12 : 1), -1),
          subtotal: quote.subtotal,
          vat: quote.vat,
          total: quote.total,
          whtAmount: quote.whtAmount,
          amountDue: quote.amountDue,
          poNumber: input.poNumber ?? null,
          dueDate: input.method === 'transfer' ? addDays(start, 7) : start,
        })
        .returning();

      const gwReq = { amount: invoice.amountDue, invoiceId: invoice.id, invoiceNumber: invoice.number, email: profile.taxEmail, idempotencyKey: key };
      const gw = input.method === 'card' ? await this.gateway.createCard(gwReq) : input.method === 'promptpay' ? await this.gateway.createPromptPay(gwReq) : null;
      await tx.insert(s.payments).values({ workspaceId: tenant.workspaceId, invoiceId: invoice.id, method: input.method, amount: invoice.amountDue, providerRef: gw?.providerRef ?? null });

      const meta: CheckoutMeta = { plan: input.plan, cycle: input.cycle, method: input.method, wht: input.wht, key, payload };
      const log = { workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user' as const, category: 'plan' as const, targetType: 'invoice', targetId: invoice.id };
      await tx.insert(s.auditLogs).values([
        { ...log, action: 'billing.checkout', summary: JSON.stringify(meta) },
        { ...log, action: 'billing.invoice_created', summary: `${invoice.number} · ${quote.planName} ${input.cycle === 'yearly' ? 'รายปี' : 'รายเดือน'} · ${input.method} · ${invoice.amountDue / 100} บาท` },
      ]);
      return { ...(await this.respond(tx, invoice.id, key)), replayed: false };
    });
  }

  /** ผลของ checkout (ใช้ทั้งครั้งแรกและตอนส่งซ้ำ) · บัตร / PromptPay ถามผู้ให้บริการอีกครั้งด้วย key เดิม ได้ intent เดิม */
  private async respond(tx: Tx, invoiceId: string, key: string) {
    const [invoice] = await tx.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    const [payment] = await tx.select().from(s.payments).where(eq(s.payments.invoiceId, invoiceId));
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
      .set({ planId: plan.id, cycle: meta.cycle, status: 'active', trialEndsAt: null, currentPeriodStart: new Date(`${invoice.periodStart}T00:00:00+07:00`), currentPeriodEnd: new Date(`${addDays(invoice.periodEnd, 1)}T00:00:00+07:00`), paymentMethod: meta.method, sourceInvoiceId: invoice.id, updatedAt: new Date() })
      .where(eq(s.subscriptions.id, invoice.subscriptionId));
    return true;
  }

  /** ชำระสำเร็จ (Stripe หรือเจ้าหน้าที่ยืนยัน) → ปิดใบแจ้งหนี้, เปิดแพ็กเกจ, ขอออกใบกำกับภาษี */
  private async settle(payment: Payment) {
    const created = await this.sys.transaction(async (tx) => {
      const [invoice] = await tx.select().from(s.invoices).where(eq(s.invoices.id, payment.invoiceId));
      const meta = await this.meta(invoice.id);
      await tx.update(s.payments).set({ status: 'confirmed', verifiedBy: 'webhook', updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
      await tx.update(s.invoices).set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() }).where(eq(s.invoices.id, invoice.id));
      const [prev] = await tx.select({ status: s.subscriptions.status, cycle: s.subscriptions.cycle, plan: s.plans.code }).from(s.subscriptions).leftJoin(s.plans, eq(s.plans.id, s.subscriptions.planId)).where(eq(s.subscriptions.id, invoice.subscriptionId));
      const granted = await this.activate(tx, invoice, meta);
      // A34: MRR movement · MRR = ยอดก่อน VAT หลังส่วนลด (รายปีหาร 12)
      const kind = granted ? classifyChange({ plan: prev?.plan ?? null, status: prev?.status ?? null, cycle: prev?.cycle ?? null }, { plan: meta.plan, cycle: meta.cycle }) : null;
      if (kind) await this.analytics.subscriptionChanged(tx, { workspaceId: invoice.workspaceId, kind, planFrom: prev?.plan ?? null, planTo: meta.plan, mrrAfterSatang: meta.cycle === 'yearly' ? invoice.subtotal / 12 : invoice.subtotal, actorKind: 'system', actorId: null });
      // ยังไม่จด VAT: ออกใบเสร็จ (ไม่ต้องส่ง e-Tax จึงถือว่าออกแล้ว)
      const [doc] = await tx
        .insert(s.taxDocuments)
        .values(config.vatRegistered
          ? { workspaceId: invoice.workspaceId, invoiceId: invoice.id, docType: 'tax_invoice_receipt', number: `TX-${invoice.number.slice(4)}` }
          : { workspaceId: invoice.workspaceId, invoiceId: invoice.id, docType: 'receipt', number: `RC-${invoice.number.slice(4)}`, status: 'issued', sentAt: new Date() })
        .onConflictDoNothing()
        .returning();
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

  /** งานเบื้องหลัง: ส่งคำขอออกใบกำกับภาษีไปยังผู้ให้บริการ (ผลจริงมาทาง hooks/etax) */
  async submitETax(taxDocumentId: string) {
    const [doc] = await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, taxDocumentId));
    if (!doc || doc.status !== 'pending') return;
    const [invoice] = await this.sys.select().from(s.invoices).where(eq(s.invoices.id, doc.invoiceId));
    const [profile] = await this.sys.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, doc.workspaceId));
    if (!profile) return;
    const { providerRef } = await this.etax.issue({
      taxDocumentId: doc.id,
      number: doc.number,
      invoiceNumber: invoice.number,
      amounts: { subtotal: invoice.subtotal, vat: invoice.vat, total: invoice.total },
      buyer: { companyName: profile.companyName, taxId: profile.taxId, branchType: profile.branchType, branchNo: profile.branchNo, address: profile.address, email: profile.taxEmail },
    });
    await this.sys.update(s.taxDocuments).set({ providerRef, status: 'submitted', updatedAt: new Date() }).where(eq(s.taxDocuments.id, doc.id));
  }

  async handleETax(raw: Buffer, signature: string | undefined) {
    if (!verifyETaxSignature(raw, signature)) throw new AppError(400, 'invalid_signature', 'ลายเซ็น Webhook ไม่ถูกต้อง');
    const body = z.object({ providerRef: z.string().min(1), status: z.enum(['issued', 'failed']) }).safeParse(JSON.parse(raw.toString('utf8') || '{}'));
    if (!body.success) throw new AppError(400, 'invalid_payload', 'รูปแบบข้อมูลไม่ถูกต้อง');
    const [doc] = await this.sys.select().from(s.taxDocuments).where(eq(s.taxDocuments.providerRef, body.data.providerRef));
    if (!doc) return { received: true, unknown: true };
    if (doc.status === body.data.status) return { received: true, duplicate: true };
    await this.sys.update(s.taxDocuments).set({ status: body.data.status, ...(body.data.status === 'issued' ? { sentAt: new Date() } : {}), updatedAt: new Date() }).where(eq(s.taxDocuments.id, doc.id));
    await this.sys.insert(s.auditLogs).values({ workspaceId: doc.workspaceId, actorId: null, actorKind: 'system', category: 'plan', action: `billing.etax_${body.data.status}`, targetType: 'tax_document', targetId: doc.id, summary: doc.number });
    if (body.data.status === 'issued') {
      const [profile] = await this.sys.select({ email: s.billingProfiles.taxEmail }).from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, doc.workspaceId));
      if (profile) await this.mailer.send({ to: profile.email, subject: `ใบกำกับภาษีอิเล็กทรอนิกส์ ${doc.number}`, text: `ออกใบกำกับภาษีอิเล็กทรอนิกส์เลขที่ ${doc.number} เรียบร้อยแล้ว · ดาวน์โหลดได้ที่หน้า การเรียกเก็บเงิน` }).catch((e) => this.log.error(`ส่งอีเมล e-Tax ไม่สำเร็จ: ${(e as Error).message}`));
    }
    return { received: true };
  }
}
